import { resolvePriceRates, type PriceContext } from './pricing.js';

/** Cached-input ÷ uncached-input list-price ratio for the model serving this
 *  request. The ratio is a PROFILE field (`cacheReadRate`), so a new family is
 *  a profile entry or a INKLING_GPT_PROFILES override — not a regex added here,
 *  which is how the gate and the savings math previously drifted apart. */
export function openAICacheReadRate(model: string | undefined, ctx?: PriceContext): number {
  return resolvePriceRates(model, ctx).read;
}

/** Output ÷ uncached-input list-price ratio, from the same profile. */
export function openAIOutputRate(model: string | undefined, ctx?: PriceContext): number {
  return resolvePriceRates(model, ctx).output;
}

/** Weighted input tokens actually paid to OpenAI this turn. `cachedTokens` is a
 *  subset of `inputTokens`, not an additive bucket. */
export function computeOpenAIActualInputEff(
  inputTokens: number,
  cachedTokens: number,
  model?: string,
  cacheWriteTokens: number = 0,
  ctx?: PriceContext,
): number {
  if (inputTokens <= 0) return 0;
  const cached = Math.max(0, Math.min(cachedTokens || 0, inputTokens));
  const written = Math.max(0, Math.min(cacheWriteTokens || 0, inputTokens - cached));
  const uncached = inputTokens - cached - written;
  const rates = resolvePriceRates(model, ctx ?? { promptTokens: inputTokens });
  return uncached + cached * rates.read + written * rates.write;
}

export function computeOpenAICollapsePaybackReads(
  nativeTokens: number,
  collapsedTokens: number,
  model?: string,
  ctx?: PriceContext,
): number {
  const rates = resolvePriceRates(model, ctx);
  const savedPerRead = (nativeTokens - collapsedTokens) * rates.read;
  if (!(savedPerRead > 0)) return Infinity;
  const transitionCost = collapsedTokens * rates.write
    - nativeTokens * rates.read;
  return Math.ceil(Math.max(0, transitionCost) / savedPerRead);
}

/** Raw token count for the unproxied GPT counterfactual: replace the rendered
 *  images with the o200k text they stood in for (plus any text hygiene delta). */
export function computeOpenAIBaselineRawTokens(
  inputTokens: number,
  imageTokens: number,
  baselineImagedTokens: number,
  nativeInjectedTokens: number = 0,
  textHygieneSavedTokens: number = 0,
): number {
  if (inputTokens <= 0) return 0;
  const delta = (baselineImagedTokens || 0) - (imageTokens || 0);
  return Math.max(
    0,
    inputTokens + delta - Math.max(0, nativeInjectedTokens || 0) + Math.max(0, textHygieneSavedTokens || 0),
  );
}

export function computeOpenAIBaselineInputEff(
  inputTokens: number,
  cachedTokens: number,
  imageTokens: number,
  baselineImagedTokens: number,
  model?: string,
  nativeInjectedTokens: number = 0,
  cacheWriteTokens: number = 0,
  ctx?: PriceContext,
): number {
  const priceCtx = ctx ?? { promptTokens: inputTokens };
  const actual = computeOpenAIActualInputEff(inputTokens, cachedTokens, model, cacheWriteTokens, priceCtx);
  if (inputTokens <= 0 || imageTokens <= 0 || baselineImagedTokens <= 0) return actual;
  const delta = baselineImagedTokens - imageTokens;
  const rates = resolvePriceRates(model, priceCtx);
  const deltaWeight = (cachedTokens || 0) > 0 ? rates.read
    : cacheWriteTokens > 0 ? rates.write : 1;
  // Synthetic native text occupies the same stable prefix as the images, so
  // apply the same observed cache weight as the replacement delta.
  return actual + (delta - Math.max(0, nativeInjectedTokens || 0)) * deltaWeight;
}

export interface OpenAIWarmthPrev {
  ts: number;
  cachedOrPrefixTokens: number;
  prefixSha?: string;
  pxPrefixSha?: string;
  model?: string;
}

export const OPENAI_CACHE_TTL_SEC = 300;

/**
 * Determine whether the unproxied OpenAI/Codex/compat baseline prefix would have
 * read warm on this turn, and detect when a transform busted an active prefix
 * cache (warm prior within TTL + same prefix/model + changed outbound pxPrefixSha followed by cached_tokens === 0).
 */
export function deriveOpenAIBaselineWarmth(
  prev: OpenAIWarmthPrev | undefined,
  requestStartSec: number,
  cachedTokens: number,
  prefixSha?: string,
  model?: string,
  ttlSec: number = OPENAI_CACHE_TTL_SEC,
  pxPrefixSha?: string,
): { warm: boolean; selfBusted: boolean; prevPrefixTokens: number } {
  if (cachedTokens > 0) {
    return { warm: true, selfBusted: false, prevPrefixTokens: prev?.cachedOrPrefixTokens ?? 0 };
  }
  const ageSec = prev ? requestStartSec - prev.ts : Infinity;
  const samePrefix = !prefixSha || !prev?.prefixSha || prefixSha === prev.prefixSha;
  const sameModel = !model || !prev?.model || model === prev.model;
  // When outbound prefix digests are supplied on both turns, require an actual
  // byte-level change before attributing a cache miss to proxy self-busting.
  const pxPrefixChanged =
    prev?.pxPrefixSha !== undefined && pxPrefixSha !== undefined
      ? prev.pxPrefixSha !== pxPrefixSha
      : true;
  if (
    prev &&
    ageSec >= 0 &&
    ageSec <= ttlSec &&
    prev.cachedOrPrefixTokens > 0 &&
    samePrefix &&
    sameModel &&
    pxPrefixChanged
  ) {
    return { warm: true, selfBusted: true, prevPrefixTokens: prev.cachedOrPrefixTokens };
  }
  return { warm: false, selfBusted: false, prevPrefixTokens: 0 };
}

/**
 * Session- and hygiene-aware OpenAI/Codex/compat baseline input-equivalent cost.
 * Credits both image replacement and deterministic text-hygiene token deltas,
 * and surfaces negative savings when a turn busts a live prefix cache.
 */
export function computeOpenAISessionBaselineInputEff(args: {
  inputTokens: number;
  cachedTokens: number;
  imageTokens: number;
  baselineImagedTokens: number;
  nativeInjectedTokens?: number;
  textHygieneSavedTokens?: number;
  prevHygieneSavedTokens?: number;
  cacheWriteTokens?: number;
  ttlSec?: number;
  model?: string;
  warmth?: { warm: boolean; selfBusted: boolean; prevPrefixTokens: number };
}): number {
  const {
    inputTokens,
    cachedTokens,
    imageTokens,
    baselineImagedTokens,
    nativeInjectedTokens = 0,
    textHygieneSavedTokens = 0,
    prevHygieneSavedTokens,
    cacheWriteTokens = 0,
    ttlSec,
    model,
    warmth,
  } = args;
  const priceCtx: PriceContext = { promptTokens: inputTokens, ...(ttlSec !== undefined ? { ttlSec } : {}) };
  const actual = computeOpenAIActualInputEff(inputTokens, cachedTokens, model, cacheWriteTokens, priceCtx);
  const imagedDelta =
    imageTokens > 0 && baselineImagedTokens > 0
      ? baselineImagedTokens - imageTokens - Math.max(0, nativeInjectedTokens || 0)
      : 0;
  const hygieneDelta = Math.max(0, textHygieneSavedTokens || 0);
  if (inputTokens <= 0 || (imagedDelta === 0 && hygieneDelta === 0 && !warmth?.selfBusted)) {
    return Math.max(0, actual);
  }
  const rates = resolvePriceRates(model, priceCtx);
  const readRate = rates.read;
  const writeRate = rates.write;
  const newTurnRate = cacheWriteTokens > 0 ? writeRate : 1;
  if (warmth?.selfBusted) {
    const unproxiedRaw = Math.max(0, inputTokens + imagedDelta + hygieneDelta);
    const reused = Math.min(unproxiedRaw, warmth.prevPrefixTokens);
    return Math.max(0, reused * readRate + (unproxiedRaw - reused) * newTurnRate);
  }
  if (prevHygieneSavedTokens !== undefined && cachedTokens > 0) {
    const cachedHygiene = Math.min(hygieneDelta, Math.max(0, prevHygieneSavedTokens));
    const uncachedHygiene = hygieneDelta - cachedHygiene;
    return Math.max(0, actual + (imagedDelta + cachedHygiene) * readRate + uncachedHygiene * newTurnRate);
  }
  const deltaWeight = cachedTokens > 0 ? readRate : newTurnRate;
  return Math.max(0, actual + (imagedDelta + hygieneDelta) * deltaWeight);
}
