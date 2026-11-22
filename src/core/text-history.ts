/**
 * ACDC: Append-Only Frozen-Epoch Extractive History Compactor for Text-Only Models.
 *
 * Grounded in:
 *  - "Context Has a Price" (Yang et al., Nov 2026) & CAPC (July 2026):
 *    mutating recent/live turns causes re-search loops or breaks prefix caches.
 *  - "The Complexity Trap" (2025/2026) & SWE-Pruner (Jan 2026): deterministic
 *    structural skeleton + outcome extraction over *aged* completed epochs
 *    matches heavy LLM summarization at zero inference cost.
 *
 * Strictly groups aged blocks behind `keepTailMessages` into fixed frozen
 * epochs (`>= epochTokenTarget` tokens). Trailing unsealed blocks are untouched
 * until full, so sealed epochs stay bit-identical across subsequent turns.
 * Every epoch passes a kosha cache-payback or cliff-avoidance gate.
 *
 * Workers-safe: zero `node:` imports.
 */

import { factSheetText } from './factsheet.js';
import { gptTokenCount, hasLongUnbrokenBpeChunk } from './gpt-tokens.js';
import { evaluateCliffAvoidance, priceMode, resolvePriceRates } from './pricing.js';

export interface TextEpochBlock {
  readonly msgIndex: number;
  readonly refId: string;
  readonly toolName?: string;
  readonly getText: () => string;
  readonly setText: (next: string) => void;
}

export interface TextEpochPlanArgs {
  readonly blocks: readonly TextEpochBlock[];
  readonly totalMessages: number;
  readonly model?: string;
  readonly totalPromptTokens: number;
  readonly expectedOutputTokens?: number;
  readonly ttlSec?: number;
  readonly keepTailMessages?: number;
  readonly epochTokenTarget?: number;
  readonly maxPaybackReads?: number;
}

export interface TextEpochPlanResult {
  readonly changed: boolean;
  readonly sealedEpochs: number;
  readonly compactedBlocks: number;
  readonly savedChars: number;
  readonly savedTokens: number;
  readonly cliffAvoided?: { at: number; multiplier: number; savedUsd: number };
}

const TOKEN_EXACT_LIMIT = 32_000;
const DIGEST_CACHE_MAX_CHARS = 8 * 1024 * 1024;
const digestCache = new Map<string, string>();
let digestCacheChars = 0;

const LINE_NUM_PREFIX_RE = /^(\s*\d{1,7}(?:\t|→|\s*[|\u2502](?:\s|$)))/;
const DIFF_HEADER_RE = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- [^\n]+|\+\+\+ [^\n]+)/;
const LOG_CRITICAL_RE =
  /\b(?:error|err|warn|warning|fail|failed|failure|fatal|panic|exception|traceback|assertion|assert|denied|forbidden|timeout|timed out|refused|oom|killed|segfault|abort|aborted|passed|skipped|summary|exit[_ ]?code(?:[=:\s]+[1-9]\d*)?|returned [1-9]\d*|[A-Za-z_]\w*(?:Error|Exception|Fault|Failure)|ECONNREFUSED|ENOENT|ETIMEDOUT|EACCES|EPERM|EADDRINUSE|EPIPE|EISDIR|ENOSPC)\b|\b(?:status[=:\s]+|HTTP\/\d(?:\.\d)?["'\s]+)[45]\d\d\b|(?:^\s*(?:at\s+\S+\s*\(|Caused by:|File "|Traceback \(most recent call last\)))/i;
const CODE_DECL_RE =
  /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?|pub(?:\([^)]*\))?\s+(?:async\s+)?|async\s+|static\s+|private\s+|protected\s+|public\s+)?(?:function|class|interface|type|enum|struct|trait|impl|fn|func|def|mod|namespace|module)\b|^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>|^\s*(?:import|from\s+\S+\s+import|package|use\s+|#include)\b/;

function countTokens(s: string): number {
  if (s.length <= TOKEN_EXACT_LIMIT && !hasLongUnbrokenBpeChunk(s)) return gptTokenCount(s);
  return Math.ceil(s.length / 3.5);
}

function estimateTokenPair(before: string, after: string): [number, number] {
  if (
    before.length <= TOKEN_EXACT_LIMIT &&
    after.length <= TOKEN_EXACT_LIMIT &&
    !hasLongUnbrokenBpeChunk(before) &&
    !hasLongUnbrokenBpeChunk(after)
  ) {
    return [gptTokenCount(before), gptTokenCount(after)];
  }
  return [Math.ceil(before.length / 3.5), Math.ceil(after.length / 3.5)];
}

function isWsChar(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 160;
}

function firstNonWsIndex(text: string, from = 0): number {
  for (let i = from; i < text.length; i++) {
    if (!isWsChar(text.charCodeAt(i))) return i;
  }
  return -1;
}

function lastNonWsCode(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text.charCodeAt(i);
    if (!isWsChar(c)) return c;
  }
  return -1;
}

const STICKY_EPOCH_MAX = 1024;
const stickySealedEpochs = new Set<string>();
const stickyCliffEpochs = new Map<string, number>();

const LOG_BRACKET_TS_RE = /^\[\s*(?:\d{4}-|\d{2}:)/;

/** Distinguish true JSON objects/arrays from log lines starting with `[2026-...]` or `[INFO]`. */
function looksLikeJsonPayload(text: string): boolean {
  const firstIdx = firstNonWsIndex(text);
  if (firstIdx < 0) return false;
  const firstCh = text.charCodeAt(firstIdx);
  const lastCh = lastNonWsCode(text);
  if (firstCh === 123 && lastCh === 125) {
    const secondIdx = firstNonWsIndex(text, firstIdx + 1);
    if (secondIdx < 0) return false;
    const ch = text.charCodeAt(secondIdx);
    return ch === 34 || ch === 125;
  }
  if (firstCh === 91 && lastCh === 93) {
    if (LOG_BRACKET_TS_RE.test(text.slice(firstIdx, firstIdx + 16))) return false;
    const secondIdx = firstNonWsIndex(text, firstIdx + 1);
    if (secondIdx < 0) return false;
    const ch = text.charCodeAt(secondIdx);
    if (ch === 123 || ch === 91 || ch === 34 || ch === 93) return true;
    const head = text.slice(secondIdx, secondIdx + 128);
    if (ch === 45 || (ch >= 48 && ch <= 57)) {
      return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?:\s*[,\]])/.test(head);
    }
    if (ch === 116) return /^true(?:\s*[,\]])/.test(head);
    if (ch === 102) return /^false(?:\s*[,\]])/.test(head);
    if (ch === 110) return /^null(?:\s*[,\]])/.test(head);
  }
  return false;
}

function stripLineNumPrefix(line: string): string {
  const m = line.match(LINE_NUM_PREFIX_RE);
  return m ? line.slice(m[1]!.length) : line;
}

function looksLikeCodeOrLineNumbered(lines: readonly string[]): boolean {
  let numHits = 0;
  let declHits = 0;
  const sample = Math.min(lines.length, 40);
  for (let i = 0; i < sample; i++) {
    const l = lines[i]!;
    if (LINE_NUM_PREFIX_RE.test(l)) numHits++;
    if (CODE_DECL_RE.test(stripLineNumPrefix(l))) declHits++;
  }
  return numHits >= 5 || declHits >= 3;
}

function looksLikeDiff(text: string, lines: readonly string[]): boolean {
  if (lines.some((l) => DIFF_HEADER_RE.test(l))) return true;
  let plusMinus = 0;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (/^[+-][^+-]/.test(lines[i]!)) plusMinus++;
  }
  return plusMinus >= 4 && text.includes('@@');
}

/**
 * Deterministic extractive structural digest for aged tool outputs.
 */
export function extractStructuralDigest(text: string, refId = 'prior'): string {
  const cacheKey = `${refId}\0${text}`;
  const hit = digestCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const store = (digest: string): string => {
    const cost = cacheKey.length + digest.length;
    if (cost <= DIGEST_CACHE_MAX_CHARS) {
      if (digestCacheChars + cost > DIGEST_CACHE_MAX_CHARS) {
        digestCache.clear();
        digestCacheChars = 0;
      }
      digestCache.set(cacheKey, digest);
      digestCacheChars += cost;
    }
    return digest;
  };

  const lines = text.split('\n');
  const sheet = factSheetText(text, 'compact');
  const appendSheet = (body: string) => store(sheet ? `${body}\n${sheet}` : body);

  if (text.startsWith('@toon ') || looksLikeJsonPayload(text)) {
    if (lines.length === 1 && text.length > 1000) {
      const body = [
        `[fiche epoch-digest ${refId}: structured data (1 line, ${text.length} chars); head/tail + identifiers preserved]`,
        text.slice(0, 300),
        `... (${text.length - 500} chars elided) ...`,
        text.slice(-200),
      ].join('\n');
      return appendSheet(body);
    }
    const head = lines.slice(0, Math.min(4, lines.length));
    const tail = lines.length > 6 ? lines.slice(-2) : [];
    const body = [
      `[fiche epoch-digest ${refId}: structured data (${lines.length} lines, ${text.length} chars); head/tail + identifiers preserved]`,
      ...head,
      ...(tail.length > 0 ? [`... (${lines.length - head.length - tail.length} rows elided) ...`, ...tail] : []),
    ].join('\n');
    return appendSheet(body);
  }

  if (looksLikeDiff(text, lines)) {
    const kept: string[] = [];
    let deltaCount = 0;
    let omitted = 0;
    for (const l of lines) {
      if (DIFF_HEADER_RE.test(l)) {
        kept.push(l);
      } else if (/^[+-]/.test(l)) {
        if (deltaCount < 80) {
          kept.push(l);
          deltaCount++;
        } else {
          omitted++;
        }
      }
    }
    const summary = `[fiche epoch-digest ${refId}: unified diff (${lines.length} lines${omitted > 0 ? `, ${omitted} extra +/- lines omitted` : ''})]`;
    return appendSheet([summary, ...kept].join('\n'));
  }

  if (looksLikeCodeOrLineNumbered(lines)) {
    const keepIdx = new Set<number>();
    for (let i = 0; i < Math.min(4, lines.length); i++) keepIdx.add(i);
    for (let i = Math.max(0, lines.length - 4); i < lines.length; i++) keepIdx.add(i);
    for (let i = 0; i < lines.length; i++) {
      if (CODE_DECL_RE.test(stripLineNumPrefix(lines[i]!))) {
        keepIdx.add(i);
      }
    }
    const sorted = [...keepIdx].sort((a, b) => a - b);
    const bodyLines: string[] = [];
    let prev = -1;
    for (const idx of sorted) {
      if (prev >= 0 && idx > prev + 1) {
        bodyLines.push(`  ... (${idx - prev - 1} lines omitted) ...`);
      }
      bodyLines.push(lines[idx]!);
      prev = idx;
    }
    const header = `[fiche epoch-digest ${refId}: code skeleton (${lines.length} lines -> ${sorted.length} signature/boundary lines); re-read if full body needed]`;
    return appendSheet([header, ...bodyLines].join('\n'));
  }

  // Logs / CLI / search / prose
  const keepIdx = new Set<number>();
  for (let i = 0; i < Math.min(5, lines.length); i++) keepIdx.add(i);
  for (let i = Math.max(0, lines.length - 8); i < lines.length; i++) keepIdx.add(i);
  for (let i = 0; i < lines.length; i++) {
    if (LOG_CRITICAL_RE.test(lines[i]!)) keepIdx.add(i);
  }
  const sorted = [...keepIdx].sort((a, b) => a - b);
  const bodyLines: string[] = [];
  let prev = -1;
  for (const idx of sorted) {
    if (prev >= 0 && idx > prev + 1) {
      bodyLines.push(`... (${idx - prev - 1} lines omitted) ...`);
    }
    bodyLines.push(lines[idx]!);
    prev = idx;
  }
  const header = `[fiche epoch-digest ${refId}: log/output digest (${lines.length} lines -> ${sorted.length} lines); head/errors/tail preserved]`;
  return appendSheet([header, ...bodyLines].join('\n'));
}

export function planAndApplyTextEpochs(args: TextEpochPlanArgs): TextEpochPlanResult {
  const keepTail = args.keepTailMessages ?? 6;
  const epochTarget = args.epochTokenTarget ?? 4_000;
  const maxPayback = args.maxPaybackReads ?? 12;
  const cutoffMsg = args.totalMessages - keepTail;
  if (cutoffMsg <= 1 || args.blocks.length === 0) {
    return { changed: false, sealedEpochs: 0, compactedBlocks: 0, savedChars: 0, savedTokens: 0 };
  }

  interface Candidate {
    block: TextEpochBlock;
    raw: string;
    rawTokens: number;
  }

  const eligible: Candidate[] = [];
  for (const b of args.blocks) {
    if (b.msgIndex <= 0 || b.msgIndex >= cutoffMsg) continue;
    const raw = b.getText();
    if (raw.length < 1000) continue;
    if (
      raw.startsWith('[fiche cas') ||
      raw.startsWith('[fiche epoch-digest') ||
      raw.startsWith('[inkling cas') ||
      raw.startsWith('[inkling epoch-digest')
    ) continue;
    eligible.push({ block: b, raw, rawTokens: countTokens(raw) });
  }

  if (eligible.length === 0) {
    return { changed: false, sealedEpochs: 0, compactedBlocks: 0, savedChars: 0, savedTokens: 0 };
  }

  // Partition deterministically from the oldest eligible block forward into fixed epochs.
  // Any trailing remainder < epochTarget is NOT sealed, keeping earlier sealed epochs frozen.
  const sealedList: Candidate[][] = [];
  let pending: Candidate[] = [];
  let pendingTokens = 0;
  for (const item of eligible) {
    pending.push(item);
    pendingTokens += item.rawTokens;
    if (pendingTokens >= epochTarget) {
      sealedList.push(pending);
      pending = [];
      pendingTokens = 0;
    }
  }

  if (sealedList.length === 0) {
    return { changed: false, sealedEpochs: 0, compactedBlocks: 0, savedChars: 0, savedTokens: 0 };
  }

  // Base-tier rates keep frozen-epoch payback strictly monotonic when crossing prompt cliffs.
  const rates = resolvePriceRates(args.model, { promptTokens: 0, ttlSec: args.ttlSec });
  const expectedOut = args.expectedOutputTokens ?? 1000;
  let runningPrompt = args.totalPromptTokens;
  let sealedEpochs = 0;
  let compactedBlocks = 0;
  let totalSavedChars = 0;
  let totalSavedTokens = 0;
  let cliffAvoided: { at: number; multiplier: number; savedUsd: number } | undefined;

  const blockTokensByBlock = new Map<TextEpochBlock, number>();
  for (const item of eligible) blockTokensByBlock.set(item.block, item.rawTokens);
  for (const b of args.blocks) {
    if (!blockTokensByBlock.has(b)) blockTokensByBlock.set(b, countTokens(b.getText()));
  }

  const mode = priceMode();
  for (const epoch of sealedList) {
    const proposals = epoch.map((item) => {
      const digest = extractStructuralDigest(item.raw, item.block.refId);
      const [rawTokPaired, digestTokPaired] = estimateTokenPair(item.raw, digest);
      return { item, digest, rawTokPaired, digestTokPaired };
    });

    const epochRawTokens = proposals.reduce((sum, p) => sum + p.rawTokPaired, 0);
    const epochDigestTokens = proposals.reduce((sum, p) => sum + p.digestTokPaired, 0);
    if (epochDigestTokens >= epochRawTokens * 0.55) continue;

    const epochLastMsg = epoch[epoch.length - 1]!.block.msgIndex;
    let downstreamCachedTokens = 0;
    for (const b of args.blocks) {
      if (b.msgIndex > epochLastMsg && b.msgIndex < args.totalMessages - 2) {
        downstreamCachedTokens += blockTokensByBlock.get(b) ?? 0;
      }
    }

    const savedTok = epochRawTokens - epochDigestTokens;
    const savedPerRead = savedTok * rates.read;
    const transitionCost =
      epochDigestTokens * rates.write -
      epochRawTokens * rates.read +
      downstreamCachedTokens * (rates.write - rates.read);
    const paybackReads =
      savedPerRead > 0 ? Math.ceil(Math.max(0, transitionCost) / savedPerRead) : Infinity;

    const stickyKey = `${mode}\0${args.model ?? ''}\0${args.ttlSec ?? ''}\0${maxPayback}\0${epoch.map((e) => `${e.block.refId}:${e.raw.length}:${e.raw.slice(0, 24)}:${e.raw.slice(-24)}`).join('|')}`;
    const alreadySealed = stickySealedEpochs.has(stickyKey);
    const stickyCliffAt = mode === 'kosha' ? stickyCliffEpochs.get(stickyKey) : undefined;
    const stickyCliffActive = stickyCliffAt !== undefined && runningPrompt > stickyCliffAt;

    const cliff = evaluateCliffAvoidance(args.model, {
      promptTokensBefore: runningPrompt,
      promptTokensAfter: Math.max(0, runningPrompt - savedTok),
      collapsedBaselineTokens: epochRawTokens,
      collapsedActualTokens: epochDigestTokens,
      downstreamCachedTokens,
      expectedOutputTokens: expectedOut,
      ttlSec: args.ttlSec,
    });

    const cliffWins = Boolean(cliff?.crossesCliff && cliff.netSingleTurnUsd > 0) || stickyCliffActive;
    if (!alreadySealed && paybackReads > maxPayback && !cliffWins) continue;

    let epochSavedChars = 0;
    let epochSavedTok = 0;
    for (const p of proposals) {
      if (p.digest.length < p.item.raw.length && p.digestTokPaired < p.rawTokPaired) {
        p.item.block.setText(p.digest);
        compactedBlocks++;
        epochSavedChars += p.item.raw.length - p.digest.length;
        epochSavedTok += p.rawTokPaired - p.digestTokPaired;
      }
    }
    if (epochSavedChars > 0) {
      sealedEpochs++;
      totalSavedChars += epochSavedChars;
      totalSavedTokens += epochSavedTok;
      runningPrompt = Math.max(0, runningPrompt - epochSavedTok);
      if (stickySealedEpochs.size >= STICKY_EPOCH_MAX) stickySealedEpochs.clear();
      stickySealedEpochs.add(stickyKey);
      if (cliff?.crossesCliff && cliff.netSingleTurnUsd > 0) {
        if (stickyCliffEpochs.size >= STICKY_EPOCH_MAX) stickyCliffEpochs.clear();
        stickyCliffEpochs.set(stickyKey, cliff.cliffAt);
        if (!cliffAvoided) {
          cliffAvoided = {
            at: cliff.cliffAt,
            multiplier: cliff.multiplier,
            savedUsd: cliff.netSingleTurnUsd,
          };
        }
      }
    }
  }

  return {
    changed: compactedBlocks > 0,
    sealedEpochs,
    compactedBlocks,
    savedChars: totalSavedChars,
    savedTokens: totalSavedTokens,
    ...(cliffAvoided ? { cliffAvoided } : {}),
  };
}
