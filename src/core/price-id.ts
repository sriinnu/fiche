/**
 * Model id normalisation for price lookup. Shared by the resolver and by
 * scripts/gen-prices.ts, so a snapshot key and a request's model id are
 * spelled the same way. Workers-safe.
 */

/** Lowercase; drop bracketed transport tags (`[1m]`), a vendor path
 *  (`anthropic/`, `moonshotai/`), a `:variant` suffix (`:free`, `:thinking`)
 *  and a trailing release date (`-20250929`, `-2026-05-20`, `@20250514`). */
export function normalizeModelId(model: string | null | undefined): string {
  let m = (model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]/g, '');
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  const colon = m.indexOf(':');
  if (colon >= 0) m = m.slice(0, colon);
  m = m
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
    .replace(/-v\d+$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
  m = m.replace(/^(claude-(?:[a-z-]+-)?)(\d+)\.(\d+)(.*)$/, '$1$2-$3$4');
  return m;
}
