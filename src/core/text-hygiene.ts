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

import {
  computeHorizonPaybackLimit,
  computeTailHydration,
  foldMarkovianEpisodes,
  getGlobalMmuStore,
  hasAnyStickyMarkovEpisode,
  isFileReadToolName,
  linkSessionSkills,
  pruneLowDensityBlob,
  type PinnedSkillStore,
} from './context-mmu.js';
import { getAllowedModelBases } from './applicability.js';
import { readBrandEnv } from './env.js';
import { createCasiIndex } from './casi-delta.js';
import { getGlobalPrefixTape, INITIAL_PREFIX_HASH, tapeHash64Hex } from './prefix-tape.js';
import { gptTokenCount, hasLongUnbrokenBpeChunk } from './gpt-tokens.js';
import { resolvePriceRates } from './pricing.js';
import {
  compileSegmentedStaticText,
  compileToolSchemas,
  splitVolatileXmlIslands,
  type ToolSchemaWire,
} from './schema-compiler.js';
import {
  getPinnedSessionSkills,
  hasStage2SealKey,
  isSessionCacheCold,
  recordStage2SealKey,
  setPinnedSessionSkills,
} from './session-state.js';
import {
  planAndApplyTextEpochs,
  type CacheBreakpointMarker,
  type TextEpochBlock,
} from './text-history.js';
import { encodeToon } from './toon.js';

export { isFileReadToolName };

export type TextHygieneMode = 'auto' | 'on' | 'off';

export interface TextHygieneOptions {
  /** Tool name associated with a single-block cleanToolOutput call (used for editSafe file-read protection). */
  toolName?: string;
  /** Whether to run Stage 1 TSCG static/schema compilation when `deepTextCompact` is enabled (default true). */
  enableTscg?: boolean;
  /** Whether to run Stage 2 TOON encoding on tabular JSON (default true). */
  enableToon?: boolean;
  /** Whether to run Stage 3 ACDC frozen-epoch history compaction when `deepTextCompact` is enabled (default true). */
  enableAcdc?: boolean;
  /** Whether to run Stage 3 Drain structural log folding (default true). */
  foldLogs?: boolean;
  /** Whether to run Stage 2 single-level JSON-in-JSON unwrapping (default true). */
  enableJsonUnwrap?: boolean;
  /** Whether to run P3 birth-time IDF density pruning on unstructured prose (default true). */
  enableDensityPrune?: boolean;
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
  /** Opt-in Stage 2 cleaning on bulky user payloads (>=1500 chars, non-code/diff, XML-safe). Default false. */
  cleanUserPayloads?: boolean;
  /** Optional session key pass-through for P2/P3 state integration. */
  sessionKey?: string;
  /** Optional first user turn text pass-through for P2/P3 state integration. */
  firstUserText?: string;
  /** Optional live-tail texts pass-through for P2/P3 state integration. */
  liveTailTexts?: readonly string[];
  /** Optional cold-cache indicator pass-through for P2/P3 state integration. */
  sessionCacheCold?: boolean;
  /** Optional LSM pass-through toggle for P2/P3 integration. */
  enableLsm?: boolean;
  /** Optional LSM edit-tail threshold pass-through for P2/P3 integration. */
  lsmEditTailMessages?: number;
  /** Optional MMU pass-through toggle for P2/P3 integration. */
  enableMmu?: boolean;
  /** Optional skill-linker pass-through toggle for P2/P3 integration. */
  enableSkillLinker?: boolean;
  /** Optional tail hydration callback for P2/P3 integration. */
  appendTailHydration?: (hydrationBlock: string) => void;
  /** Internal slot refId hint for Context-MMU density pruning page attribution. */
  refId?: string;
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
  readonly tailHydrated?: boolean;
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
  /^\s*(?:(?:(?:export(?:\s+default)?|pub(?:\([^)]*\))?|public|private|protected|internal|static|final|abstract|override|readonly|sealed|open|suspend|async)\s+){0,4}(?:function\s+\w+|class\s+\w+|interface\s+\w+|record\s+\w+|protocol\s+\w+|actor\s+\w+|extension\s+\w+|namespace\s+[\w.]+|type\s+\w+\s*(?:=|struct\b|interface\b)|enum\s+\w+|struct\s+\w+|trait\s+\w+|impl\b|fn\s+\w+|func\s+(?:\([^)]*\)\s*)?\w+|def\s+\w+|(?:const|let|var|val)\s+\w+\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\b|class\b|\{|\[)|import\s+(?:\{|\*|"|\(|\w)|from\s+\S+\s+import\b|package\s+[\w.]+|using\s+[\w.]+\s*;|#include\s*[<"]|template\s*<)|(?:public|private|protected|internal)\s+(?:static\s+)?(?:final\s+)?(?:async\s+)?[A-Za-z_][\w.<>,[\]?]*\s+[A-Za-z_]\w*\s*\()/;

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
  enableToon = true,
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
    if (enableToon) {
      const toon = encodeToon(parsed, minJsonBox);
      if (toon !== null && toon.length < text.length) {
        return { text: toon, stage: 'toon' };
      }
    }
    if (!hasNewline) return null;
    const min = minJsonBox.json ?? JSON.stringify(parsed);
    if (!min) return null;
    if (text.length - min.length < 120) return null;
    if (min.length > text.length * 0.85) return null;
    return { text: min, stage: 'json' };
  } catch {
    return null;
  }
}

const DIR_ENTRY_RE = /^((?:[MADRCU?!]{1,2}\s+)?)(?:\.\/)?((?:[A-Za-z0-9_@.~-]+\/)+)([A-Za-z0-9_@.~-]+\/?)$/;
const DIR_LEAF_RE = /^((?:[MADRCU?!]{1,2}\s+)?)[A-Za-z0-9_@.~-]+\.[A-Za-z0-9]{1,12}$/;

/**
 * Losslessly group repetitive directory/file-tree listings (`>= 12` entries, `>= 600` chars)
 * that share parent directories into `<dir>/: fileA, fileB, ...`. Preserves git status
 * prefixes per group and never triggers on code, diffs, logs, or prose.
 */
function compactDirectoryListing(text: string): string | null {
  if (text.length < 600 || text.length > MAX_HYGIENE_BLOCK_CHARS) return null;
  if (isJsonWrappedFast(text)) return null;
  const lines = text.split('\n');
  const nonEmpty: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (t) nonEmpty.push(t);
  }
  if (nonEmpty.length < 12) return null;

  let pathHits = 0;
  let slashHits = 0;
  type ParsedDirEntry = { kind: 'dir'; key: string; prefix: string; dir: string; leaf: string; raw: string };
  const parsed: Array<ParsedDirEntry | { kind: 'raw'; raw: string }> = [];

  for (const entry of nonEmpty) {
    if (
      /^(?:diff --git |@@ -\d|\*\*\* (?:Begin Patch|Update File|Add File))/.test(entry) ||
      STACK_PREFIX_RE.test(entry) ||
      entry.length > 260
    ) {
      return null;
    }
    const m = DIR_ENTRY_RE.exec(entry);
    if (m) {
      pathHits += 1;
      slashHits += 1;
      const prefix = m[1] ?? '';
      const dir = m[2]!.replace(/\/+$/, '');
      const leaf = m[3]!;
      parsed.push({ kind: 'dir', key: `${prefix}\0${dir}`, prefix, dir, leaf, raw: entry });
      continue;
    }
    if (DIR_LEAF_RE.test(entry)) {
      pathHits += 1;
    }
    parsed.push({ kind: 'raw', raw: entry });
  }

  if (pathHits / nonEmpty.length < 0.8 || slashHits / nonEmpty.length < 0.6) return null;

  const groupLeaves = new Map<string, { prefix: string; dir: string; leaves: string[] }>();
  for (const item of parsed) {
    if (item.kind !== 'dir') continue;
    let g = groupLeaves.get(item.key);
    if (!g) {
      g = { prefix: item.prefix, dir: item.dir, leaves: [] };
      groupLeaves.set(item.key, g);
    }
    g.leaves.push(item.leaf);
  }

  const emittedGroup = new Set<string>();
  const out: string[] = [];
  let hasGrouped = false;
  for (const item of parsed) {
    if (item.kind === 'raw') {
      out.push(item.raw);
      continue;
    }
    const g = groupLeaves.get(item.key)!;
    if (g.leaves.length < 2) {
      out.push(item.raw);
      continue;
    }
    if (emittedGroup.has(item.key)) continue;
    emittedGroup.add(item.key);
    hasGrouped = true;
    out.push(`${g.prefix}${g.dir}/: ${g.leaves.join(', ')}`);
  }

  if (!hasGrouped) return null;
  const candidate = out.join('\n');
  if (text.length - candidate.length < 150 || candidate.length > text.length * 0.82) {
    return null;
  }
  return candidate;
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
const LOG_RUNNER_RE = /^\s*(?:[✓✔]\s|(?:PASS|OK|RUN|Compiling|Downloading|Fetching|Resolving|Checking|Installing|Building|Bundling|Built|Transformed|Rendered)\b|\[\d+\/\d+\]\s|·+$)|(?:\.\.\.\s*ok\s*(?:\([^)\n]+\))?$|\bok\s+\S+\s+\d+(?:\.\d+)?(?:ms|s)\s*$)/;
const PASSING_PROGRESS_RE = /^\s*(?:[✓✔]\s|(?:PASS|Compiling|Downloading|Fetching|Resolving|Checking|Installing|Building|Bundling)\b|\[\d+\/\d+\]\s|·+$)|(?:\.\.\.\s*ok\s*(?:\([^)\n]+\))?$|\bok\s+\S+\s+\d+(?:\.\d+)?(?:ms|s)\s*$)/;
const FAIL_OR_SUMMARY_RE = /\b(?:error|err|warn|warning|fail|failed|failure|fatal|panic|exception|traceback|assertion|assert|denied|forbidden|timeout|timed out|refused|oom|killed|segfault|abort|aborted|skipped|summary|Tests?\s+\d|Test Files\s+\d)\b/i;

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

  // Pass B2: fold contiguous passing/progress runs (>= 8 lines: keep first 2 + last 2)
  // even when individual test names vary, while preserving every error/warning/summary line.
  const isPassingProgress = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const line = lines[i]!;
    if (PASSING_PROGRESS_RE.test(line) && !FAIL_OR_SUMMARY_RE.test(line)) {
      isPassingProgress[i] = 1;
    }
  }
  let pIdx = 0;
  while (pIdx < total) {
    if (!isPassingProgress[pIdx]) {
      pIdx++;
      continue;
    }
    const runIndices: number[] = [pIdx];
    let pEnd = pIdx + 1;
    while (pEnd < total && (isPassingProgress[pEnd] || templates[pEnd] === '<EMPTY>')) {
      if (isPassingProgress[pEnd]) runIndices.push(pEnd);
      pEnd++;
    }
    if (runIndices.length >= 8) {
      const keepHeadEnd = runIndices[1]!;
      const keepTailStart = runIndices[runIndices.length - 2]!;
      for (let k = keepHeadEnd + 1; k < keepTailStart; k++) {
        keep[k] = 0;
      }
    }
    pIdx = runIndices[runIndices.length - 1]! + 1;
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
      if (templates[i] !== '<EMPTY>') {
        foldedCount++;
      }
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

const NESTED_JSON_FIELDS = [
  'output',
  'stdout',
  'stderr',
  'content',
  'result',
  'body',
  'text',
  'data',
] as const;
const MAX_SEED_STRING_CHARS = 512_000;
const MIN_SEED_STRING_CHARS = 400;
const MIN_USER_CLEAN_CHARS = 1500;

function estimateTokenPairSameRegime(before: string, after: string): [number, number] {
  if (
    before.length <= TOKEN_EXACT_LIMIT_CHARS &&
    after.length <= TOKEN_EXACT_LIMIT_CHARS &&
    !hasLongUnbrokenBpeChunk(before) &&
    !hasLongUnbrokenBpeChunk(after)
  ) {
    return [gptTokenCount(before), gptTokenCount(after)];
  }
  return [Math.ceil(before.length / 3.5), Math.ceil(after.length / 3.5)];
}

function meetsUnwrapTokenGate(before: string, after: string): boolean {
  if (after.length >= before.length) return false;
  const [beforeTokens, afterTokens] = estimateTokenPairSameRegime(before, after);
  const savedTokens = beforeTokens - afterTokens;
  return savedTokens >= 40 && afterTokens <= beforeTokens * 0.85;
}

function countNewlinesAndQuotes(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 34) count++;
  }
  return count;
}

/**
 * Unwrap JSON tool envelopes that double-serialize inner JSON payloads or wrap
 * 1-2 heavily escaped multi-line string fields into `@toon` / `@fiche-kv` / clean JSON.
 * Keeps result only when net tokens drop by >=15% and >=40 tokens.
 */
const SHELL_TOOL_RE = /^(?:bash|sh|zsh|shell|run_command|exec)$/i;
const CONFIG_JSON_KEYS = new Set<string>([
  'compilerOptions',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'scripts',
  'workspaces',
]);

function looksLikeConfigFixture(innerParsed: unknown, rawInner: string, toolName?: string): boolean {
  if (!innerParsed || typeof innerParsed !== 'object' || Array.isArray(innerParsed)) return false;
  const isShell = typeof toolName === 'string' && SHELL_TOOL_RE.test(toolName.trim());
  const keys = Object.keys(innerParsed as Record<string, unknown>);
  const hasConfigKey = keys.some((k) => CONFIG_JSON_KEYS.has(k));
  if (!hasConfigKey) return false;
  return isShell || (rawInner.includes('\n') && rawInner.length >= 256);
}

export function unwrapNestedJsonStrings(
  text: string,
  opts?: { enableToon?: boolean; foldLogs?: boolean; toolName?: string },
): { text: string; stage: 'json_unwrap' | 'toon' } | null {
  if (typeof text !== 'string' || text.length < 256 || text.length > MAX_HYGIENE_BLOCK_CHARS) {
    return null;
  }
  let start = 0;
  let end = text.length;
  while (start < end && isAsciiWs(text.charCodeAt(start))) start++;
  while (end > start && isAsciiWs(text.charCodeAt(end - 1))) end--;
  if (end - start < 256) return null;
  if (text.charCodeAt(start) !== 123 || text.charCodeAt(end - 1) !== 125) return null;

  const trimmed = start === 0 && end === text.length ? text : text.slice(start, end);
  if (
    !trimmed.includes('\\"') &&
    !trimmed.includes('\\n') &&
    !trimmed.includes('\\u') &&
    !trimmed.includes('"[') &&
    !trimmed.includes('"{')
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  // Branch A: Long string field containing valid nested JSON object/array.
  let unwrappedObj: Record<string, unknown> | undefined;
  let unwrappedCount = 0;
  let singleUnwrappedKey: string | undefined;
  let singleInnerParsed: unknown;
  const unwrappedFields = new Set<string>();
  const unwrappedEntries: Array<[string, unknown]> = [];
  for (const field of NESTED_JSON_FIELDS) {
    const val = obj[field];
    if (typeof val !== 'string' || val.length < 256) continue;
    const innerTrim = val.trim();
    const first = innerTrim.charCodeAt(0);
    const last = innerTrim.charCodeAt(innerTrim.length - 1);
    if (!((first === 123 && last === 125) || (first === 91 && last === 93))) continue;
    let innerParsed: unknown;
    try {
      innerParsed = JSON.parse(innerTrim);
    } catch {
      continue;
    }
    if (!innerParsed || typeof innerParsed !== 'object') continue;
    if (looksLikeConfigFixture(innerParsed, val, opts?.toolName)) continue;
    if (!unwrappedObj) unwrappedObj = { ...obj };
    unwrappedObj[field] = innerParsed;
    unwrappedFields.add(field);
    unwrappedEntries.push([field, innerParsed]);
    unwrappedCount++;
    if (unwrappedCount === 1) {
      singleUnwrappedKey = field;
      singleInnerParsed = innerParsed;
    }
  }

  if (unwrappedObj && unwrappedCount > 0) {
    if (opts?.enableToon !== false) {
      const toonWhole = encodeToon(unwrappedObj);
      if (toonWhole !== null && meetsUnwrapTokenGate(text, toonWhole)) {
        return { text: toonWhole, stage: 'toon' };
      }
      if (unwrappedCount === 1 && singleUnwrappedKey && singleInnerParsed !== undefined) {
        const toonInner = encodeToon(singleInnerParsed);
        if (toonInner !== null) {
          const kvLines: string[] = ['@fiche-kv'];
          for (const k of Object.keys(obj)) {
            if (k === singleUnwrappedKey || obj[k] === undefined) continue;
            kvLines.push(`${k}: ${JSON.stringify(obj[k])}`);
          }
          kvLines.push(`--- ${singleUnwrappedKey} (json-string) ---`);
          kvLines.push(toonInner);
          const framed = kvLines.join('\n');
          if (meetsUnwrapTokenGate(text, framed)) {
            return { text: framed, stage: 'toon' };
          }
        }
      }
    }
    // Frame unwrapped string fields explicitly so the model never confuses string
    // fields with native objects when downstream JSON consumers parse strings.
    const kvLines: string[] = ['@fiche-kv'];
    for (const k of Object.keys(obj)) {
      if (unwrappedFields.has(k) || obj[k] === undefined) continue;
      kvLines.push(`${k}: ${JSON.stringify(obj[k])}`);
    }
    for (const [field, innerVal] of unwrappedEntries) {
      kvLines.push(`--- ${field} (json-string) ---`);
      try {
        kvLines.push(JSON.stringify(innerVal));
      } catch {
        kvLines.push(String(obj[field] ?? ''));
      }
    }
    const framed = kvLines.join('\n');
    if (meetsUnwrapTokenGate(text, framed)) {
      return { text: framed, stage: 'json_unwrap' };
    }
  }

  // Branch B: Small JSON envelope (<= 6 keys) wrapping 1-2 heavily escaped multi-line fields.
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (keys.length >= 1 && keys.length <= 6) {
    const heavyKeys: string[] = [];
    let totalEscapeWaste = 0;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v !== 'string') continue;
      if (countNewlinesAndQuotes(v) < 4) continue;
      const escapeWaste = JSON.stringify(v).length - 2 - v.length;
      heavyKeys.push(k);
      totalEscapeWaste += escapeWaste;
    }
    if (heavyKeys.length >= 1 && heavyKeys.length <= 2 && totalEscapeWaste >= 128) {
      const heavySet = new Set(heavyKeys);
      const outLines: string[] = ['@fiche-kv'];
      for (const k of keys) {
        if (heavySet.has(k)) continue;
        outLines.push(`${k}: ${JSON.stringify(obj[k])}`);
      }
      const foldLogs = opts?.foldLogs !== false;
      for (const k of heavyKeys) {
        const rawBody = obj[k] as string;
        const ansiStripped = stripAnsiSequences(rawBody);
        const bodyProtected = isCodeOrDiffProtected(ansiStripped);
        const term = emulateTerminal(ansiStripped, bodyProtected, ansiStripped !== rawBody);
        let bodyOut = term.text;
        if (!bodyProtected && foldLogs) {
          const folded = foldRepetitiveLogs(bodyOut);
          if (folded !== null) bodyOut = folded;
        }
        outLines.push(`--- ${k} ---`);
        outLines.push(bodyOut);
      }
      const candidate = outLines.join('\n');
      if (meetsUnwrapTokenGate(text, candidate)) {
        return { text: candidate, stage: 'json_unwrap' };
      }
    }
  }

  return null;
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
  const codeProtected = isFileReadToolName(opts?.toolName) || isCodeOrDiffProtected(ansiStripped);
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
    const unwrapped =
      opts?.enableJsonUnwrap !== false
        ? unwrapNestedJsonStrings(current, {
            enableToon: opts?.enableToon !== false,
            foldLogs,
            toolName: opts?.toolName,
          })
        : null;
    if (unwrapped !== null) {
      current = unwrapped.text;
      stages.push(unwrapped.stage);
    } else {
      const structured = encodeStructuredJson(
        current,
        opts?.aggressiveToon === true,
        opts?.enableToon !== false,
      );
      if (structured !== null) {
        current = structured.text;
        stages.push(structured.stage);
      } else {
        const dirTree = compactDirectoryListing(current);
        if (dirTree !== null) {
          current = dirTree;
          stages.push('dir_tree');
        } else {
          const folded = foldLogs ? foldRepetitiveLogs(current) : null;
          if (folded !== null) {
            current = folded;
            stages.push('log_fold');
          } else if (
            opts?.enableDensityPrune !== false &&
            opts?.enableMmu !== false &&
            (opts?.enableMmu === true || opts?.deepTextCompact === true) &&
            current.length >= 2400
          ) {
            const pruned = pruneLowDensityBlob(current, {
              store: getGlobalMmuStore(),
              sessionKey: opts?.sessionKey,
              refId: opts?.refId,
              toolName: opts?.toolName,
              minChars: 2400,
            });
            if (pruned.changed && pruned.text.length < current.length) {
              current = pruned.text;
              stages.push('density_prune');
            }
          }
        }
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

interface SeedBlock {
  readonly refId: string;
  readonly msgIndex: number;
  readonly text: string;
}

function collectSeedStrings(
  val: unknown,
  prefix: string,
  msgIndex: number,
  out: SeedBlock[],
  depth = 0,
): void {
  if (depth > 3 || val == null) return;
  if (typeof val === 'string') {
    if (val.length >= MIN_SEED_STRING_CHARS && val.length <= MAX_SEED_STRING_CHARS) {
      out.push({ refId: prefix, msgIndex, text: val });
    }
    return;
  }
  if (Array.isArray(val)) {
    const cap = Math.min(val.length, 32);
    for (let i = 0; i < cap; i++) {
      collectSeedStrings(val[i], `${prefix}[${i}]`, msgIndex, out, depth + 1);
    }
    return;
  }
  if (typeof val === 'object') {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      collectSeedStrings(v, `${prefix}.${k}`, msgIndex, out, depth + 1);
    }
  }
}

function collectSeedStringsFromJsonArg(
  rawArgs: string,
  prefix: string,
  msgIndex: number,
  out: SeedBlock[],
): void {
  if (rawArgs.length < MIN_SEED_STRING_CHARS || rawArgs.length > MAX_SEED_STRING_CHARS) return;
  const trimmed = rawArgs.trim();
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    collectSeedStrings(parsed, prefix, msgIndex, out, 0);
  } catch {
    /* ignore malformed or partial tool-call arguments */
  }
}

function cleanUserBlockPreservingXml(
  raw: string,
  opts?: TextHygieneOptions,
): { text: string; changed: boolean; stages: string[] } {
  if (
    raw.length < MIN_USER_CLEAN_CHARS ||
    raw.includes('[End of rendered') ||
    isCodeOrDiffProtected(raw)
  ) {
    return { text: raw, changed: false, stages: [] };
  }
  const islands = splitVolatileXmlIslands(raw);
  if (islands.length === 0) return { text: raw, changed: false, stages: [] };
  // Enforce threshold strictly on non-volatile user payload content (never
  // inflated by volatile <system-reminder>/<context> islands), and restrict user
  // payloads to lossless ANSI/whitespace/bijective-@toon (never density pruning!).
  let nonVolatileLen = 0;
  for (const isl of islands) {
    if (!isl.volatile) nonVolatileLen += isl.text.length;
  }
  if (nonVolatileLen < MIN_USER_CLEAN_CHARS) {
    return { text: raw, changed: false, stages: [] };
  }
  const userOpts: TextHygieneOptions = {
    ...opts,
    toolName: undefined,
    enableDensityPrune: false,
    enableJsonUnwrap: false,
    foldLogs: false,
  };
  if (islands.every((isl) => !isl.volatile)) {
    return cleanToolOutputCore(raw, userOpts);
  }

  let anyChanged = false;
  const stageSet = new Set<string>();
  const outParts = islands.map((island) => {
    if (island.volatile || island.text.length < MIN_USER_CLEAN_CHARS || isCodeOrDiffProtected(island.text)) {
      return island.text;
    }
    const cleaned = cleanToolOutputCore(island.text, userOpts);
    if (!cleaned.changed) return island.text;
    const nextText =
      island.text.startsWith('\n') && !cleaned.text.startsWith('\n')
        ? `\n${cleaned.text}`
        : cleaned.text;
    if (nextText.length >= island.text.length) return island.text;
    anyChanged = true;
    for (const s of cleaned.stages) stageSet.add(s);
    return nextText;
  });

  if (!anyChanged) return { text: raw, changed: false, stages: [] };
  const joined = outParts.join('');
  if (joined.length >= raw.length) return { text: raw, changed: false, stages: [] };
  return { text: joined, changed: true, stages: [...stageSet] };
}

const SESSION_PINNED_SKILL_STORE: PinnedSkillStore = {
  get: (sessionKey, catalogHash) => getPinnedSessionSkills(sessionKey, catalogHash),
  set: (sessionKey, catalogHash, skills) => setPinnedSessionSkills(sessionKey, catalogHash, skills),
};

function estimateMessageBlockTokens(rawBlk: unknown): number {
  if (!rawBlk || typeof rawBlk !== 'object') return 0;
  const blk = rawBlk as Record<string, unknown>;
  if (typeof blk.text === 'string') return Math.ceil(blk.text.length / 3.5);
  if (typeof blk.thinking === 'string') return Math.ceil(blk.thinking.length / 3.5);
  if (typeof blk.content === 'string') return Math.ceil(blk.content.length / 3.5);
  if (Array.isArray(blk.content)) {
    let sum = 0;
    for (const part of blk.content) sum += estimateMessageBlockTokens(part);
    return sum;
  }
  if (blk.type === 'tool_use' && blk.input !== undefined) {
    try {
      return Math.ceil((JSON.stringify(blk.input)?.length ?? 0) / 3.5);
    } catch {
      return 0;
    }
  }
  return 0;
}

export function estimateMessageTokens(rawMsg: unknown): number {
  if (!rawMsg || typeof rawMsg !== 'object') return 0;
  const msg = rawMsg as { content?: unknown };
  if (typeof msg.content === 'string') return Math.ceil(msg.content.length / 3.5);
  if (!Array.isArray(msg.content)) return 0;
  let sum = 0;
  for (const blk of msg.content) sum += estimateMessageBlockTokens(blk);
  return sum;
}

export function markerTtlSeconds(cc: unknown): number | undefined {
  if (!cc || typeof cc !== 'object') return undefined;
  const ttl = (cc as { ttl?: unknown }).ttl;
  return ttl === '1h' ? 3600 : 300;
}

export function coveringBreakpointInfo(
  msgIndex: number,
  blockIndex: number,
  cacheBreakpoints: readonly CacheBreakpointMarker[] | undefined,
  msgTotalTokens: readonly number[] | undefined,
  totalMessages: number,
): { coveringTtlSec: number; downstreamTokens: number } {
  if (!cacheBreakpoints || cacheBreakpoints.length === 0) {
    return { coveringTtlSec: 0, downstreamTokens: 0 };
  }
  let coveringTtlSec = 0;
  let maxBpMsg = -1;
  for (const bp of cacheBreakpoints) {
    if (bp.msgIndex > msgIndex || (bp.msgIndex === msgIndex && bp.blockIndex >= blockIndex)) {
      if (bp.ttlSec > coveringTtlSec) coveringTtlSec = bp.ttlSec;
      if (bp.msgIndex > maxBpMsg) maxBpMsg = bp.msgIndex;
    }
  }
  if (coveringTtlSec === 0 || !msgTotalTokens || maxBpMsg < 0) {
    return { coveringTtlSec, downstreamTokens: 0 };
  }
  const limit = Math.min(msgTotalTokens.length - 1, Math.min(totalMessages - 1, maxBpMsg));
  let downstreamTokens = 0;
  for (let m = msgIndex + 1; m <= limit; m++) {
    downstreamTokens += msgTotalTokens[m] ?? 0;
  }
  return { coveringTtlSec, downstreamTokens };
}

function stage2RewritePaybackBlocked(
  orig: string,
  candidate: string,
  slot: TextEpochBlock,
  opts: TextHygieneOptions | undefined,
  cacheBreakpoints: readonly CacheBreakpointMarker[] | undefined,
  msgTotalTokens: readonly number[] | undefined,
  totalMessages: number,
): boolean {
  const { coveringTtlSec, downstreamTokens } = coveringBreakpointInfo(
    slot.msgIndex,
    slot.blockIndex ?? 0,
    cacheBreakpoints,
    msgTotalTokens,
    totalMessages,
  );
  if (coveringTtlSec <= 0 || downstreamTokens <= 0) return false;
  const actualSavedTok = estimateTokensSaved(orig, candidate);
  if (!(actualSavedTok > 0)) return true;
  const rawTok = Math.max(actualSavedTok + 1, Math.ceil(orig.length / 3.5));
  const keptTok = Math.max(1, rawTok - actualSavedTok);
  const rates = resolvePriceRates(opts?.model, { promptTokens: 0, ttlSec: coveringTtlSec });
  const savedPerRead = actualSavedTok * rates.read;
  if (!(savedPerRead > 0)) return true;
  const transitionCost =
    keptTok * rates.write -
    rawTok * rates.read +
    downstreamTokens * (rates.write - rates.read);
  const paybackReads = Math.ceil(Math.max(0, transitionCost) / savedPerRead);
  const maxAllowed = computeHorizonPaybackLimit({
    turnsObserved: Math.max(1, Math.floor(totalMessages / 2)),
    baseMaxPayback: coveringTtlSec >= 3600 ? 8 : 12,
    downstreamCachedTokens: downstreamTokens,
  });
  return paybackReads > maxAllowed;
}

/** Deterministic session seal key protecting optically rendered Responses tool outputs from re-mutation. */
export function buildOpticalToolSealKey(refId: string, rawText: string): string {
  return `oai_opt_tr:${refId}\0${rawText.length}:${tapeHash64Hex(rawText)}`;
}

function runWireTextEngine(args: {
  tools?: unknown[];
  wire: ToolSchemaWire;
  staticSlots: readonly StaticTextSlot[];
  toolSlots: readonly TextEpochBlock[];
  userSlots?: readonly TextEpochBlock[];
  seedBlocks?: readonly SeedBlock[];
  totalMessages: number;
  msgTotalTokens?: readonly number[];
  cacheBreakpoints?: readonly CacheBreakpointMarker[];
  rawReq: unknown;
  opts?: TextHygieneOptions;
}): WireHygieneStats {
  const { tools, wire, staticSlots, toolSlots: rawToolSlots, userSlots, seedBlocks, totalMessages, msgTotalTokens, cacheBreakpoints, opts } = args;
  const effectiveOpts: TextHygieneOptions | undefined = opts?.aggressiveToon !== undefined
    ? opts
    : { ...opts, aggressiveToon: resolveTextHygieneMode(undefined) === 'on' };
  const initialSessionKey = effectiveOpts?.sessionKey;
  const toolSlots = initialSessionKey
    ? rawToolSlots.filter((s) => !hasStage2SealKey(initialSessionKey, buildOpticalToolSealKey(s.refId, s.getText())))
    : rawToolSlots;
  let staticSavedChars = 0;
  let staticSavedTokens = 0;
  let staticBlocks = 0;
  const stages = new Set<string>();
  let cliffAvoided: { at: number; multiplier: number; savedUsd: number } | undefined;

  const sessionKey = effectiveOpts?.sessionKey;
  const mmuActive = Boolean(
    effectiveOpts?.deepTextCompact && effectiveOpts?.enableMmu !== false,
  );
  const mmuStore = mmuActive ? getGlobalMmuStore() : undefined;
  const sessionCold =
    effectiveOpts?.sessionCacheCold ??
    (sessionKey ? isSessionCacheCold(sessionKey, { model: effectiveOpts?.model }) : false);

  if (effectiveOpts?.deepTextCompact) {
    if (effectiveOpts.enableSkillLinker !== false && mmuStore && effectiveOpts.firstUserText) {
      for (const sSlot of staticSlots) {
        const raw = sSlot.get();
        const linked = linkSessionSkills({
          text: raw,
          firstUserText: effectiveOpts.firstUserText,
          sessionKey,
          store: mmuStore,
          pinnedStore: SESSION_PINNED_SKILL_STORE,
        });
        if (linked.changed && linked.text.length < raw.length && linked.savedTokens > 0) {
          sSlot.set(linked.text);
          staticSavedChars += linked.savedChars;
          staticSavedTokens += linked.savedTokens;
          staticBlocks += 1;
          stages.add('skill_linker');
        }
      }
    }

    if (effectiveOpts.enableTscg !== false) {
      const schemaRes = compileToolSchemas(tools, wire);
      if (schemaRes.changed) {
        staticSavedChars += schemaRes.savedChars;
        staticSavedTokens += schemaRes.savedTokens;
        staticBlocks += 1;
        stages.add('tscg');
        if (schemaRes.schemaDagFactored) stages.add('schema_dag');
      }
      for (const sSlot of staticSlots) {
        const raw = sSlot.get();
        const staticRes = compileSegmentedStaticText(raw);
        if (staticRes.changed) {
          sSlot.set(staticRes.text);
          staticSavedChars += staticRes.savedChars;
          staticSavedTokens += staticRes.savedTokens;
          staticBlocks += 1;
          stages.add('tscg');
        }
      }
    }
  }

  const tape = getGlobalPrefixTape();
  const stage2PolicyKey = [
    effectiveOpts?.enableToon !== false ? '1' : '0',
    effectiveOpts?.aggressiveToon === true ? '1' : '0',
    effectiveOpts?.foldLogs !== false ? '1' : '0',
    effectiveOpts?.enableJsonUnwrap !== false ? '1' : '0',
    effectiveOpts?.enableDensityPrune !== false ? '1' : '0',
    mmuActive ? '1' : '0',
    sessionKey ?? '',
  ].join('|');

  const origToolTexts = toolSlots.map((s) => s.getText());
  const slotStages: string[][] = toolSlots.map(() => []);
  let stage2SavedChars = staticSavedChars;

  // Stage 2: per-block deterministic cleaning (ANSI / CR / WS / JSON-unwrap / TOON / JSON / dir_tree / log / density prune).
  // Frontier-first + monotonic: a block compressed at the frontier seals into session state so it
  // replays bit-identically behind later cache_control breakpoints (zero self-bust), while an
  // unsealed mid-prefix block covered by a live breakpoint only mutates if rewrite payback beats horizon.
  for (let i = 0; i < toolSlots.length; i++) {
    const tSlot = toolSlots[i]!;
    const cur = origToolTexts[i]!;
    const stage2SlotSig = `${tSlot.refId}\0${cur.length}:${tapeHash64Hex(cur)}`;
    const alreadySealedStage2 = Boolean(sessionKey && hasStage2SealKey(sessionKey, stage2SlotSig));
    const allowDensityPrune = effectiveOpts?.enableDensityPrune !== false;
    const memoKey =
      cur.length >= 64 && cur.length <= MAX_HYGIENE_BLOCK_CHARS
        ? `${stage2PolicyKey}:${allowDensityPrune ? '1' : '0'}\0${tSlot.refId}\0${tSlot.toolName ?? ''}\0${cur.length}:${tapeHash64Hex(cur)}`
        : undefined;
    let cleaned = memoKey ? tape.getStage2(memoKey) : undefined;
    if (!cleaned) {
      const slotOpts: TextHygieneOptions = {
        ...effectiveOpts,
        enableDensityPrune: allowDensityPrune,
        refId: tSlot.refId,
        ...(tSlot.toolName ? { toolName: tSlot.toolName } : {}),
      };
      const fresh = cleanToolOutputCore(cur, slotOpts);
      cleaned = { text: fresh.text, changed: fresh.changed, stages: fresh.stages };
      if (memoKey) {
        tape.setStage2(memoKey, cleaned);
      }
    }
    if (!cleaned.changed || cleaned.text.length >= cur.length) continue;
    if (
      !alreadySealedStage2 &&
      !sessionCold &&
      stage2RewritePaybackBlocked(
        cur,
        cleaned.text,
        tSlot,
        effectiveOpts,
        cacheBreakpoints,
        msgTotalTokens,
        totalMessages,
      )
    ) {
      continue;
    }
    tSlot.setText(cleaned.text);
    if (sessionKey) recordStage2SealKey(sessionKey, stage2SlotSig);
    stage2SavedChars += cur.length - cleaned.text.length;
    for (const s of cleaned.stages) slotStages[i]!.push(s);
  }

  // Opt-in Stage 2 cleaning on bulky user payloads (>= 1500 chars, non-code/diff, XML-safe).
  const activeUserSlots = effectiveOpts?.cleanUserPayloads === true && userSlots ? userSlots : [];
  const origUserTexts = activeUserSlots.map((s) => s.getText());
  const userSlotStages: string[][] = activeUserSlots.map(() => []);
  for (let i = 0; i < activeUserSlots.length; i++) {
    const uSlot = activeUserSlots[i]!;
    const cur = origUserTexts[i]!;
    const cleaned = cleanUserBlockPreservingXml(cur, {
      ...effectiveOpts,
      refId: uSlot.refId,
    });
    if (cleaned.changed) {
      uSlot.setText(cleaned.text);
      stage2SavedChars += cur.length - cleaned.text.length;
      for (const s of cleaned.stages) userSlotStages[i]!.push(s);
    }
  }

  const estimateRemainingPromptTokens = (): number => {
    let remainingChars = 0;
    if (effectiveOpts?.rawBodyBytes && effectiveOpts.rawBodyBytes > 0) {
      remainingChars = Math.max(
        0,
        effectiveOpts.rawBodyBytes - (effectiveOpts.nativeImageBytes ?? 0) - stage2SavedChars,
      );
    } else {
      for (const slot of toolSlots) remainingChars += slot.getText().length;
    }
    return Math.ceil(remainingChars / 3.5);
  };

  // Stage 3a/3b: Prefix-Monotonic Interval Seal Lattice (PMISL) + Context-MMU.
  // First replay already-sealed sticky Stage 3a epochs and Stage 3b Markov
  // episodes to a monotonic fixpoint BEFORE either stage evaluates new candidates,
  // so an advancing Stage 3a window never overwrites a previously folded Markov
  // episode or vice-versa on warm turns. Keeps `preCompactTexts` for CASI seeding.
  const preCompactTexts = toolSlots.map((s) => s.getText());
  const lsmActive = effectiveOpts?.enableLsm !== false;
  const lsmTail = effectiveOpts?.lsmEditTailMessages ?? 2;
  const minMsgsForEpochs = lsmActive ? lsmTail + 2 : 6;
  const canRunEpochs =
    Boolean(effectiveOpts?.deepTextCompact) &&
    effectiveOpts?.enableAcdc !== false &&
    toolSlots.length > 0 &&
    totalMessages > minMsgsForEpochs;
  const canRunMarkov =
    Boolean(effectiveOpts?.deepTextCompact) &&
    mmuActive &&
    effectiveOpts?.enableAcdc !== false &&
    toolSlots.length >= 4 &&
    totalMessages > 6;
  const epochPageOut = mmuStore
    ? (block: { refId: string; toolName?: string }, raw: string, digest: string) => {
        const page = mmuStore.storePage({
          sessionKey,
          refId: block.refId,
          toolName: block.toolName,
          rawText: raw,
        });
        return mmuStore.getPage(page.id, sessionKey)
          ? mmuStore.formatPageCard(page, digest)
          : digest;
      }
    : undefined;

  const runStage3a = (stickyOnly: boolean): void => {
    if (!canRunEpochs || !effectiveOpts) return;
    const beforeEpochTexts = toolSlots.map((s) => s.getText());
    const epochRes = planAndApplyTextEpochs({
      blocks: toolSlots,
      totalMessages,
      model: effectiveOpts.model,
      totalPromptTokens: estimateRemainingPromptTokens(),
      expectedOutputTokens: effectiveOpts.expectedOutputTokens,
      ttlSec: effectiveOpts.ttlSec,
      msgTotalTokens,
      cacheBreakpoints,
      sessionKey,
      sessionCacheCold: sessionCold,
      enableLsm: lsmActive,
      lsmEditTailMessages: effectiveOpts.lsmEditTailMessages,
      stickyOnly,
      onPageOut: epochPageOut,
    });
    if (epochRes.changed) {
      for (let i = 0; i < toolSlots.length; i++) {
        const updated = toolSlots[i]!.getText();
        if (updated !== beforeEpochTexts[i]!) {
          slotStages[i]!.push('acdc_epoch');
          if (lsmActive) slotStages[i]!.push(sessionCold ? 'lsm_l2_cold' : 'lsm_l1');
          if (mmuStore) slotStages[i]!.push('mmu_page');
          stage2SavedChars += Math.max(0, beforeEpochTexts[i]!.length - updated.length);
        }
      }
      if (epochRes.cliffAvoided) cliffAvoided = epochRes.cliffAvoided;
    }
  };

  const runStage3b = (stickyOnly: boolean): boolean => {
    if (!canRunMarkov || !effectiveOpts) return false;
    const beforeMarkov = toolSlots.map((s) => s.getText());
    const markovRes = foldMarkovianEpisodes({
      blocks: toolSlots,
      totalMessages,
      keepTailMessages:
        effectiveOpts.lsmEditTailMessages !== undefined
          ? Math.max(effectiveOpts.lsmEditTailMessages, 4)
          : 4,
      sessionKey,
      model: effectiveOpts.model,
      sessionCacheCold: sessionCold,
      store: mmuStore,
      expectedOutputTokens: effectiveOpts.expectedOutputTokens,
      ttlSec: effectiveOpts.ttlSec,
      msgTotalTokens,
      cacheBreakpoints,
      totalPromptTokens: estimateRemainingPromptTokens(),
      stickyOnly,
    });
    if (markovRes.changed) {
      for (let i = 0; i < toolSlots.length; i++) {
        const updated = toolSlots[i]!.getText();
        if (updated !== beforeMarkov[i]!) {
          slotStages[i]!.push('markov_fold');
          stage2SavedChars += beforeMarkov[i]!.length - updated.length;
        }
      }
      return true;
    }
    return false;
  };

  if ((canRunEpochs || canRunMarkov) && hasAnyStickyMarkovEpisode(sessionKey)) {
    for (let pass = 0; pass < 8; pass++) {
      const passBefore = toolSlots.map((s) => s.getText());
      runStage3a(true);
      runStage3b(true);
      let passChanged = false;
      for (let i = 0; i < toolSlots.length; i++) {
        if (toolSlots[i]!.getText() !== passBefore[i]!) {
          passChanged = true;
          break;
        }
      }
      if (!passChanged) break;
    }
  }

  const sealSessionKey =
    sessionKey && sessionKey.length > 0 && (canRunEpochs || canRunMarkov) ? sessionKey : undefined;
  const sealSigs = sealSessionKey
    ? toolSlots.map(
        (s, i) => `${s.refId}\0${s.msgIndex}\0${preCompactTexts[i]!.length}:${tapeHash64Hex(preCompactTexts[i]!)}`,
      )
    : undefined;
  const replayedSeal = new Array<boolean>(toolSlots.length).fill(false);

  // Unified Prefix Seal Table fast replay for already-sealed session slots before fixpoint scan.
  if (sealSessionKey && sealSigs && tape.hasAnySessionSeals(sealSessionKey)) {
    for (let i = 0; i < toolSlots.length; i++) {
      const seal = tape.getSeal(sealSessionKey, sealSigs[i]!);
      if (!seal) continue;
      if (mmuStore) {
        const pgMatch = seal.text.match(/\[fiche vm-page (pg_[0-9a-f]+)/);
        if (pgMatch && !mmuStore.getPage(pgMatch[1]!, sealSessionKey)) {
          continue;
        }
      }
      const before = toolSlots[i]!.getText();
      if (before === seal.text) {
        replayedSeal[i] = true;
        continue;
      }
      toolSlots[i]!.setText(seal.text);
      for (const st of seal.stages) slotStages[i]!.push(st);
      stage2SavedChars += Math.max(0, before.length - seal.text.length);
      replayedSeal[i] = true;
    }
  }

  // Now seal newly eligible Stage 3a epochs and fold newly completed Stage 3b episodes.
  runStage3a(false);
  runStage3b(false);

  if (sealSessionKey && sealSigs) {
    for (let i = 0; i < toolSlots.length; i++) {
      if (replayedSeal[i]) continue;
      const curAfter = toolSlots[i]!.getText();
      const pre = preCompactTexts[i]!;
      if (curAfter === pre || curAfter.length >= pre.length) continue;
      const isMarkov = curAfter.startsWith('[fiche causal-episode') || curAfter.startsWith('[folded into ');
      const isEpoch =
        curAfter.startsWith('[fiche epoch-digest') ||
        curAfter.startsWith('[inkling epoch-digest') ||
        curAfter.startsWith('[fiche vm-page');
      if (!isMarkov && !isEpoch) continue;
      const sealStages = slotStages[i]!.filter(
        (s) => s === 'acdc_epoch' || s === 'lsm_l1' || s === 'lsm_l2_cold' || s === 'mmu_page' || s === 'markov_fold',
      );
      tape.setSeal(sealSessionKey, sealSigs[i]!, {
        text: curAfter,
        stages: sealStages,
        kind: isMarkov ? 'markov' : 'epoch',
        rawLen: pre.length,
      });
    }
  }

  // Stage 4: CASI cross-turn deduplication / delta / FastCDC slice encoding.
  // Never seeds compacted preCompactTexts (whose bodies are gone from the prompt),
  // and replays warm indexed bases via replayIndexedBase (128-cap, independent of seedHashes).
  const casi = effectiveOpts?.enableCasi === false ? undefined : createCasiIndex();
  if (casi) {
    const sortedSeeds =
      seedBlocks && seedBlocks.length > 0
        ? [...seedBlocks].sort((a, b) => a.msgIndex - b.msgIndex)
        : [];
    let seedCursor = 0;
    let seedPrefixHash = INITIAL_PREFIX_HASH;
    let prefixHash = INITIAL_PREFIX_HASH;
    const deferredBases: Array<{ kind: 'seed' | 'indexed'; text: string; refId: string; msgIndex: number }> = [];
    const flushDeferredBases = (): void => {
      if (deferredBases.length === 0) return;
      for (const base of deferredBases) {
        if (base.kind === 'seed') {
          casi.seedBase(base.text, base.refId, base.msgIndex);
        } else {
          casi.replayIndexedBase(base.text, base.refId, base.msgIndex);
        }
      }
      deferredBases.length = 0;
    };

    for (let i = 0; i < toolSlots.length; i++) {
      const tSlot = toolSlots[i]!;
      while (seedCursor < sortedSeeds.length && sortedSeeds[seedCursor]!.msgIndex < tSlot.msgIndex) {
        const seed = sortedSeeds[seedCursor++]!;
        seedPrefixHash = tape.advancePrefixHash(
          seedPrefixHash,
          `${seed.refId}\0${seed.msgIndex}\0${seed.text.length}:${tapeHash64Hex(seed.text)}`,
        );
        deferredBases.push({ kind: 'seed', text: seed.text, refId: seed.refId, msgIndex: seed.msgIndex });
      }
      const cur = tSlot.getText();
      if (
        cur.startsWith('[fiche epoch-digest') ||
        cur.startsWith('[inkling epoch-digest') ||
        cur.startsWith('[fiche vm-page') ||
        cur.startsWith('[fiche causal-episode') ||
        cur.startsWith('[folded into ') ||
        cur.startsWith('[fiche cas') ||
        cur.startsWith('[inkling cas')
      ) {
        prefixHash = tape.advancePrefixHash(
          prefixHash,
          `compact\0${tSlot.refId}\0${tSlot.msgIndex}\0${cur.length}:${tapeHash64Hex(cur)}`,
        );
        continue;
      }

      const curHash = tapeHash64Hex(cur);
      prefixHash = tape.advancePrefixHash(
        prefixHash,
        `${tSlot.refId}\0${tSlot.msgIndex}\0${cur.length}:${curHash}`,
      );
      const casiKey = `${seedPrefixHash}\0${prefixHash}\0${tSlot.refId}\0${tSlot.msgIndex}\0${cur.length}:${curHash}`;
      let memo = tape.getCasiMemo(casiKey);
      if (!memo) {
        flushDeferredBases();
        const casiRes = casi.ingest(cur, tSlot.refId, tSlot.msgIndex);
        memo = {
          text: casiRes.text,
          changed: casiRes.changed,
          kind: casiRes.kind ?? 'none',
        };
        tape.setCasiMemo(casiKey, memo);
      } else if (!memo.changed && cur.length >= 400) {
        deferredBases.push({ kind: 'indexed', text: cur, refId: tSlot.refId, msgIndex: tSlot.msgIndex });
      }

      if (memo.changed) {
        tSlot.setText(memo.text);
        slotStages[i]!.push(
          memo.kind === 'exact_dup'
            ? 'casi_dup'
            : memo.kind === 'slice'
              ? 'casi_slice'
              : 'casi_delta',
        );
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

  // Enforce per-slot shrinkage BEFORE Stage 5 tail hydration so appending
  // `[fiche vm-hydrate]` onto string-content user messages is never reverted.
  for (let i = 0; i < activeUserSlots.length; i++) {
    const orig = origUserTexts[i]!;
    const final = activeUserSlots[i]!.getText();
    if (final !== orig && final.length < orig.length) {
      changed = true;
      savedChars += orig.length - final.length;
      savedTokens += estimateTokensSaved(orig, final);
      blocks += 1;
      for (const s of userSlotStages[i]!) stages.add(s);
    } else if (final !== orig) {
      activeUserSlots[i]!.setText(orig);
    }
  }

  // Stage 5: Speculative Live-Tail Hydration (read-only over prefix; appends ONLY to trailing live turn).
  let tailHydrated = false;
  if (
    mmuStore &&
    effectiveOpts?.appendTailHydration &&
    effectiveOpts.liveTailTexts &&
    effectiveOpts.liveTailTexts.length > 0
  ) {
    const recentVerbatimTexts: string[] = [];
    for (const tSlot of toolSlots) {
      const t = tSlot.getText();
      if (
        !t.startsWith('[fiche ') &&
        !t.startsWith('[folded into ') &&
        !t.startsWith('[inkling ')
      ) {
        recentVerbatimTexts.push(t);
      }
    }
    if (userSlots) {
      for (const uSlot of userSlots) recentVerbatimTexts.push(uSlot.getText());
    }
    const hyd = computeTailHydration({
      store: mmuStore,
      sessionKey,
      liveTailTexts: effectiveOpts.liveTailTexts,
      recentVerbatimTexts,
    });
    if (hyd.changed && hyd.text) {
      effectiveOpts.appendTailHydration(hyd.text);
      stages.add('mmu_hydrate');
      tailHydrated = true;
    }
  }

  if (!changed && !tailHydrated) return emptyWireStats();
  return {
    changed,
    ...(tailHydrated ? { tailHydrated: true } : {}),
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
  const userSlots: TextEpochBlock[] = [];
  const seedBlocks: SeedBlock[] = [];
  const toolNameById = new Map<string, string>();
  const cacheBreakpoints: CacheBreakpointMarker[] = [];
  if (Array.isArray(req.tools)) {
    for (const rawTool of req.tools) {
      if (!rawTool || typeof rawTool !== 'object') continue;
      const ttl = markerTtlSeconds((rawTool as { cache_control?: unknown }).cache_control);
      if (ttl !== undefined) {
        cacheBreakpoints.push({ msgIndex: -1, blockIndex: 0, ttlSec: ttl });
      }
    }
  }
  if (Array.isArray(req.system)) {
    for (const rawBlk of req.system) {
      if (!rawBlk || typeof rawBlk !== 'object') continue;
      const ttl = markerTtlSeconds((rawBlk as { cache_control?: unknown }).cache_control);
      if (ttl !== undefined) {
        cacheBreakpoints.push({ msgIndex: -1, blockIndex: 0, ttlSec: ttl });
      }
    }
  }

  const messages = Array.isArray(req.messages) ? req.messages : [];
  const msgTotalTokens: number[] = new Array<number>(messages.length).fill(0);
  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const rawMsg = messages[mIdx];
    if (!rawMsg || typeof rawMsg !== 'object') continue;
    msgTotalTokens[mIdx] = estimateMessageTokens(rawMsg);
    const msg = rawMsg as { role?: unknown; content?: unknown; cache_control?: unknown };
    const msgTtl = markerTtlSeconds(msg.cache_control);
    if (msgTtl !== undefined) {
      cacheBreakpoints.push({ msgIndex: mIdx, blockIndex: Number.MAX_SAFE_INTEGER, ttlSec: msgTtl });
    }
    if (msg.role === 'user' && typeof msg.content === 'string') {
      userSlots.push({
        msgIndex: mIdx,
        blockIndex: 0,
        refId: `user_${mIdx}`,
        getText: () => msg.content as string,
        setText: (next: string) => {
          msg.content = next;
        },
      });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (let bIdx = 0; bIdx < msg.content.length; bIdx++) {
      const rawBlk = msg.content[bIdx];
      if (!rawBlk || typeof rawBlk !== 'object') continue;
      const blk = rawBlk as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
        text?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
        cache_control?: unknown;
      };
      const blkTtl = markerTtlSeconds(blk.cache_control);
      if (blkTtl !== undefined) {
        cacheBreakpoints.push({ msgIndex: mIdx, blockIndex: bIdx, ttlSec: blkTtl });
      }
      if (blk.type === 'tool_use') {
        if (typeof blk.id === 'string' && typeof blk.name === 'string') {
          toolNameById.set(blk.id, blk.name);
        }
        const seedPrefix =
          typeof blk.id === 'string' && blk.id ? `${blk.id}:in` : `tu_${mIdx}_${bIdx}:in`;
        collectSeedStrings(blk.input, seedPrefix, mIdx, seedBlocks);
        continue;
      }
      if (msg.role === 'user' && blk.type === 'text' && typeof blk.text === 'string') {
        userSlots.push({
          msgIndex: mIdx,
          blockIndex: bIdx,
          refId: `user_${mIdx}_${bIdx}`,
          getText: () => blk.text as string,
          setText: (next: string) => {
            blk.text = next;
          },
        });
        continue;
      }
      if (blk.type !== 'tool_result') continue;
      const toolName = typeof blk.tool_use_id === 'string' ? toolNameById.get(blk.tool_use_id) : undefined;
      const baseRef = typeof blk.tool_use_id === 'string' && blk.tool_use_id ? blk.tool_use_id : `tr_${mIdx}_${bIdx}`;
      if (typeof blk.content === 'string') {
        toolSlots.push({
          msgIndex: mIdx,
          blockIndex: bIdx,
          refId: baseRef,
          toolName,
          getText: () => blk.content as string,
          setText: (next: string) => {
            blk.content = next;
          },
        });
      } else if (Array.isArray(blk.content)) {
        for (let pIdx = 0; pIdx < blk.content.length; pIdx++) {
          const rawPart = blk.content[pIdx];
          if (!rawPart || typeof rawPart !== 'object') continue;
          const part = rawPart as { type?: unknown; text?: unknown; cache_control?: unknown };
          const partTtl = markerTtlSeconds(part.cache_control);
          if (partTtl !== undefined) {
            cacheBreakpoints.push({ msgIndex: mIdx, blockIndex: bIdx, ttlSec: partTtl });
          }
          if (part.type === 'text' && typeof part.text === 'string') {
            toolSlots.push({
              msgIndex: mIdx,
              blockIndex: bIdx,
              refId: `${baseRef}#${pIdx}`,
              toolName,
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

  if (
    toolSlots.length === 0 &&
    userSlots.length === 0 &&
    staticSlots.length === 0 &&
    !Array.isArray(req.tools)
  ) {
    return emptyWireStats();
  }
  return runWireTextEngine({
    tools: Array.isArray(req.tools) ? req.tools : undefined,
    wire: 'anthropic',
    staticSlots,
    toolSlots,
    userSlots,
    seedBlocks,
    totalMessages: messages.length,
    msgTotalTokens,
    cacheBreakpoints,
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
  const userSlots: TextEpochBlock[] = [];
  const seedBlocks: SeedBlock[] = [];
  const toolNameById = new Map<string, string>();
  const messages = Array.isArray(req.messages) ? req.messages : [];
  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const rawMsg = messages[mIdx];
    if (!rawMsg || typeof rawMsg !== 'object') continue;
    const msg = rawMsg as { role?: unknown; name?: unknown; tool_call_id?: unknown; tool_calls?: unknown; content?: unknown };
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (let tcIdx = 0; tcIdx < msg.tool_calls.length; tcIdx++) {
        const rawTc = msg.tool_calls[tcIdx];
        if (!rawTc || typeof rawTc !== 'object') continue;
        const tc = rawTc as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        if (typeof tc.id === 'string' && typeof tc.function?.name === 'string') {
          toolNameById.set(tc.id, tc.function.name);
        }
        const seedPrefix =
          typeof tc.id === 'string' && tc.id ? `${tc.id}:in` : `tc_${mIdx}_${tcIdx}:in`;
        const fnArgs = tc.function?.arguments;
        if (typeof fnArgs === 'string') {
          collectSeedStringsFromJsonArg(fnArgs, seedPrefix, mIdx, seedBlocks);
        } else if (fnArgs && typeof fnArgs === 'object') {
          collectSeedStrings(fnArgs, seedPrefix, mIdx, seedBlocks);
        }
      }
      continue;
    }
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
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        userSlots.push({
          msgIndex: mIdx,
          refId: `user_${mIdx}`,
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
            userSlots.push({
              msgIndex: mIdx,
              refId: `user_${mIdx}_${pIdx}`,
              getText: () => part.text as string,
              setText: (next: string) => {
                part.text = next;
              },
            });
          }
        }
      }
      continue;
    }
    if (msg.role !== 'tool') continue;
    const toolName =
      typeof msg.name === 'string' && msg.name
        ? msg.name
        : typeof msg.tool_call_id === 'string'
          ? toolNameById.get(msg.tool_call_id)
          : undefined;
    const baseRef = typeof msg.tool_call_id === 'string' && msg.tool_call_id ? msg.tool_call_id : `tool_${mIdx}`;
    if (typeof msg.content === 'string') {
      toolSlots.push({
        msgIndex: mIdx,
        refId: baseRef,
        toolName,
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
            toolName,
            getText: () => part.text as string,
            setText: (next: string) => {
              part.text = next;
            },
          });
        }
      }
    }
  }

  if (
    toolSlots.length === 0 &&
    userSlots.length === 0 &&
    staticSlots.length === 0 &&
    !Array.isArray(req.tools)
  ) {
    return emptyWireStats();
  }
  return runWireTextEngine({
    tools: Array.isArray(req.tools) ? req.tools : undefined,
    wire: 'openai_chat',
    staticSlots,
    toolSlots,
    userSlots,
    seedBlocks,
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
  const userSlots: TextEpochBlock[] = [];
  const seedBlocks: SeedBlock[] = [];
  const toolNameById = new Map<string, string>();
  const items = Array.isArray(req.input) ? req.input : [];
  let leadingStatic = true;
  for (let iIdx = 0; iIdx < items.length; iIdx++) {
    const rawItem = items[iIdx];
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      role?: unknown;
      call_id?: unknown;
      arguments?: unknown;
      input?: unknown;
      content?: unknown;
      output?: unknown;
    };
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
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (typeof item.name === 'string') {
        if (typeof item.call_id === 'string' && item.call_id) toolNameById.set(item.call_id, item.name);
        if (typeof item.id === 'string' && item.id) toolNameById.set(item.id, item.name);
      }
      const callRef =
        typeof item.call_id === 'string' && item.call_id
          ? item.call_id
          : typeof item.id === 'string' && item.id
            ? item.id
            : `fc_${iIdx}`;
      if (typeof item.arguments === 'string') {
        collectSeedStringsFromJsonArg(item.arguments, `${callRef}:in`, iIdx, seedBlocks);
      } else if (item.arguments && typeof item.arguments === 'object') {
        collectSeedStrings(item.arguments, `${callRef}:in`, iIdx, seedBlocks);
      }
      if (typeof item.input === 'string' && item.input.length >= MIN_SEED_STRING_CHARS) {
        const beforeLen = seedBlocks.length;
        collectSeedStringsFromJsonArg(item.input, `${callRef}:in`, iIdx, seedBlocks);
        if (seedBlocks.length === beforeLen && item.input.length <= MAX_SEED_STRING_CHARS) {
          seedBlocks.push({ refId: `${callRef}:in`, msgIndex: iIdx, text: item.input });
        }
      } else if (item.input && typeof item.input === 'object') {
        collectSeedStrings(item.input, `${callRef}:in`, iIdx, seedBlocks);
      }
      continue;
    }
    if (item.role === 'user') {
      if (typeof item.content === 'string') {
        userSlots.push({
          msgIndex: iIdx,
          refId: `user_${iIdx}`,
          getText: () => item.content as string,
          setText: (next: string) => {
            item.content = next;
          },
        });
      } else if (Array.isArray(item.content)) {
        for (let pIdx = 0; pIdx < item.content.length; pIdx++) {
          const rawPart = item.content[pIdx];
          if (!rawPart || typeof rawPart !== 'object') continue;
          const part = rawPart as { type?: unknown; text?: unknown };
          if (typeof part.text === 'string' && (part.type === 'input_text' || part.type === 'text')) {
            userSlots.push({
              msgIndex: iIdx,
              refId: `user_${iIdx}_${pIdx}`,
              getText: () => part.text as string,
              setText: (next: string) => {
                part.text = next;
              },
            });
          }
        }
      }
      continue;
    }
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') continue;
    const toolName = typeof item.call_id === 'string' ? toolNameById.get(item.call_id) : undefined;
    const baseRef = typeof item.call_id === 'string' && item.call_id ? item.call_id : `out_${iIdx}`;
    if (typeof item.output === 'string') {
      toolSlots.push({
        msgIndex: iIdx,
        refId: baseRef,
        toolName,
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
            toolName,
            getText: () => part.text as string,
            setText: (next: string) => {
              part.text = next;
            },
          });
        }
      }
    }
  }

  if (
    toolSlots.length === 0 &&
    userSlots.length === 0 &&
    staticSlots.length === 0 &&
    !Array.isArray(req.tools)
  ) {
    return emptyWireStats();
  }
  return runWireTextEngine({
    tools: Array.isArray(req.tools) ? req.tools : undefined,
    wire: 'openai_responses',
    staticSlots,
    toolSlots,
    userSlots,
    seedBlocks,
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
  const userSlots: TextEpochBlock[] = [];
  const seedBlocks: SeedBlock[] = [];
  const contents = Array.isArray(req.contents) ? req.contents : [];
  for (let cIdx = 0; cIdx < contents.length; cIdx++) {
    const rawTurn = contents[cIdx];
    if (!rawTurn || typeof rawTurn !== 'object') continue;
    const turn = rawTurn as { role?: unknown; parts?: unknown };
    if (!Array.isArray(turn.parts)) continue;
    for (let pIdx = 0; pIdx < turn.parts.length; pIdx++) {
      const rawPart = turn.parts[pIdx];
      if (!rawPart || typeof rawPart !== 'object') continue;
      const fc = (rawPart as { functionCall?: unknown }).functionCall;
      if (fc && typeof fc === 'object') {
        const fcName = typeof (fc as { name?: unknown }).name === 'string' ? (fc as { name: string }).name : 'fn';
        collectSeedStrings((fc as { args?: unknown }).args, `${fcName}@${cIdx}.${pIdx}:in`, cIdx, seedBlocks);
      }
      const fr = (rawPart as { functionResponse?: unknown }).functionResponse;
      if (!fr || typeof fr !== 'object') {
        if (turn.role === 'user') {
          const partObj = rawPart as { text?: unknown };
          if (typeof partObj.text === 'string') {
            userSlots.push({
              msgIndex: cIdx,
              refId: `user_${cIdx}_${pIdx}`,
              getText: () => partObj.text as string,
              setText: (next: string) => {
                partObj.text = next;
              },
            });
          }
        }
        continue;
      }
      const rawFrName = typeof (fr as { name?: unknown }).name === 'string' ? (fr as { name: string }).name : undefined;
      const frName = rawFrName ?? 'fn';
      const response = (fr as { response?: unknown }).response;
      if (response && typeof response === 'object' && !Array.isArray(response)) {
        const respObj = response as Record<string, unknown>;
        for (const k of GOOGLE_RESPONSE_TEXT_KEYS) {
          if (typeof respObj[k] === 'string') {
            toolSlots.push({
              msgIndex: cIdx,
              refId: `${frName}@${cIdx}.${pIdx}.${k}`,
              toolName: rawFrName,
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
              toolName: rawFrName,
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

  if (
    toolSlots.length === 0 &&
    userSlots.length === 0 &&
    staticSlots.length === 0 &&
    !Array.isArray(req.tools)
  ) {
    return emptyWireStats();
  }
  return runWireTextEngine({
    tools: Array.isArray(req.tools) ? req.tools : undefined,
    wire: 'google',
    staticSlots,
    toolSlots,
    userSlots,
    seedBlocks,
    totalMessages: contents.length,
    rawReq: req,
    opts,
  });
}
