import { resolvePriceRates } from './pricing.js';

/** Cached-input ÷ uncached-input list-price ratio for the model serving this
 *  request. The ratio is a PROFILE field (`cacheReadRate`), so a new family is
 *  a profile entry or a INKLING_GPT_PROFILES override — not a regex added here,
 *  which is how the gate and the savings math previously drifted apart. */
export function openAICacheReadRate(model: string | undefined): number {
  return resolvePriceRates(model).read;
}

/** Output ÷ uncached-input list-price ratio, from the same profile. */
export function openAIOutputRate(model: string | undefined): number {
  return resolvePriceRates(model).output;
}

/** Weighted input tokens actually paid to OpenAI this turn. `cachedTokens` is a
 * subset of `inputTokens`, not an additive bucket. */
export function computeOpenAIActualInputEff(
  inputTokens: number,
  cachedTokens: number,
  model?: string,
  cacheWriteTokens: number = 0,
): number {
  if (inputTokens <= 0) return 0;
  const cached = Math.max(0, Math.min(cachedTokens || 0, inputTokens));
  const written = Math.max(0, Math.min(cacheWriteTokens || 0, inputTokens - cached));
  const uncached = inputTokens - cached - written;
  return uncached + cached * openAICacheReadRate(model)
    + written * resolvePriceRates(model).write;
}

export function computeOpenAICollapsePaybackReads(
  nativeTokens: number,
  collapsedTokens: number,
  model?: string,
): number {
  const rates = resolvePriceRates(model);
  const savedPerRead = (nativeTokens - collapsedTokens) * rates.read;
  if (!(savedPerRead > 0)) return Infinity;
  const transitionCost = collapsedTokens * rates.write
    - nativeTokens * rates.read;
  return Math.ceil(Math.max(0, transitionCost) / savedPerRead);
}

/** Raw token count for the unproxied GPT counterfactual: replace the rendered
 * images with the o200k text they stood in for. */
export function computeOpenAIBaselineRawTokens(
  inputTokens: number,
  imageTokens: number,
  baselineImagedTokens: number,
  nativeInjectedTokens: number = 0,
): number {
  if (inputTokens <= 0) return 0;
  const delta = (baselineImagedTokens || 0) - (imageTokens || 0);
  return Math.max(0, inputTokens + delta - Math.max(0, nativeInjectedTokens || 0));
}

export function computeOpenAIBaselineInputEff(
  inputTokens: number,
  cachedTokens: number,
  imageTokens: number,
  baselineImagedTokens: number,
  model?: string,
  nativeInjectedTokens: number = 0,
  cacheWriteTokens: number = 0,
): number {
  const actual = computeOpenAIActualInputEff(inputTokens, cachedTokens, model, cacheWriteTokens);
  if (inputTokens <= 0 || imageTokens <= 0 || baselineImagedTokens <= 0) return actual;
  const delta = baselineImagedTokens - imageTokens;
  const deltaWeight = (cachedTokens || 0) > 0 ? openAICacheReadRate(model)
    : cacheWriteTokens > 0 ? resolvePriceRates(model).write : 1;
  // Synthetic native text occupies the same stable prefix as the images, so
  // apply the same observed cache weight as the replacement delta.
  return actual + (delta - Math.max(0, nativeInjectedTokens || 0)) * deltaWeight;
}
