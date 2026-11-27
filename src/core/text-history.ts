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

import { computeHorizonPaybackLimit, fnv64Hex } from './context-mmu.js';
import { factSheetText } from './factsheet.js';
import { gptTokenCount, hasLongUnbrokenBpeChunk } from './gpt-tokens.js';
import { resetGlobalPrefixTape } from './prefix-tape.js';
import { evaluateCliffAvoidance, isAutoCacheOpenAIModel, priceMode, resolvePriceRates } from './pricing.js';
import { hasSealedEpochKey, isCacheCircuitBreakerOpen, recordSealedEpochKey } from './session-state.js';

export interface CacheBreakpointMarker {
  /** Message index in `messages`, or `-1` for tools/system. */
  readonly msgIndex: number;
  /** Block index within `messages[msgIndex].content`, or `Number.MAX_SAFE_INTEGER` for message-level. */
  readonly blockIndex: number;
  /** Cache TTL in seconds (`3600` for `1h`, `300` for `5m`). */
  readonly ttlSec: number;
}

export interface TextEpochBlock {
  readonly msgIndex: number;
  readonly blockIndex?: number;
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
  readonly msgTotalTokens?: readonly number[];
  readonly cacheBreakpoints?: readonly CacheBreakpointMarker[];
  readonly keepTailMessages?: number;
  readonly epochTokenTarget?: number;
  readonly maxPaybackReads?: number;
  readonly sessionKey?: string;
  readonly sessionCacheCold?: boolean;
  readonly enableLsm?: boolean;
  readonly lsmEditTailMessages?: number;
  readonly lsmMinLargeBlockTokens?: number;
  /** When true, only replay already-sealed sticky epochs without sealing new candidates. */
  readonly stickyOnly?: boolean;
  readonly earliestNewInvalidationMsg?: number;
  readonly circuitBreakerState?: 'closed' | 'open' | 'half_open';
  readonly ewmaInterTurnSec?: number;
  readonly ewmaHitRatio?: number;
  readonly onPageOut?: (block: TextEpochBlock, raw: string, digest: string) => string | undefined;
}

export interface TextEpochPlanResult {
  readonly changed: boolean;
  readonly sealedEpochs: number;
  readonly compactedBlocks: number;
  readonly savedChars: number;
  readonly savedTokens: number;
  readonly earliestNewInvalidationMsg?: number;
  readonly cliffAvoided?: { at: number; multiplier: number; savedUsd: number };
}

const TOKEN_EXACT_LIMIT = 32_000;
const DIGEST_CACHE_MAX_CHARS = 8 * 1024 * 1024;
const digestCache = new Map<string, string>();
let digestCacheChars = 0;

const LINE_NUM_PREFIX_RE = /^(\s*\d{1,7}(?:\t|→|\s*[|\u2502](?:\s|$)))/;
const LINE_NUM_VAL_RE = /^\s*(\d{1,7})(?:\t|→|\s*[|\u2502](?:\s|$))/;
const DIFF_HEADER_RE = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- [^\n]+|\+\+\+ [^\n]+)/;
const LOG_CRITICAL_RE =
  /\b(?:error|err|warn|warning|fail|failed|failure|fatal|panic|exception|traceback|assertion|assert|denied|forbidden|timeout|timed out|refused|oom|killed|segfault|abort|aborted|passed|skipped|summary|exit[_ ]?code(?:[=:\s]+[1-9]\d*)?|returned [1-9]\d*|[A-Za-z_]\w*(?:Error|Exception|Fault|Failure)|ECONNREFUSED|ENOENT|ETIMEDOUT|EACCES|EPERM|EADDRINUSE|EPIPE|EISDIR|ENOSPC)\b|\b(?:status[=:\s]+|HTTP\/\d(?:\.\d)?["'\s]+)[45]\d\d\b|(?:^\s*(?:at\s+\S+\s*\(|Caused by:|File "|Traceback \(most recent call last\)))/i;
const L1_FAIL_SIGNAL_RE =
  /\b(?:FAIL(?:ED)?|AssertionError|TypeError|SyntaxError|ReferenceError|ERR_[A-Z0-9_]+|exit[_ ]?code[:=\s]+[1-9]\d*|returned [1-9]\d*|[1-9]\d*\s+failed)\b|^\s*(?:×\s+\S|at\s+\S+\s*\(|Caused by:|File\s+"[^"\n]+",\s+line\s+\d+|Traceback \(most recent call last\))/im;
const CODE_DECL_RE =
  /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?|pub(?:\([^)]*\))?\s+(?:async\s+)?|async\s+|static\s+|private\s+|protected\s+|public\s+)?(?:function|class|interface|type|enum|struct|trait|impl|fn|func|def|mod|namespace|module)\b|^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>|^\s*(?:import|from\s+\S+\s+import|package|use\s+|#include)\b/;
const IMPORT_LINE_RE = /^\s*(?:import\b|from\s+\S+\s+import\b|use\s+[^;]+;|#include\s*[<"])/;
const EXPORT_OR_PUB_CONST_RE = /^\s*(?:export\s+(?:const|let|var)\s+|pub(?:\([^)]*\))?\s+const\s+|pub(?:\([^)]*\))?\s+static\s+)/;
const TYPE_CONTAINER_RE = /^\s*(?:export\s+(?:default\s+)?|pub(?:\([^)]*\))?\s+)?(?:interface|type\s+\w+\s*=\s*\{|struct|enum)\b/;
const CLASS_IMPL_HEADER_RE = /^\s*(?:export\s+(?:default\s+)?|abstract\s+|pub(?:\([^)]*\))?\s+)?(?:class|trait|impl|protocol|actor)\b/;
const DEPTH1_METHOD_RE = /^\s*(?:(?:async|static|private|protected|public|readonly|override|pub(?:\([^)]*\))?|fn|func|def|get|set)\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>\n]{0,60}>)?\s*\(/;
const THROW_PANIC_RE = /\b(?:throw\s+|raise\s+|panic!\s*\()/;
const CONTROL_KW_RE = /^\s*(?:if|else|for|while|switch|catch|with|return|match)\b/;

const TOKEN_CACHE_MAX = 2048;
const tokenCountCache = new Map<string, number>();

function countTokensExactCached(s: string): number {
  const key = `${s.length}:${fnv64Hex(s)}`;
  const hit = tokenCountCache.get(key);
  if (hit !== undefined) return hit;
  const tok = gptTokenCount(s);
  if (tokenCountCache.size >= TOKEN_CACHE_MAX) {
    const oldest = tokenCountCache.keys().next().value;
    if (oldest !== undefined) tokenCountCache.delete(oldest);
  }
  tokenCountCache.set(key, tok);
  return tok;
}

function countTokens(s: string): number {
  if (s.length <= TOKEN_EXACT_LIMIT && !hasLongUnbrokenBpeChunk(s)) return countTokensExactCached(s);
  return Math.ceil(s.length / 3.5);
}

function estimateTokenPair(before: string, after: string): [number, number] {
  if (
    before.length <= TOKEN_EXACT_LIMIT &&
    after.length <= TOKEN_EXACT_LIMIT &&
    !hasLongUnbrokenBpeChunk(before) &&
    !hasLongUnbrokenBpeChunk(after)
  ) {
    return [countTokensExactCached(before), countTokensExactCached(after)];
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

/** Test seam: drop in-memory sticky epoch caches (e.g. to verify restart recovery via session-state). */
export function resetTextEpochStickyState(): void {
  stickySealedEpochs.clear();
  stickyCliffEpochs.clear();
  tokenCountCache.clear();
  resetGlobalPrefixTape();
}

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

function extractJsonSummary(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const ERROR_LEAF_KEY_RE = /^(?:error|err|message|reason|detail|status|code|failures|errors)$/i;
  const errorLeaves: string[] = [];
  const collectErrors = (val: unknown, path: string, depth: number): void => {
    if (errorLeaves.length >= 8 || depth > 5 || !val || typeof val !== 'object') return;
    if (Array.isArray(val)) {
      const cap = Math.min(val.length, 16);
      for (let i = 0; i < cap; i++) {
        collectErrors(val[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (errorLeaves.length >= 8) break;
      const p = path ? `${path}.${k}` : k;
      if (ERROR_LEAF_KEY_RE.test(k) && v !== null && v !== undefined && typeof v !== 'object') {
        const s = String(v).slice(0, 100);
        if (s && s !== 'ok' && s !== '200' && s !== '0' && s !== 'true') {
          errorLeaves.push(`${p}=${JSON.stringify(s)}`);
        }
      } else if (v && typeof v === 'object') {
        collectErrors(v, p, depth + 1);
      }
    }
  };
  collectErrors(parsed, '', 0);

  const summarizeVal = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v !== 'object') return JSON.stringify(v).slice(0, 60);
    if (Array.isArray(v)) return `Array(${v.length})`;
    return `{${Object.keys(v as Record<string, unknown>).length} keys}`;
  };

  const parts: string[] = [];
  if (Array.isArray(parsed)) {
    parts.push(`root: Array(${parsed.length})`);
    const sampleIdx = parsed.length <= 3 ? parsed.map((_, i) => i) : [0, 1, parsed.length - 1];
    for (const idx of sampleIdx) {
      if (idx < parsed.length) parts.push(`  [${idx}]: ${JSON.stringify(parsed[idx]).slice(0, 140)}`);
    }
  } else {
    const entries = Object.entries(parsed as Record<string, unknown>);
    const cap = Math.min(entries.length, 24);
    for (let i = 0; i < cap; i++) {
      const [k, v] = entries[i]!;
      parts.push(`  ${k}: ${summarizeVal(v)}`);
    }
    if (entries.length > cap) {
      parts.push(`  ... (+${entries.length - cap} more top-level keys)`);
    }
  }
  if (errorLeaves.length > 0) {
    parts.push(`errors/status: ${errorLeaves.join(', ')}`);
  }
  return parts.join('\n');
}

function formatProportionalDiffDigest(lines: readonly string[]): { lines: string[]; omitted: number } {
  interface DiffSection {
    headerLines: string[];
    deltaIndices: number[];
    fileLabel: string;
  }
  const sections: DiffSection[] = [];
  let cur: DiffSection | null = null;
  const ensureSection = (label = 'diff'): DiffSection => {
    if (!cur) {
      cur = { headerLines: [], deltaIndices: [], fileLabel: label };
      sections.push(cur);
    }
    return cur;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      cur = { headerLines: [l], deltaIndices: [], fileLabel: l.slice(11).trim() };
      sections.push(cur);
    } else if (DIFF_HEADER_RE.test(l)) {
      ensureSection().headerLines.push(l);
    } else if (/^[+-]/.test(l)) {
      ensureSection().deltaIndices.push(i);
    }
  }

  if (sections.length === 0) return { lines: [], omitted: 0 };

  const TOTAL_BUDGET = 80;
  const minPerSection = Math.min(4, Math.max(1, Math.floor(TOTAL_BUDGET / sections.length)));
  const alloc = sections.map((s) => Math.min(s.deltaIndices.length, minPerSection));
  let used = alloc.reduce((a, b) => a + b, 0);
  let remaining = Math.max(0, TOTAL_BUDGET - used);

  // Proportional allocation with slack water-filling across file sections.
  if (remaining > 0) {
    const unsatisfied = sections
      .map((s, idx) => ({ idx, rem: s.deltaIndices.length - alloc[idx]! }))
      .filter((x) => x.rem > 0);
    const totalRem = unsatisfied.reduce((sum, x) => sum + x.rem, 0);
    if (totalRem > 0) {
      for (const x of unsatisfied) {
        const share = Math.min(x.rem, Math.floor((remaining * x.rem) / totalRem));
        alloc[x.idx]! += share;
        used += share;
      }
      let slack = Math.max(0, TOTAL_BUDGET - used);
      for (const x of unsatisfied) {
        if (slack <= 0) break;
        const canAdd = Math.min(slack, sections[x.idx]!.deltaIndices.length - alloc[x.idx]!);
        if (canAdd > 0) {
          alloc[x.idx]! += canAdd;
          slack -= canAdd;
        }
      }
    }
  }

  const out: string[] = [];
  let omitted = 0;
  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    omitted += sections[sIdx]!.deltaIndices.length - alloc[sIdx]!;
  }
  let sectionIdx = -1;
  let keptInSec = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      if (sectionIdx >= 0) {
        const secOmitted = sections[sectionIdx]!.deltaIndices.length - keptInSec;
        if (secOmitted > 0) out.push(`... (${secOmitted} extra +/- lines omitted in ${sections[sectionIdx]!.fileLabel}) ...`);
      }
      sectionIdx++;
      keptInSec = 0;
      out.push(l);
    } else if (DIFF_HEADER_RE.test(l)) {
      if (sectionIdx < 0) sectionIdx = 0;
      out.push(l);
    } else if (/^[+-]/.test(l)) {
      if (sectionIdx < 0) sectionIdx = 0;
      if (keptInSec < (alloc[sectionIdx] ?? 0)) {
        out.push(l);
        keptInSec++;
      }
    }
  }
  if (sectionIdx >= 0) {
    const secOmitted = sections[sectionIdx]!.deltaIndices.length - keptInSec;
    if (secOmitted > 0) out.push(`... (${secOmitted} extra +/- lines omitted in ${sections[sectionIdx]!.fileLabel}) ...`);
  }
  return { lines: out, omitted };
}

function buildCodeSkeletonDigest(lines: readonly string[]): { bodyLines: string[]; keptCount: number } {
  const n = lines.length;
  const stripped = lines.map(stripLineNumPrefix);
  const lineNumbers = lines.map((l, idx) => {
    const m = LINE_NUM_VAL_RE.exec(l);
    return m ? Number.parseInt(m[1]!, 10) : idx + 1;
  });

  // Lexical scope state across lines: string/comment tracking, {}, (), [] depth, Python indent.
  let inBlockComment = false;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let pythonMode = false;

  interface BlockInfo {
    kind: 'class' | 'type' | 'fn';
    headerLineIdx: number;
    targetBraceDepth: number;
    pythonIndent: number;
    isPython: boolean;
    keptFields: number;
    keptThrows: number;
    endLineIdx: number;
  }
  const stack: BlockInfo[] = [];
  const keepIdx = new Set<number>();
  const bodySpanNote = new Map<number, string>();
  const importCollapsed = new Map<number, { endIdx: number; summary: string }>();

  for (let i = 0; i < Math.min(4, n); i++) keepIdx.add(i);
  for (let i = Math.max(0, n - 4); i < n; i++) keepIdx.add(i);

  let importRunStart = -1;
  let importRunEnd = -1;
  const importNames: string[] = [];
  const flushImportRun = (): void => {
    if (importRunStart >= 0 && importRunEnd > importRunStart) {
      const startNum = lineNumbers[importRunStart]!;
      const endNum = lineNumbers[importRunEnd]!;
      const names = [...new Set(importNames)].slice(0, 8).join(', ');
      importCollapsed.set(importRunStart, {
        endIdx: importRunEnd,
        summary: `imports [L${startNum}-L${endNum}] (${importRunEnd - importRunStart + 1} lines)${names ? `: ${names}` : ''}`,
      });
    } else if (importRunStart >= 0) {
      keepIdx.add(importRunStart);
    }
    importRunStart = -1;
    importRunEnd = -1;
    importNames.length = 0;
  };

  let pendingSigBlock: BlockInfo | null = null;
  let sigLinesRemaining = 0;
  let keptConsts = 0;

  const indentOf = (s: string): number => {
    let w = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (c === 32) w++;
      else if (c === 9) w += 4;
      else break;
    }
    return w;
  };

  for (let i = 0; i < n; i++) {
    const rawLine = stripped[i]!;
    const trimmed = rawLine.trim();
    const indent = indentOf(rawLine);

    if (!pythonMode && (/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(rawLine) || /^\s*class\s+\w+[^:]*:\s*$/.test(rawLine))) {
      pythonMode = true;
    }

    // Close Python indent-scoped blocks when dedenting.
    if (trimmed.length > 0 && !trimmed.startsWith('#')) {
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        if (!top.isPython || indent > top.pythonIndent) break;
        stack.pop();
        top.endLineIdx = Math.max(top.headerLineIdx, i - 1);
        if (top.kind === 'fn' && top.endLineIdx > top.headerLineIdx) {
          bodySpanNote.set(top.headerLineIdx, `[L${lineNumbers[top.headerLineIdx]!}-L${lineNumbers[top.endLineIdx]!}]`);
        }
      }
    }

    // Collapse contiguous import runs at depth 0.
    if (braceDepth === 0 && parenDepth === 0 && !inBlockComment && IMPORT_LINE_RE.test(rawLine)) {
      if (importRunStart < 0) importRunStart = i;
      importRunEnd = i;
      const modMatch = /from\s+['"]?([^'"\s;]+)['"]?|import\s+['"]?([^'"\s;]+)['"]?|use\s+([^;]+);|#include\s*[<"]([^>"]+)[>"]/.exec(trimmed);
      const modName = (modMatch?.[1] ?? modMatch?.[2] ?? modMatch?.[3] ?? modMatch?.[4] ?? '').trim();
      if (modName && importNames.length < 12) importNames.push(modName);
      continue;
    } else if (importRunStart >= 0 && trimmed === '') {
      // Allow single blank lines inside import block only if next non-blank line is also an import.
      let nextNonBlank = i + 1;
      while (nextNonBlank < n && stripped[nextNonBlank]!.trim() === '') nextNonBlank++;
      if (nextNonBlank < n && IMPORT_LINE_RE.test(stripped[nextNonBlank]!)) {
        importRunEnd = i;
        continue;
      }
      flushImportRun();
    } else if (importRunStart >= 0) {
      flushImportRun();
    }

    const depthBefore = braceDepth;
    const parenBefore = parenDepth;

    // Scan string/comment/delimiter state on this line in O(L).
    let openBraces = 0;
    let closeBraces = 0;
    let quote = 0;
    let escaped = false;
    for (let j = 0; j < rawLine.length; j++) {
      const c = rawLine.charCodeAt(j);
      const next = j + 1 < rawLine.length ? rawLine.charCodeAt(j + 1) : 0;
      if (inBlockComment) {
        if (c === 42 && next === 47) {
          inBlockComment = false;
          j++;
        }
        continue;
      }
      if (quote !== 0) {
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;
        else if (c === quote) quote = 0;
        continue;
      }
      if (c === 47 && next === 47) break;
      if (c === 35 && (pythonMode || (j === 0 && next === 32))) break;
      if (c === 47 && next === 42) {
        inBlockComment = true;
        j++;
        continue;
      }
      if (c === 34 || c === 39 || c === 96) {
        quote = c;
        continue;
      }
      if (c === 123) {
        braceDepth++;
        openBraces++;
      } else if (c === 125) {
        braceDepth = Math.max(0, braceDepth - 1);
        closeBraces++;
      } else if (c === 40) {
        parenDepth++;
      } else if (c === 41) {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (c === 91) {
        bracketDepth++;
      } else if (c === 93) {
        bracketDepth = Math.max(0, bracketDepth - 1);
      }
    }

    const topScope = stack.length > 0 ? stack[stack.length - 1] : undefined;
    if (sigLinesRemaining > 0 && pendingSigBlock) {
      keepIdx.add(i);
      if (openBraces > 0 || parenDepth === 0 || (pendingSigBlock.isPython && /:\s*(?:#.*)?$/.test(trimmed))) {
        sigLinesRemaining = 0;
        if (!pendingSigBlock.isPython && braceDepth > pendingSigBlock.targetBraceDepth) {
          stack.push(pendingSigBlock);
          pendingSigBlock = null;
        } else if (pendingSigBlock.isPython) {
          stack.push(pendingSigBlock);
          pendingSigBlock = null;
        } else if (parenDepth === 0) {
          pendingSigBlock = null;
        }
      } else {
        sigLinesRemaining--;
      }
    } else if (!inBlockComment && trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
      const inClassScope = topScope?.kind === 'class' && depthBefore === topScope.targetBraceDepth + 1;
      const isCodeDecl = CODE_DECL_RE.test(rawLine);
      const isConstDecl = !isCodeDecl && depthBefore === 0 && EXPORT_OR_PUB_CONST_RE.test(rawLine);
      const isDecl =
        (depthBefore === 0 && (isCodeDecl || (isConstDecl && keptConsts < 12))) ||
        (inClassScope &&
          !CONTROL_KW_RE.test(rawLine) &&
          (isCodeDecl || DEPTH1_METHOD_RE.test(rawLine)));

      if (isDecl && parenBefore === 0 && bracketDepth === 0) {
        if (isConstDecl) keptConsts++;
        keepIdx.add(i);
        const kind: BlockInfo['kind'] = CLASS_IMPL_HEADER_RE.test(rawLine)
          ? 'class'
          : TYPE_CONTAINER_RE.test(rawLine)
            ? 'type'
            : 'fn';
        const isPyBlock = pythonMode && /^\s*(?:async\s+)?def\b|^\s*class\b/.test(rawLine);
        const info: BlockInfo = {
          kind,
          headerLineIdx: i,
          targetBraceDepth: depthBefore,
          pythonIndent: indent,
          isPython: isPyBlock,
          keptFields: 0,
          keptThrows: 0,
          endLineIdx: i,
        };
        if (isPyBlock) {
          if (parenDepth > 0 || !/:\s*(?:#.*)?$/.test(trimmed)) {
            pendingSigBlock = info;
            sigLinesRemaining = 6;
          } else {
            stack.push(info);
          }
        } else if (braceDepth > depthBefore) {
          stack.push(info);
        } else if (parenDepth > 0 || (!trimmed.endsWith(';') && !rawLine.includes('{'))) {
          pendingSigBlock = info;
          sigLinesRemaining = 6;
        }
      } else if (topScope?.kind === 'type' && depthBefore === topScope.targetBraceDepth + 1) {
        if (topScope.keptFields < 8 && !trimmed.startsWith('}')) {
          keepIdx.add(i);
          topScope.keptFields++;
        }
      } else if (topScope?.kind === 'fn' && THROW_PANIC_RE.test(rawLine)) {
        if (topScope.keptThrows < 4) {
          keepIdx.add(i);
          topScope.keptThrows++;
        }
      }
    }

    if (closeBraces > 0) {
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        if (top.isPython || braceDepth > top.targetBraceDepth) break;
        stack.pop();
        top.endLineIdx = i;
        if (top.kind === 'fn' && i > top.headerLineIdx) {
          bodySpanNote.set(top.headerLineIdx, `[L${lineNumbers[top.headerLineIdx]!}-L${lineNumbers[i]!}]`);
        }
        keepIdx.add(i);
      }
    }
  }
  flushImportRun();
  for (const open of stack) {
    if (open.kind === 'fn' && n - 1 > open.headerLineIdx) {
      bodySpanNote.set(open.headerLineIdx, `[L${lineNumbers[open.headerLineIdx]!}-L${lineNumbers[n - 1]!}]`);
    }
  }

  const bodyLines: string[] = [];
  let keptCount = 0;
  let prevEmitted = -1;
  for (let i = 0; i < n; i++) {
    const imp = importCollapsed.get(i);
    if (imp) {
      if (prevEmitted >= 0 && i > prevEmitted + 1) {
        bodyLines.push(`  ... (${i - prevEmitted - 1} lines omitted) ...`);
      }
      bodyLines.push(imp.summary);
      keptCount++;
      prevEmitted = imp.endIdx;
      i = imp.endIdx;
      continue;
    }
    if (!keepIdx.has(i)) continue;
    if (prevEmitted >= 0 && i > prevEmitted + 1) {
      bodyLines.push(`  ... (${i - prevEmitted - 1} lines omitted) ...`);
    }
    const span = bodySpanNote.get(i);
    bodyLines.push(span ? `${lines[i]!} // ${span}` : lines[i]!);
    keptCount++;
    prevEmitted = i;
  }
  return { bodyLines, keptCount };
}

/**
 * Deterministic extractive structural digest for aged tool outputs.
 */
export function extractStructuralDigest(text: string, refId = 'prior'): string {
  const cacheKey = `${refId}\0${text.length}:${fnv64Hex(text)}`;
  const hit = digestCache.get(cacheKey);
  if (hit !== undefined) {
    digestCache.delete(cacheKey);
    digestCache.set(cacheKey, hit);
    return hit;
  }

  const store = (digest: string): string => {
    const cost = cacheKey.length + digest.length;
    if (cost <= DIGEST_CACHE_MAX_CHARS) {
      const existing = digestCache.get(cacheKey);
      if (existing !== undefined) {
        digestCacheChars -= cacheKey.length + existing.length;
        digestCache.delete(cacheKey);
      }
      while (digestCacheChars + cost > DIGEST_CACHE_MAX_CHARS && digestCache.size > 0) {
        const oldestKey = digestCache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldestVal = digestCache.get(oldestKey);
        digestCache.delete(oldestKey);
        if (oldestVal !== undefined) digestCacheChars -= oldestKey.length + oldestVal.length;
      }
      digestCache.set(cacheKey, digest);
      digestCacheChars += cost;
    }
    return digest;
  };

  const lines = text.split('\n');
  const appendSheet = (body: string) => {
    const sheet = factSheetText(text, { format: 'compact', coveredText: body, dropCovered: true });
    return store(sheet ? `${body}\n${sheet}` : body);
  };

  if (text.startsWith('@toon ') || looksLikeJsonPayload(text)) {
    if (!text.startsWith('@toon ')) {
      const jsonSummary = extractJsonSummary(text);
      if (jsonSummary !== null) {
        const body = `[fiche epoch-digest ${refId}: JSON summary (${lines.length} lines, ${text.length} chars)]\n${jsonSummary}`;
        if (body.length < text.length) {
          return appendSheet(body);
        }
      }
    }
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
    const diffRes = formatProportionalDiffDigest(lines);
    const summary = `[fiche epoch-digest ${refId}: unified diff (${lines.length} lines${diffRes.omitted > 0 ? `, ${diffRes.omitted} extra +/- lines omitted` : ''})]`;
    return appendSheet([summary, ...diffRes.lines].join('\n'));
  }

  if (looksLikeCodeOrLineNumbered(lines)) {
    const skel = buildCodeSkeletonDigest(lines);
    const header = `[fiche epoch-digest ${refId}: code skeleton (${lines.length} lines -> ${skel.keptCount} signature/boundary lines); re-read if full body needed]`;
    return appendSheet([header, ...skel.bodyLines].join('\n'));
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

function isAlreadyCompactedMarker(raw: string): boolean {
  return (
    raw.startsWith('[fiche cas') ||
    raw.startsWith('[fiche epoch-digest') ||
    raw.startsWith('[fiche vm-page') ||
    raw.startsWith('[fiche causal-episode ') ||
    raw.startsWith('[folded into ') ||
    raw.startsWith('[inkling cas') ||
    raw.startsWith('[inkling epoch-digest')
  );
}

export function planAndApplyTextEpochs(args: TextEpochPlanArgs): TextEpochPlanResult {
  const keepTail = args.keepTailMessages ?? 6;
  const isAutoCacheOpenAI =
    !(args.cacheBreakpoints && args.cacheBreakpoints.length > 0) &&
    args.ttlSec === undefined &&
    isAutoCacheOpenAIModel(args.model);
  const epochTarget = args.epochTokenTarget ?? 4_000;
  const maxPayback = args.maxPaybackReads ?? 12;
  const lsmActive =
    args.enableLsm !== false &&
    (args.enableLsm === true ||
      args.sessionKey !== undefined ||
      args.sessionCacheCold !== undefined ||
      args.onPageOut !== undefined ||
      args.lsmEditTailMessages !== undefined ||
      args.lsmMinLargeBlockTokens !== undefined);
  const lsmEditTail = Math.max(0, args.lsmEditTailMessages ?? 2);
  const lsmMinLargeTokens = Math.max(1, args.lsmMinLargeBlockTokens ?? 600);

  const cutoffMsg = args.totalMessages - keepTail;
  const cutoffL1 = args.totalMessages - lsmEditTail;

  if (args.blocks.length === 0) {
    return { changed: false, sealedEpochs: 0, compactedBlocks: 0, savedChars: 0, savedTokens: 0 };
  }
  if (lsmActive ? cutoffL1 <= 1 && cutoffMsg <= 1 : cutoffMsg <= 1) {
    return { changed: false, sealedEpochs: 0, compactedBlocks: 0, savedChars: 0, savedTokens: 0 };
  }

  interface Candidate {
    block: TextEpochBlock;
    raw: string;
    rawTokens: number;
    sig: string;
  }

  const maxCandidateCutoff = lsmActive ? Math.max(cutoffMsg, cutoffL1) : cutoffMsg;
  const agedEligible: Candidate[] = [];
  const l1ZoneBlocks: Array<Candidate | null> = [];
  const coldL2Eligible: Candidate[] = [];

  for (const b of args.blocks) {
    if (b.msgIndex <= 0 || b.msgIndex >= maxCandidateCutoff) continue;
    const raw = b.getText();
    if (raw.length < 1000) {
      if (lsmActive && !args.sessionCacheCold && b.msgIndex >= Math.max(1, cutoffMsg) && b.msgIndex < cutoffL1) {
        l1ZoneBlocks.push(null);
      }
      continue;
    }
    if (isAlreadyCompactedMarker(raw)) {
      if (lsmActive && !args.sessionCacheCold && b.msgIndex >= Math.max(1, cutoffMsg) && b.msgIndex < cutoffL1) {
        l1ZoneBlocks.push(null);
      }
      continue;
    }
    const cand: Candidate = {
      block: b,
      raw,
      rawTokens: countTokens(raw),
      sig: `${b.refId}:${raw.length}:${fnv64Hex(raw)}`,
    };
    if (lsmActive && args.sessionCacheCold === true) {
      if (b.msgIndex < cutoffL1) coldL2Eligible.push(cand);
    } else if (b.msgIndex < cutoffMsg) {
      agedEligible.push(cand);
    } else if (lsmActive && b.msgIndex < cutoffL1) {
      l1ZoneBlocks.push(cand);
    }
  }

  const mode = priceMode();
  const hasSession = Boolean(args.sessionKey);
  const keyPrefix = hasSession
    ? `${args.sessionKey ?? ''}\0${mode}\0${args.model ?? ''}\0${maxPayback}\0`
    : `${mode}\0${args.model ?? ''}\0${args.ttlSec ?? ''}\0${maxPayback}\0`;
  const buildStickyKey = (epoch: readonly Candidate[]): string =>
    `${keyPrefix}${epoch.map((e) => e.sig).join('|')}`;

  const isKeySticky = (key: string): boolean =>
    stickySealedEpochs.has(key) || hasSealedEpochKey(args.sessionKey, key);

  const isEpochStickySealed = (epoch: readonly Candidate[]): boolean => {
    if (epoch.length === 0) return false;
    return isKeySticky(buildStickyKey(epoch));
  };

  const sealedList: Candidate[][] = [];
  const circuitBreakerOpen = isCacheCircuitBreakerOpen(
    args.sessionKey,
    args.model ? { model: args.model } : undefined,
  );
  const breakerState = args.circuitBreakerState ?? (circuitBreakerOpen ? 'open' : 'closed');
  const stickyOnly = args.stickyOnly === true || breakerState === 'open';
  let earliestNewInvalidationMsg = args.earliestNewInvalidationMsg;

  if (lsmActive && args.sessionCacheCold === true) {
    // L2 Cold-Cache Repack: partition all eligible blocks behind cutoffL1, flushing trailing remainder.
    let pending: Candidate[] = [];
    let pendingTokens = 0;
    let pendingSig = '';
    for (const item of coldL2Eligible) {
      if (pending.length === 0 && isKeySticky(`${keyPrefix}${item.sig}`)) {
        sealedList.push([item]);
        continue;
      }
      pending.push(item);
      pendingTokens += item.rawTokens;
      pendingSig = pending.length === 1 ? item.sig : `${pendingSig}|${item.sig}`;
      const stickyHit = isKeySticky(`${keyPrefix}${pendingSig}`);
      if (stickyHit || pendingTokens >= epochTarget) {
        if (!stickyOnly || stickyHit) sealedList.push(pending);
        pending = [];
        pendingTokens = 0;
        pendingSig = '';
      }
    }
    if (!stickyOnly && pending.length > 0) {
      sealedList.push(pending);
    }
  } else {
    // Standard L0/ACDC aged zone behind cutoffMsg.
    let pending: Candidate[] = [];
    let pendingTokens = 0;
    let pendingSig = '';
    for (const item of agedEligible) {
      const singleSticky = isKeySticky(`${keyPrefix}${item.sig}`);
      if (pending.length === 0 && singleSticky) {
        sealedList.push([item]);
        continue;
      }
      if (lsmActive && pending.length > 0 && singleSticky) {
        if (!stickyOnly) sealedList.push(pending);
        pending = [];
        pendingTokens = 0;
        pendingSig = '';
        sealedList.push([item]);
        continue;
      }
      pending.push(item);
      pendingTokens += item.rawTokens;
      pendingSig = pending.length === 1 ? item.sig : `${pendingSig}|${item.sig}`;
      const stickyHit = lsmActive && isKeySticky(`${keyPrefix}${pendingSig}`);
      if (stickyHit || pendingTokens >= epochTarget) {
        if (!stickyOnly || stickyHit) sealedList.push(pending);
        pending = [];
        pendingTokens = 0;
        pendingSig = '';
      }
    }

    // L1 Early Large-Block Compaction behind cutoffL1 (before waiting keepTailMessages = 6 turns).
    // Strictly 1-block `[item]` epochs so crossing cutoffMsg into L0 never splits a sticky key.
    // Defer unsealed blocks carrying failure signals so imminent green checkpoints fold in Stage 3b.
    // Evaluate unsealed L1 blocks newest-first so same-turn upstream L1 blocks see compacted downstream sizes.
    if (lsmActive && cutoffL1 > 1) {
      const unsealedL1: Candidate[] = [];
      for (const item of l1ZoneBlocks) {
        if (!item) continue;
        const itemSticky = isKeySticky(`${keyPrefix}${item.sig}`);
        if (itemSticky) {
          sealedList.push([item]);
        } else if (!stickyOnly && item.rawTokens >= lsmMinLargeTokens && !L1_FAIL_SIGNAL_RE.test(item.raw)) {
          unsealedL1.push(item);
        }
      }
      for (let i = unsealedL1.length - 1; i >= 0; i--) {
        sealedList.push([unsealedL1[i]!]);
      }
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
  for (const item of agedEligible) blockTokensByBlock.set(item.block, item.rawTokens);
  for (const item of coldL2Eligible) blockTokensByBlock.set(item.block, item.rawTokens);
  for (const item of l1ZoneBlocks) {
    if (item) blockTokensByBlock.set(item.block, item.rawTokens);
  }
  for (const b of args.blocks) {
    if (!blockTokensByBlock.has(b)) blockTokensByBlock.set(b, countTokens(b.getText()));
  }

  const coldRepack = lsmActive && args.sessionCacheCold === true;

  const addStickySealed = (key: string): void => {
    if (stickySealedEpochs.size >= STICKY_EPOCH_MAX && !stickySealedEpochs.has(key)) {
      const oldest = stickySealedEpochs.values().next().value;
      if (oldest !== undefined) stickySealedEpochs.delete(oldest);
    }
    stickySealedEpochs.add(key);
    recordSealedEpochKey(args.sessionKey, key);
  };

  for (const epoch of sealedList) {
    const stickyKey = buildStickyKey(epoch);
    const alreadySealed =
      stickySealedEpochs.has(stickyKey) || hasSealedEpochKey(args.sessionKey, stickyKey);

    const proposals = epoch.map((item) => {
      const digest = extractStructuralDigest(item.raw, item.block.refId);
      const [rawTokPaired, digestTokPaired] = estimateTokenPair(item.raw, digest);
      return { item, digest, rawTokPaired, digestTokPaired };
    });

    const epochRawTokens = proposals.reduce((sum, p) => sum + p.rawTokPaired, 0);
    const epochDigestTokens = proposals.reduce((sum, p) => sum + p.digestTokPaired, 0);
    if (!alreadySealed && epochDigestTokens >= epochRawTokens * 0.55) continue;

    const epochFirstMsg = epoch[0]!.block.msgIndex;
    const epochLastBlock = epoch[epoch.length - 1]!.block;
    const epochLastMsg = epochLastBlock.msgIndex;
    const epochLastBlockIdx = epochLastBlock.blockIndex ?? 0;

    let coveringTtlSec = 0;
    const hasBreakpoints = Boolean(args.cacheBreakpoints && args.cacheBreakpoints.length > 0);
    let horizonEndMsg = args.totalMessages - 3;
    if (args.cacheBreakpoints && args.cacheBreakpoints.length > 0) {
      let maxBpMsg = -1;
      for (const bp of args.cacheBreakpoints) {
        if (bp.msgIndex > epochLastMsg || (bp.msgIndex === epochLastMsg && bp.blockIndex >= epochLastBlockIdx)) {
          if (bp.ttlSec > coveringTtlSec) coveringTtlSec = bp.ttlSec;
          if (bp.msgIndex > maxBpMsg) maxBpMsg = bp.msgIndex;
        }
      }
      if (maxBpMsg >= 0) {
        horizonEndMsg = Math.max(horizonEndMsg, Math.min(args.totalMessages - 1, maxBpMsg));
      }
    }
    const effectiveTtlSec = Math.max(args.ttlSec ?? 0, coveringTtlSec) || undefined;
    const epochRates = effectiveTtlSec !== args.ttlSec
      ? resolvePriceRates(args.model, { promptTokens: 0, ttlSec: effectiveTtlSec })
      : rates;

    const coalescedInWave =
      !alreadySealed &&
      earliestNewInvalidationMsg !== undefined &&
      epochFirstMsg > earliestNewInvalidationMsg;
    let downstreamCachedTokens = 0;
    let midPrefixDownstreamTokens = 0;
    if (!coldRepack && !coalescedInWave) {
      let blockSum = 0;
      for (const b of args.blocks) {
        if (b.msgIndex > epochLastMsg && b.msgIndex <= horizonEndMsg) {
          const tok = blockTokensByBlock.get(b) ?? 0;
          blockSum += tok;
          if (b.msgIndex < cutoffMsg) {
            midPrefixDownstreamTokens += tok;
          }
        }
      }
      let msgSum = 0;
      if ((hasBreakpoints || isAutoCacheOpenAI) && args.msgTotalTokens && args.msgTotalTokens.length > 0) {
        const limit = Math.min(args.msgTotalTokens.length - 1, horizonEndMsg);
        for (let m = epochLastMsg + 1; m <= limit; m++) {
          msgSum += args.msgTotalTokens[m] ?? 0;
        }
      }
      downstreamCachedTokens = Math.max(blockSum, msgSum);
      if (hasBreakpoints) {
        midPrefixDownstreamTokens = downstreamCachedTokens;
      }
    }
    if (!alreadySealed && breakerState === 'half_open' && downstreamCachedTokens > 0) continue;

    const effectiveWriteRate = isAutoCacheOpenAI
      ? Math.min(epochRates.write, 1)
      : epochRates.write;
    const savedTok = epochRawTokens - epochDigestTokens;
    const savedPerRead = savedTok * epochRates.read;
    const transitionCost = coalescedInWave
      ? (epochDigestTokens - epochRawTokens) * effectiveWriteRate
      : epochDigestTokens * effectiveWriteRate -
        epochRawTokens * epochRates.read +
        downstreamCachedTokens * (effectiveWriteRate - epochRates.read);
    const paybackReads =
      savedPerRead > 0 ? Math.ceil(Math.max(0, transitionCost) / savedPerRead) : Infinity;

    const stickyCliffAt = mode === 'kosha' ? stickyCliffEpochs.get(stickyKey) : undefined;
    const stickyCliffActive = stickyCliffAt !== undefined && runningPrompt > stickyCliffAt;

    const cliff = evaluateCliffAvoidance(args.model, {
      promptTokensBefore: runningPrompt,
      promptTokensAfter: Math.max(0, runningPrompt - savedTok),
      collapsedBaselineTokens: epochRawTokens,
      collapsedActualTokens: epochDigestTokens,
      downstreamCachedTokens,
      expectedOutputTokens: expectedOut,
      ttlSec: effectiveTtlSec,
    });

    const turnsObserved = Math.max(1, Math.floor(args.totalMessages / 2));
    const frontierOnly =
      downstreamCachedTokens > 0 &&
      midPrefixDownstreamTokens === 0 &&
      !hasBreakpoints &&
      !(effectiveTtlSec !== undefined && effectiveTtlSec >= 3600);
    const cliffWins = Boolean(cliff?.crossesCliff && cliff.netSingleTurnUsd > 0) || stickyCliffActive;
    let effectiveMaxPayback =
      args.maxPaybackReads !== undefined
        ? maxPayback
        : computeHorizonPaybackLimit({
            turnsObserved,
            baseMaxPayback: maxPayback,
            downstreamCachedTokens,
            frontierOnly,
            ttlSec: effectiveTtlSec,
            ewmaInterTurnSec: args.ewmaInterTurnSec,
            ewmaHitRatio: args.ewmaHitRatio,
            writeRate: effectiveWriteRate,
          });
    if (
      args.maxPaybackReads === undefined &&
      effectiveTtlSec !== undefined &&
      effectiveTtlSec >= 3600 &&
      downstreamCachedTokens > 0
    ) {
      effectiveMaxPayback = Math.min(effectiveMaxPayback, 8);
    }
    if (!alreadySealed && paybackReads > effectiveMaxPayback && !cliffWins) continue;

    let epochSavedChars = 0;
    let epochSavedTok = 0;
    const compactedItems: Candidate[] = [];
    for (const p of proposals) {
      if (p.digest.length < p.item.raw.length && p.digestTokPaired < p.rawTokPaired) {
        const decorated = args.onPageOut ? args.onPageOut(p.item.block, p.item.raw, p.digest) : undefined;
        const replacement = decorated ?? p.digest;
        if (replacement.length >= p.item.raw.length) continue;
        const repTok =
          replacement === p.digest
            ? p.digestTokPaired
            : estimateTokenPair(p.item.raw, replacement)[1];
        if (repTok >= p.rawTokPaired) continue;
        p.item.block.setText(replacement);
        blockTokensByBlock.set(p.item.block, repTok);
        compactedBlocks++;
        compactedItems.push(p.item);
        epochSavedChars += p.item.raw.length - replacement.length;
        epochSavedTok += p.rawTokPaired - repTok;
      }
    }
    if (epochSavedChars > 0) {
      sealedEpochs++;
      totalSavedChars += epochSavedChars;
      totalSavedTokens += epochSavedTok;
      runningPrompt = Math.max(0, runningPrompt - epochSavedTok);
      if (!alreadySealed) {
        earliestNewInvalidationMsg =
          earliestNewInvalidationMsg === undefined
            ? epochFirstMsg
            : Math.min(earliestNewInvalidationMsg, epochFirstMsg);
      }
      addStickySealed(stickyKey);
      if (coldRepack) {
        // Also pin per-block keys so crossing cutoffMsg after L2 -> Warm never tears an epoch.
        for (const ci of compactedItems) {
          addStickySealed(buildStickyKey([ci]));
        }
      }
      if (cliff?.crossesCliff && cliff.netSingleTurnUsd > 0) {
        if (stickyCliffEpochs.size >= STICKY_EPOCH_MAX && !stickyCliffEpochs.has(stickyKey)) {
          const oldest = stickyCliffEpochs.keys().next().value;
          if (oldest !== undefined) stickyCliffEpochs.delete(oldest);
        }
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
    ...(earliestNewInvalidationMsg !== undefined ? { earliestNewInvalidationMsg } : {}),
    ...(cliffAvoided ? { cliffAvoided } : {}),
  };
}
