/**
 * One entry point for any wire format (Anthropic Messages, OpenAI Responses,
 * Chat Completions, Gemini generateContent). It detects the wire, images bulky
 * context only for readers that can read it, keeps prompt_cache_breakpoint off
 * Codex routes, and reports estimated billable tokens before and after.
 *
 * The proxy has its own per-route wiring; the MCP server and scripts use this.
 */
import { gptTokenCount as o200kCountTokens } from './gpt-tokens.js';
import { scrubPromptCacheBreakpoint, supportsExplicitPromptCacheBreakpoint, type PromptCacheRoute } from './codex-cache.js';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from './openai.js';
import { transformGoogleGenerateContent } from './google.js';
import { readerTier, type ReaderTier } from './reader-tier.js';
import { transformRequest, type TransformInfo, type TransformOptions } from './transform.js';
import { resolveGptProfile } from './gpt-model-profiles.js';
import { visionTokens } from './vision-cost.js';

export type RequestWire = 'anthropic' | 'responses' | 'chat' | 'google' | 'auto';

export interface RequestReport {
  readerTier: ReaderTier;
  imaged: boolean;
  textCompressed?: boolean;
  textStages?: string[];
  /** Estimated (o200k) text tokens of the incoming body. */
  originalTokens: number;
  imageTokens: number;
  /** Text tokens of the outgoing body with image payloads stripped, plus image tokens. */
  billableTokens: number;
  savedVsOriginal: number;
  savedPercent: number;
  promptCacheBreakpoint: boolean;
  reason?: string;
}

export interface RequestTransformOptions extends TransformOptions {
  wire?: RequestWire;
  /** ChatGPT Codex / chatgpt.com must pass false. */
  explicitPromptCacheBreakpoints?: boolean;
  /** When set, used only to decide the breakpoint ban. */
  route?: PromptCacheRoute;
  /** Per-call override. Does not read or write INKLING_FORCE_IMAGES. */
  forceImages?: boolean;
}

const dec = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Estimate only: o200k on the body with base64 image payloads stripped. */
export function countBillable(body: Uint8Array | string, imageTokens = 0): number {
  const text = typeof body === 'string' ? body : dec.decode(body);
  const stripped = text
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, '"IMG"')
    .replace(/"data"\s*:\s*"[A-Za-z0-9+/=]{80,}"/g, '"data":"IMG"');
  return o200kCountTokens(stripped) + imageTokens;
}

function detectWire(body: Uint8Array, hinted: RequestWire | undefined): Exclude<RequestWire, 'auto'> {
  if (hinted && hinted !== 'auto') return hinted;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(body));
  } catch {
    return 'anthropic';
  }
  if (!isRecord(parsed)) return 'anthropic';
  if (typeof parsed.instructions === 'string' || Array.isArray(parsed.input)) return 'responses';
  if (parsed.systemInstruction || parsed.contents) return 'google';
  if (Array.isArray(parsed.messages)) {
    if (parsed.system !== undefined) return 'anthropic';
    const blob = JSON.stringify(parsed.messages);
    if (blob.includes('"tool_result"') || blob.includes('"tool_use"')) return 'anthropic';
    return 'chat';
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

function allowBreakpoints(options: RequestTransformOptions): boolean {
  if (options.explicitPromptCacheBreakpoints === false) return false;
  if (options.route && !supportsExplicitPromptCacheBreakpoint(options.route)) return false;
  return true;
}

/**
 * Transforms an LLM request across any supported wire format:
 *  - `image` reader tier: renders bulky stale context optically + text hygiene.
 *  - `text` reader tier: runs 4-layer deterministic text compilation (TSCG+TOON+CASI+ACDC)
 *    with zero image rendering (`imageCompress: false`).
 * Leaves clean payloads byte-identical (except explicit Codex breakpoint scrubbing).
 */
export async function transformAnyRequest(
  body: Uint8Array,
  options: RequestTransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo; report: RequestReport }> {
  const model = options.model;
  const tier = readerTier(model, options.forceImages);
  const allow = allowBreakpoints(options);
  const wire = detectWire(body, options.wire);
  const imageTier = tier === 'image' && options.compress !== false;
  let outBody = body;
  let info: TransformInfo = {
    compressed: false,
    reason: options.compress === false ? 'compress=false' : imageTier ? 'noop' : 'weak_reader',
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
  if (options.compress !== false) {
    const wireOpts: TransformOptions = {
      ...options,
      model,
      imageCompress: imageTier,
      explicitPromptCacheBreakpoints: allow,
    };
    const result = wire === 'responses'
      ? await transformOpenAIResponses(body, wireOpts)
      : wire === 'chat'
        ? await transformOpenAIChatCompletions(body, wireOpts)
        : wire === 'google'
          ? await transformGoogleGenerateContent(body, model ?? 'gemini', wireOpts)
          : await transformRequest(body, wireOpts);
    outBody = result.body;
    info = result.info;
    if (!imageTier && !info.compressed && (info.reason === 'image_disabled' || info.reason === 'unsupported_model')) {
      info = { ...info, reason: 'weak_reader' };
    }
  }
  if (!allow) outBody = scrubPromptCacheBreakpoint(outBody);
  const imageTokens = chargedImageTokens(info, model);
  const originalTokens = countBillable(body);
  const billableTokens = countBillable(outBody, imageTokens);
  const savedVsOriginal = originalTokens - billableTokens;
  const textStages = info.textHygieneStages ? [...info.textHygieneStages] : undefined;
  const textCompressed = (info.textHygieneSavedTokens ?? 0) > 0 || Boolean(textStages && textStages.length > 0);
  const report: RequestReport = {
    readerTier: tier,
    imaged: imageTier && info.imageCount > 0,
    ...(textCompressed ? { textCompressed: true, textStages } : {}),
    originalTokens,
    imageTokens,
    billableTokens,
    savedVsOriginal,
    savedPercent: originalTokens > 0 ? Math.round((savedVsOriginal / originalTokens) * 1000) / 10 : 0,
    promptCacheBreakpoint: dec.decode(outBody).includes('"prompt_cache_breakpoint"'),
    reason: info.reason,
  };
  return { body: outBody, info, report };
}
