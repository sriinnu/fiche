/**
 * One place every price ratio comes from.
 *
 * inkling compares token counts weighted by price ratios (cached input,
 * cache write and output, each divided by the uncached input price). The
 * compression gate and the savings math must use the same ratios for the same
 * model, so both ask here.
 *
 * Two sources, chosen by `INKLING_PRICES`:
 *  - `legacy` (default): the values inkling has always used. Profile fields
 *    for the savings math; Anthropic's 5-minute-tier ratios (1.25x write,
 *    0.1x read) for the gate, whatever the model. These are NOT the official
 *    per-model prices (Opus 5.5 reads at 0.05x).
 *  - `kosha`: the build-time table in prices.generated.ts (first-party rows
 *    of a kosha snapshot; `pnpm prices:gen`). An explicit pricing field in
 *    INKLING_GPT_PROFILES still wins. A model with no sane row is UNPRICED:
 *    the gate passes it through untouched, the savings math falls back to the
 *    profile and reports the source as unpriced.
 *
 * Kosha mode also reads the snapshot's TTL write tiers, long-context bands and
 * dated changes through a {@link PriceContext}: the cache TTL the request
 * writes, its prompt size (cached tokens included) and the time. Bands keep
 * the ratios nearly flat (OpenAI, xAI and Haiku 5.5 double input, read and
 * write together); they matter for absolute dollars. The TTL tier matters for
 * the gate: an Anthropic 1h write costs 2x input, not 1.25x.
 *
 * Workers-safe: no node:, no fs. Reads process.env only behind a typeof guard,
 * like gpt-model-profiles.ts.
 */

import { CACHE_CREATE_RATE, CACHE_READ_RATE } from './baseline.js';
import { envPricingOverride, resolveGptProfile } from './gpt-model-profiles.js';
import { normalizeModelId } from './price-id.js';
import { PRICES, PRICE_ALIASES, PRICE_SNAPSHOT, type PriceRow } from './prices.generated.js';

/** What the request looks like, for picking a TTL tier, a band and a dated
 *  change. Every field is optional; an empty context prices the base row. */
export interface PriceContext {
  /** Cache TTL the request writes, in seconds (Anthropic `ttl: "1h"` = 3600). */
  ttlSec?: number;
  /** Prompt tokens, cached included: what a provider compares to a band line. */
  promptTokens?: number;
  /** Epoch ms the request is billed at. Default now. */
  at?: number;
}

/** Price ratios relative to the model's uncached input price. */
export interface PriceRates {
  /** Cached-input (cache read) price ÷ input price. */
  read: number;
  /** Shortest-TTL cache write price ÷ input price. 1 when the provider charges
   *  no write premium (the write bills as ordinary input). */
  write: number;
  /** Output price ÷ input price. */
  output: number;
}

export type PriceSource = 'legacy' | 'env' | 'kosha' | 'unpriced';

export { PRICE_SNAPSHOT };

/** The ratios the Anthropic gate has always priced with: 5-minute write tier,
 *  0.1x read, for every Claude model. */
export const ANTHROPIC_GATE_RATES: Readonly<PriceRates> = Object.freeze({
  read: CACHE_READ_RATE,
  write: CACHE_CREATE_RATE,
  output: 5,
});

/** Which source is active. Anything other than `kosha` is legacy. */
export function priceMode(): 'legacy' | 'kosha' {
  const raw = (typeof process !== 'undefined' && process.env && process.env.INKLING_PRICES) || '';
  return raw.trim().toLowerCase() === 'kosha' ? 'kosha' : 'legacy';
}

/** The snapshot row for a model: exact normalised id, then a kosha alias, then
 *  the longest snapshot id that prefixes it at a `-` boundary (a `-codex` or
 *  `-latest` variant prices as its base). */
export function priceRowFor(model: string | null | undefined): PriceRow | undefined {
  const id = normalizeModelId(model);
  if (!id) return undefined;
  const exact = PRICES[id] ?? (PRICE_ALIASES[id] ? PRICES[PRICE_ALIASES[id]!] : undefined);
  if (exact) return exact;
  let best: string | undefined;
  for (const key of Object.keys(PRICES)) {
    if (id.startsWith(key + '-') && (best === undefined || key.length > best.length)) best = key;
  }
  return best ? PRICES[best] : undefined;
}

/** The row as billed under `ctx`: due dated changes applied, then the band the
 *  prompt falls in (above `at`, or from `at` when `incl`) replacing the base
 *  rates. A band without its own read or write tiers scales the base ones by
 *  its input ratio. */
export function effectiveRow(row: PriceRow | undefined, ctx: PriceContext = {}): PriceRow | undefined {
  if (!row) return undefined;
  let r: PriceRow = { ...row };
  const at = ctx.at ?? Date.now();
  for (const c of row.chg ?? []) {
    if (c.at > at) continue;
    const { at: _at, ...rates } = c;
    r = { ...r, ...rates };
    // A dated write price supersedes the tier list it was cut from.
    if (rates.cw !== undefined || rates.cw1h !== undefined) delete r.cwt;
  }
  const n = ctx.promptTokens;
  if (typeof n === 'number' && Number.isFinite(n)) {
    let band: NonNullable<PriceRow['bands']>[number] | undefined;
    for (const b of r.bands ?? []) if (n > b.at || (b.incl === true && n >= b.at)) band = b;
    if (band && r.in > 0) {
      const k = band.in / r.in;
      r = {
        ...r,
        in: band.in,
        out: band.out ?? (r.out !== undefined ? r.out * k : undefined),
        cr: band.cr ?? (r.cr !== undefined ? r.cr * k : undefined),
        cw: band.cwt?.[0]?.[1] ?? (r.cw !== undefined ? r.cw * k : undefined),
        cw1h: r.cw1h !== undefined ? r.cw1h * k : undefined,
        cwt: band.cwt ?? r.cwt?.map(([ttl, per]) => [ttl, per * k] as [number, number]),
      };
    }
  }
  return r;
}

/** Write price for a TTL: the exact tier, else the shortest tier that lasts
 *  at least that long, else the longest. No TTL or no tiers = the flat `cw`. */
function writePriceFor(row: PriceRow, ttlSec: number | undefined): number | undefined {
  const tiers = row.cwt;
  if (!ttlSec || !tiers || tiers.length === 0) return row.cw;
  const sorted = [...tiers].sort((a, b) => a[0] - b[0]);
  return (sorted.find(([ttl]) => ttl >= ttlSec) ?? sorted[sorted.length - 1]!)[1];
}

/** Ratios from a snapshot row, or undefined when the row can't be trusted for
 *  ratios: no positive input or output, no cache read, a read at or above
 *  input, or a write outside [input, 3x input]. A write of 0 or none means no
 *  write premium (DeepSeek, z.ai, xAI bill the write as ordinary input). */
export function ratesFromRow(row: PriceRow | undefined, ttlSec?: number): PriceRates | undefined {
  if (!row || !(row.in > 0) || !(typeof row.out === 'number' && row.out > 0)) return undefined;
  if (typeof row.cr !== 'number') return undefined;
  const read = row.cr / row.in;
  if (!(read > 0 && read < 1)) return undefined;
  // `as-input`: the write bills as plain input (DeepSeek, xAI, z.ai, Google).
  const cw = writePriceFor(row, ttlSec);
  const write = row.cwb === 'as-input' ? 1
    : typeof cw === 'number' && cw > 0 ? cw / row.in : 1;
  if (!(write >= 1 && write <= 3)) return undefined;
  return { read, write, output: row.out / row.in };
}

function profileRates(model: string | undefined): PriceRates {
  const profile = resolveGptProfile(model);
  return {
    read: profile.cacheReadRate,
    write: profile.cacheWriteRate ?? 1,
    output: profile.outputRate,
  };
}

/** Kosha-mode ratios with their source; env fields override field by field. */
function koshaRates(model: string | undefined, ctx: PriceContext = {}): { rates: PriceRates; source: PriceSource } | undefined {
  const env = envPricingOverride(model);
  const fromRow = ratesFromRow(effectiveRow(priceRowFor(model), ctx), ctx.ttlSec);
  if (!env) return fromRow ? { rates: fromRow, source: 'kosha' } : undefined;
  const base = fromRow ?? profileRates(model);
  return {
    rates: {
      read: env.cacheReadRate ?? base.read,
      write: env.cacheWriteRate ?? base.write,
      output: env.outputRate ?? base.output,
    },
    source: 'env',
  };
}

/** Where this model's savings ratios come from under the active mode. */
export function priceSourceFor(model: string | undefined): PriceSource {
  if (priceMode() === 'legacy') return 'legacy';
  return koshaRates(model)?.source ?? 'unpriced';
}

/** Ratios for a model as the savings math prices it. In kosha mode an
 *  unpriced model falls back to its profile; check {@link priceSourceFor}
 *  before presenting that number as a measured saving. */
export function resolvePriceRates(model: string | undefined, ctx?: PriceContext): PriceRates {
  if (priceMode() === 'kosha') {
    const k = koshaRates(model, ctx);
    if (k) return k.rates;
  }
  return profileRates(model);
}

/** Ratios the image/text gate in transform.ts prices with, or null when the
 *  model is unpriced in kosha mode (the gate then passes the text through).
 *  Legacy mode keeps the historical Anthropic ratios for every model. */
export function gateRatesFor(model: string | undefined, ctx?: PriceContext): Readonly<PriceRates> | null {
  if (priceMode() === 'legacy') return ANTHROPIC_GATE_RATES;
  return koshaRates(model, ctx)?.rates ?? null;
}

/** Cache-read ratio for the Anthropic savings math (baseline.ts). Legacy and
 *  unpriced models keep the historical 0.1x. Writes stay at Anthropic's
 *  published 1.25x (5m) / 2x (1h), which hold for every Claude model. */
export function anthropicReadRate(model: string | undefined, ctx?: PriceContext): number {
  if (priceMode() === 'legacy') return CACHE_READ_RATE;
  return gateRatesFor(model, ctx)?.read ?? CACHE_READ_RATE;
}

/** USD per 1M uncached input tokens for converting saved token-equivalents to
 *  dollars, at the band and date in `ctx`, or undefined when legacy mode or
 *  the model is unpriced. */
export function inputUsdPerMtok(model: string | undefined, ctx?: PriceContext): number | undefined {
  if (priceMode() === 'legacy' || !koshaRates(model, ctx)) return undefined;
  const row = effectiveRow(priceRowFor(model), ctx);
  return row && row.in > 0 ? row.in : undefined;
}
