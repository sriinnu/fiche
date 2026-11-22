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
    for (let id = saved.length - 1; id >= 0; id--) {
      stripped = stripped.replace(`${tokenPrefix}${id}\uE001`, () => saved[id]!);
    }
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

function collectToolDescriptionSlots(node: unknown, out: DescSlot[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolDescriptionSlots(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.description === 'string' && obj.description.length >= 120) {
    out.push({
      get: () => obj.description as string,
      set: (v: string) => {
        obj.description = v;
      },
    });
  }
  if (obj.function && typeof obj.function === 'object' && !Array.isArray(obj.function)) {
    collectToolDescriptionSlots(obj.function, out);
  }
  if (obj.input_schema && typeof obj.input_schema === 'object') {
    collectSchemaDescSlots(obj.input_schema, out);
  }
  if (obj.parameters && typeof obj.parameters === 'object') {
    collectSchemaDescSlots(obj.parameters, out);
  }
  if (Array.isArray(obj.functionDeclarations)) {
    for (const fn of obj.functionDeclarations) collectToolDescriptionSlots(fn, out);
  }
}

function collectSchemaDescSlots(schema: unknown, out: DescSlot[]): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    for (const s of schema) collectSchemaDescSlots(s, out);
    return;
  }
  const obj = schema as Record<string, unknown>;
  if (typeof obj.description === 'string' && obj.description.length >= 120) {
    out.push({
      get: () => obj.description as string,
      set: (v: string) => {
        obj.description = v;
      },
    });
  }
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    for (const child of Object.values(obj.properties as Record<string, unknown>)) {
      collectSchemaDescSlots(child, out);
    }
  }
  if (obj.items !== undefined) collectSchemaDescSlots(obj.items, out);
  if (Array.isArray(obj.anyOf)) collectSchemaDescSlots(obj.anyOf, out);
  if (Array.isArray(obj.oneOf)) collectSchemaDescSlots(obj.oneOf, out);
  if (Array.isArray(obj.allOf)) collectSchemaDescSlots(obj.allOf, out);
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

  const tagByPara = new Map<string, string>();
  let seq = 1;
  for (const item of splitSlots) {
    let slotChanged = false;
    const outSegs = item.segments.map((seg) => {
      if (seg.fence) return seg.text;
      let segChanged = false;
      const nextParas = seg.paras.map((p) => {
        if ((counts.get(p) ?? 0) < 2) return p;
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

  const slots: DescSlot[] = [];
  for (const item of candidate) collectToolDescriptionSlots(item, slots);
  if (slots.length >= 2) {
    deduplicateSharedParagraphs(slots, 'T', 120);
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
  const result: CompileResult = { changed: true, savedChars, savedTokens };
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
