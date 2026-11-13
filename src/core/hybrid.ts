/**
 * Hybrid pipeline: lossless PAKT on structured leaves, then pxpipe images
 * only for readers that can actually read the pages.
 */
import { countTokens } from '@sriinnu/pakt';
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
  /** Per-call override. Does not read or write PXPIPE_FORCE_IMAGES. */
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
}

function rewriteNode(value: unknown, stats: WalkStats, model: string | undefined, toolName: string | undefined, lossy: boolean, semanticBudget: number | undefined): unknown {
  if (typeof value === 'string') {
    const packed = packStructured(value, { model, toolName, lossy, semanticBudget });
    if (!packed) return value;
    stats.blocks += 1;
    stats.savedTokens += packed.savedTokens;
    stats.originalTokens += packed.originalTokens;
    stats.packedTokens += packed.packedTokens;
    stats.vias.push(packed.via);
    return packed.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteNode(item, stats, model, toolName, lossy, semanticBudget));
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const nextTool = record.type === 'tool_result'
    ? (typeof record.name === 'string' ? record.name : 'tool_result')
    : toolName;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    out[key] = rewriteNode(child, stats, model, nextTool, lossy, semanticBudget);
  }
  return out;
}

function insertLegend(root: Record<string, unknown>): void {
  // Append. Claude Code classifies subscription traffic by the first system
  // block; a legend in front of that identity is an opaque 429 (#149). A
  // `role: "system"` message is also illegal on the Anthropic Messages API,
  // so when there is no system/instructions field the legend is skipped.
  const marker = 'Pipe-Aligned Kompact Text';
  if (typeof root.instructions === 'string') {
    if (!root.instructions.includes(marker)) root.instructions = `${root.instructions}\n\n${PAKT_LEGEND}`;
    return;
  }
  if (typeof root.system === 'string') {
    if (!root.system.includes(marker)) root.system = `${root.system}\n\n${PAKT_LEGEND}`;
    return;
  }
  if (Array.isArray(root.system)) {
    const already = root.system.some((block) => JSON.stringify(block).includes(marker));
    if (!already) root.system.push({ type: 'text', text: PAKT_LEGEND });
  }
}

/** Rewrite structured strings inside a JSON request. Non-JSON bodies pass through. */
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(body));
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== 'object') return base;
  const stats: WalkStats = { blocks: 0, savedTokens: 0, originalTokens: 0, packedTokens: 0, vias: [] };
  const rewritten = rewriteNode(parsed, stats, model, undefined, options.lossy === true, options.semanticBudget) as Record<string, unknown>;
  if (stats.blocks === 0 || stats.savedTokens <= 0) return base;
  insertLegend(rewritten);
  const next = enc.encode(JSON.stringify(rewritten));
  const after = countBillable(next, 0, model);
  const before = countBillable(body, 0, model);
  // Whole-request guard: a legend must not make the request larger than it started.
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
