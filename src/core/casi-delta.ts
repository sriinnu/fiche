/**
 * CASI: Append-Only Content-Addressed Suffix-Indexed Delta Store.
 *
 * Scans tool outputs monotonically in prefix order (`0 -> N-1`). Each block `k`
 * queries ONLY intact prior entries `0..k-1`, guaranteeing 100% prefix-cache
 * invariance across multi-turn conversations: turn T's prefix bytes remain bit-
 * identical when turn T+1 appends new messages.
 *
 * Emits either:
 *  - Exact duplicate reference (`[inkling cas: exact duplicate of ...]`)
 *  - Anchor-aligned unified diff hunk (`[inkling cas-delta vs ... (±2 context)]`)
 *
 * Deltas are never re-indexed as bases (chain depth <= 1). Zero `node:` imports.
 */

export interface CasiResult {
  readonly text: string;
  readonly changed: boolean;
  readonly kind?: 'exact_dup' | 'delta';
  readonly baseRefId?: string;
  readonly savedChars: number;
  readonly savedTokens: number;
}

interface CasiEntry {
  readonly idx: number;
  readonly refId: string;
  readonly turnGroup?: number;
  readonly rawText: string;
  readonly lineCount: number;
  readonly hash64: string;
  readonly lines: readonly string[];
  readonly lineHashes: Uint32Array;
  readonly lineFreq: Map<number, number>;
}

// Keep total postings alongside bounded entry indices so hot lines (e.g. `{` or `return;`) skip voting cleanly.
interface LinePostings {
  total: number;
  entries: number[];
}

const MAX_CASI_ENTRIES = 128;
const MAX_LINE_POSTINGS = 24;
const HOT_POSTING_VOTE_SKIP = 16;
const MIN_EXACT_DUP_CHARS = 400;
const MIN_DELTA_CHARS = 800;
const MIN_DELTA_LINES = 16;
const MAX_INPUT_CHARS = 512_000;
const HUNK_CONTEXT = 2;

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

function formatUnifiedDelta(
  base: CasiEntry,
  curLines: readonly string[],
  curHashes: Uint32Array,
): { text: string; matchedLines: number } | null {
  // Build hash -> unique base line position map (freq == 1 in base, 1..3 in cur).
  const curFreq = new Map<number, number>();
  for (let i = 0; i < curLines.length; i++) {
    if (!hasAtLeast4NonWs(curLines[i]!)) continue;
    const h = curHashes[i]!;
    curFreq.set(h, (curFreq.get(h) ?? 0) + 1);
  }

  const basePosUnique = new Map<number, number>();
  for (let i = 0; i < base.lines.length; i++) {
    if (!hasAtLeast4NonWs(base.lines[i]!)) continue;
    const h = base.lineHashes[i]!;
    if ((base.lineFreq.get(h) ?? 0) !== 1) continue;
    const cf = curFreq.get(h) ?? 0;
    if (cf === 0 || cf > 3) continue;
    basePosUnique.set(h, i);
  }

  const rawPairs: AnchorPair[] = [];
  for (let cIdx = 0; cIdx < curLines.length; cIdx++) {
    const h = curHashes[cIdx]!;
    const bIdx = basePosUnique.get(h);
    if (bIdx === undefined) continue;
    if (base.lines[bIdx] === curLines[cIdx]) {
      rawPairs.push({ baseIdx: bIdx, curIdx: cIdx });
    }
  }
  if (rawPairs.length === 0) return null;

  const anchors = lisAnchors(rawPairs);
  if (anchors.length === 0) return null;

  // Compute monotonic alignment segments by expanding around pinned LIS anchors.
  const matchedCur = new Int32Array(curLines.length).fill(-1);
  const usedBase = new Uint8Array(base.lines.length);
  for (const a of anchors) {
    if (matchedCur[a.curIdx] !== -1 || usedBase[a.baseIdx]) continue;
    matchedCur[a.curIdx] = a.baseIdx;
    usedBase[a.baseIdx] = 1;
  }

  // Forward & backward greedy expansion bounded by strictly monotonic neighbors.
  for (let i = 0; i < anchors.length; i++) {
    const curStart = anchors[i]!.curIdx;
    const baseStart = anchors[i]!.baseIdx;
    const nextCurBound = i + 1 < anchors.length ? anchors[i + 1]!.curIdx : curLines.length;
    const nextBaseBound = i + 1 < anchors.length ? anchors[i + 1]!.baseIdx : base.lines.length;
    let c = curStart + 1;
    let b = baseStart + 1;
    while (
      c < nextCurBound &&
      b < nextBaseBound &&
      matchedCur[c] === -1 &&
      !usedBase[b] &&
      curHashes[c] === base.lineHashes[b] &&
      curLines[c] === base.lines[b]
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
      curHashes[c] === base.lineHashes[b] &&
      curLines[c] === base.lines[b]
    ) {
      matchedCur[c] = b;
      usedBase[b] = 1;
      c--;
      b--;
    }
  }

  // Gap fill between consecutive matched anchors for identical lines.
  let prevC = -1;
  let prevB = -1;
  for (let c = 0; c <= curLines.length; c++) {
    const b = c < curLines.length ? matchedCur[c]! : base.lines.length;
    if (c < curLines.length && b < 0) continue;
    // Try filling the gap (prevC, c) vs (prevB, b) greedily from both ends.
    let lc = prevC + 1;
    let lb = prevB + 1;
    while (lc < c && lb < b && curLines[lc] === base.lines[lb]) {
      matchedCur[lc] = lb;
      usedBase[lb] = 1;
      lc++;
      lb++;
    }
    let rc = c - 1;
    let rb = b - 1;
    while (rc >= lc && rb >= lb && curLines[rc] === base.lines[rb]) {
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

  if (gaps.length === 0) return null;

  // Merge gaps whose ±HUNK_CONTEXT regions overlap, then render hunks.
  const hunks: string[] = [];
  let gIdx = 0;
  while (gIdx < gaps.length) {
    // Capture `firstIdx` directly so hunk rendering iterates O(G) instead of calling `gaps.indexOf(first)`.
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

    const hunkLines: string[] = [
      `@@ base:${ctxBStart + 1}-${ctxBEnd} -> cur:${ctxCStart + 1}-${ctxCEnd} @@`,
    ];

    // Emit leading context.
    for (let c = ctxCStart; c < first.cStart; c++) {
      hunkLines.push(` ${curLines[c]!}`);
    }
    // Emit each gap and inter-gap matched context inside this hunk.
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
    // Emit trailing context.
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
  private readonly lineIndex = new Map<number, LinePostings>();
  private readonly entries: CasiEntry[] = [];

  private indexEntry(
    rawText: string,
    refId: string,
    hash64: string,
    lines: string[],
    lineHashes: Uint32Array,
    turnGroup?: number,
  ): void {
    if (this.entries.length >= MAX_CASI_ENTRIES) return;
    const entryIdx = this.entries.length;
    const lineFreq = new Map<number, number>();
    for (let i = 0; i < lines.length; i++) {
      if (!hasAtLeast4NonWs(lines[i]!)) continue;
      const h = lineHashes[i]!;
      lineFreq.set(h, (lineFreq.get(h) ?? 0) + 1);
    }
    const entry: CasiEntry = {
      idx: entryIdx,
      refId,
      turnGroup,
      rawText,
      lineCount: lines.length,
      hash64,
      lines,
      lineHashes,
      lineFreq,
    };
    this.entries.push(entry);
    const exactBucket = this.exactByHash.get(hash64);
    if (exactBucket) {
      exactBucket.push(entry);
    } else {
      this.exactByHash.set(hash64, [entry]);
    }
    const seenEntryHashes = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (!hasAtLeast4NonWs(lines[i]!)) continue;
      const h = lineHashes[i]!;
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

    const lines = rawText.split('\n');
    const lineHashes = new Uint32Array(lines.length);
    const canVote =
      this.entries.length > 0 && rawText.length >= MIN_DELTA_CHARS && lines.length >= MIN_DELTA_LINES;

    if (!canVote) {
      for (let i = 0; i < lines.length; i++) {
        lineHashes[i] = fnv1a32(lines[i]!);
      }
      this.indexEntry(rawText, refId, hash64, lines, lineHashes, turnGroup);
      return { text: rawText, changed: false, savedChars: 0, savedTokens: 0 };
    }

    const votes = new Int32Array(this.entries.length);
    // Count distinct shared line hashes once per candidate (matching legacy base.lineHashes Set intersection).
    const seenQueryHashes = new Set<number>();
    let anyVote = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const h = fnv1a32(line);
      lineHashes[i] = h;
      if (!hasAtLeast4NonWs(line)) continue;
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
        if (bestVotes >= Math.max(lines.length, base.lines.length) * 0.45) {
          const delta = formatUnifiedDelta(base, lines, lineHashes);
          if (
            delta &&
            rawText.length - delta.text.length >= 400 &&
            delta.text.length <= rawText.length * 0.55
          ) {
            return {
              text: delta.text,
              changed: true,
              kind: 'delta',
              baseRefId: base.refId,
              savedChars: rawText.length - delta.text.length,
              savedTokens: estimateSavedTokens(rawText, delta.text),
            };
          }
        }
      }
    }

    this.indexEntry(rawText, refId, hash64, lines, lineHashes, turnGroup);
    return { text: rawText, changed: false, savedChars: 0, savedTokens: 0 };
  }
}

export function createCasiIndex(): CasiIndex {
  return new CasiIndex();
}
