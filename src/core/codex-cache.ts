/**
 * ChatGPT Codex (`https://chatgpt.com/backend-api/codex/responses`) rejects
 * `prompt_cache_breakpoint` with HTTP 400. api.openai.com still accepts the
 * explicit breakpoint on GPT-5.6 / GPT-6 profiles. The decision is the
 * upstream, not the model id.
 */

export interface PromptCacheRoute {
  pathname?: string | null;
  upstream?: string | null;
}

function hostOf(upstream: string): string {
  const trimmed = upstream.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function isCodexPath(path: string): boolean {
  return path === '/backend-api/codex' || path.startsWith('/backend-api/codex/');
}

/** True when this route may receive an explicit prompt_cache_breakpoint. */
export function supportsExplicitPromptCacheBreakpoint(route: PromptCacheRoute = {}): boolean {
  const path = route.pathname ?? '';
  if (isCodexPath(path)) return false;
  const host = hostOf(route.upstream ?? '');
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) return false;
  return true;
}

/** Drop injected or hinted breakpoint objects. Does not touch other cache fields
 *  such as OpenAI's prompt_cache_key. Bodies that do not contain the key are
 *  returned unchanged so a Codex passthrough stays byte-identical. When the
 *  key is present it is cut out of the raw text, including one neighboring
 *  comma, so the rest of the document keeps its bytes. */
export function scrubPromptCacheBreakpoint(body: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(body);
  if (!text.includes('"prompt_cache_breakpoint"')) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return body;
  }
  if (!hasKey(parsed)) return body;
  const spliced = stripKeyFromText(text);
  if (spliced === null) {
    return new TextEncoder().encode(JSON.stringify(stripKey(parsed, () => {})));
  }
  return new TextEncoder().encode(spliced);
}

function hasKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasKey);
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'prompt_cache_breakpoint' || hasKey(child)) return true;
  }
  return false;
}

function skipJsonValue(text: string, index: number): number | null {
  let i = index;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  const c = text[i];
  if (c === undefined) return null;
  if (c === '"') {
    i += 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '"') return i + 1;
      i += 1;
    }
    return null;
  }
  if (c === '{' || c === '[') {
    const open = c;
    const close = c === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    for (; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return null;
  }
  const token = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
  return token ? i + token[0].length : null;
}

/** null when the raw edit cannot be proved. The caller then re-serializes. */
function stripKeyFromText(text: string): string | null {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch !== '"') { i += 1; continue; }
    const keyStart = i;
    const endQuote = text.indexOf('"', i + 1);
    if (endQuote < 0) return null;
    const key = text.slice(i + 1, endQuote);
    let j = endQuote + 1;
    while (j < text.length && /\s/.test(text[j]!)) j += 1;
    if (text[j] !== ':') {
      inString = true;
      i += 1;
      continue;
    }
    if (key !== 'prompt_cache_breakpoint') {
      i = endQuote + 1;
      continue;
    }
    const valueEnd = skipJsonValue(text, j + 1);
    if (valueEnd === null) return null;
    let start = keyStart;
    let end = valueEnd;
    let left = start - 1;
    while (left >= 0 && /\s/.test(text[left]!)) left -= 1;
    let right = end;
    while (right < text.length && /\s/.test(text[right]!)) right += 1;
    if (text[right] === ',') end = right + 1;
    else if (text[left] === ',') start = left;
    ranges.push({ start, end });
    i = valueEnd;
  }
  if (ranges.length === 0) return null;
  let out = text;
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, range.start) + out.slice(range.end);
  }
  try { JSON.parse(out); } catch { return null; }
  return out;
}

function stripKey(value: unknown, onRemove: () => void): unknown {
  if (Array.isArray(value)) return value.map((item) => stripKey(item, onRemove));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'prompt_cache_breakpoint') {
      onRemove();
      continue;
    }
    out[key] = stripKey(child, onRemove);
  }
  return out;
}

export function bodyHasPromptCacheBreakpoint(body: Uint8Array | string): boolean {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  return text.includes('"prompt_cache_breakpoint"');
}
