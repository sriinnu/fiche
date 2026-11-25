/**
 * CASI v2: Append-Only Content-Addressed Gutter-Normalized FastCDC Delta Store.
 *
 * Scans tool outputs monotonically in prefix order (`0 -> N-1`). Each block `k`
 * queries ONLY intact prior entries `0..k-1`, guaranteeing 100% prefix-cache
 * invariance across multi-turn conversations: turn T's prefix bytes remain bit-
 * identical when turn T+1 appends new messages.
 *
 * Emits:
 *  - Exact / gutter-shifted duplicate reference (`[fiche cas: ...]`)
 *  - Anchor-aligned unified diff hunk (`[fiche cas-delta vs ... (±2 context)]`)
 *  - FastCDC sub-block slice splice (`[fiche cas-slice: ...]`)
 *
 * Deltas and slices are never re-indexed as bases (chain depth <= 1). Zero `node:` imports.
 */

export interface CasiResult {
  readonly text: string;
  readonly changed: boolean;
  readonly kind?: 'exact_dup' | 'delta' | 'slice';
  readonly baseRefId?: string;
  readonly savedChars: number;
  readonly savedTokens: number;
}

interface FastCdcChunk {
  readonly startLine: number;
  readonly endLine: number;
  readonly lineCount: number;
  readonly key: string;
}

interface ChunkRef {
  readonly entryIdx: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly lineCount: number;
  next?: ChunkRef;
}

interface CasiEntry {
  readonly idx: number;
  readonly refId: string;
  readonly turnGroup?: number;
  readonly rawText: string;
  readonly lineCount: number;
  readonly effectiveLineCount: number;
  readonly hash64: string;
  readonly bodyDocHash: string;
  readonly allHaveLineNums: boolean;
  readonly isCodeLike: boolean;
  readonly isLogLike: boolean;
  readonly lines: readonly string[];
  readonly bodies: readonly string[];
  readonly canonLines: readonly string[];
  readonly lineNums: Int32Array;
  readonly canonHashes: Uint32Array;
  readonly lineFreq: Map<number, number>;
  readonly chunks: readonly FastCdcChunk[];
}

// Keep total postings alongside bounded entry indices so hot lines (e.g. `{` or `return;`) skip voting cleanly.
interface LinePostings {
  total: number;
  entries: number[];
}

const MAX_CASI_ENTRIES = 128;
const MAX_SEED_ENTRIES = 48;
const MAX_LINE_POSTINGS = 24;
const HOT_POSTING_VOTE_SKIP = 16;
const MIN_EXACT_DUP_CHARS = 400;
const MIN_DELTA_CHARS = 800;
const MIN_DELTA_LINES = 16;
const MAX_INPUT_CHARS = 512_000;
const HUNK_CONTEXT = 2;
const HISTOGRAM_MAX_DEPTH = 16;
const HISTOGRAM_MAX_OCCURRENCES = 64;
const PREPARED_CACHE_MAX_ENTRIES = 192;
const PREPARED_CACHE_MIN_CHARS = 256;
const CDC_MIN_LINES = 8;
const CDC_AVG_LINES = 20;
const CDC_MAX_LINES = 48;
// High-bit Normalized FastCDC masks operating on the 8-line Gear rolling window
// (4 left-shifts per line across 32 bits): stricter below avg, relaxed at/above avg.
const CDC_MASK_S = 0xf8000000;
const CDC_MASK_L = 0xe0000000;
const MAX_CHUNK_REFS_PER_KEY = 8;

const GUTTER_NUM_RE = /^\s*(\d{1,7})(?:\t|→|\s*[|│](?:\s|$))/;
const ALT_GUTTER_NUM_RE = /^L(\d{1,7}):\s/;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const CLOCK_TS_RE = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const VOLATILE_DURATION_RE = /\b\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s)\b/g;

/** Deterministic 256-entry FastCDC Gear table generated via SplitMix32 constants. */
export const GEAR_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    table[i] = (z ^ (z >>> 16)) >>> 0;
  }
  return table;
})();

/**
 * Strip `read_file` / `bat` / `view_file` line-number gutters (`1→`, `1\t`, `1 │ `, `L1: `)
 * into `{ lineNum, body }` without altering body indentation.
 */
export function stripLineGutter(line: string): { lineNum: number | null; body: string } {
  if (!line) return { lineNum: null, body: line };
  const c0 = line.charCodeAt(0);
  if (c0 === 76) {
    const m = ALT_GUTTER_NUM_RE.exec(line);
    if (m) {
      return {
        lineNum: Number.parseInt(m[1]!, 10),
        body: line.slice(m[0].length),
      };
    }
    return { lineNum: null, body: line };
  }
  if ((c0 >= 48 && c0 <= 57) || c0 === 32 || c0 === 9) {
    const m = GUTTER_NUM_RE.exec(line);
    if (m) {
      return {
        lineNum: Number.parseInt(m[1]!, 10),
        body: line.slice(m[0].length),
      };
    }
  }
  return { lineNum: null, body: line };
}

/**
 * Normalize volatile ISO timestamps, clock timestamps, and durations ONLY for
 * similarity voting and chunk matching while preserving exact `curLines` in output.
 */
export function canonicalForMatching(body: string): string {
  if (!body) return body;
  let out = body;
  if (out.includes(':')) {
    out = out.replace(ISO_TS_RE, '<TS>').replace(CLOCK_TS_RE, '<TIME>');
  }
  if (out.includes('s') || out.includes('S')) {
    out = out.replace(VOLATILE_DURATION_RE, '<DUR>');
  }
  return out;
}

// Allocation-free check matching `line.trim().length >= 4` on hot CASI scan paths.
function hasAtLeast4NonWs(line: string): boolean {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && !(c >= 9 && c <= 13) && c !== 160) {
      if (++count >= 4) return true;
    }
  }
  return false;
}

function fnv1a32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function dualHash64Hex(s: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b1 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function estimateSavedTokens(raw: string, compacted: string): number {
  const diff = raw.length - compacted.length;
  return diff > 0 ? Math.max(1, Math.round(diff / 3.5)) : 0;
}

interface AnchorPair {
  baseIdx: number;
  curIdx: number;
}

/** O(K log K) Longest Increasing Subsequence on `baseIdx` ordered by `curIdx`. */
function lisAnchors(pairs: readonly AnchorPair[]): AnchorPair[] {
  const n = pairs.length;
  if (n === 0) return [];
  const tailsVal: number[] = [];
  const tailsIdx: number[] = [];
  const prev = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const x = pairs[i]!.baseIdx;
    let lo = 0;
    let hi = tailsVal.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tailsVal[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tailsIdx[lo - 1]!;
    if (lo === tailsVal.length) {
      tailsVal.push(x);
      tailsIdx.push(i);
    } else {
      tailsVal[lo] = x;
      tailsIdx[lo] = i;
    }
  }

  const out: AnchorPair[] = [];
  let cur = tailsIdx[tailsIdx.length - 1]!;
  while (cur >= 0) {
    out.push(pairs[cur]!);
    cur = prev[cur]!;
  }
  out.reverse();
  return out;
}

function chunkHash64(canonLines: readonly string[], start: number, end: number): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b1 >>> 0;
  for (let i = start; i < end; i++) {
    if (i > start) {
      h1 = Math.imul((h1 ^ 10) >>> 0, 0x01000193) >>> 0;
      h2 = Math.imul((h2 ^ 10) >>> 0, 0x01000193) >>> 0;
    }
    const line = canonLines[i]!;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      h1 = Math.imul((h1 ^ c) >>> 0, 0x01000193) >>> 0;
      h2 = Math.imul((h2 ^ c) >>> 0, 0x01000193) >>> 0;
    }
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function computeFastCdcChunks(
  canonLines: readonly string[],
  canonHashes: Uint32Array,
): FastCdcChunk[] {
  const n = canonLines.length;
  if (n < CDC_MIN_LINES) return [];
  const chunks: FastCdcChunk[] = [];
  let start = 0;
  let gear = 0;
  for (let i = 0; i < n; i++) {
    const h = canonHashes[i]!;
    gear = ((gear << 1) + GEAR_TABLE[h & 0xff]!) >>> 0;
    gear = ((gear << 1) + GEAR_TABLE[(h >>> 8) & 0xff]!) >>> 0;
    gear = ((gear << 1) + GEAR_TABLE[(h >>> 16) & 0xff]!) >>> 0;
    gear = ((gear << 1) + GEAR_TABLE[(h >>> 24) & 0xff]!) >>> 0;
    const lineCount = i - start + 1;
    const mask = lineCount < CDC_AVG_LINES ? CDC_MASK_S : CDC_MASK_L;
    if (lineCount >= CDC_MAX_LINES || (lineCount >= CDC_MIN_LINES && ((gear & mask) >>> 0) === 0)) {
      chunks.push({
        startLine: start,
        endLine: i + 1,
        lineCount,
        key: chunkHash64(canonLines, start, i + 1),
      });
      start = i + 1;
      gear = 0;
    }
  }
  if (n - start >= CDC_MIN_LINES) {
    chunks.push({
      startLine: start,
      endLine: n,
      lineCount: n - start,
      key: chunkHash64(canonLines, start, n),
    });
  }
  return chunks;
}

interface PreparedLines {
  readonly lines: readonly string[];
  readonly bodies: readonly string[];
  readonly canonLines: readonly string[];
  readonly lineNums: Int32Array;
  readonly canonHashes: Uint32Array;
  readonly effectiveLineCount: number;
  readonly allHaveLineNums: boolean;
  readonly isCodeLike: boolean;
  readonly isLogLike: boolean;
  readonly bodyDocHash: string;
  readonly rawLength: number;
}

interface PreparedCacheEntry {
  readonly rawText: string;
  readonly prep: PreparedLines;
  readonly chunks: readonly FastCdcChunk[];
}

const PREPARED_LINES_CACHE = new Map<string, PreparedCacheEntry>();

export function clearCasiPreparedCacheForTests(): void {
  PREPARED_LINES_CACHE.clear();
}

function getPreparedAndChunks(
  rawText: string,
  hash64?: string,
): { readonly prep: PreparedLines; readonly chunks: readonly FastCdcChunk[] } {
  const canCache = rawText.length >= PREPARED_CACHE_MIN_CHARS && rawText.length <= MAX_INPUT_CHARS;
  const cacheKey = canCache ? `${rawText.length}:${hash64 ?? dualHash64Hex(rawText)}` : '';
  if (canCache) {
    const cached = PREPARED_LINES_CACHE.get(cacheKey);
    if (cached && cached.rawText === rawText) {
      PREPARED_LINES_CACHE.delete(cacheKey);
      PREPARED_LINES_CACHE.set(cacheKey, cached);
      return { prep: cached.prep, chunks: cached.chunks };
    }
  }
  const prep = prepareLines(rawText);
  const chunks = computeFastCdcChunks(prep.canonLines, prep.canonHashes);
  if (canCache) {
    if (PREPARED_LINES_CACHE.has(cacheKey)) {
      PREPARED_LINES_CACHE.delete(cacheKey);
    } else if (PREPARED_LINES_CACHE.size >= PREPARED_CACHE_MAX_ENTRIES) {
      const oldestKey = PREPARED_LINES_CACHE.keys().next().value;
      if (oldestKey !== undefined) {
        PREPARED_LINES_CACHE.delete(oldestKey);
      }
    }
    PREPARED_LINES_CACHE.set(cacheKey, { rawText, prep, chunks });
  }
  return { prep, chunks };
}

const CODE_HINT_RE = /(?:^|\s)(?:export|import|function|const|let|var|class|interface|type|enum|def|async|fn|pub|func|struct|return|throw)\b|=>|;\s*$/;
const LOG_LINE_HINT_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b|^\s*\[?(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\]?(?:\s|:)/i;

function isMonotonicLineNums(lineNums: Int32Array, count: number): boolean {
  for (let i = 1; i < count; i++) {
    if (lineNums[i]! <= lineNums[i - 1]!) return false;
  }
  return count > 0 && lineNums[0]! >= 0;
}

function prepareLines(rawText: string): PreparedLines {
  const lines = rawText.split('\n');
  const n = lines.length;
  // Ignore a single trailing empty line produced by a final `\n`.
  const effectiveLineCount = n > 1 && lines[n - 1] === '' ? n - 1 : n;
  const bodies = new Array<string>(n);
  const canonLines = new Array<string>(n);
  const lineNums = new Int32Array(n);
  const canonHashes = new Uint32Array(n);
  let allHaveLineNums = effectiveLineCount > 0;
  let codeHintHits = 0;
  let logHintHits = 0;
  let ch1 = 0x811c9dc5 >>> 0;
  let ch2 = 0x9e3779b1 >>> 0;

  for (let i = 0; i < n; i++) {
    const { lineNum, body } = stripLineGutter(lines[i]!);
    bodies[i] = body;
    const canon = canonicalForMatching(body);
    canonLines[i] = canon;
    if (lineNum === null) {
      lineNums[i] = -1;
      if (i < effectiveLineCount) allHaveLineNums = false;
    } else {
      lineNums[i] = lineNum;
    }
    if (i < effectiveLineCount && codeHintHits < 3 && CODE_HINT_RE.test(body)) {
      codeHintHits++;
    }
    if (i < effectiveLineCount && logHintHits < 4 && LOG_LINE_HINT_RE.test(body)) {
      logHintHits++;
    }
    canonHashes[i] = fnv1a32(canon);
    if (i < effectiveLineCount) {
      if (i > 0) {
        ch1 = Math.imul((ch1 ^ 10) >>> 0, 0x01000193) >>> 0;
        ch2 = Math.imul((ch2 ^ 10) >>> 0, 0x01000193) >>> 0;
      }
      for (let j = 0; j < body.length; j++) {
        const c = body.charCodeAt(j);
        ch1 = Math.imul((ch1 ^ c) >>> 0, 0x01000193) >>> 0;
        ch2 = Math.imul((ch2 ^ c) >>> 0, 0x01000193) >>> 0;
      }
    }
  }

  const bodyDocHash =
    (ch1 >>> 0).toString(16).padStart(8, '0') + (ch2 >>> 0).toString(16).padStart(8, '0');
  return {
    lines,
    bodies,
    canonLines,
    lineNums,
    canonHashes,
    effectiveLineCount,
    allHaveLineNums,
    isCodeLike: codeHintHits >= 2,
    isLogLike: logHintHits >= 3,
    bodyDocHash,
    rawLength: rawText.length,
  };
}

function sliceCharLength(lines: readonly string[], start: number, end: number): number {
  let len = Math.max(0, end - start - 1);
  for (let i = start; i < end; i++) {
    len += lines[i]!.length;
  }
  return len;
}

function formatUnifiedDelta(
  base: CasiEntry,
  cur: PreparedLines,
): { text: string; matchedLines: number; exactBodyMatch?: boolean } | null {
  const { lines: curLines, bodies: curBodies, canonLines: curCanonLines, canonHashes: curCanonHashes } = cur;
  // Use canonical matching only on unguttered non-code log streams; any guttered,
  // code-like, or structured non-log payload (YAML/JSON/config) MUST verify exact body equality.
  const strictBody =
    base.allHaveLineNums ||
    cur.allHaveLineNums ||
    base.isCodeLike ||
    cur.isCodeLike ||
    !(base.isLogLike && cur.isLogLike);
  const matchCanon = (bIdx: number, cIdx: number): boolean =>
    strictBody ? base.bodies[bIdx] === curBodies[cIdx] : base.canonLines[bIdx] === curCanonLines[cIdx];

  const baseLen = base.lines.length;
  const curLen = curLines.length;
  const baseHas4 = new Uint8Array(baseLen);
  for (let i = 0; i < baseLen; i++) {
    if (hasAtLeast4NonWs(base.canonLines[i]!)) baseHas4[i] = 1;
  }

  // Build hash -> unique base line position map (freq == 1 in base, 1..3 in cur).
  const curHas4 = new Uint8Array(curLen);
  const curFreq = new Map<number, number>();
  for (let i = 0; i < curLen; i++) {
    if (!hasAtLeast4NonWs(curCanonLines[i]!)) continue;
    curHas4[i] = 1;
    const h = curCanonHashes[i]!;
    curFreq.set(h, (curFreq.get(h) ?? 0) + 1);
  }

  const basePosUnique = new Map<number, number>();
  for (let i = 0; i < baseLen; i++) {
    if (!baseHas4[i]) continue;
    const h = base.canonHashes[i]!;
    if ((base.lineFreq.get(h) ?? 0) !== 1) continue;
    const cf = curFreq.get(h) ?? 0;
    if (cf === 0 || cf > 3) continue;
    basePosUnique.set(h, i);
  }

  const rawPairs: AnchorPair[] = [];
  for (let cIdx = 0; cIdx < curLen; cIdx++) {
    if (!curHas4[cIdx]) continue;
    const h = curCanonHashes[cIdx]!;
    const bIdx = basePosUnique.get(h);
    if (bIdx === undefined) continue;
    if (matchCanon(bIdx, cIdx)) {
      rawPairs.push({ baseIdx: bIdx, curIdx: cIdx });
    }
  }

  // Compute monotonic alignment segments by expanding around pinned LIS anchors,
  // then recursively anchor remaining unmatched intervals via Histogram Diff.
  const matchedCur = new Int32Array(curLen).fill(-1);
  const usedBase = new Uint8Array(baseLen);
  if (rawPairs.length > 0) {
    const anchors = lisAnchors(rawPairs);
    for (const a of anchors) {
      if (matchedCur[a.curIdx] !== -1 || usedBase[a.baseIdx]) continue;
      matchedCur[a.curIdx] = a.baseIdx;
      usedBase[a.baseIdx] = 1;
    }

    // Forward & backward greedy expansion bounded by strictly monotonic neighbors.
    for (let i = 0; i < anchors.length; i++) {
      const curStart = anchors[i]!.curIdx;
      const baseStart = anchors[i]!.baseIdx;
      const nextCurBound = i + 1 < anchors.length ? anchors[i + 1]!.curIdx : curLen;
      const nextBaseBound = i + 1 < anchors.length ? anchors[i + 1]!.baseIdx : baseLen;
      let c = curStart + 1;
      let b = baseStart + 1;
      while (
        c < nextCurBound &&
        b < nextBaseBound &&
        matchedCur[c] === -1 &&
        !usedBase[b] &&
        curCanonHashes[c] === base.canonHashes[b] &&
        matchCanon(b, c)
      ) {
        matchedCur[c] = b;
        usedBase[b] = 1;
        c++;
        b++;
      }

      const prevCurBound = i > 0 ? anchors[i - 1]!.curIdx : -1;
      const prevBaseBound = i > 0 ? anchors[i - 1]!.baseIdx : -1;
      c = curStart - 1;
      b = baseStart - 1;
      while (
        c > prevCurBound &&
        b > prevBaseBound &&
        matchedCur[c] === -1 &&
        !usedBase[b] &&
        curCanonHashes[c] === base.canonHashes[b] &&
        matchCanon(b, c)
      ) {
        matchedCur[c] = b;
        usedBase[b] = 1;
        c--;
        b--;
      }
    }
  }

  const lisIntervalFallback = (bStart: number, bEnd: number, cStart: number, cEnd: number): void => {
    const localCurFreq = new Map<number, number>();
    for (let c = cStart; c < cEnd; c++) {
      if (matchedCur[c] !== -1 || !curHas4[c]) continue;
      const h = curCanonHashes[c]!;
      localCurFreq.set(h, (localCurFreq.get(h) ?? 0) + 1);
    }
    const localBaseFreq = new Map<number, number>();
    const localBasePos = new Map<number, number>();
    for (let b = bStart; b < bEnd; b++) {
      if (usedBase[b] || !baseHas4[b]) continue;
      const h = base.canonHashes[b]!;
      localBaseFreq.set(h, (localBaseFreq.get(h) ?? 0) + 1);
      localBasePos.set(h, b);
    }
    const pairs: AnchorPair[] = [];
    for (let c = cStart; c < cEnd; c++) {
      if (matchedCur[c] !== -1 || !curHas4[c]) continue;
      const h = curCanonHashes[c]!;
      if (localBaseFreq.get(h) !== 1) continue;
      const cf = localCurFreq.get(h) ?? 0;
      if (cf === 0 || cf > 3) continue;
      const b = localBasePos.get(h)!;
      if (matchCanon(b, c)) {
        pairs.push({ baseIdx: b, curIdx: c });
      }
    }
    if (pairs.length === 0) return;
    const subAnchors = lisAnchors(pairs);
    for (const a of subAnchors) {
      if (matchedCur[a.curIdx] !== -1 || usedBase[a.baseIdx]) continue;
      matchedCur[a.curIdx] = a.baseIdx;
      usedBase[a.baseIdx] = 1;
    }
    for (let i = 0; i < subAnchors.length; i++) {
      const curStart = subAnchors[i]!.curIdx;
      const baseStart = subAnchors[i]!.baseIdx;
      const nextC = i + 1 < subAnchors.length ? subAnchors[i + 1]!.curIdx : cEnd;
      const nextB = i + 1 < subAnchors.length ? subAnchors[i + 1]!.baseIdx : bEnd;
      let c = curStart + 1;
      let b = baseStart + 1;
      while (
        c < nextC &&
        b < nextB &&
        matchedCur[c] === -1 &&
        !usedBase[b] &&
        curCanonHashes[c] === base.canonHashes[b] &&
        matchCanon(b, c)
      ) {
        matchedCur[c] = b;
        usedBase[b] = 1;
        c++;
        b++;
      }
      const prevC = i > 0 ? subAnchors[i - 1]!.curIdx : cStart - 1;
      const prevB = i > 0 ? subAnchors[i - 1]!.baseIdx : bStart - 1;
      c = curStart - 1;
      b = baseStart - 1;
      while (
        c > prevC &&
        b > prevB &&
        matchedCur[c] === -1 &&
        !usedBase[b] &&
        curCanonHashes[c] === base.canonHashes[b] &&
        matchCanon(b, c)
      ) {
        matchedCur[c] = b;
        usedBase[b] = 1;
        c--;
        b--;
      }
    }
  };

  // Recursive Histogram Diff on unmatched intervals: resolves repeated boilerplate
  // blocks (freq >= 2) where globally unique anchors are sparse or exhausted.
  const histogramAnchors = (
    bStart: number,
    bEnd: number,
    cStart: number,
    cEnd: number,
    depth: number,
  ): void => {
    if (bEnd <= bStart || cEnd <= cStart) return;
    if (depth >= HISTOGRAM_MAX_DEPTH) {
      lisIntervalFallback(bStart, bEnd, cStart, cEnd);
      return;
    }

    const basePositions = new Map<number, number[]>();
    for (let b = bStart; b < bEnd; b++) {
      if (usedBase[b] || !baseHas4[b]) continue;
      const h = base.canonHashes[b]!;
      let arr = basePositions.get(h);
      if (!arr) {
        arr = [b];
        basePositions.set(h, arr);
      } else if (arr.length <= HISTOGRAM_MAX_OCCURRENCES) {
        arr.push(b);
      }
    }
    if (basePositions.size === 0) return;

    const curPositions = new Map<number, number[]>();
    for (let c = cStart; c < cEnd; c++) {
      if (matchedCur[c] !== -1 || !curHas4[c]) continue;
      const h = curCanonHashes[c]!;
      const bArr = basePositions.get(h);
      if (!bArr || bArr.length > HISTOGRAM_MAX_OCCURRENCES) continue;
      let cArr = curPositions.get(h);
      if (!cArr) {
        cArr = [c];
        curPositions.set(h, cArr);
      } else if (cArr.length <= HISTOGRAM_MAX_OCCURRENCES) {
        cArr.push(c);
      }
    }
    if (curPositions.size === 0) return;

    interface HistogramCandidate {
      readonly score: number;
      readonly bArr: readonly number[];
      readonly cArr: readonly number[];
    }
    const candidates: HistogramCandidate[] = [];
    for (const [h, cArr] of curPositions) {
      if (cArr.length > HISTOGRAM_MAX_OCCURRENCES) continue;
      const bArr = basePositions.get(h)!;
      candidates.push({
        score: bArr.length + cArr.length,
        bArr,
        cArr,
      });
    }
    if (candidates.length === 0) {
      lisIntervalFallback(bStart, bEnd, cStart, cEnd);
      return;
    }
    candidates.sort((a, b) => a.score - b.score || a.cArr[0]! - b.cArr[0]!);

    let bestScore = Infinity;
    let bestRunLen = 0;
    let bestBStart = 0;
    let bestBEnd = 0;
    let bestCStart = 0;
    let bestCEnd = 0;
    const diagCovered = new Map<number, Array<[number, number]>>();

    for (const cand of candidates) {
      if (bestRunLen > 0 && cand.score > bestScore) break;
      for (let bi = 0; bi < cand.bArr.length; bi++) {
        const bIdx = cand.bArr[bi]!;
        for (let ci = 0; ci < cand.cArr.length; ci++) {
          const cIdx = cand.cArr[ci]!;
          const diag = bIdx - cIdx;
          const spans = diagCovered.get(diag);
          if (spans) {
            let already = false;
            for (let s = 0; s < spans.length; s++) {
              const sp = spans[s]!;
              if (cIdx >= sp[0] && cIdx < sp[1]) {
                already = true;
                break;
              }
            }
            if (already) continue;
          }
          if (!matchCanon(bIdx, cIdx)) continue;

          let rbStart = bIdx;
          let rcStart = cIdx;
          while (
            rbStart > bStart &&
            rcStart > cStart &&
            !usedBase[rbStart - 1] &&
            matchedCur[rcStart - 1] === -1 &&
            curCanonHashes[rcStart - 1] === base.canonHashes[rbStart - 1] &&
            matchCanon(rbStart - 1, rcStart - 1)
          ) {
            rbStart--;
            rcStart--;
          }
          let rbEnd = bIdx + 1;
          let rcEnd = cIdx + 1;
          while (
            rbEnd < bEnd &&
            rcEnd < cEnd &&
            !usedBase[rbEnd] &&
            matchedCur[rcEnd] === -1 &&
            curCanonHashes[rcEnd] === base.canonHashes[rbEnd] &&
            matchCanon(rbEnd, rcEnd)
          ) {
            rbEnd++;
            rcEnd++;
          }

          if (spans) {
            spans.push([rcStart, rcEnd]);
          } else {
            diagCovered.set(diag, [[rcStart, rcEnd]]);
          }

          const runLen = rcEnd - rcStart;
          const isBetter =
            bestRunLen === 0 ||
            runLen > bestRunLen ||
            (runLen === bestRunLen &&
              (rcStart < bestCStart || (rcStart === bestCStart && rbStart < bestBStart)));
          if (isBetter) {
            bestScore = cand.score;
            bestRunLen = runLen;
            bestBStart = rbStart;
            bestBEnd = rbEnd;
            bestCStart = rcStart;
            bestCEnd = rcEnd;
          }
        }
      }
    }

    if (bestRunLen === 0) return;

    for (let k = 0; k < bestRunLen; k++) {
      const b = bestBStart + k;
      const c = bestCStart + k;
      matchedCur[c] = b;
      usedBase[b] = 1;
    }

    histogramAnchors(bStart, bestBStart, cStart, bestCStart, depth + 1);
    histogramAnchors(bestBEnd, bEnd, bestCEnd, cEnd, depth + 1);
  };

  const initialIntervals: Array<[number, number, number, number]> = [];
  {
    let pC = -1;
    let pB = -1;
    for (let c = 0; c <= curLen; c++) {
      const b = c < curLen ? matchedCur[c]! : baseLen;
      if (c < curLen && b < 0) continue;
      const bStart = pB + 1;
      const bEnd = b;
      const cStart = pC + 1;
      const cEnd = c;
      if (bEnd > bStart && cEnd > cStart) {
        initialIntervals.push([bStart, bEnd, cStart, cEnd]);
      }
      pC = c;
      pB = b;
    }
  }
  for (const [bStart, bEnd, cStart, cEnd] of initialIntervals) {
    histogramAnchors(bStart, bEnd, cStart, cEnd, 0);
  }

  // Gap fill between consecutive matched anchors for identical lines.
  let prevC = -1;
  let prevB = -1;
  for (let c = 0; c <= curLines.length; c++) {
    const b = c < curLines.length ? matchedCur[c]! : base.lines.length;
    if (c < curLines.length && b < 0) continue;
    let lc = prevC + 1;
    let lb = prevB + 1;
    while (lc < c && lb < b && matchCanon(lb, lc)) {
      matchedCur[lc] = lb;
      usedBase[lb] = 1;
      lc++;
      lb++;
    }
    let rc = c - 1;
    let rb = b - 1;
    while (rc >= lc && rb >= lb && matchCanon(rb, rc)) {
      matchedCur[rc] = rb;
      usedBase[rb] = 1;
      rc--;
      rb--;
    }
    prevC = c;
    prevB = b;
  }

  let matchedLines = 0;
  for (let c = 0; c < curLines.length; c++) {
    if (matchedCur[c]! >= 0) matchedLines++;
  }
  if (matchedLines / Math.max(1, curLines.length, base.lines.length) < 0.65) return null;

  // Collect unmatched gap intervals (baseStart..baseEnd, curStart..curEnd).
  interface DiffGap {
    bStart: number;
    bEnd: number;
    cStart: number;
    cEnd: number;
  }
  const gaps: DiffGap[] = [];
  prevC = -1;
  prevB = -1;
  for (let c = 0; c <= curLines.length; c++) {
    const b = c < curLines.length ? matchedCur[c]! : base.lines.length;
    if (c < curLines.length && b < 0) continue;
    const bStart = prevB + 1;
    const bEnd = b;
    const cStart = prevC + 1;
    const cEnd = c;
    if (bEnd > bStart || cEnd > cStart) {
      gaps.push({ bStart, bEnd, cStart, cEnd });
    }
    prevC = c;
    prevB = b;
  }

  if (gaps.length === 0) {
    if (base.effectiveLineCount === cur.effectiveLineCount) {
      let exact = true;
      for (let i = 0; i < cur.effectiveLineCount; i++) {
        if (base.bodies[i] !== curBodies[i]) {
          exact = false;
          break;
        }
      }
      if (exact) {
        const range =
          cur.allHaveLineNums && isMonotonicLineNums(cur.lineNums, cur.effectiveLineCount)
            ? `L${cur.lineNums[0]!}..${cur.lineNums[cur.effectiveLineCount - 1]!}, `
            : '';
        return {
          text: `[fiche cas: body identical to ${base.refId} (${range}${cur.effectiveLineCount} lines, ${cur.rawLength} chars) — unchanged]`,
          matchedLines,
          exactBodyMatch: true,
        };
      }
    }
    return null;
  }

  // Merge gaps whose ±HUNK_CONTEXT regions overlap, then render hunks with exact raw lines.
  const hunks: string[] = [];
  let gIdx = 0;
  while (gIdx < gaps.length) {
    const firstIdx = gIdx;
    const first = gaps[firstIdx]!;
    let last = first;
    while (gIdx + 1 < gaps.length) {
      const next = gaps[gIdx + 1]!;
      if (next.cStart - HUNK_CONTEXT <= last.cEnd + HUNK_CONTEXT) {
        last = next;
        gIdx++;
      } else {
        break;
      }
    }
    gIdx++;

    const ctxCStart = Math.max(0, first.cStart - HUNK_CONTEXT);
    const ctxBStart = Math.max(0, first.bStart - HUNK_CONTEXT);
    const ctxCEnd = Math.min(curLines.length, last.cEnd + HUNK_CONTEXT);
    const ctxBEnd = Math.min(base.lines.length, last.bEnd + HUNK_CONTEXT);

    const resolveHunkEndLineNum = (
      prepared: { readonly allHaveLineNums: boolean; readonly lineNums: Int32Array },
      startIdx: number,
      endIdx: number,
      startNum: number,
    ): number => {
      if (prepared.allHaveLineNums && endIdx > startIdx) {
        for (let k = endIdx - 1; k >= startIdx; k--) {
          const ln = prepared.lineNums[k]!;
          if (ln > 0) return ln;
        }
      }
      return endIdx > startIdx ? Math.max(startNum, endIdx) : endIdx;
    };

    const ctxBNumStart = base.allHaveLineNums && base.lineNums[ctxBStart]! > 0 ? base.lineNums[ctxBStart]! : ctxBStart + 1;
    const ctxBNumEnd = resolveHunkEndLineNum(base, ctxBStart, ctxBEnd, ctxBNumStart);
    const ctxCNumStart = cur.allHaveLineNums && cur.lineNums[ctxCStart]! > 0 ? cur.lineNums[ctxCStart]! : ctxCStart + 1;
    const ctxCNumEnd = resolveHunkEndLineNum(cur, ctxCStart, ctxCEnd, ctxCNumStart);
    const hunkLines: string[] = [
      `@@ base:${ctxBNumStart}-${ctxBNumEnd} -> cur:${ctxCNumStart}-${ctxCNumEnd} @@`,
    ];

    for (let c = ctxCStart; c < first.cStart; c++) {
      hunkLines.push(` ${curLines[c]!}`);
    }
    for (let k = firstIdx; ; k++) {
      const g = gaps[k]!;
      for (let b = g.bStart; b < g.bEnd; b++) hunkLines.push(`-${base.lines[b]!}`);
      for (let c = g.cStart; c < g.cEnd; c++) hunkLines.push(`+${curLines[c]!}`);
      if (g === last) break;
      const nextG = gaps[k + 1]!;
      for (let c = g.cEnd; c < nextG.cStart; c++) {
        hunkLines.push(` ${curLines[c]!}`);
      }
    }
    for (let c = last.cEnd; c < ctxCEnd; c++) {
      hunkLines.push(` ${curLines[c]!}`);
    }
    hunks.push(hunkLines.join('\n'));
  }

  const outText =
    `[fiche cas-delta vs ${base.refId}: ${matchedLines}/${curLines.length} lines unchanged; only changed hunks below (±${HUNK_CONTEXT} context)]\n` +
    hunks.join('\n');
  return { text: outText, matchedLines };
}

export class CasiIndex {
  private readonly exactByHash = new Map<string, CasiEntry[]>();
  private readonly exactBodyByHash = new Map<string, CasiEntry[]>();
  private readonly lineIndex = new Map<number, LinePostings>();
  private readonly chunkIndex = new Map<string, ChunkRef>();
  private readonly entries: CasiEntry[] = [];
  private readonly seedHashes = new Set<string>();
  private seedCount = 0;

  private indexEntry(
    rawText: string,
    refId: string,
    hash64: string,
    prep: PreparedLines,
    turnGroup?: number,
    precomputedChunks?: readonly FastCdcChunk[],
  ): void {
    if (this.entries.length >= MAX_CASI_ENTRIES) return;
    const entryIdx = this.entries.length;
    const lineFreq = new Map<number, number>();
    for (let i = 0; i < prep.effectiveLineCount; i++) {
      if (!hasAtLeast4NonWs(prep.canonLines[i]!)) continue;
      const h = prep.canonHashes[i]!;
      lineFreq.set(h, (lineFreq.get(h) ?? 0) + 1);
    }
    const chunks = precomputedChunks ?? computeFastCdcChunks(prep.canonLines, prep.canonHashes);
    const entry: CasiEntry = {
      idx: entryIdx,
      refId,
      turnGroup,
      rawText,
      lineCount: prep.lines.length,
      effectiveLineCount: prep.effectiveLineCount,
      hash64,
      bodyDocHash: prep.bodyDocHash,
      allHaveLineNums: prep.allHaveLineNums,
      isCodeLike: prep.isCodeLike,
      isLogLike: prep.isLogLike,
      lines: prep.lines,
      bodies: prep.bodies,
      canonLines: prep.canonLines,
      lineNums: prep.lineNums,
      canonHashes: prep.canonHashes,
      lineFreq,
      chunks,
    };
    this.entries.push(entry);

    const exactBucket = this.exactByHash.get(hash64);
    if (exactBucket) exactBucket.push(entry);
    else this.exactByHash.set(hash64, [entry]);

    const bodyBucket = this.exactBodyByHash.get(prep.bodyDocHash);
    if (bodyBucket) bodyBucket.push(entry);
    else this.exactBodyByHash.set(prep.bodyDocHash, [entry]);

    const seenEntryHashes = new Set<number>();
    for (let i = 0; i < prep.canonLines.length; i++) {
      if (!hasAtLeast4NonWs(prep.canonLines[i]!)) continue;
      const h = prep.canonHashes[i]!;
      if (seenEntryHashes.has(h)) continue;
      seenEntryHashes.add(h);
      let postings = this.lineIndex.get(h);
      if (!postings) {
        postings = { total: 1, entries: [entryIdx] };
        this.lineIndex.set(h, postings);
      } else {
        postings.total += 1;
        if (postings.total <= MAX_LINE_POSTINGS) {
          postings.entries.push(entryIdx);
        }
      }
    }

    // Prefix-monotonic chunk index: first occurrence sits at the head.
    const seenChunks = new Set<string>();
    for (const chunk of chunks) {
      if (seenChunks.has(chunk.key)) continue;
      seenChunks.add(chunk.key);
      const ref: ChunkRef = {
        entryIdx,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        lineCount: chunk.lineCount,
      };
      const head = this.chunkIndex.get(chunk.key);
      if (!head) {
        this.chunkIndex.set(chunk.key, ref);
      } else {
        let cur: ChunkRef = head;
        let count = 1;
        while (cur.next && count < MAX_CHUNK_REFS_PER_KEY) {
          cur = cur.next;
          count++;
        }
        if (!cur.next && count < MAX_CHUNK_REFS_PER_KEY) {
          cur.next = ref;
        }
      }
    }
  }

  /**
   * Read-only base seeding (e.g. from `tool_use.input` / `functionCall.args` payloads >= 400 chars)
   * without mutating assistant/model messages.
   */
  seedBase(rawText: string, refId: string, turnGroup?: number): void {
    if (
      typeof rawText !== 'string' ||
      rawText.length < MIN_EXACT_DUP_CHARS ||
      rawText.length > MAX_INPUT_CHARS ||
      this.entries.length >= MAX_CASI_ENTRIES ||
      this.seedCount >= MAX_SEED_ENTRIES
    ) {
      return;
    }
    const hash64 = dualHash64Hex(rawText);
    if (this.seedHashes.has(hash64)) return;
    this.seedHashes.add(hash64);
    this.seedCount++;
    const { prep, chunks } = getPreparedAndChunks(rawText, hash64);
    this.indexEntry(rawText, refId, hash64, prep, turnGroup, chunks);
  }

  private tryFastCdcSplice(
    rawText: string,
    prep: PreparedLines,
    curChunks: readonly FastCdcChunk[],
    isEligibleBase: (entry: CasiEntry) => boolean,
  ): CasiResult | null {
    if (this.chunkIndex.size === 0) return null;
    if (curChunks.length === 0) return null;

    interface MatchSpan {
      curStart: number;
      curEnd: number;
      baseEntryIdx: number;
      baseStart: number;
      baseEnd: number;
    }

    const rawSpans: MatchSpan[] = [];
    // Sub-block slice omission ALWAYS verifies exact body line equality so
    // numeric/timestamp/duration differences (e.g. latency tables) are never masked.
    const linesEqual = (base: CasiEntry, bIdx: number, cIdx: number): boolean =>
      bIdx < base.effectiveLineCount &&
      cIdx < prep.effectiveLineCount &&
      base.bodies[bIdx] === prep.bodies[cIdx];

    for (const chunk of curChunks) {
      let ref = this.chunkIndex.get(chunk.key);
      while (ref) {
        const base = this.entries[ref.entryIdx];
        if (base && isEligibleBase(base) && ref.lineCount === chunk.lineCount) {
          let exact = true;
          for (let k = 0; k < chunk.lineCount; k++) {
            if (!linesEqual(base, ref.startLine + k, chunk.startLine + k)) {
              exact = false;
              break;
            }
          }
          if (exact) {
            rawSpans.push({
              curStart: chunk.startLine,
              curEnd: chunk.endLine,
              baseEntryIdx: ref.entryIdx,
              baseStart: ref.startLine,
              baseEnd: ref.endLine,
            });
            break;
          }
        }
        ref = ref.next;
      }
    }

    if (rawSpans.length === 0) return null;

    // Pass 1: coalesce adjacent matched chunks pointing to contiguous lines in the same base.
    const merged: MatchSpan[] = [rawSpans[0]!];
    for (let i = 1; i < rawSpans.length; i++) {
      const prev = merged[merged.length - 1]!;
      const cur = rawSpans[i]!;
      if (
        prev.baseEntryIdx === cur.baseEntryIdx &&
        prev.curEnd === cur.curStart &&
        prev.baseEnd === cur.baseStart
      ) {
        prev.curEnd = cur.curEnd;
        prev.baseEnd = cur.baseEnd;
      } else {
        merged.push(cur);
      }
    }

    // Pass 2: extend each span backward & forward line-by-line within non-overlapping bounds.
    for (let i = 0; i < merged.length; i++) {
      const s = merged[i]!;
      const base = this.entries[s.baseEntryIdx]!;
      const minCur = i > 0 ? merged[i - 1]!.curEnd : 0;
      const maxCur = i + 1 < merged.length ? merged[i + 1]!.curStart : prep.lines.length;
      while (s.curStart > minCur && s.baseStart > 0 && linesEqual(base, s.baseStart - 1, s.curStart - 1)) {
        s.curStart--;
        s.baseStart--;
      }
      while (
        s.curEnd < maxCur &&
        s.baseEnd < base.effectiveLineCount &&
        linesEqual(base, s.baseEnd, s.curEnd)
      ) {
        s.curEnd++;
        s.baseEnd++;
      }
    }

    // Pass 3: coalesce spans that touched after line extension.
    const finalSpans: MatchSpan[] = [merged[0]!];
    for (let i = 1; i < merged.length; i++) {
      const prev = finalSpans[finalSpans.length - 1]!;
      const cur = merged[i]!;
      if (
        prev.baseEntryIdx === cur.baseEntryIdx &&
        prev.curEnd === cur.curStart &&
        prev.baseEnd === cur.baseStart
      ) {
        prev.curEnd = cur.curEnd;
        prev.baseEnd = cur.baseEnd;
      } else {
        finalSpans.push(cur);
      }
    }

    interface BuiltSlice {
      readonly span: MatchSpan;
      readonly marker: string;
      readonly saved: number;
      readonly baseRefId: string;
    }
    const keptSlices: BuiltSlice[] = [];
    for (const s of finalSpans) {
      const matchLen = s.curEnd - s.curStart;
      if (matchLen < CDC_MIN_LINES) continue;
      const base = this.entries[s.baseEntryIdx]!;
      const rawSliceChars = sliceCharLength(prep.lines, s.curStart, s.curEnd);
      const baseStartNum =
        base.allHaveLineNums && base.lineNums[s.baseStart]! > 0 ? base.lineNums[s.baseStart]! : s.baseStart + 1;
      const baseEndNum =
        base.allHaveLineNums && s.baseEnd > 0 && base.lineNums[s.baseEnd - 1]! > 0 ? base.lineNums[s.baseEnd - 1]! : s.baseEnd;
      const curGutterNote =
        prep.allHaveLineNums && prep.lineNums[s.curStart]! > 0 && prep.lineNums[s.curStart]! !== s.curStart + 1
          ? `; file L${prep.lineNums[s.curStart]!}..${prep.lineNums[s.curEnd - 1]!}`
          : '';
      const marker = `[fiche cas-slice: lines ${s.curStart + 1}..${s.curEnd} identical to ${base.refId}:${baseStartNum}..${baseEndNum} (${matchLen} lines, ${rawSliceChars} chars) — omitted${curGutterNote}]`;
      const saved = rawSliceChars - marker.length;
      if (saved < 40) continue;
      keptSlices.push({ span: s, marker, saved, baseRefId: base.refId });
    }

    if (keptSlices.length === 0) return null;

    const outLines: string[] = [];
    let cursor = 0;
    let bestSlice = keptSlices[0]!;
    for (const ks of keptSlices) {
      if (ks.saved > bestSlice.saved) bestSlice = ks;
      for (let i = cursor; i < ks.span.curStart; i++) {
        outLines.push(prep.lines[i]!);
      }
      outLines.push(ks.marker);
      cursor = ks.span.curEnd;
    }
    for (let i = cursor; i < prep.lines.length; i++) {
      outLines.push(prep.lines[i]!);
    }

    const outText = outLines.join('\n');
    const savedChars = rawText.length - outText.length;
    if (savedChars < 400) return null;

    return {
      text: outText,
      changed: true,
      kind: 'slice',
      baseRefId: bestSlice.baseRefId,
      savedChars,
      savedTokens: estimateSavedTokens(rawText, outText),
    };
  }

  ingest(
    rawText: string,
    refId: string,
    turnGroup?: number,
    minBaseTurnGroup?: number,
  ): CasiResult {
    if (
      typeof rawText !== 'string' ||
      rawText.length < MIN_EXACT_DUP_CHARS ||
      rawText.length > MAX_INPUT_CHARS
    ) {
      return { text: rawText, changed: false, savedChars: 0, savedTokens: 0 };
    }

    const isEligibleBase = (entry: CasiEntry): boolean => {
      if (turnGroup !== undefined && entry.turnGroup !== undefined && !(entry.turnGroup < turnGroup)) {
        return false;
      }
      if (minBaseTurnGroup !== undefined && entry.turnGroup !== undefined && entry.turnGroup < minBaseTurnGroup) {
        return false;
      }
      return true;
    };

    // Step 1a: Exact raw duplicate check.
    const hash64 = dualHash64Hex(rawText);
    const exactCandidates = this.exactByHash.get(hash64);
    let exactHit: CasiEntry | undefined;
    if (exactCandidates) {
      for (let i = exactCandidates.length - 1; i >= 0; i--) {
        const candidate = exactCandidates[i]!;
        if (isEligibleBase(candidate) && candidate.rawText === rawText) {
          exactHit = candidate;
          break;
        }
      }
    }
    if (exactHit) {
      const marker = `[fiche cas: exact duplicate of earlier tool output ${exactHit.refId} (${exactHit.lineCount} lines, ${rawText.length} chars) — unchanged; reuse verbatim content above]`;
      if (rawText.length - marker.length >= 200) {
        return {
          text: marker,
          changed: true,
          kind: 'exact_dup',
          baseRefId: exactHit.refId,
          savedChars: rawText.length - marker.length,
          savedTokens: estimateSavedTokens(rawText, marker),
        };
      }
      return { text: rawText, changed: false, savedChars: 0, savedTokens: 0 };
    }

    const { prep, chunks } = getPreparedAndChunks(rawText, hash64);

    // Step 1b: Gutter-normalized exact body duplicate (uniform line-number shift deltaL !== 0,
    // or guttered Read matching an unguttered Write seedBase).
    const bodyCandidates = this.exactBodyByHash.get(prep.bodyDocHash);
    if (bodyCandidates && prep.allHaveLineNums && isMonotonicLineNums(prep.lineNums, prep.effectiveLineCount)) {
      for (let i = bodyCandidates.length - 1; i >= 0; i--) {
        const base = bodyCandidates[i]!;
        if (!isEligibleBase(base) || base.effectiveLineCount !== prep.effectiveLineCount) {
          continue;
        }
        if (base.allHaveLineNums) {
          if (!isMonotonicLineNums(base.lineNums, base.effectiveLineCount)) continue;
          const deltaL = prep.lineNums[0]! - base.lineNums[0]!;
          if (deltaL === 0) continue;
          let uniform = true;
          for (let k = 0; k < prep.effectiveLineCount; k++) {
            if (
              prep.lineNums[k]! - base.lineNums[k]! !== deltaL ||
              prep.bodies[k] !== base.bodies[k]
            ) {
              uniform = false;
              break;
            }
          }
          if (!uniform) continue;
          const marker = `[fiche cas: lines shifted ${deltaL > 0 ? '+' : ''}${deltaL}L vs ${base.refId} (${prep.effectiveLineCount} lines, ${rawText.length} chars) — body unchanged]`;
          if (rawText.length - marker.length >= 200) {
            return {
              text: marker,
              changed: true,
              kind: 'exact_dup',
              baseRefId: base.refId,
              savedChars: rawText.length - marker.length,
              savedTokens: estimateSavedTokens(rawText, marker),
            };
          }
        } else {
          let exact = true;
          for (let k = 0; k < prep.effectiveLineCount; k++) {
            if (prep.bodies[k] !== base.bodies[k]) {
              exact = false;
              break;
            }
          }
          if (!exact) continue;
          const first = prep.lineNums[0]!;
          const last = prep.lineNums[prep.effectiveLineCount - 1]!;
          const marker = `[fiche cas: body identical to ${base.refId} (L${first}..${last}, ${prep.effectiveLineCount} lines, ${rawText.length} chars) — unchanged]`;
          if (rawText.length - marker.length >= 200) {
            return {
              text: marker,
              changed: true,
              kind: 'exact_dup',
              baseRefId: base.refId,
              savedChars: rawText.length - marker.length,
              savedTokens: estimateSavedTokens(rawText, marker),
            };
          }
        }
      }
    }

    const canVote =
      this.entries.length > 0 && rawText.length >= MIN_DELTA_CHARS && prep.effectiveLineCount >= MIN_DELTA_LINES;

    if (!canVote) {
      this.indexEntry(rawText, refId, hash64, prep, turnGroup, chunks);
      return { text: rawText, changed: false, savedChars: 0, savedTokens: 0 };
    }

    // Step 2: Canonical whole-block voting & anchor-aligned unified delta.
    const votes = new Int32Array(this.entries.length);
    const seenQueryHashes = new Set<number>();
    let anyVote = false;
    for (let i = 0; i < prep.canonLines.length; i++) {
      const canon = prep.canonLines[i]!;
      if (!hasAtLeast4NonWs(canon)) continue;
      const h = prep.canonHashes[i]!;
      if (seenQueryHashes.has(h)) continue;
      seenQueryHashes.add(h);
      const postings = this.lineIndex.get(h);
      if (!postings || postings.total > HOT_POSTING_VOTE_SKIP) continue;
      for (let p = 0; p < postings.entries.length; p++) {
        const entryIdx = postings.entries[p]!;
        const candidate = this.entries[entryIdx];
        if (!candidate || !isEligibleBase(candidate)) continue;
        votes[entryIdx]! += 1;
        anyVote = true;
      }
    }

    if (anyVote) {
      let bestEntryIdx = -1;
      let bestVotes = 0;
      for (let idx = 0; idx < votes.length; idx++) {
        const count = votes[idx]!;
        if (count > bestVotes) {
          bestVotes = count;
          bestEntryIdx = idx;
        }
      }
      if (bestEntryIdx >= 0) {
        const base = this.entries[bestEntryIdx]!;
        if (bestVotes >= Math.max(prep.lines.length, base.lines.length) * 0.45) {
          const delta = formatUnifiedDelta(base, prep);
          if (
            delta &&
            rawText.length - delta.text.length >= (delta.exactBodyMatch ? 200 : 400) &&
            (delta.exactBodyMatch || delta.text.length <= rawText.length * 0.55)
          ) {
            return {
              text: delta.text,
              changed: true,
              kind: delta.exactBodyMatch ? 'exact_dup' : 'delta',
              baseRefId: base.refId,
              savedChars: rawText.length - delta.text.length,
              savedTokens: estimateSavedTokens(rawText, delta.text),
            };
          }
        }
      }
    }

    // Step 3: Sub-block FastCDC splice fallback when whole-block overlap < 65%.
    const spliced = this.tryFastCdcSplice(rawText, prep, chunks, isEligibleBase);
    if (spliced) {
      return spliced;
    }

    this.indexEntry(rawText, refId, hash64, prep, turnGroup, chunks);
    return { text: rawText, changed: false, savedChars: 0, savedTokens: 0 };
  }
}

export function createCasiIndex(): CasiIndex {
  return new CasiIndex();
}
