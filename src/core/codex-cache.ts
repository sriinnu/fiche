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

/** Drop injected or hinted breakpoint objects. Does not touch other cache fields
 *  such as OpenAI's prompt_cache_key. */
export function scrubPromptCacheBreakpoint(body: Uint8Array): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return body;
  }
  const scrubbed = stripKey(parsed);
  return new TextEncoder().encode(JSON.stringify(scrubbed));
}

function stripKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripKey);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'prompt_cache_breakpoint') continue;
    out[key] = stripKey(child);
  }
  return out;
}

export function bodyHasPromptCacheBreakpoint(body: Uint8Array | string): boolean {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  return text.includes('"prompt_cache_breakpoint"');
}
