/**
 * OpenAI Chat Completions + Responses API transformer for the GPT-5 family.
 * Separate from the Anthropic path: no cache-control breakpoints,
 * images as image_url/input_image parts, system/developer messages in messages[]/input[].
 * OpenAI tools keep native names/descriptions/schema shape; verbose schema prose
 * is also rendered into images for token savings so calls do not depend only on OCR.
 */

import { readBrandEnv } from './env.js';
import {
  renderTextToPngs,
  reflow,
  neutralizeSentinel,
  shrinkColsToContent,
  resolveSinglePagePatchCols,
  renderCellWidth,
  renderCellHeight,
  PAD_X,
  PAD_Y,
  READABLE_CHARS_PER_IMAGE,
  type RenderedImage,
} from './render.js';
import {
  resolveGptProfile,
  type GptModelProfile,
  type GptVisionCost,
} from './gpt-model-profiles.js';
import { bytesToBase64 } from './png.js';
import {
  applyClientSessionIdentity,
  compactSlabWhitespace,
  countVisualRows,
  estimateImageCount,
  resolveOpticalHistoryPolicy,
  sha8,
  splitStaticDynamic,
  type ClientSessionSource,
  type OpticalMode,
  type TransformInfo,
  type TransformOptions,
} from './transform.js';
import { splitVolatileXmlIslands, VOLATILE_XML_TAGS } from './schema-compiler.js';
import { visionTokens } from './vision-cost.js';
import { computeOpenAICollapsePaybackReads } from './openai-savings.js';
import { extractFaultSignalSnippet, isFileReadToolName } from './context-mmu.js';
import { evaluateCliffAvoidance, gateRatesFor, priceMode } from './pricing.js';
import {
  applyOpenAIChatTextHygiene,
  applyOpenAIResponsesTextHygiene,
  buildOpticalToolSealKey,
  isTextHygieneActive,
  resolveTextHygieneMode,
  type TextHygieneMode,
} from './text-hygiene.js';
import type { StageToggles } from './stage-plugins.js';
import { stripSchemaDescriptions } from './schema-strip.js';
import {
  GPT_HISTORY_DEFAULTS,
  planGptCollapse,
  planResponsesPairCollapse,
  chatMessagesToTurns,
  isResponsesToolCall,
  isResponsesToolOutput,
  type GptCollapsePlan,
  type GptHistoryOptions,
} from './openai-history.js';
import { HISTORY_SYNTHETIC_INTRO, HISTORY_SYNTHETIC_OUTRO } from './history.js';
import { extractFactSheetTokens, factSheetText, prepareFactSheet } from './factsheet.js';
import { relocateOpenAIPins } from './pin.js';
import { gptTokenCount as o200kCountTokens } from './gpt-tokens.js';
import {
  getCacheCircuitBreakerState,
  hasStage2SealKey,
  noteHistoryRequest,
  recordStage2SealKey,
  sessionAnchorText,
} from './session-state.js';

// Per-model GPT rendering + vision-cost profiles (portrait-strip width, image-token
// cost model, max image height) live in ./gpt-model-profiles.ts so a new model is a
// one-line / one-env-var retune. resolveVisionCost stays a thin wrapper so every caller
// (gate, slab, history, dashboard) shares the single source of truth.
type VisionCost = GptVisionCost;

export function resolveVisionCost(model: string): VisionCost {
  return resolveGptProfile(model).vision;
}

// Sharp framing around the collapsed-history image. The transcript flattens BOTH
// roles into one role:'user' message (the API forbids images inside role:'assistant'),
// so this text must (a) tell the model to attribute strictly by the <user>/<assistant>
// tags rendered inside the image and (b) make explicit this is PAST context, not the
// live request — otherwise the model summarizes the transcript instead of answering.
// Aliases of the SINGLE SOURCE OF TRUTH in history.ts (see its doc comment). Importing
// rather than re-declaring guarantees the GPT and Anthropic paths can never silently drift
// on the turn-attribution wording — the exact divergence history.ts warns about.
export const HISTORY_TRANSCRIPT_INTRO = HISTORY_SYNTHETIC_INTRO;
export const HISTORY_TRANSCRIPT_OUTRO = HISTORY_SYNTHETIC_OUTRO;
export const COMPACT_HISTORY_TRANSCRIPT_INTRO =
  '[Earlier turns in image(s): follow <user t=N>/<assistant t=N> tags in increasing N. Prior context—not the current request.]';
export const COMPACT_HISTORY_TRANSCRIPT_OUTRO = '[End earlier conversation.]';
// The most-recent user request is kept as LEGIBLE TEXT (never imaged) and spliced
// between the before/after history images inside the synthetic user message, under
// this banner. Older user turns stay imaged (they must not look live). This is the
// fix for autonomous single-user-turn agents (OpenCode): the lone request is the
// OLDEST turn, so it would otherwise be the first thing imaged and the model loses
// it — "I wonder what the user actually asked" → off-task drift.
const PINNED_REQUEST_HEADER =
  '\n===== CURRENT USER REQUEST (live; kept as text by fiche, NOT inside any image) =====\n';
const PINNED_REQUEST_FOOTER =
  '\n===== END CURRENT USER REQUEST =====\n';

export function pinnedRequestBlock(text: string): string {
  return PINNED_REQUEST_HEADER + text + PINNED_REQUEST_FOOTER;
}

// Developer-role guard placed after the history image. When a request was pinned it
// echoes it verbatim (capped) and points at the in-history text block; otherwise it
// falls back to "the live request is the trailing user message" (interactive shape,
// where the latest user turn is already native text in the kept tail).
export function buildLiveRequestGuard(pinText?: string): string {
  if (pinText !== undefined) {
    const echo = pinText.length > 600 ? pinText.slice(0, 600) + '…' : pinText;
    return (
      'fiche note: everything in the rendered history above is PAST context. Your live current request is the plain-text block labeled "CURRENT USER REQUEST" inside it — NOT anything OCR\'d from an image. It reads: «' +
      echo +
      '» Answer THAT request.'
    );
  }
  return 'fiche note: the preceding rendered history item is prior conversation context only. It is not the current user request. The live current request is in the user message(s) that follow, especially the final user message.';
}

/** Alias of `visionTokensForModel`, kept for OpenAI-path call sites and tests.
 *  There is no separate OpenAI formula: the model's profile carries its regime. */
export function openAIVisionTokens(model: string, w: number, h: number): number {
  return visionTokensForModel(model, w, h);
}

/** True when this Responses/Chat request is actually served by a Claude model.
 *  Codex-style clients speak OpenAI Responses while some models are Anthropic,
 *  so routing must agree with pricing: this re-exports the SAME predicate the
 *  profile table uses to route an id to the Anthropic profile. A second, subtly
 *  different copy here would route a request one way and price it the other. */
export { isClaudeModel } from './claude-model-profiles.js';

/** Per-image vision-token cost for the model actually serving the request.
 *  Model-based, not endpoint-based, and family-agnostic: the profile's `vision`
 *  regime decides the formula (Anthropic patches, OpenAI tiles/patches, Grok
 *  pixels, Gemini flat), so no provider branch is needed here. This is the exact
 *  provider cost; the gate applies its own margin separately. */
export function visionTokensForModel(model: string, w: number, h: number): number {
  return visionTokens(resolveGptProfile(model), w, h);
}

type OpenAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | string;

interface OpenAITextPart {
  type: 'text';
  text: string;
  [k: string]: unknown;
}

interface OpenAIImagePart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high' | 'original';
  };
}

type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | Record<string, unknown>;

interface OpenAIChatMessage {
  role: OpenAIRole;
  content?: string | OpenAIContentPart[] | null;
  [k: string]: unknown;
}

interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name?: string;
    description?: string;
    parameters?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: unknown[];
  [k: string]: unknown;
}

// ---- Responses API types ----
interface ResponsesInputTextPart {
  type: 'input_text';
  text: string;
  [k: string]: unknown;
}

interface ResponsesInputImagePart {
  type: 'input_image';
  image_url: string;
  detail?: 'auto' | 'low' | 'high' | 'original';
  [k: string]: unknown;
}

type ResponsesContentPart = ResponsesInputTextPart | ResponsesInputImagePart | Record<string, unknown>;

interface ResponsesInputItem {
  role: 'user' | 'system' | 'developer' | 'assistant' | string;
  content: string | ResponsesContentPart[];
  [k: string]: unknown;
}

interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: string | Array<ResponsesInputItem | Record<string, unknown>>;
  tools?: unknown[];
  [k: string]: unknown;
}

function responsesCacheBreakpoint(
  req: ResponsesRequest,
  profile: GptModelProfile,
  allowExplicit: boolean,
): Record<string, unknown> {
  // ChatGPT Codex rejects this field on every model whose profile started
  // marking cacheBreakpoints. api.openai.com still receives it when the
  // profile asks and the caller did not already pick a non-implicit mode.
  if (!allowExplicit || profile.cacheBreakpoints !== true) return {};
  const mode = (req.prompt_cache_options as { mode?: string } | undefined)?.mode;
  return mode === undefined || mode === 'implicit'
    ? { prompt_cache_breakpoint: { mode: 'explicit' } }
    : {};
}

/** Profile-controlled native overflow is shared with rendered-content evals. */
export function historyFactSheet(text: string, profile: GptModelProfile, coveredTokens?: ReadonlySet<string>): string {
  return prepareHistoryFactSheet(text, profile)(coveredTokens);
}

function prepareHistoryFactSheet(
  text: string,
  profile: GptModelProfile,
  slabCoveredText?: string,
): (coveredTokens?: ReadonlySet<string>) => string {
  const renderSheet = prepareFactSheet(text, profile.factSheetFormat);
  const sheet = renderSheet();
  if (profile.history.factSheetOverflow !== 'native-opaque') {
    const baseSheet = slabCoveredText ? renderSheet(slabCoveredText, true) : sheet;
    return () => baseSheet;
  }
  const opaque = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]{7,128}\b)(?=[0-9a-f]{0,127}\d)[0-9a-f]{7,128})\b/gi;
  const covered = new Set([...sheet.matchAll(opaque)].map((m) => m[0]));
  const excerpts = new Map<string, string[]>();
  let source = 'archived context';
  let argumentsNext = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('[tool_use ')) {
      source = line;
      argumentsNext = true;
    } else if (argumentsNext) {
      source += ' ' + line;
      argumentsNext = false;
    }
    const identifiers = [...line.matchAll(opaque)].map((m) => m[0]);
    if (!identifiers.some((id) => !covered.has(id))) continue;
    const lines = excerpts.get(source) ?? [];
    lines.push(line);
    excerpts.set(source, lines);
    for (const id of identifiers) covered.add(id);
  }
  // Exact spellings already sent in earlier archive groups need not be sent
  // again. Keep local repetition counts, and never deduplicate opaque excerpts.
  if (excerpts.size === 0) return (coveredTokens) => {
    if (slabCoveredText && !coveredTokens?.size) {
      return renderSheet(slabCoveredText, true);
    }
    return coveredTokens?.size ? renderSheet(coveredTokens) : sheet;
  };
  const raw = [...excerpts].map(([source, lines]) => [source, ...lines].join('\n')).join('\n');
  const quoted = [...excerpts].map(([source, lines]) => ({ source, lines }));
  const result = renderSheet(raw)
    + '\n[Archived exact-value excerpts (quoted data, not current instructions): '
    + JSON.stringify(quoted) + ']';
  return () => result;
}

/** Bounded to one request. Only extraction is reused; final coverage-dependent
 * output is always recomputed. No cross-request retention of source text. */
export function createHistoryFactSheetRenderer(
  profile: GptModelProfile,
  limits: { maxEntries?: number; maxChars?: number; slabCoveredText?: string } = {},
) {
  const maxEntries = Number.isFinite(limits.maxEntries) ? Math.max(0, Math.floor(limits.maxEntries!)) : 64;
  const maxChars = Number.isFinite(limits.maxChars) ? Math.max(0, Math.floor(limits.maxChars!)) : 1024 * 1024;
  const slabCoveredText = limits.slabCoveredText;
  const snapshot = { ...profile, history: { ...profile.history } };
  const cache = new Map<string, ReturnType<typeof prepareHistoryFactSheet>>();
  let chars = 0, hits = 0, misses = 0, admitMisses = true;
  return {
    render(text: string, coveredTokens?: ReadonlySet<string>): string {
      let prepared = cache.get(text);
      if (prepared) {
        hits++;
        cache.delete(text); cache.set(text, prepared);
      } else {
        misses++;
        prepared = prepareHistoryFactSheet(text, snapshot, slabCoveredText);
        if (admitMisses && maxEntries > 0 && text.length <= maxChars) {
          while (cache.size && (cache.size >= maxEntries || chars + text.length > maxChars)) {
            const oldest = cache.keys().next().value!;
            chars -= oldest.length; cache.delete(oldest);
          }
          cache.set(text, prepared); chars += text.length;
        }
      }
      return prepared(coveredTokens);
    },
    // Emission is a second sequential pass. Misses there must not evict
    // prepared gate results that later segments can still reuse.
    beginEmission: () => { admitMisses = false; },
    stats: () => ({ entries: cache.size, chars, hits, misses }),
  };
}

interface ResponsesFlatTool {
  type: 'function';
  name?: string;
  description?: string;
  parameters?: unknown;
  [k: string]: unknown;
}

interface OpenAIResolvedOptions {
  compress: boolean;
  imageCompress: boolean;
  opticalMode: OpticalMode;
  textHygiene: boolean | TextHygieneMode;
  expectedOutputTokens: number;
  compressTools: boolean;
  compressToolResults: boolean;
  minCompressChars: number;
  cols?: number;
  charsPerToken: number;
  explicitCharsPerToken: boolean;
  reflow: boolean;
  collapseHistory: boolean;
  gptHistory?: Partial<GptHistoryOptions>;
  /** See TransformOptions.explicitPromptCacheBreakpoints. Default on. */
  explicitPromptCacheBreakpoints: boolean;
  stageToggles?: Partial<StageToggles>;
  cleanUserPayloads: boolean;
  clientSessionId?: string;
  clientSessionSource?: ClientSessionSource;
  claudeCodeSessionId?: string;
}

const DEFAULTS: OpenAIResolvedOptions = {
  compress: true,
  imageCompress: true,
  opticalMode: 'auto',
  textHygiene: 'auto',
  expectedOutputTokens: 1000,
  compressTools: true,
  compressToolResults: true,
  minCompressChars: 2000,
  cols: undefined,
  charsPerToken: 4, // conservative OpenAI default; override after calibration
  explicitCharsPerToken: false,
  reflow: true,
  collapseHistory: true,
  explicitPromptCacheBreakpoints: true,
  stageToggles: {},
  cleanUserPayloads: false,
};

function resolveOptions(opts: TransformOptions): OpenAIResolvedOptions {
  return {
    compress: opts.compress ?? DEFAULTS.compress,
    imageCompress: opts.imageCompress ?? DEFAULTS.imageCompress,
    opticalMode: opts.opticalMode ?? DEFAULTS.opticalMode,
    textHygiene: opts.textHygiene ?? DEFAULTS.textHygiene,
    expectedOutputTokens: opts.expectedOutputTokens ?? DEFAULTS.expectedOutputTokens,
    compressTools: opts.compressTools ?? DEFAULTS.compressTools,
    compressToolResults: opts.compressToolResults ?? DEFAULTS.compressToolResults,
    minCompressChars: opts.minCompressChars ?? DEFAULTS.minCompressChars,
    cols: opts.cols,
    charsPerToken: opts.charsPerToken ?? DEFAULTS.charsPerToken,
    explicitCharsPerToken: opts.charsPerToken !== undefined,
    reflow: opts.reflow ?? DEFAULTS.reflow,
    collapseHistory: opts.collapseHistory ?? DEFAULTS.collapseHistory,
    gptHistory: opts.gptHistory,
    explicitPromptCacheBreakpoints: opts.explicitPromptCacheBreakpoints !== false,
    stageToggles: opts.stageToggles ?? {},
    cleanUserPayloads:
      opts.cleanUserPayloads !== undefined
        ? opts.cleanUserPayloads === true
        : resolveTextHygieneMode(opts.textHygiene ?? DEFAULTS.textHygiene) === 'on',
    clientSessionId: opts.clientSessionId,
    clientSessionSource: opts.clientSessionSource,
    claudeCodeSessionId: opts.claudeCodeSessionId,
  };
}


/** History-collapse options for both Chat and Responses. Profile geometry is
 *  the single source of truth; Grok allows more pages because leftover plain
 *  history is expensive on its pixel bill + weak cache discount. */
function configuredHistoryMaxImages(model: string): number {
  const fallback = resolveGptProfile(model).history.maxImages;
  const raw = readBrandEnv('GPT_HISTORY_MAX_IMAGES');
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  // Responses providers impose their own total image caps. Keep a defensive ceiling
  // while allowing long Sol sessions to opt into substantially more coverage.
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : fallback;
}

function countRequestImages(messages: OpenAIChatMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null && 'type' in part && (part as { type?: string }).type === 'image_url') {
          count++;
        }
      }
    }
  }
  return count;
}

function gptHistoryOpts(
  model: string,
  o: OpenAIResolvedOptions,
  profile: ReturnType<typeof resolveGptProfile>,
  slabImages = 0,
  clientImages = 0,
): Partial<GptHistoryOptions> {
  const configuredMax = o.gptHistory?.maxImages ?? configuredHistoryMaxImages(model);
  // Separate fiche's history-image budget from late client screenshots so adding a
  // user/tool screenshot never shrinks the history budget and un-collapses sealed segments.
  // Only providers with a hard total-image cap subtract clientImages from headroom.
  const historyBudget = Math.max(0, configuredMax - slabImages);
  const remainingMax = profile.providerImageCap !== undefined
    ? Math.max(0, Math.min(historyBudget, profile.providerImageCap - slabImages - clientImages))
    : historyBudget;
  const maxLines = Math.max(
    1,
    Math.floor((profile.maxHeightPx - 2 * PAD_Y) / renderCellHeight(profile.style)),
  );
  const derivedSectionTokens = Math.max(
    GPT_HISTORY_DEFAULTS.sectionTokens,
    Math.floor((0.88 * Math.min(READABLE_CHARS_PER_IMAGE, profile.stripCols * maxLines)) / 3.5),
  );
  return {
    ...o.gptHistory,
    reflow: o.gptHistory?.reflow ?? profile.history.reflow ?? o.reflow,
    keepTail: o.gptHistory?.keepTail ?? profile.history.keepTail,
    keepRecentPairs: o.gptHistory?.keepRecentPairs ?? profile.history.keepRecentPairs,
    minCollapseTokens: o.gptHistory?.minCollapseTokens ?? profile.history.minCollapseTokens,
    sectionTokens: o.gptHistory?.sectionTokens ?? derivedSectionTokens,
    ...(o.gptHistory?.minCollapsePrefix !== undefined || profile.history.minCollapsePrefix !== undefined
      ? { minCollapsePrefix: o.gptHistory?.minCollapsePrefix ?? profile.history.minCollapsePrefix }
      : {}),
    ...(o.gptHistory?.collapseChunk !== undefined || profile.history.collapseChunk !== undefined
      ? { collapseChunk: o.gptHistory?.collapseChunk ?? profile.history.collapseChunk }
      : {}),
    freezeChunk: o.gptHistory?.freezeChunk ?? profile.history.freezeChunk ?? GPT_HISTORY_DEFAULTS.freezeChunk,
    responsesMode: profile.history.responsesMode,
    cols: o.gptHistory?.cols ?? profile.stripCols,
    maxHeightPx: o.gptHistory?.maxHeightPx ?? profile.maxHeightPx,
    style: o.gptHistory?.style ?? profile.style,
    maxImages: remainingMax,
  };
}

function emptyInfo(reason?: string): TransformInfo {
  return {
    compressed: false,
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

export function prepareImagedRenderText(text: string, reflowEnabled: boolean): string {
  return maybeReflow(text.trimEnd(), reflowEnabled);
}

function maybeReflow(text: string, enabled: boolean): string {
  if (!enabled) return text;
  const safe = neutralizeSentinel(text);
  return reflow(safe) ?? safe;
}

function isTextPart(part: unknown): part is OpenAITextPart {
  return (
    typeof part === 'object'
    && part !== null
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
  );
}

function contentText(content: OpenAIChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isTextPart)
    .map((p) => p.text)
    .join('\n\n');
}

function setTextContent(msg: OpenAIChatMessage, text: string): void {
  if (Array.isArray(msg.content)) {
    const kept = msg.content.filter((p) => !isTextPart(p));
    msg.content = [{ type: 'text', text }, ...kept];
  } else {
    msg.content = text;
  }
}

function firstUserText(req: OpenAIChatRequest): string {
  const texts: string[] = [];
  for (const msg of req.messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      if (texts.length > 0) break;
      continue;
    }
    if (msg.role !== 'user') break;
    const t = contentText(msg.content);
    if (t.trim()) texts.push(t);
  }
  return sessionAnchorText(texts).slice(0, 4096);
}

function responsesContentText(content: ResponsesInputItem['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is ResponsesInputTextPart =>
      typeof p === 'object'
      && p !== null
      && (
        (p as { type?: unknown }).type === 'input_text' ||
        (p as { type?: unknown }).type === 'output_text' ||
        (p as { type?: unknown }).type === 'text'
      )
      && typeof (p as { text?: unknown }).text === 'string')
    .map((p) => p.text)
    .join('\n\n');
}

function firstResponsesUserText(
  inputWasString: boolean,
  originalInput: string | undefined,
  inputItems: Array<ResponsesInputItem | Record<string, unknown>>,
): string {
  if (inputWasString) {
    return originalInput ? sessionAnchorText([originalInput]).slice(0, 4096) : '';
  }
  const texts: string[] = [];
  for (const item of inputItems) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as ResponsesInputItem).role;
    const type = (item as { type?: unknown }).type;
    if (role === 'system' || role === 'developer') {
      if (texts.length > 0) break;
      continue;
    }
    if (role !== 'user') {
      if (role || type === 'function_call' || type === 'function_call_output' || type === 'custom_tool_call') break;
      continue;
    }
    const t = responsesContentText((item as ResponsesInputItem).content);
    if (t.trim()) texts.push(t);
  }
  return sessionAnchorText(texts).slice(0, 4096);
}

function extractChatLiveTailTexts(messages: readonly OpenAIChatMessage[]): string[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const out: string[] = [];
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object') return out;

  if (last.role === 'tool') {
    let toolStart = messages.length - 1;
    while (toolStart > 0 && messages[toolStart - 1]?.role === 'tool') {
      toolStart--;
    }
    const prev = toolStart > 0 ? messages[toolStart - 1] : undefined;
    // Only pull tool_calls names/arguments from the preceding assistant message —
    // never Turn t-1's user prompt prose or assistant prose.
    if (prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls)) {
      for (const tc of prev.tool_calls) {
        const fn = tc && typeof tc === 'object' ? (tc as { function?: { name?: unknown; arguments?: unknown } }).function : undefined;
        if (fn && typeof fn.arguments === 'string' && fn.arguments.trim()) {
          out.push(typeof fn.name === 'string' ? `${fn.name} ${fn.arguments}` : fn.arguments);
        }
      }
    }
    for (let i = toolStart; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;
      const t = contentText(msg.content);
      const faultSnippet = extractFaultSignalSnippet(t) ?? (t.length <= 1024 && t.trim() ? t : undefined);
      if (faultSnippet) out.push(faultSnippet);
    }
    return out;
  }

  if (last.role === 'user') {
    let toolEnd = messages.length - 1;
    let toolStart = toolEnd;
    while (toolStart > 0 && messages[toolStart - 1]?.role === 'tool') {
      toolStart--;
    }
    for (let i = toolStart; i < toolEnd; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;
      const faultSnippet = extractFaultSignalSnippet(contentText(msg.content));
      if (faultSnippet) out.push(faultSnippet);
    }
  }

  const t = contentText(last.content);
  if (t.trim()) out.push(t);
  if (Array.isArray(last.tool_calls)) {
    for (const tc of last.tool_calls) {
      const fn = tc && typeof tc === 'object' ? (tc as { function?: { name?: unknown; arguments?: unknown } }).function : undefined;
      if (fn && typeof fn.arguments === 'string' && fn.arguments.trim()) {
        out.push(typeof fn.name === 'string' ? `${fn.name} ${fn.arguments}` : fn.arguments);
      }
    }
  }
  return out;
}

function appendChatTailHydration(req: OpenAIChatRequest, hydrationBlock: string): void {
  if (!hydrationBlock) return;
  if (!Array.isArray(req.messages) || req.messages.length === 0) return;
  // Never walk backwards past an assistant/tool sequence into Turn-1 messages.
  // Only append to the trailing live user or trailing tool-result message.
  const last = req.messages[req.messages.length - 1];
  if (!last || (last.role !== 'user' && last.role !== 'tool')) return;
  if (typeof last.content === 'string') {
    last.content = last.content ? `${last.content}\n\n${hydrationBlock}` : hydrationBlock;
    return;
  }
  if (Array.isArray(last.content)) {
    last.content.push({ type: 'text', text: hydrationBlock });
  }
}

function extractResponsesLiveTailTexts(
  inputWasString: boolean,
  originalInput: string | undefined,
  inputItems: ReadonlyArray<ResponsesInputItem | Record<string, unknown>>,
): string[] {
  if (inputWasString) return originalInput ? [originalInput] : [];
  if (!Array.isArray(inputItems) || inputItems.length === 0) return [];
  const out: string[] = [];
  const isToolOutputItem = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    const t = (item as { type?: unknown }).type;
    return t === 'function_call_output' || t === 'custom_tool_call_output';
  };
  const isToolCallItem = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    const t = (item as { type?: unknown }).type;
    return t === 'function_call' || t === 'custom_tool_call';
  };
  const pushCallItem = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    const rec = item as { name?: unknown; arguments?: unknown; input?: unknown };
    if (typeof rec.arguments === 'string' && rec.arguments.trim()) {
      out.push(typeof rec.name === 'string' ? `${rec.name} ${rec.arguments}` : rec.arguments);
    } else if (typeof rec.input === 'string' && rec.input.trim()) {
      out.push(typeof rec.name === 'string' ? `${rec.name} ${rec.input}` : rec.input);
    }
  };

  const last = inputItems[inputItems.length - 1];
  if (!last || typeof last !== 'object') return out;

  if (isToolOutputItem(last)) {
    let tailStart = inputItems.length - 1;
    while (tailStart > 0 && isToolOutputItem(inputItems[tailStart - 1])) {
      tailStart--;
    }
    // Pull ONLY preceding tool call names/arguments — never Turn t-1's user prompt prose.
    let callStart = tailStart;
    while (callStart > 0 && isToolCallItem(inputItems[callStart - 1])) {
      callStart--;
    }
    for (let i = callStart; i < tailStart; i++) {
      pushCallItem(inputItems[i]);
    }
    for (let i = tailStart; i < inputItems.length; i++) {
      const rec = inputItems[i] as { output?: unknown };
      if (rec.output !== undefined) {
        const rawOut = typeof rec.output === 'string' ? rec.output : JSON.stringify(rec.output);
        const faultSnippet =
          extractFaultSignalSnippet(rawOut) ?? (rawOut.length <= 1024 && rawOut.trim() ? rawOut : undefined);
        if (faultSnippet) out.push(faultSnippet);
      }
    }
    return out;
  }

  const rec = last as {
    role?: unknown;
    content?: unknown;
    name?: unknown;
    arguments?: unknown;
    input?: unknown;
  };
  if (rec.role === 'user') {
    let toolEnd = inputItems.length - 1;
    let toolStart = toolEnd;
    while (toolStart > 0 && isToolOutputItem(inputItems[toolStart - 1])) {
      toolStart--;
    }
    for (let i = toolStart; i < toolEnd; i++) {
      const prevOut = inputItems[i] as { output?: unknown };
      if (prevOut.output !== undefined) {
        const faultSnippet = extractFaultSignalSnippet(
          typeof prevOut.output === 'string' ? prevOut.output : JSON.stringify(prevOut.output),
        );
        if (faultSnippet) out.push(faultSnippet);
      }
    }
  }
  pushCallItem(rec);
  if (typeof rec.content === 'string' && rec.content.trim()) {
    out.push(rec.content);
  } else if (Array.isArray(rec.content)) {
    const txt = responsesContentText(rec.content as ResponsesContentPart[]);
    if (txt.trim()) out.push(txt);
  }
  return out;
}

function appendResponsesTailHydration(req: ResponsesRequest, hydrationBlock: string): void {
  if (!hydrationBlock) return;
  if (typeof req.input === 'string') {
    req.input = req.input ? `${req.input}\n\n${hydrationBlock}` : hydrationBlock;
    return;
  }
  if (!Array.isArray(req.input)) req.input = [];
  const items = req.input;
  const last = items[items.length - 1] as ResponsesInputItem | undefined;
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') {
      last.content = last.content ? `${last.content}\n\n${hydrationBlock}` : hydrationBlock;
      return;
    }
    if (Array.isArray(last.content)) {
      last.content.push({ type: 'input_text', text: hydrationBlock });
      return;
    }
  }
  items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: hydrationBlock }] });
}

function isFunctionTool(tool: unknown): tool is OpenAIFunctionTool {
  return (
    typeof tool === 'object'
    && tool !== null
    && (tool as { type?: unknown }).type === 'function'
    && typeof (tool as { function?: unknown }).function === 'object'
    && (tool as { function?: unknown }).function !== null
  );
}

function isFlatFunctionTool(tool: unknown): tool is ResponsesFlatTool {
  return (
    typeof tool === 'object'
    && tool !== null
    && (tool as { type?: unknown }).type === 'function'
    && typeof (tool as { name?: unknown }).name === 'string'
  );
}

/** Render schema annotations removed from the native tool definition. The full
 * top-level description rides in the same image and is replaced by a short
 * per-tool pointer, matching the Anthropic tool-reference approach. */
export function schemaAnnotationLines(node: unknown, path = '$', depth = 0): string[] {
  if (!node || typeof node !== 'object' || depth > 20) return [];
  if (Array.isArray(node)) {
    return node.flatMap((value, i) => schemaAnnotationLines(value, `${path}[${i}]`, depth + 1));
  }
  const obj = node as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['description', 'title', 'examples', 'default', '$comment']) {
    if (obj[key] !== undefined) out.push(`${path} ${key}: ${JSON.stringify(obj[key])}`);
  }
  if (typeof obj.format === 'string' && obj.format.length > 32) {
    out.push(`${path} format: ${JSON.stringify(obj.format)}`);
  }
  for (const key of ['properties', 'patternProperties', 'definitions', '$defs']) {
    const children = obj[key];
    if (!children || typeof children !== 'object' || Array.isArray(children)) continue;
    for (const [name, child] of Object.entries(children as Record<string, unknown>)) {
      out.push(...schemaAnnotationLines(child, `${path}.${name}`, depth + 1));
    }
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const children = obj[key];
    if (!Array.isArray(children)) continue;
    children.forEach((child, i) => {
      out.push(...schemaAnnotationLines(child, `${path}.${key}[${i}]`, depth + 1));
    });
  }
  for (const key of [
    'items', 'additionalProperties', 'not', 'contains', 'propertyNames',
    'unevaluatedItems', 'unevaluatedProperties', 'if', 'then', 'else',
  ]) {
    if (obj[key] !== undefined) {
      out.push(...schemaAnnotationLines(obj[key], `${path}.${key}`, depth + 1));
    }
  }
  return out;
}

function renderToolDoc(tool: OpenAIFunctionTool): string {
  const f = tool.function;
  const annotations = schemaAnnotationLines(f.parameters);
  return f.description || annotations.length
    ? [`## Tool: ${f.name ?? '?'}`, f.description ?? '', ...annotations].filter(Boolean).join('\n')
    : '';
}

function renderFlatToolDoc(tool: ResponsesFlatTool): string {
  const annotations = schemaAnnotationLines(tool.parameters);
  return tool.description || annotations.length
    ? [`## Tool: ${tool.name ?? '?'}`, tool.description ?? '', ...annotations].filter(Boolean).join('\n')
    : '';
}

function rewriteToolsForGpt(tools: unknown[] | undefined): {
  tools: unknown[] | undefined;
  docs: string;
} {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, docs: '' };
  const docs: string[] = [];
  let changed = false;
  const rewritten = tools.map((tool) => {
    if (!isFunctionTool(tool)) return tool;
    const doc = renderToolDoc(tool);
    if (doc) docs.push(doc);
    if (tool.function.parameters === undefined) return tool;
    changed = true;
    return {
      ...tool,
      function: {
        ...tool.function,
        description: `Full docs: see "## Tool: ${tool.function.name ?? '?'}" in the rendered context image.`,
        parameters: stripSchemaDescriptions(tool.function.parameters),
      },
    };
  });
  return { tools: changed ? rewritten : tools, docs: docs.join('\n\n') };
}

function rewriteFlatToolsForGpt(tools: unknown[] | undefined): {
  tools: unknown[] | undefined;
  docs: string;
} {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, docs: '' };
  const docs: string[] = [];
  let changed = false;
  const rewritten = tools.map((tool) => {
    if (!isFlatFunctionTool(tool)) return tool;
    const doc = renderFlatToolDoc(tool);
    if (doc) docs.push(doc);
    if (tool.parameters === undefined) return tool;
    changed = true;
    return {
      ...tool,
      description: `Full docs: see "## Tool: ${tool.name ?? '?'}" in the rendered context image.`,
      parameters: stripSchemaDescriptions(tool.parameters),
    };
  });
  return { tools: changed ? rewritten : tools, docs: docs.join('\n\n') };
}

/** Shared by normal outbound requests and profile-aligned evaluations. */
export function openAIImageDetail(model?: string): 'original' | 'high' {
  const isGpt5Family = typeof model === 'string' && /^gpt-5/i.test(model);
  return resolveGptProfile(model).imageDetail ?? (isGpt5Family ? 'original' : 'high');
}

function openAIImagePart(img: RenderedImage, model?: string): OpenAIImagePart {
  return {
    type: 'image_url',
    image_url: {
      url: `data:image/png;base64,${bytesToBase64(img.png)}`,
      detail: openAIImageDetail(model),
    },
  };
}

/** Build a Responses API input_image part. */
function responsesImagePart(img: RenderedImage, model?: string): ResponsesInputImagePart {
  return {
    type: 'input_image',
    image_url: `data:image/png;base64,${bytesToBase64(img.png)}`,
    detail: openAIImageDetail(model),
  };
}

function countOutgoingTextChars(req: OpenAIChatRequest): number {
  let n = 0;
  for (const msg of req.messages) n += contentText(msg.content).length;
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      if (!isFunctionTool(tool)) continue;
      const f = tool.function;
      if (typeof f.name === 'string') n += f.name.length;
      if (typeof f.description === 'string') n += f.description.length;
      if (f.parameters !== undefined) n += safeStringifyLen(f.parameters);
    }
  }
  return n;
}

/** Outgoing text-char denominator for the GPT Responses regression, mirroring
 *  countOutgoingTextChars for Chat: instructions + message-item text (string or
 *  input_text parts) + flat tool name/description/parameters. input_image base64
 *  is excluded on purpose — it is image cost, not text (responsesContentText
 *  already drops non-text parts). */
type ResponsesComposition = NonNullable<TransformInfo['responsesComposition']>;

/** Bounded LRU cache for opaque reasoning/compaction blobs so immutable
 *  Codex `encrypted_content` items are not re-serialized & o200k-tokenized on every turn. */
const OPAQUE_ITEM_TOKEN_CACHE = new Map<string, number>();
const OPAQUE_ITEM_CACHE_MAX = 256;

function dualDigest64Hex(s: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b1 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul((h1 ^ c) >>> 0, 0x01000193) >>> 0;
    h2 = Math.imul((h2 ^ ((c + (i & 0xff)) >>> 0)) >>> 0, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function cachedOpaqueItemTokens(o: Record<string, unknown>): number {
  const enc = typeof o.encrypted_content === 'string' ? o.encrypted_content : undefined;
  const keyCount = Object.keys(o).length;
  if (enc && enc.length >= 256 && keyCount <= 6) {
    const itemType = typeof o.type === 'string' ? o.type : '';
    const id = typeof o.id === 'string' ? o.id : '';
    const cacheKey = `${itemType}:${id}:${keyCount}:${enc.length}:${dualDigest64Hex(enc)}`;
    const hit = OPAQUE_ITEM_TOKEN_CACHE.get(cacheKey);
    if (hit !== undefined) {
      OPAQUE_ITEM_TOKEN_CACHE.delete(cacheKey);
      OPAQUE_ITEM_TOKEN_CACHE.set(cacheKey, hit);
      return hit;
    }
    const tokens = gptTextTokens(JSON.stringify(o));
    if (OPAQUE_ITEM_TOKEN_CACHE.size >= OPAQUE_ITEM_CACHE_MAX) {
      const oldest = OPAQUE_ITEM_TOKEN_CACHE.keys().next().value;
      if (oldest !== undefined) OPAQUE_ITEM_TOKEN_CACHE.delete(oldest);
    }
    OPAQUE_ITEM_TOKEN_CACHE.set(cacheKey, tokens);
    return tokens;
  }
  return gptTextTokens(JSON.stringify(o));
}

function responsesOutputTextOnly(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const part of output) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      const t = typeof p.type === 'string' ? p.type : '';
      if (t === 'input_image' || t === 'image' || t === 'output_image' || t === 'image_url') continue;
      if ((t === 'input_text' || t === 'output_text' || t === 'text' || !t) && typeof p.text === 'string') {
        texts.push(p.text);
      } else if (typeof p.content === 'string') {
        texts.push(p.content);
      }
    }
    return texts.join('\n\n');
  }
  if (output !== undefined && output !== null) {
    try {
      return JSON.stringify(output) ?? '';
    } catch {
      return '';
    }
  }
  return '';
}

/** Local o200k decomposition of the original Responses request. This is
 * diagnostic only and never calls Anthropic/provider count_tokens. */
function measureResponsesComposition(
  req: ResponsesRequest,
  inputWasString: boolean,
  originalInputString: string | undefined,
  inputItems: Array<ResponsesInputItem | Record<string, unknown>>,
): ResponsesComposition {
  const c: ResponsesComposition = {
    instructions: gptTextTokens(typeof req.instructions === 'string' ? req.instructions : ''),
    systemDeveloper: 0,
    userAssistant: 0,
    functionCalls: 0,
    functionOutputs: 0,
    reasoningEncrypted: 0,
    compactionOpaque: 0,
    toolsJson: Array.isArray(req.tools) ? gptTextTokens(JSON.stringify(req.tools)) : 0,
    other: 0,
    totalLocal: 0,
    imageParts: 0,
  };
  if (inputWasString) {
    c.userAssistant += gptTextTokens(originalInputString ?? '');
  }
  const countImages = (content: unknown): number => {
    if (!Array.isArray(content)) return 0;
    return content.filter((p) => {
      const type = (p as { type?: unknown } | null)?.type;
      return type === 'input_image' || type === 'image' || type === 'output_image';
    }).length;
  };
  for (const item of inputItems) {
    const o = item as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type : '';
    const role = typeof o.role === 'string' ? o.role : '';
    c.imageParts += countImages(o.content);
    if (role === 'system' || role === 'developer') {
      c.systemDeveloper += gptTextTokens(responsesContentText(o.content as ResponsesInputItem['content']));
    } else if (role === 'user' || role === 'assistant') {
      c.userAssistant += gptTextTokens(responsesContentText(o.content as ResponsesInputItem['content']));
    } else if (isResponsesToolCall(o)) {
      c.functionCalls += gptTextTokens(JSON.stringify(o));
    } else if (isResponsesToolOutput(o)) {
      c.functionOutputs += gptTextTokens(responsesOutputTextOnly(o.output));
      c.imageParts += countImages(o.output);
    } else if (type === 'reasoning') {
      // Includes encrypted_content when present; this is often a large Codex-native bucket.
      c.reasoningEncrypted += cachedOpaqueItemTokens(o);
    } else if (
      type === 'compaction' || type === 'compaction_trigger' ||
      type === 'context_compaction' || type === 'item_reference'
    ) {
      c.compactionOpaque += cachedOpaqueItemTokens(o);
    } else if (!role && type) {
      c.other += gptTextTokens(JSON.stringify(o));
    }
  }
  c.totalLocal = c.instructions + c.systemDeveloper + c.userAssistant +
    c.functionCalls + c.functionOutputs + c.reasoningEncrypted +
    c.compactionOpaque + c.toolsJson + c.other;
  return c;
}

function countResponsesOutgoingTextChars(req: ResponsesRequest): number {
  let n = 0;
  if (typeof req.instructions === 'string') n += req.instructions.length;
  if (typeof req.input === 'string') {
    n += req.input.length;
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      n += responsesContentText((item as ResponsesInputItem).content).length;
    }
  }
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      if (!isFlatFunctionTool(tool)) continue;
      if (typeof tool.name === 'string') n += tool.name.length;
      if (typeof tool.description === 'string') n += tool.description.length;
      if (tool.parameters !== undefined) n += safeStringifyLen(tool.parameters);
    }
  }
  return n;
}

function safeStringifyLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function droppedCodepointsTop(droppedCodepoints: Map<number, number>): Record<string, number> | undefined {
  if (droppedCodepoints.size === 0) return undefined;
  const out: Record<string, number> = {};
  for (const [cp, count] of [...droppedCodepoints.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)) {
    out[`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`] = count;
  }
  return out;
}

/** Shared gate: image vs text token cost → profitability.
 *
 *  Profiles with a local-token floor always use o200k (same baseline as savings
 *  math). Legacy non-o200k profiles retain the charsPerToken override. Images bill full
 *  pages at maxHeight and the last page at residual height — charging every page
 *  as a full strip over-states cost and blocks profitable collapses. */
function evalOpenAIGate(
  model: string,
  renderedText: string,
  cols: number,
  charsPerToken: number,
  baselineTextTokens?: number,
): { imageTokens: number; textTokens: number; profitable: boolean } {
  const profile = resolveGptProfile(model);
  const style = profile.style;
  const cellW = renderCellWidth(style);
  const cellH = renderCellHeight(style);
  const stripW = 2 * PAD_X + cols * cellW;
  const canvasRows = Math.max(1, Math.floor((profile.maxHeightPx - 2 * PAD_Y) / cellH));
  const fullPageHeight = 2 * PAD_Y + canvasRows * cellH;
  const maxLines = canvasRows;
  const maxCharsPerImage = Math.min(
    READABLE_CHARS_PER_IMAGE,
    Math.max(1, cols) * maxLines,
  );
  const linesPerImage = Math.min(
    maxLines,
    Math.max(1, Math.floor(maxCharsPerImage / Math.max(1, cols))),
  );
  const estImages = estimateImageCount(
    renderedText,
    cols,
    maxCharsPerImage,
    maxLines,
  );
  // Last page: residual soft-wrapped rows, not a full strip.
  const visualRows = countVisualRows(renderedText, cols);
  const lastPageLines = estImages <= 1
    ? Math.min(linesPerImage, Math.max(1, visualRows))
    : Math.min(
        linesPerImage,
        Math.max(1, visualRows - (estImages - 1) * linesPerImage),
      );
  const lastPageHeight = Math.min(
    profile.maxHeightPx,
    2 * PAD_Y + lastPageLines * cellH,
  );
  const fullPageTokens = visionTokens(profile, stripW, fullPageHeight);
  const lastPageTokens = visionTokens(profile, stripW, lastPageHeight);
  // No GATE_MARGIN here, unlike the Anthropic slab/history gate, and that
  // asymmetry is deliberate rather than drift:
  //   - this path reproduces the renderer's own page split from the SAME
  //     profile geometry, so `imageTokens` is the exact cost of the images that
  //     will be sent (tests pin gateEval.imageTokens === info.imageTokens);
  //   - it compares against an exact o200k count of the text baseline, not a
  //     chars-per-token approximation.
  // Both sides are exact, so a margin would only be pessimism: it would refuse
  // real, measured savings. The Anthropic gate estimates rows/pages heuristically,
  // which is the estimation error GATE_MARGIN exists to absorb.
  const imageTokens =
    estImages <= 1
      ? lastPageTokens
      : (estImages - 1) * fullPageTokens + lastPageTokens;
  const textTokens = baselineTextTokens ?? (
    charsPerToken !== DEFAULTS.charsPerToken
      ? renderedText.length / Math.max(1e-6, charsPerToken)
      : (profile.minCompressTokens !== undefined || charsPerToken === DEFAULTS.charsPerToken
          ? Math.max(1, gptTextTokens(renderedText) || Math.ceil(renderedText.length / charsPerToken))
          : renderedText.length / Math.max(1e-6, charsPerToken))
  );
  return { imageTokens, textTokens, profitable: imageTokens < textTokens };
}

function usesExactStaticBaseline(model: string): boolean {
  return resolveGptProfile(model).exactStaticBaseline === true;
}

/** Shared image-part accumulation from rendered PNGs. */
function accumulateRenderedImages(
  images: RenderedImage[],
  info: TransformInfo,
): { droppedCodepoints: Map<number, number> } {
  const droppedCodepoints = new Map<number, number>();
  for (const img of images) {
    info.imageBytes += img.png.length;
    info.imagePixels = (info.imagePixels ?? 0) + img.width * img.height;
    info.droppedChars = (info.droppedChars ?? 0) + img.droppedChars;
    for (const [cp, count] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + count);
    }
  }
  return { droppedCodepoints };
}

/** o200k_base token count — gpt-5 / gpt-4o / o-series share this encoding. The
 *  honest "as plain text" baseline for the content inkling imaged. Pure JS, no
 *  native build, runs in both Node and Workers. */
function gptTextTokens(text: string): number {
  if (!text) return 0;
  try {
    return o200kCountTokens(text);
  } catch {
    return 0;
  }
}

/** Vision-token cost of the rendered images, summed over their real dims —
 *  what GPT actually bills as input for the slab inkling imaged. */
function gptImageTokens(model: string, images: RenderedImage[]): number {
  let n = 0;
  for (const img of images) n += visionTokensForModel(model, img.width, img.height);
  return n;
}

/** Text-token value of what inkling replaced with images this request: the
 *  original system/developer text (now a pointer + image) plus the tool
 *  *description* tokens stripped from the native JSON (the verbose docs moved
 *  into the image). Tool *structure* stays in the JSON on both paths, so only
 *  the stripped delta counts. Compared against gptImageTokens for the saving. */
function gptBaselineImagedTokens(
  systemTexts: string[],
  originalTools: unknown[] | undefined,
  strippedTools: unknown[] | undefined,
): number {
  let n = 0;
  for (const t of systemTexts) n += gptTextTokens(t);
  const orig = Array.isArray(originalTools) && originalTools.length > 0
    ? gptTextTokens(JSON.stringify(originalTools))
    : 0;
  const stripped = Array.isArray(strippedTools) && strippedTools.length > 0
    ? gptTextTokens(JSON.stringify(strippedTools))
    : 0;
  return n + Math.max(0, orig - stripped);
}

/** Fold a history-collapse plan into TransformInfo: the history images cost
 *  vision tokens (added to imageTokens) and stand in for the o200k text tokens
 *  the collapsed transcript would have cost unproxied (added to baselineImagedTokens).
 *  openai-savings.ts then credits (baseline − image) × cache-weight with no
 *  further change. Also merges image bytes/pixels/dropped + collapse stats. */
function foldGptHistory(
  info: TransformInfo,
  model: string,
  plan: GptCollapsePlan,
): void {
  // A pin can split the collapse into before/after image groups — account for both.
  const allImages = [...plan.images, ...plan.imagesAfter];
  if (allImages.length === 0) {
    if (plan.reason) info.historyReason = plan.reason;
    if (plan.collapsedChars > 0) info.historyTextChars = plan.collapsedChars;
    return;
  }
  info.imageTokens = (info.imageTokens ?? 0) + gptImageTokens(model, allImages);
  // o200k token value of the collapsed transcript (what it cost as plain text).
  info.baselineImagedTokens = (info.baselineImagedTokens ?? 0) +
    (plan.baselineTokens ?? gptTextTokens(plan.text));
  info.imageCount = (info.imageCount ?? 0) + allImages.length;
  for (const img of allImages) {
    info.imageBytes = (info.imageBytes ?? 0) + img.png.length;
    info.imagePixels = (info.imagePixels ?? 0) + img.width * img.height;
  }
  info.imagePngs = [...(info.imagePngs ?? []), ...allImages.map((i) => i.png)];
  info.imageDims = [
    ...(info.imageDims ?? []),
    ...allImages.map((i) => ({ width: i.width, height: i.height })),
  ];
  info.imageSourceTexts = [
    ...(info.imageSourceTexts ?? []),
    ...plan.imageSources,
    ...plan.imageSourcesAfter,
  ];
  if (plan.droppedChars > 0) info.droppedChars = (info.droppedChars ?? 0) + plan.droppedChars;
  info.collapsedTurns = plan.collapsedTurns;
  info.collapsedChars = plan.collapsedChars;
  info.collapsedImages = allImages.length;
  info.historyTextChars = plan.collapsedChars;
  info.historyReason = 'collapsed';
  info.bucketChars = { ...(info.bucketChars ?? {}), history: plan.collapsedChars };
}

async function applyChatHistoryCollapse(
  req: OpenAIChatRequest,
  info: TransformInfo,
  o: OpenAIResolvedOptions,
  profile: GptModelProfile,
  protectedPrefix: number,
  estPromptTokensChat = 0,
  slabCoveredText?: string,
): Promise<boolean> {
  const upstreamSysTok = Math.ceil((info.origChars ?? 0) / Math.max(1, o.charsPerToken));
  const tailMsgTok = req.messages.length > 0 ? gptTextTokens(JSON.stringify(req.messages[req.messages.length - 1])) : 0;
  const estPromptTok = Math.max(estPromptTokensChat, upstreamSysTok + tailMsgTok);
  const profitable = (text: string, cols: number, baselineTextTokens?: number) => {
    const gate = evalOpenAIGate(req.model, text, cols, o.charsPerToken, baselineTextTokens);
    const cliffKey = `${req.model}\0${info.sessionKey ?? info.firstUserSha8 ?? ''}\0chat_hist`;
    const cliffHit = evalAndRecordOpenAICliff(req.model, info, cliffKey, {
      promptTokensBefore: Math.max(gate.textTokens, estPromptTok),
      collapsedBaselineTokens: gate.textTokens,
      collapsedActualTokens: gate.imageTokens,
      downstreamCachedTokens: Math.max(0, estPromptTok - (info.imageTokens ?? 0) - gate.textTokens - tailMsgTok),
      expectedOutputTokens: o.expectedOutputTokens,
    });
    return gate.profitable || cliffHit;
  };
  // Count images already in the request. At the main call site the static slab
  // images are inserted into req.messages before this runs, so walking the
  // messages (instead of also adding info.imageCount) avoids double-counting
  // the slab and matches the Responses path's budget math.
  const slabImages = info.imageCount ?? 0;
  const clientImages = Math.max(0, countRequestImages(req.messages) - slabImages);
  const plan = await planGptCollapse(
    chatMessagesToTurns(req.messages),
    protectedPrefix,
    profitable,
    gptHistoryOpts(req.model, o, profile, slabImages, clientImages),
  );
  foldGptHistory(info, req.model, plan);
  const allImages = [...plan.images, ...plan.imagesAfter];
  if (allImages.length === 0) return false;

  const compactFraming = profile.history.framing === 'compact';
  const intro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_INTRO : HISTORY_TRANSCRIPT_INTRO;
  const outro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_OUTRO : HISTORY_TRANSCRIPT_OUTRO;
  const histFactSheet = slabCoveredText
    ? factSheetText(plan.text, {
        format: profile.factSheetFormat,
        coveredText: slabCoveredText,
        dropCovered: true,
      })
    : factSheetText(plan.text, profile.factSheetFormat);
  const content: OpenAIContentPart[] = [{ type: 'text', text: intro }];
  const chatB64Parts: string[] = [];
  for (const img of plan.images) {
    const part = openAIImagePart(img, req.model);
    chatB64Parts.push(part.image_url.url.slice('data:image/png;base64,'.length));
    content.push(part);
  }
  if (plan.pinText !== undefined) {
    content.push({ type: 'text', text: pinnedRequestBlock(plan.pinText) });
    for (const img of plan.imagesAfter) {
      const part = openAIImagePart(img, req.model);
      chatB64Parts.push(part.image_url.url.slice('data:image/png;base64,'.length));
      content.push(part);
    }
  }
  if (histFactSheet) content.push({ type: 'text', text: histFactSheet });
  content.push({ type: 'text', text: outro });
  const guard = buildLiveRequestGuard(plan.pinText);
  req.messages = [
    ...req.messages.slice(0, plan.start),
    { role: 'user', content },
    { role: 'developer', content: guard },
    ...req.messages.slice(plan.endExclusive),
  ];
  info.nativeInjectedTokens = (info.nativeInjectedTokens ?? 0)
    + gptTextTokens(intro + histFactSheet + outro + guard);
  info.historyImageSha = await sha8(chatB64Parts.join(''));
  return true;
}

function evalAndRecordOpenAICliff(
  model: string,
  info: TransformInfo,
  stickyKey: string,
  args: {
    promptTokensBefore: number;
    collapsedBaselineTokens: number;
    collapsedActualTokens: number;
    downstreamCachedTokens: number;
    expectedOutputTokens: number;
  },
): boolean {
  if (priceMode() !== 'kosha') return false;
  const {
    promptTokensBefore,
    collapsedBaselineTokens,
    collapsedActualTokens,
    downstreamCachedTokens,
    expectedOutputTokens,
  } = args;
  if (!(collapsedActualTokens < collapsedBaselineTokens) || promptTokensBefore <= collapsedBaselineTokens) {
    return false;
  }
  const stickyCliffAt = getOpenAICliffSticky(stickyKey);
  if (stickyCliffAt !== undefined && promptTokensBefore > stickyCliffAt) {
    return true;
  }
  const cliff = evaluateCliffAvoidance(model, {
    promptTokensBefore,
    promptTokensAfter: Math.max(0, promptTokensBefore - (collapsedBaselineTokens - collapsedActualTokens)),
    collapsedBaselineTokens,
    collapsedActualTokens,
    downstreamCachedTokens: Math.max(0, downstreamCachedTokens),
    expectedOutputTokens,
  });
  if (cliff?.crossesCliff && cliff.netSingleTurnUsd > 0) {
    recordOpenAICliffSticky(stickyKey, cliff.cliffAt);
    info.cliffAvoided = {
      at: cliff.cliffAt,
      multiplier: cliff.multiplier,
      savedUsd: cliff.netSingleTurnUsd,
    };
    return true;
  }
  return false;
}

const OPENAI_CLIFF_STICKY_MAX = 512;
const openaiCliffSticky = new Map<string, number>();

function getOpenAICliffSticky(key: string): number | undefined {
  const hit = openaiCliffSticky.get(key);
  if (hit !== undefined) {
    openaiCliffSticky.delete(key);
    openaiCliffSticky.set(key, hit);
  }
  return hit;
}

function recordOpenAICliffSticky(key: string, cliffAt: number): void {
  if (openaiCliffSticky.has(key)) {
    openaiCliffSticky.delete(key);
  } else if (openaiCliffSticky.size >= OPENAI_CLIFF_STICKY_MAX) {
    const oldest = openaiCliffSticky.keys().next().value;
    if (oldest !== undefined) openaiCliffSticky.delete(oldest);
  }
  openaiCliffSticky.set(key, cliffAt);
}

function clearImageStatsForLimit(info: TransformInfo): void {
  info.imageCount = 0;
  info.imageTokens = 0;
  info.baselineImagedTokens = 0;
  info.nativeInjectedTokens = 0;
  info.imageBytes = 0;
  info.imagePixels = 0;
  info.imagePngs = undefined;
  info.imageDims = undefined;
  info.imageSourceText = undefined;
  info.imageSourceTexts = undefined;
  info.firstImagePng = undefined;
  info.firstImageWidth = undefined;
  info.firstImageHeight = undefined;
  info.collapsedTurns = undefined;
  info.collapsedChars = undefined;
  info.collapsedImages = undefined;
  info.historyReason = undefined;
  info.historyTextChars = undefined;
  info.historyImageSha = undefined;
  info.bucketChars = undefined;
  info.compressedChars = 0;
}

async function applyResponsesHistoryCollapse(
  req: ResponsesRequest,
  inputItems: Array<ResponsesInputItem | Record<string, unknown>>,
  info: TransformInfo,
  o: OpenAIResolvedOptions,
  profile: GptModelProfile,
  slabCoveredText?: string,
): Promise<boolean> {
  const historySheets = createHistoryFactSheetRenderer(profile, { slabCoveredText });
  const renderHistorySheet = historySheets.render;
  // Match emission's prefix-local deduplication. Only accepted sections cover
  // spellings; rejected sections must not make a later replacement look cheaper.
  const plannedSheetTokens = profile.history.factSheetOverflow === 'native-opaque'
    && profile.history.factSheetScope === 'per-segment' ? new Set<string>() : undefined;
  const initialComp = info.responsesComposition;
  let remainingPromptTokens = initialComp?.totalLocal ?? 0;
  const upstreamPrefixTokens = (initialComp?.instructions ?? 0) + (initialComp?.toolsJson ?? 0);
  const tailItemTokens = inputItems.length > 0
    ? gptTextTokens(JSON.stringify(inputItems[inputItems.length - 1]))
    : 0;
  const profitable = (text: string, cols: number, baselineTextTokens?: number, sourceText = text) => {
    const gate = evalOpenAIGate(
      req.model,
      text,
      cols,
      o.charsPerToken,
      o.explicitCharsPerToken ? undefined : baselineTextTokens,
    );
    if (!gate.profitable) return false;
    const maxReads = profile.history.maxCachePaybackReads;
    if (!profile.history.factSheetOverflow && maxReads === undefined) return true;
    const framing = profile.history.framing === 'compact'
      ? COMPACT_HISTORY_TRANSCRIPT_INTRO + COMPACT_HISTORY_TRANSCRIPT_OUTRO
      : HISTORY_TRANSCRIPT_INTRO + HISTORY_TRANSCRIPT_OUTRO;
    const sheet = renderHistorySheet(sourceText, plannedSheetTokens);
    const collapsedTokens = gate.imageTokens + gptTextTokens(sheet + framing);
    if (collapsedTokens >= gate.textTokens) return false;
    let accepted = maxReads === undefined
      || computeOpenAICollapsePaybackReads(gate.textTokens, collapsedTokens, req.model) <= maxReads;
    const cliffStickyKey = `${req.model}\0${info.sessionKey ?? info.firstUserSha8 ?? ''}\0${sourceText.length}:${sourceText.slice(0, 128)}`;
    if (!accepted && remainingPromptTokens > gate.textTokens) {
      const stickyCliffAt = priceMode() === 'kosha' ? getOpenAICliffSticky(cliffStickyKey) : undefined;
      if (stickyCliffAt !== undefined && remainingPromptTokens > stickyCliffAt) {
        accepted = true;
      } else {
        const downstreamCachedTokens = Math.max(
          0,
          remainingPromptTokens - upstreamPrefixTokens - gate.textTokens - tailItemTokens,
        );
        const cliff = evaluateCliffAvoidance(req.model, {
          promptTokensBefore: remainingPromptTokens,
          promptTokensAfter: Math.max(0, remainingPromptTokens - (gate.textTokens - collapsedTokens)),
          collapsedBaselineTokens: gate.textTokens,
          collapsedActualTokens: collapsedTokens,
          downstreamCachedTokens,
          expectedOutputTokens: o.expectedOutputTokens,
        });
        if (cliff?.crossesCliff && cliff.netSingleTurnUsd > 0) {
          accepted = true;
          recordOpenAICliffSticky(cliffStickyKey, cliff.cliffAt);
          info.cliffAvoided = {
            at: cliff.cliffAt,
            multiplier: cliff.multiplier,
            savedUsd: cliff.netSingleTurnUsd,
          };
        }
      }
    }
    if (accepted) {
      remainingPromptTokens = Math.max(0, remainingPromptTokens - (gate.textTokens - collapsedTokens));
      if (plannedSheetTokens) {
        for (const token of extractFactSheetTokens(sheet)) plannedSheetTokens.add(token);
      }
    }
    return accepted;
  };
  const slabImages = info.imageCount ?? 0;
  const clientImages = info.responsesComposition?.imageParts ?? 0;
  const plan = await planResponsesPairCollapse(
    inputItems,
    profitable,
    gptHistoryOpts(req.model, o, profile, slabImages, clientImages),
  );
  historySheets.beginEmission();
  const ps = plan.pairState;
  const rc = info.responsesComposition!;
  rc.completedFunctionPairs = ps.completedPairs;
  rc.recentNativeFunctionPairs = ps.recentCompletedPairs;
  rc.oldFunctionPairs = ps.oldCompletedPairs;
  rc.openFunctionCalls = ps.openCalls;
  rc.orphanFunctionOutputs = ps.orphanOutputs;
  rc.malformedFunctionItems = ps.malformedItems;
  rc.imageableFunctionCalls = ps.imageableFunctionCallTokens;
  rc.imageableFunctionOutputs = ps.imageableFunctionOutputTokens;
  rc.collapsedFunctionPairs = ps.collapsedPairs;
  rc.collapsedFunctionCalls = ps.collapsedFunctionCallTokens;
  rc.collapsedFunctionOutputs = ps.collapsedFunctionOutputTokens;
  // Descending count so the dominant page-breaker is first. Bounded to 8 so a
  // pathological body cannot bloat the event row.
  if (plan.barrierTypes && plan.barrierTypes.size > 0) {
    rc.barrierTypes = [...plan.barrierTypes.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([type, count]) => `${type}:${count}`);
  }

  foldGptHistory(info, req.model, plan);
  if (plan.segments.length === 0) return false;

  const replacements = new Map<number, ResponsesInputItem>();
  const compactFraming = profile.history.framing === 'compact';
  const intro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_INTRO : HISTORY_TRANSCRIPT_INTRO;
  const outro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_OUTRO : HISTORY_TRANSCRIPT_OUTRO;
  const combinedSheet = profile.history.factSheetScope === 'combined'
    ? renderHistorySheet(plan.text)
    : '';
  // Request-local and emission-ordered: a skipped/referenced/unimaged group
  // cannot cover a spelling. Use a fresh set to replay the same accepted-prefix
  // coverage used by planning; appended groups keep old prefixes.
  const coveredSheetTokens = profile.history.factSheetOverflow === 'native-opaque'
    ? new Set<string>() : undefined;
  const respB64Parts: string[] = [];
  for (let segmentIndex = 0; segmentIndex < plan.segments.length; segmentIndex++) {
    const segment = plan.segments[segmentIndex]!;
    const segImgParts = segment.images.map((img) => {
      const part = responsesImagePart(img, req.model);
      respB64Parts.push(part.image_url.slice('data:image/png;base64,'.length));
      return part;
    });
    const content: ResponsesContentPart[] = [
      { type: 'input_text', text: intro },
      ...segImgParts,
    ];
    // For `combined`, emit the shared factsheet as a standalone item AFTER all frozen
    // segments so Segment 0 stays byte-identical when Segment 1 seals later.
    const sheet = profile.history.factSheetScope === 'combined'
      ? ''
      : renderHistorySheet(segment.text, coveredSheetTokens);
    if (sheet) {
      content.push({ type: 'input_text', text: sheet });
      if (coveredSheetTokens) {
        for (const token of extractFactSheetTokens(sheet)) coveredSheetTokens.add(token);
      }
    }
    content.push({ type: 'input_text', text: outro, ...responsesCacheBreakpoint(req, profile, o.explicitPromptCacheBreakpoints) });
    info.nativeInjectedTokens = (info.nativeInjectedTokens ?? 0)
      + gptTextTokens(intro + sheet + outro);
    replacements.set(segment.insertAt, { role: 'user', content });
  }

  const removed = new Set(plan.selectedIndices);
  const lastCollapsedIdx = plan.selectedIndices.length > 0
    ? Math.max(...plan.selectedIndices)
    : -1;
  const rewritten: Array<ResponsesInputItem | Record<string, unknown>> = [];
  for (let i = 0; i < inputItems.length; i++) {
    const replacement = replacements.get(i);
    if (replacement) rewritten.push(replacement);
    if (!removed.has(i)) rewritten.push(inputItems[i]!);
    if (combinedSheet && i === lastCollapsedIdx) {
      rewritten.push({ role: 'user', content: [{ type: 'input_text', text: combinedSheet }] });
      info.nativeInjectedTokens = (info.nativeInjectedTokens ?? 0) + gptTextTokens(combinedSheet);
    }
  }
  req.input = rewritten;
  info.historyImageSha = await sha8(respB64Parts.join(''));
  return true;
}

const HYBRID_TOOL_OPTICAL_MIN_CHARS = 2_500;
const HYBRID_TOOL_OPTICAL_MAX_IMAGES = 8;
const LARGE_USER_OPTICAL_MIN_CHARS = 24_000;
const USER_HEAD_KEEP_CHARS = 1_000;
const USER_TAIL_KEEP_CHARS = 1_500;
const LARGE_USER_OPTICAL_MAX_IMAGES = 24;

async function compressResponsesToolOutputsOptically(
  req: ResponsesRequest,
  inputItems: Array<ResponsesInputItem | Record<string, unknown>>,
  info: TransformInfo,
  o: OpenAIResolvedOptions,
  profile: GptModelProfile,
  droppedCodepoints?: Map<number, number>,
  sessionKey?: string,
  _sessionCacheCold?: boolean,
  rawIndexOffset = 0,
  breakerState: 'closed' | 'open' | 'half_open' = 'closed',
): Promise<boolean> {
  let addedImagesCount = 0;
  let addedBase64Bytes = 0;
  let changed = false;
  const maxSerialized = profile.maxSerializedRequestBytes;
  const reflowNote = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const maxCols = o.cols ?? profile.stripCols;
  // Strict 2-phase trailing-round isolator:
  // Phase 1 walks backwards across contiguous trailing `*_output` items;
  // Phase 2 walks backwards across immediately preceding `*_call`/`reasoning` items,
  // stopping as soon as any earlier `*_output` or non-tool message appears.
  const isTrailingOutput = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object') return false;
    if (isResponsesToolOutput(raw)) return true;
    const t = (raw as { type?: unknown }).type;
    return typeof t === 'string' && t.endsWith('_output');
  };
  const isTrailingCallOrReasoning = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object') return false;
    if (isResponsesToolCall(raw)) return true;
    const t = (raw as { type?: unknown }).type;
    return t === 'reasoning' || (typeof t === 'string' && t.endsWith('_call'));
  };
  let roundIdx = inputItems.length - 1;
  while (roundIdx >= 0 && isTrailingOutput(inputItems[roundIdx])) {
    roundIdx--;
  }
  const trailingOutputCount = inputItems.length - 1 - roundIdx;
  if (trailingOutputCount > 0) {
    while (roundIdx >= 0 && isTrailingCallOrReasoning(inputItems[roundIdx])) {
      roundIdx--;
    }
  }
  const cutoffL1 =
    trailingOutputCount > 0 ? roundIdx + 1 : Math.max(0, inputItems.length - 2);
  const toolNameById = new Map<string, string>();
  for (const rawItem of inputItems) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const callItem = rawItem as { type?: unknown; name?: unknown; call_id?: unknown; id?: unknown };
    if (
      (callItem.type === 'function_call' || callItem.type === 'custom_tool_call') &&
      typeof callItem.name === 'string'
    ) {
      if (typeof callItem.call_id === 'string' && callItem.call_id) {
        toolNameById.set(callItem.call_id, callItem.name);
      }
      if (typeof callItem.id === 'string' && callItem.id) {
        toolNameById.set(callItem.id, callItem.name);
      }
    }
  }

  for (let i = 0; i < inputItems.length; i++) {
    const rawItem = inputItems[i];
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as { type?: unknown; output?: unknown; call_id?: unknown };
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') continue;
    if (typeof item.output !== 'string') continue;
    const rawText = item.output;
    if (rawText.length < HYBRID_TOOL_OPTICAL_MIN_CHARS) continue;
    if (
      rawText.startsWith('[fiche ') ||
      rawText.startsWith('[folded into ') ||
      rawText.startsWith('[inkling ')
    ) {
      continue;
    }

    const callIdStr = typeof item.call_id === 'string' && item.call_id ? item.call_id : '';
    const toolName = callIdStr ? toolNameById.get(callIdStr) : undefined;
    const origIdx = Math.max(0, i - rawIndexOffset);
    const baseRef = callIdStr || `out_${origIdx}`;
    const sealKey = buildOpticalToolSealKey(baseRef, rawText);
    const alreadySealed = Boolean(sessionKey && hasStage2SealKey(sessionKey, sealKey));
    if (!alreadySealed) {
      if (breakerState === 'open') continue;
      if (breakerState === 'half_open' && i < cutoffL1) continue;
    }
    // Protect recent live-tail file reads from imaging so Edit/apply_patch string anchors stay exact.
    if (!alreadySealed && i >= cutoffL1 && isFileReadToolName(toolName)) {
      continue;
    }

    const existingImages = (info.responsesComposition?.imageParts ?? 0) + info.imageCount;
    const capRem = profile.providerImageCap !== undefined
      ? Math.max(0, profile.providerImageCap - existingImages)
      : HYBRID_TOOL_OPTICAL_MAX_IMAGES;
    const remBudget = Math.min(HYBRID_TOOL_OPTICAL_MAX_IMAGES - addedImagesCount, capRem);
    if (remBudget <= 0) break;

    const compacted = compactSlabWhitespace(rawText);
    const renderedText = prepareImagedRenderText(
      `=== RENDERED TOOL OUTPUT ===${reflowNote}\n${compacted}`,
      o.reflow,
    );
    let cols = Math.min(
      shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font),
      profile.stripCols,
    );
    if (o.reflow) {
      cols = resolveSinglePagePatchCols(renderedText, cols, profile.style, profile.maxHeightPx, profile);
    }
    const factSheet = factSheetText(rawText, profile.factSheetFormat);
    const endMarker = '[End of rendered tool output.]';
    const nativeOverhead = gptTextTokens(factSheet) + gptTextTokens(endMarker);
    const rawTokens = gptTextTokens(rawText) || Math.ceil(rawText.length / Math.max(1, o.charsPerToken));
    const gate = evalOpenAIGate(req.model, renderedText, cols, o.charsPerToken, rawTokens);
    if (!(gate.imageTokens + nativeOverhead < gate.textTokens * 0.7)) continue;

    const imgs = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
    if (imgs.length === 0 || imgs.length > remBudget) continue;
    const imgTok = gptImageTokens(req.model, imgs);
    if (!(imgTok + nativeOverhead < rawTokens * 0.7)) continue;

    const estAddedBytes = imgs.reduce((s, img) => s + Math.ceil((img.png.length * 4) / 3) + 128, 0);
    if (maxSerialized !== undefined && addedBase64Bytes + estAddedBytes > maxSerialized * 0.75) {
      continue;
    }

    const acc = accumulateRenderedImages(imgs, info);
    if (droppedCodepoints) {
      for (const [cp, n] of acc.droppedCodepoints) {
        droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
      }
    }
    const imgPartsResp: ResponsesInputImagePart[] = imgs.map((img) => responsesImagePart(img, req.model));
    const outParts: ResponsesContentPart[] = [...imgPartsResp];
    if (factSheet) outParts.push({ type: 'input_text', text: factSheet });
    outParts.push({ type: 'input_text', text: endMarker });
    item.output = outParts;
    if (sessionKey) recordStage2SealKey(sessionKey, sealKey);

    info.imageCount += imgs.length;
    info.imageTokens = (info.imageTokens ?? 0) + imgTok;
    info.baselineImagedTokens = (info.baselineImagedTokens ?? 0) + rawTokens;
    info.nativeInjectedTokens = (info.nativeInjectedTokens ?? 0) + nativeOverhead;
    info.compressedChars += rawText.length;
    (info.imagePngs ??= []).push(...imgs.map((img) => img.png));
    (info.imageDims ??= []).push(...imgs.map((img) => ({ width: img.width, height: img.height })));
    const sourceSlice = renderedText.slice(0, 65_536);
    (info.imageSourceTexts ??= []).push(...imgs.map(() => sourceSlice));
    if (!info.firstImagePng) {
      info.firstImagePng = imgs[0]!.png;
      info.firstImageWidth = imgs[0]!.width;
      info.firstImageHeight = imgs[0]!.height;
      info.imageSourceText = sourceSlice;
    }
    addedImagesCount += imgs.length;
    addedBase64Bytes += estAddedBytes;
    changed = true;
  }

  if (changed) {
    const stages = info.textHygieneStages ? [...info.textHygieneStages] : [];
    if (!stages.includes('hybrid_tool_optical')) stages.push('hybrid_tool_optical');
    info.textHygieneStages = stages;
    if (droppedCodepoints && droppedCodepoints.size > 0) {
      const top = droppedCodepointsTop(droppedCodepoints);
      if (top) info.droppedCodepointsTop = top;
    }
  }
  return changed;
}

async function compressResponsesLargeUserContextOptically(
  req: ResponsesRequest,
  inputItems: Array<ResponsesInputItem | Record<string, unknown>>,
  info: TransformInfo,
  o: OpenAIResolvedOptions,
  profile: GptModelProfile,
  droppedCodepoints?: Map<number, number>,
  breakerState: 'closed' | 'open' | 'half_open' = 'closed',
): Promise<boolean> {
  if (breakerState === 'open') return false;
  let lastUserIdx = -1;
  for (let idx = inputItems.length - 1; idx >= 0; idx--) {
    const it = inputItems[idx];
    if (it && typeof it === 'object' && (it as { role?: unknown }).role === 'user') {
      lastUserIdx = idx;
      break;
    }
  }
  let addedImagesCount = 0;
  let addedBase64Bytes = 0;
  let changed = false;
  const maxSerialized = profile.maxSerializedRequestBytes;
  const reflowNote = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const maxCols = o.cols ?? profile.stripCols;

  const tryCompressUserText = async (rawText: string): Promise<ResponsesContentPart[] | undefined> => {
    if (rawText.length < LARGE_USER_OPTICAL_MIN_CHARS) return undefined;
    if (rawText.includes('[fiche ') || rawText.includes('[End of rendered')) return undefined;

    const existingImages = (info.responsesComposition?.imageParts ?? 0) + info.imageCount;
    const capRem = profile.providerImageCap !== undefined
      ? Math.max(0, profile.providerImageCap - existingImages)
      : LARGE_USER_OPTICAL_MAX_IMAGES;
    const remBudget = Math.min(LARGE_USER_OPTICAL_MAX_IMAGES - addedImagesCount, capRem);
    if (remBudget <= 0) return undefined;

    const nlHead = rawText.lastIndexOf('\n', USER_HEAD_KEEP_CHARS);
    const headCut = nlHead >= 400 ? nlHead + 1 : USER_HEAD_KEEP_CHARS;
    const nlTail = rawText.indexOf('\n', Math.max(headCut, rawText.length - USER_TAIL_KEEP_CHARS));
    const tailCut =
      nlTail >= headCut && rawText.length - nlTail >= 500
        ? nlTail
        : rawText.length - USER_TAIL_KEEP_CHARS;
    const head = rawText.slice(0, headCut);
    const middle = rawText.slice(headCut, tailCut);
    const tail = rawText.slice(tailCut);
    if (middle.length < 16_000) return undefined;

    const compacted = compactSlabWhitespace(middle);
    const renderedText = prepareImagedRenderText(
      `=== RENDERED USER CONTEXT ===${reflowNote}\n${compacted}`,
      o.reflow,
    );
    let cols = Math.min(
      shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font),
      profile.stripCols,
    );
    if (o.reflow) {
      cols = resolveSinglePagePatchCols(renderedText, cols, profile.style, profile.maxHeightPx, profile);
    }
    const factSheet = factSheetText(middle, profile.factSheetFormat);
    const endMarker = '[End of rendered user context.]';
    const nativeOverhead = gptTextTokens(factSheet) + gptTextTokens(endMarker);
    const middleTokens = gptTextTokens(middle) || Math.ceil(middle.length / Math.max(1, o.charsPerToken));
    const gate = evalOpenAIGate(req.model, renderedText, cols, o.charsPerToken, middleTokens);
    if (!(gate.imageTokens + nativeOverhead < gate.textTokens * 0.65)) return undefined;

    const imgs = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
    if (imgs.length === 0 || imgs.length > remBudget) return undefined;
    const imgTok = gptImageTokens(req.model, imgs);
    if (!(imgTok + nativeOverhead < middleTokens * 0.65)) return undefined;

    const estAddedBytes = imgs.reduce((s, img) => s + Math.ceil((img.png.length * 4) / 3) + 128, 0);
    if (maxSerialized !== undefined && addedBase64Bytes + estAddedBytes > maxSerialized * 0.75) {
      return undefined;
    }

    const acc = accumulateRenderedImages(imgs, info);
    if (droppedCodepoints) {
      for (const [cp, n] of acc.droppedCodepoints) {
        droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
      }
    }
    const imgPartsResp: ResponsesInputImagePart[] = imgs.map((img) => responsesImagePart(img, req.model));
    const replacement: ResponsesContentPart[] = [];
    if (head) replacement.push({ type: 'input_text', text: head });
    replacement.push(...imgPartsResp);
    if (factSheet) replacement.push({ type: 'input_text', text: factSheet });
    replacement.push({ type: 'input_text', text: endMarker });
    if (tail) replacement.push({ type: 'input_text', text: tail });

    info.imageCount += imgs.length;
    info.imageTokens = (info.imageTokens ?? 0) + imgTok;
    info.baselineImagedTokens = (info.baselineImagedTokens ?? 0) + middleTokens;
    info.nativeInjectedTokens = (info.nativeInjectedTokens ?? 0) + nativeOverhead;
    info.compressedChars += middle.length;
    (info.imagePngs ??= []).push(...imgs.map((img) => img.png));
    (info.imageDims ??= []).push(...imgs.map((img) => ({ width: img.width, height: img.height })));
    const sourceSlice = renderedText.slice(0, 65_536);
    (info.imageSourceTexts ??= []).push(...imgs.map(() => sourceSlice));
    if (!info.firstImagePng) {
      info.firstImagePng = imgs[0]!.png;
      info.firstImageWidth = imgs[0]!.width;
      info.firstImageHeight = imgs[0]!.height;
      info.imageSourceText = sourceSlice;
    }
    addedImagesCount += imgs.length;
    addedBase64Bytes += estAddedBytes;
    changed = true;
    return replacement;
  };

  for (let itemIdx = 0; itemIdx < inputItems.length; itemIdx++) {
    const rawItem = inputItems[itemIdx];
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as { role?: unknown; content?: unknown };
    if (item.role !== 'user') continue;
    if (breakerState === 'half_open' && itemIdx < lastUserIdx) continue;
    if (Array.isArray(item.content)) {
      const isInsertedSlab = item.content.some(
        (p) =>
          p &&
          typeof p === 'object' &&
          (p as { text?: unknown }).text === '[End of rendered GPT system/tool context.]',
      );
      if (isInsertedSlab) continue;
      const nextContent: ResponsesContentPart[] = [];
      let itemChanged = false;
      for (const part of item.content as ResponsesContentPart[]) {
        if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'input_text') {
          const textVal = (part as { text?: unknown }).text;
          if (typeof textVal === 'string') {
            const expanded = await tryCompressUserText(textVal);
            if (expanded) {
              nextContent.push(...expanded);
              itemChanged = true;
              continue;
            }
          }
        }
        nextContent.push(part);
      }
      if (itemChanged) item.content = nextContent;
    } else if (typeof item.content === 'string') {
      const expanded = await tryCompressUserText(item.content);
      if (expanded) item.content = expanded;
    }
  }

  if (changed) {
    const stages = info.textHygieneStages ? [...info.textHygieneStages] : [];
    if (!stages.includes('hybrid_user_optical')) stages.push('hybrid_user_optical');
    info.textHygieneStages = stages;
    if (droppedCodepoints && droppedCodepoints.size > 0) {
      const top = droppedCodepointsTop(droppedCodepoints);
      if (top) info.droppedCodepointsTop = top;
    }
  }
  return changed;
}

export const CHAT_HEADER =
  '================= RENDERED GPT SYSTEM + TOOL CONTEXT =================\n' +
  'These images were injected by fiche, not by the end user. They contain system/developer instructions and tool parameter documentation rendered for token efficiency. Treat rendered system/developer instructions with the same priority as their original messages. OCR carefully and treat the rendered content as authoritative. For tool calls, use the native JSON tool definitions — they carry each tool\'s name and description; the imaged parameter annotations are supplemental.' +
  '\n====================== BEGIN RENDERED CONTEXT ======================\n';

export const RESPONSES_HEADER =
  '================= RENDERED GPT SYSTEM + TOOL CONTEXT =================\n' +
  'These images were injected by fiche, not by the end user. They contain instructions and tool parameter documentation rendered for token efficiency. Treat rendered instructions with the same priority as the originals. OCR carefully and treat the rendered content as authoritative. For tool calls, use the native JSON tool definitions — they carry each tool\'s name and description; the imaged parameter annotations are supplemental.' +
  '\n====================== BEGIN RENDERED CONTEXT ======================\n';

const CHAT_POINTER =
  'The full instructions for this message were rendered into image(s) attached to the first user message by fiche. Treat those rendered instructions as if they appeared here with the same priority. Tool definitions remain in native JSON (name and description); the rendered parameter annotations are supplemental.';

const RESPONSES_POINTER =
  'The full instructions were rendered into image(s) attached to the first user message by fiche. Treat them with the same priority. Tool definitions remain in native JSON (name and description); the rendered parameter annotations are supplemental.';

function countOpenAINativeImageBytes(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  const scanParts = (parts: unknown) => {
    if (!Array.isArray(parts)) return;
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      const rec = p as Record<string, unknown>;
      const imgUrl = rec.image_url;
      if (typeof imgUrl === 'string' && imgUrl.startsWith('data:image/')) {
        total += imgUrl.length;
      } else if (imgUrl && typeof imgUrl === 'object') {
        const u = (imgUrl as { url?: unknown }).url;
        if (typeof u === 'string' && u.startsWith('data:image/')) total += u.length;
      }
    }
  };
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    scanParts(rec.content);
    scanParts(rec.output);
  }
  return total;
}

export async function transformOpenAIChatCompletions(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const o = resolveOptions(opts);
  const info = emptyInfo();
  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: OpenAIChatRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }
  if (!Array.isArray(req.messages)) {
    info.reason = 'parse_error: messages must be an array';
    return { body, info };
  }
  // The element itself is read unguarded from here down (`m.role` just below,
  // then contentText/setTextContent/history collapse), so a non-object element
  // threw out of the transform and the proxy answered 502 for a body the
  // upstream would have rejected with its own 400. Same bail-out as above.
  if (req.messages.some((m) => !m || typeof m !== 'object')) {
    info.reason = 'invalid_messages';
    return { body, info };
  }
  const profile = resolveGptProfile(req.model);
  const pinChars = relocateOpenAIPins(req);
  if (pinChars > 0) info.pinChars = pinChars;
  const chatNativeImageBytes = countOpenAINativeImageBytes(req.messages);

  const effectiveImageCompress = o.imageCompress && o.stageToggles?.optical !== false;
  const textHygieneActive = isTextHygieneActive(o.textHygiene);
  const estTextPromptTokensChat = Math.ceil(
    Math.max(0, body.byteLength - chatNativeImageBytes) / Math.max(1, o.charsPerToken),
  );
  const earlyFirstUser = firstUserText(req);
  const chatSessionKey = await applyClientSessionIdentity(info, earlyFirstUser, o);
  const sessionState = chatSessionKey
    ? noteHistoryRequest(chatSessionKey, { model: req.model })
    : { cold: false, minFreezeStep: 0 };
  const opticalHistoryPolicy = effectiveImageCompress
    ? resolveOpticalHistoryPolicy({
        opticalMode: o.opticalMode,
        collapseHistory: opts.collapseHistory === true ? true : undefined,
        model: req.model,
        estPromptTokens: estTextPromptTokensChat,
        textHygieneActive,
        sessionKey: chatSessionKey,
        sessionCold: sessionState.cold,
      })
    : 'full';
  const hybridTextMmu = effectiveImageCompress && opticalHistoryPolicy === 'hybrid';
  const chatBreakerState = chatSessionKey
    ? getCacheCircuitBreakerState(chatSessionKey, req.model ? { model: req.model } : undefined)
    : 'closed';
  const hygieneStats = textHygieneActive
    ? applyOpenAIChatTextHygiene(req, {
        foldLogs: !effectiveImageCompress || hybridTextMmu,
        deepTextCompact: !effectiveImageCompress || hybridTextMmu,
        cleanUserPayloads: o.cleanUserPayloads,
        enableTscg: !effectiveImageCompress ? o.stageToggles?.tscg : false,
        enableToon: o.stageToggles?.toon,
        enableAcdc: o.stageToggles?.acdc,
        enableCasi: (!effectiveImageCompress || hybridTextMmu) && o.stageToggles?.casi !== false,
        enableLsm: o.stageToggles?.lsm,
        enableMmu: o.stageToggles?.mmu,
        enableSkillLinker: !effectiveImageCompress ? o.stageToggles?.skillLinker : false,
        aggressiveToon: resolveTextHygieneMode(o.textHygiene) === 'on',
        model: req.model,
        expectedOutputTokens: o.expectedOutputTokens,
        rawBodyBytes: body.byteLength,
        nativeImageBytes: chatNativeImageBytes,
        sessionKey: chatSessionKey,
        firstUserText: earlyFirstUser,
        sessionCacheCold: sessionState.cold,
        circuitBreakerState: chatBreakerState,
        liveTailTexts: (!effectiveImageCompress || hybridTextMmu) ? extractChatLiveTailTexts(req.messages) : undefined,
        appendTailHydration: (!effectiveImageCompress || hybridTextMmu) ? (blk) => appendChatTailHydration(req, blk) : undefined,
      })
    : undefined;
  let hygieneChanged = Boolean(hygieneStats?.changed);
  let hygieneTailHydrated = Boolean(hygieneStats?.tailHydrated);
  if (hygieneStats?.changed || hygieneStats?.tailHydrated) {
    info.textHygieneSavedChars = hygieneStats.savedChars;
    info.textHygieneSavedTokens = hygieneStats.savedTokens;
    info.textHygieneBlocks = hygieneStats.blocks;
    info.textHygieneStages = [...hygieneStats.stages];
    if (hygieneStats.cliffAvoided) info.cliffAvoided = hygieneStats.cliffAvoided;
  }
  let cachedPinBodyChat: Uint8Array | undefined;
  let cachedPinOutgoingChat: number | undefined;
  const getPinBody = (): Uint8Array => {
    if (cachedPinBodyChat) return cachedPinBodyChat;
    if (pinChars > 0 || hygieneChanged || hygieneTailHydrated) {
      cachedPinOutgoingChat = countOutgoingTextChars(req);
      cachedPinBodyChat = new TextEncoder().encode(JSON.stringify(req));
    } else {
      cachedPinBodyChat = body;
    }
    return cachedPinBodyChat;
  };
  const runFallbackChatStaticHygiene = (
    targetReq: OpenAIChatRequest = req,
    targetInfo: TransformInfo = info,
  ): boolean => {
    if (!textHygieneActive || !effectiveImageCompress) return false;
    const fb = applyOpenAIChatTextHygiene(targetReq, {
      foldLogs: false,
      deepTextCompact: true,
      cleanUserPayloads: false,
      enableTscg: o.stageToggles?.tscg,
      enableToon: false,
      enableAcdc: false,
      enableCasi: false,
      enableLsm: false,
      enableMmu: o.stageToggles?.mmu,
      enableSkillLinker: o.stageToggles?.skillLinker,
      enableJsonUnwrap: false,
      enableDensityPrune: false,
      aggressiveToon: resolveTextHygieneMode(o.textHygiene) === 'on',
      model: targetReq.model,
      expectedOutputTokens: o.expectedOutputTokens,
      rawBodyBytes: body.byteLength,
      nativeImageBytes: chatNativeImageBytes,
      sessionKey: chatSessionKey,
      firstUserText: earlyFirstUser,
      sessionCacheCold: sessionState.cold,
      circuitBreakerState: chatBreakerState,
    });
    if (!fb.changed) return false;
    if (targetReq === req) {
      hygieneChanged = true;
      cachedPinBodyChat = undefined;
      cachedPinOutgoingChat = undefined;
    }
    targetInfo.textHygieneSavedChars = (targetInfo.textHygieneSavedChars ?? 0) + fb.savedChars;
    targetInfo.textHygieneSavedTokens = (targetInfo.textHygieneSavedTokens ?? 0) + fb.savedTokens;
    targetInfo.textHygieneBlocks = (targetInfo.textHygieneBlocks ?? 0) + fb.blocks;
    targetInfo.textHygieneStages = [...new Set([...(targetInfo.textHygieneStages ?? []), ...fb.stages])];
    if (!targetInfo.cliffAvoided && fb.cliffAvoided) targetInfo.cliffAvoided = fb.cliffAvoided;
    return true;
  };
  if (profile.maxSerializedRequestBytes !== undefined && (pinChars > 0 || hygieneChanged || hygieneTailHydrated)) {
    getPinBody();
  }
  if (!effectiveImageCompress) {
    if (hygieneChanged) {
      info.compressed = true;
      info.reason = 'text_hygiene';
      info.outgoingTextChars = countOutgoingTextChars(req);
      return { body: getPinBody(), info };
    }
    if (hygieneTailHydrated) {
      info.reason = 'mmu_hydrate';
      info.outgoingTextChars = countOutgoingTextChars(req);
      return { body: getPinBody(), info };
    }
    info.reason = 'image_disabled';
    if (pinChars > 0) info.outgoingTextChars = countOutgoingTextChars(req);
    return { body: getPinBody(), info };
  }

  const firstUserIdx = req.messages.findIndex((m) => m.role === 'user');
  if (firstUserIdx < 0) {
    runFallbackChatStaticHygiene();
    if (hygieneChanged) {
      info.compressed = true;
      info.reason = 'text_hygiene';
      info.outgoingTextChars = countOutgoingTextChars(req);
    } else {
      info.reason = 'no_user_message';
    }
    return { body: getPinBody(), info };
  }

  const estPromptTokensChat = Math.ceil(body.byteLength / Math.max(1, o.charsPerToken));
  if (priceMode() === 'kosha' && gateRatesFor(req.model, { promptTokens: estPromptTokensChat }) === null) {
    runFallbackChatStaticHygiene();
    info.reason = hygieneChanged ? 'text_hygiene' : 'unpriced_model';
    if (hygieneChanged) {
      if (!info.firstUserSha8 || !info.sessionKey) {
        await applyClientSessionIdentity(info, firstUserText(req), o);
      }
      info.compressed = true;
      info.outgoingTextChars = countOutgoingTextChars(req);
    }
    return { body: getPinBody(), info };
  }

  const authorityDocs: string[] = [];
  const systemTexts: string[] = [];
  interface ChatLeadingSplit {
    readonly index: number;
    readonly msg: OpenAIChatMessage;
    readonly staticText: string;
    readonly dynamicText: string;
  }
  const chatLeadingSplits = new Map<number, ChatLeadingSplit>();
  const chatRelocatedVolatileMsgs: OpenAIChatMessage[] = [];
  // Leading system/developer messages only; split volatile XML islands after the slab.
  for (let idx = 0; idx < firstUserIdx; idx++) {
    const msg = req.messages[idx]!;
    if (msg.role !== 'system' && msg.role !== 'developer') continue;
    const text = contentText(msg.content);
    if (!text) continue;
    const split = splitLeadingOpenAIAuthorityText(text);
    chatLeadingSplits.set(idx, {
      index: idx,
      msg,
      staticText: split.staticText,
      dynamicText: split.dynamicText,
    });
    if (split.dynamicText) {
      info.dynamicChars += split.dynamicText.length;
      info.dynamicBlockCount += Math.max(1, split.blockCount);
      chatRelocatedVolatileMsgs.push({
        role: msg.role,
        content: Array.isArray(msg.content) ? [{ type: 'text', text: split.dynamicText }] : split.dynamicText,
      });
    }
    if (split.staticText) {
      authorityDocs.push(`## ${String(msg.role).toUpperCase()} MESSAGE\n${split.staticText}`);
      systemTexts.push(split.staticText);
      info.staticChars += split.staticText.length;
    }
  }

  const { tools: rewrittenTools, docs: toolDocs } = o.compressTools
    ? rewriteToolsForGpt(req.tools)
    : { tools: req.tools, docs: '' };

  const combinedRaw = [...authorityDocs, toolDocs].filter((s) => s.length > 0).join('\n\n');
  info.origChars = combinedRaw.length;
  const finishSerializedChat = () => {
    const encoded = new TextEncoder().encode(JSON.stringify(req));
    const serializedByteLimit = profile.maxSerializedRequestBytes;
    if (serializedByteLimit !== undefined && encoded.byteLength > serializedByteLimit) {
      clearImageStatsForLimit(info);
      info.reason = 'serialized_request_limit';
      if (body.byteLength > serializedByteLimit) {
        info.compressed = false;
        info.serializedRequestBytes = encoded.byteLength;
        info.sizeLimitOutcome = 'rejected';
        return { body, info };
      }
      const pinBody = getPinBody();
      const usePinBody = pinBody.byteLength <= serializedByteLimit;
      const outBody = usePinBody ? pinBody : body;
      info.compressed = usePinBody && hygieneChanged;
      info.sizeLimitOutcome = 'fallback';
      if (usePinBody && cachedPinOutgoingChat !== undefined) {
        info.outgoingTextChars = cachedPinOutgoingChat;
      }
      return { body: outBody, info };
    }
    info.outgoingTextChars = countOutgoingTextChars(req);
    info.compressed = true;
    return { body: encoded, info };
  };
  const finishHistoryOnly = async (reason: string) => {
    runFallbackChatStaticHygiene();
    if (profile.maxSerializedRequestBytes !== undefined) {
      getPinBody();
    }
    info.reason = reason;
    if (o.collapseHistory && !hybridTextMmu) {
      if (chatBreakerState !== 'closed') {
        info.historyReason ??= 'circuit_breaker';
      } else if (await applyChatHistoryCollapse(
        req, info, o, profile, firstUserIdx + 1, estPromptTokensChat,
      )) {
        info.reason = undefined;
        return finishSerializedChat();
      }
    }
    if (hygieneChanged) {
      info.compressed = true;
      info.reason = 'text_hygiene';
      info.outgoingTextChars = countOutgoingTextChars(req);
    } else if (hygieneTailHydrated) {
      info.reason = 'mmu_hydrate';
      info.outgoingTextChars = countOutgoingTextChars(req);
    }
    return { body: getPinBody(), info };
  };
  if (!combinedRaw) {
    return finishHistoryOnly('no_static_context');
  }

  if (!info.firstUserSha8 || !info.sessionKey) {
    await applyClientSessionIdentity(info, firstUserText(req), o);
  }

  const combined = compactSlabWhitespace(combinedRaw).trimEnd();
  const minCompressTokens = profile.minCompressTokens;
  const combinedTokens = minCompressTokens === undefined ? undefined : gptTextTokens(combined);
  if (minCompressTokens !== undefined && combinedTokens! < minCompressTokens) {
    return finishHistoryOnly(`below_min_tokens (${combinedTokens} < ${minCompressTokens})`);
  }
  if (minCompressTokens === undefined && combined.length < o.minCompressChars) {
    return finishHistoryOnly(`below_min_chars (${combined.length} < ${o.minCompressChars})`);
  }

  const reflowNote = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const header = CHAT_HEADER.replace('\n====', reflowNote + '\n====');
  const renderedText = prepareImagedRenderText(header + combined, o.reflow);
  const maxCols = o.cols ?? profile.stripCols;
  let cols = Math.min(
    shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font),
    profile.stripCols,
  );
  if (o.reflow) {
    cols = resolveSinglePagePatchCols(renderedText, cols, profile.style, profile.maxHeightPx, profile);
  }

  const slabFactSheetPreview = factSheetText(combinedRaw, profile.factSheetFormat);
  const slabNativeOverhead = systemTexts.length * gptTextTokens(CHAT_POINTER)
    + gptTextTokens('[End of rendered GPT system/tool context.]')
    + gptTextTokens(slabFactSheetPreview);
  const staticBaselineTokens = gptBaselineImagedTokens(systemTexts, req.tools, rewrittenTools);
  const gate = evalOpenAIGate(
    req.model,
    renderedText,
    cols,
    o.charsPerToken,
    opts.charsPerToken === undefined && usesExactStaticBaseline(req.model)
      ? staticBaselineTokens
      : undefined,
  );
  const actualSlabTokensChat = gate.imageTokens + (profile.exactStaticBaseline ? slabNativeOverhead : 0);
  let slabProfitable = actualSlabTokensChat < gate.textTokens;
  const tailTokChat = req.messages.length > 0 ? gptTextTokens(JSON.stringify(req.messages[req.messages.length - 1])) : 0;
  const promptBeforeChat = Math.max(gate.textTokens, estPromptTokensChat);
  const slabCliffHitChat = evalAndRecordOpenAICliff(
    req.model,
    info,
    `${req.model}\0${info.sessionKey ?? info.firstUserSha8 ?? ''}\0chat_slab`,
    {
      promptTokensBefore: promptBeforeChat,
      collapsedBaselineTokens: gate.textTokens,
      collapsedActualTokens: actualSlabTokensChat,
      downstreamCachedTokens: Math.max(0, promptBeforeChat - gate.textTokens - tailTokChat),
      expectedOutputTokens: o.expectedOutputTokens,
    },
  );
  if (!slabProfitable && slabCliffHitChat) {
    slabProfitable = true;
  }
  info.gateEval = {
    site: 'slab',
    imageTokens: gate.imageTokens,
    textTokens: gate.textTokens,
    burnImageSide: 0,
    burnTextSide: 0,
    profitable: slabProfitable,
  };
  if (!slabProfitable) {
    info.passthroughReasons = { not_profitable: 1 };
    return finishHistoryOnly(`not_profitable (slab=${combined.length} chars)`);
  }

  const images = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
  if (images.length === 0) {
    runFallbackChatStaticHygiene();
    info.reason = hygieneChanged ? 'text_hygiene' : 'render_empty';
    if (hygieneChanged) {
      info.compressed = true;
      info.outgoingTextChars = countOutgoingTextChars(req);
    }
    return { body: getPinBody(), info };
  }

  // A hard provider cap makes static-first allocation pathological on long Qwen
  // chats: the repeated system slab consumes slots that could replace much more
  // history. Plan against the full cap first and keep static text native when the
  // two image sets cannot coexist.
  if (o.collapseHistory && !hybridTextMmu && chatBreakerState === 'closed' && profile.providerImageCap !== undefined) {
    const historyReq = structuredClone(req);
    const historyInfo = structuredClone(info);
    if (await applyChatHistoryCollapse(
      historyReq, historyInfo, o, profile, firstUserIdx + 1, estPromptTokensChat,
    ) && countRequestImages(historyReq.messages) + images.length > profile.providerImageCap) {
      runFallbackChatStaticHygiene(historyReq, historyInfo);
      historyInfo.outgoingTextChars = countOutgoingTextChars(historyReq);
      historyInfo.compressed = true;
      return { body: new TextEncoder().encode(JSON.stringify(historyReq)), info: historyInfo };
    }
  }
  if (profile.providerImageCap !== undefined &&
      countRequestImages(req.messages) + images.length > profile.providerImageCap) {
    runFallbackChatStaticHygiene();
    info.reason = hygieneChanged ? 'text_hygiene' : 'provider_image_cap';
    if (hygieneChanged) {
      info.compressed = true;
      info.outgoingTextChars = countOutgoingTextChars(req);
    }
    return { body: getPinBody(), info };
  }

  const { droppedCodepoints } = accumulateRenderedImages(images, info);
  const topDropped = droppedCodepointsTop(droppedCodepoints);
  if (topDropped) info.droppedCodepointsTop = topDropped;

  const imageParts: OpenAIImagePart[] = images.map((img) => openAIImagePart(img, req.model));
  info.imageCount = images.length;
  // GPT savings basis: vision tokens the images actually cost vs the text tokens
  // the same content would have cost unproxied. req.tools is still the original
  // (reassigned to the stripped set below). See src/core/openai-savings.ts.
  info.imageTokens = gptImageTokens(req.model, images);
  info.baselineImagedTokens = staticBaselineTokens;
  info.compressedChars = combinedRaw.length;
  info.bucketChars = { static_slab: combinedRaw.length };
  info.systemSha8 = await sha8(combined);
  info.firstImagePng = images[0]!.png;
  info.firstImageWidth = images[0]!.width;
  info.firstImageHeight = images[0]!.height;
  info.imagePngs = images.map((img) => img.png);
  info.imageDims = images.map((img) => ({ width: img.width, height: img.height }));
  // One slab render may page into multiple PNGs; each page links to the same
  // rendered source. History sources are appended later by foldGptHistory.
  info.imageSourceText = renderedText.slice(0, 65_536);
  info.imageSourceTexts = images.map(() => info.imageSourceText);

  // Verbatim fact-sheet: precision-critical tokens (paths, ids, versions, flags)
  // pulled from the pre-image text so exact strings survive OCR loss. Deterministic
  // → stays inside the cached prefix. See src/core/factsheet.ts.
  const slabFactSheet = slabFactSheetPreview;
  info.nativeInjectedTokens = slabNativeOverhead;
  const slabUserMsg: OpenAIChatMessage = {
    role: 'user',
    content: [
      ...imageParts,
      ...(slabFactSheet ? [{ type: 'text', text: slabFactSheet } as OpenAIContentPart] : []),
      { type: 'text', text: '[End of rendered GPT system/tool context.]' },
    ],
  };
  const chatStaticLeadingMsgs: OpenAIChatMessage[] = [];
  for (let idx = 0; idx < firstUserIdx; idx++) {
    const msg = req.messages[idx]!;
    const split = chatLeadingSplits.get(idx);
    if (!split) {
      chatStaticLeadingMsgs.push(msg);
      continue;
    }
    if (!split.staticText) {
      // Wholly volatile leading system/developer message relocated after the slab.
      continue;
    }
    setTextContent(msg, CHAT_POINTER);
    chatStaticLeadingMsgs.push(msg);
  }
  req.messages = [
    ...chatStaticLeadingMsgs,
    slabUserMsg,
    ...chatRelocatedVolatileMsgs,
    ...req.messages.slice(firstUserIdx),
  ];

  // Collapse the OLD conversation prefix into history image(s). The inserted slab
  // item (and any relocated volatile authority messages) are protected; the original
  // opening user prompt remains collapsible history instead of looking like the live request.
  if (o.collapseHistory && !hybridTextMmu) {
    if (chatBreakerState !== 'closed') {
      info.historyReason ??= 'circuit_breaker';
    } else {
      await applyChatHistoryCollapse(
        req,
        info,
        o,
        profile,
        chatStaticLeadingMsgs.length + 1 + chatRelocatedVolatileMsgs.length,
        estPromptTokensChat,
        combinedRaw,
      );
    }
  }

  if (rewrittenTools !== undefined) req.tools = rewrittenTools;
  if (hybridTextMmu && info.imageCount > 0) {
    info.reason = 'hybrid_slab_optical';
    const stages = info.textHygieneStages ? [...info.textHygieneStages] : [];
    if (!stages.includes('hybrid_slab_optical')) stages.push('hybrid_slab_optical');
    info.textHygieneStages = stages;
  }
  return finishSerializedChat();
}

const CODEX_ENV_CONTEXT_RE = /<environment_context>[\s\S]*?<\/environment_context>/g;
const EXTRA_VOLATILE_XML_TAGS = [
  ...new Set([
    ...VOLATILE_XML_TAGS,
    'environment_context',
    'cc_automode_session_rules',
    'cc_automode_permissions',
  ]),
].filter((t) => /^[a-zA-Z0-9_-]+$/.test(t));
const CANONICAL_VOLATILE_XML_RE = EXTRA_VOLATILE_XML_TAGS.length > 0
  ? new RegExp(`<(${EXTRA_VOLATILE_XML_TAGS.join('|')})(\\s[^>]*)?>[\\s\\S]*?</\\1>`, 'gi')
  : null;

export function splitLeadingOpenAIAuthorityText(text: string): {
  staticText: string;
  dynamicText: string;
  blockCount: number;
} {
  if (!text) return { staticText: '', dynamicText: '', blockCount: 0 };
  const base = splitStaticDynamic(text);
  const dynamicParts: string[] = base.dynamicText ? [base.dynamicText] : [];
  let blockCount = base.blockCount;

  let rem = base.staticText.replace(CODEX_ENV_CONTEXT_RE, (m) => {
    dynamicParts.push(m);
    blockCount++;
    return '';
  });

  if (CANONICAL_VOLATILE_XML_RE) {
    rem = rem.replace(CANONICAL_VOLATILE_XML_RE, (m) => {
      dynamicParts.push(m);
      blockCount++;
      return '';
    });
  }

  const islands = splitVolatileXmlIslands(rem);
  if (islands.some((isl) => isl.volatile)) {
    const staticIslands: string[] = [];
    for (const isl of islands) {
      if (isl.volatile) {
        dynamicParts.push(isl.text);
        blockCount++;
      } else {
        staticIslands.push(isl.text);
      }
    }
    rem = staticIslands.join('');
  }

  if (blockCount === 0 && dynamicParts.length === 0) {
    return {
      staticText: text,
      dynamicText: '',
      blockCount: 0,
    };
  }

  return {
    staticText: rem.replace(/\n{3,}/g, '\n\n').trim(),
    dynamicText: dynamicParts.join('\n\n').trim(),
    blockCount,
  };
}

function makeRelocatedAuthorityItem(
  sourceItem: ResponsesInputItem,
  dynamicText: string,
): ResponsesInputItem {
  const hadArray = Array.isArray(sourceItem.content);
  const base: Record<string, unknown> = {};
  if (typeof (sourceItem as Record<string, unknown>).type === 'string') {
    base.type = (sourceItem as Record<string, unknown>).type;
  }
  base.role = sourceItem.role;
  base.content = hadArray ? [{ type: 'input_text', text: dynamicText }] : dynamicText;
  return base as unknown as ResponsesInputItem;
}

async function computeResponsesCachePrefixSha8(req: ResponsesRequest): Promise<string | undefined> {
  const input = Array.isArray(req.input) ? req.input : undefined;
  let prefixItems: unknown[] = [];
  if (input && input.length > 0) {
    const slabIdx = input.findIndex((it) => {
      const c = (it as { content?: unknown } | null)?.content;
      return Array.isArray(c) && c.some((p) => (p as { text?: unknown } | null)?.text === '[End of rendered GPT system/tool context.]');
    });
    if (slabIdx >= 0) {
      prefixItems = input.slice(0, slabIdx + 1);
      for (let i = slabIdx + 1; i < input.length; i++) {
        const it = input[i] as { role?: unknown; content?: unknown } | null;
        if (
          it?.role === 'user' &&
          Array.isArray(it.content) &&
          it.content.some((p) => {
            const t = (p as { text?: unknown } | null)?.text;
            return typeof t === 'string' && t.includes('Earlier turns in image(s)');
          })
        ) {
          prefixItems.push(it);
        }
      }
    } else {
      for (const it of input) {
        const r = (it as { role?: unknown } | null)?.role;
        if (r === 'system' || r === 'developer') prefixItems.push(it);
        else break;
      }
    }
  }
  if (
    prefixItems.length === 0 &&
    typeof req.instructions !== 'string' &&
    !Array.isArray(req.tools)
  ) {
    return undefined;
  }
  try {
    return await sha8(
      JSON.stringify({
        instructions: req.instructions ?? null,
        tools: req.tools ?? null,
        prefix: prefixItems,
      }),
    );
  } catch {
    return undefined;
  }
}

export async function transformOpenAIResponses(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const o = resolveOptions(opts);
  const info = emptyInfo();
  if (!o.compress) {
    info.reason = 'compress=false';
    return { body, info };
  }

  let req: ResponsesRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return { body, info };
  }
  const inputWasString = typeof req.input === 'string';
  const originalInputString = inputWasString ? (req.input as string) : undefined;
  let inputItems: Array<ResponsesInputItem | Record<string, unknown>>;
  if (inputWasString) {
    inputItems = [];
  } else if (Array.isArray(req.input)) {
    inputItems = req.input as Array<ResponsesInputItem | Record<string, unknown>>;
  } else {
    info.reason = 'parse_error: input must be a string or array';
    return { body, info };
  }
  if (inputItems.some((item) => !item || typeof item !== 'object')) {
    info.reason = 'invalid_input';
    return { body, info };
  }
  const profile = resolveGptProfile(req.model);
  const pinChars = relocateOpenAIPins(req);
  if (pinChars > 0) info.pinChars = pinChars;
  const respNativeImageBytes = countOpenAINativeImageBytes(req.input);

  const effectiveImageCompress = o.imageCompress && o.stageToggles?.optical !== false;
  const textHygieneActive = isTextHygieneActive(o.textHygiene);
  const estTextPromptTokensResp = Math.ceil(
    Math.max(0, body.byteLength - respNativeImageBytes) / Math.max(1, o.charsPerToken),
  );
  const earlyRespFirstUser = firstResponsesUserText(inputWasString, originalInputString, inputItems);
  const respSessionKey = await applyClientSessionIdentity(info, earlyRespFirstUser, o);
  const sessionState = respSessionKey
    ? noteHistoryRequest(respSessionKey, { model: req.model })
    : { cold: false, minFreezeStep: 0 };
  const opticalHistoryPolicy = effectiveImageCompress
    ? resolveOpticalHistoryPolicy({
        opticalMode: o.opticalMode,
        collapseHistory: opts.collapseHistory === true ? true : undefined,
        model: req.model,
        estPromptTokens: estTextPromptTokensResp,
        textHygieneActive,
        sessionKey: respSessionKey,
        sessionCold: sessionState.cold,
      })
    : 'full';
  const hybridTextMmu = effectiveImageCompress && opticalHistoryPolicy === 'hybrid';
  const respBreakerState = respSessionKey
    ? getCacheCircuitBreakerState(respSessionKey, req.model ? { model: req.model } : undefined)
    : 'closed';
  const hygieneStats = textHygieneActive
    ? applyOpenAIResponsesTextHygiene(req, {
        foldLogs: !effectiveImageCompress || hybridTextMmu,
        deepTextCompact: !effectiveImageCompress || hybridTextMmu,
        cleanUserPayloads: o.cleanUserPayloads,
        enableTscg: !effectiveImageCompress ? o.stageToggles?.tscg : false,
        enableToon: o.stageToggles?.toon,
        enableAcdc: o.stageToggles?.acdc,
        enableCasi: (!effectiveImageCompress || hybridTextMmu) && o.stageToggles?.casi !== false,
        enableLsm: o.stageToggles?.lsm,
        enableMmu: o.stageToggles?.mmu,
        enableSkillLinker: !effectiveImageCompress ? o.stageToggles?.skillLinker : false,
        aggressiveToon: resolveTextHygieneMode(o.textHygiene) === 'on',
        model: req.model,
        expectedOutputTokens: o.expectedOutputTokens,
        rawBodyBytes: body.byteLength,
        nativeImageBytes: respNativeImageBytes,
        sessionKey: respSessionKey,
        firstUserText: earlyRespFirstUser,
        sessionCacheCold: sessionState.cold,
        circuitBreakerState: respBreakerState,
        liveTailTexts: (!effectiveImageCompress || hybridTextMmu)
          ? extractResponsesLiveTailTexts(inputWasString, originalInputString, inputItems)
          : undefined,
        appendTailHydration: (!effectiveImageCompress || hybridTextMmu) ? (blk) => appendResponsesTailHydration(req, blk) : undefined,
      })
    : undefined;
  let hygieneChangedResp = Boolean(hygieneStats?.changed);
  let hygieneTailHydratedResp = Boolean(hygieneStats?.tailHydrated);
  if (hygieneStats?.changed || hygieneStats?.tailHydrated) {
    info.textHygieneSavedChars = hygieneStats.savedChars;
    info.textHygieneSavedTokens = hygieneStats.savedTokens;
    info.textHygieneBlocks = hygieneStats.blocks;
    info.textHygieneStages = [...hygieneStats.stages];
    if (hygieneStats.cliffAvoided) info.cliffAvoided = hygieneStats.cliffAvoided;
  }
  let cachedPinBodyResp: Uint8Array | undefined;
  let cachedPinOutgoingResp: number | undefined;
  const getPinBodyResp = (): Uint8Array => {
    if (cachedPinBodyResp) return cachedPinBodyResp;
    if (pinChars > 0 || hygieneChangedResp || hygieneTailHydratedResp) {
      cachedPinOutgoingResp = countResponsesOutgoingTextChars(req);
      cachedPinBodyResp = new TextEncoder().encode(JSON.stringify(req));
    } else {
      cachedPinBodyResp = body;
    }
    return cachedPinBodyResp;
  };
  const runFallbackResponsesStaticHygiene = (): boolean => {
    if (!textHygieneActive || !effectiveImageCompress) return false;
    const fb = applyOpenAIResponsesTextHygiene(req, {
      foldLogs: false,
      deepTextCompact: true,
      cleanUserPayloads: false,
      enableTscg: o.stageToggles?.tscg,
      enableToon: false,
      enableAcdc: false,
      enableCasi: false,
      enableLsm: false,
      enableMmu: o.stageToggles?.mmu,
      enableSkillLinker: o.stageToggles?.skillLinker,
      enableJsonUnwrap: false,
      enableDensityPrune: false,
      aggressiveToon: resolveTextHygieneMode(o.textHygiene) === 'on',
      model: req.model,
      expectedOutputTokens: o.expectedOutputTokens,
      rawBodyBytes: body.byteLength,
      nativeImageBytes: respNativeImageBytes,
      sessionKey: respSessionKey,
      firstUserText: earlyRespFirstUser,
      sessionCacheCold: sessionState.cold,
      circuitBreakerState: respBreakerState,
    });
    if (!fb.changed) return false;
    hygieneChangedResp = true;
    cachedPinBodyResp = undefined;
    cachedPinOutgoingResp = undefined;
    info.textHygieneSavedChars = (info.textHygieneSavedChars ?? 0) + fb.savedChars;
    info.textHygieneSavedTokens = (info.textHygieneSavedTokens ?? 0) + fb.savedTokens;
    info.textHygieneBlocks = (info.textHygieneBlocks ?? 0) + fb.blocks;
    info.textHygieneStages = [...new Set([...(info.textHygieneStages ?? []), ...fb.stages])];
    if (!info.cliffAvoided && fb.cliffAvoided) info.cliffAvoided = fb.cliffAvoided;
    return true;
  };
  if (profile.maxSerializedRequestBytes !== undefined && (pinChars > 0 || hygieneChangedResp || hygieneTailHydratedResp)) {
    getPinBodyResp();
  }
  if (!effectiveImageCompress) {
    if (hygieneChangedResp) {
      info.compressed = true;
      info.reason = 'text_hygiene';
      info.outgoingTextChars = countResponsesOutgoingTextChars(req);
      return { body: getPinBodyResp(), info };
    }
    if (hygieneTailHydratedResp) {
      info.reason = 'mmu_hydrate';
      info.outgoingTextChars = countResponsesOutgoingTextChars(req);
      return { body: getPinBodyResp(), info };
    }
    info.reason = 'image_disabled';
    if (pinChars > 0) info.outgoingTextChars = countResponsesOutgoingTextChars(req);
    return { body: getPinBodyResp(), info };
  }

  if (Array.isArray(req.input)) {
    inputItems = req.input as Array<ResponsesInputItem | Record<string, unknown>>;
  }

  // Find first user item index (skip non-message items like function_call_output, reasoning).
  const firstUserIdx = inputItems.findIndex(
    (item): item is ResponsesInputItem =>
      typeof (item as ResponsesInputItem).role === 'string' &&
      (item as ResponsesInputItem).role === 'user',
  );
  if (!inputWasString && firstUserIdx < 0) {
    runFallbackResponsesStaticHygiene();
    if (hygieneChangedResp) {
      info.compressed = true;
      info.reason = 'text_hygiene';
      info.outgoingTextChars = countResponsesOutgoingTextChars(req);
    } else {
      info.reason = 'no_user_message';
    }
    return { body: getPinBodyResp(), info };
  }

  info.responsesComposition = measureResponsesComposition(
    req, inputWasString, originalInputString, inputItems,
  );
  if (priceMode() === 'kosha' && gateRatesFor(req.model, { promptTokens: info.responsesComposition.totalLocal }) === null) {
    runFallbackResponsesStaticHygiene();
    info.reason = hygieneChangedResp ? 'text_hygiene' : 'unpriced_model';
    if (hygieneChangedResp) {
      if (!info.firstUserSha8 || !info.sessionKey) {
        await applyClientSessionIdentity(
          info,
          firstResponsesUserText(inputWasString, originalInputString, inputItems),
          o,
        );
      }
      info.compressed = true;
      info.outgoingTextChars = countResponsesOutgoingTextChars(req);
    }
    return { body: getPinBodyResp(), info };
  }

  // Collect static context: instructions + system/developer items + flat tools.
  const authorityDocs: string[] = [];
  const systemTexts: string[] = [];
  if (typeof req.instructions === 'string' && req.instructions.length > 0) {
    authorityDocs.push(`## INSTRUCTIONS\n${req.instructions}`);
    systemTexts.push(req.instructions);
    info.staticChars += req.instructions.length;
  }
  // Only the LEADING system/developer items are static, and volatile XML islands
  // (<env>, <git_status>, <system-reminder>, <environment_context>, etc.) inside them
  // are split out and relocated after the static slab so per-turn changes never bust the slab.
  const leadingAuthorityEnd = inputWasString ? 0 : firstUserIdx;
  interface LeadingAuthoritySplit {
    readonly index: number;
    readonly item: ResponsesInputItem;
    readonly staticText: string;
    readonly dynamicText: string;
  }
  const leadingSplits = new Map<number, LeadingAuthoritySplit>();
  const relocatedVolatileItems: ResponsesInputItem[] = [];
  for (let idx = 0; idx < leadingAuthorityEnd; idx++) {
    const item = inputItems[idx]!;
    const r = (item as ResponsesInputItem).role;
    if (r !== 'system' && r !== 'developer') continue;
    const content = (item as ResponsesInputItem).content;
    // content may be a string OR an array of input_text parts (both are valid
    // Responses shapes for system/developer items) — read either form.
    const text = responsesContentText(content);
    if (!text) continue;
    const split = r === 'developer'
      ? splitLeadingOpenAIAuthorityText(text)
      : { staticText: text, dynamicText: '', blockCount: 0 };
    leadingSplits.set(idx, {
      index: idx,
      item: item as ResponsesInputItem,
      staticText: split.staticText,
      dynamicText: split.dynamicText,
    });
    if (split.dynamicText) {
      info.dynamicChars += split.dynamicText.length;
      info.dynamicBlockCount += Math.max(1, split.blockCount);
      relocatedVolatileItems.push(
        makeRelocatedAuthorityItem(item as ResponsesInputItem, split.dynamicText),
      );
    }
    if (split.staticText) {
      authorityDocs.push(`## ${String(r).toUpperCase()} MESSAGE\n${split.staticText}`);
      systemTexts.push(split.staticText);
      info.staticChars += split.staticText.length;
    }
  }

  const { tools: rewrittenTools, docs: toolDocs } = o.compressTools
    ? rewriteFlatToolsForGpt(req.tools)
    : { tools: req.tools, docs: '' };

  const combinedRaw = [...authorityDocs, toolDocs].filter((s) => s.length > 0).join('\n\n');
  info.origChars = combinedRaw.length;
  const finishSerialized = async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(req));
    // The SAME cap the proxy enforces with a 413 (proxy.ts), applied to every
    // profile that declares one. Imaging trades tokens for bytes (base64 PNGs
    // are larger than the text they replace), so a compressed body can exceed a
    // provider's request-size limit even when the original fits. Falling back to
    // the original here turns a hard 413 into a plain uncompressed request.
    const serializedByteLimit = profile.maxSerializedRequestBytes;
    if (serializedByteLimit !== undefined && encoded.byteLength > serializedByteLimit) {
      clearImageStatsForLimit(info);
      info.reason = 'serialized_request_limit';
      if (body.byteLength > serializedByteLimit) {
        info.compressed = false;
        info.serializedRequestBytes = encoded.byteLength;
        info.sizeLimitOutcome = 'rejected';
        return { body, info };
      }
      const pinBody = getPinBodyResp();
      const usePinBody = pinBody.byteLength <= serializedByteLimit;
      const outBody = usePinBody ? pinBody : body;
      info.compressed = usePinBody && hygieneChangedResp;
      info.sizeLimitOutcome = 'fallback';
      if (usePinBody && cachedPinOutgoingResp !== undefined) {
        info.outgoingTextChars = cachedPinOutgoingResp;
      }
      return { body: outBody, info };
    }
    info.outgoingTextChars = countResponsesOutgoingTextChars(req);
    info.compressed = true;
    const prefixSha = await computeResponsesCachePrefixSha8(req);
    if (prefixSha) info.cachePrefixSha8 = prefixSha;
    return { body: encoded, info };
  };
  const origInputLen = inputItems.length;
  const pureUserAssistantHybrid =
    hybridTextMmu &&
    (info.responsesComposition?.functionOutputs ?? 0) === 0 &&
    (info.responsesComposition?.userAssistant ?? 0) >= 2_000;
  const runFallbackTextHygiene = (): boolean => {
    if (!textHygieneActive) return false;
    const fb = applyOpenAIResponsesTextHygiene(req, {
      foldLogs: true,
      deepTextCompact: true,
      cleanUserPayloads: o.cleanUserPayloads,
      enableTscg: o.stageToggles?.tscg,
      enableToon: o.stageToggles?.toon,
      enableAcdc: o.stageToggles?.acdc,
      enableCasi: o.stageToggles?.casi !== false,
      enableLsm: o.stageToggles?.lsm,
      enableMmu: o.stageToggles?.mmu,
      enableSkillLinker: o.stageToggles?.skillLinker,
      aggressiveToon: resolveTextHygieneMode(o.textHygiene) === 'on',
      model: req.model,
      expectedOutputTokens: o.expectedOutputTokens,
      rawBodyBytes: body.byteLength,
      nativeImageBytes: respNativeImageBytes,
      sessionKey: respSessionKey,
      firstUserText: earlyRespFirstUser,
      sessionCacheCold: sessionState.cold,
      circuitBreakerState: respBreakerState,
      liveTailTexts: extractResponsesLiveTailTexts(inputWasString, originalInputString, inputItems),
      appendTailHydration: (blk) => appendResponsesTailHydration(req, blk),
    });
    if (!fb.changed && !fb.tailHydrated) return false;
    if (fb.changed) hygieneChangedResp = true;
    if (fb.tailHydrated) hygieneTailHydratedResp = true;
    cachedPinBodyResp = undefined;
    cachedPinOutgoingResp = undefined;
    info.textHygieneSavedChars = (info.textHygieneSavedChars ?? 0) + fb.savedChars;
    info.textHygieneSavedTokens = (info.textHygieneSavedTokens ?? 0) + fb.savedTokens;
    info.textHygieneBlocks = (info.textHygieneBlocks ?? 0) + fb.blocks;
    const mergedStages = new Set([...(info.textHygieneStages ?? []), ...fb.stages]);
    info.textHygieneStages = [...mergedStages];
    if (!info.cliffAvoided && fb.cliffAvoided) info.cliffAvoided = fb.cliffAvoided;
    return fb.changed;
  };
  const finishHistoryOnly = async (reason: string) => {
    info.reason = reason;
    runFallbackResponsesStaticHygiene();
    if (profile.maxSerializedRequestBytes !== undefined) {
      getPinBodyResp();
    }
    const collapseAllowed = o.collapseHistory && (!hybridTextMmu || pureUserAssistantHybrid) && !inputWasString;
    if (collapseAllowed && respBreakerState !== 'closed') {
      info.historyReason ??= 'circuit_breaker';
    }
    const collapseRan =
      collapseAllowed && respBreakerState === 'closed'
        ? await applyResponsesHistoryCollapse(req, inputItems, info, o, profile)
        : false;
    if (collapseRan) {
      const collapsedItems = Array.isArray(req.input)
        ? (req.input as Array<ResponsesInputItem | Record<string, unknown>>)
        : inputItems;
      await compressResponsesLargeUserContextOptically(
        req,
        collapsedItems,
        info,
        o,
        profile,
        undefined,
        respBreakerState,
      );
      info.reason = undefined;
      return finishSerialized();
    }
    const toolOptRan =
      hybridTextMmu && o.compressToolResults && !inputWasString
        ? await compressResponsesToolOutputsOptically(
            req,
            inputItems,
            info,
            o,
            profile,
            undefined,
            respSessionKey,
            sessionState.cold,
            0,
            respBreakerState,
          )
        : false;
    const userOptRan = !inputWasString
      ? await compressResponsesLargeUserContextOptically(
          req,
          inputItems,
          info,
          o,
          profile,
          undefined,
          respBreakerState,
        )
      : false;
    if (toolOptRan || userOptRan) {
      info.reason = toolOptRan ? 'hybrid_tool_optical' : 'hybrid_user_optical';
      return finishSerialized();
    }
    const fbChanged = !hybridTextMmu ? runFallbackTextHygiene() : false;
    if (hygieneChangedResp || fbChanged) {
      info.compressed = true;
      info.reason = 'text_hygiene';
      info.outgoingTextChars = countResponsesOutgoingTextChars(req);
      const prefixSha = await computeResponsesCachePrefixSha8(req);
      if (prefixSha) info.cachePrefixSha8 = prefixSha;
      return { body: new TextEncoder().encode(JSON.stringify(req)), info };
    }
    if (hygieneTailHydratedResp) {
      info.reason = 'mmu_hydrate';
      info.outgoingTextChars = countResponsesOutgoingTextChars(req);
    }
    const prefixSha = await computeResponsesCachePrefixSha8(req);
    if (prefixSha) info.cachePrefixSha8 = prefixSha;
    return { body: getPinBodyResp(), info };
  };
  if (!combinedRaw) {
    return finishHistoryOnly('no_static_context');
  }

  if (!info.firstUserSha8 || !info.sessionKey) {
    await applyClientSessionIdentity(
      info,
      firstResponsesUserText(inputWasString, originalInputString, inputItems),
      o,
    );
  }

  const combined = compactSlabWhitespace(combinedRaw).trimEnd();
  const minCompressTokens = profile.minCompressTokens;
  const combinedTokens = minCompressTokens === undefined ? undefined : gptTextTokens(combined);
  if (minCompressTokens !== undefined && combinedTokens! < minCompressTokens) {
    return finishHistoryOnly(`below_min_tokens (${combinedTokens} < ${minCompressTokens})`);
  }
  if (minCompressTokens === undefined && combined.length < o.minCompressChars) {
    return finishHistoryOnly(`below_min_chars (${combined.length} < ${o.minCompressChars})`);
  }

  const reflowNote = o.reflow
    ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
    : '';
  const header = RESPONSES_HEADER.replace('\n====', reflowNote + '\n====');
  const renderedText = prepareImagedRenderText(header + combined, o.reflow);
  const maxCols = o.cols ?? profile.stripCols;
  let cols = Math.min(
    shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font),
    profile.stripCols,
  );
  if (o.reflow) {
    cols = resolveSinglePagePatchCols(renderedText, cols, profile.style, profile.maxHeightPx, profile);
  }

  const slabFactSheetPreview = factSheetText(combinedRaw, profile.factSheetFormat);
  let staticAuthorityCountPre = 0;
  for (const s of leadingSplits.values()) {
    if (s.staticText.length > 0) staticAuthorityCountPre++;
  }
  const authorityPointerCountPre = (typeof req.instructions === 'string' && req.instructions.length > 0 ? 1 : 0)
    + staticAuthorityCountPre;
  const slabNativeOverhead = authorityPointerCountPre * gptTextTokens(RESPONSES_POINTER)
    + gptTextTokens(slabFactSheetPreview)
    + gptTextTokens('[End of rendered GPT system/tool context.]');
  const staticBaselineTokens = gptBaselineImagedTokens(systemTexts, req.tools, rewrittenTools);
  const gate = evalOpenAIGate(
    req.model,
    renderedText,
    cols,
    o.charsPerToken,
    opts.charsPerToken === undefined && usesExactStaticBaseline(req.model)
      ? staticBaselineTokens
      : undefined,
  );
  const actualSlabTokensResp = gate.imageTokens + (profile.exactStaticBaseline ? slabNativeOverhead : 0);
  let slabProfitable = actualSlabTokensResp < gate.textTokens;
  const respTotalTokens = info.responsesComposition?.totalLocal ?? estTextPromptTokensResp;
  const respTailTok = inputItems.length > 0 ? gptTextTokens(JSON.stringify(inputItems[inputItems.length - 1])) : 0;
  const respPromptBefore = Math.max(gate.textTokens, respTotalTokens);
  const slabCliffHitResp = evalAndRecordOpenAICliff(
    req.model,
    info,
    `${req.model}\0${info.sessionKey ?? info.firstUserSha8 ?? ''}\0resp_slab`,
    {
      promptTokensBefore: respPromptBefore,
      collapsedBaselineTokens: gate.textTokens,
      collapsedActualTokens: actualSlabTokensResp,
      downstreamCachedTokens: Math.max(0, respPromptBefore - gate.textTokens - respTailTok),
      expectedOutputTokens: o.expectedOutputTokens,
    },
  );
  if (!slabProfitable && slabCliffHitResp) {
    slabProfitable = true;
  }
  info.gateEval = {
    site: 'slab',
    imageTokens: gate.imageTokens,
    textTokens: gate.textTokens,
    burnImageSide: 0,
    burnTextSide: 0,
    profitable: slabProfitable,
  };
  if (!slabProfitable) {
    info.passthroughReasons = { not_profitable: 1 };
    return finishHistoryOnly(`not_profitable (slab=${combined.length} chars)`);
  }

  const images = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
  if (images.length === 0) {
    runFallbackResponsesStaticHygiene();
    info.reason = hygieneChangedResp ? 'text_hygiene' : 'render_empty';
    if (hygieneChangedResp) {
      info.compressed = true;
      info.outgoingTextChars = countResponsesOutgoingTextChars(req);
    }
    return { body: getPinBodyResp(), info };
  }
  if (
    profile.providerImageCap !== undefined &&
    (info.responsesComposition?.imageParts ?? 0) + images.length > profile.providerImageCap
  ) {
    runFallbackResponsesStaticHygiene();
    info.reason = hygieneChangedResp ? 'text_hygiene' : 'provider_image_cap';
    if (hygieneChangedResp) {
      info.compressed = true;
      info.outgoingTextChars = countResponsesOutgoingTextChars(req);
    }
    return { body: getPinBodyResp(), info };
  }

  const { droppedCodepoints } = accumulateRenderedImages(images, info);
  const topDropped = droppedCodepointsTop(droppedCodepoints);
  if (topDropped) info.droppedCodepointsTop = topDropped;

  info.imageCount = images.length;
  // GPT savings basis (see src/core/openai-savings.ts). req.tools is still the
  // original here — reassigned to the stripped set below.
  info.imageTokens = gptImageTokens(req.model, images);
  info.baselineImagedTokens = staticBaselineTokens;
  info.compressedChars = combinedRaw.length;
  info.bucketChars = { static_slab: combinedRaw.length };
  info.systemSha8 = await sha8(combined);
  info.firstImagePng = images[0]!.png;
  info.firstImageWidth = images[0]!.width;
  info.firstImageHeight = images[0]!.height;
  info.imagePngs = images.map((img) => img.png);
  info.imageDims = images.map((img) => ({ width: img.width, height: img.height }));
  // One slab render may page into multiple PNGs; each page links to the same
  // rendered source. History sources are appended later by foldGptHistory.
  info.imageSourceText = renderedText.slice(0, 65_536);
  info.imageSourceTexts = images.map(() => info.imageSourceText);

  const imagePartsResp: ResponsesInputImagePart[] = images.map((img) => responsesImagePart(img, req.model));
  const endMarker: ResponsesInputTextPart = { type: 'input_text', text: '[End of rendered GPT system/tool context.]', ...responsesCacheBreakpoint(req, profile, o.explicitPromptCacheBreakpoints) };
  // Verbatim fact-sheet (see src/core/factsheet.ts): exact tokens that survive OCR loss.
  const slabFactSheet = slabFactSheetPreview;
  const slabFactSheetPart: ResponsesInputTextPart[] = slabFactSheet
    ? [{ type: 'input_text', text: slabFactSheet }]
    : [];
  info.nativeInjectedTokens = slabNativeOverhead;

  if (inputWasString) {
    // Wrap bare string input into a user item with images prepended.
    req.input = [{
      role: 'user',
      content: [
        ...imagePartsResp,
        ...slabFactSheetPart,
        endMarker,
        { type: 'input_text', text: typeof req.input === 'string' ? req.input : originalInputString! },
      ],
    }];
  } else {
    // Insert a dedicated static-slab item. Replace static leading items with pointers,
    // and relocate any volatile leading developer islands right AFTER the slab item so
    // per-turn volatile updates never bust the cached slab prefix.
    const staticLeadingItems: Array<ResponsesInputItem | Record<string, unknown>> = [];
    for (let idx = 0; idx < leadingAuthorityEnd; idx++) {
      const item = inputItems[idx]!;
      const split = leadingSplits.get(idx);
      if (!split) {
        staticLeadingItems.push(item);
        continue;
      }
      if (!split.staticText) {
        // Wholly volatile leading developer item: relocated to `relocatedVolatileItems` after slabUserItem.
        continue;
      }
      const it = item as ResponsesInputItem;
      if (typeof it.content === 'string') {
        it.content = RESPONSES_POINTER;
      } else if (Array.isArray(it.content)) {
        it.content = [{ type: 'input_text', text: RESPONSES_POINTER }];
      }
      staticLeadingItems.push(item);
    }
    const slabUserItem: ResponsesInputItem = {
      role: 'user',
      content: [...imagePartsResp, ...slabFactSheetPart, endMarker],
    };
    inputItems = [
      ...staticLeadingItems,
      slabUserItem,
      ...relocatedVolatileItems,
      ...inputItems.slice(firstUserIdx),
    ];
    req.input = inputItems;
  }

  // Replace instructions with pointer.
  if (typeof req.instructions === 'string' && req.instructions.length > 0) {
    req.instructions = RESPONSES_POINTER;
  }

  // Responses protocol state is not an ordinary contiguous conversation prefix.
  // The profile selects pair-only legacy coverage or mixed safe-message coverage;
  // both preserve recent/open/malformed calls and opaque protocol barriers.
  const mainCollapseAllowed = o.collapseHistory && (!hybridTextMmu || pureUserAssistantHybrid) && !inputWasString;
  if (mainCollapseAllowed && respBreakerState !== 'closed') {
    info.historyReason ??= 'circuit_breaker';
  }
  if (mainCollapseAllowed && respBreakerState === 'closed') {
    await applyResponsesHistoryCollapse(req, inputItems, info, o, profile, combinedRaw);
  }
  const activeItems = Array.isArray(req.input)
    ? (req.input as Array<ResponsesInputItem | Record<string, unknown>>)
    : inputItems;
  if (hybridTextMmu && o.compressToolResults && !inputWasString && !pureUserAssistantHybrid) {
    await compressResponsesToolOutputsOptically(
      req,
      activeItems,
      info,
      o,
      profile,
      droppedCodepoints,
      respSessionKey,
      sessionState.cold,
      Math.max(0, inputItems.length - origInputLen),
      respBreakerState,
    );
  }
  if (!inputWasString) {
    await compressResponsesLargeUserContextOptically(
      req,
      activeItems,
      info,
      o,
      profile,
      droppedCodepoints,
      respBreakerState,
    );
  }

  if (rewrittenTools !== undefined) req.tools = rewrittenTools;
  if (hybridTextMmu && info.imageCount > 0) {
    info.reason = 'hybrid_slab_optical';
    const stages = info.textHygieneStages ? [...info.textHygieneStages] : [];
    if (!stages.includes('hybrid_slab_optical')) stages.push('hybrid_slab_optical');
    info.textHygieneStages = stages;
  }

  // Regression denominator, same as the Chat path — Responses was the only
  // transform that never recorded it.
  return await finishSerialized();
}
