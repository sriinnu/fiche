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

/** True when this route may receive an explicit prompt_cache_breakpoint. */
export function supportsExplicitPromptCacheBreakpoint(route: PromptCacheRoute = {}): boolean {
  const path = route.pathname ?? '';
  if (path === '/backend-api/codex/responses' || path.endsWith('/backend-api/codex/responses')) {
    return false;
  }
  const host = hostOf(route.upstream ?? '');
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) return false;
  return true;
}

// The only breakpoint this proxy injects is `{ mode: 'explicit' }` on a
// content part (openai.ts). Match that object as a key/value pair: after a
// comma, or right after `{`. Inside a JSON string the quotes are escaped, so
// `,"` and `{"` cannot match there.
const AFTER_COMMA = /,\s*"prompt_cache_breakpoint"\s*:\s*\{\s*"mode"\s*:\s*"explicit"\s*\}/g;
const AFTER_BRACE = /(?<=\{)\s*"prompt_cache_breakpoint"\s*:\s*\{\s*"mode"\s*:\s*"explicit"\s*\}\s*,?/g;

/** Drop breakpoint objects of the injected shape, editing the text in place.
 *  Nothing else is reserialized, so large integers, number spellings and
 *  key order survive, and a tool schema with a property of the same name is
 *  left alone. Bodies without the key are returned unchanged, so a Codex
 *  passthrough stays byte-identical. */
export function scrubPromptCacheBreakpoint(body: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(body);
  if (!text.includes('"prompt_cache_breakpoint"')) return body;
  const next = text.replace(AFTER_COMMA, '').replace(AFTER_BRACE, '');
  if (next === text) return body;
  try {
    JSON.parse(next);
  } catch {
    return body;
  }
  return new TextEncoder().encode(next);
}

export function bodyHasPromptCacheBreakpoint(body: Uint8Array | string): boolean {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  return text.includes('"prompt_cache_breakpoint"');
}
