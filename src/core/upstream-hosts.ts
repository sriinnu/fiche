/**
 * The provider hosts inkling knows, and the "follow the agent" resolver.
 *
 * Following means: forward a request to the host the agent was actually talking
 * to, instead of to whichever upstream inkling's env vars name. It applies to
 * third-party (`compat`) hosts only. First-party hosts keep the configured
 * routing (ANTHROPIC/OPENAI/Google upstreams, gateways, bridges), so nothing
 * that works today changes.
 *
 * Two ways in, one registry:
 *  - Host: under `inkling warp` the agent still addresses its own provider and
 *    warp keeps that Host when diverting into inkling.
 *  - Path: `http://127.0.0.1:47821/to/<host>/<rest>` for agents configured by
 *    base URL, so one inkling serves many providers with no per-provider env.
 *
 * Both can only ever select a registry host, over https on 443, so neither is an
 * open proxy: an arbitrary host, port, IP literal or local name is refused or
 * left to legacy routing. The followed request carries only the agent's own
 * credential; configured keys stay bound to their configured upstreams (see
 * proxy.ts).
 */

import { readBrandEnv } from './env.js';

export type UpstreamFamily = 'anthropic' | 'openai' | 'google' | 'compat';

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'kimi'
  | 'glm'
  | 'minimax'
  | 'qwen'
  | 'openrouter'
  | 'xai'
  | 'groq'
  | 'together'
  | 'fireworks'
  | 'cerebras'
  | 'mistral'
  | 'perplexity'
  | 'cohere'
  | 'sambanova'
  | 'github'
  | 'azure'
  | 'vercel';

export type ProviderTier = 'first-party' | 'third-party';

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly label: string;
  readonly tier: ProviderTier;
  readonly defaultEnabled: boolean;
  readonly hosts: readonly string[];
  readonly aliases?: readonly string[];
  readonly envKeys?: readonly string[];
}

export interface ProviderStatus {
  readonly id: ProviderId;
  readonly label: string;
  readonly tier: ProviderTier;
  readonly hosts: readonly string[];
  readonly enabled: boolean;
}

export interface UpstreamHost {
  /** Exact lowercase hostname; no wildcards. */
  readonly host: string;
  readonly family: UpstreamFamily;
  /** Canonical provider bucket for opt-in scoping; undefined for custom FICHE_UPSTREAM_HOSTS entries. */
  readonly provider?: ProviderId;
  /**
   * API path prefixes on this host, longest first when resolved. Stripping one
   * gives the canonical wire path (`/v1/messages`, `/v1/chat/completions`, ...)
   * that the wire classifiers understand; the upstream still gets the original
   * path byte-for-byte. `''` means the API sits at the root.
   */
  readonly prefixes: readonly string[];
}

/** First-party hosts: trusted as inbound Host names, never followed. */
const FIRST_PARTY: readonly UpstreamHost[] = [
  { host: 'api.anthropic.com', family: 'anthropic', provider: 'anthropic', prefixes: [''] },
  { host: 'api.openai.com', family: 'openai', provider: 'openai', prefixes: [''] },
  { host: 'chatgpt.com', family: 'openai', provider: 'openai', prefixes: ['/backend-api/codex'] },
  { host: 'generativelanguage.googleapis.com', family: 'google', provider: 'google', prefixes: [''] },
  { host: 'cloudcode-pa.googleapis.com', family: 'google', provider: 'google', prefixes: [''] },
  { host: 'daily-cloudcode-pa.googleapis.com', family: 'google', provider: 'google', prefixes: [''] },
];

/**
 * Third-party providers with Anthropic- and/or OpenAI-compatible endpoints.
 * Hostnames and prefixes are from the providers' published Claude Code setup
 * guides (2026-11); `FICHE_UPSTREAM_HOSTS` adds more without a release.
 */
const COMPAT: readonly UpstreamHost[] = [
  { host: 'api.deepseek.com', family: 'compat', provider: 'deepseek', prefixes: ['/anthropic', ''] },
  { host: 'api.moonshot.ai', family: 'compat', provider: 'kimi', prefixes: ['/anthropic', ''] },
  { host: 'api.moonshot.cn', family: 'compat', provider: 'kimi', prefixes: ['/anthropic', ''] },
  { host: 'api.kimi.com', family: 'compat', provider: 'kimi', prefixes: ['/coding', ''] },
  { host: 'api.z.ai', family: 'compat', provider: 'glm', prefixes: ['/api/anthropic', '/api/coding/paas/v4', '/api/paas/v4'] },
  { host: 'open.bigmodel.cn', family: 'compat', provider: 'glm', prefixes: ['/api/anthropic', '/api/paas/v4'] },
  { host: 'api.minimax.io', family: 'compat', provider: 'minimax', prefixes: ['/anthropic', ''] },
  { host: 'api.minimaxi.com', family: 'compat', provider: 'minimax', prefixes: ['/anthropic', ''] },
  { host: 'dashscope-intl.aliyuncs.com', family: 'compat', provider: 'qwen', prefixes: ['/apps/anthropic', '/compatible-mode'] },
  { host: 'dashscope.aliyuncs.com', family: 'compat', provider: 'qwen', prefixes: ['/apps/anthropic', '/compatible-mode'] },
  { host: 'openrouter.ai', family: 'compat', provider: 'openrouter', prefixes: ['/api'] },
  { host: 'api.x.ai', family: 'compat', provider: 'xai', prefixes: [''] },
  { host: 'api.groq.com', family: 'compat', provider: 'groq', prefixes: ['/openai', ''] },
  { host: 'api.together.xyz', family: 'compat', provider: 'together', prefixes: [''] },
  { host: 'api.fireworks.ai', family: 'compat', provider: 'fireworks', prefixes: ['/inference', ''] },
  { host: 'api.cerebras.ai', family: 'compat', provider: 'cerebras', prefixes: [''] },
  { host: 'api.mistral.ai', family: 'compat', provider: 'mistral', prefixes: [''] },
  { host: 'api.perplexity.ai', family: 'compat', provider: 'perplexity', prefixes: [''] },
  { host: 'api.cohere.com', family: 'compat', provider: 'cohere', prefixes: ['/compatibility', ''] },
  { host: 'api.sambanova.ai', family: 'compat', provider: 'sambanova', prefixes: [''] },
  { host: 'models.github.ai', family: 'compat', provider: 'github', prefixes: ['/inference', ''] },
  { host: 'models.inference.ai.azure.com', family: 'compat', provider: 'azure', prefixes: [''] },
  { host: 'ai-gateway.vercel.sh', family: 'compat', provider: 'vercel', prefixes: [''] },
];

const PROVIDER_META: ReadonlyArray<Omit<ProviderDescriptor, 'hosts'>> = [
  { id: 'anthropic', label: 'Anthropic / Claude', tier: 'first-party', defaultEnabled: true, aliases: ['claude'], envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] },
  { id: 'openai', label: 'OpenAI / Codex', tier: 'first-party', defaultEnabled: true, aliases: ['codex', 'chatgpt'], envKeys: ['OPENAI_API_KEY'] },
  { id: 'google', label: 'Google / Gemini', tier: 'first-party', defaultEnabled: true, aliases: ['gemini', 'antigravity'], envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  { id: 'deepseek', label: 'DeepSeek', tier: 'third-party', defaultEnabled: false, envKeys: ['DEEPSEEK_API_KEY'] },
  { id: 'kimi', label: 'Kimi / Moonshot', tier: 'third-party', defaultEnabled: false, aliases: ['moonshot'], envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
  { id: 'glm', label: 'GLM / Z.ai', tier: 'third-party', defaultEnabled: false, aliases: ['zai', 'z.ai', 'bigmodel'], envKeys: ['ZAI_API_KEY', 'ZHIPU_API_KEY'] },
  { id: 'minimax', label: 'MiniMax', tier: 'third-party', defaultEnabled: false, envKeys: ['MINIMAX_API_KEY'] },
  { id: 'qwen', label: 'Qwen / DashScope', tier: 'third-party', defaultEnabled: false, aliases: ['dashscope', 'alibaba'], envKeys: ['DASHSCOPE_API_KEY'] },
  { id: 'openrouter', label: 'OpenRouter', tier: 'third-party', defaultEnabled: false, envKeys: ['OPENROUTER_API_KEY'] },
  { id: 'xai', label: 'xAI / Grok', tier: 'third-party', defaultEnabled: false, aliases: ['grok'], envKeys: ['XAI_API_KEY'] },
  { id: 'groq', label: 'Groq', tier: 'third-party', defaultEnabled: false, envKeys: ['GROQ_API_KEY'] },
  { id: 'together', label: 'Together AI', tier: 'third-party', defaultEnabled: false, envKeys: ['TOGETHER_API_KEY'] },
  { id: 'fireworks', label: 'Fireworks AI', tier: 'third-party', defaultEnabled: false, envKeys: ['FIREWORKS_API_KEY'] },
  { id: 'cerebras', label: 'Cerebras', tier: 'third-party', defaultEnabled: false, envKeys: ['CEREBRAS_API_KEY'] },
  { id: 'mistral', label: 'Mistral', tier: 'third-party', defaultEnabled: false, envKeys: ['MISTRAL_API_KEY'] },
  { id: 'perplexity', label: 'Perplexity', tier: 'third-party', defaultEnabled: false, envKeys: ['PERPLEXITY_API_KEY'] },
  { id: 'cohere', label: 'Cohere', tier: 'third-party', defaultEnabled: false, envKeys: ['COHERE_API_KEY'] },
  { id: 'sambanova', label: 'SambaNova', tier: 'third-party', defaultEnabled: false, envKeys: ['SAMBANOVA_API_KEY'] },
  { id: 'github', label: 'GitHub Models', tier: 'third-party', defaultEnabled: false, aliases: ['github-models'], envKeys: ['GITHUB_MODELS_TOKEN'] },
  { id: 'azure', label: 'Azure AI Inference', tier: 'third-party', defaultEnabled: false, aliases: ['azure-ai'], envKeys: ['AZURE_AI_API_KEY'] },
  { id: 'vercel', label: 'Vercel AI Gateway', tier: 'third-party', defaultEnabled: false, aliases: ['vercel-ai'], envKeys: ['AI_GATEWAY_API_KEY', 'VERCEL_AI_GATEWAY_KEY'] },
];

const ALL_BUILTIN_HOSTS: readonly UpstreamHost[] = [...FIRST_PARTY, ...COMPAT];

export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = PROVIDER_META.map((meta) => ({
  ...meta,
  hosts: ALL_BUILTIN_HOSTS.filter((h) => h.provider === meta.id).map((h) => h.host),
}));

export const DEFAULT_ENABLED_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google'];

const PROVIDER_ALIAS_MAP: ReadonlyMap<string, ProviderId> = (() => {
  const map = new Map<string, ProviderId>();
  for (const p of PROVIDER_CATALOG) {
    map.set(p.id.toLowerCase(), p.id);
    for (const alias of p.aliases ?? []) map.set(alias.toLowerCase(), p.id);
  }
  return map;
})();

/** Map a user-supplied provider name or alias (`grok` → `xai`, `claude` → `anthropic`) to a canonical ProviderId. */
export function normalizeProviderId(raw: string): ProviderId | null {
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return PROVIDER_ALIAS_MAP.get(key) ?? null;
}

/** Parse a CSV string, special keyword (`all`, `*`, `off`, `none`), or string array into ProviderIds. */
export function parseProvidersSpec(
  raw: string | readonly string[] | undefined,
): { providers: ProviderId[] | null; unknown: string[] } {
  if (raw === undefined) return { providers: null, unknown: [] };
  let tokens: string[];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { providers: null, unknown: [] };
    if (/^(?:all|\*)$/i.test(trimmed)) {
      return { providers: PROVIDER_CATALOG.map((p) => p.id), unknown: [] };
    }
    if (/^(?:0|false|no|off|none)$/i.test(trimmed)) {
      return { providers: [], unknown: [] };
    }
    tokens = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    if (raw.length === 0) return { providers: [], unknown: [] };
    tokens = raw.map((s) => String(s).trim()).filter(Boolean);
    if (tokens.length === 0) return { providers: [], unknown: [] };
    if (tokens.length === 1 && /^(?:all|\*)$/i.test(tokens[0]!)) {
      return { providers: PROVIDER_CATALOG.map((p) => p.id), unknown: [] };
    }
    if (tokens.length === 1 && /^(?:0|false|no|off|none)$/i.test(tokens[0]!)) {
      return { providers: [], unknown: [] };
    }
  }
  const seen = new Set<ProviderId>();
  const unknown: string[] = [];
  for (const tok of tokens) {
    const id = normalizeProviderId(tok);
    if (id) seen.add(id);
    else unknown.push(tok);
  }
  return { providers: [...seen], unknown };
}

let runtimeEnabledProviders: readonly ProviderId[] | null = null;

function envOrDefaultProviders(): ProviderId[] {
  const { providers } = parseProvidersSpec(readBrandEnv('PROVIDERS'));
  return providers !== null ? providers : [...DEFAULT_ENABLED_PROVIDERS];
}

/** Current effective enabled provider list. Defaults to first-party providers only (`anthropic`, `openai`, `google`). */
export function getEnabledProviders(): ProviderId[] {
  return runtimeEnabledProviders !== null ? [...runtimeEnabledProviders] : envOrDefaultProviders();
}

/** Env / config configured providers, ignoring temporary in-memory overrides. */
export function getConfiguredProviders(): ProviderId[] {
  return envOrDefaultProviders();
}

/** Replace the runtime provider override, or pass `null` to fall back to `FICHE_PROVIDERS` / default. */
export function setEnabledProviders(list: readonly ProviderId[] | null): void {
  if (list === null) {
    runtimeEnabledProviders = null;
    return;
  }
  const seen = new Set<ProviderId>();
  for (const entry of list) {
    const normalized = normalizeProviderId(String(entry));
    if (normalized) seen.add(normalized);
  }
  runtimeEnabledProviders = [...seen];
}

/** Return the full catalog annotated with live `enabled` flags. */
export function listProviderStatuses(
  enabled: readonly ProviderId[] = getEnabledProviders(),
): ProviderStatus[] {
  const on = new Set(enabled);
  return PROVIDER_CATALOG.map((p) => ({
    id: p.id,
    label: p.label,
    tier: p.tier,
    hosts: [...p.hosts],
    enabled: on.has(p.id),
  }));
}

/** Detect providers whose standard API key env var is non-empty (presence only; never returns secret values). */
export function detectProvidersFromEnv(
  env: Readonly<Record<string, string | undefined>> = typeof process !== 'undefined' ? process.env : {},
): Array<{ id: ProviderId; matchedEnvKey: string }> {
  const found: Array<{ id: ProviderId; matchedEnvKey: string }> = [];
  for (const p of PROVIDER_CATALOG) {
    for (const key of p.envKeys ?? []) {
      if (env[key]?.trim()) {
        found.push({ id: p.id, matchedEnvKey: key });
        break;
      }
    }
  }
  return found;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Could this name ever be an outbound follow target? Syntax only: a public,
 * dotted DNS name. IP literals, single labels, and local suffixes are inbound
 * conveniences in the request guard; they must never become outbound targets.
 */
export function isFollowableHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  if (/^\d+$/.test(labels.at(-1)!)) return false; // 10.0.0.1, 1.2.3.4
  const tld = labels.at(-1)!;
  if (['localhost', 'local', 'internal', 'lan', 'home', 'arpa', 'test', 'invalid', 'example'].includes(tld)) return false;
  return true;
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * `INKLING_UPSTREAM_HOSTS=host[/prefix][,host[/prefix]...]`. Extra prefixes for
 * one host may be listed as separate entries. Invalid names are dropped with no
 * fallback to "allow anything": a typo must not widen the list.
 */
export function parseUpstreamHosts(spec: string | undefined): UpstreamHost[] {
  if (!spec) return [];
  const byHost = new Map<string, Set<string>>();
  for (const raw of spec.split(',')) {
    const item = raw.trim().toLowerCase();
    if (item === '') continue;
    const slash = item.indexOf('/');
    const host = (slash < 0 ? item : item.slice(0, slash)).replace(/\.$/, '');
    if (!isFollowableHostname(host)) continue;
    const prefix = normalizePrefix(slash < 0 ? '' : item.slice(slash));
    if (!/^(?:\/[a-z0-9._~-]+)*$/.test(prefix)) continue;
    const set = byHost.get(host) ?? new Set<string>();
    set.add(prefix);
    byHost.set(host, set);
  }
  return [...byHost].map(([host, prefixes]) => ({ host, family: 'compat' as const, prefixes: [...prefixes, ''] }));
}

export type UpstreamRegistry = ReadonlyMap<string, UpstreamHost>;

/** Built-in hosts plus extensions. An extension can add hosts or prefixes, but
 *  never re-families or removes a first-party host. */
export function buildUpstreamRegistry(extra: readonly UpstreamHost[] = []): UpstreamRegistry {
  const map = new Map<string, UpstreamHost>();
  for (const entry of [...FIRST_PARTY, ...COMPAT]) map.set(entry.host, entry);
  for (const entry of extra) {
    if (!isFollowableHostname(entry.host)) continue;
    const existing = map.get(entry.host);
    if (existing && existing.family !== 'compat') continue;
    const prefixes = new Set([...(existing?.prefixes ?? []), ...entry.prefixes]);
    map.set(entry.host, { host: entry.host, family: 'compat', prefixes: [...prefixes] });
  }
  return map;
}

/** The built-in registry; `INKLING_UPSTREAM_HOSTS` is applied by the Node entry. */
export const DEFAULT_UPSTREAM_REGISTRY: UpstreamRegistry = buildUpstreamRegistry();

export interface FollowTarget {
  readonly host: string;
  readonly entry: UpstreamHost;
  /** `https://<host>`; never another scheme or port. */
  readonly origin: string;
  /** Path + query sent upstream, exactly as the agent meant it. */
  readonly outboundPath: string;
  /** Path with the host's API prefix removed, for the wire classifiers. */
  readonly wirePathname: string;
  readonly via: 'host' | 'path';
}

export interface FollowRefusal {
  readonly status: 400 | 421;
  readonly reason: 'follow_refused';
  readonly message: string;
}

function wirePathFor(entry: UpstreamHost, pathname: string): string {
  const prefixes = [...entry.prefixes].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (prefix === '') return pathname;
    if (pathname === prefix) return '/';
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  }
  return pathname;
}

/** Parse "host[:port]" from a Host header: lowercase, trailing dot removed. */
function splitHostHeader(value: string): { host: string; port: string | null } | null {
  const v = value.trim().toLowerCase();
  if (v === '' || v.startsWith('[')) return null; // IPv6 literal: never followed
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return null;
  return { host: m[1]!.replace(/\.$/, ''), port: m[2] ?? null };
}

/**
 * Decide whether this request follows the agent's host.
 *
 *  - `null`: not a follow request; legacy routing applies.
 *  - `FollowRefusal`: a `/to/` request that names something inkling will not
 *    forward to. Refused before any upstream call.
 *  - `FollowTarget`: forward to `origin + outboundPath`.
 */
export function resolveFollowTarget(
  url: URL,
  hostHeader: string | null,
  registry: UpstreamRegistry = DEFAULT_UPSTREAM_REGISTRY,
  enabledProviders?: ReadonlySet<string>,
): FollowTarget | FollowRefusal | null {
  // `url.pathname` is already dot-segment-normalized by the URL parser, and
  // percent-escapes stay escaped, so `%2f`/`%40` tricks fail the syntax check.
  if (url.pathname === '/to' || url.pathname.startsWith('/to/')) {
    const rest = url.pathname.slice('/to/'.length);
    const slash = rest.indexOf('/');
    const hostPart = slash < 0 ? rest : rest.slice(0, slash);
    const host = hostPart.toLowerCase().replace(/\.$/, '');
    const refuse = (message: string): FollowRefusal => ({ status: 400, reason: 'follow_refused', message });
    if (!isFollowableHostname(host)) return refuse(`fiche: /to/ needs a provider hostname, got ${JSON.stringify(hostPart.slice(0, 100))}`);
    const entry = registry.get(host);
    if (!entry) return refuse(`fiche: ${host} is not a known provider host; add it with FICHE_UPSTREAM_HOSTS`);
    if (entry.family !== 'compat') {
      return refuse(`fiche: ${host} is first-party; point the agent at fiche's plain base URL instead of /to/`);
    }
    if (enabledProviders && entry.provider !== undefined && !enabledProviders.has(entry.provider)) {
      return refuse(
        `fiche: ${host} (provider ${entry.provider}) is disabled; enable it via \`fiche providers enable ${entry.provider}\` or FICHE_PROVIDERS`,
      );
    }
    const tail = slash < 0 ? '/' : rest.slice(slash);
    return {
      host,
      entry,
      origin: `https://${host}`,
      outboundPath: tail + url.search,
      wirePathname: wirePathFor(entry, tail),
      via: 'path',
    };
  }
  if (hostHeader === null) return null;
  const parsed = splitHostHeader(hostHeader);
  if (!parsed) return null;
  const entry = registry.get(parsed.host);
  if (!entry || entry.family !== 'compat') return null;
  // Defense in depth: a registry handed in by a caller is still never allowed
  // to point at an IP literal or a local name.
  if (!isFollowableHostname(parsed.host)) return null;
  // Never fall back to legacy first-party routing when a registered third-party
  // provider is disabled — return an explicit refusal instead.
  if (enabledProviders && entry.provider !== undefined && !enabledProviders.has(entry.provider)) {
    return {
      status: 421,
      reason: 'follow_refused',
      message: `fiche: ${parsed.host} (provider ${entry.provider}) is disabled; enable it via \`fiche providers enable ${entry.provider}\` or FICHE_PROVIDERS`,
    };
  }
  // A third-party Host that is not followed must not fall back to legacy
  // routing: that would hand its request, and the configured first-party keys,
  // to the default upstream.
  if (parsed.port !== null && parsed.port !== '443') {
    return {
      status: 421,
      reason: 'follow_refused',
      message: `fiche: ${parsed.host}:${parsed.port} refused; provider hosts are followed on https:443 only`,
    };
  }
  return {
    host: parsed.host,
    entry,
    origin: `https://${parsed.host}`,
    outboundPath: url.pathname + url.search,
    wirePathname: wirePathFor(entry, url.pathname),
    via: 'host',
  };
}

/**
 * For `followHosts: false`: a Host naming a registered third-party provider
 * cannot be served, because legacy routing would send it to the configured
 * first-party upstream with the configured keys. Returns the refusal, or null.
 */
export function refuseUnfollowedProviderHost(
  hostHeader: string | null,
  registry: UpstreamRegistry = DEFAULT_UPSTREAM_REGISTRY,
): FollowRefusal | null {
  const parsed = hostHeader === null ? null : splitHostHeader(hostHeader);
  if (!parsed) return null;
  const entry = registry.get(parsed.host);
  if (!entry || entry.family !== 'compat') return null;
  return {
    status: 421,
    reason: 'follow_refused',
    message: `fiche: ${parsed.host} is a third-party provider and following is off (FICHE_FOLLOW_HOSTS=0)`,
  };
}

export function isFollowRefusal(v: FollowTarget | FollowRefusal | null): v is FollowRefusal {
  return v !== null && 'reason' in v;
}
