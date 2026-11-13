/**
 * Hybrid pipeline: lossless PAKT on structured leaves, then pxpipe images
 * only for readers that can actually read the pages.
 */
import { countTokens } from '@sriinnu/pakt';
import { isPxpipeSupportedModel } from './applicability.js';
import { scanJsonStrings, spliceJsonStrings } from './cache-splice.js';
import { scrubPromptCacheBreakpoint, supportsExplicitPromptCacheBreakpoint, type PromptCacheRoute } from './codex-cache.js';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from './openai.js';
import { transformGoogleGenerateContent } from './google.js';
import { PAKT_LEGEND, packStructured, type PackResult } from './pakt-stage.js';
import { readerTier, type ReaderTier } from './reader-tier.js';
import { transformRequest, type TransformInfo, type TransformOptions } from './transform.js';
import { resolveGptProfile } from './gpt-model-profiles.js';
import { visionTokens } from './vision-cost.js';

export type HybridWire = 'anthropic' | 'responses' | 'chat' | 'google' | 'auto';

export interface HybridPrepass {
  body: Uint8Array;
  changed: boolean;
  tier: ReaderTier;
  blocks: number;
  savedTokens: number;
  originalTokens: number;
  packedTokens: number;
  vias: PackResult['via'][];
}

export interface HybridReport {
  readerTier: ReaderTier;
  imaged: boolean;
  paktBlocks: number;
  paktSavedTokens: number;
  originalTokens: number;
  /** Tokens of the PAKT-rewritten JSON before any images. */
  afterPaktTokens: number;
  imageTokens: number;
  /** Text tokens of the outgoing body with image payloads stripped, plus image tokens. */
  billableTokens: number;
  savedVsOriginal: number;
  savedPercent: number;
  promptCacheBreakpoint: boolean;
  reason?: string;
}

export interface HybridTransformOptions extends TransformOptions {
  wire?: HybridWire;
  /** ChatGPT Codex / chatgpt.com must pass false. */
  explicitPromptCacheBreakpoints?: boolean;
  /** When set, used only to decide the breakpoint ban. */
  route?: PromptCacheRoute;
  /** L4. Proxy and MCP default this off. */
  lossy?: boolean;
  semanticBudget?: number;
  /** Per-call override. Does not read or write PXPIPE_FORCE_IMAGES.
   *  True considers images even when the model is not allowlisted. */
  forceImages?: boolean;
  /** When set, overrides the allowlist. The proxy passes its model gate here. */
  allowImages?: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function tokenModel(model: string | undefined): string {
  return model && model.trim() ? model : 'gpt-4o';
}

export function countBillable(body: Uint8Array | string, imageTokens = 0, model?: string): number {
  const text = typeof body === 'string' ? body : dec.decode(body);
  // Provider bills vision tokens for images, not the base64. Drop both URL and
  // Anthropic source.data payloads before counting the remaining text.
  const stripped = text
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, '"IMG"')
    .replace(/"data"\s*:\s*"[A-Za-z0-9+/=]{80,}"/g, '"data":"IMG"');
  return countTokens(stripped, tokenModel(model)) + imageTokens;
}

interface WalkStats {
  blocks: number;
  savedTokens: number;
  originalTokens: number;
  packedTokens: number;
  vias: PackResult['via'][];
}

/**
 * Pack structured string values without touching the cached prefix.
 * The legend rides inside the first packed string, after the cache boundary,
 * so `system` and `instructions` stay byte-identical. Claude Code classifies
 * the subscription on the first system block; a legend in front of it is a 429.
 */
export function prepassRequest(
  body: Uint8Array,
  model?: string,
  options: { lossy?: boolean; semanticBudget?: number; forceImages?: boolean } = {},
): HybridPrepass {
  const tier = readerTier(model, options.forceImages);
  const base: HybridPrepass = {
    body,
    changed: false,
    tier,
    blocks: 0,
    savedTokens: 0,
    originalTokens: 0,
    packedTokens: 0,
    vias: [],
  };
  const text = dec.decode(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== 'object') return base;
  const scan = scanJsonStrings(text);
  if (!scan) return base;
  const stats: WalkStats = { blocks: 0, savedTokens: 0, originalTokens: 0, packedTokens: 0, vias: [] };
  const replacements: Array<{ start: number; end: number; next: string }> = [];
  let legendUsed = false;
  for (const span of scan.strings) {
    if (span.start < scan.boundary) continue;
    const packed = packStructured(span.decoded, {
      model,
      lossy: options.lossy === true,
      semanticBudget: options.semanticBudget,
    });
    if (!packed) continue;
    let payload = packed.text;
    if (!legendUsed && !payload.includes('Pipe-Aligned Kompact Text')) {
      payload = `${PAKT_LEGEND}\n\n${payload}`;
      legendUsed = true;
    }
    replacements.push({ start: span.start, end: span.end, next: JSON.stringify(payload) });
    stats.blocks += 1;
    stats.savedTokens += packed.savedTokens;
    stats.originalTokens += packed.originalTokens;
    stats.packedTokens += packed.packedTokens;
    stats.vias.push(packed.via);
  }
  if (stats.blocks === 0) return base;
  const spliced = spliceJsonStrings(text, replacements);
  if (scan.boundary > 0 && spliced.slice(0, scan.boundary) !== text.slice(0, scan.boundary)) return base;
  try {
    JSON.parse(spliced);
  } catch {
    return base;
  }
  const next = enc.encode(spliced);
  const after = countBillable(next, 0, model);
  const before = countBillable(body, 0, model);
  // The legend sits in the tail. It must not make the request larger than it started.
  if (after >= before) return base;
  return {
    body: next,
    changed: true,
    tier,
    blocks: stats.blocks,
    savedTokens: before - after,
    originalTokens: before,
    packedTokens: after,
    vias: stats.vias,
  };
}

function detectWire(body: Uint8Array, hinted: HybridWire | undefined): Exclude<HybridWire, 'auto'> {
  if (hinted && hinted !== 'auto') return hinted;
  try {
    const parsed = JSON.parse(dec.decode(body)) as Record<string, unknown>;
    if (typeof parsed.instructions === 'string' || Array.isArray(parsed.input)) return 'responses';
    if (parsed.systemInstruction || parsed.contents) return 'google';
    if (Array.isArray(parsed.messages)) {
      const blob = JSON.stringify(parsed.messages);
      if (blob.includes('"tool_result"') || blob.includes('"tool_use"') || parsed.system) return 'anthropic';
      return 'chat';
    }
  } catch {
    // fall through
  }
  return 'anthropic';
}

function chargedImageTokens(info: TransformInfo, model: string | undefined): number {
  if ((info.imageTokens ?? 0) > 0) return info.imageTokens ?? 0;
  const dims = info.imageDims ?? [];
  if (dims.length === 0) return 0;
  const pricing = resolveGptProfile(model);
  return dims.reduce((sum, dim) => sum + visionTokens(pricing, dim.width, dim.height), 0);
}

function allowBreakpoints(options: HybridTransformOptions): boolean {
  if (options.explicitPromptCacheBreakpoints === false) return false;
  if (options.route && !supportsExplicitPromptCacheBreakpoint(options.route)) return false;
  return true;
}

function blankInfo(reason: string, compressed: boolean): TransformInfo {
  return {
    compressed,
    reason,
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
}

/** Allowlisted models, or an explicit per-call force. `compress: false` wins. */
export function imageCandidateEnabled(model: string | undefined, options: HybridTransformOptions = {}): boolean {
  if (options.compress === false) return false;
  if (options.forceImages === true) return true;
  if (options.allowImages === false) return false;
  if (options.allowImages === true) return true;
  return isPxpipeSupportedModel(model);
}

export interface PricedBody {
  body: Uint8Array;
  info: TransformInfo;
  choice: 'raw' | 'pakt' | 'image';
}

/**
 * Strict minimum of raw, cache-safe PAKT, and (when compressed) images of the
 * original. A tie keeps the earlier candidate: raw, then PAKT text, then images.
 */
export function pickCheapest(
  raw: Uint8Array,
  pakt: HybridPrepass,
  image: { body: Uint8Array; info: TransformInfo } | undefined,
  model?: string,
): PricedBody {
  const rawCost = countBillable(raw, 0, model);
  const paktCost = pakt.changed ? countBillable(pakt.body, 0, model) : Number.POSITIVE_INFINITY;
  // `compressed` is the profile gate (including charsPerToken). countBillable
  // is cl100k plus pixel math and can disagree by a few tokens; it is not
  // allowed to overturn a gate that already chose images. It does decide
  // whether PAKT text beats that image.
  const imageAccepted = image?.info.compressed === true;
  const imageCost = imageAccepted
    ? countBillable(image!.body, chargedImageTokens(image!.info, model), model)
    : Number.POSITIVE_INFINITY;
  const paktBeatsRaw = paktCost < rawCost;
  const paktBeatsImage = !imageAccepted || paktCost < imageCost;
  let best: PricedBody;
  if (paktBeatsRaw && paktBeatsImage) {
    best = {
      body: pakt.body,
      choice: 'pakt',
      info: {
        ...blankInfo('pakt_text', true),
        hybrid: {
          readerTier: pakt.tier,
          paktBlocks: pakt.blocks,
          paktSavedTokens: pakt.savedTokens,
          imaged: false,
        },
      },
    };
  } else if (imageAccepted && image) {
    best = { body: image.body, choice: 'image', info: image.info };
  } else {
    const reason = image?.info.reason ?? 'pakt_noop';
    best = {
      body: raw,
      choice: 'raw',
      info: image
        ? { ...image.info, compressed: false, reason }
        : blankInfo(reason, false),
    };
  }
  best.info.hybrid = {
    readerTier: pakt.tier,
    paktBlocks: best.choice === 'pakt' ? pakt.blocks : 0,
    paktSavedTokens: best.choice === 'pakt' ? pakt.savedTokens : 0,
    imaged: best.choice === 'image' && (best.info.imageCount ?? 0) > 0,
  };
  return best;
}

/**
 * Cache-safe PAKT and, when the model is allowlisted or forceImages is set,
 * images of the original body. Sends whichever estimate is strictly cheapest.
 * Codex routes leave without prompt_cache_breakpoint.
 */
export async function hybridTransform(
  body: Uint8Array,
  options: HybridTransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo; report: HybridReport }> {
  const model = options.model;
  const pre = prepassRequest(body, model, {
    lossy: options.lossy,
    semanticBudget: options.semanticBudget,
    forceImages: options.forceImages,
  });
  const allow = allowBreakpoints(options);
  const wire = detectWire(body, options.wire);
  let image: { body: Uint8Array; info: TransformInfo } | undefined;
  if (imageCandidateEnabled(model, options)) {
    const imageOptions: TransformOptions = {
      ...options,
      model,
      explicitPromptCacheBreakpoints: allow,
    };
    if (wire === 'responses') image = await transformOpenAIResponses(body, imageOptions);
    else if (wire === 'chat') image = await transformOpenAIChatCompletions(body, imageOptions);
    else if (wire === 'google') image = await transformGoogleGenerateContent(body, model ?? 'gemini', imageOptions);
    else image = await transformRequest(body, imageOptions);
  }
  const picked = pickCheapest(body, pre, image, model);
  let outBody = picked.body;
  if (!allow) outBody = scrubPromptCacheBreakpoint(outBody);
  const imageTokens = picked.choice === 'image' ? chargedImageTokens(picked.info, model) : 0;
  const originalTokens = countBillable(body, 0, model);
  const afterPaktTokens = countBillable(pre.body, 0, model);
  const billableTokens = countBillable(outBody, imageTokens, model);
  const savedVsOriginal = originalTokens - billableTokens;
  const breakpoint = dec.decode(outBody).includes('"prompt_cache_breakpoint"');
  const report: HybridReport = {
    readerTier: pre.tier,
    imaged: picked.info.hybrid?.imaged === true,
    paktBlocks: picked.choice === 'pakt' ? pre.blocks : 0,
    paktSavedTokens: picked.choice === 'pakt' ? pre.savedTokens : 0,
    originalTokens,
    afterPaktTokens,
    imageTokens,
    billableTokens,
    savedVsOriginal,
    savedPercent: originalTokens > 0 ? Math.round((savedVsOriginal / originalTokens) * 1000) / 10 : 0,
    promptCacheBreakpoint: breakpoint,
    reason: picked.info.reason,
  };
  return { body: outBody, info: picked.info, report };
}
