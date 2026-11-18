// Generate src/core/prices.generated.ts from a kosha registry snapshot.
//
//   pnpm prices:gen [path/to/snapshot.json]     (default: `kosha registry export`,
//                                                 or the file in $KOSHA_REGISTRY)
//   pnpm prices:check [path]                     fails if the committed table differs
//
// Use kosha >= 1.17.0's export: it carries the cited cache tiers, the
// as-input write billing, the long-context bands and dated changes. The
// ~/.kosha/registry.json cache does not.
//
// Only first-party rows (providerId === originProviderId) of the providers
// inkling serves are kept: a reseller's row says what the reseller charges,
// and its cache fields are often junk (OpenRouter's kimi-k3 reads at 0.95x
// input). Prices are absolute USD per 1M tokens; the resolver turns them into
// ratios. The output is deterministic (sorted, rounded) so a diff is a real
// price change.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeModelId } from '../src/core/price-id.js';

/** Provider precedence when two first-party rows normalise to one id. `zai`
 *  (api.z.ai) matches z.ai's official page; the `glm` rows don't (2026-11-17).
 *  `alibaba` is the international endpoint inkling routes to. */
const PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshot', 'zai', 'glm', 'minimax', 'alibaba'];

/** Maker names that count as the provider's own models. kosha >= 1.17 names
 *  Alibaba's own models' maker `qwen`. */
const OWN_ORIGINS: Record<string, string[]> = { alibaba: ['qwen'] };

function isFirstParty(provider: string, origin: string | undefined): boolean {
  return origin === provider || (origin !== undefined && (OWN_ORIGINS[provider] ?? []).includes(origin));
}

/** Rate fields carried through, kosha name -> short key. Fields kosha may add
 *  later (TTL write tiers, long-context cache rates) pass through when present. */
const FIELDS: Record<string, string> = {
  inputPerMillion: 'in',
  outputPerMillion: 'out',
  cacheReadPerMillion: 'cr',
  cacheWritePerMillion: 'cw',
  cacheWrite1hPerMillion: 'cw1h',
  longContextInputPerMillion: 'lcIn',
  longContextOutputPerMillion: 'lcOut',
  longContextThresholdTokens: 'lcAt',
  longContextCacheReadPerMillion: 'lcCr',
};

const OUT = new URL('../src/core/prices.generated.ts', import.meta.url);

function round(n: number): number {
  return Number(n.toPrecision(6));
}

/** A model as either kosha shape spells it: the registry cache
 *  (modelId/providerId/originProviderId) or `kosha registry export`
 *  (id/provider/originProvider, grouped under providers[]). */
interface KoshaModel {
  modelId?: string;
  providerId?: string;
  originProviderId?: string;
  id?: string;
  provider?: string;
  originProvider?: string;
  pricing?: Record<string, unknown> | null;
  aliases?: string[];
  status?: string;
}

export interface KoshaSnapshot {
  schemaVersion?: unknown;
  discoveredAt?: unknown;
  models?: KoshaModel[];
  providers?: Array<{ models?: KoshaModel[] }>;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round(v) : undefined;

/** [[ttlSeconds, perMillion], ...] sorted by TTL, or undefined. */
function tiers(v: unknown): Array<[number, number]> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<[number, number]> = [];
  for (const t of v as Array<Record<string, unknown>>) {
    const ttl = num(t?.ttlSeconds);
    const per = num(t?.perMillion);
    if (ttl !== undefined && ttl > 0 && per !== undefined) out.push([ttl, per]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.length ? out : undefined;
}

/** Long-context bands: above `at` prompt tokens (cached included), or from
 *  `at` when `incl`, the whole request bills at the band's rates. */
function bands(v: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const b of v as Array<Record<string, unknown>>) {
    const at = num(b?.aboveInputTokens);
    const inp = num(b?.inputPerMillion);
    if (at === undefined || inp === undefined || !(inp > 0)) continue;
    const band: Record<string, unknown> = { at };
    if (b.inclusive === true) band.incl = true;
    band.in = inp;
    const out_ = num(b.outputPerMillion); if (out_ !== undefined) band.out = out_;
    const cr = num(b.cacheReadPerMillion); if (cr !== undefined) band.cr = cr;
    const cwt = tiers(b.cacheWrites); if (cwt) band.cwt = cwt;
    out.push(band);
  }
  out.sort((a, b) => (a.at as number) - (b.at as number));
  return out.length ? out : undefined;
}

/** Dated absolute changes: from `at` (epoch ms) the listed rates apply. */
function changes(v: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const c of v as Array<Record<string, unknown>>) {
    const at = typeof c?.effectiveAt === 'string' ? Date.parse(c.effectiveAt) : NaN;
    const rates = c?.rates as Record<string, unknown> | undefined;
    if (!Number.isFinite(at) || !rates) continue;
    const ch: Record<string, unknown> = { at };
    for (const [k, short] of Object.entries(FIELDS)) {
      const n = num(rates[k]); if (n !== undefined) ch[short] = n;
    }
    if (Object.keys(ch).length > 1) out.push(ch);
  }
  out.sort((a, b) => (a.at as number) - (b.at as number));
  return out.length ? out : undefined;
}

function modelsOf(registry: KoshaSnapshot): KoshaModel[] {
  if (Array.isArray(registry.models)) return registry.models;
  return (registry.providers ?? []).flatMap((p) => p.models ?? []);
}

export function generate(registry: KoshaSnapshot): string {
  const rows = new Map<string, { provider: string; row: Record<string, unknown> }>();
  const aliases = new Map<string, string>();
  for (const m of modelsOf(registry)) {
    const provider = m.providerId ?? m.provider;
    const origin = m.originProviderId ?? m.originProvider;
    const modelId = m.modelId ?? m.id;
    if (!provider || !modelId || !isFirstParty(provider, origin)) continue;
    const rank = PROVIDERS.indexOf(provider);
    if (rank < 0 || !m.pricing) continue;
    const p = m.pricing;
    if (typeof p.inputPerMillion !== 'number' || !(p.inputPerMillion > 0)) continue;
    const row: Record<string, unknown> = {};
    for (const [k, short] of Object.entries(FIELDS)) {
      const v = num(p[k]);
      if (v !== undefined) row[short] = v;
    }
    const cwt = tiers(p.cacheWrites); if (cwt) row.cwt = cwt;
    if (p.cacheWriteBilling === 'as-input') row.cwb = 'as-input';
    const bs = bands(p.bands); if (bs) row.bands = bs;
    const ch = changes(p.changes); if (ch) row.chg = ch;
    const id = normalizeModelId(modelId);
    if (!id) continue;
    const prev = rows.get(id);
    if (prev && PROVIDERS.indexOf(prev.provider) <= rank) continue;
    rows.set(id, { provider, row });
    for (const a of m.aliases ?? []) {
      const an = normalizeModelId(a);
      if (an && an !== id && !aliases.has(an)) aliases.set(an, id);
    }
  }
  // An alias never shadows a real id.
  for (const a of [...aliases.keys()]) if (rows.has(a)) aliases.delete(a);

  const snapshot = `kosha schema ${String(registry.schemaVersion ?? '?')} discovered ${new Date(Number(registry.discoveredAt) || 0).toISOString()}`;
  const lines: string[] = [];
  lines.push('// GENERATED by scripts/gen-prices.ts from a kosha registry snapshot. Do not edit.');
  lines.push('// Regenerate with `pnpm prices:gen`; `pnpm prices:check` fails on drift.');
  lines.push('// USD per 1M tokens. in/out/cr/cw = input/output/cache read/cache write (short TTL);');
  lines.push('// cw1h = 1-hour write; cwt = [ttlSeconds, perMillion] write tiers; cwb = as-input when');
  lines.push('// a write bills as plain input; bands = long-context tiers (above `at` prompt tokens, from');
  lines.push('// `at` when incl, the whole request bills at the band); chg = dated changes (at = epoch ms).');
  lines.push('');
  lines.push('export interface PriceBand { at: number; incl?: true; in: number; out?: number; cr?: number; cwt?: Array<[number, number]> }');
  lines.push('export interface PriceChange { at: number; in?: number; out?: number; cr?: number; cw?: number; cw1h?: number }');
  lines.push('export interface PriceRow {');
  lines.push('  p: string; in: number; out?: number; cr?: number; cw?: number; cw1h?: number;');
  lines.push('  lcIn?: number; lcOut?: number; lcAt?: number; lcCr?: number;');
  lines.push("  cwt?: Array<[number, number]>; cwb?: 'as-input'; bands?: PriceBand[]; chg?: PriceChange[];");
  lines.push('}');
  lines.push('');
  lines.push(`export const PRICE_SNAPSHOT = ${JSON.stringify(snapshot)};`);
  lines.push('');
  lines.push('export const PRICES: Readonly<Record<string, PriceRow>> = {');
  for (const id of [...rows.keys()].sort()) {
    const { provider, row } = rows.get(id)!;
    lines.push(`  ${JSON.stringify(id)}: ${JSON.stringify({ p: provider, ...row })},`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export const PRICE_ALIASES: Readonly<Record<string, string>> = {');
  for (const a of [...aliases.keys()].sort()) lines.push(`  ${JSON.stringify(a)}: ${JSON.stringify(aliases.get(a))},`);
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const path = args.find((a) => !a.startsWith('--')) ?? process.env.KOSHA_REGISTRY;
  let raw: string;
  let source: string;
  if (path) {
    raw = readFileSync(path, 'utf8');
    source = path;
  } else {
    try {
      raw = execFileSync('kosha', ['registry', 'export'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      console.error('kosha registry export failed; install kosha >= 1.17.0 or pass a snapshot path');
      process.exit(2);
    }
    source = 'kosha registry export';
  }
  const registry = JSON.parse(raw) as KoshaSnapshot;
  const text = generate(registry);
  if (check) {
    let current = '';
    try { current = readFileSync(OUT, 'utf8'); } catch { /* missing = drift */ }
    // The snapshot line dates the export; only a price change is drift.
    const body = (t: string) => t.replace(/^export const PRICE_SNAPSHOT = .*$/m, '');
    if (body(current) !== body(text)) {
      console.error(`prices.generated.ts is stale against ${source}; run pnpm prices:gen`);
      process.exit(1);
    }
    console.log('prices.generated.ts matches the snapshot');
    return;
  }
  let previous = '';
  try { previous = readFileSync(OUT, 'utf8'); } catch { /* first run */ }
  const ids = (t: string) => new Set([...t.matchAll(/^  "([^"]+)": \{"p"/gm)].map((m) => m[1]!));
  const gone = [...ids(previous)].filter((id) => !ids(text).has(id));
  if (gone.length) console.warn(`dropped ${gone.length} rows no longer in the snapshot: ${gone.join(', ')}`);
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT.pathname} (${text.split('\n').length} lines) from ${source}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
