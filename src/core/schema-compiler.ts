/**
 * TSCG: Deterministic Tool-Schema & Static-Prompt Compiler.
 *
 * Grounded in:
 *  - TSCG (2026): lossless schema metadata compilation removes bloat ($schema,
 *    $comment, redundant titles, decorative whitespace, cross-tool repeated
 *    boilerplate) without altering tool names, parameter types, required fields,
 *    enums, constraints, or strictness.
 *  - CAPC (2026): strictly query-agnostic so compiled static prefixes produce
 *    identical bytes across every turn of a session (zero prefix-cache busts).
 *
 * Workers-safe: zero `node:` imports.
 */

import { gptTokenCount, hasLongUnbrokenBpeChunk } from './gpt-tokens.js';

export type ToolSchemaWire = 'anthropic' | 'openai_chat' | 'openai_responses' | 'google';

export interface CompileResult {
  readonly changed: boolean;
  readonly savedChars: number;
  readonly savedTokens: number;
  readonly schemaDagFactored?: boolean;
}

export interface CompileTextResult extends CompileResult {
  readonly text: string;
}

const TOKEN_EXACT_LIMIT = 32_000;
const DIVIDER_LINE_RE = /^[ \t]*[-=*_~─━═]{4,}[ \t]*$/;
const PROTECTED_SYS_LINE_RE = /^(?:You are Claude Code\b|You are a Claude agent, built on Anthropic's Claude Agent SDK\.|x-anthropic-billing-header:)/;
const COMPILER_CACHE_MAX_CHARS = 4 * 1024 * 1024;

const toolSchemaCache = new Map<string, { result: CompileResult; compiledJson?: string }>();
let toolSchemaCacheChars = 0;
const staticTextCache = new Map<string, CompileTextResult>();
let staticTextCacheChars = 0;
const segmentedStaticPatternCache = new Map<string, { readonly compiledStatic: readonly string[]; readonly origStaticChars: number; readonly savedChars: number }>();
let segmentedStaticPatternCacheChars = 0;

const VOLATILE_XML_TAGS = new Set<string>([
  'env',
  'context',
  'system-reminder',
  'fast_mode_info',
  'git_status',
  'additional_metadata',
]);
const VOLATILE_ATTR_SCAN_LIMIT = 1024;

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

function normAlpha(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** O(N) HTML comment stripper avoiding O(N^2) backtracking on unclosed `<!--`. */
function stripHtmlComments(s: string): string {
  const first = s.indexOf('<!--');
  if (first < 0) return s;
  let out = '';
  let pos = 0;
  let open = first;
  while (open >= 0) {
    const close = s.indexOf('-->', open + 4);
    if (close < 0) break;
    if (open > pos) out += s.slice(pos, open);
    pos = close + 3;
    open = s.indexOf('<!--', pos);
  }
  if (pos === 0) return s;
  if (pos < s.length) out += s.slice(pos);
  return out;
}

interface TextSegment {
  readonly fence: boolean;
  readonly text: string;
}

/**
 * Split text into unfenced prose vs fenced code blocks (``` or ~~~) using a strict
 * CommonMark line scanner. Unclosed fences protect the remainder verbatim.
 */
function splitCodeFences(raw: string): TextSegment[] {
  if (!raw.includes('```') && !raw.includes('~~~')) {
    return [{ fence: false, text: raw }];
  }
  const lines = raw.split('\n');
  const out: TextSegment[] = [];
  let buf: string[] = [];
  let openChar = '';
  let openLen = 0;

  const flush = (fence: boolean) => {
    if (buf.length === 0) return;
    out.push({ fence, text: buf.join('\n') });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmedStart = line.replace(/^[ \t]{0,3}/, '');
    const ch = trimmedStart[0];
    let run = 0;
    if (ch === '`' || ch === '~') {
      while (trimmedStart[run] === ch) run++;
    }
    const isBacktickInline = ch === '`' && trimmedStart.indexOf('`', run) >= 0;
    if (!openChar && run >= 3 && !isBacktickInline) {
      // Flush preceding prose lines with trailing newline delimiter preserved between segments.
      flush(false);
      openChar = ch!;
      openLen = run;
      buf.push(line);
      continue;
    }
    if (
      openChar &&
      ch === openChar &&
      run >= openLen &&
      trimmedStart.slice(run).trim() === ''
    ) {
      buf.push(line);
      flush(true);
      openChar = '';
      openLen = 0;
      continue;
    }
    buf.push(line);
  }
  flush(Boolean(openChar));
  return out;
}

export interface VolatileXmlIsland {
  readonly volatile: boolean;
  readonly text: string;
}

function isXmlWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function isXmlTagChar(c: number): boolean {
  return (
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === 45 ||
    c === 95
  );
}

function asciiEqualsIgnoreCase(text: string, start: number, lowerTarget: string): boolean {
  if (text.length - start < lowerTarget.length) return false;
  for (let i = 0; i < lowerTarget.length; i++) {
    let c = text.charCodeAt(start + i);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== lowerTarget.charCodeAt(i)) return false;
  }
  return true;
}

function buildNonProseSkipRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const len = text.length;
  let pos = 0;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceStart = -1;

  while (pos < len) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl < 0 ? len : nl;
    const line = text.slice(pos, lineEnd);
    const trimmed = line.replace(/^[ \t]{0,3}/, '');
    const ch = trimmed[0];
    let run = 0;
    if (ch === '`' || ch === '~') {
      while (trimmed[run] === ch) run++;
    }
    const isInlineFence = ch === '`' && trimmed.indexOf('`', run) >= 0;

    if (!fenceChar && run >= 3 && !isInlineFence) {
      fenceChar = ch!;
      fenceLen = run;
      fenceStart = pos;
    } else if (fenceChar && ch === fenceChar && run >= fenceLen && trimmed.slice(run).trim() === '') {
      ranges.push([fenceStart, nl < 0 ? len : nl + 1]);
      fenceChar = '';
      fenceLen = 0;
      fenceStart = -1;
    } else if (!fenceChar && line.includes('`')) {
      // Mask single-line inline backtick spans so prose mentions like `<system-reminder>` are skipped.
      let bi = pos;
      while (bi < lineEnd) {
        if (text.charCodeAt(bi) === 96) {
          let openRun = 0;
          while (bi + openRun < lineEnd && text.charCodeAt(bi + openRun) === 96) openRun++;
          let closePos = -1;
          let search = bi + openRun;
          while (search < lineEnd) {
            if (text.charCodeAt(search) === 96) {
              let closeRun = 0;
              while (search + closeRun < lineEnd && text.charCodeAt(search + closeRun) === 96) closeRun++;
              if (closeRun === openRun) {
                closePos = search + closeRun;
                break;
              }
              search += closeRun;
            } else {
              search++;
            }
          }
          if (closePos >= 0) {
            ranges.push([bi, closePos]);
            bi = closePos;
            continue;
          }
          bi += openRun;
        } else {
          bi++;
        }
      }
    }
    pos = nl < 0 ? len : nl + 1;
  }
  if (fenceChar && fenceStart >= 0) {
    ranges.push([fenceStart, len]);
  }
  return ranges;
}

function advancePastSkipRange(ranges: readonly [number, number][], idx: number, pos: number): { idx: number; skipEnd: number } {
  let i = idx;
  while (i < ranges.length && ranges[i]![1] <= pos) i++;
  if (i < ranges.length && pos >= ranges[i]![0] && pos < ranges[i]![1]) {
    return { idx: i + 1, skipEnd: ranges[i]![1] };
  }
  return { idx: i, skipEnd: -1 };
}

function parseOpenTagHead(
  text: string,
  lt: number,
  targetLower?: string,
): { tagLower: string; openEnd: number; selfClosing: boolean } | undefined {
  const len = text.length;
  let nameEnd = lt + 1;
  while (nameEnd < len && nameEnd - (lt + 1) <= 24 && isXmlTagChar(text.charCodeAt(nameEnd))) {
    nameEnd++;
  }
  const nameLen = nameEnd - (lt + 1);
  if (nameLen === 0 || nameLen > 24 || nameEnd >= len) return undefined;

  const tagLower = text.slice(lt + 1, nameEnd).toLowerCase();
  if (targetLower !== undefined) {
    if (tagLower !== targetLower) return undefined;
  } else if (!VOLATILE_XML_TAGS.has(tagLower)) {
    return undefined;
  }

  const delim = text.charCodeAt(nameEnd);
  let openEnd = -1;
  let selfClosing = false;
  if (delim === 62) {
    openEnd = nameEnd + 1;
  } else if (delim === 47) {
    if (nameEnd + 1 < len && text.charCodeAt(nameEnd + 1) === 62) {
      openEnd = nameEnd + 2;
      selfClosing = true;
    }
  } else if (isXmlWs(delim)) {
    const limit = Math.min(len, nameEnd + VOLATILE_ATTR_SCAN_LIMIT);
    let quote = 0;
    for (let j = nameEnd; j < limit; j++) {
      const ch = text.charCodeAt(j);
      if (quote === 0) {
        if (ch === 60) break;
        if (ch === 62) {
          selfClosing = j > nameEnd && text.charCodeAt(j - 1) === 47;
          openEnd = j + 1;
          break;
        }
        if (ch === 34 || ch === 39) quote = ch;
      } else if (ch === quote) {
        quote = 0;
      }
    }
  }
  if (openEnd < 0) return undefined;
  return { tagLower, openEnd, selfClosing };
}

/**
 * Linear O(N) scanner splitting dynamic/volatile XML prompt islands
 * (`<env>`, `<context>`, `<system-reminder>`, `<fast_mode_info>`, `<git_status>`,
 * `<ADDITIONAL_METADATA>`) from surrounding static prose.
 * Skips fenced code blocks and inline backtick spans, tracks same-tag nesting
 * depth, and fails open as volatile on unclosed tags.
 */
export function splitVolatileXmlIslands(text: string): VolatileXmlIsland[] {
  if (!text) return [];
  const out: VolatileXmlIsland[] = [];
  const len = text.length;
  const skipRanges = buildNonProseSkipRanges(text);
  let skipIdx = 0;
  let lastEmit = 0;
  let scanPos = 0;

  while (scanPos < len) {
    const lt = text.indexOf('<', scanPos);
    if (lt < 0) break;

    const sk = advancePastSkipRange(skipRanges, skipIdx, lt);
    skipIdx = sk.idx;
    if (sk.skipEnd >= 0) {
      scanPos = sk.skipEnd;
      continue;
    }

    const head = parseOpenTagHead(text, lt);
    if (!head) {
      scanPos = lt + 1;
      continue;
    }

    if (head.selfClosing) {
      if (lt > lastEmit) out.push({ volatile: false, text: text.slice(lastEmit, lt) });
      out.push({ volatile: true, text: text.slice(lt, head.openEnd) });
      lastEmit = head.openEnd;
      scanPos = head.openEnd;
      continue;
    }

    const tagLower = head.tagLower;
    let closeSearch = head.openEnd;
    let closeSkipIdx = skipIdx;
    let depth = 1;
    let closeEnd = -1;
    while (closeSearch < len) {
      const nextLt = text.indexOf('<', closeSearch);
      if (nextLt < 0) break;
      const csk = advancePastSkipRange(skipRanges, closeSkipIdx, nextLt);
      closeSkipIdx = csk.idx;
      if (csk.skipEnd >= 0) {
        closeSearch = csk.skipEnd;
        continue;
      }
      if (nextLt + 1 < len && text.charCodeAt(nextLt + 1) === 47) {
        const afterSlash = nextLt + 2;
        if (asciiEqualsIgnoreCase(text, afterSlash, tagLower)) {
          let k = afterSlash + tagLower.length;
          while (k < len && isXmlWs(text.charCodeAt(k))) k++;
          if (k < len && text.charCodeAt(k) === 62) {
            depth--;
            if (depth === 0) {
              closeEnd = k + 1;
              skipIdx = closeSkipIdx;
              break;
            }
            closeSearch = k + 1;
            continue;
          }
        }
      } else {
        const nested = parseOpenTagHead(text, nextLt, tagLower);
        if (nested && !nested.selfClosing) {
          depth++;
          closeSearch = nested.openEnd;
          continue;
        }
      }
      closeSearch = nextLt + 1;
    }

    if (closeEnd < 0) {
      if (lt > lastEmit) out.push({ volatile: false, text: text.slice(lastEmit, lt) });
      out.push({ volatile: true, text: text.slice(lt) });
      lastEmit = len;
      break;
    }

    if (lt > lastEmit) out.push({ volatile: false, text: text.slice(lastEmit, lt) });
    out.push({ volatile: true, text: text.slice(lt, closeEnd) });
    lastEmit = closeEnd;
    scanPos = closeEnd;
  }

  if (lastEmit < len) {
    out.push({ volatile: false, text: text.slice(lastEmit) });
  }
  return out;
}

/** Compact one line of unfenced prose while leaving inline `` `...` `` spans verbatim. */
function compactInlineSafeLine(line: string): string {
  if (!line.includes('`')) {
    const noTrail = line.replace(/[ \t]+$/g, '');
    return noTrail.replace(/(\S)[ \t]{3,}/g, '$1 ');
  }
  let out = '';
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    if (tick < 0) {
      out += line.slice(i).replace(/(\S)[ \t]{3,}/g, '$1 ');
      break;
    }
    if (tick > i) {
      out += line.slice(i, tick).replace(/(\S)[ \t]{3,}/g, '$1 ');
    }
    let ticks = 1;
    while (tick + ticks < line.length && line[tick + ticks] === '`') ticks++;
    const fence = '`'.repeat(ticks);
    let close = line.indexOf(fence, tick + ticks);
    // Require exact backtick run length for closing delimiter.
    while (close >= 0) {
      const beforeOk = close === 0 || line[close - 1] !== '`';
      const afterOk = close + ticks >= line.length || line[close + ticks] !== '`';
      if (beforeOk && afterOk) break;
      close = line.indexOf(fence, close + ticks);
    }
    if (close < 0) {
      out += line.slice(tick);
      break;
    }
    out += line.slice(tick, close + ticks);
    i = close + ticks;
  }
  return out.replace(/[ \t]+$/g, '');
}

/** Split an unfenced chunk across inline backtick spans on the same line, running HTML comment removal only outside them. */
function stripHtmlCommentsOutsideInlineCode(seg: string): string {
  if (!seg.includes('<!--')) return seg;
  if (!seg.includes('`')) return stripHtmlComments(seg);
  // Mask single/multi-backtick inline spans per line with a collision-free marker.
  const lines = seg.split('\n');
  const saved: string[] = [];
  let tokenPrefix = '\uE000__FC__';
  while (seg.includes(tokenPrefix)) tokenPrefix += '_';
  const maskedLines = lines.map((line) => {
    if (!line.includes('`')) return line;
    let out = '';
    let i = 0;
    while (i < line.length) {
      const tick = line.indexOf('`', i);
      if (tick < 0) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, tick);
      let ticks = 1;
      while (tick + ticks < line.length && line[tick + ticks] === '`') ticks++;
      const fence = '`'.repeat(ticks);
      let close = line.indexOf(fence, tick + ticks);
      while (close >= 0) {
        const beforeOk = close === 0 || line[close - 1] !== '`';
        const afterOk = close + ticks >= line.length || line[close + ticks] !== '`';
        if (beforeOk && afterOk) break;
        close = line.indexOf(fence, close + ticks);
      }
      if (close < 0) {
        out += line.slice(tick);
        break;
      }
      const id = saved.length;
      saved.push(line.slice(tick, close + ticks));
      out += `${tokenPrefix}${id}\uE001`;
      i = close + ticks;
    }
    return out;
  });
  let stripped = stripHtmlComments(maskedLines.join('\n'));
  if (saved.length > 0) {
    const escPrefix = tokenPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    stripped = stripped.replace(
      new RegExp(`${escPrefix}(\\d+)\uE001`, 'g'),
      (_, rawId) => saved[Number(rawId)] ?? '',
    );
  }
  return stripped;
}

function compactUnfencedSegment(segRaw: string, preserveProtectedLines: boolean): string {
  const withoutComments = stripHtmlCommentsOutsideInlineCode(segRaw);
  const lines = withoutComments.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (preserveProtectedLines && PROTECTED_SYS_LINE_RE.test(line)) {
      kept.push(line);
      continue;
    }
    const noTrail = line.replace(/[ \t]+$/g, '');
    if (DIVIDER_LINE_RE.test(noTrail)) continue;
    kept.push(compactInlineSafeLine(noTrail));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Compact decorative prose whitespace outside fenced code blocks and inline backticks. */
function compactProseOutsideCode(raw: string): string {
  if (!raw || raw.length < 40) return raw;
  const segments = splitCodeFences(raw);
  const out = segments
    .map((seg) => (seg.fence ? seg.text : compactUnfencedSegment(seg.text, false)))
    .join('\n');
  return out.trim();
}

function cleanSchemaNode(node: unknown, propKey?: string): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) cleanSchemaNode(item);
    return;
  }
  const obj = node as Record<string, unknown>;
  // Preserve `$schema` so Draft-07 MCP tool schemas aren't re-evaluated as Draft 2020-12.
  delete obj.$comment;

  if (typeof obj.description === 'string') {
    const compacted = compactProseOutsideCode(obj.description);
    if (compacted === '') {
      delete obj.description;
    } else if (compacted.length < obj.description.length) {
      obj.description = compacted;
    }
  }

  if (propKey !== undefined && typeof obj.title === 'string') {
    const np = normAlpha(propKey);
    if (np.length > 0 && normAlpha(obj.title) === np) {
      delete obj.title;
    }
  }

  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    for (const [k, child] of Object.entries(obj.properties as Record<string, unknown>)) {
      cleanSchemaNode(child, k);
    }
  }
  if (obj.items !== undefined) cleanSchemaNode(obj.items);
  if (Array.isArray(obj.anyOf)) cleanSchemaNode(obj.anyOf);
  if (Array.isArray(obj.oneOf)) cleanSchemaNode(obj.oneOf);
  if (Array.isArray(obj.allOf)) cleanSchemaNode(obj.allOf);
  if (obj.$defs && typeof obj.$defs === 'object') {
    for (const child of Object.values(obj.$defs as Record<string, unknown>)) cleanSchemaNode(child);
  }
  if (obj.definitions && typeof obj.definitions === 'object') {
    for (const child of Object.values(obj.definitions as Record<string, unknown>)) cleanSchemaNode(child);
  }
}

interface DescSlot {
  get: () => string;
  set: (v: string) => void;
}

const DEFAULT_SCHEMA_MIN_PARA_CHARS = 96;

function collectToolDescriptionSlots(node: unknown, out: DescSlot[], minChars = DEFAULT_SCHEMA_MIN_PARA_CHARS): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolDescriptionSlots(item, out, minChars);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.description === 'string' && obj.description.length >= minChars) {
    out.push({
      get: () => obj.description as string,
      set: (v: string) => {
        obj.description = v;
      },
    });
  }
  if (obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function)) {
    collectToolDescriptionSlots(obj.function, out, minChars);
  }
  if (obj.input_schema && typeof obj.input_schema === 'object') {
    collectSchemaDescSlots(obj.input_schema, out, minChars);
  }
  if (obj.parameters && typeof obj.parameters === 'object') {
    collectSchemaDescSlots(obj.parameters, out, minChars);
  }
  if (Array.isArray(obj.functionDeclarations)) {
    for (const fn of obj.functionDeclarations) collectToolDescriptionSlots(fn, out, minChars);
  }
}

function collectSchemaDescSlots(schema: unknown, out: DescSlot[], minChars = DEFAULT_SCHEMA_MIN_PARA_CHARS): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    for (const s of schema) collectSchemaDescSlots(s, out, minChars);
    return;
  }
  const obj = schema as Record<string, unknown>;
  if (typeof obj.description === 'string' && obj.description.length >= minChars) {
    out.push({
      get: () => obj.description as string,
      set: (v: string) => {
        obj.description = v;
      },
    });
  }
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    for (const child of Object.values(obj.properties as Record<string, unknown>)) {
      collectSchemaDescSlots(child, out, minChars);
    }
  }
  if (obj.items !== undefined) collectSchemaDescSlots(obj.items, out, minChars);
  if (Array.isArray(obj.anyOf)) collectSchemaDescSlots(obj.anyOf, out, minChars);
  if (Array.isArray(obj.oneOf)) collectSchemaDescSlots(obj.oneOf, out, minChars);
  if (Array.isArray(obj.allOf)) collectSchemaDescSlots(obj.allOf, out, minChars);
  if (obj.$defs && typeof obj.$defs === 'object' && !Array.isArray(obj.$defs)) {
    for (const child of Object.values(obj.$defs as Record<string, unknown>)) {
      collectSchemaDescSlots(child, out, minChars);
    }
  }
  if (obj.definitions && typeof obj.definitions === 'object' && !Array.isArray(obj.definitions)) {
    for (const child of Object.values(obj.definitions as Record<string, unknown>)) {
      collectSchemaDescSlots(child, out, minChars);
    }
  }
}

function deduplicateSharedParagraphs(
  slots: readonly DescSlot[],
  tagPrefix: 'T' | 'S',
  minParaChars: number,
): void {
  const counts = new Map<string, number>();
  const splitSlots = slots.map((slot) => {
    const raw = slot.get();
    const segments = splitCodeFences(raw).map((seg) => {
      if (seg.fence) {
        return { fence: true as const, text: seg.text, paras: [] as string[] };
      }
      const paras = seg.text.split(/\n\n+/);
      for (const p of paras) {
        if (p.length < minParaChars || PROTECTED_SYS_LINE_RE.test(p)) continue;
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      return { fence: false as const, text: seg.text, paras };
    });
    return { slot, raw, segments };
  });

  const profitableParas = new Set<string>();
  let estSeq = 1;
  for (const [p, count] of counts.entries()) {
    if (count < 2) continue;
    const tagLen = 1 + String(estSeq).length + 1; // `#T1`
    const netSaved = (count - 1) * (p.length - (12 + tagLen)) - (tagLen + 3);
    if (netSaved > 0) {
      profitableParas.add(p);
      estSeq++;
    }
  }
  if (profitableParas.size === 0) return;

  const tagByPara = new Map<string, string>();
  let seq = 1;
  for (const item of splitSlots) {
    let slotChanged = false;
    const outSegs = item.segments.map((seg) => {
      if (seg.fence) return seg.text;
      let segChanged = false;
      const nextParas = seg.paras.map((p) => {
        if (!profitableParas.has(p)) return p;
        const existing = tagByPara.get(p);
        if (existing) {
          segChanged = true;
          slotChanged = true;
          return `See [${existing}] above.`;
        }
        const tag = `#${tagPrefix}${seq++}`;
        tagByPara.set(p, tag);
        segChanged = true;
        slotChanged = true;
        return `[${tag}] ${p}`;
      });
      return segChanged ? nextParas.join('\n\n') : seg.text;
    });
    if (slotChanged) {
      item.slot.set(outSegs.join('\n'));
    }
  }
}

const MIN_SUBTREE_JSON_CHARS = 220;
const MIN_TOOL_FACTOR_SAVED_CHARS = 120;
const SINGLE_SUBSCHEMA_KEYS = new Set<string>([
  'additionalProperties',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);
const ARRAY_SUBSCHEMA_KEYS = new Set<string>(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const MAP_SUBSCHEMA_KEYS = new Set<string>(['properties', 'patternProperties', 'dependentSchemas']);
const DEF_MAP_KEYS = new Set<string>(['$defs', 'definitions']);
const SCOPE_ANCHOR_KEYS = new Set<string>([
  '$id',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$recursiveRef',
  '$recursiveAnchor',
]);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mixHashPair(h1: number, h2: number, val: number): [number, number] {
  const n1 = Math.imul((h1 ^ val) >>> 0, 0x01000193) >>> 0;
  const n2 = Math.imul((h2 ^ ((val + 0x9e3779b9) | 0)) >>> 0, 0x85ebca6b) >>> 0;
  return [n1, n2];
}

function mixHashString(h1: number, h2: number, s: string): [number, number] {
  let a = h1 >>> 0;
  let b = h2 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul((a ^ c) >>> 0, 0x01000193) >>> 0;
    b = Math.imul((b ^ (c + i)) >>> 0, 0x85ebca6b) >>> 0;
  }
  return mixHashPair(a, b, s.length);
}

function hashJsonValue(val: unknown, depth = 0): [number, number] {
  if (depth > 64) return [0xdeadbeef, 0xcafebabe];
  if (val === null) return [0x11111111, 0x22222222];
  if (val === true) return [0x33333333, 0x44444444];
  if (val === false) return [0x55555555, 0x66666666];
  if (typeof val === 'number') {
    const [a, b] = mixHashString(0x811c9dc5, 0x9e3779b1, String(val));
    return mixHashPair(a, b, 1);
  }
  if (typeof val === 'string') {
    const [a, b] = mixHashString(0x811c9dc5, 0x9e3779b1, val);
    return mixHashPair(a, b, 2);
  }
  if (Array.isArray(val)) {
    let a = 0x517cc1b7;
    let b = 0x27d4eb2f;
    for (let i = 0; i < val.length; i++) {
      const [ca, cb] = hashJsonValue(val[i], depth + 1);
      [a, b] = mixHashPair(a, b, ca ^ cb);
    }
    return mixHashPair(a, b, val.length);
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    let a = 0x811c9dc5;
    let b = 0x9e3779b1;
    for (const k of keys) {
      [a, b] = mixHashString(a, b, k);
      const [va, vb] = hashJsonValue(obj[k], depth + 1);
      [a, b] = mixHashPair(a, b, va ^ vb);
    }
    return mixHashPair(a, b, keys.length);
  }
  return [0, 0];
}

function jsonValuesEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonValuesEqual(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!jsonValuesEqual(ao[k], bo[k], depth + 1)) return false;
  }
  return true;
}

interface SubschemaRec {
  readonly id: number;
  readonly parentSchemaId: number;
  readonly node: Record<string, unknown>;
  readonly applyReplace: (refObj: Record<string, unknown>) => void;
  readonly hashKey: string;
  readonly height: number;
  groupId: number;
}

function hasUnsafeInternalRef(root: Record<string, unknown>): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    const rec = cur as Record<string, unknown>;
    if (typeof rec.$ref === 'string') {
      const ref = rec.$ref;
      if (
        ref.startsWith('#/') &&
        !ref.startsWith('#/$defs/') &&
        !ref.startsWith('#/definitions/')
      ) {
        return true;
      }
    }
    for (const v of Object.values(rec)) stack.push(v);
  }
  return false;
}

function factorSingleSchema(schema: Record<string, unknown>): boolean {
  const useDraft07Definitions =
    typeof schema.$schema === 'string' &&
    /draft-0[467]\b/i.test(schema.$schema) &&
    schema.$defs === undefined;
  const defsKey = useDraft07Definitions ? 'definitions' : '$defs';
  const defsPtr = `#/${defsKey}/`;
  if (!useDraft07Definitions && schema.$defs !== undefined && !isPlainRecord(schema.$defs)) {
    return false;
  }
  if (useDraft07Definitions && schema.definitions !== undefined && !isPlainRecord(schema.definitions)) {
    return false;
  }
  if (hasUnsafeInternalRef(schema)) return false;

  const allNodes: SubschemaRec[] = [];
  const recById = new Map<number, SubschemaRec>();
  let nextId = 1;
  const activeStack = new Set<object>();

  const visit = (
    node: Record<string, unknown>,
    id: number,
    parentSchemaId: number,
    replaceable: boolean,
    applyReplace: (refObj: Record<string, unknown>) => void,
    depth: number,
    inEmbeddedResource: boolean,
  ): { h1: number; h2: number; height: number; hasScopeAnchor: boolean } => {
    if (depth > 48 || activeStack.has(node)) {
      return { h1: 0, h2: 0, height: 0, hasScopeAnchor: true };
    }
    activeStack.add(node);

    const isEmbedded = inEmbeddedResource || (depth > 0 && typeof node.$id === 'string');
    const keys = Object.keys(node).filter((k) => node[k] !== undefined).sort();
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b1;
    let maxChildHeight = -1;
    let hasScopeAnchor = isEmbedded;

    for (const k of keys) {
      if (SCOPE_ANCHOR_KEYS.has(k)) hasScopeAnchor = true;
      const val = node[k];
      [h1, h2] = mixHashString(h1, h2, k);

      if (SINGLE_SUBSCHEMA_KEYS.has(k) && isPlainRecord(val)) {
        const cid = nextId++;
        const child = visit(
          val,
          cid,
          id,
          true,
          (refObj) => {
            node[k] = refObj;
          },
          depth + 1,
          isEmbedded,
        );
        [h1, h2] = mixHashPair(h1, h2, child.h1 ^ child.h2);
        if (child.height > maxChildHeight) maxChildHeight = child.height;
        if (child.hasScopeAnchor) hasScopeAnchor = true;
        continue;
      }

      if (k === 'items') {
        if (isPlainRecord(val)) {
          const cid = nextId++;
          const child = visit(
            val,
            cid,
            id,
            true,
            (refObj) => {
              node.items = refObj;
            },
            depth + 1,
            isEmbedded,
          );
          [h1, h2] = mixHashPair(h1, h2, child.h1 ^ child.h2);
          if (child.height > maxChildHeight) maxChildHeight = child.height;
          if (child.hasScopeAnchor) hasScopeAnchor = true;
          continue;
        }
        if (Array.isArray(val)) {
          let ah1 = 0x517cc1b7;
          let ah2 = 0x27d4eb2f;
          for (let idx = 0; idx < val.length; idx++) {
            const elem = val[idx];
            if (isPlainRecord(elem)) {
              const cid = nextId++;
              const child = visit(
                elem,
                cid,
                id,
                true,
                (refObj) => {
                  val[idx] = refObj;
                },
                depth + 1,
                isEmbedded,
              );
              [ah1, ah2] = mixHashPair(ah1, ah2, child.h1 ^ child.h2);
              if (child.height > maxChildHeight) maxChildHeight = child.height;
              if (child.hasScopeAnchor) hasScopeAnchor = true;
            } else {
              const [eh1, eh2] = hashJsonValue(elem, depth + 1);
              [ah1, ah2] = mixHashPair(ah1, ah2, eh1 ^ eh2);
            }
          }
          [ah1, ah2] = mixHashPair(ah1, ah2, val.length);
          [h1, h2] = mixHashPair(h1, h2, ah1 ^ ah2);
          continue;
        }
      }

      if (ARRAY_SUBSCHEMA_KEYS.has(k) && Array.isArray(val)) {
        let ah1 = 0x517cc1b7;
        let ah2 = 0x27d4eb2f;
        for (let idx = 0; idx < val.length; idx++) {
          const elem = val[idx];
          if (isPlainRecord(elem)) {
            const cid = nextId++;
            const child = visit(
              elem,
              cid,
              id,
              true,
              (refObj) => {
                val[idx] = refObj;
              },
              depth + 1,
              isEmbedded,
            );
            [ah1, ah2] = mixHashPair(ah1, ah2, child.h1 ^ child.h2);
            if (child.height > maxChildHeight) maxChildHeight = child.height;
            if (child.hasScopeAnchor) hasScopeAnchor = true;
          } else {
            const [eh1, eh2] = hashJsonValue(elem, depth + 1);
            [ah1, ah2] = mixHashPair(ah1, ah2, eh1 ^ eh2);
          }
        }
        [ah1, ah2] = mixHashPair(ah1, ah2, val.length);
        [h1, h2] = mixHashPair(h1, h2, ah1 ^ ah2);
        continue;
      }

      if ((MAP_SUBSCHEMA_KEYS.has(k) || DEF_MAP_KEYS.has(k)) && isPlainRecord(val)) {
        const childReplaceable = !DEF_MAP_KEYS.has(k) && !isEmbedded;
        const mapKeys = Object.keys(val).filter((mk) => val[mk] !== undefined).sort();
        let mh1 = 0x811c9dc5;
        let mh2 = 0x9e3779b1;
        for (const mk of mapKeys) {
          [mh1, mh2] = mixHashString(mh1, mh2, mk);
          const sub = val[mk];
          if (isPlainRecord(sub)) {
            const cid = nextId++;
            const child = visit(
              sub,
              cid,
              id,
              childReplaceable,
              (refObj) => {
                val[mk] = refObj;
              },
              depth + 1,
              isEmbedded,
            );
            [mh1, mh2] = mixHashPair(mh1, mh2, child.h1 ^ child.h2);
            if (child.height > maxChildHeight) maxChildHeight = child.height;
            if (child.hasScopeAnchor) hasScopeAnchor = true;
          } else {
            const [vh1, vh2] = hashJsonValue(sub, depth + 1);
            [mh1, mh2] = mixHashPair(mh1, mh2, vh1 ^ vh2);
          }
        }
        [mh1, mh2] = mixHashPair(mh1, mh2, mapKeys.length);
        [h1, h2] = mixHashPair(h1, h2, mh1 ^ mh2);
        continue;
      }

      const [vh1, vh2] = hashJsonValue(val, depth + 1);
      [h1, h2] = mixHashPair(h1, h2, vh1 ^ vh2);
    }

    [h1, h2] = mixHashPair(h1, h2, keys.length);
    activeStack.delete(node);

    const height = maxChildHeight + 1;
    const isPureRef = typeof node.$ref === 'string' && keys.length === 1;
    if (replaceable && !isPureRef && !hasScopeAnchor && !isEmbedded) {
      const rec: SubschemaRec = {
        id,
        parentSchemaId,
        node,
        applyReplace,
        hashKey: `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`,
        height,
        groupId: -1,
      };
      allNodes.push(rec);
      recById.set(id, rec);
    }
    return { h1, h2, height, hasScopeAnchor };
  };

  visit(schema, 0, -1, false, () => {}, 0, false);
  if (allNodes.length < 2) return false;

  const buckets = new Map<string, SubschemaRec[]>();
  for (const rec of allNodes) {
    let list = buckets.get(rec.hashKey);
    if (!list) {
      list = [];
      buckets.set(rec.hashKey, list);
    }
    list.push(rec);
  }

  interface EquivGroup {
    id: number;
    height: number;
    members: SubschemaRec[];
    dominated: boolean;
  }
  const groups: EquivGroup[] = [];

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const subGroups: SubschemaRec[][] = [];
    for (const rec of bucket) {
      let matched = false;
      for (const sg of subGroups) {
        if (jsonValuesEqual(rec.node, sg[0]!.node)) {
          sg.push(rec);
          matched = true;
          break;
        }
      }
      if (!matched) subGroups.push([rec]);
    }

    for (const sg of subGroups) {
      if (sg.length < 2) continue;
      let serializedLen = 0;
      try {
        serializedLen = JSON.stringify(sg[0]!.node).length;
      } catch {
        continue;
      }
      if (serializedLen < MIN_SUBTREE_JSON_CHARS) continue;
      const gid = groups.length;
      for (const m of sg) m.groupId = gid;
      groups.push({ id: gid, height: sg[0]!.height, members: sg, dominated: false });
    }
  }

  if (groups.length === 0) return false;

  // Prune groups strictly dominated by an identical parent group of the exact same cardinality.
  for (const g of groups) {
    let commonParentGid = -1;
    let sameParentGroup = true;
    const distinctParents = new Set<number>();
    for (const m of g.members) {
      const parentRec = recById.get(m.parentSchemaId);
      if (!parentRec || parentRec.groupId < 0) {
        sameParentGroup = false;
        break;
      }
      distinctParents.add(m.parentSchemaId);
      if (commonParentGid < 0) commonParentGid = parentRec.groupId;
      else if (parentRec.groupId !== commonParentGid) {
        sameParentGroup = false;
        break;
      }
    }
    if (
      sameParentGroup &&
      commonParentGid >= 0 &&
      distinctParents.size === g.members.length &&
      groups[commonParentGid]!.members.length === g.members.length
    ) {
      g.dominated = true;
    }
  }

  const ordered = groups
    .filter((g) => !g.dominated)
    .sort((a, b) => a.height - b.height || a.id - b.id);
  if (ordered.length === 0) return false;

  const rawExistingDefs = useDraft07Definitions ? schema.definitions : schema.$defs;
  const existingDefs = isPlainRecord(rawExistingDefs) ? rawExistingDefs : undefined;
  const usedKeys = new Set<string>(existingDefs ? Object.keys(existingDefs) : []);
  let defSeq = 1;
  const hoisted: Array<{ defName: string; value: Record<string, unknown> }> = [];

  for (const g of ordered) {
    const sample = g.members[0]!.node;
    let currentJson: string;
    try {
      currentJson = JSON.stringify(sample);
    } catch {
      continue;
    }
    if (currentJson.length < MIN_SUBTREE_JSON_CHARS) continue;

    while (usedKeys.has(`_f${defSeq}`)) defSeq++;
    const defName = `_f${defSeq++}`;
    usedKeys.add(defName);

    const cloned = JSON.parse(currentJson) as Record<string, unknown>;
    hoisted.push({ defName, value: cloned });

    const refTarget = `${defsPtr}${defName}`;
    for (const m of g.members) {
      m.applyReplace({ $ref: refTarget });
    }
  }

  if (hoisted.length === 0) return false;
  const defsObj = existingDefs ?? {};
  for (const h of hoisted) {
    defsObj[h.defName] = h.value;
  }
  schema[defsKey] = defsObj;
  return true;
}

/**
 * Bottom-up Merkle subtree factoring across non-Google tool schemas.
 * Hoists identical JSON Schema subtrees (`JSON.stringify(node).length >= 220`,
 * occurring `>= 2` times inside one tool's schema) into `schema.$defs._f1.._fN`
 * without colliding with existing `$defs` keys, replacing repeated occurrences
 * with `{ $ref: '#/$defs/_fN' }`. Keeps a tool's rewrite only when serialized
 * tool JSON shrinks by `>= 120` chars.
 */
export function factorSharedSchemaSubtrees(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;

  const tryFactorTool = (rawTool: unknown, applyWriteBack: (next: unknown) => void): boolean => {
    if (!isPlainRecord(rawTool)) return false;
    if (rawTool.strict === true || (isPlainRecord(rawTool.function) && rawTool.function.strict === true)) {
      return false;
    }
    let origToolJson: string;
    try {
      origToolJson = JSON.stringify(rawTool);
    } catch {
      return false;
    }
    if (origToolJson.length < MIN_SUBTREE_JSON_CHARS * 2) return false;

    const toolClone = JSON.parse(origToolJson) as Record<string, unknown>;
    const fnTarget = isPlainRecord(toolClone.function) ? toolClone.function : toolClone;
    let touched = false;
    if (isPlainRecord(fnTarget.input_schema) && factorSingleSchema(fnTarget.input_schema)) {
      touched = true;
    }
    if (isPlainRecord(fnTarget.parameters) && factorSingleSchema(fnTarget.parameters)) {
      touched = true;
    }
    if (!touched) return false;

    const nextToolJson = JSON.stringify(toolClone);
    if (origToolJson.length - nextToolJson.length < MIN_TOOL_FACTOR_SAVED_CHARS) {
      return false;
    }
    applyWriteBack(toolClone);
    return true;
  };

  if (Array.isArray(candidate)) {
    let anyChanged = false;
    for (let i = 0; i < candidate.length; i++) {
      if (
        tryFactorTool(candidate[i], (next) => {
          candidate[i] = next;
        })
      ) {
        anyChanged = true;
      }
    }
    return anyChanged;
  }

  const obj = candidate as Record<string, unknown>;
  if (isPlainRecord(obj.function) || isPlainRecord(obj.input_schema) || isPlainRecord(obj.parameters)) {
    return tryFactorTool(obj, (next) => {
      const nextObj = next as Record<string, unknown>;
      for (const k of Object.keys(obj)) delete obj[k];
      Object.assign(obj, nextObj);
    });
  }

  let origJson: string;
  try {
    origJson = JSON.stringify(obj);
  } catch {
    return false;
  }
  if (origJson.length < MIN_SUBTREE_JSON_CHARS * 2) return false;
  const clone = JSON.parse(origJson) as Record<string, unknown>;
  if (!factorSingleSchema(clone)) return false;
  const nextJson = JSON.stringify(clone);
  if (origJson.length - nextJson.length < MIN_TOOL_FACTOR_SAVED_CHARS) return false;
  for (const k of Object.keys(obj)) delete obj[k];
  Object.assign(obj, clone);
  return true;
}

/**
 * Compile tool definitions & JSON schemas deterministically in place.
 * Only writes back to `tools` when net savings are >=200 chars & >=40 tokens.
 */
export function compileToolSchemas(
  tools: unknown[] | undefined,
  wire: ToolSchemaWire,
): CompileResult {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { changed: false, savedChars: 0, savedTokens: 0 };
  }

  let origJson: string;
  try {
    origJson = JSON.stringify(tools);
  } catch {
    return { changed: false, savedChars: 0, savedTokens: 0 };
  }
  if (!origJson || origJson.length < 512) {
    return { changed: false, savedChars: 0, savedTokens: 0 };
  }

  const cacheKey = `${wire}\0${origJson}`;
  const cached = toolSchemaCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached.compiledJson !== undefined) {
      const cloned = JSON.parse(cached.compiledJson) as unknown[];
      for (let i = 0; i < tools.length && i < cloned.length; i++) {
        tools[i] = cloned[i];
      }
    }
    return cached.result;
  }

  const candidate = JSON.parse(origJson) as unknown[];

  for (const rawTool of candidate) {
    if (!rawTool || typeof rawTool !== 'object') continue;
    const tool = rawTool as Record<string, unknown>;
    if (wire === 'google' && Array.isArray(tool.functionDeclarations)) {
      for (const rawFn of tool.functionDeclarations) {
        if (!rawFn || typeof rawFn !== 'object') continue;
        const fn = rawFn as Record<string, unknown>;
        if (typeof fn.description === 'string') {
          const c = compactProseOutsideCode(fn.description);
          if (c.length < fn.description.length && c.length > 0) fn.description = c;
        }
        if (fn.parameters !== undefined) cleanSchemaNode(fn.parameters);
      }
      continue;
    }

    const fnTarget =
      tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function)
        ? (tool.function as Record<string, unknown>)
        : tool;
    if (typeof fnTarget.description === 'string') {
      const c = compactProseOutsideCode(fnTarget.description);
      if (c.length < fnTarget.description.length && c.length > 0) fnTarget.description = c;
    }
    if (fnTarget.input_schema !== undefined) cleanSchemaNode(fnTarget.input_schema);
    if (fnTarget.parameters !== undefined) cleanSchemaNode(fnTarget.parameters);
  }

  const schemaDagFactored = wire !== 'google' ? factorSharedSchemaSubtrees(candidate) : false;

  const slots: DescSlot[] = [];
  for (const item of candidate) collectToolDescriptionSlots(item, slots, DEFAULT_SCHEMA_MIN_PARA_CHARS);
  if (slots.length >= 2) {
    deduplicateSharedParagraphs(slots, 'T', DEFAULT_SCHEMA_MIN_PARA_CHARS);
  }

  const nextJson = JSON.stringify(candidate);
  const savedChars = origJson.length - nextJson.length;
  const storeSchemaCache = (entry: { result: CompileResult; compiledJson?: string }) => {
    const cost = cacheKey.length + (entry.compiledJson?.length ?? 0);
    if (cost <= COMPILER_CACHE_MAX_CHARS) {
      if (toolSchemaCacheChars + cost > COMPILER_CACHE_MAX_CHARS) {
        toolSchemaCache.clear();
        toolSchemaCacheChars = 0;
      }
      toolSchemaCache.set(cacheKey, entry);
      toolSchemaCacheChars += cost;
    }
  };

  if (savedChars < 200) {
    const result: CompileResult = { changed: false, savedChars: 0, savedTokens: 0 };
    storeSchemaCache({ result });
    return result;
  }
  const [origTokens, nextTokens] = estimateTokenPair(origJson, nextJson);
  const savedTokens = Math.max(0, origTokens - nextTokens);
  if (savedTokens < 40) {
    const result: CompileResult = { changed: false, savedChars: 0, savedTokens: 0 };
    storeSchemaCache({ result });
    return result;
  }

  for (let i = 0; i < tools.length && i < candidate.length; i++) {
    tools[i] = candidate[i];
  }
  const result: CompileResult = {
    changed: true,
    savedChars,
    savedTokens,
    ...(schemaDagFactored ? { schemaDagFactored: true } : {}),
  };
  storeSchemaCache({ result, compiledJson: nextJson });
  return result;
}

/**
 * Compile multi-line static system/instruction prose deterministically.
 * Leaves single-line text, OAuth identity lines, billing headers, inline code
 * spans, and fenced code blocks verbatim untouched.
 */
export function compileStaticText(text: string): CompileTextResult {
  if (typeof text !== 'string' || text.length < 1200 || !text.includes('\n')) {
    return { text, changed: false, savedChars: 0, savedTokens: 0 };
  }

  const hit = staticTextCache.get(text);
  if (hit !== undefined) return hit;

  const storeStaticCache = (res: CompileTextResult): CompileTextResult => {
    const cost = text.length + (res.changed ? res.text.length : 0);
    if (cost <= COMPILER_CACHE_MAX_CHARS) {
      if (staticTextCacheChars + cost > COMPILER_CACHE_MAX_CHARS) {
        staticTextCache.clear();
        staticTextCacheChars = 0;
      }
      staticTextCache.set(text, res);
      staticTextCacheChars += cost;
    }
    return res;
  };

  // Split by fenced code blocks (``` / ~~~) so anything inside code fences stays byte-identical.
  const segments = splitCodeFences(text);
  const outSegments: TextSegment[] = [];
  const paraCounts = new Map<string, number>();

  for (const seg of segments) {
    if (seg.fence) {
      outSegments.push(seg);
      continue;
    }
    const cleaned = compactUnfencedSegment(seg.text, true);
    outSegments.push({ fence: false, text: cleaned });

    for (const para of cleaned.split(/\n\n+/)) {
      if (para.length >= 140 && !PROTECTED_SYS_LINE_RE.test(para)) {
        paraCounts.set(para, (paraCounts.get(para) ?? 0) + 1);
      }
    }
  }

  const tagByPara = new Map<string, string>();
  let seq = 1;
  const outParts = outSegments.map((seg) => {
    if (seg.fence) return seg.text;
    const paras = seg.text.split(/\n\n+/);
    let any = false;
    const mapped = paras.map((p) => {
      if ((paraCounts.get(p) ?? 0) < 2) return p;
      const existing = tagByPara.get(p);
      if (existing) {
        any = true;
        return `See [${existing}] above.`;
      }
      const tag = `#S${seq++}`;
      tagByPara.set(p, tag);
      any = true;
      return `[${tag}] ${p}`;
    });
    return any ? mapped.join('\n\n') : seg.text;
  });

  const candidate = outParts.join('\n');
  const savedChars = text.length - candidate.length;
  if (savedChars < 200 || savedChars < text.length * 0.05) {
    return storeStaticCache({ text, changed: false, savedChars: 0, savedTokens: 0 });
  }
  const [origTokens, candTokens] = estimateTokenPair(text, candidate);
  const savedTokens = Math.max(0, origTokens - candTokens);
  if (savedTokens <= 0) {
    return storeStaticCache({ text, changed: false, savedChars: 0, savedTokens: 0 });
  }
  return storeStaticCache({ text: candidate, changed: true, savedChars, savedTokens });
}

interface SegmentedParaInfo {
  readonly leadNl: string;
  readonly core: string;
  readonly trailNl: string;
}

function splitParaEdges(p: string): SegmentedParaInfo {
  const leadNl = p.startsWith('\n') ? '\n' : '';
  const trailNl = p.length > leadNl.length && p.endsWith('\n') ? '\n' : '';
  const core = p.slice(leadNl.length, p.length - trailNl.length);
  return { leadNl, core, trailNl };
}

/**
 * Compile multi-line static prompt prose while preserving volatile XML islands
 * (`<env>`, `<context>`, `<system-reminder>`, `<fast_mode_info>`, `<git_status>`,
 * `<ADDITIONAL_METADATA>`) and fenced code blocks byte-identical.
 * Deduplicates repeated paragraphs across non-volatile static islands (`#S1`, `#S2`, ...).
 */
export function compileSegmentedStaticText(text: string): CompileTextResult {
  if (typeof text !== 'string' || text.length < 300 || !text.includes('\n')) {
    return { text, changed: false, savedChars: 0, savedTokens: 0 };
  }

  const islands = splitVolatileXmlIslands(text);
  const staticIslands: string[] = [];
  let origStaticChars = 0;
  for (const island of islands) {
    if (!island.volatile) {
      staticIslands.push(island.text);
      origStaticChars += island.text.length;
    }
  }
  if (origStaticChars < 300) {
    return { text, changed: false, savedChars: 0, savedTokens: 0 };
  }

  // Key cache strictly by the invariant static islands so volatile <env>/<git_status>
  // updates hit the compiled static outputs immediately without re-scanning.
  const staticCacheKey = staticIslands.join('\uE002');
  const cached = segmentedStaticPatternCache.get(staticCacheKey);
  if (cached !== undefined) {
    if (cached.savedChars < 150 || cached.savedChars < cached.origStaticChars * 0.03) {
      return { text, changed: false, savedChars: 0, savedTokens: 0 };
    }
    let si = 0;
    const rebuilt = islands.map((isl) => (isl.volatile ? isl.text : cached.compiledStatic[si++]!)).join('');
    const [origTokens, candTokens] = estimateTokenPair(text, rebuilt);
    const savedTokens = Math.max(0, origTokens - candTokens);
    if (savedTokens <= 0) {
      return { text, changed: false, savedChars: 0, savedTokens: 0 };
    }
    return { text: rebuilt, changed: true, savedChars: cached.savedChars, savedTokens };
  }

  const storePatternCache = (compiledStatic: readonly string[], savedChars: number): void => {
    const cost = staticCacheKey.length + compiledStatic.reduce((sum, s) => sum + s.length, 0);
    if (cost <= COMPILER_CACHE_MAX_CHARS) {
      if (segmentedStaticPatternCacheChars + cost > COMPILER_CACHE_MAX_CHARS) {
        segmentedStaticPatternCache.clear();
        segmentedStaticPatternCacheChars = 0;
      }
      segmentedStaticPatternCache.set(staticCacheKey, { compiledStatic, origStaticChars, savedChars });
      segmentedStaticPatternCacheChars += cost;
    }
  };

  const paraCounts = new Map<string, number>();

  interface CompiledFenceSeg {
    readonly fence: boolean;
    readonly text: string;
    readonly paras: readonly SegmentedParaInfo[];
  }
  type CompiledIsland =
    | { readonly volatile: true; readonly text: string }
    | { readonly volatile: false; readonly trailingInlineSpace: boolean; readonly segments: readonly CompiledFenceSeg[] };

  const compiledIslands: CompiledIsland[] = islands.map((island, idx) => {
    if (island.volatile) {
      return { volatile: true, text: island.text };
    }
    const trailingInlineSpace =
      idx < islands.length - 1 &&
      islands[idx + 1]!.volatile &&
      /[ \t]$/.test(island.text);
    const fenceSegs = splitCodeFences(island.text);
    const segments: CompiledFenceSeg[] = fenceSegs.map((seg) => {
      if (seg.fence) {
        return { fence: true, text: seg.text, paras: [] };
      }
      const cleaned = compactUnfencedSegment(seg.text, true);
      const rawParas = cleaned.split(/\n\n+/);
      const paras = rawParas.map(splitParaEdges);
      for (const p of paras) {
        if (p.core.length >= 140 && !PROTECTED_SYS_LINE_RE.test(p.core)) {
          paraCounts.set(p.core, (paraCounts.get(p.core) ?? 0) + 1);
        }
      }
      return { fence: false, text: cleaned, paras };
    });
    return { volatile: false, trailingInlineSpace, segments };
  });

  const profitableParas = new Set<string>();
  let estSeq = 1;
  for (const [core, count] of paraCounts.entries()) {
    if (count < 2) continue;
    const tagLen = 1 + String(estSeq).length + 1;
    const netSaved = (count - 1) * (core.length - (12 + tagLen)) - (tagLen + 3);
    if (netSaved > 0) {
      profitableParas.add(core);
      estSeq++;
    }
  }

  const tagByPara = new Map<string, string>();
  let seq = 1;
  const compiledStaticOut: string[] = [];
  const outIslands = compiledIslands.map((island) => {
    if (island.volatile) return island.text;
    const outFenceParts = island.segments.map((seg) => {
      if (seg.fence) return seg.text;
      if (profitableParas.size === 0) return seg.text;
      let any = false;
      const mapped = seg.paras.map((p) => {
        if (!profitableParas.has(p.core)) {
          return `${p.leadNl}${p.core}${p.trailNl}`;
        }
        const existing = tagByPara.get(p.core);
        if (existing) {
          any = true;
          return `${p.leadNl}See [${existing}] above.${p.trailNl}`;
        }
        const tag = `#S${seq++}`;
        tagByPara.set(p.core, tag);
        any = true;
        return `${p.leadNl}[${tag}] ${p.core}${p.trailNl}`;
      });
      return any ? mapped.join('\n\n') : seg.text;
    });
    let compiledIslandText = outFenceParts.join('\n');
    if (island.trailingInlineSpace && !/[ \t\n]$/.test(compiledIslandText)) {
      compiledIslandText += ' ';
    }
    compiledStaticOut.push(compiledIslandText);
    return compiledIslandText;
  });

  const candidate = outIslands.join('');
  const savedChars = text.length - candidate.length;
  storePatternCache(compiledStaticOut, savedChars);
  if (savedChars < 150 || savedChars < origStaticChars * 0.03) {
    return { text, changed: false, savedChars: 0, savedTokens: 0 };
  }
  const [origTokens, candTokens] = estimateTokenPair(text, candidate);
  const savedTokens = Math.max(0, origTokens - candTokens);
  if (savedTokens <= 0) {
    return { text, changed: false, savedChars: 0, savedTokens: 0 };
  }
  return { text: candidate, changed: true, savedChars, savedTokens };
}
