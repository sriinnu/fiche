/**
 * Hybrid pipeline: lossless PAKT on structured leaves, then inkling images
 * only for readers that can actually read the pages.
 */
import { countTokens } from '@sriinnu/pakt';
import { scrubPromptCacheBreakpoint, supportsExplicitPromptCacheBreakpoint, type PromptCacheRoute } from './codex-cache.js';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from './openai.js';
import { transformGoogleGenerateContent } from './google.js';
import { PAKT_LEGEND, jsonLosslessUnderParse, packStructured, type PackResult } from './pakt-stage.js';
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
  /** Per-call override. Does not read or write INKLING_FORCE_IMAGES. */
  forceImages?: boolean;
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
  /** Set once a packed leaf carries the legend. */
  legendPlaced: boolean;
}

interface WalkContext {
  stats: WalkStats;
  model: string | undefined;
  lossy: boolean;
  semanticBudget: number | undefined;
  legendTokens: number;
}

const LEGEND_PREFIX = `${PAKT_LEGEND}\n\n`;
/** A packed leaf after the first must still save at least this much. */
const MIN_LEAF_SAVING = 16;
const TOOL_NAME = 'tool_result';

/**
 * Pack one tool-result string, or return it unchanged.
 *
 * The decision depends only on this leaf and the leaves before it, never on
 * anything later in the request. Conversations only append, so a leaf packed
 * (or left alone) on turn N gets the same answer on turn N+1 and the cached
 * prefix stays byte-stable. The legend rides in front of the first packed leaf
 * instead of the system prompt, for the same reason, and that first leaf has
 * to pay for it on its own.
 */
function packLeaf(text: string, ctx: WalkContext): string {
  const packed = packStructured(text, {
    model: ctx.model,
    toolName: TOOL_NAME,
    lossy: ctx.lossy,
    semanticBudget: ctx.semanticBudget,
  });
  if (!packed) return text;
  const stats = ctx.stats;
  const cost = stats.legendPlaced ? 0 : ctx.legendTokens;
  if (packed.savedTokens - cost < MIN_LEAF_SAVING) return text;
  const out = stats.legendPlaced ? packed.text : `${LEGEND_PREFIX}${packed.text}`;
  stats.legendPlaced = true;
  stats.blocks += 1;
  stats.savedTokens += packed.savedTokens - cost;
  stats.originalTokens += packed.originalTokens;
  stats.packedTokens += packed.packedTokens + cost;
  stats.vias.push(packed.via);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Tool-result content that is a string or an array of text parts. */
function packContent(content: unknown, ctx: WalkContext, textTypes: readonly string[]): unknown {
  if (typeof content === 'string') return packLeaf(content, ctx);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!isRecord(part) || typeof part.text !== 'string') return part;
    if (typeof part.type === 'string' && !textTypes.includes(part.type)) return part;
    const text = packLeaf(part.text, ctx);
    return text === part.text ? part : { ...part, text };
  });
}

/** Every string value inside a Gemini functionResponse.response object. */
function packResponseValues(value: unknown, ctx: WalkContext): unknown {
  if (typeof value === 'string') return packLeaf(value, ctx);
  if (Array.isArray(value)) return value.map((item) => packResponseValues(item, ctx));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) out[key] = packResponseValues(child, ctx);
  return out;
}

/**
 * Rewrite only tool-result text. Everything else (tool-call arguments,
 * `tool_use.input`, thinking blocks and their signatures, tool definitions,
 * metadata, system prompts, user and assistant text) is never touched.
 */
function rewriteToolResults(root: Record<string, unknown>, wire: Exclude<HybridWire, 'auto'>, ctx: WalkContext): void {
  if (wire === 'anthropic' && Array.isArray(root.messages)) {
    root.messages = root.messages.map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((block) => {
          if (!isRecord(block) || block.type !== 'tool_result') return block;
          return { ...block, content: packContent(block.content, ctx, ['text']) };
        }),
      };
    });
    return;
  }
  if (wire === 'responses' && Array.isArray(root.input)) {
    root.input = root.input.map((item) => {
      if (!isRecord(item)) return item;
      if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') return item;
      return { ...item, output: packContent(item.output, ctx, ['input_text', 'output_text', 'text']) };
    });
    return;
  }
  if (wire === 'chat' && Array.isArray(root.messages)) {
    root.messages = root.messages.map((message) => {
      if (!isRecord(message) || message.role !== 'tool') return message;
      return { ...message, content: packContent(message.content, ctx, ['text']) };
    });
    return;
  }
  if (wire === 'google' && Array.isArray(root.contents)) {
    root.contents = root.contents.map((content) => {
      if (!isRecord(content) || !Array.isArray(content.parts)) return content;
      return {
        ...content,
        parts: content.parts.map((part) => {
          if (!isRecord(part) || !isRecord(part.functionResponse)) return part;
          const fr = part.functionResponse;
          return { ...part, functionResponse: { ...fr, response: packResponseValues(fr.response, ctx) } };
        }),
      };
    });
  }
}

/** Rewrite tool-result strings inside a JSON request. Non-JSON bodies pass through. */
export function prepassRequest(
  body: Uint8Array,
  model?: string,
  options: { lossy?: boolean; semanticBudget?: number; forceImages?: boolean; wire?: HybridWire } = {},
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
  if (!isRecord(parsed)) return base;
  // Re-serializing goes through JSON.parse, so a body that parse cannot keep
  // exactly (big integers, duplicate keys) is forwarded untouched.
  if (!jsonLosslessUnderParse(text.trim())) return base;
  const wire = detectWireParsed(parsed, options.wire);
  const stats: WalkStats = {
    blocks: 0, savedTokens: 0, originalTokens: 0, packedTokens: 0, vias: [], legendPlaced: false,
  };
  const ctx: WalkContext = {
    stats,
    model,
    lossy: options.lossy === true,
    semanticBudget: options.semanticBudget,
    legendTokens: countTokens(LEGEND_PREFIX, tokenModel(model)),
  };
  rewriteToolResults(parsed, wire, ctx);
  if (stats.blocks === 0) return base;
  return {
    body: enc.encode(JSON.stringify(parsed)),
    changed: true,
    tier,
    blocks: stats.blocks,
    savedTokens: stats.savedTokens,
    originalTokens: stats.originalTokens,
    packedTokens: stats.packedTokens,
    vias: stats.vias,
  };
}

function detectWireParsed(parsed: Record<string, unknown>, hinted: HybridWire | undefined): Exclude<HybridWire, 'auto'> {
  if (hinted && hinted !== 'auto') return hinted;
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

function detectWire(body: Uint8Array, hinted: HybridWire | undefined): Exclude<HybridWire, 'auto'> {
  if (hinted && hinted !== 'auto') return hinted;
  try {
    const parsed = JSON.parse(dec.decode(body)) as unknown;
    if (isRecord(parsed)) return detectWireParsed(parsed, undefined);
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

/**
 * PAKT first. Images only when the reader tier is `image` and compression
 * is not explicitly off. Codex routes leave without prompt_cache_breakpoint.
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
    wire: options.wire,
  });
  const allow = allowBreakpoints(options);
  const wire = detectWire(pre.body, options.wire);
  const imageTier = pre.tier === 'image' && options.compress !== false;
  let outBody = pre.body;
  let info: TransformInfo = {
    compressed: pre.changed,
    reason: pre.changed ? 'pakt_text' : 'pakt_noop',
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
  if (imageTier) {
    const imageOptions: TransformOptions = {
      ...options,
      model,
      explicitPromptCacheBreakpoints: allow,
    };
    if (wire === 'responses') {
      const result = await transformOpenAIResponses(pre.body, imageOptions);
      outBody = result.body;
      info = result.info;
    } else if (wire === 'chat') {
      const result = await transformOpenAIChatCompletions(pre.body, imageOptions);
      outBody = result.body;
      info = result.info;
    } else if (wire === 'google') {
      const result = await transformGoogleGenerateContent(pre.body, model ?? 'gemini', imageOptions);
      outBody = result.body;
      info = result.info;
    } else {
      const result = await transformRequest(pre.body, imageOptions);
      outBody = result.body;
      info = result.info;
    }
  }
  if (!allow) outBody = scrubPromptCacheBreakpoint(outBody);
  const imageTokens = chargedImageTokens(info, model);
  const originalTokens = countBillable(body, 0, model);
  const afterPaktTokens = countBillable(pre.body, 0, model);
  const billableTokens = countBillable(outBody, imageTokens, model);
  const savedVsOriginal = originalTokens - billableTokens;
  const breakpoint = dec.decode(outBody).includes('"prompt_cache_breakpoint"');
  info.hybrid = {
    readerTier: pre.tier,
    paktBlocks: pre.blocks,
    paktSavedTokens: pre.savedTokens,
    imaged: imageTier && info.imageCount > 0,
  };
  if (!imageTier && pre.changed) {
    info.compressed = true;
    info.reason = 'pakt_text';
  }
  const report: HybridReport = {
    readerTier: pre.tier,
    imaged: info.hybrid.imaged,
    paktBlocks: pre.blocks,
    paktSavedTokens: pre.savedTokens,
    originalTokens,
    afterPaktTokens,
    imageTokens,
    billableTokens,
    savedVsOriginal,
    savedPercent: originalTokens > 0 ? Math.round((savedVsOriginal / originalTokens) * 1000) / 10 : 0,
    promptCacheBreakpoint: breakpoint,
    reason: info.reason,
  };
  return { body: outBody, info, report };
}
