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
 * Not yet modelled in kosha mode: TTL write tiers (Anthropic 1h at 2x, OpenAI
 * 12h at 2.5x) and long-context tiers. The gate prices the short-TTL write.
 *
 * Workers-safe: no node:, no fs. Reads process.env only behind a typeof guard,
 * like gpt-model-profiles.ts.
 */

import { CACHE_CREATE_RATE, CACHE_READ_RATE } from './baseline.js';
import { envPricingOverride, resolveGptProfile } from './gpt-model-profiles.js';
import { normalizeModelId } from './price-id.js';
import { PRICES, PRICE_ALIASES, PRICE_SNAPSHOT, type PriceRow } from './prices.generated.js';

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

/** Ratios from a snapshot row, or undefined when the row can't be trusted for
 *  ratios: no positive input or output, no cache read, a read at or above
 *  input, or a write outside [input, 3x input]. A write of 0 or none means no
 *  write premium (DeepSeek, z.ai, xAI bill the write as ordinary input). */
export function ratesFromRow(row: PriceRow | undefined): PriceRates | undefined {
  if (!row || !(row.in > 0) || !(typeof row.out === 'number' && row.out > 0)) return undefined;
  if (typeof row.cr !== 'number') return undefined;
  const read = row.cr / row.in;
  if (!(read > 0 && read < 1)) return undefined;
  const write = typeof row.cw === 'number' && row.cw > 0 ? row.cw / row.in : 1;
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
function koshaRates(model: string | undefined): { rates: PriceRates; source: PriceSource } | undefined {
  const env = envPricingOverride(model);
  const fromRow = ratesFromRow(priceRowFor(model));
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
export function resolvePriceRates(model: string | undefined): PriceRates {
  if (priceMode() === 'kosha') {
    const k = koshaRates(model);
    if (k) return k.rates;
  }
  return profileRates(model);
}

/** Ratios the image/text gate in transform.ts prices with, or null when the
 *  model is unpriced in kosha mode (the gate then passes the text through).
 *  Legacy mode keeps the historical Anthropic ratios for every model. */
export function gateRatesFor(model: string | undefined): Readonly<PriceRates> | null {
  if (priceMode() === 'legacy') return ANTHROPIC_GATE_RATES;
  return koshaRates(model)?.rates ?? null;
}
