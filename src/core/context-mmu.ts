/**
 * Context-MMU: Virtual Context Memory engine for Fiche (Pure Core — zero `node:` imports).
 *
 * Five deterministic, prefix-cache-safe primitives:
 *  1. `ContextPageStore` + deterministic 64-bit FNV-1a page IDs (`pg_<12hex>`),
 *     bounded LRU eviction (`maxPages`, `maxBytes`), inverted symbol/basename index,
 *     and pluggable debounced persistence (`MmuPersistenceAdapter`).
 *  2. `extractSymbolSpans` + `inferFilePath` + `extractErrorAnchors`: O(N) line
 *     scanner across TS/JS, Python, Go, Rust, Swift, and Java with line-gutter stripping.
 *  3. `computeTailHydration`: read-only speculative live-tail hydration (`±15` lines)
 *     from paged-out pages without mutating cached prefixes.
 *  4. `foldMarkovianEpisodes`: Markovian causal episode folding at verified checkpoints
 *     (`git commit`, red -> green test passes, PR merge) gated by Kosha payback / cliff avoidance.
 *  5. `linkSessionSkills` & `pruneLowDensityBlob`: Turn-1 pinned skill stubbing with
 *     Turn-N auto-hydration, and `<3ms` birth-time information-density prose pruning.
 */

import { extractFactSheetTokens } from './factsheet.js';
import { gptTokenCount, hasLongUnbrokenBpeChunk } from './gpt-tokens.js';
import { resetGlobalPrefixTape } from './prefix-tape.js';
import { evaluateCliffAvoidance, resolvePriceRates } from './pricing.js';
import { hasAnyFoldedEpisodeId, hasFoldedEpisodeId, recordFoldedEpisodeId } from './session-state.js';
import type { TextEpochBlock } from './text-history.js';

// ---------------------------------------------------------------------------
// Constants & Shared Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PAGES = 512;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MIN_MMU_PAGES = 64;
const MAX_MMU_PAGES = 16_384;
const MIN_MMU_BYTES = 4 * 1024 * 1024;
const MAX_MMU_BYTES = 256 * 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 250;
const PERSIST_FORMAT = 1;
const PERSIST_MAX_IDLE_MS = 24 * 60 * 60 * 1000;
const TOKEN_EXACT_LIMIT = 32_000;
const STICKY_EPISODE_CAP = 1024;
const MAX_LINE_SCAN_CHARS = 512;
const MAX_DEREF_CHARS = 65_536;
const TLB_MAX_SESSIONS = 512;
const TLB_MAX_LEASES_PER_SESSION = 64;
const TLB_DEFAULT_COOLDOWN_TURNS = 3;
const TLB_OVERLAP_PAD_LINES = 4;
const EMPTY_I32 = new Int32Array(0);
const POW_HALF = Float64Array.from({ length: 32 }, (_, k) => Math.pow(0.5, k));

/**
 * Horizon-aware online compaction payback gate.
 * At the append frontier (`downstreamCachedTokens <= 0`), admits fast (`>= 16` reads).
 * Mid-prefix (`downstreamCachedTokens > 0`), scales conservatively with observed turns
 * so immature sessions do not pay heavy cache-write penalties prematurely.
 */
export function computeHorizonPaybackLimit(opts: {
  readonly turnsObserved: number;
  readonly baseMaxPayback: number;
  readonly downstreamCachedTokens: number;
}): number {
  if (opts.downstreamCachedTokens <= 0) {
    return Math.max(opts.baseMaxPayback, 16);
  }
  return Math.max(4, Math.min(opts.baseMaxPayback, Math.round(3 + opts.turnsObserved * 0.45)));
}

const TOKEN_CACHE_MAX = 2048;
const tokenCountCache = new Map<string, number>();

function countTokensFast(text: string): number {
  if (!text) return 0;
  if (text.length <= TOKEN_EXACT_LIMIT && !hasLongUnbrokenBpeChunk(text)) {
    const key = `${text.length}:${fnv64Hex(text)}`;
    const hit = tokenCountCache.get(key);
    if (hit !== undefined) return hit;
    const tok = gptTokenCount(text);
    if (tokenCountCache.size >= TOKEN_CACHE_MAX) {
      const oldest = tokenCountCache.keys().next().value;
      if (oldest !== undefined) tokenCountCache.delete(oldest);
    }
    tokenCountCache.set(key, tok);
    return tok;
  }
  return Math.ceil(text.length / 3.5);
}

/** Exact UTF-8 byte length in pure JS without allocating a buffer. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

// ---------------------------------------------------------------------------
// 1. Deterministic 64-bit FNV-1a Hashing & Page IDs
// ---------------------------------------------------------------------------

/**
 * Compute deterministic 64-bit FNV-1a digest as 16 lowercase hex chars.
 * Uses two 32-bit lanes with exact IEEE-754 safe integer carry arithmetic
 * (zero `node:crypto`, zero BigInt heap allocations).
 */
export function fnv64Hex(text: string): string {
  let hi = 0xcbf29ce4 >>> 0;
  let lo = 0x84222325 >>> 0;
  const step = (b: number): void => {
    lo = (lo ^ b) >>> 0;
    const prodLo = lo * 0x1b3; // max 2^32 * 435 < 2^41 (exact IEEE-754 double)
    const carry = Math.floor(prodLo / 0x100000000);
    hi = (Math.imul(hi, 0x1b3) + carry + ((lo & 0xffffff) << 8)) >>> 0;
    lo = prodLo >>> 0;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      step(c);
    } else if (c < 0x800) {
      step(0xc0 | (c >>> 6));
      step(0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        step(0xf0 | (cp >>> 18));
        step(0x80 | ((cp >>> 12) & 0x3f));
        step(0x80 | ((cp >>> 6) & 0x3f));
        step(0x80 | (cp & 0x3f));
        i += 1;
      } else {
        step(0xe0 | (c >>> 12));
        step(0x80 | ((c >>> 6) & 0x3f));
        step(0x80 | (c & 0x3f));
      }
    } else {
      step(0xe0 | (c >>> 12));
      step(0x80 | ((c >>> 6) & 0x3f));
      step(0x80 | (c & 0x3f));
    }
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** Deterministic Context-MMU page ID (`pg_<12hex>`) derived from 64-bit FNV-1a. */
export function pageIdForText(text: string): string {
  return `pg_${fnv64Hex(text).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// 2. Symbol, File-Path & Error-Anchor Extractor (O(N))
// ---------------------------------------------------------------------------

export type MmuSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'impl'
  | 'protocol'
  | 'actor'
  | 'module'
  | 'const'
  | 'error'
  | 'anchor';

export interface MmuSymbolSpan {
  readonly name: string;
  readonly kind: MmuSymbolKind;
  readonly startLine: number;
  readonly endLine: number;
}

const GUTTER_EXPLICIT_RE = /^(?:\s*\d{1,7}(?:\t|→|\s*[|\u2502](?:\s|$))|L\d{1,7}:\s)/;
const GUTTER_COLON_RE = /^\s*(\d{1,7}):\s?(.*)$/;
const CODE_KW_AFTER_COLON_RE =
  /^(?:export|import|async|function|class|interface|type|enum|struct|trait|impl|fn|func|def|pub|public|private|protected|internal|static|const|let|var|protocol|actor|package|from)\b/;

function detectColonGutterMode(lines: readonly string[]): boolean {
  let hits = 0;
  const limit = Math.min(lines.length, 40);
  for (let i = 0; i < limit; i++) {
    const m = GUTTER_COLON_RE.exec(lines[i]!.slice(0, 128));
    if (m && (CODE_KW_AFTER_COLON_RE.test(m[2]!) || /^\s*$/.test(m[2]!))) {
      hits += 1;
      if (hits >= 3) return true;
    }
  }
  return false;
}

function stripLineGutter(line: string, allowColonGutter: boolean): string {
  const m = GUTTER_EXPLICIT_RE.exec(line);
  if (m) return line.slice(m[0].length);
  if (allowColonGutter) {
    const cm = GUTTER_COLON_RE.exec(line);
    if (cm) return cm[2] ?? '';
  }
  return line;
}

const FILE_HEADER_PATTERNS: readonly RegExp[] = [
  /^diff --git a\/([^\s]+) b\/([^\s]+)/,
  /^\+\+\+ (?:b\/)?([^\s\t]+)/,
  /^--- (?:a\/)?([^\s\t]+)/,
  /^\*\*\* (?:Update|Add|Delete) File:\s*([^\s\r\n]+)/,
  /^(?:\/\/|#|\/\*|\*)\s*(?:file|path)\s*:\s*([^\s*]+(?:\.[A-Za-z0-9]{1,10}))/i,
  /^(?:File|Path)\s*:\s*["']?([^\s"']+\.[A-Za-z0-9]{1,10})["']?/i,
  /^File\s+"([^"\n]+)",\s*line\s+\d+/,
  /^<file\s+(?:path|name)=["']([^"'\n]+)["']/i,
  /^===\s*([^\s=]+\.[A-Za-z0-9]{1,10})\s*===$/,
  /^(?:\/\/|#)\s*((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10})\s*$/,
  /^["']?(?:file_?[pP]ath|path)["']?\s*:\s*["']([^"'\n]+\.[A-Za-z0-9]{1,10})["']/,
];

function cleanInferredPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let cleaned = raw.trim().replace(/^["']|["']$/g, '').replace(/[:,;]+$/, '');
  if (!cleaned || cleaned === '/dev/null' || cleaned.length > 260) return undefined;
  if (cleaned.startsWith('a/') || cleaned.startsWith('b/')) {
    cleaned = cleaned.slice(2);
  }
  if (!/[/.]/.test(cleaned) || /\s/.test(cleaned)) return undefined;
  return cleaned;
}

/** Infer a source file path from header lines or `refId` if present. */
export function inferFilePath(text: string, refId?: string): string | undefined {
  if (text) {
    const lines = text.split('\n');
    const limit = Math.min(lines.length, 15);
    const allowColon = detectColonGutterMode(lines);
    for (let i = 0; i < limit; i++) {
      const line = stripLineGutter(lines[i]!, allowColon).trim().slice(0, 260);
      if (!line) continue;
      for (let p = 0; p < FILE_HEADER_PATTERNS.length; p++) {
        const m = FILE_HEADER_PATTERNS[p]!.exec(line);
        if (!m) continue;
        const candidate = cleanInferredPath(m[2] ?? m[1]);
        if (candidate) return candidate;
      }
    }
  }
  if (refId) {
    const trimmedRef = refId.trim();
    if (/^(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,10}$/.test(trimmedRef)) {
      return trimmedRef;
    }
  }
  return undefined;
}

const MODIFIER_WORDS = new Set([
  'export',
  'default',
  'declare',
  'async',
  'abstract',
  'pub',
  'public',
  'private',
  'protected',
  'internal',
  'fileprivate',
  'open',
  'static',
  'final',
  'override',
  'readonly',
  'sealed',
  'unsafe',
  'mutating',
  'nonmutating',
  'synchronized',
  'native',
  'inline',
  'suspend',
  'extern',
]);

const CONTROL_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'catch',
  'with',
  'return',
  'throw',
  'await',
  'new',
  'typeof',
  'delete',
  'super',
  'this',
  'yield',
  'import',
  'from',
  'match',
]);

function skipLeadingModifiers(trimmedHead: string): { rest: string; hadModifier: boolean; hadConst: boolean } {
  let s = trimmedHead;
  let hadModifier = false;
  let hadConst = false;
  for (let steps = 0; steps < 8; steps++) {
    // Handle Rust `pub(crate)` / `pub(super)` / `pub(in ...)`
    if (s.startsWith('pub(')) {
      const close = s.indexOf(')');
      if (close > 0 && close < 32) {
        s = s.slice(close + 1).trimStart();
        hadModifier = true;
        continue;
      }
    }
    // Handle `extern "C"`
    if (s.startsWith('extern ')) {
      const m = /^extern(?:\s+"[^"\n]{1,16}")?\s+/.exec(s);
      if (m) {
        s = s.slice(m[0].length).trimStart();
        hadModifier = true;
        continue;
      }
    }
    const sp = /^([A-Za-z_][A-Za-z0-9_-]*)\s+/.exec(s);
    if (!sp) break;
    const word = sp[1]!;
    if (word === 'const') {
      // `const` can be Rust `const fn`, TS `const enum`, or JS `const foo = ...`
      const after = s.slice(sp[0].length).trimStart();
      if (/^(?:fn|enum|unsafe)\b/.test(after)) {
        s = after;
        hadModifier = true;
        hadConst = true;
        continue;
      }
      break;
    }
    if (!MODIFIER_WORDS.has(word)) break;
    s = s.slice(sp[0].length).trimStart();
    hadModifier = true;
  }
  return { rest: s, hadModifier, hadConst };
}

interface ParsedDecl {
  name: string;
  kind: MmuSymbolKind;
  isPythonIndent: boolean;
  isStatementNoBody: boolean;
}

function parseDeclarationLine(
  strippedLine: string,
  insideBraceClass: boolean,
): ParsedDecl | null {
  const trimmed = strippedLine.trim();
  if (!trimmed) return null;
  // Skip comments, strings, decorators
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('@')
  ) {
    return null;
  }

  const head = trimmed.length > MAX_LINE_SCAN_CHARS ? trimmed.slice(0, MAX_LINE_SCAN_CHARS) : trimmed;
  const { rest, hadModifier } = skipLeadingModifiers(head);
  if (!rest) return null;

  // Python `def name(` / `class Name`
  let m = /^def\s+([A-Za-z_]\w*)\s*\(/.exec(rest);
  if (m) {
    return { name: m[1]!, kind: 'function', isPythonIndent: true, isStatementNoBody: false };
  }

  // Go `func (recv) Name(` or `func Name(` / Swift `func name(`
  m = /^func\s+(?:\([^)\n]{1,80}\)\s*)?([A-Za-z_]\w*)\s*(?:<[^>\n]{0,60}>)?\s*\(/.exec(rest);
  if (m) {
    const hasRecv = /^func\s*\(/.test(rest);
    return {
      name: m[1]!,
      kind: hasRecv ? 'method' : 'function',
      isPythonIndent: false,
      isStatementNoBody: !rest.includes('{') && rest.endsWith(';'),
    };
  }

  // Rust `fn name`
  m = /^fn\s+([A-Za-z_]\w*)\s*(?:<|\()/.exec(rest);
  if (m) {
    return {
      name: m[1]!,
      kind: 'function',
      isPythonIndent: false,
      isStatementNoBody: !rest.includes('{') && rest.endsWith(';'),
    };
  }

  // TS/JS `function [*] name(`
  m = /^function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<|\()/.exec(rest);
  if (m) {
    return {
      name: m[1]!,
      kind: 'function',
      isPythonIndent: false,
      isStatementNoBody: !rest.includes('{') && rest.endsWith(';'),
    };
  }

  // Type declarations across TS/Go/Rust/Swift/Java
  m = /^(class|interface|struct|enum|trait|protocol|actor|record|namespace|mod)\s+([A-Za-z_$][\w$]*)\b/.exec(rest);
  if (m) {
    const kw = m[1]!;
    const name = m[2]!;
    const kind: MmuSymbolKind =
      kw === 'record'
        ? 'class'
        : kw === 'mod' || kw === 'namespace'
          ? 'module'
          : (kw as MmuSymbolKind);
    const isPyClass =
      kw === 'class' && !rest.includes('{') && (/:\s*(?:#.*)?$/.test(rest) || rest.includes('('));
    return {
      name,
      kind,
      isPythonIndent: isPyClass,
      isStatementNoBody: !isPyClass && !rest.includes('{') && rest.endsWith(';'),
    };
  }

  // Rust `impl [<T>] [Trait for] TypeName`
  if (rest.startsWith('impl ') || rest.startsWith('impl<')) {
    const implFor = /^impl(?:<[^>\n]{0,80}>)?\s+[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:<[^>\n]{0,80}>)?\s+for\s+([A-Za-z_]\w*)/.exec(rest);
    if (implFor) {
      return { name: implFor[1]!, kind: 'impl', isPythonIndent: false, isStatementNoBody: false };
    }
    const implSelf = /^impl(?:<[^>\n]{0,80}>)?\s+([A-Za-z_]\w*)/.exec(rest);
    if (implSelf) {
      return { name: implSelf[1]!, kind: 'impl', isPythonIndent: false, isStatementNoBody: false };
    }
  }

  // TS/Go/Rust/Swift type / typealias
  m = /^(?:type|typealias)\s+([A-Za-z_$][\w$]*)\b(?:\s*<[^>\n]{0,80}>)?\s*(struct|interface)?/.exec(rest);
  if (m) {
    const sub = m[2];
    const kind: MmuSymbolKind = sub === 'struct' ? 'struct' : sub === 'interface' ? 'interface' : 'type';
    return {
      name: m[1]!,
      kind,
      isPythonIndent: false,
      isStatementNoBody: !rest.includes('{'),
    };
  }

  // TS/JS `const|let|var name = [async] (...) =>` or `= [async] function`
  m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{1,100})?=\s*(?:async\s+)?(?:(?:\([^)\n]{0,160}\)|[A-Za-z_$][\w$]*)\s*=>|function\b|class\b)/.exec(rest);
  if (m) {
    return {
      name: m[1]!,
      kind: 'function',
      isPythonIndent: false,
      isStatementNoBody: !rest.includes('{'),
    };
  }

  // Java method: modifiers + optional generic `<T>` + return type + name(
  if (hadModifier) {
    const firstWord = /^([A-Za-z_$][\w$]*)\b/.exec(rest)?.[1];
    const jm = /^(?:<[^>\n]{1,60}>\s+)?[A-Za-z_$][\w$.[\]?]*(?:<[^>\n]{1,60}>)?(?:\[\])*\s+([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
    if ((!firstWord || !CONTROL_KEYWORDS.has(firstWord)) && jm && !CONTROL_KEYWORDS.has(jm[1]!)) {
      return {
        name: jm[1]!,
        kind: 'method',
        isPythonIndent: false,
        isStatementNoBody: !rest.includes('{') && rest.endsWith(';'),
      };
    }
  }

  // TS/JS/Java class method (`async storePage(...) {` or `storePage(...): MmuPage {`)
  if (insideBraceClass || hadModifier) {
    const mm = /^(?:(?:get|set)\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>\n]{0,60}>)?\s*\(/.exec(rest);
    if (mm && (!CONTROL_KEYWORDS.has(mm[1]!) || mm[1] === 'constructor')) {
      if (hadModifier || rest.includes('{') || /\)\s*(?::\s*[^\n{;]{1,80})?\s*\{/.test(rest)) {
        return {
          name: mm[1]!,
          kind: 'method',
          isPythonIndent: false,
          isStatementNoBody: !rest.includes('{') && rest.endsWith(';'),
        };
      }
    }
  }

  return null;
}

const ERROR_TOKEN_RE =
  /\b([A-Z][A-Za-z0-9]*(?:Error|Exception|Fault|Panic)|ERR_[A-Z0-9_]{2,}|E(?:NOENT|ACCES|PERM|CONNREFUSED|TIMEDOUT|ADDRINUSE|PIPE|ISDIR|NOSPC|EXIST|NOTDIR|BADF|INVAL|AGAIN|BUSY|IO))\b/;
const JS_STACK_FRAME_RE = /^\s*at\s+(?:async\s+)?([A-Za-z_$][\w$.<>]*)\s+\(/;
const PY_STACK_FRAME_RE = /^\s*File\s+"[^"\n]+",\s*line\s+\d+,\s*in\s+([A-Za-z_]\w*)/;

/** Extract error names and stack frame anchors from text with 1-based line numbers. */
export function extractErrorAnchors(text: string): MmuSymbolSpan[] {
  if (!text) return [];
  const lines = text.split('\n');
  const allowColon = detectColonGutterMode(lines);
  const out: MmuSymbolSpan[] = [];
  const seenLineName = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const raw = stripLineGutter(lines[i]!, allowColon);
    const head = raw.length > MAX_LINE_SCAN_CHARS ? raw.slice(0, MAX_LINE_SCAN_CHARS) : raw;
    const lineNum = i + 1;
    const errMatch = ERROR_TOKEN_RE.exec(head);
    if (errMatch) {
      const name = errMatch[1]!;
      const k = `${lineNum}\0${name}`;
      if (!seenLineName.has(k)) {
        seenLineName.add(k);
        out.push({ name, kind: 'error', startLine: lineNum, endLine: lineNum });
      }
    }
    const jsFrame = JS_STACK_FRAME_RE.exec(head);
    if (jsFrame) {
      const full = jsFrame[1]!;
      const short = full.includes('.') ? full.slice(full.lastIndexOf('.') + 1) : full;
      if (short && short !== '<anonymous>') {
        const k = `${lineNum}\0${short}`;
        if (!seenLineName.has(k)) {
          seenLineName.add(k);
          out.push({ name: short, kind: 'anchor', startLine: lineNum, endLine: lineNum });
        }
      }
    }
    const pyFrame = PY_STACK_FRAME_RE.exec(head);
    if (pyFrame) {
      const name = pyFrame[1]!;
      if (name && name !== '<module>') {
        const k = `${lineNum}\0${name}`;
        if (!seenLineName.has(k)) {
          seenLineName.add(k);
          out.push({ name, kind: 'anchor', startLine: lineNum, endLine: lineNum });
        }
      }
    }
  }
  return out;
}

function leadingIndentWidth(line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) width += 1;
    else if (c === 9) width += 4;
    else break;
  }
  return width;
}

interface ScanLineDelta {
  openBraces: number;
  closeBraces: number;
  parenDelta: number;
  firstBraceDepthDelta: boolean;
  hasSemicolonAtBase: boolean;
  inBlockCommentOut: boolean;
}

/** Single-pass O(L) scanner for braces/parens ignoring strings and comments. */
function scanLineDelimiters(
  line: string,
  inBlockComment: boolean,
  allowHashComment = false,
): ScanLineDelta {
  let openBraces = 0;
  let closeBraces = 0;
  let parenDelta = 0;
  let inBC = inBlockComment;
  let quote = 0; // 34=" 39=' 96=`
  let escaped = false;
  let firstBraceDepthDelta = false;
  let hasSemicolonAtBase = false;
  let localDepth = 0;

  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    const next = i + 1 < line.length ? line.charCodeAt(i + 1) : 0;
    if (inBC) {
      if (c === 42 && next === 47) {
        inBC = false;
        i += 1;
      }
      continue;
    }
    if (quote !== 0) {
      if (escaped) {
        escaped = false;
      } else if (c === 92) {
        escaped = true;
      } else if (c === quote) {
        quote = 0;
      }
      continue;
    }
    if (c === 47 && next === 47) break; // // comment
    // Treat `#` as comment only in Python/shell context (not JS/TS `#private` or Rust `#[attr]`)
    if (c === 35 && (allowHashComment || (next === 32 && i === 0))) break;
    if (c === 47 && next === 42) {
      inBC = true;
      i += 1;
      continue;
    }
    if (c === 34 || c === 39 || c === 96) {
      quote = c;
      continue;
    }
    if (c === 123) {
      openBraces += 1;
      localDepth += 1;
      if (localDepth > 0) firstBraceDepthDelta = true;
    } else if (c === 125) {
      closeBraces += 1;
      localDepth -= 1;
    } else if (c === 40) {
      parenDelta += 1;
    } else if (c === 41) {
      parenDelta -= 1;
    } else if (c === 59 && localDepth === 0) {
      hasSemicolonAtBase = true;
    }
  }

  return {
    openBraces,
    closeBraces,
    parenDelta,
    firstBraceDepthDelta,
    hasSemicolonAtBase,
    inBlockCommentOut: inBC,
  };
}

/**
 * O(N) line scanner extracting declarations (TS/JS, Python, Go, Rust, Swift, Java)
 * and error/stack anchors with 1-based `{ name, kind, startLine, endLine }`.
 */
export function extractSymbolSpans(text: string): MmuSymbolSpan[] {
  if (!text) return [];
  const lines = text.split('\n');
  const allowColon = detectColonGutterMode(lines);

  interface MutableSpan {
    name: string;
    kind: MmuSymbolKind;
    startLine: number;
    endLine: number;
  }

  interface OpenBlock {
    spanIdx: number;
    targetDepth: number;
    indent: number;
    isClassScope: boolean;
    waitingForSignatureClose: boolean;
  }

  const spans: MutableSpan[] = [];
  const braceStack: OpenBlock[] = [];
  const indentStack: OpenBlock[] = [];
  let openBraceClassCount = 0;
  let waitingIndentCount = 0;
  let pendingBraceDecl: {
    spanIdx: number;
    baseDepth: number;
    startIdx: number;
    isClassScope: boolean;
  } | null = null;

  let braceDepth = 0;
  let parenDepth = 0;
  let inBlockComment = false;
  let hashCommentMode = false;
  let lastNonEmptyLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const stripped = stripLineGutter(lines[i]!, allowColon);
    const trimmed = stripped.trim();
    const indent = leadingIndentWidth(stripped);

    if (
      !hashCommentMode &&
      trimmed.length > 0 &&
      (/^#!.*(?:python|bash|sh|zsh)\b/.test(trimmed) ||
        /^(?:async\s+)?def\s+\w+\s*\(/.test(trimmed) ||
        /^class\s+[A-Za-z_]\w*(?:\([^)\n]*\))?\s*:\s*(?:#.*)?$/.test(trimmed))
    ) {
      hashCommentMode = true;
    }

    // Close Python indent-scoped blocks before processing new non-empty, non-comment line (O(1) amortized).
    if (trimmed.length > 0 && !trimmed.startsWith('#')) {
      while (indentStack.length > 0) {
        const blk = indentStack[indentStack.length - 1]!;
        if (blk.waitingForSignatureClose || indent > blk.indent) break;
        indentStack.pop();
        spans[blk.spanIdx]!.endLine = Math.max(spans[blk.spanIdx]!.startLine, lastNonEmptyLine);
      }
    }

    const insideBraceClass = openBraceClassCount > 0;
    const depthBefore = braceDepth;

    let decl: ParsedDecl | null = null;
    if (!inBlockComment && trimmed.length > 0) {
      decl = parseDeclarationLine(stripped, insideBraceClass);
      if (decl && !decl.isPythonIndent && stripped.includes('{')) {
        hashCommentMode = false;
      }
    }

    const delta = scanLineDelimiters(stripped, inBlockComment, hashCommentMode);
    inBlockComment = delta.inBlockCommentOut;
    braceDepth = Math.max(0, braceDepth + delta.openBraces - delta.closeBraces);
    parenDepth = Math.max(0, parenDepth + delta.parenDelta);

    // Resolve any pending multi-line signature waiting for `{`
    if (pendingBraceDecl) {
      if (delta.openBraces > 0) {
        const blk: OpenBlock = {
          spanIdx: pendingBraceDecl.spanIdx,
          targetDepth: pendingBraceDecl.baseDepth,
          indent: 0,
          isClassScope: pendingBraceDecl.isClassScope,
          waitingForSignatureClose: false,
        };
        if (braceDepth <= blk.targetDepth) {
          spans[blk.spanIdx]!.endLine = lineNum;
        } else {
          braceStack.push(blk);
          if (blk.isClassScope) openBraceClassCount++;
        }
        pendingBraceDecl = null;
      } else if (delta.hasSemicolonAtBase && parenDepth === 0) {
        spans[pendingBraceDecl.spanIdx]!.endLine = lineNum;
        pendingBraceDecl = null;
      } else if (i - pendingBraceDecl.startIdx > 6) {
        pendingBraceDecl = null;
      }
    }

    // Check if an indent block's multi-line signature just finished (`):`)
    if (waitingIndentCount > 0 && parenDepth === 0 && /:\s*(?:#.*)?$/.test(trimmed)) {
      for (let s = indentStack.length - 1; s >= 0; s--) {
        const blk = indentStack[s]!;
        if (blk.waitingForSignatureClose) {
          blk.waitingForSignatureClose = false;
          waitingIndentCount--;
        }
      }
    }

    // Register new declaration found on this line
    if (decl) {
      const spanIdx = spans.length;
      spans.push({
        name: decl.name,
        kind: decl.kind,
        startLine: lineNum,
        endLine: lineNum,
      });
      const isClassScope =
        decl.kind === 'class' ||
        decl.kind === 'struct' ||
        decl.kind === 'interface' ||
        decl.kind === 'trait' ||
        decl.kind === 'impl' ||
        decl.kind === 'protocol' ||
        decl.kind === 'actor';

      if (decl.isPythonIndent) {
        const waiting = parenDepth > 0 || !/:\s*(?:#.*)?$/.test(trimmed);
        if (waiting) waitingIndentCount++;
        indentStack.push({
          spanIdx,
          targetDepth: 0,
          indent,
          isClassScope,
          waitingForSignatureClose: waiting,
        });
      } else if (delta.openBraces > 0) {
        if (braceDepth <= depthBefore) {
          // Opened and closed on same line (e.g. `function noop() {}`)
          spans[spanIdx]!.endLine = lineNum;
        } else {
          braceStack.push({
            spanIdx,
            targetDepth: depthBefore,
            indent,
            isClassScope,
            waitingForSignatureClose: false,
          });
          if (isClassScope) openBraceClassCount++;
        }
      } else if (!decl.isStatementNoBody) {
        pendingBraceDecl = {
          spanIdx,
          baseDepth: depthBefore,
          startIdx: i,
          isClassScope,
        };
      }
    }

    // Close brace-scoped blocks whose brace depth returned to targetDepth (monotonic stack)
    if (delta.closeBraces > 0) {
      while (braceStack.length > 0 && braceDepth <= braceStack[braceStack.length - 1]!.targetDepth) {
        const blk = braceStack.pop()!;
        if (blk.isClassScope) openBraceClassCount--;
        spans[blk.spanIdx]!.endLine = lineNum;
      }
    }

    if (trimmed.length > 0) {
      lastNonEmptyLine = lineNum;
    }
  }

  // Close any open blocks reaching EOF
  const eofLine = Math.max(1, lines.length);
  for (const blk of indentStack) {
    spans[blk.spanIdx]!.endLine = Math.max(spans[blk.spanIdx]!.startLine, lastNonEmptyLine);
  }
  for (const blk of braceStack) {
    spans[blk.spanIdx]!.endLine = eofLine;
  }

  // Append error / stack anchors (deduped against declaration lines with identical name)
  const declKeys = new Set(spans.map((s) => `${s.startLine}\0${s.name}`));
  for (const anchor of extractErrorAnchors(text)) {
    if (!declKeys.has(`${anchor.startLine}\0${anchor.name}`)) {
      spans.push(anchor);
    }
  }

  return spans.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

// ---------------------------------------------------------------------------
// 3. ContextPageStore, Inverted Indexes, LRU & Persistence
// ---------------------------------------------------------------------------

export interface MmuPage {
  readonly id: string;
  readonly sessionKey: string;
  readonly refId: string;
  readonly toolName?: string;
  readonly filePath?: string;
  readonly createdAtMs: number;
  readonly rawText: string;
  readonly lineCount: number;
  readonly symbols: readonly MmuSymbolSpan[];
  readonly factTokens: readonly string[];
}

export interface MmuPageSummary extends Omit<MmuPage, 'rawText'> {
  readonly chars: number;
}

export interface MmuStats {
  pagesStored: number;
  pagesEvicted: number;
  totalRawChars: number;
  activePages: number;
  activeBytes: number;
  tailHydrations: number;
  tailHydrationTokens: number;
  markovFolds: number;
  markovFoldedChars: number;
  skillsStubbed: number;
  skillStubSavedChars: number;
  densityPrunedBlocks: number;
  densityPrunedChars: number;
}

export interface MmuPersistenceAdapter {
  load(): string | undefined;
  save(json: string): void;
}

export interface ContextPageStoreOptions {
  readonly maxPages?: number;
  readonly maxBytes?: number;
  readonly debounceMs?: number;
  readonly persistence?: MmuPersistenceAdapter;
}

export interface StorePageInput {
  readonly sessionKey?: string;
  readonly refId?: string;
  readonly rawText: string;
  readonly toolName?: string;
  readonly filePath?: string;
  readonly nowMs?: number;
  readonly extraSymbols?: readonly string[];
}

export interface DerefPageOptions {
  readonly sessionKey?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly query?: string;
  readonly maxLines?: number;
}

const SECRET_PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const SECRET_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/;
const SECRET_TOKEN_PREFIX_RE = /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})\b/;
const SECRET_ENV_ASSIGN_RE =
  /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*[ \t]*=[ \t]*["']?[^\s"'#]{8,}/m;

/** Skip persisting raw pages containing high-confidence credentials or private keys. */
function containsHighConfidenceSecret(text: string): boolean {
  return (
    SECRET_PEM_RE.test(text) ||
    SECRET_BEARER_RE.test(text) ||
    SECRET_TOKEN_PREFIX_RE.test(text) ||
    SECRET_ENV_ASSIGN_RE.test(text)
  );
}

export interface DerefPageResult {
  readonly page: MmuPage;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface MmuPageSearchHit {
  readonly page: MmuPageSummary;
  readonly score: number;
  readonly matchedSymbols: readonly MmuSymbolSpan[];
  readonly matchedLine: number;
}

interface StoredEntry {
  readonly key: string;
  readonly page: MmuPage;
  readonly bytes: number;
  readonly indexKeys: readonly string[];
}

interface PersistedPageRecord {
  id: string;
  sessionKey: string;
  refId: string;
  toolName?: string;
  filePath?: string;
  createdAtMs: number;
  rawText: string;
  lineCount: number;
  symbols?: MmuSymbolSpan[];
  factTokens?: string[];
}

interface PersistedMmuState {
  format: number;
  savedAtMs: number;
  pages: PersistedPageRecord[];
  stats?: Partial<MmuStats>;
}

function emptyStats(): MmuStats {
  return {
    pagesStored: 0,
    pagesEvicted: 0,
    totalRawChars: 0,
    activePages: 0,
    activeBytes: 0,
    tailHydrations: 0,
    tailHydrationTokens: 0,
    markovFolds: 0,
    markovFoldedChars: 0,
    skillsStubbed: 0,
    skillStubSavedChars: 0,
    densityPrunedBlocks: 0,
    densityPrunedChars: 0,
  };
}

function summarizePage(page: MmuPage): MmuPageSummary {
  const { rawText, ...rest } = page;
  return { ...rest, chars: rawText.length };
}

function collectIndexKeys(
  symbols: readonly MmuSymbolSpan[],
  filePath: string | undefined,
  extraSymbols?: readonly string[],
): string[] {
  const keys = new Set<string>();
  for (const sym of symbols) {
    const low = sym.name.trim().toLowerCase();
    if (low) keys.add(low);
  }
  if (filePath) {
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    keys.add(norm);
    const base = pathBasename(norm);
    if (base) keys.add(base);
  }
  if (extraSymbols) {
    for (const sym of extraSymbols) {
      const low = sym.trim().toLowerCase();
      if (low) keys.add(low);
    }
  }
  return [...keys];
}

export class ContextPageStore {
  maxPages: number;
  maxBytes: number;
  private readonly debounceMs: number;

  /** LRU map keyed by `${sessionKey}\0${id}` (insertion order = LRU -> MRU). */
  private readonly entries = new Map<string, StoredEntry>();
  /** Fast pageId -> latest entryKey lookup (one pageId can exist under multiple sessions). */
  private readonly keysByPageId = new Map<string, Set<string>>();
  /** Inverted index: lowercased symbol / basename -> page IDs. */
  readonly symbolIndex = new Map<string, Set<string>>();
  /** Session index: sessionKey -> page IDs. */
  readonly sessionIndex = new Map<string, Set<string>>();

  private totalBytes = 0;
  private stats: MmuStats = emptyStats();

  private persistence: MmuPersistenceAdapter | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  /** Per-session Context-TLB leases: sessionKey -> (pageId -> { startLine, endLine, turn }). */
  private readonly hydrationTlb = new Map<
    string,
    Map<string, { startLine: number; endLine: number; turn: number }>
  >();
  /** Per-session logical hydration turn counter (bounded to 512 LRU sessions). */
  private readonly hydrationTurn = new Map<string, number>();

  constructor(options: ContextPageStoreOptions = {}) {
    this.maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
    this.debounceMs = Math.max(0, Math.floor(options.debounceMs ?? DEFAULT_DEBOUNCE_MS));
    if (options.persistence) {
      this.configurePersistence(options.persistence);
    }
  }

  /** Attach or detach persistence adapter, restoring saved pages fail-open. */
  configurePersistence(adapter: MmuPersistenceAdapter | undefined): number {
    this.flush();
    this.persistence = adapter;
    if (!adapter) return 0;
    let raw: string | undefined;
    try {
      raw = adapter.load();
    } catch {
      return 0;
    }
    return this.restore(raw);
  }

  private scheduleSave(): void {
    if (!this.persistence) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, this.debounceMs);
    (this.saveTimer as { unref?: () => void }).unref?.();
  }

  /** Immediately write pending updates to the configured persistence adapter. */
  flush(): boolean {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.persistence || !this.dirty) return false;
    this.dirty = false;
    try {
      this.persistence.save(this.serialize());
      return true;
    } catch {
      return false;
    }
  }

  /** Serialize current store state in LRU order (oldest first), skipping expired or secret-bearing pages. */
  serialize(nowMs: number = Date.now()): string {
    const pages: PersistedPageRecord[] = [];
    for (const entry of this.entries.values()) {
      const p = entry.page;
      const createdAtMs = p.createdAtMs > 0 ? p.createdAtMs : nowMs;
      if (nowMs - createdAtMs > PERSIST_MAX_IDLE_MS) continue;
      if (containsHighConfidenceSecret(p.rawText)) continue;
      pages.push({
        id: p.id,
        sessionKey: p.sessionKey,
        refId: p.refId,
        ...(p.toolName !== undefined ? { toolName: p.toolName } : {}),
        ...(p.filePath !== undefined ? { filePath: p.filePath } : {}),
        createdAtMs,
        rawText: p.rawText,
        lineCount: p.lineCount,
        symbols: [...p.symbols],
        factTokens: [...p.factTokens],
      });
    }
    const payload: PersistedMmuState = {
      format: PERSIST_FORMAT,
      savedAtMs: nowMs,
      pages,
      stats: { ...this.stats },
    };
    return JSON.stringify(payload);
  }

  /** Restore serialized pages into the store (in-memory entries win on collision; drops expired or secret-bearing records). */
  restore(json: string | undefined, nowMs: number = Date.now()): number {
    if (!json) return 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return 0;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    const obj = parsed as Partial<PersistedMmuState>;
    if (obj.format !== PERSIST_FORMAT || !Array.isArray(obj.pages)) return 0;

    let restored = 0;
    for (const rawRec of obj.pages) {
      if (!rawRec || typeof rawRec !== 'object' || Array.isArray(rawRec)) continue;
      const r = rawRec as Partial<PersistedPageRecord>;
      if (typeof r.rawText !== 'string' || typeof r.sessionKey !== 'string' || !r.sessionKey) continue;
      const createdAtMs = typeof r.createdAtMs === 'number' && Number.isFinite(r.createdAtMs) ? r.createdAtMs : 0;
      if (createdAtMs <= 0 || nowMs - createdAtMs > PERSIST_MAX_IDLE_MS) continue;
      if (containsHighConfidenceSecret(r.rawText)) continue;
      const id = typeof r.id === 'string' && /^pg_[0-9a-f]{8,16}$/.test(r.id) ? r.id : pageIdForText(r.rawText);
      const entryKey = `${r.sessionKey}\0${id}`;
      if (this.entries.has(entryKey)) continue;

      const bytes = utf8ByteLength(r.rawText);
      if (bytes > this.maxBytes) continue;

      const filePath = typeof r.filePath === 'string' && r.filePath ? r.filePath : inferFilePath(r.rawText, r.refId);
      const symbols = Array.isArray(r.symbols)
        ? r.symbols.filter(
            (s): s is MmuSymbolSpan =>
              Boolean(s) &&
              typeof s.name === 'string' &&
              typeof s.kind === 'string' &&
              typeof s.startLine === 'number' &&
              typeof s.endLine === 'number',
          )
        : extractSymbolSpans(r.rawText);
      const factTokens = Array.isArray(r.factTokens)
        ? r.factTokens.filter((t): t is string => typeof t === 'string')
        : extractFactSheetTokens(r.rawText);
      const page: MmuPage = {
        id,
        sessionKey: r.sessionKey,
        refId: typeof r.refId === 'string' && r.refId ? r.refId : 'restored',
        ...(typeof r.toolName === 'string' && r.toolName ? { toolName: r.toolName } : {}),
        ...(filePath !== undefined ? { filePath } : {}),
        createdAtMs,
        rawText: r.rawText,
        lineCount:
          typeof r.lineCount === 'number' && Number.isFinite(r.lineCount) && r.lineCount >= 0
            ? r.lineCount
            : countLines(r.rawText),
        symbols,
        factTokens,
      };
      this.insertEntry(entryKey, page, bytes, collectIndexKeys(symbols, filePath), false);
      restored += 1;
    }

    if (obj.stats && typeof obj.stats === 'object') {
      const s = obj.stats;
      const num = (v: unknown, cur: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.max(cur, v) : cur);
      this.stats.pagesStored = num(s.pagesStored, this.stats.pagesStored);
      this.stats.pagesEvicted = num(s.pagesEvicted, this.stats.pagesEvicted);
      this.stats.totalRawChars = num(s.totalRawChars, this.stats.totalRawChars);
      this.stats.tailHydrations = num(s.tailHydrations, this.stats.tailHydrations);
      this.stats.tailHydrationTokens = num(s.tailHydrationTokens, this.stats.tailHydrationTokens);
      this.stats.markovFolds = num(s.markovFolds, this.stats.markovFolds);
      this.stats.markovFoldedChars = num(s.markovFoldedChars, this.stats.markovFoldedChars);
      this.stats.skillsStubbed = num(s.skillsStubbed, this.stats.skillsStubbed);
      this.stats.skillStubSavedChars = num(s.skillStubSavedChars, this.stats.skillStubSavedChars);
      this.stats.densityPrunedBlocks = num(s.densityPrunedBlocks, this.stats.densityPrunedBlocks);
      this.stats.densityPrunedChars = num(s.densityPrunedChars, this.stats.densityPrunedChars);
    }
    return restored;
  }

  private touchEntry(entry: StoredEntry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }

  private addIndexes(entry: StoredEntry): void {
    const { page, key, indexKeys } = entry;
    let pidKeys = this.keysByPageId.get(page.id);
    if (!pidKeys) {
      pidKeys = new Set();
      this.keysByPageId.set(page.id, pidKeys);
    }
    pidKeys.add(key);

    let sessPages = this.sessionIndex.get(page.sessionKey);
    if (!sessPages) {
      sessPages = new Set();
      this.sessionIndex.set(page.sessionKey, sessPages);
    }
    sessPages.add(page.id);

    for (const idxKey of indexKeys) {
      let set = this.symbolIndex.get(idxKey);
      if (!set) {
        set = new Set();
        this.symbolIndex.set(idxKey, set);
      }
      set.add(page.id);
    }
  }

  private removeIndexes(entry: StoredEntry): void {
    const { page, key, indexKeys } = entry;
    const pidKeys = this.keysByPageId.get(page.id);
    let pageIdStillExists = false;
    if (pidKeys) {
      pidKeys.delete(key);
      if (pidKeys.size === 0) {
        this.keysByPageId.delete(page.id);
      } else {
        pageIdStillExists = true;
      }
    }

    const sessPages = this.sessionIndex.get(page.sessionKey);
    if (sessPages) {
      sessPages.delete(page.id);
      if (sessPages.size === 0) this.sessionIndex.delete(page.sessionKey);
    }

    for (const idxKey of indexKeys) {
      const set = this.symbolIndex.get(idxKey);
      if (!set) continue;
      if (!pageIdStillExists) {
        set.delete(page.id);
      } else {
        // Only keep page.id under idxKey if another remaining entry with page.id owns idxKey
        let stillOwned = false;
        for (const otherKey of pidKeys!) {
          const other = this.entries.get(otherKey);
          if (other && other.indexKeys.includes(idxKey)) {
            stillOwned = true;
            break;
          }
        }
        if (!stillOwned) set.delete(page.id);
      }
      if (set.size === 0) this.symbolIndex.delete(idxKey);
    }
  }

  private evictOldest(): boolean {
    let candidate: [string, StoredEntry] | undefined;
    let firstEntry: [string, StoredEntry] | undefined;
    for (const pair of this.entries.entries()) {
      if (!firstEntry) firstEntry = pair;
      if (pair[1].page.toolName !== 'skill-catalog') {
        candidate = pair;
        break;
      }
    }
    const victim = candidate ?? firstEntry;
    if (!victim) return false;
    const [key, entry] = victim;
    this.entries.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    this.removeIndexes(entry);
    this.stats.pagesEvicted += 1;
    return true;
  }

  private insertEntry(
    entryKey: string,
    page: MmuPage,
    bytes: number,
    indexKeys: readonly string[],
    schedule: boolean,
  ): void {
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxPages || this.totalBytes + bytes > this.maxBytes)
    ) {
      if (!this.evictOldest()) break;
    }
    const entry: StoredEntry = { key: entryKey, page, bytes, indexKeys };
    this.entries.set(entryKey, entry);
    this.totalBytes += bytes;
    this.addIndexes(entry);
    this.stats.pagesStored += 1;
    this.stats.totalRawChars += page.rawText.length;
    if (schedule) this.scheduleSave();
  }

  /**
   * Store a paged-out block into Context-MMU.
   * Reuses an existing entry with identical `id` under `sessionKey` (no-op, refreshes LRU).
   */
  storePage(input: StorePageInput): MmuPage {
    const sessionKey = input.sessionKey && input.sessionKey.trim() ? input.sessionKey.trim() : 'default';
    const refId = input.refId && input.refId.trim() ? input.refId.trim() : 'page';
    const id = pageIdForText(input.rawText);
    const entryKey = `${sessionKey}\0${id}`;
    const existing = this.entries.get(entryKey);
    if (existing) {
      if (input.extraSymbols && input.extraSymbols.length > 0) {
        const extraKeys = collectIndexKeys([], existing.page.filePath, input.extraSymbols);
        const merged = [...new Set([...existing.indexKeys, ...extraKeys])];
        const updated: StoredEntry = { ...existing, indexKeys: merged };
        this.entries.delete(entryKey);
        this.entries.set(entryKey, updated);
        this.addIndexes(updated);
      } else {
        this.touchEntry(existing);
      }
      return existing.page;
    }

    const filePath = input.filePath ?? inferFilePath(input.rawText, refId);
    const symbols = extractSymbolSpans(input.rawText);
    const factTokens = extractFactSheetTokens(input.rawText);
    const page: MmuPage = {
      id,
      sessionKey,
      refId,
      ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
      ...(filePath !== undefined ? { filePath } : {}),
      createdAtMs: input.nowMs ?? Date.now(),
      rawText: input.rawText,
      lineCount: countLines(input.rawText),
      symbols,
      factTokens,
    };

    const bytes = utf8ByteLength(input.rawText);
    if (bytes > this.maxBytes) {
      // Single page exceeds total memory cap: return record without violating store bound.
      return page;
    }

    const indexKeys = collectIndexKeys(symbols, filePath, input.extraSymbols);
    this.insertEntry(entryKey, page, bytes, indexKeys, true);
    return page;
  }

  private resolveEntryByPageId(pageId: string, sessionKey?: string): StoredEntry | undefined {
    if (sessionKey !== undefined) {
      const sk = sessionKey.trim();
      return sk ? this.entries.get(`${sk}\0${pageId}`) : undefined;
    }
    const keys = this.keysByPageId.get(pageId);
    if (!keys || keys.size === 0) return undefined;
    let latest: StoredEntry | undefined;
    for (const key of keys) {
      const e = this.entries.get(key);
      if (e) latest = e;
    }
    return latest;
  }

  /** Dereference a stored page by ID with optional sessionKey boundary, line range, or focused query. */
  derefPage(pageId: string, opts: DerefPageOptions = {}): DerefPageResult | null {
    if (!pageId || typeof pageId !== 'string') return null;
    const entry = this.resolveEntryByPageId(pageId.trim(), opts.sessionKey);
    if (!entry) return null;
    this.touchEntry(entry);

    const { page } = entry;
    const lines = page.rawText.split('\n');
    const total = lines.length;
    if (total === 0) {
      return { page, text: '', startLine: 1, endLine: 0 };
    }

    const maxLines =
      opts.maxLines !== undefined && Number.isFinite(opts.maxLines)
        ? Math.max(1, Math.min(2000, Math.floor(opts.maxLines)))
        : undefined;

    let startLine = 1;
    let endLine = total;

    if (opts.startLine !== undefined || opts.endLine !== undefined) {
      const reqStart = opts.startLine !== undefined && Number.isFinite(opts.startLine)
        ? Math.floor(opts.startLine)
        : 1;
      startLine = Math.max(1, Math.min(total, reqStart));
      const defaultEnd = maxLines !== undefined ? startLine + maxLines - 1 : total;
      const reqEnd = opts.endLine !== undefined && Number.isFinite(opts.endLine)
        ? Math.floor(opts.endLine)
        : defaultEnd;
      endLine = Math.max(startLine, Math.min(total, reqEnd));
      if (maxLines !== undefined) {
        endLine = Math.min(endLine, startLine + maxLines - 1);
      }
    } else if (opts.query && opts.query.trim()) {
      const q = opts.query.trim().slice(0, 512).toLowerCase();
      const symHit =
        page.symbols.find((s) => s.name.toLowerCase() === q) ??
        page.symbols.find((s) => s.name.toLowerCase().includes(q));
      let centerLine = symHit?.startLine;
      if (centerLine === undefined) {
        for (let i = 0; i < total; i++) {
          if (lines[i]!.toLowerCase().includes(q)) {
            centerLine = i + 1;
            break;
          }
        }
      }
      if (centerLine !== undefined) {
        const cap = maxLines ?? 40;
        if (symHit && symHit.endLine - symHit.startLine + 1 <= cap) {
          startLine = Math.max(1, symHit.startLine - 5);
          endLine = Math.min(total, Math.max(symHit.endLine + 5, startLine + cap - 1));
        } else {
          const before = Math.min(15, Math.floor(cap / 2));
          startLine = Math.max(1, centerLine - before);
          endLine = Math.min(total, startLine + cap - 1);
        }
      } else {
        startLine = 1;
        endLine = maxLines !== undefined ? Math.min(total, maxLines) : total;
      }
    } else if (maxLines !== undefined) {
      startLine = 1;
      endLine = Math.min(total, maxLines);
    }

    const slicedLines = lines.slice(startLine - 1, endLine);
    let text = slicedLines.join('\n');
    let actualEnd = endLine;
    if (text.length > MAX_DEREF_CHARS) {
      const kept: string[] = [];
      let len = 0;
      for (let k = 0; k < slicedLines.length; k++) {
        const l = slicedLines[k]!;
        const nextLen = kept.length === 0 ? l.length : len + 1 + l.length;
        if (nextLen > MAX_DEREF_CHARS) {
          if (kept.length === 0) {
            kept.push(`${l.slice(0, Math.max(0, MAX_DEREF_CHARS - 16))}\n... [truncated]`);
            actualEnd = startLine;
          } else {
            actualEnd = startLine + kept.length - 1;
          }
          break;
        }
        kept.push(l);
        len = nextLen;
      }
      text = kept.join('\n');
    }

    return {
      page,
      text,
      startLine,
      endLine: actualEnd,
    };
  }

  /** List stored page metadata (no `rawText`), strictly scoped when `sessionKey` is provided. */
  listPages(sessionKey?: string): MmuPageSummary[] {
    let scopedKey: string | undefined;
    if (sessionKey !== undefined) {
      scopedKey = sessionKey.trim();
      if (!scopedKey) return [];
    }
    const out: MmuPageSummary[] = [];
    for (const entry of this.entries.values()) {
      if (scopedKey !== undefined && entry.page.sessionKey !== scopedKey) continue;
      out.push(summarizePage(entry.page));
    }
    return out;
  }

  /** Search resident pages by symbol name, file path, fact token, or text content. */
  searchPages(query: string, sessionKey?: string): MmuPageSearchHit[] {
    let scopedKey: string | undefined;
    if (sessionKey !== undefined) {
      scopedKey = sessionKey.trim();
      if (!scopedKey) return [];
    }
    const q = query.trim().slice(0, 512);
    if (!q) return [];
    const qLower = q.toLowerCase();
    const terms = qLower
      .split(/[\s,;/()]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .slice(0, 16);
    if (terms.length === 0) terms.push(qLower);

    const indexedIds = new Set<string>();
    const exactIdSet = this.symbolIndex.get(qLower);
    if (exactIdSet) {
      for (const id of exactIdSet) indexedIds.add(id);
    }
    for (const term of terms) {
      const s = this.symbolIndex.get(term);
      if (s) for (const id of s) indexedIds.add(id);
    }

    const hits: MmuPageSearchHit[] = [];
    const sessionFilter = scopedKey !== undefined ? this.sessionIndex.get(scopedKey) : undefined;
    if (scopedKey !== undefined && (!sessionFilter || sessionFilter.size === 0)) {
      return [];
    }

    // Walk MRU -> LRU by iterating entries in reverse insertion order
    const ordered = [...this.entries.values()].reverse();
    for (const entry of ordered) {
      const { page } = entry;
      if (scopedKey !== undefined && page.sessionKey !== scopedKey) continue;

      let score = indexedIds.has(page.id) ? 50 : 0;
      const matchedSymbols: MmuSymbolSpan[] = [];
      for (const sym of page.symbols) {
        const sLower = sym.name.toLowerCase();
        if (sLower === qLower || terms.includes(sLower)) {
          score += 100;
          matchedSymbols.push(sym);
        } else if (terms.some((t) => sLower.includes(t))) {
          score += 40;
          matchedSymbols.push(sym);
        }
      }

      if (page.filePath) {
        const fpLower = page.filePath.toLowerCase();
        const baseLower = pathBasename(fpLower);
        if (baseLower === qLower || terms.includes(baseLower)) score += 80;
        else if (fpLower.includes(qLower) || terms.some((t) => fpLower.includes(t))) score += 30;
      }
      if (page.refId.toLowerCase().includes(qLower)) score += 25;

      for (const ft of page.factTokens) {
        const ftLow = ft.toLowerCase();
        if (ftLow === qLower || terms.includes(ftLow)) {
          score += 30;
          break;
        }
      }

      let textLineHit: number | undefined;
      if (score === 0 || matchedSymbols.length === 0) {
        const rawLower = page.rawText.toLowerCase();
        const idx = rawLower.indexOf(qLower);
        if (idx >= 0) {
          score += 15;
          textLineHit = countLines(page.rawText.slice(0, idx));
        } else if (terms.length > 1) {
          for (const t of terms) {
            const tidx = rawLower.indexOf(t);
            if (tidx >= 0) {
              score += 10;
              textLineHit = textLineHit ?? countLines(page.rawText.slice(0, tidx));
              break;
            }
          }
        }
      }

      if (score > 0) {
        hits.push({
          page: summarizePage(page),
          score,
          matchedSymbols,
          matchedLine: matchedSymbols[0]?.startLine ?? textLineHit ?? 1,
        });
      }
    }

    hits.sort((a, b) => b.score - a.score || b.page.createdAtMs - a.page.createdAtMs);
    return hits;
  }

  /** Lookup page IDs indexed for a lowercased symbol or basename key. */
  lookupSymbolPageIds(symbolOrBasename: string, sessionKey?: string): string[] {
    const set = this.symbolIndex.get(symbolOrBasename.trim().toLowerCase());
    if (!set || set.size === 0) return [];
    if (!sessionKey) return [...set];
    const sessPages = this.sessionIndex.get(sessionKey);
    if (!sessPages || sessPages.size === 0) return [];
    const out: string[] = [];
    for (const id of set) {
      if (sessPages.has(id)) out.push(id);
    }
    return out;
  }

  /** O(1) resident page count (optionally scoped to one session). */
  getSessionPageCount(sessionKey?: string): number {
    if (!sessionKey) return this.entries.size;
    return this.sessionIndex.get(sessionKey.trim())?.size ?? 0;
  }

  /** Retrieve raw page object by ID (optional sessionKey preference) without modifying text. */
  getPage(pageId: string, sessionKey?: string): MmuPage | null {
    const entry = this.resolveEntryByPageId(pageId, sessionKey);
    return entry ? entry.page : null;
  }

  /**
   * Append a clean, idempotent Virtual Memory page card to a compact digest.
   */
  formatPageCard(page: MmuPage, compactDigest: string): string {
    const markerPrefix = `[fiche vm-page ${page.id}`;
    if (compactDigest.includes(markerPrefix)) return compactDigest;

    const seenSyms = new Set<string>();
    const declNames: string[] = [];
    const anchorNames: string[] = [];
    for (const sym of page.symbols) {
      if (seenSyms.has(sym.name)) continue;
      seenSyms.add(sym.name);
      if (sym.kind === 'error' || sym.kind === 'anchor') {
        if (anchorNames.length < 4) anchorNames.push(sym.name);
      } else if (declNames.length < 5) {
        declNames.push(sym.name);
      }
    }
    const topSyms = declNames.length > 0 ? declNames : anchorNames;
    const loc = page.filePath ? ` (${page.filePath}, ${page.lineCount}L)` : '';
    const symPart = topSyms.length > 0 ? ` | top symbols: ${topSyms.join(', ')}` : '';
    const card = `[fiche vm-page ${page.id}${loc}${symPart} | page_in("${page.id}")]`;
    return compactDigest ? `${compactDigest}\n${card}` : card;
  }

  recordTailHydration(tokens: number): void {
    if (tokens <= 0) return;
    this.stats.tailHydrations += 1;
    this.stats.tailHydrationTokens += tokens;
    this.scheduleSave();
  }

  recordMarkovFold(foldedChars: number): void {
    if (foldedChars <= 0) return;
    this.stats.markovFolds += 1;
    this.stats.markovFoldedChars += foldedChars;
    this.scheduleSave();
  }

  recordSkillStub(stubbedCount: number, savedChars: number): void {
    if (stubbedCount <= 0) return;
    this.stats.skillsStubbed += stubbedCount;
    this.stats.skillStubSavedChars += Math.max(0, savedChars);
    this.scheduleSave();
  }

  recordDensityPrune(prunedChars: number): void {
    if (prunedChars <= 0) return;
    this.stats.densityPrunedBlocks += 1;
    this.stats.densityPrunedChars += prunedChars;
    this.scheduleSave();
  }

  getStats(): MmuStats {
    return {
      ...this.stats,
      activePages: this.entries.size,
      activeBytes: this.totalBytes,
    };
  }

  /** Return active page/RAM bounds and whether disk persistence is attached. */
  getLimits(): { readonly maxPages: number; readonly maxBytes: number; readonly persisted: boolean } {
    return {
      maxPages: this.maxPages,
      maxBytes: this.maxBytes,
      persisted: this.persistence !== undefined,
    };
  }

  /**
   * Update page/byte bounds dynamically and evict oldest pages if the store
   * currently exceeds the new limits.
   */
  setLimits(opts: { maxPages?: number; maxBytes?: number }): void {
    if (opts.maxPages !== undefined && Number.isFinite(opts.maxPages)) {
      this.maxPages = Math.max(1, Math.floor(opts.maxPages));
    }
    if (opts.maxBytes !== undefined && Number.isFinite(opts.maxBytes)) {
      this.maxBytes = Math.max(1, Math.floor(opts.maxBytes));
    }
    while (
      this.entries.size > 0 &&
      (this.entries.size > this.maxPages || this.totalBytes > this.maxBytes)
    ) {
      if (!this.evictOldest()) break;
    }
  }

  /** Increment and return the per-session logical hydration turn counter (LRU-bounded to 512 sessions). */
  nextHydrationTurn(sessionKey: string): number {
    const key = sessionKey || 'default';
    const next = (this.hydrationTurn.get(key) ?? 0) + 1;
    if (this.hydrationTurn.has(key)) {
      this.hydrationTurn.delete(key);
    } else if (this.hydrationTurn.size >= TLB_MAX_SESSIONS) {
      const oldest = this.hydrationTurn.keys().next().value;
      if (oldest !== undefined) {
        this.hydrationTurn.delete(oldest);
        this.hydrationTlb.delete(oldest);
      }
    }
    this.hydrationTurn.set(key, next);
    return next;
  }

  /**
   * Return true iff an overlapping slice on `pageId` (`±4` lines) was already
   * hydrated for `sessionKey` within the last `cooldownTurns` logical turns.
   */
  isTlbSuppressed(
    sessionKey: string,
    pageId: string,
    startLine: number,
    endLine: number,
    turn: number,
    cooldownTurns = TLB_DEFAULT_COOLDOWN_TURNS,
  ): boolean {
    const key = sessionKey || 'default';
    const sessionLeases = this.hydrationTlb.get(key);
    if (!sessionLeases) return false;
    const prev = sessionLeases.get(pageId);
    if (!prev) return false;
    if (turn - prev.turn > cooldownTurns) return false;
    return Math.max(startLine, prev.startLine) <= Math.min(endLine, prev.endLine) + TLB_OVERLAP_PAD_LINES;
  }

  /** Record/refresh a Context-TLB hydration lease (LRU-bounded to 64 leases per session). */
  recordHydrationLease(
    sessionKey: string,
    pageId: string,
    startLine: number,
    endLine: number,
    turn: number,
  ): void {
    const key = sessionKey || 'default';
    let sessionLeases = this.hydrationTlb.get(key);
    if (sessionLeases) {
      this.hydrationTlb.delete(key);
    } else {
      if (this.hydrationTlb.size >= TLB_MAX_SESSIONS) {
        const oldest = this.hydrationTlb.keys().next().value;
        if (oldest !== undefined) {
          this.hydrationTlb.delete(oldest);
          this.hydrationTurn.delete(oldest);
        }
      }
      sessionLeases = new Map();
    }
    this.hydrationTlb.set(key, sessionLeases);

    if (sessionLeases.has(pageId)) {
      sessionLeases.delete(pageId);
    } else if (sessionLeases.size >= TLB_MAX_LEASES_PER_SESSION) {
      const oldestPage = sessionLeases.keys().next().value;
      if (oldestPage !== undefined) sessionLeases.delete(oldestPage);
    }
    sessionLeases.set(pageId, { startLine, endLine, turn });
  }

  reset(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.dirty = false;
    this.entries.clear();
    this.keysByPageId.clear();
    this.symbolIndex.clear();
    this.sessionIndex.clear();
    this.hydrationTlb.clear();
    this.hydrationTurn.clear();
    this.totalBytes = 0;
    this.stats = emptyStats();
  }
}

let globalMmuStore: ContextPageStore | undefined;

export function getGlobalMmuStore(): ContextPageStore {
  if (!globalMmuStore) {
    globalMmuStore = new ContextPageStore();
  }
  return globalMmuStore;
}

/**
 * Configure the global Context-MMU RAM limits (clamped to `[64, 16384]` pages
 * and `[4 MiB, 256 MiB]` bytes), evicting oldest pages immediately if shrunk.
 */
export function configureMmuLimits(opts: { maxPages?: number; maxBytes?: number }): {
  maxPages: number;
  maxBytes: number;
} {
  const store = getGlobalMmuStore();
  const next: { maxPages?: number; maxBytes?: number } = {};
  if (opts.maxPages !== undefined && Number.isFinite(opts.maxPages)) {
    next.maxPages = Math.min(MAX_MMU_PAGES, Math.max(MIN_MMU_PAGES, Math.floor(opts.maxPages)));
  }
  if (opts.maxBytes !== undefined && Number.isFinite(opts.maxBytes)) {
    next.maxBytes = Math.min(MAX_MMU_BYTES, Math.max(MIN_MMU_BYTES, Math.floor(opts.maxBytes)));
  }
  store.setLimits(next);
  return { maxPages: store.maxPages, maxBytes: store.maxBytes };
}

export function configureMmuPersistence(adapter?: MmuPersistenceAdapter): number {
  return getGlobalMmuStore().configurePersistence(adapter);
}

export function flushMmuPersistence(): boolean {
  return globalMmuStore ? globalMmuStore.flush() : false;
}

export function resetGlobalMmuStore(): void {
  globalMmuStore?.reset();
  resetGlobalPrefixTape();
}

// ---------------------------------------------------------------------------
// 4. Speculative Live-Tail Hydration (`computeTailHydration`)
// ---------------------------------------------------------------------------

export interface TailHydrationInput {
  readonly store: ContextPageStore;
  readonly sessionKey?: string;
  readonly liveTailTexts: readonly string[];
  readonly recentVerbatimTexts?: readonly string[];
  readonly budgetTokens?: number;
  readonly maxSlices?: number;
}

export interface TailHydrationSlice {
  readonly pageId: string;
  readonly refId: string;
  readonly filePath?: string;
  readonly matchedSymbol: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly tokens: number;
}

export interface TailHydrationResult {
  readonly text: string;
  readonly changed: boolean;
  readonly slices: readonly TailHydrationSlice[];
  readonly totalTokens: number;
}

interface ExtractedTailTokens {
  readonly pageIds: string[];
  readonly symbols: string[];
  readonly basenames: string[];
  readonly skillWords: string[];
}

const TAIL_PAGE_ID_RE = /\bpg_[0-9a-f]{8,16}\b/g;
// Non-backtracking maximal path token scan for O(N) basename extraction (no nested path quantifier).
const TAIL_PATH_TOKEN_RE = /[\w.@+/-]+/g;
const TAIL_BASE_VALID_RE = /^[\w.-]+$/;
const TAIL_EXT_VALID_RE = /^[A-Za-z0-9]{1,10}$/;
const TAIL_CAMEL_RE = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;
const TAIL_PASCAL_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
const TAIL_SNAKE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const TAIL_KEBAB_RE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g;
const TAIL_ERROR_RE = /\b(?:[A-Z][A-Za-z0-9]*(?:Error|Exception|Fault|Panic)|ERR_[A-Z0-9_]{2,}|E(?:NOENT|ACCES|PERM|CONNREFUSED|TIMEDOUT|ADDRINUSE|PIPE|ISDIR|NOSPC))\b/g;
const TAIL_SKILL_WORD_RE = /\b[A-Za-z][A-Za-z0-9]{2,31}\b/g;

const TAIL_FAULT_SIGNAL_RE =
  /\b(?:pg_[0-9a-f]{8,16}|[A-Za-z_]\w*(?:Error|Exception|Fault|Panic)|ERR_[A-Z0-9_]+|FAIL(?:ED)?|exit[_ ]?code[:=\s]+[1-9]\d*|returned [1-9]\d*)\b|Traceback \(most recent call last\)|^\s*at\s+\S+\s*\(/m;

/**
 * Intent-stratified tool-output filter for SB-SMP: returns the trailing
 * snippet only when a tool output carries an active fault/stack signal or
 * explicit `pg_*` page pointer, preventing routine `read_file` outputs from
 * triggering speculative hydrations on passing turns.
 */
export function extractFaultSignalSnippet(
  toolText: string,
  maxChars = 2048,
): string | undefined {
  if (!toolText || !toolText.trim()) return undefined;
  if (!TAIL_FAULT_SIGNAL_RE.test(toolText)) return undefined;
  return toolText.length > maxChars ? toolText.slice(-maxChars) : toolText;
}

function extractTailIdentifierTokens(texts: readonly string[]): ExtractedTailTokens {
  const pageIds: string[] = [];
  const symbols: string[] = [];
  const basenames: string[] = [];
  const skillWords: string[] = [];
  const seenPage = new Set<string>();
  const seenSym = new Set<string>();
  const seenBase = new Set<string>();
  const seenWord = new Set<string>();

  const pushMatches = (
    src: string,
    re: RegExp,
    target: string[],
    seen: Set<string>,
    lowercaseOut = false,
  ) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const val = m[0].trim();
      if (!val || val.length < 3 || val.length > 120) continue;
      const low = val.toLowerCase();
      if (!seen.has(low)) {
        seen.add(low);
        target.push(lowercaseOut ? low : val);
      }
      if (target.length >= 64) break;
    }
  };

  // Iterate newest-to-oldest so the active prompt/tool turn never starves behind earlier messages.
  for (let i = texts.length - 1; i >= 0; i--) {
    const raw = texts[i];
    if (!raw) continue;
    const sample = raw.length > 16_384 ? raw.slice(-16_384) : raw;
    if (pageIds.length < 64) pushMatches(sample, TAIL_PAGE_ID_RE, pageIds, seenPage);
    if (symbols.length < 64) pushMatches(sample, TAIL_CAMEL_RE, symbols, seenSym);
    if (symbols.length < 64) pushMatches(sample, TAIL_PASCAL_RE, symbols, seenSym);
    if (symbols.length < 64) pushMatches(sample, TAIL_SNAKE_RE, symbols, seenSym);
    if (symbols.length < 64) pushMatches(sample, TAIL_KEBAB_RE, symbols, seenSym);
    if (symbols.length < 64) pushMatches(sample, TAIL_ERROR_RE, symbols, seenSym);
    if (basenames.length < 64) {
      TAIL_PATH_TOKEN_RE.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = TAIL_PATH_TOKEN_RE.exec(sample)) !== null) {
        const tok = pm[0];
        const slash = tok.lastIndexOf('/');
        const base = slash >= 0 ? tok.slice(slash + 1) : tok;
        if (base.length < 3 || base.length > 120 || !TAIL_BASE_VALID_RE.test(base)) continue;
        const dot = base.lastIndexOf('.');
        if (dot <= 0 || !TAIL_EXT_VALID_RE.test(base.slice(dot + 1))) continue;
        const low = base.toLowerCase();
        if (!seenBase.has(low)) {
          seenBase.add(low);
          basenames.push(base);
        }
        if (basenames.length >= 64) break;
      }
    }
    if (skillWords.length < 64) pushMatches(sample, TAIL_SKILL_WORD_RE, skillWords, seenWord, true);
  }
  return { pageIds, symbols, basenames, skillWords };
}

/**
 * Purely read-only Symbol-Boundary-Aware Speculative MMU Prefetcher (SB-SMP).
 * Fuses `pg_*`, declaration spans, error anchors, basenames, and skill matches
 * with exact session IDF weighting; preserves full enclosing function bodies
 * up to ~45 lines; never modifies cached prefixes; fails closed without `sessionKey`.
 */
export function computeTailHydration(input: TailHydrationInput): TailHydrationResult {
  const budgetTokens = Math.max(64, Math.floor(input.budgetTokens ?? 1400));
  const maxSlices = Math.max(1, Math.floor(input.maxSlices ?? 3));
  const sessionKey = input.sessionKey?.trim();
  if (!sessionKey || input.liveTailTexts.length === 0) {
    return { text: '', changed: false, slices: [], totalTokens: 0 };
  }
  const tlbTurn = input.store.nextHydrationTurn(sessionKey);

  const tokens = extractTailIdentifierTokens(input.liveTailTexts);
  if (
    tokens.pageIds.length === 0 &&
    tokens.symbols.length === 0 &&
    tokens.basenames.length === 0 &&
    tokens.skillWords.length === 0
  ) {
    return { text: '', changed: false, slices: [], totalTokens: 0 };
  }

  const recentTexts = (input.recentVerbatimTexts ?? []).filter(Boolean);
  const isAlreadyVerbatim = (page: MmuPage, sliceText: string): boolean => {
    for (const r of recentTexts) {
      if (r.includes(page.rawText)) return true;
      if (sliceText.length >= 40 && r.includes(sliceText)) return true;
    }
    return false;
  };

  interface Candidate {
    page: MmuPage;
    matchedSymbol: string;
    targetLine: number;
    spanStartLine: number;
    spanEndLine: number;
    hasDeclSpan: boolean;
    score: number;
    isExplicitPageId?: boolean;
    hasHighSignal?: boolean;
  }

  const totalSessionPages = Math.max(1, input.store.getSessionPageCount(sessionKey));
  const computeIdf = (df: number): number => Math.log(1 + totalSessionPages / (1 + Math.max(0, df)));

  // Collect basename-matched pages up front so co-hits receive multi-signal fusion bonus.
  const basenamePageInfo = new Map<string, { base: string; idf: number }>();
  for (const base of tokens.basenames) {
    const pageIds = input.store.lookupSymbolPageIds(base, sessionKey);
    const idf = computeIdf(pageIds.length);
    for (const pid of pageIds) {
      const prev = basenamePageInfo.get(pid);
      if (!prev || idf > prev.idf) basenamePageInfo.set(pid, { base, idf });
    }
  }

  const candidates: Candidate[] = [];
  const addOrFuseCandidate = (next: Candidate) => {
    for (const existing of candidates) {
      if (existing.page.id !== next.page.id) continue;
      if (Math.abs(existing.targetLine - next.targetLine) <= 8) {
        // Multi-signal fusion: boost composite score and preserve tighter/fuller span info.
        existing.score += next.score * 0.5;
        if (next.isExplicitPageId) existing.isExplicitPageId = true;
        if (next.hasHighSignal) existing.hasHighSignal = true;
        if (next.hasDeclSpan && !existing.hasDeclSpan) {
          existing.matchedSymbol = next.matchedSymbol;
          existing.targetLine = next.targetLine;
          existing.spanStartLine = next.spanStartLine;
          existing.spanEndLine = next.spanEndLine;
          existing.hasDeclSpan = true;
        }
        return;
      }
    }
    candidates.push(next);
  };

  // Explicit `pg_<hex>` reference (highest confidence, scoped to sessionKey)
  for (const pid of tokens.pageIds) {
    const page = input.store.getPage(pid, sessionKey);
    if (!page) continue;
    const sp = page.symbols[0];
    const hasDecl = Boolean(sp && sp.kind !== 'error' && sp.kind !== 'anchor' && sp.endLine > sp.startLine);
    addOrFuseCandidate({
      page,
      matchedSymbol: pid,
      targetLine: sp?.startLine ?? 1,
      spanStartLine: sp?.startLine ?? 1,
      spanEndLine: sp?.endLine ?? (sp?.startLine ?? 1),
      hasDeclSpan: hasDecl,
      score: 100,
      isExplicitPageId: true,
      hasHighSignal: true,
    });
  }

  // Symbol / declaration / error hits via inverted symbolIndex + IDF weighting
  const symbolMatchedPageIds = new Set<string>();
  for (const sym of tokens.symbols) {
    const pageIds = input.store.lookupSymbolPageIds(sym, sessionKey);
    if (pageIds.length === 0) continue;
    const idf = computeIdf(pageIds.length);
    const symLow = sym.toLowerCase();
    for (const pid of pageIds) {
      const page = input.store.getPage(pid, sessionKey);
      if (!page) continue;
      symbolMatchedPageIds.add(pid);
      const span = page.symbols.find((s) => s.name.toLowerCase() === symLow);
      const isErrorOrAnchor = span?.kind === 'error' || span?.kind === 'anchor';
      const hasDecl = Boolean(span && !isErrorOrAnchor && span.endLine > span.startLine);
      const baseBonus = basenamePageInfo.has(pid) ? 6 : 0;
      const score = (isErrorOrAnchor ? 7 + 2 * idf : 12 + 4 * idf) + baseBonus;
      addOrFuseCandidate({
        page,
        matchedSymbol: span?.name ?? sym,
        targetLine: span?.startLine ?? 1,
        spanStartLine: span?.startLine ?? 1,
        spanEndLine: span?.endLine ?? (span?.startLine ?? 1),
        hasDeclSpan: hasDecl,
        score,
        hasHighSignal: true,
      });
    }
  }

  // Case-insensitive single-word skill name lookup (restricted to `skill-catalog` pages)
  for (const word of tokens.skillWords) {
    const pageIds = input.store.lookupSymbolPageIds(word, sessionKey);
    if (pageIds.length === 0) continue;
    const idf = computeIdf(pageIds.length);
    for (const pid of pageIds) {
      const page = input.store.getPage(pid, sessionKey);
      if (!page || page.toolName !== 'skill-catalog') continue;
      const sp = page.symbols[0];
      addOrFuseCandidate({
        page,
        matchedSymbol: word,
        targetLine: sp?.startLine ?? 1,
        spanStartLine: sp?.startLine ?? 1,
        spanEndLine: sp?.endLine ?? (sp?.startLine ?? 1),
        hasDeclSpan: Boolean(sp && sp.endLine > sp.startLine),
        score: 10 + 3 * idf,
        hasHighSignal: true,
      });
    }
  }

  // File basename fallback hits (for pages matched by path/filename)
  for (const [pid, info] of basenamePageInfo) {
    const page = input.store.getPage(pid, sessionKey);
    if (!page) continue;
    const sp = page.symbols[0];
    const hasDecl = Boolean(sp && sp.kind !== 'error' && sp.kind !== 'anchor' && sp.endLine > sp.startLine);
    addOrFuseCandidate({
      page,
      matchedSymbol: info.base,
      targetLine: sp?.startLine ?? 1,
      spanStartLine: sp?.startLine ?? 1,
      spanEndLine: sp?.endLine ?? (sp?.startLine ?? 1),
      hasDeclSpan: hasDecl,
      score: 4 + 2 * info.idf,
      hasHighSignal: symbolMatchedPageIds.has(pid),
    });
  }

  if (candidates.length === 0) {
    return { text: '', changed: false, slices: [], totalTokens: 0 };
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.page.createdAtMs - a.page.createdAtMs ||
      (a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : 0),
  );

  const wrapperOverheadTokens = 16;
  let usedTokens = wrapperOverheadTokens;
  const emitted: TailHydrationSlice[] = [];
  const emittedChunks: string[] = [];
  const acceptedTargetsByPage = new Map<string, number[]>();

  for (const cand of candidates) {
    if (emitted.length >= maxSlices) break;
    if (!cand.isExplicitPageId && !cand.hasHighSignal && cand.score < 9) continue;
    const { page } = cand;
    const prevTargets = acceptedTargetsByPage.get(page.id);
    if (prevTargets && prevTargets.some((t) => Math.abs(t - cand.targetLine) <= 15)) {
      continue;
    }
    const lines = page.rawText.split('\n');
    const totalLines = lines.length;
    if (totalLines === 0) continue;

    // Enclosing AST/symbol-boundary slicing when span bounds are known; otherwise ±15 window.
    let startLine = cand.hasDeclSpan
      ? Math.max(1, cand.spanStartLine - 2)
      : Math.max(1, cand.targetLine - 15);
    let endLine = cand.hasDeclSpan
      ? Math.min(totalLines, Math.min(cand.spanStartLine + 44, cand.spanEndLine + 2))
      : Math.min(totalLines, cand.targetLine + 15);
    let sliceBody = lines.slice(startLine - 1, endLine).join('\n');
    if (!sliceBody.trim() || isAlreadyVerbatim(page, sliceBody)) continue;
    if (!cand.isExplicitPageId && input.store.isTlbSuppressed(sessionKey, page.id, startLine, endLine, tlbTurn)) {
      continue;
    }

    const label = page.filePath ?? page.refId;
    const makeChunk = (s: number, e: number, body: string) =>
      `--- page ${page.id} (${label} L${s}-${e}, matched "${cand.matchedSymbol}") ---\n${body}`;

    let chunk = makeChunk(startLine, endLine, sliceBody);
    let chunkTokens = countTokensFast(chunk);

    // If a slice exceeds remaining budget, try exact span first, then shrink radius cleanly.
    if (usedTokens + chunkTokens > budgetTokens) {
      const remaining = budgetTokens - usedTokens;
      if (remaining < 48) continue;
      let fitted = false;
      if (cand.hasDeclSpan && cand.spanEndLine <= cand.spanStartLine + 42) {
        const sExact = Math.max(1, cand.spanStartLine);
        const eExact = Math.min(totalLines, cand.spanEndLine);
        const bExact = lines.slice(sExact - 1, eExact).join('\n');
        const cExact = makeChunk(sExact, eExact, bExact);
        const tExact = countTokensFast(cExact);
        if (tExact <= remaining) {
          startLine = sExact;
          endLine = eExact;
          sliceBody = bExact;
          chunk = cExact;
          chunkTokens = tExact;
          fitted = true;
        }
      }
      if (!fitted) {
        let radius = 10;
        while (radius >= 2) {
          const s2 = Math.max(1, cand.targetLine - radius);
          const e2 = Math.min(totalLines, cand.targetLine + radius);
          const b2 = lines.slice(s2 - 1, e2).join('\n');
          const c2 = makeChunk(s2, e2, b2);
          const t2 = countTokensFast(c2);
          if (t2 <= remaining) {
            startLine = s2;
            endLine = e2;
            sliceBody = b2;
            chunk = c2;
            chunkTokens = t2;
            fitted = true;
            break;
          }
          radius = Math.floor(radius / 2);
        }
      }
      if (!fitted) continue;
    }

    usedTokens += chunkTokens;
    const existingTargets = acceptedTargetsByPage.get(page.id);
    if (existingTargets) existingTargets.push(cand.targetLine);
    else acceptedTargetsByPage.set(page.id, [cand.targetLine]);
    emitted.push({
      pageId: page.id,
      refId: page.refId,
      ...(page.filePath !== undefined ? { filePath: page.filePath } : {}),
      matchedSymbol: cand.matchedSymbol,
      startLine,
      endLine,
      text: sliceBody,
      tokens: chunkTokens,
    });
    input.store.recordHydrationLease(sessionKey, page.id, startLine, endLine, tlbTurn);
    emittedChunks.push(chunk);
  }

  if (emitted.length === 0) {
    return { text: '', changed: false, slices: [], totalTokens: 0 };
  }

  const text = `[fiche vm-hydrate]\n${emittedChunks.join('\n')}\n[/fiche vm-hydrate]`;
  const totalTokens = countTokensFast(text);
  input.store.recordTailHydration(totalTokens);
  return {
    text,
    changed: true,
    slices: emitted,
    totalTokens,
  };
}

// ---------------------------------------------------------------------------
// 5. Markovian Causal Episode Folding (`foldMarkovianEpisodes`)
// ---------------------------------------------------------------------------

export interface FoldMarkovianEpisodesArgs {
  readonly blocks: readonly TextEpochBlock[];
  readonly totalMessages: number;
  readonly keepTailMessages?: number;
  readonly sessionKey?: string;
  readonly model?: string;
  readonly sessionCacheCold?: boolean;
  readonly store?: ContextPageStore;
  readonly expectedOutputTokens?: number;
  readonly ttlSec?: number;
  readonly totalPromptTokens?: number;
  /** When true, only replay already-folded sticky episodes without folding new spans. */
  readonly stickyOnly?: boolean;
}

export interface FoldMarkovianEpisodesResult {
  readonly changed: boolean;
  readonly foldedEpisodes: number;
  readonly foldedBlocks: number;
  readonly savedChars: number;
  readonly savedTokens: number;
  readonly episodeIds: readonly string[];
}

const stickyMarkovEpisodes = new Set<string>();
const stickyMarkovSessions = new Set<string>();

/** O(1) check for whether this session has ever folded a Markovian episode. */
export function hasAnyStickyMarkovEpisode(sessionKey?: string): boolean {
  const key = sessionKey?.trim() || 'default';
  return stickyMarkovSessions.has(key) || hasAnyFoldedEpisodeId(sessionKey);
}

/** Test helper: clear sticky Markovian episode seal memory. */
export function clearStickyMarkovEpisodesForTests(): void {
  stickyMarkovEpisodes.clear();
  stickyMarkovSessions.clear();
}

const GIT_COMMIT_HEADER_TAIL_RE = /^\[[^\]\r\n]+\s+[0-9a-f]{7,40}\]$/;
const GIT_FILES_CHANGED_RE = /\b\d+\s+files?\s+changed\b|\b(?:insertions?\(\+\)|deletions?\(-\))\b/i;
const COMMIT_BRACKET_RE = /^\s*\[commit\b[^\]]*\]/im;
const PR_MERGE_RE = /(?:Squashed and merged pull request|Merged pull request)/i;

/** Strict O(N) scan for `[branch deadbeef]` git-commit headers (zero backtracking). */
function hasGitCommitHeader(text: string): boolean {
  let lineStart = 0;
  while (lineStart < text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl >= 0 ? nl : text.length;
    if (text.charCodeAt(lineStart) === 91 /* '[' */) {
      const limit = Math.min(lineEnd, lineStart + 200);
      const close = text.indexOf(']', lineStart + 1);
      if (close > lineStart + 1 && close < limit) {
        if (GIT_COMMIT_HEADER_TAIL_RE.test(text.slice(lineStart, close + 1))) {
          return true;
        }
      }
    }
    if (nl < 0) break;
    lineStart = nl + 1;
  }
  return false;
}

const FAIL_SIGNAL_RE =
  /\b(?:FAIL(?:ED)?|AssertionError|TypeError|SyntaxError|ReferenceError|ERR_[A-Z0-9_]+|exit[_ ]?code[:=\s]+[1-9]\d*|returned [1-9]\d*|[1-9]\d*\s+failed)\b|^\s*×\s+\S|Traceback \(most recent call last\)/im;
const PASS_SUMMARY_RE =
  /(?:Test Files\s+\d+\s+passed|Tests\s+\d+\s+passed|\b\d+\s+passing\b|0 failed|\bAll \d+ tests? passed\b)/i;
const ANY_ACTIVE_FAILURE_RE = /\b(?:[1-9]\d*\s+failed|FAIL(?:ED)?)\b/;

function isGitCommitCheckpoint(text: string): boolean {
  if (COMMIT_BRACKET_RE.test(text)) return true;
  return hasGitCommitHeader(text) && GIT_FILES_CHANGED_RE.test(text);
}

function isPrMergeCheckpoint(text: string): boolean {
  return PR_MERGE_RE.test(text);
}

function isGreenVerificationCheckpoint(text: string, sawPriorFailure: boolean): boolean {
  if (!sawPriorFailure) return false;
  return PASS_SUMMARY_RE.test(text) && !ANY_ACTIVE_FAILURE_RE.test(text);
}

function alreadyFoldedOrCompactedMarker(text: string): boolean {
  return (
    text.startsWith('[fiche causal-episode ') ||
    text.startsWith('[folded into ') ||
    text.startsWith('[fiche cas') ||
    text.startsWith('[fiche epoch-digest') ||
    text.startsWith('[fiche vm-page ') ||
    text.startsWith('[inkling cas') ||
    text.startsWith('[inkling epoch-digest')
  );
}

/**
 * Fold completed intermediate debugging spans preceding Markovian checkpoints
 * (`git commit`, red -> green verification, PR merge) into deterministic causal
 * certificates while preserving the checkpoint block and raw pages in `ContextPageStore`.
 */
export function foldMarkovianEpisodes(args: FoldMarkovianEpisodesArgs): FoldMarkovianEpisodesResult {
  const keepTail = args.keepTailMessages ?? 6;
  const cutoffMsg = args.totalMessages - keepTail;
  if (cutoffMsg <= 1 || args.blocks.length === 0) {
    return {
      changed: false,
      foldedEpisodes: 0,
      foldedBlocks: 0,
      savedChars: 0,
      savedTokens: 0,
      episodeIds: [],
    };
  }

  const closedBlocks = args.blocks
    .filter((b) => b.msgIndex > 0 && b.msgIndex < cutoffMsg)
    .sort((a, b) => a.msgIndex - b.msgIndex);

  if (closedBlocks.length < 4) {
    return {
      changed: false,
      foldedEpisodes: 0,
      foldedBlocks: 0,
      savedChars: 0,
      savedTokens: 0,
      episodeIds: [],
    };
  }

  interface SpanCandidate {
    predecessors: Array<{ block: TextEpochBlock; raw: string; rawTokens: number }>;
    checkpoint: { block: TextEpochBlock; raw: string };
  }

  const episodes: SpanCandidate[] = [];
  let pending: Array<{ block: TextEpochBlock; raw: string; rawTokens: number }> = [];
  let firstFailureIdx = -1;

  for (const block of closedBlocks) {
    const raw = block.getText();
    if (alreadyFoldedOrCompactedMarker(raw)) {
      pending = [];
      firstFailureIdx = -1;
      continue;
    }

    const isCommitOrMerge = isGitCommitCheckpoint(raw) || isPrMergeCheckpoint(raw);
    const isGreen = !isCommitOrMerge && isGreenVerificationCheckpoint(raw, firstFailureIdx >= 0);

    if (isCommitOrMerge || isGreen) {
      const slice = isGreen && firstFailureIdx >= 0 ? pending.slice(firstFailureIdx) : pending;
      const sliceChars = slice.reduce((s, p) => s + p.raw.length, 0);
      if (slice.length >= 3 && sliceChars >= 4000) {
        episodes.push({
          predecessors: slice,
          checkpoint: { block, raw },
        });
      }
      pending = [];
      firstFailureIdx = -1;
      continue;
    }

    if (firstFailureIdx < 0 && FAIL_SIGNAL_RE.test(raw)) {
      firstFailureIdx = pending.length;
    }
    pending.push({ block, raw, rawTokens: countTokensFast(raw) });
  }

  if (episodes.length === 0) {
    return {
      changed: false,
      foldedEpisodes: 0,
      foldedBlocks: 0,
      savedChars: 0,
      savedTokens: 0,
      episodeIds: [],
    };
  }

  const blockTokens = new Map<TextEpochBlock, number>();
  let toolBlockSum = 0;
  let runningPrompt = args.totalPromptTokens ?? 0;
  const computeTotalPrompt = args.totalPromptTokens === undefined;
  for (const b of args.blocks) {
    const tok = countTokensFast(b.getText());
    blockTokens.set(b, tok);
    toolBlockSum += tok;
    if (computeTotalPrompt) runningPrompt += tok;
  }
  const nonToolPromptTokens =
    args.totalPromptTokens !== undefined ? Math.max(0, args.totalPromptTokens - toolBlockSum) : 0;

  const rates = resolvePriceRates(args.model, { promptTokens: 0, ttlSec: args.ttlSec });
  const expectedOut = args.expectedOutputTokens ?? 1000;
  const sessionKey = args.sessionKey?.trim() || 'default';

  let foldedEpisodes = 0;
  let foldedBlocks = 0;
  let totalSavedChars = 0;
  let totalSavedTokens = 0;
  const episodeIds: string[] = [];

  for (const ep of episodes) {
    const signatureSource =
      ep.predecessors.map((p) => `${p.block.refId}:${p.raw.length}:${fnv64Hex(p.raw)}`).join('|') +
      `->${ep.checkpoint.block.refId}:${fnv64Hex(ep.checkpoint.raw)}`;
    const epId = `ep_${fnv64Hex(signatureSource).slice(0, 10)}`;
    const stickyKey = `${sessionKey}\0${args.model ?? ''}\0${args.ttlSec ?? ''}\0${epId}`;
    const alreadySealed =
      stickyMarkovEpisodes.has(stickyKey) || hasFoldedEpisodeId(args.sessionKey, stickyKey);
    if (args.stickyOnly && !alreadySealed) continue;

    // Write the causal certificate into the longest predecessor; skip tiny blocks that would bloat.
    let certIdx = 0;
    for (let k = 1; k < ep.predecessors.length; k++) {
      if (ep.predecessors[k]!.raw.length > ep.predecessors[certIdx]!.raw.length) {
        certIdx = k;
      }
    }
    const continuationMarker = `[folded into ${epId}]`;
    const replaceableIndices: number[] = [certIdx];
    for (let k = 0; k < ep.predecessors.length; k++) {
      if (k !== certIdx && ep.predecessors[k]!.raw.length > continuationMarker.length + 8) {
        replaceableIndices.push(k);
      }
    }
    replaceableIndices.sort((a, b) => a - b);

    const pgIds: string[] = [];
    const touchedSet = new Set<string>();
    const predMeta = new Map<number, { filePath?: string; symbols: MmuSymbolSpan[] }>();

    for (const idx of replaceableIndices) {
      const pred = ep.predecessors[idx]!;
      pgIds.push(pageIdForText(pred.raw));
      const fp = inferFilePath(pred.raw, pred.block.refId);
      if (fp && touchedSet.size < 12) touchedSet.add(fp);
      const syms = extractSymbolSpans(pred.raw);
      predMeta.set(idx, { filePath: fp, symbols: syms });
      for (const s of syms) {
        if (s.kind !== 'error' && s.kind !== 'anchor') {
          touchedSet.add(s.name);
          if (touchedSet.size >= 12) break;
        }
      }
    }

    const touchedSummary = touchedSet.size > 0 ? [...touchedSet].join(', ') : 'none';
    const cpRef = ep.checkpoint.block.refId;
    const formatCertificate = (ids: readonly string[]): string => {
      const pageSummary = ids.length > 0 ? ids.join(', ') : 'none';
      return (
        `[fiche causal-episode ${epId}: folded ${replaceableIndices.length} intermediate debug steps ` +
        `before verified checkpoint ${cpRef}; archived pages: ${pageSummary}; ` +
        `touched symbols/paths: ${touchedSummary}]`
      );
    };
    let certificate = formatCertificate(pgIds);

    if (certificate.length >= ep.predecessors[certIdx]!.raw.length) continue;

    const rawChars = replaceableIndices.reduce((s, idx) => s + ep.predecessors[idx]!.raw.length, 0);
    const rawTok = replaceableIndices.reduce((s, idx) => s + ep.predecessors[idx]!.rawTokens, 0);
    let foldedChars = certificate.length + Math.max(0, replaceableIndices.length - 1) * continuationMarker.length;
    let foldedTok =
      countTokensFast(certificate) +
      Math.max(0, replaceableIndices.length - 1) * countTokensFast(continuationMarker);

    if (foldedChars >= rawChars || foldedTok >= rawTok) continue;

    if (!alreadySealed && args.sessionCacheCold !== true) {
      let downstreamCachedTokens = 0;
      for (const b of args.blocks) {
        if (b.msgIndex >= ep.checkpoint.block.msgIndex && b.msgIndex < args.totalMessages - 2) {
          downstreamCachedTokens += blockTokens.get(b) ?? 0;
        }
      }
      if (nonToolPromptTokens > 0 && args.totalMessages > 2) {
        const spanRatio = Math.max(
          0,
          Math.min(1, (args.totalMessages - 2 - ep.predecessors[0]!.block.msgIndex) / Math.max(1, args.totalMessages)),
        );
        downstreamCachedTokens += Math.round(nonToolPromptTokens * spanRatio);
      }
      const savedTok = rawTok - foldedTok;
      const savedPerRead = savedTok * rates.read;
      const transitionCost =
        foldedTok * rates.write -
        rawTok * rates.read +
        downstreamCachedTokens * (rates.write - rates.read);
      const paybackReads =
        savedPerRead > 0 ? Math.ceil(Math.max(0, transitionCost) / savedPerRead) : Infinity;

      const cliff = evaluateCliffAvoidance(args.model, {
        promptTokensBefore: runningPrompt,
        promptTokensAfter: Math.max(0, runningPrompt - savedTok),
        collapsedBaselineTokens: rawTok,
        collapsedActualTokens: foldedTok,
        downstreamCachedTokens,
        expectedOutputTokens: expectedOut,
        ttlSec: args.ttlSec,
      });
      const cliffWins = Boolean(cliff?.crossesCliff && cliff.netSingleTurnUsd > 0);
      const effectiveMaxPayback = computeHorizonPaybackLimit({
        turnsObserved: Math.max(1, Math.floor(args.totalMessages / 2)),
        baseMaxPayback: 12,
        downstreamCachedTokens,
      });
      if (paybackReads > effectiveMaxPayback && !cliffWins) continue;
    }

    // Archive raw pages into ContextPageStore ONLY after payback gate passes,
    // and emit only actually-resident page IDs in the certificate.
    if (args.store) {
      const residentIds: string[] = [];
      for (const idx of replaceableIndices) {
        const pred = ep.predecessors[idx]!;
        const meta = predMeta.get(idx);
        const stored = args.store.storePage({
          sessionKey,
          refId: pred.block.refId,
          toolName: pred.block.toolName,
          filePath: meta?.filePath,
          rawText: pred.raw,
        });
        if (args.store.getPage(stored.id, sessionKey)) {
          residentIds.push(stored.id);
        }
      }
      if (residentIds.length !== pgIds.length) {
        certificate = formatCertificate(residentIds);
        if (certificate.length >= ep.predecessors[certIdx]!.raw.length) continue;
        foldedChars = certificate.length + Math.max(0, replaceableIndices.length - 1) * continuationMarker.length;
        foldedTok =
          countTokensFast(certificate) +
          Math.max(0, replaceableIndices.length - 1) * countTokensFast(continuationMarker);
        if (foldedChars >= rawChars || foldedTok >= rawTok) continue;
      }
    }

    // Apply fold across replaced predecessor blocks; checkpoint block stays untouched.
    ep.predecessors[certIdx]!.block.setText(certificate);
    for (const idx of replaceableIndices) {
      if (idx !== certIdx) {
        ep.predecessors[idx]!.block.setText(continuationMarker);
      }
    }

    if (stickyMarkovEpisodes.size >= STICKY_EPISODE_CAP && !stickyMarkovEpisodes.has(stickyKey)) {
      const oldest = stickyMarkovEpisodes.values().next().value;
      if (oldest !== undefined) stickyMarkovEpisodes.delete(oldest);
    }
    stickyMarkovEpisodes.add(stickyKey);
    stickyMarkovSessions.add(sessionKey);
    recordFoldedEpisodeId(args.sessionKey, stickyKey);

    const savedChars = rawChars - foldedChars;
    const savedTokens = rawTok - foldedTok;
    foldedEpisodes += 1;
    foldedBlocks += replaceableIndices.length;
    totalSavedChars += savedChars;
    totalSavedTokens += savedTokens;
    runningPrompt = Math.max(0, runningPrompt - savedTokens);
    episodeIds.push(epId);
    args.store?.recordMarkovFold(savedChars);
  }

  return {
    changed: foldedEpisodes > 0,
    foldedEpisodes,
    foldedBlocks,
    savedChars: totalSavedChars,
    savedTokens: totalSavedTokens,
    episodeIds,
  };
}

// ---------------------------------------------------------------------------
// 6. Session-Pinned Semantic Capability & Skill Linker (`linkSessionSkills`)
// ---------------------------------------------------------------------------

export interface PinnedSkillStore {
  get(sessionKey: string, catalogHash: string): readonly string[] | undefined;
  set(sessionKey: string, catalogHash: string, skills: readonly string[]): void;
}

export interface LinkSessionSkillsInput {
  readonly text: string;
  readonly firstUserText: string;
  readonly sessionKey?: string;
  readonly store?: ContextPageStore;
  readonly pinnedStore?: PinnedSkillStore;
  readonly maxVerbatim?: number;
  readonly minSkills?: number;
  readonly alwaysKeep?: readonly string[];
  readonly workspaceHints?: readonly string[];
}

export interface LinkSessionSkillsResult {
  readonly text: string;
  readonly changed: boolean;
  readonly catalogHash?: string;
  readonly keptSkills: readonly string[];
  readonly stubbedSkills: readonly string[];
  readonly savedChars: number;
  readonly savedTokens: number;
}

interface ParsedSkillEntry {
  readonly name: string;
  readonly skillPath?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly rawEntry: string;
  readonly catalogIndex: number;
}

const DEFAULT_CORE_SKILLS = new Set(['accidental-data-loss-prevention', 'fiche']);
const SKILL_ENTRY_HEAD_RE = /^-\s+([A-Za-z0-9][A-Za-z0-9._-]{1,80})(?:\s+\(([^)\n]+)\))?\s*:\s*(.*)$/;
const SKILL_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'use', 'when', 'you', 'are',
  'not', 'can', 'will', 'any', 'all', 'into', 'your', 'about', 'have', 'only', 'user',
]);

function tokenizeQueryWords(text: string): string[] {
  const out = new Set<string>();
  const spaced = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  for (const part of spaced.split(/[^a-z0-9]+/)) {
    if (part.length >= 2 && !SKILL_STOPWORDS.has(part)) {
      out.add(part);
    }
  }
  // Also preserve common extension signals (.sqlx -> sqlx, .tf -> terraform, etc.)
  const lower = text.toLowerCase();
  if (lower.includes('.sqlx') || lower.includes('sqlx')) out.add('dataform');
  if (lower.includes('.ipynb')) out.add('notebook');
  if (lower.includes('.py')) out.add('python');
  if (lower.includes('.tf')) out.add('terraform');
  if (lower.includes('dockerfile')) out.add('docker');
  return [...out];
}

function parseSkillCatalogEntries(lines: readonly string[]): ParsedSkillEntry[] {
  const entries: ParsedSkillEntry[] = [];
  let currentStart = -1;
  let currentName = '';
  let currentPath: string | undefined;
  let inSkillsXml = false;
  let inAvailableHeader = false;

  const flushCurrent = (endLineExclusive: number) => {
    if (currentStart < 0) return;
    // Trim trailing blank lines out of the entry so separator spacing stays intact
    let last = endLineExclusive - 1;
    while (last > currentStart && lines[last]!.trim() === '') {
      last -= 1;
    }
    entries.push({
      name: currentName,
      ...(currentPath ? { skillPath: currentPath } : {}),
      startLine: currentStart,
      endLine: last,
      rawEntry: lines.slice(currentStart, last + 1).join('\n'),
      catalogIndex: entries.length,
    });
    currentStart = -1;
    currentName = '';
    currentPath = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '<skills>' || /^Available skills:\s*$/i.test(trimmed)) {
      if (trimmed === '<skills>') inSkillsXml = true;
      else inAvailableHeader = true;
      continue;
    }
    if (trimmed === '</skills>') {
      flushCurrent(i);
      inSkillsXml = false;
      inAvailableHeader = false;
      continue;
    }

    const headMatch = SKILL_ENTRY_HEAD_RE.exec(line);
    if (headMatch && (inSkillsXml || inAvailableHeader || (headMatch[2] !== undefined && /SKILL\.md$/i.test(headMatch[2])))) {
      flushCurrent(i);
      currentStart = i;
      currentName = headMatch[1]!;
      currentPath = headMatch[2]?.trim();
      continue;
    }

    if (currentStart >= 0) {
      // Detect clean end of skill list outside `<skills>` block
      if (!inSkillsXml && /^<\/[A-Za-z_][\w-]*>$/.test(trimmed)) {
        flushCurrent(i);
        inAvailableHeader = false;
        continue;
      }
      if (!inSkillsXml && /^#{1,3}\s+\S/.test(trimmed)) {
        flushCurrent(i);
        inAvailableHeader = false;
        continue;
      }
      if (!inSkillsXml && i > 0 && lines[i - 1]!.trim() === '' && trimmed !== '' && !/^(?:\s|[-*]|\d+\.)/.test(line)) {
        // Peek ahead up to 12 lines: if no new `- skill-name` entry follows, section ended
        let moreSkills = false;
        for (let k = i + 1; k < Math.min(lines.length, i + 15); k++) {
          if (SKILL_ENTRY_HEAD_RE.test(lines[k]!)) {
            moreSkills = true;
            break;
          }
        }
        if (!moreSkills) {
          flushCurrent(i);
          inAvailableHeader = false;
        }
      }
    }
  }
  flushCurrent(lines.length);
  return entries;
}

/**
 * Stub low-relevance skill descriptions in large skill catalogs (`>= 10` skills),
 * pinning Turn-1 selection per `(sessionKey, catalogHash)` and archiving full entries
 * in `ContextPageStore` so mentioning a stubbed skill on Turn N triggers tail hydration.
 */
export function linkSessionSkills(input: LinkSessionSkillsInput): LinkSessionSkillsResult {
  const minSkills = Math.max(1, input.minSkills ?? 10);
  const maxVerbatim = Math.max(0, input.maxVerbatim ?? 6);
  const noop: LinkSessionSkillsResult = {
    text: input.text,
    changed: false,
    keptSkills: [],
    stubbedSkills: [],
    savedChars: 0,
    savedTokens: 0,
  };
  if (!input.text || !input.store) return noop;

  const lines = input.text.split('\n');
  const entries = parseSkillCatalogEntries(lines);
  if (entries.length < minSkills) return noop;

  const catalogHash = fnv64Hex(entries.map((e) => `${e.name}\0${e.rawEntry}`).join('\n'));
  const sessionKey = input.sessionKey && input.sessionKey.trim() ? input.sessionKey.trim() : 'default';

  const coreSet = new Set<string>(DEFAULT_CORE_SKILLS);
  if (input.alwaysKeep) {
    for (const k of input.alwaysKeep) coreSet.add(k.trim());
  }

  let keptNames: Set<string>;
  let shouldPinSelected = false;
  let toPin: string[] = [];
  const pinnedList = input.pinnedStore?.get(sessionKey, catalogHash);
  if (pinnedList && pinnedList.length > 0) {
    keptNames = new Set(pinnedList);
    for (const c of coreSet) keptNames.add(c);
  } else {
    const querySource = [input.firstUserText, ...(input.workspaceHints ?? [])].join(' ');
    const queryTokens = tokenizeQueryWords(querySource);
    const queryLower = querySource.toLowerCase();

    const scoredNonCore: Array<{ entry: ParsedSkillEntry; score: number }> = [];
    keptNames = new Set<string>();

    for (const entry of entries) {
      if (coreSet.has(entry.name)) {
        keptNames.add(entry.name);
        continue;
      }
      let score = 0;
      const nameLower = entry.name.toLowerCase();
      const bodyLower = entry.rawEntry.toLowerCase();
      if (queryLower.includes(nameLower)) score += 100;

      const nameParts = nameLower.split(/[-_.]+/);
      for (const qt of queryTokens) {
        if (nameParts.includes(qt)) score += 20;
        else if (bodyLower.includes(qt)) score += 3;
      }
      scoredNonCore.push({ entry, score });
    }

    scoredNonCore.sort((a, b) => b.score - a.score || a.entry.catalogIndex - b.entry.catalogIndex);
    for (let i = 0; i < Math.min(maxVerbatim, scoredNonCore.length); i++) {
      keptNames.add(scoredNonCore[i]!.entry.name);
    }

    toPin = entries.filter((e) => keptNames.has(e.name)).map((e) => e.name);
    shouldPinSelected = true;
  }

  const entryByStart = new Map<number, ParsedSkillEntry>();
  for (const entry of entries) entryByStart.set(entry.startLine, entry);

  const outLines: string[] = [];
  const keptSkills: string[] = [];
  const stubbedEntries: Array<{ entry: ParsedSkillEntry; pageId: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const entry = entryByStart.get(i);
    if (!entry) {
      outLines.push(lines[i]!);
      continue;
    }
    if (keptNames.has(entry.name)) {
      keptSkills.push(entry.name);
      outLines.push(entry.rawEntry);
    } else {
      const pgId = pageIdForText(entry.rawEntry);
      stubbedEntries.push({ entry, pageId: pgId });
      outLines.push(`- ${entry.name} [${pgId}] (stubbed; mention name to auto-hydrate)`);
    }
    i = entry.endLine;
  }

  if (stubbedEntries.length === 0) return noop;

  const rewritten = outLines.join('\n');
  const savedChars = input.text.length - rewritten.length;
  if (savedChars < 400) return noop;

  const savedTokens = countTokensFast(input.text) - countTokensFast(rewritten);
  if (savedTokens < 100) return noop;

  if (shouldPinSelected) {
    input.pinnedStore?.set(sessionKey, catalogHash, toPin);
  }

  // Commit stubbed entries into ContextPageStore ONLY after threshold check succeeds
  for (const { entry } of stubbedEntries) {
    input.store.storePage({
      sessionKey,
      refId: `skill:${entry.name}`,
      toolName: 'skill-catalog',
      filePath: entry.skillPath,
      rawText: entry.rawEntry,
      extraSymbols: [entry.name],
    });
  }
  input.store.recordSkillStub(stubbedEntries.length, savedChars);

  return {
    text: rewritten,
    changed: true,
    catalogHash,
    keptSkills,
    stubbedSkills: stubbedEntries.map((s) => s.entry.name),
    savedChars,
    savedTokens,
  };
}

// ---------------------------------------------------------------------------
// 7. Birth-Time Information-Density Pruner (`pruneLowDensityBlob`)
// ---------------------------------------------------------------------------

export interface PruneLowDensityOptions {
  readonly store?: ContextPageStore;
  readonly sessionKey?: string;
  readonly refId?: string;
  readonly toolName?: string;
  readonly minChars?: number;
  readonly targetDropRatio?: number;
}

export interface PruneLowDensityResult {
  readonly text: string;
  readonly changed: boolean;
  readonly pageId?: string;
  readonly prunedLines: number;
  readonly totalLines: number;
  readonly savedChars: number;
}

const HEADING_RE = /^#{1,6}\s+\S/;
const URL_RE = /https?:\/\/[^\s)>'"]+/;
const FILE_PATH_RE =
  /(?:(?:^|[\s(`"'])(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,8}(?:$|[\s)`"':,])|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|swift|sql|yaml|yml|json|toml|md)(?::\d+(?::\d+)?)?\b)/i;
const STACK_PREFIX_RE = /^(?:at\s+\S+\s*\(|Caused by:|File\s+"[^"\n]+",\s+line\s+\d+|Traceback\s+\(most recent call last\))/;
const BACKTICK_ID_RE = /`[^`\n]{2,60}`/;
const NUMBER_RE = /\b\d+(?:\.\d+)?%?\b/;
const BULLET_KEY_RE = /^[-*]\s+(?:\*\*[^*\n]{2,40}\*\*|[A-Za-z0-9 _-]{2,30}:)/;

const STRUCTURED_LOG_RE =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\[(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\])/;
const DIFF_LINE_RE = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|\*\*\* (?:Begin Patch|Update File:|Add File:))/;
const YAML_KV_RE = /^[ \t]*(?:-\s+)?[A-Za-z_][\w.-]*:[ \t]*\S/;

function looksLikeJsonText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const first = trimmed.charCodeAt(0);
  const last = trimmed.charCodeAt(trimmed.length - 1);
  if ((first === 123 && last === 125) || (first === 91 && last === 93)) return true;
  // Detect HTTP-header-prefixed JSON bodies (e.g., `HTTP/1.1 200 OK\n...\n\n{...}`)
  if (last === 125 || last === 93) {
    const lines = trimmed.split('\n', 24);
    if (/^HTTP\/\d/.test(lines[0] ?? '')) {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]!.trim() === '' && i + 1 < lines.length) {
          const bodyChar = lines[i + 1]!.trimStart().charCodeAt(0);
          if (bodyChar === 123 || bodyChar === 91) return true;
        }
      }
    }
  }
  return false;
}

function isNonProseBlob(text: string, lines: readonly string[]): boolean {
  if (text.startsWith('@toon ') || text.includes('[Drain ') || looksLikeJsonText(text)) return true;

  let codeHints = 0;
  let logHints = 0;
  let gutterHints = 0;
  let yamlHints = 0;
  let nonEmpty = 0;
  const sample = Math.min(lines.length, 60);

  for (let i = 0; i < sample; i++) {
    const l = lines[i]!;
    const trimmed = l.trim();
    if (!trimmed) continue;
    nonEmpty += 1;
    if (DIFF_LINE_RE.test(trimmed)) return true;
    if (GUTTER_EXPLICIT_RE.test(l) || GUTTER_COLON_RE.test(l) || /^\s+\d{1,7}\t/.test(l)) gutterHints += 1;
    if (STRUCTURED_LOG_RE.test(trimmed)) logHints += 1;
    if (YAML_KV_RE.test(l)) yamlHints += 1;
    if (/^(?:export\s+|import\s+|from\s+\S+\s+import\b|(?:async\s+)?(?:function|def|fn|func|class|interface|struct|enum)\s+[A-Za-z_])/.test(trimmed)) {
      codeHints += 1;
    }
  }
  if (gutterHints >= 5 || codeHints >= 3) return true;
  if (nonEmpty > 0 && logHints / nonEmpty >= 0.4) return true;
  if (nonEmpty >= 8 && yamlHints / nonEmpty >= 0.45) return true;
  return false;
}

function extractLineRarityWords(line: string): string[] {
  const words: string[] = [];
  let start = -1;
  for (let i = 0; i <= line.length; i++) {
    const c = i < line.length ? line.charCodeAt(i) : 32;
    const isWord = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
    if (isWord) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const len = i - start;
      if (len >= 3 && len <= 40) {
        words.push(line.slice(start, i).toLowerCase());
      }
      start = -1;
      if (words.length >= 48) break;
    }
  }
  return words;
}

/**
 * Deterministic, pure-TS `<3ms` birth-time extractive pruner for large
 * unstructured prose/web blobs (`>= 4,000` chars). Archives full raw text in
 * `ContextPageStore` and drops the bottom redundant lines (~45%–55% reduction).
 */
export function pruneLowDensityBlob(
  text: string,
  opts: PruneLowDensityOptions = {},
): PruneLowDensityResult {
  const minChars = opts.minChars ?? 4000;
  const targetDropRatio = Math.min(0.65, Math.max(0.3, opts.targetDropRatio ?? 0.5));
  const totalLines = countLines(text);

  if (!text || text.length < minChars) {
    return { text, changed: false, prunedLines: 0, totalLines, savedChars: 0 };
  }
  if (text.includes('low-density lines pruned; raw in pg_') || text.startsWith('[fiche ')) {
    return { text, changed: false, prunedLines: 0, totalLines, savedChars: 0 };
  }

  const lines = text.split('\n');
  if (lines.length < 12 || isNonProseBlob(text, lines)) {
    return { text, changed: false, prunedLines: 0, totalLines: lines.length, savedChars: 0 };
  }

  const n = lines.length;
  const wordIdMap = new Map<string, number>();
  const dfCounts: number[] = [];
  const uniqLineWordIds: Int32Array[] = new Array(n);

  // Pass 1: document-frequency scan + integer-indexed unique rarity words per line (O(N))
  for (let i = 0; i < n; i++) {
    const words = extractLineRarityWords(lines[i]!);
    if (words.length === 0) {
      uniqLineWordIds[i] = EMPTY_I32;
      continue;
    }
    const ids: number[] = [];
    for (let k = 0; k < words.length; k++) {
      const w = words[k]!;
      let id = wordIdMap.get(w);
      if (id === undefined) {
        if (wordIdMap.size >= 8192) continue;
        id = dfCounts.length;
        wordIdMap.set(w, id);
        dfCounts.push(0);
      }
      let dup = false;
      for (let j = 0; j < ids.length; j++) {
        if (ids[j] === id) {
          dup = true;
          break;
        }
      }
      if (!dup) {
        ids.push(id);
        dfCounts[id]! += 1;
      }
    }
    uniqLineWordIds[i] = ids.length > 0 ? Int32Array.from(ids) : EMPTY_I32;
  }

  const wordCount = dfCounts.length;
  const wordIdf = new Float64Array(wordCount);
  for (let id = 0; id < wordCount; id++) {
    wordIdf[id] = Math.log(1 + n / (1 + dfCounts[id]!));
  }

  // Pass 2: seed submodular coverage from fixed head-4 + tail-4 lines
  const seenNormalized = new Set<string>();
  const keep = new Uint8Array(n);
  let keptChars = 0;
  const covered = new Uint16Array(wordCount);
  const addCoverage = (ids: Int32Array): void => {
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      covered[id] = (covered[id]! + 1) & 0xffff;
    }
  };

  for (let i = 0; i < Math.min(4, n); i++) {
    keep[i] = 1;
    keptChars += lines[i]!.length + 1;
    addCoverage(uniqLineWordIds[i]!);
  }
  for (let i = Math.max(4, n - 4); i < n; i++) {
    keep[i] = 1;
    keptChars += lines[i]!.length + 1;
    addCoverage(uniqLineWordIds[i]!);
  }

  const computeGain = (structScore: number, ids: Int32Array): number => {
    if (ids.length === 0) return structScore;
    let sum = 0;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      const c = covered[id]!;
      if (c < 32) sum += wordIdf[id]! * POW_HALF[c]!;
    }
    return structScore + 1.5 * sum;
  };

  interface HeapItem {
    readonly idx: number;
    readonly chars: number;
    readonly structScore: number;
    readonly uniqIds: Int32Array;
    gain: number;
    evalVersion: number;
  }

  const heap: HeapItem[] = [];
  const lineScores = new Float32Array(n);

  for (let i = 4; i < n - 4; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const head = trimmed.length > MAX_LINE_SCAN_CHARS ? trimmed.slice(0, MAX_LINE_SCAN_CHARS) : trimmed;

    if (!trimmed) {
      lineScores[i] = -10;
      continue;
    }

    let structScore = 0;
    if (HEADING_RE.test(head)) structScore += 10;
    if (STACK_PREFIX_RE.test(head)) structScore += 7;
    if (ERROR_TOKEN_RE.test(head) || /\b(?:error|exception|fatal|warn|failed|timeout|http\s*[45]\d\d)\b/i.test(head)) {
      structScore += 6;
    }
    if (URL_RE.test(head)) structScore += 5;
    if (FILE_PATH_RE.test(head)) structScore += 5;
    if (BACKTICK_ID_RE.test(head)) structScore += 4;
    if (NUMBER_RE.test(head)) structScore += 2.5;
    if (BULLET_KEY_RE.test(head)) structScore += 2;

    if (trimmed.length < 15 && structScore < 4) structScore -= 2;
    const norm = trimmed.toLowerCase();
    if (seenNormalized.has(norm)) structScore -= 5;
    else if (seenNormalized.size < 4096) seenNormalized.add(norm);

    const uniqIds = uniqLineWordIds[i]!;
    const initialGain = computeGain(structScore, uniqIds);
    lineScores[i] = initialGain;
    if (initialGain > -5) {
      heap.push({
        idx: i,
        chars: line.length + 1,
        structScore,
        uniqIds,
        gain: initialGain,
        evalVersion: 0,
      });
    }
  }

  const higherPriority = (a: HeapItem, b: HeapItem): boolean =>
    a.gain > b.gain || (a.gain === b.gain && a.idx < b.idx);

  const siftDown = (arr: HeapItem[], startIdx: number): void => {
    let idx = startIdx;
    const len = arr.length;
    while (true) {
      const left = (idx << 1) + 1;
      if (left >= len) break;
      const right = left + 1;
      let best = left;
      if (right < len && higherPriority(arr[right]!, arr[left]!)) {
        best = right;
      }
      if (!higherPriority(arr[best]!, arr[idx]!)) break;
      const tmp = arr[idx]!;
      arr[idx] = arr[best]!;
      arr[best] = tmp;
      idx = best;
    }
  };

  const heapPush = (arr: HeapItem[], item: HeapItem): void => {
    let idx = arr.length;
    arr.push(item);
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!higherPriority(arr[idx]!, arr[parent]!)) break;
      const tmp = arr[parent]!;
      arr[parent] = arr[idx]!;
      arr[idx] = tmp;
      idx = parent;
    }
  };

  const heapPop = (arr: HeapItem[]): HeapItem => {
    const top = arr[0]!;
    const last = arr.pop()!;
    if (arr.length > 0) {
      arr[0] = last;
      siftDown(arr, 0);
    }
    return top;
  };

  for (let idx = (heap.length >> 1) - 1; idx >= 0; idx--) {
    siftDown(heap, idx);
  }

  // Minoux Lazy Greedy Submodular Maximization
  const targetKeepChars = Math.floor(text.length * (1 - targetDropRatio));
  const maxReevals = n * 4;
  let acceptedVersion = 0;
  let reevals = 0;

  while (heap.length > 0 && keptChars < targetKeepChars) {
    const top = heapPop(heap);
    let curGain = top.gain;
    if (top.evalVersion !== acceptedVersion && reevals < maxReevals) {
      curGain = computeGain(top.structScore, top.uniqIds);
      top.evalVersion = acceptedVersion;
      reevals += 1;
    }
    const isMax = heap.length === 0 || curGain >= heap[0]!.gain - 1e-6;
    if (isMax || reevals >= maxReevals) {
      if (curGain <= -5) {
        if (isMax) break;
        continue;
      }
      keep[top.idx] = 1;
      lineScores[top.idx] = curGain;
      keptChars += top.chars;
      addCoverage(top.uniqIds);
      acceptedVersion += 1;
    } else {
      top.gain = curGain;
      heapPush(heap, top);
    }
  }

  // Coalesce low-value 1-line kept islands; never drop high-signal headings, errors, stacks, paths, URLs, or backticks.
  for (let i = 4; i < n - 4; i++) {
    if (
      keep[i] === 1 &&
      keep[i - 1] === 0 &&
      keep[i + 1] === 0 &&
      lines[i]!.length <= 64 &&
      lineScores[i]! < 4
    ) {
      keep[i] = 0;
    }
  }

  const pageId = pageIdForText(text);
  const outParts: string[] = [];
  let prunedLines = 0;
  let i = 0;
  while (i < n) {
    if (keep[i] === 1) {
      outParts.push(lines[i]!);
      i += 1;
      continue;
    }
    const startDrop = i;
    while (i < n && keep[i] === 0) i += 1;
    const dropped = i - startDrop;
    prunedLines += dropped;
    outParts.push(`[... ${dropped} low-density lines pruned; raw in ${pageId} ...]`);
  }

  const out = outParts.join('\n');
  const savedChars = text.length - out.length;
  if (prunedLines === 0 || savedChars < 1000 || savedChars < text.length * 0.25) {
    return { text, changed: false, prunedLines: 0, totalLines: n, savedChars: 0 };
  }

  if (opts.store) {
    const targetSessionKey = opts.sessionKey?.trim() || 'default';
    const storedPage = opts.store.storePage({
      sessionKey: targetSessionKey,
      refId: opts.refId ?? 'prose-blob',
      toolName: opts.toolName,
      rawText: text,
    });
    if (!opts.store.getPage(storedPage.id, targetSessionKey)) {
      return { text, changed: false, prunedLines: 0, totalLines: n, savedChars: 0 };
    }
    opts.store.recordDensityPrune(savedChars);
  }

  return {
    text: out,
    changed: true,
    pageId,
    prunedLines,
    totalLines: n,
    savedChars,
  };
}
