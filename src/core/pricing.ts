/**
 * One place every price ratio comes from.
 *
 * inkling compares token counts weighted by price ratios (cached input,
 * cache write and output, each divided by the uncached input price). The
 * compression gate and the savings math must use the same ratios for the same
 * model, so both ask here.
 *
 * Today the values are the ones inkling has always used: the profile fields
 * for GPT/Gemini/compat models, and Anthropic's documented 5-minute-tier
 * ratios for the Anthropic gate. They are NOT yet the official per-model
 * prices (Opus 5.5 reads at 0.05x, not 0.1x). The next step replaces the
 * source with a build-time kosha snapshot (official prices, cited) behind a
 * flag, so only this file's data changes. See docs/CACHING_AND_SAVINGS.md.
 *
 * Workers-safe: no node:, no fs, no process.*.
 */

import { CACHE_CREATE_RATE, CACHE_READ_RATE } from './baseline.js';
import { resolveGptProfile } from './gpt-model-profiles.js';

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

/** The ratios the Anthropic gate has always priced with: 5-minute write tier,
 *  0.1x read, for every Claude model. */
export const ANTHROPIC_GATE_RATES: Readonly<PriceRates> = Object.freeze({
  read: CACHE_READ_RATE,
  write: CACHE_CREATE_RATE,
  output: 5,
});

/** Ratios for a model as the savings math prices it (profile-backed; env
 *  overrides in INKLING_GPT_PROFILES still apply through the profile). */
export function resolvePriceRates(model: string | undefined): PriceRates {
  const profile = resolveGptProfile(model);
  return {
    read: profile.cacheReadRate,
    write: profile.cacheWriteRate ?? 1,
    output: profile.outputRate,
  };
}

/** Ratios the image/text gate in transform.ts prices with for this model.
 *  Pinned to {@link ANTHROPIC_GATE_RATES} for now, whatever the model, which
 *  is exactly the gate's historical behaviour. */
export function gateRatesFor(_model: string | undefined): Readonly<PriceRates> {
  return ANTHROPIC_GATE_RATES;
}
