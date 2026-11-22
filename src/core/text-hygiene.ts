/**
 * Universal, prefix-cache-safe deterministic hygiene for tool/observation text.
 *
 * Grounded in multi-turn coding-agent caching findings:
 *  - CoACT (2026): action-preserving deterministic compression of tool outputs
 *    compounds quadratically across turns without breaking agent edits.
 *  - Prefix caching under 0.05x–0.1x reads ("Context Has a Price", 2026):
 *    removing or changing past observations mid-prefix busts caches, whereas a
 *    pure deterministic function `f(block)` applied consistently when each tool
 *    output enters the transcript produces byte-identical prefixes across turns
 *    while shrinking every cache write and subsequent cache read.
 *
 * Works across ALL providers and models — including text-only and weak-vision
 * models (Claude 5.5, DeepSeek, Kimi, GLM, MiniMax, Qwen, Grok) where inkling
 * refuses image rendering.
 *
 * Workers-safe: zero `node:` imports.
 */

import { getAllowedModelBases } from './applicability.js';
import { readBrandEnv } from './env.js';
import { createCasiIndex } from './casi-delta.js';
import { gptTokenCount, hasLongUnbrokenBpeChunk } from './gpt-tokens.js';
import { compileStaticText, compileToolSchemas, type ToolSchemaWire } from './schema-compiler.js';
import { planAndApplyTextEpochs, type TextEpochBlock } from './text-history.js';
import { encodeToon } from './toon.js';

export type TextHygieneMode = 'auto' | 'on' | 'off';

export interface TextHygieneOptions {
  /** Whether to run Stage 3 Drain structural log folding (default true). */
  foldLogs?: boolean;
  /** Enable TSCG static/schema compilation + ACDC frozen-epoch history compaction. */
  deepTextCompact?: boolean;
  /** Whether to run Stage 5 CASI cross-turn deduplication/delta compression (default true). */
  enableCasi?: boolean;
  /** Also TOON-encode single-line tabular JSON when `INKLING_TEXT_HYGIENE=on`. */
  aggressiveToon?: boolean;
  /** Target model id for kosha payback/cliff math in ACDC. */
  model?: string;
  /** Expected output tokens for kosha cliff avoidance evaluation. */
  expectedOutputTokens?: number;
  /** Raw request body byte length (avoids redundant full-body JSON.stringify). */
  rawBodyBytes?: number;
  /** Native inline/base64 image payload bytes excluded from ACDC token estimates. */
  nativeImageBytes?: number;
  /** Live-tail cutoff message index when optical history collapse follows text hygiene. */
  opticalCollapseCutoffMsg?: number;
  /** Explicit prompt cache TTL (seconds) for cache-aware ACDC payback math. */
  ttlSec?: number;
}

export interface TextHygieneResult {
  readonly text: string;
  readonly changed: boolean;
  readonly savedChars: number;
  readonly savedTokens: number;
  readonly stages: readonly string[];
}

export interface WireHygieneStats {
  readonly changed: boolean;
  readonly savedChars: number;
  readonly savedTokens: number;
  readonly blocks: number;
  readonly stages: readonly string[];
  readonly cliffAvoided?: { at: number; multiplier: number; savedUsd: number };
}

const MAX_HYGIENE_BLOCK_CHARS = 2 * 1024 * 1024;
const TOKEN_EXACT_LIMIT_CHARS = 16_000;

// ANSI / terminal control sequences (CSI, OSC, 2-byte ESC, BEL).
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESC_2BYTE_RE = /\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_SCAN_RE = /[\x1b\x07\x08\r]/;

// Guards against mutating code files / diffs where whitespace or line structure
// is an Edit / apply_patch string-match anchor.
const LINE_NUMBER_RE = /^\s*\d{1,7}(?:\t|→|\s*[|\u2502](?:\s|$))/;
const ALT_LINE_NUMBER_RE = /^L\d{1,7}:\s/;
const DIFF_HEADER_RE = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:))/;
const DIFF_FILE_PAIR_RE = /^--- [^\n]+\n\+\+\+ [^\n]+/m;
const CODE_DECL_LINE_RE =
  /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?|pub(?:\([^)]*\))?\s+(?:async\s+)?|async\s+)?(?:function\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+\s*=|enum\s+\w+|struct\s+\w+|trait\s+\w+|impl\b|fn\s+\w+|func\s+(?:\([^)]*\)\s*)?\w+|def\s+\w+|import\s+(?:\{|\*|\w)|from\s+\S+\s+import\b|#include\s*[<"])/;
const STACK_PREFIX_RE =
  /^\s*(?:at\s+\S+\s*\(|Caused by:|File "|Traceback \(most recent call last\))/i;
const FILE_EXT_LOC_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|cc|h|hpp|rb|php|cs|kt|swift):\d+\b/gi;
const TRAILING_WS_LINE_RE = /[ \t](?:\n|$)/;
const MULTI_BLANK_RE = /\n{4,}/g;

function stripAnsiSequences(raw: string): string {
  if (!raw.includes('\x1b') && !raw.includes('\x07')) return raw;
  return raw
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC_2BYTE_RE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x07/g, '');
}

function isAsciiWordChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/**
 * Strictly O(L) file:line matcher replacing `\b\w[\w.-]*\.ext:\d+\b` without
 * catastrophic O(L^2) backtracking on long dotted/hyphenated lines.
 */
function hasFileLineLocation(line: string): boolean {
  if (!line.includes(':')) return false;
  FILE_EXT_LOC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_EXT_LOC_RE.exec(line)) !== null) {
    let sawWord = false;
    for (let i = m.index - 1; i >= 0; i--) {
      const c = line.charCodeAt(i);
      if (isAsciiWordChar(c)) {
        sawWord = true;
      } else if (c !== 46 && c !== 45) {
        break;
      }
    }
    if (sawWord) return true;
  }
  return false;
}
const CRITICAL_LOG_KEYWORD_RE =
  /\b(?:error|err|warn|warning|fail|failed|failure|fatal|panic|exception|traceback|assertion|assert|denied|forbidden|timeout|timed out|refused|oom|killed|segfault|abort|aborted|passed|skipped|summary|exit[_ ]?code(?:[=:\s]+[1-9]\d*)?|returned [1-9]\d*|[A-Za-z_]\w*(?:Error|Exception|Fault|Failure)|ECONNREFUSED|ENOENT|ETIMEDOUT|EACCES|EPERM|EADDRINUSE|EPIPE|EISDIR|ENOSPC)\b|\b(?:status[=:\s]+|HTTP\/\d(?:\.\d)?["'\s]+)[45]\d\d\b/i;

/**
 * Resolve text-hygiene activation mode from call options and `INKLING_TEXT_HYGIENE`.
 *  - Explicit option/env `on`/`true` activates even when `INKLING_MODELS=off`.
 *  - Explicit option/env `off`/`false` disables completely.
 *  - `auto` (default) is active whenever `INKLING_MODELS` has any model enabled.
 */
export function resolveTextHygieneMode(opt?: boolean | TextHygieneMode): TextHygieneMode {
  if (opt === true || opt === 'on') return 'on';
  if (opt === false || opt === 'off') return 'off';
  const raw = readBrandEnv('TEXT_HYGIENE') ?? '';
  const norm = raw.trim().toLowerCase();
  if (/^(1|true|on|yes)$/i.test(norm)) return 'on';
  if (/^(0|false|off|no|none)$/i.test(norm)) return 'off';
  return 'auto';
}

export function isTextHygieneActive(opt?: boolean | TextHygieneMode): boolean {
  const mode = resolveTextHygieneMode(opt);
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return getAllowedModelBases().length > 0;
}

function estimateTokensSaved(original: string, cleaned: string): number {
  const charDelta = original.length - cleaned.length;
  if (charDelta <= 0) return 0;
  // Pure-JS BPE is quadratic on huge strings or long unbroken BPE chunks.
  if (
    original.length <= TOKEN_EXACT_LIMIT_CHARS &&
    !hasLongUnbrokenBpeChunk(original) &&
    !hasLongUnbrokenBpeChunk(cleaned)
  ) {
    const before = gptTokenCount(original);
    const after = gptTokenCount(cleaned);
    if (before > 0 && after >= 0) {
      return Math.max(0, before - after);
    }
  }
  return Math.max(1, Math.round(charDelta / 3.5));
}

function isAsciiWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160;
}

/**
 * Edit/Action-Preservation Safety Guard:
 * Protects source-code file reads, unified diffs, and code-fence-heavy outputs so
 * Edit / apply_patch exact string matching never loses whitespace or repeated lines.
 * Strips ANSI escapes first so colored git diffs, bat, and ripgrep stay protected.
 */
export function isCodeOrDiffProtected(text: string): boolean {
  if (!text) return false;
  const scan = stripAnsiSequences(text);
  if (scan.includes('\n+++ ') && DIFF_FILE_PAIR_RE.test(scan)) return true;

  const hasBackticks = scan.includes('```');
  let numberedLines = 0;
  let codeDecls = 0;
  let fencedLines = 0;
  let inFence = false;
  let diffHeaders = 0;
  let lineIdx = 0;
  let start = 0;
  const len = scan.length;

  while (start <= len) {
    const nl = scan.indexOf('\n', start);
    const end = nl < 0 ? len : nl;
    const line = scan.slice(start, end);
    if (lineIdx < 200) {
      if (LINE_NUMBER_RE.test(line) || ALT_LINE_NUMBER_RE.test(line)) {
        numberedLines++;
        if (numberedLines >= 3) return true;
      }
      if (DIFF_HEADER_RE.test(line)) {
        if (
          line.startsWith('diff --git ') ||
          line.startsWith('*** Begin Patch') ||
          line.startsWith('*** Update File:')
        ) {
          return true;
        }
        diffHeaders++;
        if (diffHeaders >= 2) return true;
      }
      if (lineIdx < 100 && CODE_DECL_LINE_RE.test(line)) {
        codeDecls++;
        if (codeDecls >= 3) return true;
      }
    } else if (!hasBackticks) {
      return false;
    }

    if (hasBackticks) {
      let ws = 0;
      while (ws < line.length && isAsciiWs(line.charCodeAt(ws))) ws++;
      if (
        ws + 2 < line.length &&
        line.charCodeAt(ws) === 96 &&
        line.charCodeAt(ws + 1) === 96 &&
        line.charCodeAt(ws + 2) === 96
      ) {
        inFence = !inFence;
        fencedLines++;
      } else if (inFence) {
        fencedLines++;
      }
    }

    lineIdx++;
    if (nl < 0) break;
    start = nl + 1;
  }

  return hasBackticks && lineIdx > 0 && fencedLines / lineIdx >= 0.3;
}

/** Simulate carriage returns and backspaces within one terminal line cleanly. */
function resolveTerminalLine(line: string): string {
  let active = line;
  if (active.includes('\r')) {
    const segs = active.split('\r');
    // Pick the final non-whitespace overwritten progress frame, falling back to last non-empty.
    let chosen = '';
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i]!.trim().length > 0) {
        chosen = segs[i]!;
        break;
      }
    }
    if (!chosen) {
      for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i]!.length > 0) {
          chosen = segs[i]!;
          break;
        }
      }
    }
    active = chosen;
  }
  if (!active.includes('\x08')) return active;
  const chars: string[] = [];
  for (let i = 0; i < active.length; i++) {
    const ch = active[i]!;
    if (ch === '\x08') {
      if (chars.length > 0) chars.pop();
    } else {
      chars.push(ch);
    }
  }
  return chars.join('');
}

function stripTrailingLineWsLinear(text: string): string {
  const parts: string[] = [];
  let segStart = 0;
  let i = 0;
  const len = text.length;
  while (true) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl < 0 ? len : nl;
    let trimEnd = lineEnd;
    while (trimEnd > i) {
      const c = text.charCodeAt(trimEnd - 1);
      if (c === 32 || c === 9) trimEnd--;
      else break;
    }
    if (trimEnd < lineEnd) {
      parts.push(text.slice(segStart, trimEnd));
      segStart = lineEnd;
    }
    if (nl < 0) break;
    i = nl + 1;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(segStart));
  return parts.join('');
}

function emulateTerminal(
  ansiStripped: string,
  codeProtected: boolean,
  hasAnsi: boolean,
): { text: string; changed: boolean; strippedAnsi: boolean; strippedCr: boolean } {
  const hasBareCrOrBs =
    ansiStripped.includes('\x08') ||
    (() => {
      let idx = ansiStripped.indexOf('\r');
      while (idx >= 0) {
        if (ansiStripped.charCodeAt(idx + 1) !== 10) return true;
        idx = ansiStripped.indexOf('\r', idx + 1);
      }
      return false;
    })();

  // On guarded code/diff reads, never touch CR/LF normalization or indentation/trailing spaces
  // beyond literal ANSI escape codes so exact Edit anchors remain intact.
  if (codeProtected) {
    return {
      text: ansiStripped,
      changed: hasAnsi,
      strippedAnsi: hasAnsi,
      strippedCr: false,
    };
  }

  const normalizedLf = ansiStripped.includes('\r\n') ? ansiStripped.replace(/\r\n/g, '\n') : ansiStripped;
  let resolved = normalizedLf;
  if (hasBareCrOrBs) {
    const resolvedLines = normalizedLf.split('\n').map(resolveTerminalLine);
    resolved = resolvedLines.join('\n');
  }

  // Trailing whitespace trim + 4+ blank line collapse (skip allocation entirely when clean).
  const hasTrailingWs = TRAILING_WS_LINE_RE.test(resolved);
  const hasMultiBlank = resolved.includes('\n\n\n\n');
  let trimmedLines = resolved;
  if (hasTrailingWs) trimmedLines = stripTrailingLineWsLinear(trimmedLines);
  if (hasMultiBlank) trimmedLines = trimmedLines.replace(MULTI_BLANK_RE, '\n\n\n');

  const pureWsSaved = resolved.length - trimmedLines.length;
  const keepWsTrim =
    hasAnsi ||
    hasBareCrOrBs ||
    (pureWsSaved >= 128 && trimmedLines.length <= resolved.length * 0.95);

  const out = keepWsTrim ? trimmedLines : resolved;
  return {
    text: out,
    changed: hasAnsi || out !== ansiStripped,
    strippedAnsi: hasAnsi,
    strippedCr: hasBareCrOrBs && resolved !== normalizedLf,
  };
}

/** Losslessly convert tabular JSON to `@toon` or minify pretty-printed JSON objects/arrays. */
function encodeStructuredJson(
  text: string,
  _aggressiveToon: boolean,
): { text: string; stage: 'toon' | 'json' } | null {
  const hasNewline = text.includes('\n');
  if (text.length < 256) return null;
  let start = 0;
  let end = text.length;
  while (start < end && isAsciiWs(text.charCodeAt(start))) start++;
  while (end > start && isAsciiWs(text.charCodeAt(end - 1))) end--;
  if (end - start < 2) return null;
  const first = text.charCodeAt(start);
  const last = text.charCodeAt(end - 1);
  if (!((first === 123 && last === 125) || (first === 91 && last === 93))) {
    return null;
  }
  const trimmed = start === 0 && end === text.length ? text : text.slice(start, end);
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') return null;
    const minJsonBox: { json?: string } = {};
    const toon = encodeToon(parsed, minJsonBox);
    if (toon !== null && toon.length < text.length) {
      return { text: toon, stage: 'toon' };
    }
    if (!hasNewline) return null;
    const min = minJsonBox.json ?? JSON.stringify(parsed);
    if (!min) return null;
    if (text.length - min.length < 128) return null;
    if (min.length > text.length * 0.85) return null;
    return { text: min, stage: 'json' };
  } catch {
    return null;
  }
}

/** Parameterize variable tokens into a Drain-style structural template for repetition detection. */
function drainTemplate(line: string): string {
  const s = line.trim();
  if (!s) return '<EMPTY>';
  return s
    // UUIDs
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
    // ISO timestamps & HH:MM:SS.sss
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<TS>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<TIME>')
    // IPv4 + optional port
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<IP>')
    // Hex addresses / digests >= 8 hex chars
    .replace(/\b0x[0-9a-f]+\b/gi, '<HEX>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<HEX>')
    // Durations & byte sizes
    .replace(/\b\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s|m|h|B|KB|KiB|MB|MiB|GB|GiB)\b/gi, '<UNIT>')
    // Remaining integers / decimals
    .replace(/\b\d+(?:\.\d+)?\b/g, '<NUM>');
}

const LOG_ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const LOG_CLOCK_TS_RE = /(?:^|[\s\[])\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\]|[\s,:])/;
const LOG_LEVEL_RE = /\b(?:INFO|DEBUG|TRACE|VERBOSE|NOTICE|LOG)\b/;
const LOG_HTTP_RE = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*/;
const LOG_RUNNER_RE = /^\s*(?:✓|✔|PASS|OK|RUN|Compiling|Downloading|Fetching|Resolving|Checking|Installing|Building|Bundling|Built|Transformed|Rendered)\b/;

function isLogShapedLine(line: string): boolean {
  return (
    LOG_ISO_TS_RE.test(line) ||
    LOG_CLOCK_TS_RE.test(line) ||
    LOG_LEVEL_RE.test(line) ||
    LOG_HTTP_RE.test(line) ||
    LOG_RUNNER_RE.test(line)
  );
}

function isAnchorLine(line: string, index: number, total: number): boolean {
  if (index < 5 || index >= total - 15) return true;
  if (!line.trim()) return false;
  if (CRITICAL_LOG_KEYWORD_RE.test(line)) return true;
  if (STACK_PREFIX_RE.test(line) || hasFileLineLocation(line)) return true;
  if (!isLogShapedLine(line)) return true;
  return false;
}

function isJsonWrappedFast(text: string): boolean {
  let start = 0;
  let end = text.length;
  while (start < end && isAsciiWs(text.charCodeAt(start))) start++;
  while (end > start && isAsciiWs(text.charCodeAt(end - 1))) end--;
  if (end - start < 2) return false;
  const first = text.charCodeAt(start);
  const last = text.charCodeAt(end - 1);
  return (first === 123 && last === 125) || (first === 91 && last === 93);
}

/**
 * Drain-inspired structural log-template folder:
 *  - Preserves first/last context lines, all error/warning/test summary/stack lines.
 *  - Collapses contiguous runs (>=4) and global high-frequency boilerplate (>=12) of
 *    structurally identical template lines with explicit `[... K similar lines folded ...]`.
 */
function foldRepetitiveLogs(text: string): string | null {
  if (text.length < 1024 || isJsonWrappedFast(text)) {
    // Do not mangle structured JSON blobs if minification declined them.
    return null;
  }

  const lines = text.split('\n');
  if (lines.length < 25) return null;

  const total = lines.length;
  const anchored = new Uint8Array(total);
  const templates = new Array<string>(total);
  const freq = new Map<string, number>();

  for (let i = 0; i < total; i++) {
    const line = lines[i]!;
    if (isAnchorLine(line, i, total)) {
      anchored[i] = 1;
      templates[i] = '';
    } else {
      const tpl = drainTemplate(line);
      templates[i] = tpl;
      if (tpl !== '<EMPTY>') {
        freq.set(tpl, (freq.get(tpl) ?? 0) + 1);
      }
    }
  }

  const keep = new Uint8Array(total);
  keep.fill(1);

  // Pass A: contiguous runs of >= 4 identical templates (bridging blank <EMPTY> separators; keep first 2, last 1).
  let runStart = 0;
  while (runStart < total) {
    if (anchored[runStart] || templates[runStart] === '<EMPTY>') {
      runStart++;
      continue;
    }
    const tpl = templates[runStart]!;
    const runIndices: number[] = [runStart];
    let runEnd = runStart + 1;
    while (
      runEnd < total &&
      !anchored[runEnd] &&
      (templates[runEnd] === tpl || templates[runEnd] === '<EMPTY>')
    ) {
      if (templates[runEnd] === tpl) runIndices.push(runEnd);
      runEnd++;
    }
    if (runIndices.length >= 4) {
      const keepHeadEnd = runIndices[1]!;
      const keepTailStart = runIndices[runIndices.length - 1]!;
      for (let k = keepHeadEnd + 1; k < keepTailStart; k++) {
        keep[k] = 0;
      }
    }
    runStart = runIndices[runIndices.length - 1]! + 1;
  }

  // Pass B: globally repetitive non-anchored templates (>= 12 times: keep first 3 + last 2).
  const highFreqPositions = new Map<string, number[]>();
  for (let i = 0; i < total; i++) {
    const tpl = templates[i]!;
    if (!tpl || tpl === '<EMPTY>' || (freq.get(tpl) ?? 0) < 12) continue;
    let list = highFreqPositions.get(tpl);
    if (!list) {
      list = [];
      highFreqPositions.set(tpl, list);
    }
    list.push(i);
  }
  for (const positions of highFreqPositions.values()) {
    for (let j = 3; j < positions.length - 2; j++) {
      keep[positions[j]!] = 0;
    }
  }

  // Pass C: collapse <EMPTY> blank lines sandwiched inside any folded span.
  let prevNonEmptyKept = true;
  for (let i = 0; i < total; i++) {
    if (templates[i] !== '<EMPTY>') {
      prevNonEmptyKept = keep[i] === 1;
      continue;
    }
    if (keep[i] === 0 || prevNonEmptyKept) continue;
    let j = i + 1;
    while (j < total && templates[j] === '<EMPTY>') j++;
    const nextNonEmptyKept = j < total ? keep[j] === 1 : true;
    if (!nextNonEmptyKept) {
      for (let k = i; k < j; k++) keep[k] = 0;
    }
    i = j - 1;
  }

  const out: string[] = [];
  let foldedCount = 0;
  const flushFolded = (): void => {
    if (foldedCount > 0) {
      out.push(`[... ${foldedCount} similar lines folded ...]`);
      foldedCount = 0;
    }
  };

  for (let i = 0; i < total; i++) {
    if (keep[i]) {
      flushFolded();
      out.push(lines[i]!);
    } else {
      // Collapse blank lines engulfed inside a folded region cleanly.
      if (templates[i] !== '<EMPTY>') foldedCount++;
    }
  }
  flushFolded();

  const candidate = out.join('\n');
  const saved = text.length - candidate.length;
  if (saved < 256 || candidate.length > text.length * 0.75) {
    return null;
  }
  return candidate;
}

function cleanToolOutputCore(
  text: string,
  opts?: TextHygieneOptions,
): { text: string; changed: boolean; stages: string[] } {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_HYGIENE_BLOCK_CHARS) {
    return { text, changed: false, stages: [] };
  }
  if (text.length < 256 && !CONTROL_SCAN_RE.test(text)) {
    return { text, changed: false, stages: [] };
  }

  // Strip ANSI first so colored diffs, bat pipes, and ripgrep results stay code-protected.
  const ansiStripped = stripAnsiSequences(text);
  const strippedAnsi = ansiStripped !== text;
  const codeProtected = isCodeOrDiffProtected(ansiStripped);
  const foldLogs = opts?.foldLogs !== false;
  const stages: string[] = [];
  let current = ansiStripped;

  const term = emulateTerminal(ansiStripped, codeProtected, strippedAnsi);
  if (term.changed) {
    current = term.text;
    if (term.strippedAnsi) stages.push('ansi');
    if (term.strippedCr) stages.push('cr');
    if (!term.strippedAnsi && !term.strippedCr) stages.push('ws');
  }

  if (!codeProtected) {
    const structured = encodeStructuredJson(current, opts?.aggressiveToon === true);
    if (structured !== null) {
      current = structured.text;
      stages.push(structured.stage);
    } else if (foldLogs) {
      const folded = foldRepetitiveLogs(current);
      if (folded !== null) {
        current = folded;
        stages.push('log_fold');
      }
    }
  }

  if (current === text || current.length >= text.length) {
    return { text, changed: false, stages: [] };
  }
  return { text: current, changed: true, stages };
}

/**
 * Clean a single tool-output / observation string deterministically.
 * Guaranteed pure function `f(text)` → identical output on every turn.
 */
export function cleanToolOutput(text: string, opts?: TextHygieneOptions): TextHygieneResult {
  const core = cleanToolOutputCore(text, opts);
  if (!core.changed) {
    return { text: core.text, changed: false, savedChars: 0, savedTokens: 0, stages: [] };
  }
  return {
    text: core.text,
    changed: true,
    savedChars: text.length - core.text.length,
    savedTokens: estimateTokensSaved(text, core.text),
    stages: core.stages,
  };
}

function emptyWireStats(): WireHygieneStats {
  return { changed: false, savedChars: 0, savedTokens: 0, blocks: 0, stages: [] };
}

interface StaticTextSlot {
  readonly get: () => string;
  readonly set: (next: string) => void;
}

const DYNAMIC_SYSTEM_MARKER_RE = /<(?:env|context|system-reminder|fast_mode_info|git_status)\b/i;

function runWireTextEngine(args: {
  tools?: unknown[];
  wire: ToolSchemaWire;
  staticSlots: readonly StaticTextSlot[];
  toolSlots: readonly TextEpochBlock[];
  totalMessages: number;
  rawReq: unknown;
  opts?: TextHygieneOptions;
}): WireHygieneStats {
  const { tools, wire, staticSlots, toolSlots, totalMessages, opts } = args;
  const effectiveOpts: TextHygieneOptions | undefined = opts?.aggressiveToon !== undefined
    ? opts
    : { ...opts, aggressiveToon: resolveTextHygieneMode(undefined) === 'on' };
  let staticSavedChars = 0;
  let staticSavedTokens = 0;
  let staticBlocks = 0;
  const stages = new Set<string>();
  let cliffAvoided: { at: number; multiplier: number; savedUsd: number } | undefined;

  if (effectiveOpts?.deepTextCompact) {
    const schemaRes = compileToolSchemas(tools, wire);
    if (schemaRes.changed) {
      staticSavedChars += schemaRes.savedChars;
      staticSavedTokens += schemaRes.savedTokens;
      staticBlocks += 1;
      stages.add('tscg');
    }
    for (const sSlot of staticSlots) {
      const raw = sSlot.get();
      if (DYNAMIC_SYSTEM_MARKER_RE.test(raw)) continue;
      const staticRes = compileStaticText(raw);
      if (staticRes.changed) {
        sSlot.set(staticRes.text);
        staticSavedChars += staticRes.savedChars;
        staticSavedTokens += staticRes.savedTokens;
        staticBlocks += 1;
        stages.add('tscg');
      }
    }
  }

  const origToolTexts = toolSlots.map((s) => s.getText());
  const slotStages: string[][] = toolSlots.map(() => []);
  let stage2SavedChars = staticSavedChars;

  // Stage 2: per-block deterministic cleaning (ANSI / CR / WS / TOON / JSON / log folding)
  for (let i = 0; i < toolSlots.length; i++) {
    const tSlot = toolSlots[i]!;
    const cur = origToolTexts[i]!;
    const cleaned = cleanToolOutputCore(cur, effectiveOpts);
    if (cleaned.changed) {
      tSlot.setText(cleaned.text);
      stage2SavedChars += cur.length - cleaned.text.length;
      for (const s of cleaned.stages) slotStages[i]!.push(s);
    }
  }

  // Stage 3: ACDC frozen-epoch digestion runs BEFORE CASI so CASI never indexes a block
  // that becomes an epoch digest (and never creates circular live-tail references to digests).
  if (effectiveOpts?.deepTextCompact && toolSlots.length > 0 && totalMessages > 6) {
    let remainingChars = 0;
    if (effectiveOpts.rawBodyBytes && effectiveOpts.rawBodyBytes > 0) {
      remainingChars = Math.max(
        0,
        effectiveOpts.rawBodyBytes - (effectiveOpts.nativeImageBytes ?? 0) - stage2SavedChars,
      );
    } else {
      for (const slot of toolSlots) remainingChars += slot.getText().length;
    }
    const beforeEpochTexts = toolSlots.map((s) => s.getText());
    const epochRes = planAndApplyTextEpochs({
      blocks: toolSlots,
      totalMessages,
      model: effectiveOpts.model,
      totalPromptTokens: Math.ceil(remainingChars / 3.5),
      expectedOutputTokens: effectiveOpts.expectedOutputTokens,
      ttlSec: effectiveOpts.ttlSec,
    });
    if (epochRes.changed) {
      for (let i = 0; i < toolSlots.length; i++) {
        if (toolSlots[i]!.getText() !== beforeEpochTexts[i]!) {
          slotStages[i]!.push('acdc_epoch');
        }
      }
      if (epochRes.cliffAvoided) cliffAvoided = epochRes.cliffAvoided;
    }
  }

  // Stage 4: CASI cross-turn deduplication / delta encoding on remaining verbatim blocks only.
  // Strictly monotonic over 0..k-1 (no sliding optical-collapse cutoff) so a block never
  // flaps verbatim <-> delta across turns.
  const casi = effectiveOpts?.enableCasi === false ? undefined : createCasiIndex();
  if (casi) {
    for (let i = 0; i < toolSlots.length; i++) {
      const tSlot = toolSlots[i]!;
      const cur = tSlot.getText();
      if (
        cur.startsWith('[fiche epoch-digest') ||
        cur.startsWith('[inkling epoch-digest') ||
        cur.startsWith('[fiche cas') ||
        cur.startsWith('[inkling cas')
      ) {
        continue;
      }
      const casiRes = casi.ingest(cur, tSlot.refId, tSlot.msgIndex);
      if (casiRes.changed) {
        tSlot.setText(casiRes.text);
        slotStages[i]!.push(casiRes.kind === 'exact_dup' ? 'casi_dup' : 'casi_delta');
      }
    }
  }

  let savedChars = staticSavedChars;
  let savedTokens = staticSavedTokens;
  let blocks = staticBlocks;
  let changed = staticBlocks > 0;

  for (let i = 0; i < toolSlots.length; i++) {
    const orig = origToolTexts[i]!;
    const final = toolSlots[i]!.getText();
    if (final !== orig && final.length < orig.length) {
      changed = true;
      savedChars += orig.length - final.length;
      savedTokens += estimateTokensSaved(orig, final);
      blocks += 1;
      for (const s of slotStages[i]!) stages.add(s);
    } else if (final !== orig) {
      // Revert if combined transforms somehow didn't shorten the block.
      toolSlots[i]!.setText(orig);
    }
  }

  if (!changed) return emptyWireStats();
  return {
    changed: true,
    savedChars,
    savedTokens,
    blocks,
    stages: [...stages],
    ...(cliffAvoided ? { cliffAvoided } : {}),
  };
}

/** Clean Anthropic `messages[].content[].type==='tool_result'` (+ TSCG/CASI/ACDC when enabled) in place. */
export function applyAnthropicTextHygiene(
  req: { system?: unknown; tools?: unknown[]; messages?: unknown[] },
  opts?: TextHygieneOptions,
): WireHygieneStats {
  const staticSlots: StaticTextSlot[] = [];
  if (typeof req.system === 'string') {
    staticSlots.push({
      get: () => req.system as string,
      set: (next: string) => {
        req.system = next;
      },
    });
  } else if (Array.isArray(req.system)) {
    for (const rawBlk of req.system) {
      if (!rawBlk || typeof rawBlk !== 'object') continue;
      const blk = rawBlk as { type?: unknown; text?: unknown };
      if (blk.type === 'text' && typeof blk.text === 'string') {
        staticSlots.push({
          get: () => blk.text as string,
          set: (next: string) => {
            blk.text = next;
          },
        });
      }
    }
  }

  const toolSlots: TextEpochBlock[] = [];
  const messages = Array.isArray(req.messages) ? req.messages : [];
  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const rawMsg = messages[mIdx];
    if (!rawMsg || typeof rawMsg !== 'object') continue;
    const msg = rawMsg as { content?: unknown };
    if (!Array.isArray(msg.content)) continue;
    for (let bIdx = 0; bIdx < msg.content.length; bIdx++) {
      const rawBlk = msg.content[bIdx];
      if (!rawBlk || typeof rawBlk !== 'object') continue;
      const blk = rawBlk as { type?: unknown; tool_use_id?: unknown; content?: unknown };
      if (blk.type !== 'tool_result') continue;
      const baseRef = typeof blk.tool_use_id === 'string' && blk.tool_use_id ? blk.tool_use_id : `tr_${mIdx}_${bIdx}`;
      if (typeof blk.content === 'string') {
        toolSlots.push({
          msgIndex: mIdx,
          refId: baseRef,
          getText: () => blk.content as string,
          setText: (next: string) => {
            blk.content = next;
          },
        });
      } else if (Array.isArray(blk.content)) {
        for (let pIdx = 0; pIdx < blk.content.length; pIdx++) {
          const rawPart = blk.content[pIdx];
          if (!rawPart || typeof rawPart !== 'object') continue;
          const part = rawPart as { type?: unknown; text?: unknown };
          if (part.type === 'text' && typeof part.text === 'string') {
            toolSlots.push({
              msgIndex: mIdx,
              refId: `${baseRef}#${pIdx}`,
              getText: () => part.text as string,
              setText: (next: string) => {
                part.text = next;
              },
            });
          }
        }
      }
    }
  }

  if (toolSlots.length === 0 && staticSlots.length === 0 && !Array.isArray(req.tools)) {
    return emptyWireStats();
  }
  return runWireTextEngine({
    tools: Array.isArray(req.tools) ? req.tools : undefined,
    wire: 'anthropic',
    staticSlots,
    toolSlots,
    totalMessages: messages.length,
    rawReq: req,
    opts,
  });
}

/** Clean OpenAI Chat Completions `role==='tool'` (+ TSCG/CASI/ACDC when enabled) in place. */
export function applyOpenAIChatTextHygiene(
  req: { tools?: unknown[]; messages?: unknown[] },
  opts?: TextHygieneOptions,
): WireHygieneStats {
  const staticSlots: StaticTextSlot[] = [];
  const toolSlots: TextEpochBlock[] = [];
  const messages = Array.isArray(req.messages) ? req.messages : [];
  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const rawMsg = messages[mIdx];
    if (!rawMsg || typeof rawMsg !== 'object') continue;
    const msg = rawMsg as { role?: unknown; tool_call_id?: unknown; content?: unknown };
    if (msg.role === 'system' || msg.role === 'developer') {
      if (typeof msg.content === 'string') {
        staticSlots.push({
          get: () => msg.content as string,
          set: (next: string) => {
            msg.content = next;
          },
        });
      } else if (Array.isArray(msg.content)) {
        for (const rawPart of msg.content) {
          if (!rawPart || typeof rawPart !== 'object') continue;
          const part = rawPart as { type?: unknown; text?: unknown };
          if (typeof part.text === 'string' && (part.type === 'text' || part.type === 'input_text')) {
            staticSlots.push({
              get: () => part.text as string,
              set: (next: string) => {
                part.text = next;
              },
            });
          }
        }
      }
      continue;
    }
    if (msg.role !== 'tool') continue;
    const baseRef = typeof msg.tool_call_id === 'string' && msg.tool_call_id ? msg.tool_call_id : `tool_${mIdx}`;
    if (typeof msg.content === 'string') {
      toolSlots.push({
        msgIndex: mIdx,
        refId: baseRef,
        getText: () => msg.content as string,
        setText: (next: string) => {
          msg.content = next;
        },
      });
    } else if (Array.isArray(msg.content)) {
      for (let pIdx = 0; pIdx < msg.content.length; pIdx++) {
        const rawPart = msg.content[pIdx];
        if (!rawPart || typeof rawPart !== 'object') continue;
        const part = rawPart as { type?: unknown; text?: unknown };
        if (typeof part.text === 'string' && (part.type === 'text' || part.type === 'input_text')) {
          toolSlots.push({
            msgIndex: mIdx,
            refId: `${baseRef}#${pIdx}`,
            getText: () => part.text as string,
            setText: (next: string) => {
              part.text = next;
            },
          });
        }
      }
    }
  }

  if (toolSlots.length === 0 && staticSlots.length === 0 && !Array.isArray(req.tools)) {
    return emptyWireStats();
  }
  return runWireTextEngine({
    tools: Array.isArray(req.tools) ? req.tools : undefined,
    wire: 'openai_chat',
    staticSlots,
    toolSlots,
    totalMessages: messages.length,
    rawReq: req,
    opts,
  });
}

/** Clean OpenAI Responses `function_call_output` / `custom_tool_call_output` (+ TSCG/CASI/ACDC when enabled) in place. */
export function applyOpenAIResponsesTextHygiene(
  req: { instructions?: unknown; tools?: unknown[]; input?: unknown },
  opts?: TextHygieneOptions,
): WireHygieneStats {
  const staticSlots: StaticTextSlot[] = [];
  if (typeof req.instructions === 'string') {
    staticSlots.push({
      get: () => req.instructions as string,
      set: (next: string) => {
        req.instructions = next;
      },
    });
  }

  const toolSlots: TextEpochBlock[] = [];
  const items = Array.isArray(req.input) ? req.input : [];
  let leadingStatic = true;
  for (let iIdx = 0; iIdx < items.length; iIdx++) {
    const rawItem = items[iIdx];
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as { type?: unknown; role?: unknown; call_id?: unknown; content?: unknown; output?: unknown };
    if (leadingStatic && (item.role === 'system' || item.role === 'developer')) {
      if (typeof item.content === 'string') {
        staticSlots.push({
          get: () => item.content as string,
          set: (next: string) => {
            item.content = next;
          },
        });
      } else if (Array.isArray(item.content)) {
        for (const rawPart of item.content) {
          if (!rawPart || typeof rawPart !== 'object') continue;
          const part = rawPart as { type?: unknown; text?: unknown };
          if (typeof part.text === 'string' && (part.type === 'input_text' || part.type === 'text')) {
            staticSlots.push({
              get: () => part.text as string,
              set: (next: string) => {
                part.text = next;
              },
            });
          }
        }
      }
      continue;
    }
    leadingStatic = false;
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') continue;
    const baseRef = typeof item.call_id === 'string' && item.call_id ? item.call_id : `out_${iIdx}`;
    if (typeof item.output === 'string') {
      toolSlots.push({
        msgIndex: iIdx,
        refId: baseRef,
        getText: () => item.output as string,
        setText: (next: string) => {
          item.output = next;
        },
      });
    } else if (Array.isArray(item.output)) {
      for (let pIdx = 0; pIdx < item.output.length; pIdx++) {
        const rawPart = item.output[pIdx];
        if (!rawPart || typeof rawPart !== 'object') continue;
        const part = rawPart as { type?: unknown; text?: unknown };
        if (typeof part.text === 'string' && (part.type === 'input_text' || part.type === 'text' || part.type === 'output_text')) {
          toolSlots.push({
            msgIndex: iIdx,
            refId: `${baseRef}#${pIdx}`,
            getText: () => part.text as string,
            setText: (next: string) => {
              part.text = next;
            },
          });
        }
      }
    }
  }

  if (toolSlots.length === 0 && staticSlots.length === 0 && !Array.isArray(req.tools)) {
    return emptyWireStats();
  }
  return runWireTextEngine({
    tools: Array.isArray(req.tools) ? req.tools : undefined,
    wire: 'openai_responses',
    staticSlots,
    toolSlots,
    totalMessages: items.length,
    rawReq: req,
    opts,
  });
}

const GOOGLE_RESPONSE_TEXT_KEYS = [
  'content',
  'output',
  'result',
  'stdout',
  'stderr',
  'error',
  'text',
  'data',
  'value',
  'fileContent',
  'body',
] as const;

/** Clean Google / Antigravity `functionResponse.response` & `.parts` (+ TSCG/CASI/ACDC when enabled) in place. */
export function applyGoogleTextHygiene(
  req: { systemInstruction?: { parts?: unknown[] }; tools?: unknown[]; contents?: unknown[] },
  opts?: TextHygieneOptions,
): WireHygieneStats {
  const staticSlots: StaticTextSlot[] = [];
  if (req.systemInstruction && Array.isArray(req.systemInstruction.parts)) {
    for (const rawPart of req.systemInstruction.parts) {
      if (!rawPart || typeof rawPart !== 'object') continue;
      const part = rawPart as { text?: unknown };
      if (typeof part.text === 'string') {
        staticSlots.push({
          get: () => part.text as string,
          set: (next: string) => {
            part.text = next;
          },
        });
      }
    }
  }

  const toolSlots: TextEpochBlock[] = [];
  const contents = Array.isArray(req.contents) ? req.contents : [];
  for (let cIdx = 0; cIdx < contents.length; cIdx++) {
    const rawTurn = contents[cIdx];
    if (!rawTurn || typeof rawTurn !== 'object') continue;
    const turn = rawTurn as { parts?: unknown };
    if (!Array.isArray(turn.parts)) continue;
    for (let pIdx = 0; pIdx < turn.parts.length; pIdx++) {
      const rawPart = turn.parts[pIdx];
      if (!rawPart || typeof rawPart !== 'object') continue;
      const fr = (rawPart as { functionResponse?: unknown }).functionResponse;
      if (!fr || typeof fr !== 'object') continue;
      const frName = typeof (fr as { name?: unknown }).name === 'string' ? (fr as { name: string }).name : 'fn';
      const response = (fr as { response?: unknown }).response;
      if (response && typeof response === 'object' && !Array.isArray(response)) {
        const respObj = response as Record<string, unknown>;
        for (const k of GOOGLE_RESPONSE_TEXT_KEYS) {
          if (typeof respObj[k] === 'string') {
            toolSlots.push({
              msgIndex: cIdx,
              refId: `${frName}@${cIdx}.${pIdx}.${k}`,
              getText: () => respObj[k] as string,
              setText: (next: string) => {
                respObj[k] = next;
              },
            });
          }
        }
      }
      const frParts = (fr as { parts?: unknown }).parts;
      if (Array.isArray(frParts)) {
        for (let spIdx = 0; spIdx < frParts.length; spIdx++) {
          const rawSub = frParts[spIdx];
          if (!rawSub || typeof rawSub !== 'object') continue;
          const sub = rawSub as { text?: unknown };
          if (typeof sub.text === 'string') {
            toolSlots.push({
              msgIndex: cIdx,
              refId: `${frName}@${cIdx}.${pIdx}.p${spIdx}`,
              getText: () => sub.text as string,
              setText: (next: string) => {
                sub.text = next;
              },
            });
          }
        }
      }
    }
  }

  if (toolSlots.length === 0 && staticSlots.length === 0 && !Array.isArray(req.tools)) {
    return emptyWireStats();
  }
  return runWireTextEngine({
    tools: Array.isArray(req.tools) ? req.tools : undefined,
    wire: 'google',
    staticSlots,
    toolSlots,
    totalMessages: contents.length,
    rawReq: req,
    opts,
  });
}
