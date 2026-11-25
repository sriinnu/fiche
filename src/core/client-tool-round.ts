/**
 * Client detection for the history-collapse round shape. Kept free of proxy
 * dependencies so the proxy and the Worker apply the same rule.
 */

/** Anything with a case-insensitive `get`, e.g. the Fetch `Headers` class. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** `x-app` values Claude Code sends (foreground and background sessions). */
const CLAUDE_CODE_X_APP = new Set(['cli', 'cli-bg']);

/**
 * True only when both Claude Code identity headers are present: the
 * `claude-cli/` User-Agent prefix AND an `x-app: cli|cli-bg` header. A tool
 * that only copies the User-Agent string does not match, so it keeps the
 * conservative round-level boundaries.
 */
function isClaudeCodeClient(headers: HeaderReader | null | undefined): boolean {
  if (!headers) return false;
  const userAgent = headers.get('user-agent') ?? '';
  const xApp = (headers.get('x-app') ?? '').trim().toLowerCase();
  return userAgent.startsWith('claude-cli/') && CLAUDE_CODE_X_APP.has(xApp);
}

/**
 * Claude Code sends a parallel tool batch as ONE assistant message, so each
 * closed call/result pair is a safe history boundary even across pure tool
 * loops with no text-only assistant turn. An explicit option from the host
 * (`FICHE_TRUST_ADJACENT_TOOL_ROUNDS`) wins over header detection.
 */
export function withClientToolRoundShape<T extends { separateAdjacentToolPairs?: boolean }>(
  opts: T | undefined,
  headers: HeaderReader | null | undefined,
): T | undefined {
  if (opts?.separateAdjacentToolPairs !== undefined) return opts;
  if (!isClaudeCodeClient(headers)) return opts;
  return { ...opts, separateAdjacentToolPairs: true } as T;
}

/**
 * Resolve `FICHE_TRUST_ADJACENT_TOOL_ROUNDS` for a host (Node or Worker).
 * Returns `value` (`undefined` = decide from client headers) and, for an
 * unrecognized value, the warning string the host should log.
 */
export function resolveTrustAdjacentToolRoundsEnv(
  raw: string | undefined,
): { value: boolean | undefined; warning?: string } {
  const parsed = parseTrustAdjacentToolRounds(raw);
  if (!parsed.invalid) return { value: parsed.value };
  return {
    value: undefined,
    warning:
      `[fiche] FICHE_TRUST_ADJACENT_TOOL_ROUNDS=${JSON.stringify(raw)} not recognized ` +
      '(use 1/0) — falling back to client-header detection',
  };
}

export function parseTrustAdjacentToolRounds(
  raw: string | undefined,
): { value: boolean | undefined; invalid: boolean } {
  const s = (raw ?? '').trim();
  if (s === '') return { value: undefined, invalid: false };
  if (/^(1|true|yes|on)$/i.test(s)) return { value: true, invalid: false };
  if (/^(0|false|no|off)$/i.test(s)) return { value: false, invalid: false };
  return { value: undefined, invalid: true };
}
