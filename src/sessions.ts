/**
 * Shared data layer for the dashboard's session views. Node-only (filesystem
 * I/O) — never imported from `src/core/`.
 *
 * ## Why we group by first_user_sha8 (Path B)
 *
 * Every TrackEvent carries `first_user_sha8` (see src/core/tracker.ts), an
 * sha256 prefix of the conversation's first prompt (harness envelopes skipped;
 * see src/core/session-state.ts:sessionAnchorText). Within a single
 * Claude Code session that hash is stable across every turn; across two
 * different sessions it is virtually never the same. That makes it a
 * better-than-good-enough session key without coupling inkling to Claude
 * Code's internal file layout for *correctness*.
 *
 * We *do* read `~/.claude/projects/` opportunistically (see `claudeCodeMap`)
 * to enrich the dashboard with real Claude Code session IDs + project
 * paths — but it's best-effort: missing or unreadable files just leave the
 * synthetic ID standing alone.
 *
 * ## File layout we manage
 *
 * - `~/.inkling/events.jsonl` — append-only JSONL written by FileTracker
 * - `~/.inkling/4xx-bodies/${iso-ts}-${sha8}.json.gz` — gzipped failure
 *   bodies referenced from JSONL rows via `req_body_sample_path`
 */

import * as fs from 'node:fs';
import { readBrandEnv } from './core/env.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import { eventLogFiles } from './file-tracker.js';
import type { TrackEvent } from './core/tracker.js';
import {
  computeActualInputEffWithCacheTier,
  computeBaselineInputEffWithCacheTier,
  deriveBaselineWarmth,
  observedCacheTtlSec,
  type BaselineWarmthPrev,
} from './core/baseline.js';
import { sessionAnchorText } from './core/session-state.js';
import { anthropicReadRate, priceMode, resolvePriceRates } from './core/pricing.js';
import {
  computeOpenAIActualInputEff,
  computeOpenAISessionBaselineInputEff,
  deriveOpenAIBaselineWarmth,
  OPENAI_CACHE_TTL_SEC,
  type OpenAIWarmthPrev,
} from './core/openai-savings.js';

// ---- Types -----------------------------------------------------------------

export interface SessionSummary {
  /** The synthetic session ID = first_user_sha8 (or '<unknown>' if missing). */
  id: string;
  /** Working directory of the first event in the session, if any. */
  project: string | undefined;
  /** ISO timestamp of the first event we saw for this session. */
  firstSeen: string;
  /** ISO timestamp of the last event we saw for this session. */
  lastSeen: string;
  /** Number of events recorded against this session. */
  requestCount: number;
  /** `tokensSavedEst × 4` — a coarse byte-equivalent of the token savings,
   *  useful only as a rough "we shaved X kB off the wire" callout. Not
   *  load-bearing math; the real number is `tokensSavedEst`. */
  charsSaved: number;
  /** Real input-side tokens saved: sum of `baseline_tokens − (input +
   *  cache_create×1.25 + cache_read×0.10)` across events that carry both
   *  a /v1/messages/count_tokens probe and an upstream usage block.
   *  Events missing either side contribute to requestCount but not here.
   *  No estimation — can go negative when a compression net-lost. */
  tokensSavedEst: number;
  /** Sum of cache_read_input_tokens — actual prompt-cache hits. */
  cacheReadTokens: number;
  /** Bytes attributable to this session in events.jsonl (sum of line lengths
   *  including the trailing newline). */
  jsonlBytes: number;
  /** Bytes attributable to this session in 4xx-bodies/ sidecars. */
  sidecarBytes: number;
}

export interface DiskUsage {
  eventsJsonlBytes: number;
  sidecarsBytes: number;
  sidecarCount: number;
  totalBytes: number;
}

/** Resolved paths a sessions invocation will touch. Single source of truth so
 *  tests can point the whole module at a tmpdir. */
export interface SessionsPaths {
  eventsFile: string;
  sidecarDir: string;
}

export function defaultPaths(): SessionsPaths {
  const home = os.homedir();
  const preferred = path.join(home, '.fiche', 'events.jsonl');
  const legacy = path.join(home, '.inkling', 'events.jsonl');
  const eventsFile =
    readBrandEnv('LOG') ?? (fs.existsSync(preferred) || !fs.existsSync(legacy) ? preferred : legacy);
  // The sidecar directory is `4xx-bodies` next to the events file, matching
  // what src/node.ts writes.
  const sidecarDir = path.join(path.dirname(eventsFile), '4xx-bodies');
  return { eventsFile, sidecarDir };
}

// ---- Core reader -----------------------------------------------------------

/** Lazily stream events.jsonl line by line. Yields parsed TrackEvents plus
 *  the raw line (we need byte length for jsonlBytes accounting). Malformed
 *  lines are silently dropped — matches `inkling stats` behavior. */
export async function* readEvents(
  eventsFile: string,
): AsyncGenerator<{ ev: TrackEvent; rawBytes: number }> {
  for (const file of eventLogFiles(eventsFile)) {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let ev: TrackEvent;
      try {
        ev = JSON.parse(line) as TrackEvent;
      } catch {
        continue;
      }
      // +1 for the newline FileTracker writes after each row.
      yield { ev, rawBytes: Buffer.byteLength(line, 'utf8') + 1 };
    }
  }
}

// ---- Aggregation -----------------------------------------------------------

export const UNKNOWN_SESSION = '<unknown>';

function sessionIdOf(ev: TrackEvent): string {
  return ev.session_key ?? ev.first_user_sha8 ?? UNKNOWN_SESSION;
}

export interface AggregateResult {
  sessions: Map<string, SessionSummary>;
  /** sessionId -> set of absolute sidecar paths referenced by its events. */
  sidecarsBySession: Map<string, Set<string>>;
}

/** Build a map of sessionId -> SessionSummary by scanning every event. Also
 *  tracks which sidecars belong to which session so prune can clean them. */
export async function aggregateSessions(
  paths: SessionsPaths,
): Promise<AggregateResult> {
  const sessions = new Map<string, SessionSummary>();
  const sidecarsBySession = new Map<string, Set<string>>();
  // Per-session prior rows for the cache-aware text counterfactual: a fresh
  // same-prefix prior makes the text path warm, and sizes the reused/grown
  // split. Kept out of SessionSummary so it never leaks into the
  // /api/sessions.json shape.
  const warmth = new Map<string, BaselineWarmthPrev & { observedCachedTokens?: number }>();
  const openaiWarmth = new Map<string, OpenAIWarmthPrev>();
  const googleWarmth = new Map<string, OpenAIWarmthPrev>();
  const CACHE_TTL_SEC = 300; // default; a 1h-tier prior carries 3600 s (observedCacheTtlSec)

  // Stat sidecar sizes once up front. Looking up size per event would be
  // O(N²) syscalls; the directory is small enough to read fully.
  const sidecarSizes = sidecarFileSizes(paths.sidecarDir);

  for await (const { ev, rawBytes } of readEvents(paths.eventsFile)) {
    const id = sessionIdOf(ev);
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        project: ev.cwd,
        firstSeen: ev.ts,
        lastSeen: ev.ts,
        requestCount: 0,
        charsSaved: 0,
        tokensSavedEst: 0,
        cacheReadTokens: 0,
        jsonlBytes: 0,
        sidecarBytes: 0,
      };
      sessions.set(id, s);
    }
    s.requestCount++;
    s.jsonlBytes += rawBytes;
    if (ev.ts < s.firstSeen) s.firstSeen = ev.ts;
    if (ev.ts > s.lastSeen) s.lastSeen = ev.ts;
    // Cling to whichever cwd we saw first; sessions that hop directories are
    // rare and the first cwd is the most stable identifier.
    if (s.project === undefined && ev.cwd) s.project = ev.cwd;
    // Real per-session savings, cache-aware. See src/core/baseline.ts for the
    // full derivation: inkling is credited only for token reduction, never for
    // caching. The imagined text baseline is warm when cr>0, or when a
    // same-prefix prior completed within the TTL (see deriveBaselineWarmth).
    // Events missing either probe stay out of the rollup — no estimation.
    const inp = ev.input_tokens ?? 0;
    const cc = ev.cache_create_tokens ?? 0;
    const cc5m = ev.cache_create_5m_tokens;
    const cc1h = ev.cache_create_1h_tokens ?? 0;
    const cr = ev.cache_read_tokens ?? 0;
    const cached = ev.cached_tokens ?? 0;
    const cacheWrite = ev.cache_write_tokens ?? 0;
    const out = ev.output_tokens ?? 0;
    const pathIsOpenAI = ev.path.includes('responses') || ev.path.includes('chat/completions');
    const isOpenAI = ev.accounting_provider ? ev.accounting_provider === 'openai' : pathIsOpenAI;
    const isGoogle = ev.accounting_provider
      ? ev.accounting_provider === 'google'
      : !pathIsOpenAI && (ev.path.includes('google-ai-studio') || ev.path.toLowerCase().includes('generatecontent'));
    const haveUsage = inp > 0 || out > 0 || cc > 0 || cr > 0 || cached > 0 || cacheWrite > 0;
    const completionSec = Date.parse(ev.ts) / 1000;
    const requestStartSec = completionSec - Math.max(0, ev.duration_ms || 0) / 1000;
    const baseline = ev.baseline_tokens;

    if (isGoogle) {
      const gPrev = googleWarmth.get(id);
      const pxShaG = ev.cache_prefix_sha8 ?? ev.history_image_sha8;
      const gWarmth = deriveOpenAIBaselineWarmth(
        gPrev,
        requestStartSec,
        cached,
        ev.system_sha8,
        ev.model,
        CACHE_TTL_SEC,
        pxShaG,
      );
      const measured = ev.baseline_probe_status === 'ok' && typeof baseline === 'number' && baseline > 0
        ? baseline
        : 0;
      const hygieneTok = ev.text_hygiene_saved_tokens ?? 0;
      const estimated = ev.compressed === true
        && (((ev.image_tokens ?? 0) > 0 && (ev.baseline_imaged_tokens ?? 0) > 0) || hygieneTok > 0)
        ? Math.max(
            0,
            inp
              - (ev.image_tokens ?? 0)
              - (ev.native_injected_tokens ?? 0)
              + (ev.baseline_imaged_tokens ?? 0)
              + hygieneTok,
          )
        : 0;
      const gBaseline = measured || estimated;
      const clampedCached = Math.min(inp, Math.max(0, cached));
      if (ev.compressed === true && haveUsage && gBaseline > 0) {
        let tokensSaved: number;
        if (priceMode() === 'kosha') {
          const rates = resolvePriceRates(ev.model, { promptTokens: inp });
          if (gWarmth.selfBusted) {
            const reused = Math.min(gBaseline, gWarmth.prevPrefixTokens);
            const baselineEff = reused * rates.read + (gBaseline - reused) * 1.0;
            const actualEff = (inp - clampedCached) + clampedCached * rates.read;
            tokensSaved = baselineEff - actualEff;
          } else {
            tokensSaved = (gBaseline - inp) * (clampedCached > 0 ? rates.read : 1);
          }
        } else {
          tokensSaved = gBaseline - inp;
        }
        s.tokensSavedEst += Math.round(tokensSaved);
        s.charsSaved += Math.round(tokensSaved * 4);
      }
      if (haveUsage) {
        googleWarmth.set(id, {
          ts: completionSec,
          cachedOrPrefixTokens: clampedCached > 0 ? clampedCached : 0,
          prefixSha: ev.system_sha8 ?? gPrev?.prefixSha,
          pxPrefixSha: pxShaG ?? gPrev?.pxPrefixSha,
          model: ev.model ?? gPrev?.model,
        });
      }
    } else if (isOpenAI) {
      const oPrev = openaiWarmth.get(id);
      const pxShaO = ev.cache_prefix_sha8 ?? ev.history_image_sha8;
      const oWarmth = deriveOpenAIBaselineWarmth(
        oPrev,
        requestStartSec,
        cached,
        ev.system_sha8,
        ev.model,
        OPENAI_CACHE_TTL_SEC,
        pxShaO,
      );
      const hygieneTok = ev.text_hygiene_saved_tokens ?? 0;
      if (
        ev.compressed === true &&
        haveUsage &&
        ((ev.baseline_imaged_tokens ?? 0) > 0 || hygieneTok > 0)
      ) {
        const actualEff = computeOpenAIActualInputEff(inp, cached, ev.model, cacheWrite);
        const baselineEff = computeOpenAISessionBaselineInputEff({
          inputTokens: inp,
          cachedTokens: cached,
          imageTokens: ev.image_tokens ?? 0,
          baselineImagedTokens: ev.baseline_imaged_tokens ?? 0,
          nativeInjectedTokens: ev.native_injected_tokens ?? 0,
          textHygieneSavedTokens: hygieneTok,
          cacheWriteTokens: cacheWrite,
          model: ev.model,
          warmth: oWarmth,
        });
        const tokensSaved = baselineEff - actualEff;
        s.tokensSavedEst += Math.round(tokensSaved);
        s.charsSaved += Math.round(tokensSaved * 4);
      }
      if (haveUsage) {
        openaiWarmth.set(id, {
          ts: completionSec,
          cachedOrPrefixTokens: cached > 0 ? cached : 0,
          prefixSha: ev.system_sha8 ?? oPrev?.prefixSha,
          pxPrefixSha: pxShaO ?? oPrev?.pxPrefixSha,
          model: ev.model ?? oPrev?.model,
        });
      }
    } else if (
      typeof baseline === 'number' &&
      baseline > 0 &&
      haveUsage &&
      ev.compressed === true &&
      (ev.baseline_probe_status === 'ok' || ev.baseline_probe_status === undefined)
    ) {
      const cacheable = ev.baseline_cacheable_tokens ?? 0;
      const prefixSha = ev.system_sha8;
      const prev = warmth.get(id);
      const { warm, prevCacheable } = deriveBaselineWarmth(
        prev,
        requestStartSec,
        cacheable,
        cr,
        CACHE_TTL_SEC,
        prefixSha,
        ev.cache_prefix_tools_sha8,
        { pxPrefixSha: ev.cache_prefix_sha8, model: ev.model },
      );
      const baselineEff = computeBaselineInputEffWithCacheTier(
        baseline,
        cacheable,
        inp,
        cc,
        cr,
        warm,
        prevCacheable,
        cc1h,
        cc5m,
        anthropicReadRate(ev.model),
      );
      const actualEff = computeActualInputEffWithCacheTier(inp, cc, cr, cc1h, cc5m, anthropicReadRate(ev.model));
      const tokensSaved = baselineEff - actualEff;
      s.tokensSavedEst += Math.round(tokensSaved);
      s.charsSaved += Math.round(tokensSaved * 4);
    } else if (
      haveUsage &&
      ev.compressed === true &&
      (ev.text_hygiene_saved_tokens ?? 0) > 0 &&
      (ev.image_count ?? 0) === 0
    ) {
      const hygieneTok = ev.text_hygiene_saved_tokens ?? 0;
      const readRate = anthropicReadRate(ev.model);
      const prev = warmth.get(id);
      const { warm, prevCacheable } = deriveBaselineWarmth(
        prev,
        requestStartSec,
        ev.baseline_cacheable_tokens ?? 0,
        cr,
        CACHE_TTL_SEC,
        ev.system_sha8,
        ev.cache_prefix_tools_sha8,
        { pxPrefixSha: ev.cache_prefix_sha8, model: ev.model },
      );
      let tokensSaved: number;
      if (warm && cr === 0) {
        const actualEff = computeActualInputEffWithCacheTier(inp, cc, cr, cc1h, cc5m, readRate);
        const unproxiedRaw = inp + cc + hygieneTok;
        const reusedTarget = prevCacheable > 0 ? prevCacheable : (prev?.observedCachedTokens ?? 0);
        if (reusedTarget > 0) {
          const reused = Math.min(unproxiedRaw, reusedTarget);
          const createRate = cc > 0 ? (cc1h > 0 && cc1h >= cc ? 2.0 : 1.25) : 1.0;
          const baselineEff = reused * readRate + (unproxiedRaw - reused) * createRate;
          tokensSaved = baselineEff - actualEff;
        } else {
          tokensSaved = hygieneTok * readRate;
        }
      } else {
        const deltaWeight = cr > 0
          ? readRate
          : cc > 0 ? (cc1h > 0 && cc1h >= cc ? 2.0 : 1.25) : 1.0;
        tokensSaved = hygieneTok * deltaWeight;
      }
      s.tokensSavedEst += Math.round(tokensSaved);
      s.charsSaved += Math.round(tokensSaved * 4);
    }
    // Record this completed row's prefix for later warmth/split decisions.
    // Carry prior cacheable when this row had no probe.
    if (haveUsage && !isGoogle && !isOpenAI) {
      const cacheable = ev.baseline_cacheable_tokens ?? 0;
      const prefixSha = ev.system_sha8;
      const prev = warmth.get(id);
      warmth.set(id, {
        ts: completionSec,
        cacheable: cacheable > 0 ? cacheable : (prev?.cacheable ?? 0),
        prefixSha: prefixSha ?? prev?.prefixSha,
        toolsSha: ev.cache_prefix_tools_sha8 ?? prev?.toolsSha,
        pxPrefixSha: ev.cache_prefix_sha8 ?? prev?.pxPrefixSha,
        model: ev.model ?? prev?.model,
        ttlSec: observedCacheTtlSec(ev.cache_create_1h_tokens, prev?.ttlSec),
        observedCachedTokens: cr > 0 || cc > 0 ? cr + cc : prev?.observedCachedTokens,
      });
    }
    const cacheReadEv = ev.cache_read_tokens ?? ev.cached_tokens;
    if (typeof cacheReadEv === 'number') {
      s.cacheReadTokens += cacheReadEv;
    }
    if (ev.req_body_sample_path) {
      let set = sidecarsBySession.get(id);
      if (!set) {
        set = new Set();
        sidecarsBySession.set(id, set);
      }
      set.add(ev.req_body_sample_path);
      const size = sidecarSizes.get(ev.req_body_sample_path);
      if (typeof size === 'number') s.sidecarBytes += size;
    }
  }

  return { sessions, sidecarsBySession };
}

// ---- list / filter --------------------------------------------------------

export interface ListOptions {
  /** Substring or basename match against `cwd`. */
  project?: string;
  /** ISO timestamp; only sessions whose lastSeen >= since survive. */
  since?: string;
}

/** Sort SessionSummary entries most-recent-first and apply optional filters.
 *  Pure: the dashboard maps query-string params straight into ListOptions. */
export function filterSessions(
  sessions: Map<string, SessionSummary>,
  opts: ListOptions,
): SessionSummary[] {
  return [...sessions.values()]
    .filter((s) => {
      if (opts.project) {
        if (!s.project) return false;
        if (
          s.project !== opts.project &&
          path.basename(s.project) !== opts.project &&
          !s.project.includes(opts.project)
        ) {
          return false;
        }
      }
      if (opts.since && s.lastSeen < opts.since) return false;
      return true;
    })
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

function sidecarFileSizes(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) out.set(full, st.size);
    } catch {
      /* concurrent delete is fine */
    }
  }
  return out;
}

// ---- prune -----------------------------------------------------------------

export interface PruneOptions {
  /** Drop sessions whose lastSeen is older than N days. */
  olderThanDays?: number;
  /** Keep only the N most-recently-active sessions. */
  keepLast?: number;
  /** Drop a single session by ID. */
  sessionId?: string;
  /** Drop multiple sessions in one atomic pass — bulk-delete from the
   *  dashboard's checkbox UI. Unknown IDs are silently ignored (the
   *  caller may have raced a concurrent prune). Coexists with
   *  `sessionId` (single) — both contribute to the removal set. */
  sessionIds?: string[];
  /** When true, actually delete. When false (the default), report only. */
  force: boolean;
}

export interface PruneReport {
  sessionsRemoved: string[];
  eventsRemoved: number;
  eventsKept: number;
  jsonlBytesFreed: number;
  sidecarsRemoved: number;
  sidecarBytesFreed: number;
  /** True when this was a real run (force=true). False for dry-run. */
  applied: boolean;
}

/** Decide which sessions to remove based on the prune options. Pure — no
 *  I/O — so it's easy to unit-test against a synthetic aggregation. */
export function selectSessionsToRemove(
  sessions: Map<string, SessionSummary>,
  opts: PruneOptions,
  now: Date = new Date(),
): Set<string> {
  const toRemove = new Set<string>();
  const all = [...sessions.values()];

  if (opts.sessionId) {
    if (sessions.has(opts.sessionId)) toRemove.add(opts.sessionId);
  }

  if (Array.isArray(opts.sessionIds)) {
    for (const id of opts.sessionIds) {
      // Silently skip unknown IDs — the client may have raced a concurrent
      // prune. The report will reflect what we actually removed.
      if (typeof id === 'string' && sessions.has(id)) toRemove.add(id);
    }
  }

  if (typeof opts.olderThanDays === 'number') {
    const cutoff = new Date(
      now.getTime() - opts.olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    for (const s of all) {
      if (s.lastSeen < cutoff) toRemove.add(s.id);
    }
  }

  if (typeof opts.keepLast === 'number') {
    // Most-recently-active first; everything after keepLast goes.
    const sorted = [...all].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
    for (const s of sorted.slice(opts.keepLast)) toRemove.add(s.id);
  }

  return toRemove;
}

/**
 * Rewrite events.jsonl with rows from `toRemove` sessions stripped out, and
 * delete the matching 4xx-body sidecars. Atomic: writes to a sibling `.tmp`
 * file with fsync, then renames over the original.
 *
 * Concurrency note: `rewriteEventsFile` serializes against both concurrent prune
 * calls on the same path and any registered in-process {@link FileTracker}
 * coordinator (which buffers incoming `emit()` calls in memory during the
 * rewrite and flushes them into the new temp file before atomic rename).
 * External writers appending while no in-process coordinator is active are also
 * tailed synchronously right before `fsyncSync` + `renameSync`.
 */
export interface EventsFileCoordinator {
  runDuringRewrite<T>(
    fn: (flushPending: (outFd: number, writeLine?: (outFd: number, line: string) => void) => void) => Promise<T>,
  ): Promise<T>;
}

const eventsFileCoordinators = new Map<string, EventsFileCoordinator>();
const rewriteLocks = new Map<string, Promise<void>>();

/** Register an in-process append coordinator (e.g. `FileTracker`) for `eventsFile`. */
export function registerEventsFileCoordinator(
  eventsFile: string,
  coordinator: EventsFileCoordinator,
): () => void {
  const key = path.resolve(eventsFile);
  eventsFileCoordinators.set(key, coordinator);
  return () => {
    if (eventsFileCoordinators.get(key) === coordinator) {
      eventsFileCoordinators.delete(key);
    }
  };
}

export async function prune(
  paths: SessionsPaths,
  opts: PruneOptions,
  now: Date = new Date(),
): Promise<PruneReport> {
  const { sessions, sidecarsBySession } = await aggregateSessions(paths);
  const toRemove = selectSessionsToRemove(sessions, opts, now);

  let jsonlBytesFreed = 0;
  let eventsRemoved = 0;
  let eventsKept = 0;
  for (const s of sessions.values()) {
    if (toRemove.has(s.id)) {
      jsonlBytesFreed += s.jsonlBytes;
      eventsRemoved += s.requestCount;
    } else {
      eventsKept += s.requestCount;
    }
  }

  // Collect sidecar paths up for deletion (and their on-disk sizes).
  const sidecarsToDelete: { path: string; size: number }[] = [];
  for (const id of toRemove) {
    const set = sidecarsBySession.get(id);
    if (!set) continue;
    for (const p of set) {
      try {
        const st = fs.statSync(p);
        sidecarsToDelete.push({ path: p, size: st.size });
      } catch {
        /* already gone — fine */
      }
    }
  }
  const sidecarBytesFreed = sidecarsToDelete.reduce((n, s) => n + s.size, 0);

  const report: PruneReport = {
    sessionsRemoved: [...toRemove],
    eventsRemoved,
    eventsKept,
    jsonlBytesFreed,
    sidecarsRemoved: sidecarsToDelete.length,
    sidecarBytesFreed,
    applied: false,
  };

  if (!opts.force) return report;
  if (toRemove.size === 0) {
    report.applied = true;
    return report;
  }

  // Atomic rewrite: stream every existing log file (active + rotated .1) through a
  // filter into a .tmp file, fsync, then rename (or unlink .1 if emptied).
  await rewriteAllEventLogFiles(paths.eventsFile, toRemove);

  for (const { path: p } of sidecarsToDelete) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore — leftover sidecars are harmless */
    }
  }

  report.applied = true;
  return report;
}

function writeFilteredLine(outFd: number, line: string, toRemove: Set<string>): boolean {
  const clean = line.replace(/\r?\n$/, '');
  if (!clean.trim()) return false;
  let ev: TrackEvent;
  try {
    ev = JSON.parse(clean) as TrackEvent;
  } catch {
    // Preserve malformed lines so we don't silently eat data we can't parse.
    fs.writeSync(outFd, clean + '\n');
    return true;
  }
  if (toRemove.has(sessionIdOf(ev))) return false;
  fs.writeSync(outFd, clean + '\n');
  return true;
}

async function rewriteSingleEventLogFile(
  targetFile: string,
  toRemove: Set<string>,
  options: {
    unlinkIfEmpty: boolean;
    flushPending?: (outFd: number, writeLine?: (outFd: number, line: string) => void) => void;
  },
): Promise<void> {
  if (!fs.existsSync(targetFile)) return;
  const tmp = `${targetFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  // Open with O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW and 0o600 permissions so pruned logs never expose prompts.
  const openFlags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  const outFd = fs.openSync(tmp, openFlags, 0o600);
  fs.fchmodSync(outFd, 0o600);
  let outFdClosed = false;
  let renamed = false;
  let keptLines = 0;
  try {
    let streamBytes = 0;
    let streamIno: number | null = null;
    let streamDev: number | null = null;
    const stream = fs.createReadStream(targetFile);
    stream.on('open', (rfd: number) => {
      try {
        const fst = fs.fstatSync(rfd);
        streamIno = fst.ino;
        streamDev = fst.dev;
      } catch {
        /* ignore fstat error */
      }
    });
    stream.on('data', (chunk: string | Buffer) => {
      streamBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, 'utf8');
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (writeFilteredLine(outFd, line, toRemove)) keptLines += 1;
    }
    // Catch up any lines appended externally during async streaming before locking in rename.
    try {
      const st = fs.statSync(targetFile);
      const sameFile = streamIno === null || (st.ino === streamIno && st.dev === streamDev);
      if (sameFile && st.size > streamBytes) {
        const extraBuf = Buffer.allocUnsafe(st.size - streamBytes);
        const rfd = fs.openSync(targetFile, 'r');
        let readTotal = 0;
        try {
          const fst = fs.fstatSync(rfd);
          if (streamIno === null || (fst.ino === streamIno && fst.dev === streamDev)) {
            while (readTotal < extraBuf.length) {
              const n = fs.readSync(rfd, extraBuf, readTotal, extraBuf.length - readTotal, streamBytes + readTotal);
              if (n <= 0) break;
              readTotal += n;
            }
          }
        } finally {
          fs.closeSync(rfd);
        }
        if (readTotal > 0) {
          const tailText = extraBuf.subarray(0, readTotal).toString('utf8');
          for (const tailLine of tailText.split(/\r?\n/)) {
            if (writeFilteredLine(outFd, tailLine, toRemove)) keptLines += 1;
          }
        }
      }
    } catch {
      /* ignore stat race */
    }
    if (options.flushPending) {
      options.flushPending(outFd, (fd, rawLine) => {
        if (writeFilteredLine(fd, rawLine, toRemove)) keptLines += 1;
      });
    }
    if (options.unlinkIfEmpty && keptLines === 0) {
      fs.closeSync(outFd);
      outFdClosed = true;
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore cleanup error */
      }
      try {
        fs.unlinkSync(targetFile);
      } catch {
        /* ignore — already unlinked */
      }
      renamed = true;
      return;
    }
    fs.fsyncSync(outFd);
    fs.closeSync(outFd);
    outFdClosed = true;
    fs.renameSync(tmp, targetFile);
    renamed = true;
    fs.chmodSync(targetFile, 0o600);
  } catch (err) {
    if (!outFdClosed) {
      try {
        fs.closeSync(outFd);
      } catch {
        /* ignore */
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore cleanup error */
      }
    }
    throw err;
  }
}

async function rewriteAllEventLogFiles(
  eventsFile: string,
  toRemove: Set<string>,
): Promise<void> {
  const key = path.resolve(eventsFile);
  const prevLock = rewriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const currentLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  rewriteLocks.set(key, currentLock);
  await prevLock;

  try {
    const runAll = async (
      flushPending?: (outFd: number, writeLine?: (outFd: number, line: string) => void) => void,
    ): Promise<void> => {
      for (const targetFile of eventLogFiles(eventsFile)) {
        const isRotated = targetFile !== eventsFile;
        await rewriteSingleEventLogFile(targetFile, toRemove, {
          unlinkIfEmpty: isRotated,
          flushPending: isRotated ? undefined : flushPending,
        });
      }
    };

    const coordinator = eventsFileCoordinators.get(key);
    if (coordinator) {
      await coordinator.runDuringRewrite((flushPending) => runAll(flushPending));
    } else {
      await runAll();
    }
  } finally {
    release();
    if (rewriteLocks.get(key) === currentLock) {
      rewriteLocks.delete(key);
    }
  }
}

// ---- disk usage ------------------------------------------------------------

export function diskUsage(paths: SessionsPaths): DiskUsage {
  let eventsJsonlBytes = 0;
  for (const file of eventLogFiles(paths.eventsFile)) {
    try {
      eventsJsonlBytes += fs.statSync(file).size;
    } catch {
      /* ignore unreadable/missing rotated or active log */
    }
  }
  const sidecarSizes = sidecarFileSizes(paths.sidecarDir);
  let sidecarsBytes = 0;
  for (const s of sidecarSizes.values()) sidecarsBytes += s;
  return {
    eventsJsonlBytes,
    sidecarsBytes,
    sidecarCount: sidecarSizes.size,
    totalBytes: eventsJsonlBytes + sidecarsBytes,
  };
}

// ---- Claude Code session fingerprint map -----------------------------------

export interface ClaudeCodeSessionRef {
  /** The Claude Code session ID (file basename without .jsonl). */
  sessionId: string;
  /** The decoded project path. Encoded form: `-Users-me-code-foo` →
   *  `/Users/me/code/foo`. Best-effort: dashes in actual path segments
   *  (e.g. `my-project`) round-trip as slashes, so this is for display
   *  only — don't `fs.existsSync` against it. */
  projectPath: string;
  /** First user message text, truncated for display. */
  firstUserPreview: string;
}

/** Path where Claude Code stores per-session JSONL transcripts. */
export function claudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Compute the sha256 prefix the proxy uses for `first_user_sha8` from the
 * anchor text (see src/core/session-state.ts:sessionAnchorText + sha8).
 * Crucially this must match exactly — same 4 KiB cap, same first-8-hex-char
 * prefix — or the map will silently miss every entry.
 */
export function fingerprintFirstUser(text: string): string {
  const trimmed = text.slice(0, 4096);
  const hash = crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex');
  return hash.slice(0, 8);
}

/** Pull the session anchor text out of a single Claude Code session JSONL
 *  file: the text blocks of every user row before the first assistant row,
 *  reduced by the same `sessionAnchorText` rule the proxy applies. */
export async function readFirstUserFromClaudeSession(
  filePath: string,
): Promise<string | undefined> {
  // createReadStream doesn't throw synchronously for ENOENT — the error fires
  // on the 'error' event when read() starts. Pre-check with existsSync so
  // we can return undefined cleanly without an unhandled rejection.
  if (!fs.existsSync(filePath)) return undefined;
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  // Defensive: still attach an error handler so a permission/race-deletion
  // surface doesn't bubble out of readline's async iterator.
  stream.on('error', () => {
    /* swallow — the iterator will end with no rows */
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const texts: string[] = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (r.type === 'assistant') break;
      if (r.type !== 'user') continue;
      const msg = r.message;
      const content =
        msg && typeof msg === 'object'
          ? (msg as Record<string, unknown>).content
          : r.content; // Older Claude Code format: content may live at the top level.
      if (typeof content === 'string') {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as Record<string, unknown>).type === 'text'
          ) {
            const t = (block as Record<string, unknown>).text;
            if (typeof t === 'string') texts.push(t);
          }
        }
      }
      // First user row unreadable — give up on this file so we don't hash a
      // later message and produce a wrong mapping.
      if (texts.length === 0) return undefined;
    }
  } finally {
    stream.close();
  }
  return texts.length > 0 ? sessionAnchorText(texts) : undefined;
}

/** Convert Claude Code's project directory encoding back to a path. The
 *  encoding is lossy (every `/`, `_`, and original `-` all become `-` in the
 *  directory name) so this is display-only. */
export function decodeClaudeProjectDir(name: string): string {
  if (name.startsWith('-')) return '/' + name.slice(1).replaceAll('-', '/');
  return name.replaceAll('-', '/');
}

const CLAUDE_FILE_CACHE_CAP = 4096;
const CLAUDE_DIR_CACHE_CAP = 16;
const claudeFileCache = new Map<string, { sig: string; firstUser: string | undefined }>();
const claudeDirCache = new Map<string, { sig: string; map: Map<string, ClaudeCodeSessionRef> }>();
const claudeDirInFlight = new Map<string, Promise<Map<string, ClaudeCodeSessionRef>>>();

function fileSig(st: fs.Stats): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}`;
}

async function scanClaudeCodeMap(
  rootDir: string,
  cacheKey: string,
): Promise<Map<string, ClaudeCodeSessionRef>> {
  const out = new Map<string, ClaudeCodeSessionRef>();
  let rootStat: fs.Stats;
  let projects: fs.Dirent[];
  try {
    rootStat = fs.statSync(rootDir);
    projects = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    claudeDirCache.delete(cacheKey);
    return out; // No Claude Code install or unreadable — that's fine.
  }

  const sigParts: string[] = [fileSig(rootStat)];
  const candidates: Array<{
    projName: string;
    sess: string;
    file: string;
    fSig: string;
  }> = [];

  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(rootDir, proj.name);
    let projStat: fs.Stats;
    let sessions: string[];
    try {
      projStat = fs.statSync(projDir);
      sessions = fs.readdirSync(projDir);
    } catch {
      continue;
    }
    sigParts.push(`${proj.name}:${fileSig(projStat)}`);
    for (const sess of sessions) {
      if (!sess.endsWith('.jsonl')) continue;
      const file = path.join(projDir, sess);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        const fSig = fileSig(st);
        sigParts.push(`${proj.name}/${sess}:${fSig}`);
        candidates.push({ projName: proj.name, sess, file, fSig });
      } catch {
        continue;
      }
    }
  }

  const dirSig = sigParts.join('|');
  const cachedDir = claudeDirCache.get(cacheKey);
  if (cachedDir && cachedDir.sig === dirSig) {
    claudeDirCache.delete(cacheKey);
    claudeDirCache.set(cacheKey, cachedDir);
    return cachedDir.map;
  }

  for (const c of candidates) {
    const cachedFile = claudeFileCache.get(c.file);
    let firstUser: string | undefined;
    if (cachedFile && cachedFile.sig === c.fSig) {
      claudeFileCache.delete(c.file);
      claudeFileCache.set(c.file, cachedFile);
      firstUser = cachedFile.firstUser;
    } else {
      firstUser = await readFirstUserFromClaudeSession(c.file);
      if (claudeFileCache.has(c.file)) claudeFileCache.delete(c.file);
      claudeFileCache.set(c.file, { sig: c.fSig, firstUser });
      while (claudeFileCache.size > CLAUDE_FILE_CACHE_CAP) {
        const oldest = claudeFileCache.keys().next().value;
        if (oldest === undefined) break;
        claudeFileCache.delete(oldest);
      }
    }
    if (!firstUser) continue;
    const sha8 = fingerprintFirstUser(firstUser);
    // First write wins. If two sessions in different projects start with
    // the same user prompt (e.g. "hi"), the first one we read keeps the
    // slot — at least the dashboard shows *some* CC ref rather than none.
    if (!out.has(sha8)) {
      out.set(sha8, {
        sessionId: c.sess.replace(/\.jsonl$/, ''),
        projectPath: decodeClaudeProjectDir(c.projName),
        firstUserPreview: firstUser.slice(0, 120),
      });
    }
  }

  if (claudeDirCache.has(cacheKey)) claudeDirCache.delete(cacheKey);
  claudeDirCache.set(cacheKey, { sig: dirSig, map: out });
  while (claudeDirCache.size > CLAUDE_DIR_CACHE_CAP) {
    const oldest = claudeDirCache.keys().next().value;
    if (oldest === undefined) break;
    claudeDirCache.delete(oldest);
  }
  return out;
}

/**
 * Best-effort scan of `~/.claude/projects/*.jsonl`. Returns a map keyed by
 * the same `first_user_sha8` the proxy emits. If `~/.claude/projects/` is
 * missing, returns an empty map without throwing — inkling must keep
 * working for non-Claude-Code clients.
 *
 * Cached by `(ino, size, mtimeMs)` with in-flight singleflight coalescing so
 * repeated/concurrent dashboard polls avoid redundant disk scans.
 */
export async function claudeCodeMap(
  rootDir: string = claudeProjectsDir(),
): Promise<Map<string, ClaudeCodeSessionRef>> {
  const key = path.resolve(rootDir);
  const inFlight = claudeDirInFlight.get(key);
  if (inFlight) {
    return new Map(await inFlight);
  }
  const p = scanClaudeCodeMap(rootDir, key);
  claudeDirInFlight.set(key, p);
  try {
    return new Map(await p);
  } finally {
    if (claudeDirInFlight.get(key) === p) {
      claudeDirInFlight.delete(key);
    }
  }
}
