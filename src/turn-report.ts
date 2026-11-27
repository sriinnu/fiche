/**
 * Fast, zero-token-overhead per-turn and session savings reporter.
 * Reads the tail of `~/.inkling/events.jsonl` in <5ms so IDE/CLI plugins,
 * hooks, status bars, and MCP tools can surface live savings without sending
 * extra turns to the LLM.
 *
 * Node-only (`node:fs`, `node:os`, `node:path`).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  computeActualInputEffWithCacheTier,
  computeBaselineInputEffWithCacheTier,
  deriveBaselineWarmth,
  isUsableAnthropicBaselineProbe,
  observedCacheTtlSec,
  type BaselineWarmthPrev,
} from './core/baseline.js';
import { readBrandEnv } from './core/env.js';
import {
  computeOpenAIActualInputEff,
  computeOpenAISessionBaselineInputEff,
  deriveOpenAIBaselineWarmth,
  OPENAI_CACHE_TTL_SEC,
  type OpenAIWarmthPrev,
} from './core/openai-savings.js';
import type { TrackEvent } from './core/tracker.js';
import { anthropicReadRate, inputUsdPerMtok, priceMode, resolvePriceRates } from './core/pricing.js';
import { eventLogFiles } from './file-tracker.js';

const ASSUMED_INPUT_USD_PER_MTOK = 10.0;

export type TurnReportFormat = 'cli' | 'agy' | 'claude-statusline' | 'json';

export interface TurnSavingsSnapshot {
  readonly ts: string;
  readonly model?: string;
  readonly status: number;
  readonly basis: 'measured' | 'estimated';
  readonly savedTokens: number;
  readonly savedUsd: number;
  readonly cacheHitPct: number | null;
  readonly stages: readonly string[];
  readonly cliffAvoidedAt?: number;
  readonly cliffSavedUsd?: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly sessionId?: string;
}

export interface SessionSavingsRollup {
  readonly sessionId: string | null;
  readonly turns: number;
  readonly compressedTurns: number;
  readonly savedTokens: number;
  readonly savedUsd: number;
  readonly cliffSavedUsd: number;
  readonly avgCacheHitPct: number | null;
}

export interface TurnReportPayload {
  readonly eventsFile: string;
  readonly hasNewTurn: boolean;
  readonly lastTurn: TurnSavingsSnapshot | null;
  readonly session: SessionSavingsRollup;
}

export interface ReadTurnReportOptions {
  readonly cursorFile?: string;
  readonly updateCursor?: boolean;
  readonly maxTailBytes?: number;
}

interface CursorState {
  readonly ts: string;
  readonly offset: number;
}

const DEFAULT_MAX_TAIL_BYTES = 2 * 1024 * 1024;
const SESSION_FALLBACK_WINDOW_MS = 30 * 60 * 1000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function isInferenceEvent(ev: TrackEvent): boolean {
  if (!ev || typeof ev !== 'object') return false;
  if (typeof ev.ts !== 'string' || typeof ev.status !== 'number') return false;
  if (ev.status < 200 || ev.status >= 300) return false;
  if (typeof ev.path === 'string' && (ev.path.includes('count_tokens') || ev.path.includes('countTokens'))) {
    return false;
  }
  return (
    ev.compressed === true ||
    (ev.text_hygiene_saved_tokens ?? 0) > 0 ||
    (ev.input_tokens ?? 0) > 0 ||
    (ev.cache_read_tokens ?? 0) > 0 ||
    (ev.cached_tokens ?? 0) > 0
  );
}

interface CachedModelRates {
  readonly inUsd: number | undefined;
}

interface TurnWarmthState {
  anthropic?: BaselineWarmthPrev;
  anthropicObservedPrefix?: number;
  openai?: OpenAIWarmthPrev;
  google?: {
    ts: number;
    cachedTokens: number;
    prefixSha?: string;
    pxPrefixSha?: string;
    model?: string;
  };
}

function computeTurnSnapshotWithCache(
  ev: TrackEvent,
  rateCache?: Map<string, CachedModelRates>,
  warmthState?: TurnWarmthState,
): TurnSavingsSnapshot {
  const pathIsOpenAI =
    typeof ev.path === 'string' &&
    (ev.path.includes('responses') || ev.path.includes('chat/completions'));
  const isOpenAI = ev.accounting_provider ? ev.accounting_provider === 'openai' : pathIsOpenAI;
  const isGoogle = ev.accounting_provider
    ? ev.accounting_provider === 'google'
    : typeof ev.path === 'string' &&
      !pathIsOpenAI &&
      (ev.path.includes('google-ai-studio') || ev.path.toLowerCase().includes('generatecontent'));
  const isInclusiveUsage =
    isOpenAI ||
    isGoogle ||
    (ev.cached_tokens !== undefined && ev.cache_read_tokens === undefined);

  const inp = ev.input_tokens ?? 0;
  const cc = ev.cache_create_tokens ?? 0;
  const cc5m = ev.cache_create_5m_tokens;
  const cc1h = ev.cache_create_1h_tokens ?? 0;
  const cr = ev.cache_read_tokens ?? 0;
  const cacheWrite = ev.cache_write_tokens ?? 0;
  const rawCached = ev.cached_tokens ?? ev.cache_read_tokens ?? 0;

  const cachedTokens = isInclusiveUsage ? Math.max(0, Math.min(inp, rawCached)) : cr;
  const inputTokens = isInclusiveUsage ? inp : inp + cc + cr;

  const parsedMs = Date.parse(ev.ts);
  const eventMs = Number.isFinite(parsedMs) ? parsedMs : Date.now();
  const completionSec = eventMs / 1000;
  const requestStartSec = completionSec - Math.max(0, ev.duration_ms || 0) / 1000;

  const hasMeasuredBaseline =
    ev.compressed !== false &&
    ev.baseline_probe_status === 'ok' &&
    typeof ev.baseline_tokens === 'number' &&
    ev.baseline_tokens > 0 &&
    inputTokens > 0 &&
    (isOpenAI ||
      isGoogle ||
      isUsableAnthropicBaselineProbe({
        baselineTokens: ev.baseline_tokens,
        probeStatus: ev.baseline_probe_status,
        threadContinue: ev.thread_continue === true,
        cacheReadTokens: cr,
      }));

  const hygieneTok = Math.max(0, ev.text_hygiene_saved_tokens ?? 0);
  const baselineImaged = ev.baseline_imaged_tokens ?? Math.round((ev.compressed_chars ?? 0) / 4);
  const nativeTok = Math.max(0, ev.native_injected_tokens ?? 0);
  const imageTok = ev.image_tokens ?? 0;
  const imgSaved = ev.compressed ? baselineImaged - imageTok - nativeTok : 0;

  const savedTokens = hasMeasuredBaseline
    ? Math.round((ev.baseline_tokens ?? 0) - inputTokens)
    : Math.round(hygieneTok + imgSaved);

  let weightedSaved = 0;
  if (isOpenAI) {
    const pxSha = ev.cache_prefix_sha8 ?? ev.history_image_sha8;
    const oPrev = warmthState?.openai;
    const oWarmth = deriveOpenAIBaselineWarmth(
      oPrev,
      requestStartSec,
      cachedTokens,
      ev.system_sha8,
      ev.model,
      OPENAI_CACHE_TTL_SEC,
      pxSha,
    );
    const priceCtx = { promptTokens: inp, at: eventMs };
    const actualEff = inp > 0
      ? computeOpenAIActualInputEff(inp, cachedTokens, ev.model, cacheWrite, priceCtx)
      : 0;
    if (hasMeasuredBaseline) {
      const rates = resolvePriceRates(ev.model, priceCtx);
      if (oWarmth.selfBusted) {
        const unproxiedRaw = Math.max(0, ev.baseline_tokens!);
        const reused = Math.min(unproxiedRaw, oWarmth.prevPrefixTokens);
        const newRate = cacheWrite > 0 ? rates.write : 1;
        const baselineEff = reused * rates.read + (unproxiedRaw - reused) * newRate;
        weightedSaved = baselineEff - actualEff;
      } else {
        const deltaWeight = cachedTokens > 0 ? rates.read : cacheWrite > 0 ? rates.write : 1;
        weightedSaved = (ev.baseline_tokens! - inp) * deltaWeight;
      }
    } else if (
      inp > 0 &&
      ((ev.compressed && (baselineImaged > 0 || (ev.compressed_chars ?? 0) > 0)) || hygieneTok > 0)
    ) {
      const baselineEff = computeOpenAISessionBaselineInputEff({
        inputTokens: inp,
        cachedTokens,
        imageTokens: ev.compressed ? imageTok : 0,
        baselineImagedTokens: ev.compressed ? baselineImaged : 0,
        nativeInjectedTokens: ev.compressed ? nativeTok : 0,
        textHygieneSavedTokens: hygieneTok,
        cacheWriteTokens: cacheWrite,
        model: ev.model,
        warmth: oWarmth,
      });
      weightedSaved = baselineEff - actualEff;
    } else if (hygieneTok > 0 || imgSaved !== 0) {
      weightedSaved = savedTokens;
    }
    if (warmthState && inputTokens > 0) {
      warmthState.openai = {
        ts: completionSec,
        cachedOrPrefixTokens: cachedTokens > 0 ? cachedTokens : 0,
        prefixSha: ev.system_sha8 ?? oPrev?.prefixSha,
        pxPrefixSha: pxSha ?? oPrev?.pxPrefixSha,
        model: ev.model ?? oPrev?.model,
      };
    }
  } else if (isGoogle) {
    const pxSha = ev.cache_prefix_sha8 ?? ev.history_image_sha8;
    const gPrev = warmthState?.google;
    const gWarmth = deriveOpenAIBaselineWarmth(
      gPrev
        ? {
            ts: gPrev.ts,
            cachedOrPrefixTokens: gPrev.cachedTokens,
            prefixSha: gPrev.prefixSha,
            pxPrefixSha: gPrev.pxPrefixSha,
            model: gPrev.model,
          }
        : undefined,
      requestStartSec,
      cachedTokens,
      ev.system_sha8,
      ev.model,
      300,
      pxSha,
    );
    const priceCtx = { promptTokens: inp, at: eventMs };
    const rates = resolvePriceRates(ev.model, priceCtx);
    if (priceMode() === 'kosha') {
      if (
        gWarmth.selfBusted &&
        inp > 0 &&
        (hasMeasuredBaseline || (ev.compressed && baselineImaged > 0) || hygieneTok > 0)
      ) {
        const unproxiedRaw = Math.max(0, hasMeasuredBaseline ? ev.baseline_tokens! : inp + savedTokens);
        const reused = Math.min(unproxiedRaw, gWarmth.prevPrefixTokens);
        const baselineEff = reused * rates.read + (unproxiedRaw - reused) * 1.0;
        const actualEff = (inp - cachedTokens) + cachedTokens * rates.read;
        weightedSaved = baselineEff - actualEff;
      } else {
        weightedSaved = savedTokens * (cachedTokens > 0 ? rates.read : 1.0);
      }
    } else {
      weightedSaved = savedTokens;
    }
    if (warmthState && inputTokens > 0) {
      warmthState.google = {
        ts: completionSec,
        cachedTokens: cachedTokens > 0 ? cachedTokens : 0,
        prefixSha: ev.system_sha8 ?? gPrev?.prefixSha,
        pxPrefixSha: pxSha ?? gPrev?.pxPrefixSha,
        model: ev.model ?? gPrev?.model,
      };
    }
  } else {
    const readRate = anthropicReadRate(ev.model, { promptTokens: inputTokens, at: eventMs });
    const actualEff = inputTokens > 0
      ? computeActualInputEffWithCacheTier(inp, cc, cr, cc1h, cc5m, readRate)
      : 0;
    const cacheable = ev.baseline_cacheable_tokens ?? 0;
    const aPrev = warmthState?.anthropic;
    const { warm, prevCacheable } = deriveBaselineWarmth(
      aPrev,
      requestStartSec,
      cacheable,
      cr,
      300,
      ev.system_sha8,
      ev.cache_prefix_tools_sha8,
      { pxPrefixSha: ev.cache_prefix_sha8, model: ev.model },
    );
    if (hasMeasuredBaseline) {
      if (cacheable > 0) {
        const baselineEff = computeBaselineInputEffWithCacheTier(
          ev.baseline_tokens!,
          cacheable,
          inp,
          cc,
          cr,
          warm,
          prevCacheable,
          cc1h,
          cc5m,
          readRate,
        );
        weightedSaved = baselineEff - actualEff;
      } else if (cc === 0 && cr === 0) {
        weightedSaved = ev.baseline_tokens! - inp;
      } else if (warm && cr === 0) {
        const unproxiedRaw = ev.baseline_tokens!;
        const reusedTarget = warmthState?.anthropicObservedPrefix ?? 0;
        const reused = Math.min(unproxiedRaw, reusedTarget);
        const createRate = cc > 0 ? (cc1h > 0 && cc1h >= cc ? 2.0 : 1.25) : 1.0;
        const baselineEff = reused * readRate + (unproxiedRaw - reused) * createRate;
        weightedSaved = baselineEff - actualEff;
      } else {
        weightedSaved = 0;
      }
    } else if (savedTokens !== 0 && inputTokens > 0) {
      if (warm && cr === 0) {
        const unproxiedRaw = inp + cc + savedTokens;
        const reusedTarget = prevCacheable > 0 ? prevCacheable : (warmthState?.anthropicObservedPrefix ?? 0);
        if (reusedTarget > 0) {
          const reused = Math.min(unproxiedRaw, reusedTarget);
          const createRate = cc > 0 ? (cc1h > 0 && cc1h >= cc ? 2.0 : 1.25) : 1.0;
          const baselineEff = reused * readRate + (unproxiedRaw - reused) * createRate;
          weightedSaved = baselineEff - actualEff;
        } else {
          weightedSaved = savedTokens * readRate;
        }
      } else {
        const deltaWeight = cr > 0
          ? readRate
          : cc > 0 ? (cc1h > 0 && cc1h >= cc ? 2.0 : 1.25) : 1.0;
        weightedSaved = savedTokens * deltaWeight;
      }
    } else {
      weightedSaved = savedTokens;
    }
    if (warmthState && inputTokens > 0) {
      warmthState.anthropic = {
        ts: completionSec,
        cacheable: cacheable > 0 ? cacheable : (aPrev?.cacheable ?? 0),
        prefixSha: ev.system_sha8 ?? aPrev?.prefixSha,
        toolsSha: ev.cache_prefix_tools_sha8 ?? aPrev?.toolsSha,
        pxPrefixSha: ev.cache_prefix_sha8 ?? aPrev?.pxPrefixSha,
        model: ev.model ?? aPrev?.model,
        ttlSec: observedCacheTtlSec(cc1h, aPrev?.ttlSec),
      };
      if (cr > 0 || cc > 0) {
        warmthState.anthropicObservedPrefix = cr + cc;
      }
    }
  }

  const cacheHitPct = inputTokens > 0 ? round1((cachedTokens / inputTokens) * 100) : null;

  const mode = priceMode();
  const modelKey = `${mode}:${isGoogle ? 'g' : 'o'}:${ev.model ?? ''}:${inputTokens}`;
  let rates = rateCache?.get(modelKey);
  if (!rates) {
    rates = {
      inUsd: mode === 'kosha'
        ? inputUsdPerMtok(ev.model, { promptTokens: inputTokens, at: eventMs })
        : (!isGoogle ? ASSUMED_INPUT_USD_PER_MTOK : undefined),
    };
    rateCache?.set(modelKey, rates);
  }
  const cliffUsd = ev.cliff_saved_usd ?? 0;
  const tokUsd = rates.inUsd !== undefined ? (weightedSaved * rates.inUsd) / 1_000_000 : 0;
  const savedUsd = round6(tokUsd < 0 ? tokUsd : (cliffUsd > 0 ? Math.max(tokUsd, cliffUsd) : tokUsd));

  const stageSet = new Set<string>();
  if (ev.compressed && (ev.image_count ?? 0) > 0) stageSet.add('image');
  if (Array.isArray(ev.text_hygiene_stages)) {
    for (const s of ev.text_hygiene_stages) {
      if (typeof s === 'string' && s.length > 0) stageSet.add(s);
    }
  }

  return {
    ts: ev.ts,
    ...(ev.model ? { model: ev.model } : {}),
    status: ev.status,
    basis: hasMeasuredBaseline ? 'measured' : 'estimated',
    savedTokens,
    savedUsd,
    cacheHitPct,
    stages: [...stageSet],
    ...(ev.cliff_avoided_at !== undefined ? { cliffAvoidedAt: ev.cliff_avoided_at } : {}),
    ...(cliffUsd > 0 ? { cliffSavedUsd: round6(cliffUsd) } : {}),
    inputTokens,
    cachedTokens,
    ...(ev.first_user_sha8 ? { sessionId: ev.first_user_sha8 } : {}),
  };
}

/** Compute deterministic token, cache-hit, and USD savings for one TrackEvent. */
export function computeTurnSnapshot(ev: TrackEvent): TurnSavingsSnapshot {
  return computeTurnSnapshotWithCache(ev);
}

function emptyRollup(sessionId: string | null = null): SessionSavingsRollup {
  return {
    sessionId,
    turns: 0,
    compressedTurns: 0,
    savedTokens: 0,
    savedUsd: 0,
    cliffSavedUsd: 0,
    avgCacheHitPct: null,
  };
}

// Bound turn-report reads to the trailing byte window and drop any split leading line.
function readTailBuffer(
  filePath: string,
  maxTailBytes: number,
): { buf: Buffer; startOffset: number; size: number; truncatedHead: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) {
      return { buf: Buffer.alloc(0), startOffset: 0, size: 0, truncatedHead: false };
    }

    const bytesToRead = Math.min(stat.size, maxTailBytes);
    let start = Math.max(0, stat.size - bytesToRead);
    let buf = Buffer.allocUnsafe(bytesToRead);
    let totalRead = 0;
    while (totalRead < bytesToRead) {
      const n = fs.readSync(fd, buf, totalRead, bytesToRead - totalRead, start + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    if (totalRead === 0 && start > 0) {
      const shrunkStat = fs.fstatSync(fd);
      if (shrunkStat.size <= 0) {
        return { buf: Buffer.alloc(0), startOffset: 0, size: 0, truncatedHead: false };
      }
      const retryBytes = Math.min(shrunkStat.size, maxTailBytes);
      start = Math.max(0, shrunkStat.size - retryBytes);
      buf = Buffer.allocUnsafe(retryBytes);
      while (totalRead < retryBytes) {
        const n = fs.readSync(fd, buf, totalRead, retryBytes - totalRead, start + totalRead);
        if (n <= 0) break;
        totalRead += n;
      }
    }
    const slice = totalRead === buf.length ? buf : buf.subarray(0, totalRead);
    if (start > 0) {
      const firstNl = slice.indexOf(0x0a);
      if (firstNl < 0) {
        return {
          buf: Buffer.alloc(0),
          startOffset: start + totalRead,
          size: start + totalRead,
          truncatedHead: true,
        };
      }
      return {
        buf: slice.subarray(firstNl + 1),
        startOffset: start + firstNl + 1,
        size: start + totalRead,
        truncatedHead: true,
      };
    }
    return { buf: slice, startOffset: 0, size: totalRead, truncatedHead: false };
  } finally {
    fs.closeSync(fd);
  }
}

function readCursor(cursorFile: string): CursorState | null {
  try {
    const raw = fs.readFileSync(cursorFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CursorState>;
    if (typeof parsed.ts === 'string' && typeof parsed.offset === 'number' && Number.isFinite(parsed.offset)) {
      return { ts: parsed.ts, offset: parsed.offset };
    }
  } catch {
    // Missing or corrupt cursor behaves as unseen.
  }
  return null;
}

function writeCursor(cursorFile: string, state: CursorState): void {
  const dir = path.dirname(cursorFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nonce = crypto.randomBytes(6).toString('hex');
  const tmp = `${cursorFile}.${process.pid}.${nonce}.tmp`;
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(tmp, flags, 0o600);
  let closed = false;
  try {
    fs.fchmodSync(fd, 0o600);
    const payload = Buffer.from(JSON.stringify(state), 'utf8');
    let written = 0;
    while (written < payload.length) {
      written += fs.writeSync(fd, payload, written, payload.length - written);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    closed = true;
    fs.renameSync(tmp, cursorFile);
  } catch (err) {
    if (!closed) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function parseJsonLine(lineBuf: Buffer): TrackEvent | null {
  let s = 0;
  let e = lineBuf.length;
  while (s < e && lineBuf[s]! <= 32) s++;
  while (e > s && lineBuf[e - 1]! <= 32) e--;
  if (e - s < 2 || lineBuf[s] !== 0x7b) return null;
  try {
    const parsed = JSON.parse(lineBuf.subarray(s, e).toString('utf8')) as TrackEvent;
    return isInferenceEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Read latest turn + session rollup from `eventsFile` (and rotated `.1` if needed) with optional cursor de-duplication. */
export function readTurnReport(eventsFile: string, opts: ReadTurnReportOptions = {}): TurnReportPayload {
  const maxTailBytes = opts.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES;
  const files = eventLogFiles(eventsFile);
  if (files.length === 0) {
    return { eventsFile, hasNewTurn: false, lastTurn: null, session: emptyRollup(null) };
  }

  // Pass 1: reverse scan newest -> oldest file for the latest valid inference event.
  let lastEv: TrackEvent | null = null;
  let lastLineStart = 0;
  let tail: { buf: Buffer; startOffset: number; size: number; truncatedHead: boolean } | null = null;
  let lastFileIdx = -1;
  for (let fi = files.length - 1; fi >= 0; fi--) {
    const candidateTail = readTailBuffer(files[fi]!, maxTailBytes);
    if (!candidateTail || candidateTail.buf.length === 0) continue;
    const buf = candidateTail.buf;
    let lineEnd = buf.length;
    while (lineEnd > 0) {
      const nl = buf.lastIndexOf(0x0a, lineEnd - 1);
      const lineStart = nl >= 0 ? nl + 1 : 0;
      const ev = parseJsonLine(buf.subarray(lineStart, lineEnd));
      if (ev) {
        lastEv = ev;
        lastLineStart = lineStart;
        tail = candidateTail;
        lastFileIdx = fi;
        break;
      }
      lineEnd = nl;
      if (nl < 0) break;
    }
    if (lastEv) break;
  }

  if (!lastEv || !tail) {
    return { eventsFile, hasNewTurn: false, lastTurn: null, session: emptyRollup(null) };
  }

  const rateCache = new Map<string, CachedModelRates>();
  const sessionId = lastEv.first_user_sha8 ?? null;
  const lastMs = Date.parse(lastEv.ts);
  const sessionNeedle = sessionId ? Buffer.from(sessionId, 'ascii') : null;

  // Pass 2: reverse scan prior lines, pre-filtering in native Buffer before JSON.parse,
  // and spilling back to any older rotated `.1` log if the active tail is shorter than maxTailBytes.
  const sessionEvents: TrackEvent[] = [lastEv];
  const scanPrior = (buf: Buffer, initialEnd: number): boolean => {
    let scanEnd = initialEnd;
    while (scanEnd > 0) {
      const nl = buf.lastIndexOf(0x0a, scanEnd - 1);
      const lineStart = nl >= 0 ? nl + 1 : 0;
      const slice = buf.subarray(lineStart, scanEnd);
      scanEnd = nl >= 0 ? nl : 0;
      if (slice.length < 2) continue;
      if (sessionNeedle) {
        if (!slice.includes(sessionNeedle)) continue;
        const ev = parseJsonLine(slice);
        if (ev && ev.first_user_sha8 === sessionId) {
          sessionEvents.push(ev);
        }
      } else {
        const ev = parseJsonLine(slice);
        if (!ev) continue;
        if (Number.isFinite(lastMs)) {
          const evMs = Date.parse(ev.ts);
          if (!Number.isFinite(evMs)) continue;
          if (lastMs - evMs > SESSION_FALLBACK_WINDOW_MS) return false;
        }
        sessionEvents.push(ev);
      }
    }
    return true;
  };

  const keepScanningOlder = scanPrior(tail.buf, lastLineStart > 0 ? lastLineStart - 1 : 0);
  if (keepScanningOlder && !tail.truncatedHead && lastFileIdx > 0) {
    let remainingBudget = maxTailBytes - tail.buf.length;
    for (let fi = lastFileIdx - 1; fi >= 0 && remainingBudget > 0; fi--) {
      const olderTail = readTailBuffer(files[fi]!, remainingBudget);
      if (!olderTail || olderTail.buf.length === 0) continue;
      remainingBudget -= olderTail.buf.length;
      const cont = scanPrior(olderTail.buf, olderTail.buf.length);
      if (!cont || olderTail.truncatedHead) break;
    }
  }

  sessionEvents.reverse();
  const warmthState: TurnWarmthState = {};
  const sessionSnapshots: TurnSavingsSnapshot[] = sessionEvents.map((ev) =>
    computeTurnSnapshotWithCache(ev, rateCache, warmthState),
  );
  const lastTurn = sessionSnapshots[sessionSnapshots.length - 1]!;

  let savedTokens = 0;
  let savedUsd = 0;
  let cliffSavedUsd = 0;
  let compressedTurns = 0;
  let cacheWeightSum = 0;
  let cacheTokTotal = 0;

  for (let i = 0; i < sessionSnapshots.length; i++) {
    const snap = sessionSnapshots[i]!;
    savedTokens += snap.savedTokens;
    savedUsd += snap.savedUsd;
    cliffSavedUsd += snap.cliffSavedUsd ?? 0;
    if (snap.savedTokens > 0 || snap.stages.length > 0) compressedTurns += 1;
    if (snap.inputTokens > 0) {
      cacheTokTotal += snap.inputTokens;
      cacheWeightSum += snap.cachedTokens;
    }
  }

  const session: SessionSavingsRollup = {
    sessionId,
    turns: sessionSnapshots.length,
    compressedTurns,
    savedTokens,
    savedUsd: round6(savedUsd),
    cliffSavedUsd: round6(cliffSavedUsd),
    avgCacheHitPct: cacheTokTotal > 0 ? round1((cacheWeightSum / cacheTokTotal) * 100) : null,
  };

  const lastLineAbsOffset = Math.max(0, tail.startOffset + lastLineStart);
  let hasNewTurn = true;
  if (opts.cursorFile) {
    const prev = readCursor(opts.cursorFile);
    hasNewTurn = prev === null || prev.ts !== lastTurn.ts || prev.offset !== lastLineAbsOffset;
    if (hasNewTurn && opts.updateCursor !== false) {
      try {
        writeCursor(opts.cursorFile, { ts: lastTurn.ts, offset: lastLineAbsOffset });
      } catch {
        // Non-fatal: cursor write failures never fail hooks or CLI status.
      }
    }
  }

  return { eventsFile, hasNewTurn, lastTurn, session };
}

function formatCompactTokens(tokens: number): string {
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(abs / 1_000).toFixed(1)}k`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(2)}k`;
  return String(abs);
}

function formatSignedTokens(savedTokens: number): string {
  return savedTokens < 0
    ? `+${formatCompactTokens(savedTokens)}`
    : `-${formatCompactTokens(savedTokens)}`;
}

function formatUsd(usd: number): string {
  if (usd === 0) return '';
  const sign = usd > 0 ? '-' : '+';
  const abs = Math.abs(usd);
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  if (abs < 1) return `${sign}$${abs.toFixed(3)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Markdown summary suitable for Antigravity `metadata.user_markdown`. */
export function formatTurnReportMarkdown(payload: TurnReportPayload): string {
  const { lastTurn, session } = payload;
  if (!lastTurn) return '';
  const modelLabel = lastTurn.model ? ` **${lastTurn.model}**` : '';
  const turnUsd = formatUsd(lastTurn.savedUsd);
  const turnUsdPart = turnUsd ? ` (${turnUsd})` : '';
  const cachePart = lastTurn.cacheHitPct !== null ? ` · **${Math.round(lastTurn.cacheHitPct)}% cache**` : '';
  const stagesPart = lastTurn.stages.length > 0 ? ` · \`${lastTurn.stages.join('+')}\`` : '';
  const cliffPart =
    lastTurn.cliffAvoidedAt !== undefined ? ` · cliff <${formatCompactTokens(lastTurn.cliffAvoidedAt)} avoided` : '';
  const sessUsd = formatUsd(session.savedUsd);
  const sessUsdPart = sessUsd ? ` (${sessUsd})` : '';
  const sessVerb = session.savedTokens < 0 ? 'delta' : 'session';
  const sessPart =
    session.turns > 1
      ? ` · ${sessVerb} **${formatSignedTokens(session.savedTokens)} tok**${sessUsdPart}, ${session.turns}t`
      : '';
  const verb = lastTurn.savedTokens < 0 ? 'delta' : 'saved';
  return `\`fiche\`${modelLabel} · ${verb} **${formatSignedTokens(lastTurn.savedTokens)} tok**${turnUsdPart}${cachePart}${stagesPart}${cliffPart}${sessPart}`;
}

/** Antigravity `PostInvocation` hook JSON output (zero LLM tokens via empty `systemMessage`). */
export function formatAgyHookJson(payload: TurnReportPayload): Record<string, unknown> {
  if (!payload.hasNewTurn || !payload.lastTurn) return {};
  if (payload.lastTurn.savedTokens === 0 && payload.session.savedTokens === 0) return {};
  const md = formatTurnReportMarkdown(payload);
  if (!md) return {};
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: md,
          },
        },
      },
    ],
  };
}

/** Compact single-line output for Claude Code `statusLine`. */
export function formatClaudeStatusLine(payload: TurnReportPayload): string {
  const { lastTurn, session } = payload;
  if (!lastTurn) return '';
  const model = lastTurn.model ? `${lastTurn.model} ` : '';
  const turnUsd = formatUsd(lastTurn.savedUsd);
  const usdSuffix = turnUsd ? ` (${turnUsd})` : '';
  const cache = lastTurn.cacheHitPct !== null ? ` | ${Math.round(lastTurn.cacheHitPct)}% cache` : '';
  const sessUsd = formatUsd(session.savedUsd);
  const sessPart =
    session.turns > 1
      ? ` | sess ${formatSignedTokens(session.savedTokens)}${sessUsd ? ` (${sessUsd})` : ''}`
      : '';
  return `fiche ${model}${formatSignedTokens(lastTurn.savedTokens)} tok${usdSuffix}${cache}${sessPart}`;
}

/** Compact single-line CLI output (optionally ANSI colored). */
export function formatCliLine(payload: TurnReportPayload, color = false): string {
  const { lastTurn, session } = payload;
  if (!lastTurn) return '[fiche] no recorded turns yet';
  const line = formatClaudeStatusLine(payload);
  const stages = lastTurn.stages.length > 0 ? ` [${lastTurn.stages.join('+')}]` : '';
  const full = `${line}${stages} (${session.turns}t)`;
  return color ? `\x1b[36m${full}\x1b[0m` : full;
}

export function defaultEventsFilePath(): string {
  const configured = readBrandEnv('LOG');
  if (configured !== undefined && configured !== '') return configured;
  const preferred = path.join(os.homedir(), '.fiche', 'events.jsonl');
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(os.homedir(), '.inkling', 'events.jsonl');
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

/** CLI runner for `fiche turn-report`. */
export function runTurnReportCli(
  argv: readonly string[],
  defaultEventsFile: string,
): { code: number; out: string; err: string } {
  let format: TurnReportFormat = 'cli';
  let filePath = defaultEventsFile;
  let cursorFile: string | undefined;
  let updateCursor = true;
  let color = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--format' && argv[i + 1]) {
      const f = argv[++i]!;
      if (f === 'cli' || f === 'agy' || f === 'claude-statusline' || f === 'json') format = f;
      else return { code: 2, out: '', err: `[fiche turn-report] unknown format: ${f}` };
    } else if (a.startsWith('--format=')) {
      const f = a.slice('--format='.length);
      if (f === 'cli' || f === 'agy' || f === 'claude-statusline' || f === 'json') format = f;
      else return { code: 2, out: '', err: `[fiche turn-report] unknown format: ${f}` };
    } else if ((a === '--file' || a === '-f') && argv[i + 1]) {
      filePath = argv[++i]!;
    } else if (a.startsWith('--file=')) {
      filePath = a.slice('--file='.length);
    } else if (a === '--cursor' && argv[i + 1]) {
      cursorFile = argv[++i]!;
    } else if (a.startsWith('--cursor=')) {
      cursorFile = a.slice('--cursor='.length);
    } else if (a === '--json') {
      format = 'json';
    } else if (a === '--no-update-cursor') {
      updateCursor = false;
    } else if (a === '--color') {
      color = true;
    } else if (a === '--help' || a === '-h') {
      return {
        code: 0,
        out: [
          'fiche turn-report — report latest turn & session token/$ savings from events JSONL',
          '',
          'Options:',
          '  --format=cli|agy|claude-statusline|json   Output format (default: cli)',
          '  --json                                    Alias for --format=json',
          '  --file <path>                             Events JSONL (default: $FICHE_LOG or ~/.fiche/events.jsonl)',
          '  --cursor <path>                           Cursor file for deduplicating repeat hook calls',
          '  --no-update-cursor                        Inspect cursor without updating it',
          '  --color                                   ANSI color for cli format',
        ].join('\n'),
        err: '',
      };
    } else {
      return { code: 2, out: '', err: `[fiche turn-report] unknown option: ${a}` };
    }
  }

  const payload = readTurnReport(filePath, { cursorFile, updateCursor });
  if (format === 'json') {
    return { code: 0, out: JSON.stringify(payload, null, 2), err: '' };
  }
  if (format === 'agy') {
    return { code: 0, out: JSON.stringify(formatAgyHookJson(payload)), err: '' };
  }
  if (format === 'claude-statusline') {
    return { code: 0, out: formatClaudeStatusLine(payload), err: '' };
  }
  return { code: 0, out: formatCliLine(payload, color), err: '' };
}
