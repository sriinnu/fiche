/**
 * Google AI Studio / Gemini API request transformer and usage extractor.
 * Intercepts /google-ai-studio/v1beta/models/*:generateContent and :streamGenerateContent
 * requests, extracts static system instructions, renders them to PNG image parts, and
 * passes transformed payloads to Google AI Studio.
 */

import {
  PAD_Y,
  READABLE_CHARS_PER_IMAGE,
  estimateImageCount,
  neutralizeSentinel,
  reflow,
  renderCellHeight,
  renderTextToPngs,
  shrinkColsToContent,
  type RenderedImage,
} from './render.js';
import { geminiVisionTokens, hasGeminiMeasuredProfile, isGeminiModel, resolveGeminiProfile } from './gemini-model-profiles.js';
import { bytesToBase64 } from './png.js';
import {
  applyClientSessionIdentity,
  classifyContent,
  compactSlabWhitespace,
  resolveOpticalHistoryPolicy,
  sha8,
  type ClientSessionSource,
  type OpticalMode,
  type TransformInfo,
} from './transform.js';
import {
  getCacheCircuitBreakerState,
  hasStage2SealKey,
  noteHistoryRequest,
  recordStage2SealKey,
  sessionAnchorText,
} from './session-state.js';
import {
  prepareImagedRenderText,
  droppedCodepointsTop,
  schemaAnnotationLines,
  buildLiveRequestGuard,
  splitLeadingOpenAIAuthorityText,
  CHAT_HEADER,
  HISTORY_TRANSCRIPT_INTRO,
  HISTORY_TRANSCRIPT_OUTRO,
  COMPACT_HISTORY_TRANSCRIPT_INTRO,
  COMPACT_HISTORY_TRANSCRIPT_OUTRO,
  pinnedRequestBlock,
} from './openai.js';
import { extractFactSheetTokens, factSheetText, prepareFactSheet } from './factsheet.js';
import { stripSchemaDescriptions } from './schema-strip.js';
import { relocateGooglePins } from './pin.js';
import { compactPreview, verbatimTaskText } from './history.js';
import { extractFaultSignalSnippet } from './context-mmu.js';
import { evaluateCliffAvoidance, gateRatesFor, priceMode, resolvePriceRates } from './pricing.js';
import {
  applyGoogleTextHygiene,
  buildOpticalToolSealKey,
  isTextHygieneActive,
  resolveTextHygieneMode,
  type TextHygieneMode,
  type WireHygieneStats,
} from './text-hygiene.js';
import type { StageToggles } from './stage-plugins.js';
export interface GooglePart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name?: string;
    args?: unknown;
    [key: string]: unknown;
  };
  functionResponse?: {
    name?: string;
    response?: unknown;
    parts?: GooglePart[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GoogleContent {
  role?: 'user' | 'model' | string;
  parts?: GooglePart[];
  [key: string]: unknown;
}

export interface GoogleGenerateContentRequest {
  contents?: GoogleContent[];
  systemInstruction?: {
    role?: string;
    parts?: GooglePart[];
    [key: string]: unknown;
  };
  tools?: unknown[];
  [key: string]: unknown;
}

const GOOGLE_ROUTE = /^(?:\/google-ai-studio)?\/(?:v1|v1beta)\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;
const CLOUDCODE_PA_INFERENCE_ROUTE = /^\/v1internal:(?:generateContent|streamGenerateContent)$/;

export function parseGoogleModelFromPath(pathname: string): string | null {
  const match = GOOGLE_ROUTE.exec(pathname);
  return match && match[1] ? match[1] : null;
}

export function isGoogleInferencePath(pathname: string): boolean {
  return parseGoogleModelFromPath(pathname) !== null || CLOUDCODE_PA_INFERENCE_ROUTE.test(pathname);
}

const SYSTEM_POINTER =
  'The original system instruction is rendered in the image at the start of the first user turn. ' +
  'Treat that image as this system instruction, with the same authority and priority.';

const TOOL_POINTER_PREFIX = 'Full parameter docs: see "## Tool: ';

interface GoogleFunctionDeclaration extends Record<string, unknown> {
  name?: string;
  description?: string;
  parameters?: unknown;
}

interface GoogleToolRewrite {
  tools: unknown[] | undefined;
  docs: string;
  originalTokens: number;
  rewrittenTokens: number;
}

interface GoogleHistoryUnit {
  index: number;
  text: string;
  userText?: string;
  userInterjection?: boolean;
  baselineTokens: number;
  source: GoogleContent;
  opens: string[];
  closes: string[];
  opaque: boolean;
}

interface GoogleHistorySegment {
  images: RenderedImage[];
  imageSources: string[];
  text: string;
  factSheet: string;
}

interface GoogleHistoryPlan {
  start: number;
  endExclusive: number;
  segments: GoogleHistorySegment[];
  images: RenderedImage[];
  imageSources: string[];
  text: string;
  factSheet: string;
  pinnedUserText?: string;
  baselineTokens: number;
  nativeTokens: number;
  collapsedTurns: number;
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
  cliffAvoided?: { at: number; multiplier: number; savedUsd: number };
}

const GOOGLE_CLIFF_STICKY_MAX = 512;
const googleCliffSticky = new Map<string, number>();

function getGoogleCliffSticky(key: string): number | undefined {
  const hit = googleCliffSticky.get(key);
  if (hit !== undefined) {
    googleCliffSticky.delete(key);
    googleCliffSticky.set(key, hit);
  }
  return hit;
}

function recordGoogleCliffSticky(key: string, cliffAt: number): void {
  if (googleCliffSticky.has(key)) {
    googleCliffSticky.delete(key);
  } else if (googleCliffSticky.size >= GOOGLE_CLIFF_STICKY_MAX) {
    const oldest = googleCliffSticky.keys().next().value;
    if (oldest !== undefined) googleCliffSticky.delete(oldest);
  }
  googleCliffSticky.set(key, cliffAt);
}

function evalAndRecordGoogleCliff(
  modelName: string,
  stickyKey: string,
  args: {
    promptTokensBefore: number;
    collapsedBaselineTokens: number;
    collapsedActualTokens: number;
    downstreamCachedTokens: number;
    expectedOutputTokens?: number;
  },
): { at: number; multiplier: number; savedUsd: number } | undefined {
  if (priceMode() !== 'kosha') return undefined;
  const {
    promptTokensBefore,
    collapsedBaselineTokens,
    collapsedActualTokens,
    downstreamCachedTokens,
    expectedOutputTokens,
  } = args;
  if (!(collapsedActualTokens < collapsedBaselineTokens) || promptTokensBefore <= collapsedBaselineTokens) {
    return undefined;
  }
  const stickyCliffAt = getGoogleCliffSticky(stickyKey);
  if (stickyCliffAt !== undefined && promptTokensBefore > stickyCliffAt) {
    const evalSticky = evaluateCliffAvoidance(modelName, {
      promptTokensBefore,
      promptTokensAfter: Math.max(0, promptTokensBefore - (collapsedBaselineTokens - collapsedActualTokens)),
      collapsedBaselineTokens,
      collapsedActualTokens,
      downstreamCachedTokens: Math.max(0, downstreamCachedTokens),
      expectedOutputTokens,
    });
    if (evalSticky?.crossesCliff && evalSticky.netSingleTurnUsd > 0) {
      return {
        at: evalSticky.cliffAt,
        multiplier: evalSticky.multiplier,
        savedUsd: evalSticky.netSingleTurnUsd,
      };
    }
    return { at: stickyCliffAt, multiplier: 2, savedUsd: 0 };
  }
  const cliff = evaluateCliffAvoidance(modelName, {
    promptTokensBefore,
    promptTokensAfter: Math.max(0, promptTokensBefore - (collapsedBaselineTokens - collapsedActualTokens)),
    collapsedBaselineTokens,
    collapsedActualTokens,
    downstreamCachedTokens: Math.max(0, downstreamCachedTokens),
    expectedOutputTokens,
  });
  if (cliff?.crossesCliff && cliff.netSingleTurnUsd > 0) {
    recordGoogleCliffSticky(stickyKey, cliff.cliffAt);
    return {
      at: cliff.cliffAt,
      multiplier: cliff.multiplier,
      savedUsd: cliff.netSingleTurnUsd,
    };
  }
  return undefined;
}

function countGoogleInlineImageBytes(req: GoogleGenerateContentRequest): number {
  let bytes = 0;
  const addParts = (parts?: GooglePart[]) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (part?.inlineData && typeof part.inlineData.data === 'string') {
        bytes += part.inlineData.data.length;
      }
      if (part?.functionResponse && Array.isArray(part.functionResponse.parts)) {
        addParts(part.functionResponse.parts);
      }
    }
  };
  addParts(req.systemInstruction?.parts);
  if (Array.isArray(req.contents)) {
    for (const c of req.contents) addParts(c?.parts);
  }
  return bytes;
}

interface GoogleToolResultPlan {
  contents: GoogleContent[];
  images: RenderedImage[];
  imageSources: string[];
  baselineTokens: number;
  nativeTokens: number;
  compressedChars: number;
  bucketChars: Partial<Record<'tool_result_json' | 'tool_result_log' | 'tool_result_prose', number>>;
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Gemini 3+ replay token. Present on the part, thought block, or nested on functionCall. */
function readGeminiThoughtSignature(part: unknown): string | undefined {
  const rec = record(part);
  if (!rec) return undefined;
  const direct = readString(rec.thoughtSignature) ?? readString(rec.thought_signature) ?? readString(rec.signature);
  if (direct) return direct;
  const functionCall = record(rec.functionCall);
  if (functionCall) {
    const fcSig = readString(functionCall.thoughtSignature) ?? readString(functionCall.thought_signature) ?? readString(functionCall.signature);
    if (fcSig) return fcSig;
  }
  return undefined;
}

function isGeminiFunctionCallPart(part: unknown): boolean {
  return record(part)?.functionCall !== undefined;
}

function cleanGeminiFunctionCall(fc: unknown): { cleaned: Record<string, unknown> | undefined; changed: boolean } {
  const rec = record(fc);
  if (!rec) return { cleaned: undefined, changed: false };
  // FunctionCall in Gemini protobuf only permits `name`, `args`, and `id`.
  // Discard any thought_signature / thoughtSignature mistakenly attached to functionCall itself.
  if ('thoughtSignature' in rec || 'thought_signature' in rec || 'signature' in rec) {
    const { thoughtSignature, thought_signature, signature, ...rest } = rec;
    return { cleaned: rest, changed: true };
  }
  return { cleaned: rec, changed: false };
}

/** Normalize signature placement without changing Gemini's signed part sequence. */
function normalizeGeminiThoughtSignatures(contents: GoogleContent[]): GoogleContent[] {
  let changed = false;

  const next = contents.map((content) => {
    if (!Array.isArray(content.parts) || content.parts.length === 0) return content;

    let partsChanged = false;
    const parts = content.parts.map((part) => {
      if (!isGeminiFunctionCallPart(part)) return part;
      const rec = record(part) ?? {};
      const { cleaned: fc, changed: fcChanged } = cleanGeminiFunctionCall(rec.functionCall);
      const signature = readGeminiThoughtSignature(part);
      const hasCanonicalSignature = readString(rec.thoughtSignature) === signature;
      const hasLegacySignature = 'thought_signature' in rec || 'signature' in rec;
      if (!signature) {
        if (fcChanged) {
          partsChanged = true;
          return { ...rec, functionCall: fc };
        }
        return part;
      }
      if (hasCanonicalSignature && !hasLegacySignature && !fcChanged) {
        return part;
      }
      const { thought_signature, signature: legacySignature, ...rest } = rec;
      partsChanged = true;
      return {
        ...rest,
        thoughtSignature: signature,
        ...(fc ? { functionCall: fc } : {}),
      };
    });
    if (!partsChanged) return content;
    changed = true;
    return { ...content, parts };
  });
  return changed ? next : contents;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value ?? '');
  }
}

function googleTextTokens(text: string): number {
  return text ? Math.ceil(text.length / 3.5) : 0;
}

function rewriteGoogleTools(tools: unknown[] | undefined): GoogleToolRewrite {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tools, docs: '', originalTokens: 0, rewrittenTokens: 0 };
  }
  const originalTokens = googleTextTokens(safeJson(tools));
  const docs: string[] = [];
  let changed = false;
  const rewritten = tools.map((rawTool) => {
    const tool = record(rawTool);
    if (!tool || !Array.isArray(tool.functionDeclarations)) return rawTool;
    let toolChanged = false;
    const declarations = tool.functionDeclarations.map((rawDeclaration) => {
      const declaration = record(rawDeclaration) as GoogleFunctionDeclaration | null;
      if (!declaration || typeof declaration.name !== 'string') return rawDeclaration;
      const annotations = schemaAnnotationLines(declaration.parameters);
      const description = typeof declaration.description === 'string'
        ? declaration.description
        : '';
      if (!description && annotations.length === 0) return rawDeclaration;
      docs.push([
        `## Tool: ${declaration.name}`,
        description,
        declaration.parameters === undefined
          ? ''
          : `\`\`\`json\n${safeJson(declaration.parameters)}\n\`\`\``,
      ].filter(Boolean).join('\n'));
      toolChanged = true;
      return {
        ...declaration,
        description: `${TOOL_POINTER_PREFIX}${declaration.name}" in the rendered context image.`,
        parameters: stripSchemaDescriptions(declaration.parameters),
      };
    });
    if (!toolChanged) return rawTool;
    changed = true;
    return { ...tool, functionDeclarations: declarations };
  });
  const toolsOut = changed ? rewritten : tools;
  return {
    tools: toolsOut,
    docs: docs.join('\n\n'),
    originalTokens,
    rewrittenTokens: googleTextTokens(safeJson(toolsOut)),
  };
}

const SIMPLE_RESPONSE_KEYS = new Set(['name', 'output', 'content', 'result', 'error']);

function extractGoogleFunctionResponseText(response: unknown): string {
  const rec = record(response);
  if (rec) {
    const keys = Object.keys(rec);
    if (keys.length > 0 && keys.every((k) => SIMPLE_RESPONSE_KEYS.has(k))) {
      const parts: string[] = [];
      for (const k of ['content', 'output', 'result', 'error'] as const) {
        const v = rec[k];
        if (typeof v === 'string' && v.length > 0) parts.push(v);
      }
      if (parts.length > 0) return compactSlabWhitespace(parts.join('\n'));
    }
  }
  return safeJson(response ?? {});
}
const GOOGLE_REMINDER_OPEN = '<system-reminder>';
const GOOGLE_REMINDER_CLOSE = '</system-reminder>';
const GOOGLE_NOTICE_OPEN = '<system-notice>';
const GOOGLE_NOTICE_CLOSE = '</system-notice>';
const USER_INTERJECTION_HEADER_RE = /^User interjection during work[^\n]*\n?/i;
const USER_INTERJECTION_FOOTER_RE =
  /\n?\[User interjection supersedes conflicting prior instructions\.[^\]]*\]\s*$/i;

/**
 * Extract human-authored prompt text from a Gemini user turn's text parts.
 * Strips `<system-reminder>` envelopes and non-interjection `<system-notice>`
 * blocks (e.g. device-inventory updates), while unwrapping mid-work user
 * interjections (`<system-notice>User interjection during work...</system-notice>`)
 * so they remain recognized as part of the active user request.
 */
function extractGoogleUserPrompt(
  parts: readonly string[],
): { text: string; isInterjection: boolean } | undefined {
  if (parts.length === 0) return undefined;
  const cleanedParts: string[] = [];
  let isInterjection = false;

  for (const raw of parts) {
    let withoutReminders = '';
    let at = 0;
    for (;;) {
      const open = raw.indexOf(GOOGLE_REMINDER_OPEN, at);
      if (open < 0) break;
      const close = raw.indexOf(
        GOOGLE_REMINDER_CLOSE,
        open + GOOGLE_REMINDER_OPEN.length,
      );
      if (close < 0) break;
      withoutReminders += raw.slice(at, open);
      at = close + GOOGLE_REMINDER_CLOSE.length;
    }
    withoutReminders += raw.slice(at);

    let out = '';
    let cursor = 0;
    for (;;) {
      const open = withoutReminders.indexOf(GOOGLE_NOTICE_OPEN, cursor);
      if (open < 0) break;
      const close = withoutReminders.indexOf(
        GOOGLE_NOTICE_CLOSE,
        open + GOOGLE_NOTICE_OPEN.length,
      );
      if (close < 0) break;
      out += withoutReminders.slice(cursor, open);
      const inner = withoutReminders
        .slice(open + GOOGLE_NOTICE_OPEN.length, close)
        .trim();
      if (USER_INTERJECTION_HEADER_RE.test(inner)) {
        isInterjection = true;
        const unwrapped = inner
          .replace(USER_INTERJECTION_HEADER_RE, '')
          .replace(USER_INTERJECTION_FOOTER_RE, '')
          .trim();
        if (unwrapped) {
          out += (out && !out.endsWith('\n') ? '\n' : '') + unwrapped + '\n';
        }
      }
      cursor = close + GOOGLE_NOTICE_CLOSE.length;
    }
    out += withoutReminders.slice(cursor);

    const trimmed = out.trim();
    if (trimmed) cleanedParts.push(trimmed);
  }

  if (cleanedParts.length === 0) return undefined;
  return { text: cleanedParts.join('\n\n'), isInterjection };
}

function googlePartText(part: GooglePart): string {
  if (typeof part.text === 'string') return part.text;
  if (part.functionCall) {
    return `[tool_use ${part.functionCall.name ?? 'tool'}]\n${safeJson(part.functionCall.args ?? {})}`;
  }
  if (part.functionResponse) {
    return `[tool_result ${part.functionResponse.name ?? 'tool'}]\n${extractGoogleFunctionResponseText(part.functionResponse.response)}`;
  }
  return '';
}

function googleHistoryUnit(content: GoogleContent, index: number): GoogleHistoryUnit {
  if (!Array.isArray(content.parts)) {
    return { index, text: '', baselineTokens: 0, source: content, opens: [], closes: [], opaque: true };
  }
  const text: string[] = [];
  const rawTexts: string[] = [];
  const userTextParts: string[] = [];
  const opens: string[] = [];
  const closes: string[] = [];
  let opaque = false;
  for (const rawPart of content.parts) {
    const part = record(rawPart) as GooglePart | null;
    if (!part) { opaque = true; continue; }
    if (part.thought === true) {
      if (typeof part.text === 'string' && part.text) rawTexts.push(part.text);
      continue;
    }
    if (typeof part.text === 'string') {
      text.push(part.text);
      rawTexts.push(part.text);
      if (content.role !== 'model') userTextParts.push(part.text);
      continue;
    }
    if (part.functionCall) {
      const name = typeof part.functionCall.name === 'string' ? part.functionCall.name : 'tool';
      opens.push(name);
      const serialized = googlePartText(part);
      text.push(serialized);
      rawTexts.push(safeJson(part.functionCall));
      continue;
    }
    if (part.functionResponse) {
      const name = typeof part.functionResponse.name === 'string' ? part.functionResponse.name : 'tool';
      closes.push(name);
      const serialized = googlePartText(part);
      text.push(serialized);
      rawTexts.push(safeJson(part.functionResponse.response ?? {}));
      continue;
    }
    if (part.inlineData) {
      text.push('[image]');
      continue;
    }
    if (readGeminiThoughtSignature(part) !== undefined) {
      continue;
    }
    // Server tool state and unknown parts must stay native.
    opaque = true;
  }
  const role = content.role === 'model' ? 'assistant' : 'user';
  const body = text.filter(Boolean).join('\n\n');
  const rawBody = rawTexts.filter(Boolean).join('\n\n');
  const transcript = body ? `<${role} t="${index}">\n${body}\n</${role}>` : '';
  const userPrompt =
    content.role !== 'model' ? extractGoogleUserPrompt(userTextParts) : undefined;
  return {
    index,
    text: transcript,
    ...(userPrompt
      ? {
          userText: userPrompt.text,
          userInterjection: userPrompt.isInterjection || closes.length > 0,
        }
      : {}),
    baselineTokens: Math.max(googleTextTokens(body), googleTextTokens(rawBody)),
    source: content,
    opens,
    closes,
    opaque,
  };
}

/**
 * File-reading tools whose outputs are commonly quoted verbatim by an immediately
 * following edit tool (`edit_file`, `Edit`, `replace`, `view_file`). Keeping
 * them as native text in the live tail avoids OCR/whitespace misses while a file
 * is actively being edited; once those turns age into collapsed history,
 * `planGoogleHistory` still compresses them.
 */
const EXACT_TEXT_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'view_file',
  'file_read',
  'get_file_contents',
]);

function isExactTextTool(name: string): boolean {
  const bare = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
  return EXACT_TEXT_TOOL_NAMES.has(bare.toLowerCase());
}

async function compressGoogleToolResults(
  contents: GoogleContent[],
  modelName: string,
  options: {
    compressToolResults?: boolean;
    minToolResultChars?: number;
    maxImagesPerToolResult?: number;
    reflow?: boolean;
    sessionKey?: string;
    breakerState?: 'closed' | 'open' | 'half_open';
    slabCoveredText?: string;
  },
): Promise<GoogleToolResultPlan> {
  const empty = (): GoogleToolResultPlan => ({
    contents,
    images: [],
    imageSources: [],
    baselineTokens: 0,
    nativeTokens: 0,
    compressedChars: 0,
    bucketChars: {},
    droppedChars: 0,
    droppedCodepoints: new Map(),
  });
  if (options.compressToolResults === false) return empty();

  const profile = resolveGeminiProfile(modelName);
  const minChars = Math.max(0, options.minToolResultChars ?? 4500);
  const perResultCap = Math.max(1, options.maxImagesPerToolResult ?? 10);
  const breakerState = options.breakerState ?? 'closed';
  const sessionKey = options.sessionKey;
  const allImages: RenderedImage[] = [];
  const imageSources: string[] = [];
  const bucketChars: GoogleToolResultPlan['bucketChars'] = {};
  const droppedCodepoints = new Map<number, number>();
  let baselineTokens = 0;
  let nativeTokens = 0;
  let compressedChars = 0;
  let droppedChars = 0;
  let changed = false;

  const rewrittenContents: GoogleContent[] = [];
  for (let cIdx = 0; cIdx < contents.length; cIdx++) {
    const content = contents[cIdx]!;
    if (!Array.isArray(content.parts)) {
      rewrittenContents.push(content);
      continue;
    }
    let contentChanged = false;
    const rewrittenParts: GooglePart[] = [];
    for (let pIdx = 0; pIdx < content.parts.length; pIdx++) {
      const rawPart = content.parts[pIdx]!;
      const part = record(rawPart) as GooglePart | null;
      const response = part?.functionResponse;
      const responseBody = record(response?.response);
      const textKey = (['content', 'output', 'result', 'error'] as const).find(
        (k) => typeof responseBody?.[k] === 'string' && (responseBody[k] as string).length >= minChars,
      );
      const raw = textKey ? (responseBody![textKey] as string) : '';
      if (
        !part || !response || !responseBody || !textKey || raw.length < minChars ||
        (Array.isArray(response.parts) && response.parts.length > 0)
      ) {
        rewrittenParts.push(rawPart);
        continue;
      }

      const name = typeof response.name === 'string' ? response.name : 'tool';
      if (isExactTextTool(name)) {
        rewrittenParts.push(rawPart);
        continue;
      }
      const sealKey = buildOpticalToolSealKey(`g_${cIdx}_${pIdx}_${name}`, raw);
      const alreadySealed = Boolean(sessionKey && hasStage2SealKey(sessionKey, sealKey));
      if (!alreadySealed) {
        if (breakerState === 'open') {
          rewrittenParts.push(rawPart);
          continue;
        }
        if (breakerState === 'half_open' && cIdx < contents.length - 1) {
          rewrittenParts.push(rawPart);
          continue;
        }
      }
      const compact = compactSlabWhitespace(raw);
      const safe = neutralizeSentinel(compact);
      const packed = options.reflow !== false ? reflow(safe) ?? safe : safe;
      const rendered = prepareImagedRenderText(
        `================= RENDERED TOOL RESULT: ${name} =================\n` +
        'fiche rendered this completed tool result into image pages to reduce input tokens. Read it as the exact result returned by the tool.\n' +
        packed,
        false,
      );
      const cellH = renderCellHeight(profile.style);
      const maxLines = Math.max(1, Math.floor((profile.maxHeightPx - 2 * PAD_Y) / cellH));
      const maxCharsPerImg = Math.min(READABLE_CHARS_PER_IMAGE, Math.max(1, profile.stripCols) * maxLines);
      if (estimateImageCount(rendered, profile.stripCols, maxCharsPerImg, maxLines) > perResultCap) {
        rewrittenParts.push(rawPart);
        continue;
      }
      const images = await renderTextToPngs(
        rendered,
        profile.stripCols,
        profile.style,
        profile.maxHeightPx,
      );
      if (images.length === 0 || images.length > perResultCap) {
        rewrittenParts.push(rawPart);
        continue;
      }
      const imageTokens = images.reduce(
        (sum, image) => sum + geminiVisionTokens(modelName, image.width, image.height),
        0,
      );
      const sheet = options.slabCoveredText
        ? factSheetText(raw, { format: profile.factSheetFormat, coveredText: options.slabCoveredText, dropCovered: true })
        : factSheetText(raw, profile.factSheetFormat);
      const pointer = `The completed ${name} tool result is rendered in the attached image part(s).` +
        (sheet ? `\n${sheet}` : '');
      const textTokens = googleTextTokens(raw);
      const pointerTokens = googleTextTokens(pointer);
      if (imageTokens + pointerTokens >= textTokens) {
        rewrittenParts.push(rawPart);
        continue;
      }

      rewrittenParts.push({
        ...part,
        functionResponse: {
          ...response,
          response: { ...responseBody, [textKey]: pointer },
          parts: images.map(imagePart),
        },
      });
      if (sessionKey) recordStage2SealKey(sessionKey, sealKey);
      contentChanged = true;
      changed = true;
      allImages.push(...images);
      imageSources.push(...images.map(() => raw));
      baselineTokens += textTokens;
      nativeTokens += pointerTokens;
      compressedChars += raw.length;
      const shape = classifyContent(compact);
      const bucket = shape === 'structured'
        ? 'tool_result_json'
        : shape === 'log' ? 'tool_result_log' : 'tool_result_prose';
      bucketChars[bucket] = (bucketChars[bucket] ?? 0) + raw.length;
      for (const image of images) {
        droppedChars += image.droppedChars;
        for (const [codepoint, count] of image.droppedCodepoints) {
          droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + count);
        }
      }
    }
    rewrittenContents.push(contentChanged ? { ...content, parts: rewrittenParts } : content);
  }

  return {
    contents: changed ? rewrittenContents : contents,
    images: allImages,
    imageSources,
    baselineTokens,
    nativeTokens,
    compressedChars,
    bucketChars,
    droppedChars,
    droppedCodepoints,
  };
}

function googleClosedBoundary(
  units: GoogleHistoryUnit[],
  fromInclusive: number,
  cutoffExclusive: number,
): number {
  const open = new Map<string, number>();
  let lastClosed = fromInclusive - 1;
  for (let i = fromInclusive; i < Math.min(cutoffExclusive, units.length); i++) {
    const unit = units[i]!;
    if (unit.opaque) break;
    for (const name of unit.opens) open.set(name, (open.get(name) ?? 0) + 1);
    for (const name of unit.closes) {
      const count = open.get(name) ?? 0;
      // An output whose call sits before the selected range is a protocol barrier.
      if (count === 0) return lastClosed;
      if (count === 1) open.delete(name);
      else open.set(name, count - 1);
    }
    if (open.size === 0) lastClosed = i;
  }
  return lastClosed;
}

async function planGoogleHistory(
  contents: GoogleContent[],
  modelName: string,
  reflowEnabled: boolean,
  cliffCtx?: {
    estPromptTokens?: number;
    expectedOutputTokens?: number;
    sessionKey?: string;
    slabCoveredText?: string;
  },
): Promise<GoogleHistoryPlan | null> {
  const profile = resolveGeminiProfile(modelName);
  const units = contents.map(googleHistoryUnit);
  const cutoff = Math.max(0, units.length - profile.history.keepTail);
  // Keep Turn 0 anchored as native (`start = 1`) permanently whenever Turn 0 is a
  // user turn, so Turn 2+ never flips `start` from 1 -> 0 or retroactively seeds
  // `coveredTokens` into already-sealed segments.
  const userTurns: number[] = [];
  for (let i = 0; i < units.length; i++) {
    if (units[i]?.userText !== undefined) {
      userTurns.push(i);
    }
  }
  const start = userTurns[0] === 0 ? 1 : 0;
  const boundary = googleClosedBoundary(units, start, cutoff);
  if (boundary < start || boundary + 1 - start < 4) return null;
  const selected = units.slice(start, boundary + 1);
  const eligibleTokens = selected.reduce((sum, unit) => sum + unit.baselineTokens, 0);
  if (eligibleTokens < profile.history.minCollapseTokens) return null;

  const admitted: GoogleHistoryUnit[] = [];
  const segments: GoogleHistorySegment[] = [];
  const images: RenderedImage[] = [];
  const imageSources: string[] = [];
  const coveredTokens = new Set<string>();
  const minChunkTurns = 8;
  let cursor = 0;

  const cellH = renderCellHeight(profile.style);
  const maxLines = Math.max(1, Math.floor((profile.maxHeightPx - 2 * PAD_Y) / cellH));
  const maxCharsPerImg = Math.min(READABLE_CHARS_PER_IMAGE, Math.max(1, profile.stripCols) * maxLines);

  const maxPaybackReads = profile.history.maxCachePaybackReads ?? 10;
  const rates = resolvePriceRates(modelName);
  const compactFraming = profile.history.framing === 'compact';
  const intro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_INTRO : HISTORY_TRANSCRIPT_INTRO;
  const outro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_OUTRO : HISTORY_TRANSCRIPT_OUTRO;
  const framingOverheadTokens = googleTextTokens(`${intro}\n\n${outro}`);
  let remainingPromptTokens = cliffCtx?.estPromptTokens ?? eligibleTokens;
  let cliffAvoided: { at: number; multiplier: number; savedUsd: number } | undefined;
  const segmentPaysBack = (segBaselineTokens: number, segCollapsedTokens: number): boolean => {
    if (segCollapsedTokens >= segBaselineTokens) return false;
    const savedPerRead = (segBaselineTokens - segCollapsedTokens) * rates.read;
    if (!(savedPerRead > 0)) return false;
    const transitionCost = segCollapsedTokens * rates.write - segBaselineTokens * rates.read;
    const paybackReads = Math.ceil(Math.max(0, transitionCost) / savedPerRead);
    if (paybackReads <= maxPaybackReads) {
      remainingPromptTokens = Math.max(0, remainingPromptTokens - (segBaselineTokens - segCollapsedTokens));
      return true;
    }
    const cliff = evalAndRecordGoogleCliff(
      modelName,
      `${modelName}\0${cliffCtx?.sessionKey ?? ''}\0google_hist`,
      {
        promptTokensBefore: Math.max(segBaselineTokens, remainingPromptTokens),
        collapsedBaselineTokens: segBaselineTokens,
        collapsedActualTokens: segCollapsedTokens,
        downstreamCachedTokens: Math.max(0, remainingPromptTokens - segBaselineTokens),
        expectedOutputTokens: cliffCtx?.expectedOutputTokens,
      },
    );
    if (cliff) {
      if (!cliffAvoided) cliffAvoided = cliff;
      remainingPromptTokens = Math.max(0, remainingPromptTokens - (segBaselineTokens - segCollapsedTokens));
      return true;
    }
    return false;
  };

  const pageChars = maxCharsPerImg;
  while (cursor < selected.length && images.length < profile.history.maxImages) {
    const remaining = profile.history.maxImages - images.length;
    let lastClosedUnderCap = -1;
    let firstClosedOvershoot = -1;
    let reachedPageCap = false;
    let accruedChars = 0;
    for (let i = cursor; i < selected.length; i++) {
      const nextChars = accruedChars + (accruedChars > 0 ? 2 : 0) + selected[i]!.text.length;
      if (nextChars < pageChars) {
        accruedChars = nextChars;
        if (i + 1 >= cursor + minChunkTurns) {
          const closed = googleClosedBoundary(selected, cursor, i + 1) + 1;
          if (closed > cursor) lastClosedUnderCap = closed;
        }
        continue;
      }
      reachedPageCap = true;
      if (nextChars === pageChars) {
        const closed = googleClosedBoundary(selected, cursor, i + 1) + 1;
        if (closed > cursor) {
          lastClosedUnderCap = closed;
          break;
        }
        accruedChars = nextChars;
        continue;
      }
      // Next turn would overshoot pageChars: seal at the largest closed prefix <= pageChars.
      if (lastClosedUnderCap <= cursor && i > cursor) {
        const preClosed = googleClosedBoundary(selected, cursor, i) + 1;
        if (preClosed > cursor) lastClosedUnderCap = preClosed;
      }
      if (lastClosedUnderCap > cursor) break;
      // Single turn / atomic open-close round alone exceeds pageChars: fall back to single overshoot.
      const closed = googleClosedBoundary(selected, cursor, i + 1) + 1;
      if (closed > cursor) {
        firstClosedOvershoot = closed;
        break;
      }
    }
    const targetEnd = reachedPageCap
      ? (lastClosedUnderCap > cursor ? lastClosedUnderCap : firstClosedOvershoot)
      : -1;
    if (targetEnd <= cursor) break;
    let candidateEnd = googleClosedBoundary(selected, cursor, targetEnd) + 1;
    let accepted = false;
    while (candidateEnd > cursor) {
      const chunk = selected.slice(cursor, candidateEnd);
      const chunkText = chunk.map((unit) => unit.text).filter(Boolean).join('\n\n');
      if (!chunkText) {
        admitted.push(...chunk);
        cursor = candidateEnd;
        accepted = true;
        break;
      }
      const safe = neutralizeSentinel(chunkText);
      const renderedText = reflowEnabled ? reflow(safe) ?? safe : safe;
      if (estimateImageCount(renderedText, profile.stripCols, maxCharsPerImg, maxLines) > remaining) {
        candidateEnd = googleClosedBoundary(selected, cursor, candidateEnd - 1) + 1;
        continue;
      }
      const chunkImages = await renderTextToPngs(
        renderedText,
        profile.stripCols,
        profile.style,
        profile.maxHeightPx,
      );
      if (chunkImages.length > 0 && chunkImages.length <= remaining) {
        const renderSegSheet = prepareFactSheet(chunkText, profile.factSheetFormat);
        const segSheet = cliffCtx?.slabCoveredText && coveredTokens.size === 0
          ? renderSegSheet(cliffCtx.slabCoveredText, true)
          : renderSegSheet(coveredTokens);
        const segImageTokens = chunkImages.reduce(
          (sum, image) => sum + geminiVisionTokens(modelName, image.width, image.height),
          0,
        );
        const segBaselineTokens = chunk.reduce((sum, unit) => sum + unit.baselineTokens, 0);
        const segCollapsedTokens = segImageTokens + framingOverheadTokens + googleTextTokens(segSheet);
        if (!segmentPaysBack(segBaselineTokens, segCollapsedTokens)) {
          break;
        }
        if (segSheet) {
          for (const tok of extractFactSheetTokens(segSheet)) coveredTokens.add(tok);
        }
        const chunkSources = chunkImages.map(() => chunkText);
        segments.push({
          images: chunkImages,
          imageSources: chunkSources,
          text: chunkText,
          factSheet: segSheet,
        });
        admitted.push(...chunk);
        images.push(...chunkImages);
        imageSources.push(...chunkSources);
        cursor = candidateEnd;
        accepted = true;
        break;
      }
      candidateEnd = googleClosedBoundary(selected, cursor, candidateEnd - 1) + 1;
    }
    if (!accepted) break;
  }

  if (admitted.length < 4 || images.length === 0) return null;
  const text = admitted.map((unit) => unit.text).filter(Boolean).join('\n\n');
  const baselineTokens = admitted.reduce((sum, unit) => sum + unit.baselineTokens, 0);
  if (!text || baselineTokens < profile.history.minCollapseTokens) return null;
  const imageTokens = images.reduce(
    (sum, image) => sum + geminiVisionTokens(modelName, image.width, image.height),
    0,
  );
  const segSheets = segments.map((s) => s.factSheet).filter(Boolean);
  const factSheet = segSheets.join('\n');
  const endExclusive = start + admitted.length;

  // Identify the active user request: the latest human user turn, plus any
  // preceding user turn(s) that were not yet answered by a completed assistant
  // prose turn (no tool calls) or that the latest user turn interjected into
  // mid-work.
  const activeUserIndices: number[] = [];
  if (userTurns.length > 0) {
    const lastUserIdx = userTurns[userTurns.length - 1]!;
    activeUserIndices.push(lastUserIdx);
    let needParentPrompt = units[lastUserIdx]!.userInterjection === true;
    for (let i = lastUserIdx - 1; i >= 0; i--) {
      const u = units[i]!;
      if (u.userText !== undefined) {
        activeUserIndices.unshift(i);
        needParentPrompt = u.userInterjection === true;
        continue;
      }
      if (!needParentPrompt && u.source.role === 'model') {
        break;
      }
    }
  }
  const activeUserSet = new Set(activeUserIndices);

  const collapsedUserIndices = userTurns.filter(
    (i) => i >= start && i < endExclusive,
  );
  const collapsedActiveIndices = collapsedUserIndices.filter((i) =>
    activeUserSet.has(i),
  );
  const collapsedPriorIndices = collapsedUserIndices.filter(
    (i) => !activeUserSet.has(i),
  );
  // If Turn 0 remained anchored at index 0 (`start === 1`) and has been superseded
  // by a later user turn, keep a prior-turn breadcrumb in the live tail without
  // mutating contents[0] or any sealed segment.
  if (
    start === 1 &&
    userTurns[0] === 0 &&
    userTurns.length > 1 &&
    !activeUserSet.has(0) &&
    !collapsedPriorIndices.includes(0)
  ) {
    collapsedPriorIndices.unshift(0);
  }

  let pinnedUserText: string | undefined;
  if (collapsedUserIndices.length > 0 || collapsedPriorIndices.length > 0) {
    const blocks: string[] = [];
    if (collapsedPriorIndices.length > 0) {
      // Never drop Turn 0 from prior-turn breadcrumbs when there are >6 user turns.
      const recentPrior =
        collapsedPriorIndices.length > 6 && collapsedPriorIndices[0] === 0
          ? [0, ...collapsedPriorIndices.slice(-5)]
          : collapsedPriorIndices.slice(-6);
      const priorLines = recentPrior.map(
        (i) => `<user t="${i}">${compactPreview(units[i]!.userText!)}</user>`,
      );
      blocks.push(
        `[Earlier user turns in this session (prior context only - superseded by later turns):\n${priorLines.join('\n')}]`,
      );
    }
    if (collapsedActiveIndices.length > 0) {
      const activeVerbatim = activeUserIndices
        .map(
          (i) => `<user t="${i}">\n${verbatimTaskText(units[i]!.userText!)}\n</user>`,
        )
        .join('\n\n');
      const activeSummary = activeUserIndices
        .map((i) => `<user t="${i}"> ${compactPreview(units[i]!.userText!)} </user>`)
        .join(' ');
      blocks.push(pinnedRequestBlock(activeVerbatim).trim());
      blocks.push(buildLiveRequestGuard(activeSummary));
    } else {
      blocks.push(buildLiveRequestGuard(undefined));
    }
    pinnedUserText = blocks.join('\n\n');
  }

  const segNativeText = segments
    .map((s) => [intro, s.factSheet, outro].filter(Boolean).join('\n\n'))
    .join('\n\n');
  const nativeTokens = googleTextTokens(
    [segNativeText, pinnedUserText].filter(Boolean).join('\n\n'),
  );
  remainingPromptTokens = cliffCtx?.estPromptTokens ?? baselineTokens;
  if (!segmentPaysBack(baselineTokens, imageTokens + nativeTokens)) return null;
  const droppedCodepoints = new Map<number, number>();
  let droppedChars = 0;
  for (const image of images) {
    droppedChars += image.droppedChars;
    for (const [codepoint, count] of image.droppedCodepoints) {
      droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + count);
    }
  }
  return {
    start,
    endExclusive,
    segments,
    images,
    imageSources,
    text,
    factSheet,
    ...(pinnedUserText ? { pinnedUserText } : {}),
    baselineTokens,
    nativeTokens,
    collapsedTurns: admitted.length,
    droppedChars,
    droppedCodepoints,
    ...(cliffAvoided ? { cliffAvoided } : {}),
  };
}

function imagePart(image: RenderedImage): GooglePart {
  return {
    inlineData: {
      mimeType: 'image/png',
      data: bytesToBase64(image.png),
    },
  };
}

/**
 * Normalizes Google turn roles so that:
 * 1. Adjacent turns with the same role are merged.
 * 2. The conversation starts with a user turn.
 * 3. The conversation ends with a user turn (never a model turn), avoiding
 *    Google AI Studio's 400 "Requests ending with a model turn are not supported."
 */
export function normalizeGoogleTurnRoles(contents: GoogleContent[]): GoogleContent[] {
  if (contents.length === 0) return contents;
  const merged: GoogleContent[] = [];
  for (const turn of contents) {
    // Google AI Studio rejects empty-parts turns; skip turns with no content.
    if (!turn || !Array.isArray(turn.parts) || turn.parts.length === 0) continue;
    const role = turn.role === 'model' ? 'model' : 'user';
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      merged[merged.length - 1] = { ...last, parts: [...(last.parts ?? []), ...turn.parts] };
    } else {
      merged.push({ ...turn, role, parts: [...turn.parts] });
    }
  }
  if (merged.length === 0) return [];
  const first = merged[0];
  if (first && first.role === 'model') {
    merged.unshift({ role: 'user', parts: [{ text: ' ' }] });
  }
  const last = merged[merged.length - 1];
  if (last && last.role === 'model') {
    merged.push({ role: 'user', parts: [{ text: ' ' }] });
  }
  return merged;
}

function firstGoogleUserText(contents: readonly GoogleContent[] | undefined): string {
  if (!Array.isArray(contents)) return '';
  const texts: string[] = [];
  for (const turn of contents) {
    if (!turn || typeof turn !== 'object') continue;
    if (turn.role === 'model') {
      if (texts.length > 0) break;
      continue;
    }
    if (Array.isArray(turn.parts)) {
      for (const part of turn.parts) {
        if (part && typeof part === 'object' && typeof part.text === 'string' && part.text.trim()) {
          texts.push(part.text);
        }
      }
    }
    if (texts.length > 0) break;
  }
  return sessionAnchorText(texts);
}

function extractGoogleLiveTailTexts(contents: readonly GoogleContent[] | undefined): string[] {
  if (!Array.isArray(contents) || contents.length === 0) return [];
  const out: string[] = [];
  const last = contents[contents.length - 1];
  if (!last || !Array.isArray(last.parts)) return out;

  const isToolResponseTurn = (last.parts as readonly GooglePart[]).some(
    (part) => part && typeof part === 'object' && Boolean(part.functionResponse),
  );

  // Only inspect contents[n - 2] when contents[n - 1] is a tool-response turn,
  // and ONLY pull functionCall names/args — never Turn t-1's user prompt prose.
  if (isToolResponseTurn && contents.length >= 2) {
    const prev = contents[contents.length - 2];
    if (prev && Array.isArray(prev.parts)) {
      for (const part of prev.parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.functionCall && typeof part.functionCall === 'object') {
          const fcName = typeof part.functionCall.name === 'string' ? part.functionCall.name : '';
          const serialized = safeJson(part.functionCall.args);
          out.push(fcName ? `${fcName} ${serialized}` : serialized);
        }
      }
    }
  } else if (!isToolResponseTurn && last.role === 'user' && contents.length >= 2) {
    // If a trailing user prompt immediately follows a functionResponse turn, surface any
    // active fault/stack snippet from those tool responses (never prior user prompt prose).
    const prev = contents[contents.length - 2];
    if (prev && Array.isArray(prev.parts)) {
      for (const part of prev.parts) {
        if (!part || typeof part !== 'object' || !part.functionResponse || typeof part.functionResponse !== 'object') continue;
        const frName = typeof part.functionResponse.name === 'string' ? part.functionResponse.name : '';
        const frPartsText = Array.isArray(part.functionResponse.parts)
          ? (part.functionResponse.parts as readonly GooglePart[])
              .map((sub) => (sub && typeof sub === 'object' && typeof sub.text === 'string' ? sub.text : ''))
              .filter(Boolean)
              .join('\n')
          : '';
        const rawFr = frPartsText
          ? `${safeJson(part.functionResponse.response)}\n${frPartsText}`
          : safeJson(part.functionResponse.response);
        const faultSnippet = extractFaultSignalSnippet(rawFr);
        if (faultSnippet) {
          out.push(frName ? `${frName} ${faultSnippet}` : faultSnippet);
        }
      }
    }
  }

  const promptTexts: string[] = [];
  for (const part of last.parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && part.text.trim()) {
      promptTexts.push(part.text);
    } else if (part.functionCall && typeof part.functionCall === 'object') {
      const fcName = typeof part.functionCall.name === 'string' ? part.functionCall.name : '';
      const serialized = safeJson(part.functionCall.args);
      out.push(fcName ? `${fcName} ${serialized}` : serialized);
    } else if (part.functionResponse && typeof part.functionResponse === 'object') {
      const frName = typeof part.functionResponse.name === 'string' ? part.functionResponse.name : '';
      const frPartsText = Array.isArray(part.functionResponse.parts)
        ? (part.functionResponse.parts as readonly GooglePart[])
            .map((sub) => (sub && typeof sub === 'object' && typeof sub.text === 'string' ? sub.text : ''))
            .filter(Boolean)
            .join('\n')
        : '';
      const rawFr = frPartsText
        ? `${safeJson(part.functionResponse.response)}\n${frPartsText}`
        : safeJson(part.functionResponse.response);
      const faultSnippet = extractFaultSignalSnippet(rawFr);
      if (faultSnippet) {
        out.push(frName ? `${frName} ${faultSnippet}` : faultSnippet);
      }
    }
  }
  for (const t of promptTexts) out.push(t);
  return out;
}

function appendGoogleTailHydration(req: GoogleGenerateContentRequest, hydrationBlock: string): void {
  if (!hydrationBlock) return;
  if (!Array.isArray(req.contents)) req.contents = [];
  // Never scan backwards past model turns into earlier cached user messages.
  const last = req.contents[req.contents.length - 1];
  if (last && last.role === 'user') {
    if (!Array.isArray(last.parts)) last.parts = [];
    last.parts.push({ text: hydrationBlock });
    return;
  }
  req.contents.push({ role: 'user', parts: [{ text: hydrationBlock }] });
}

export async function transformGoogleGenerateContent(
  bodyBytes: Uint8Array,
  modelName: string,
  options: {
    compress?: boolean;
    imageCompress?: boolean;
    opticalMode?: OpticalMode;
    textHygiene?: boolean | TextHygieneMode;
    cleanUserPayloads?: boolean;
    expectedOutputTokens?: number;
    compressTools?: boolean;
    compressToolResults?: boolean;
    collapseHistory?: boolean;
    minToolResultChars?: number;
    maxImagesPerToolResult?: number;
    cols?: number;
    reflow?: boolean;
    stageToggles?: Partial<StageToggles>;
    clientSessionId?: string;
    clientSessionSource?: ClientSessionSource;
    claudeCodeSessionId?: string;
  } = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const isGemini = isGeminiModel(modelName);
  const text = new TextDecoder().decode(bodyBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const info = createDefaultInfo(modelName);
    if (!isGemini) info.reason = 'unsupported_model';
    return { body: bodyBytes, info };
  }
  const reqRecord = record(parsed);
  if (!reqRecord) {
    const info = createDefaultInfo(modelName);
    if (!isGemini) info.reason = 'unsupported_model';
    return { body: bodyBytes, info };
  }
  const isEnvelope = Boolean(
    reqRecord.request
    && typeof reqRecord.request === 'object'
    && !Array.isArray(reqRecord.request),
  );
  const req = (isEnvelope ? reqRecord.request : reqRecord) as GoogleGenerateContentRequest;

  const info = createDefaultInfo(modelName);
  const measuredProfile = isGemini && hasGeminiMeasuredProfile(modelName);
  const firstUser = firstGoogleUserText(req.contents);
  const resolvedSessionKey = await applyClientSessionIdentity(info, firstUser, options);

  const infoMeasured = measuredProfile;
  if (options.compress === false) {
    info.reason = 'compression_disabled';
    return infoMeasured
      ? withStampedThoughtSignatures(req, bodyBytes, info, isEnvelope ? reqRecord : undefined)
      : { body: bodyBytes, info };
  }

  const sessionState = resolvedSessionKey
    ? noteHistoryRequest(resolvedSessionKey, { model: modelName })
    : { cold: false, minFreezeStep: 0 };

  const pinChars = relocateGooglePins(req);
  if (pinChars > 0) info.pinChars = pinChars;

  const nativeImageBytes = countGoogleInlineImageBytes(req);

  const opticalEnabled =
    measuredProfile &&
    options.imageCompress !== false &&
    options.stageToggles?.optical !== false;

  const textHygieneActive = isTextHygieneActive(options.textHygiene);
  const breakerState = resolvedSessionKey
    ? getCacheCircuitBreakerState(resolvedSessionKey, { model: modelName })
    : 'closed';
  let hygieneStats: WireHygieneStats | undefined;
  const runGoogleHygiene = (hygieneOpts: {
    deep: boolean;
    hasStaticSlabOptical?: boolean;
  }): void => {
    if (!textHygieneActive) return;
    hygieneStats = applyGoogleTextHygiene(req, {
      foldLogs: hygieneOpts.deep,
      deepTextCompact: hygieneOpts.deep,
      cleanUserPayloads: options.cleanUserPayloads === true,
      enableTscg: hygieneOpts.hasStaticSlabOptical ? false : options.stageToggles?.tscg,
      enableToon: options.stageToggles?.toon,
      enableAcdc: options.stageToggles?.acdc,
      enableCasi: hygieneOpts.deep && options.stageToggles?.casi !== false,
      enableLsm: options.stageToggles?.lsm,
      enableMmu: options.stageToggles?.mmu,
      enableSkillLinker: hygieneOpts.hasStaticSlabOptical ? false : options.stageToggles?.skillLinker,
      aggressiveToon: resolveTextHygieneMode(options.textHygiene) === 'on',
      model: modelName,
      expectedOutputTokens: options.expectedOutputTokens,
      rawBodyBytes: bodyBytes.byteLength,
      nativeImageBytes,
      sessionKey: resolvedSessionKey,
      firstUserText: firstUser,
      sessionCacheCold: sessionState.cold,
      circuitBreakerState: breakerState,
      liveTailTexts: hygieneOpts.deep ? extractGoogleLiveTailTexts(req.contents) : undefined,
      appendTailHydration: hygieneOpts.deep ? (blk) => appendGoogleTailHydration(req, blk) : undefined,
    });
    if (hygieneStats.changed || hygieneStats.tailHydrated) {
      info.textHygieneSavedChars = hygieneStats.savedChars;
      info.textHygieneSavedTokens = hygieneStats.savedTokens;
      info.textHygieneBlocks = hygieneStats.blocks;
      info.textHygieneStages = [...hygieneStats.stages];
      if (hygieneStats.cliffAvoided) info.cliffAvoided = hygieneStats.cliffAvoided;
    }
  };

  let cachedPinBody: Uint8Array | undefined;
  const getPinBody = (): Uint8Array => {
    if (cachedPinBody) return cachedPinBody;
    cachedPinBody = pinChars > 0 || hygieneStats?.changed || hygieneStats?.tailHydrated
      ? new TextEncoder().encode(JSON.stringify(isEnvelope ? { ...reqRecord, request: req } : req))
      : bodyBytes;
    return cachedPinBody;
  };

  if (!opticalEnabled) {
    runGoogleHygiene({ deep: true });
    if (hygieneStats?.changed) {
      info.compressed = true;
      info.reason = 'text_hygiene';
      return measuredProfile
        ? withStampedThoughtSignatures(req, getPinBody(), info, isEnvelope ? reqRecord : undefined)
        : { body: getPinBody(), info };
    }
    if (hygieneStats?.tailHydrated) {
      info.reason = 'mmu_hydrate';
      return measuredProfile
        ? withStampedThoughtSignatures(req, getPinBody(), info, isEnvelope ? reqRecord : undefined)
        : { body: getPinBody(), info };
    }
    info.reason = !measuredProfile ? 'unsupported_model' : 'image_disabled';
    if (pinChars > 0) {
      return measuredProfile
        ? withStampedThoughtSignatures(req, getPinBody(), info, isEnvelope ? reqRecord : undefined)
        : { body: getPinBody(), info };
    }
    return { body: bodyBytes, info };
  }

  const finishEarlyInvalid = () => {
    if (hygieneStats?.changed) {
      info.compressed = true;
      info.reason = 'text_hygiene';
    } else if (hygieneStats?.tailHydrated) {
      info.reason = 'mmu_hydrate';
    }
    return { body: getPinBody(), info };
  };

  // Extract system instructions
  const systemTexts: string[] = [];
  const systemInstruction = record(req.systemInstruction);
  const systemParts = systemInstruction?.parts;
  let invalidSystemParts = systemParts !== undefined && !Array.isArray(systemParts);
  if (!invalidSystemParts && Array.isArray(systemParts)) {
    for (const rawPart of systemParts) {
      const part = record(rawPart);
      if (!part) {
        invalidSystemParts = true;
        break;
      }
      if (typeof part.text === 'string' && part.text.trim()) {
        systemTexts.push(part.text);
        info.staticChars += part.text.length;
      }
    }
  }
  if (invalidSystemParts) {
    runGoogleHygiene({ deep: false });
    return finishEarlyInvalid();
  }

  const toolRewrite = options.compressTools === false
    // Tools pass through untouched, so the saving is 0 by construction. Don't
    // pay two full safeJson walks of the tool array to compute `x - x`.
    ? { tools: req.tools, docs: '', originalTokens: 0, rewrittenTokens: 0 }
    : rewriteGoogleTools(req.tools);
  if (toolRewrite.docs) info.toolDocsChars = toolRewrite.docs.length;
  const authorityText = systemTexts.join('\n\n');
  const authoritySplit = splitLeadingOpenAIAuthorityText(authorityText);
  const staticAuthorityText = authoritySplit.staticText;
  const dynamicAuthorityText = authoritySplit.dynamicText;
  if (dynamicAuthorityText) {
    info.staticChars = staticAuthorityText.length;
    info.dynamicChars += dynamicAuthorityText.length;
    info.dynamicBlockCount += Math.max(1, authoritySplit.blockCount);
  }
  const combinedRaw = [staticAuthorityText, toolRewrite.docs].filter(Boolean).join('\n\n');
  info.origChars = combinedRaw.length;

  const profile = resolveGeminiProfile(modelName);
  const contentPromptTokens = Array.isArray(req.contents)
    ? req.contents.reduce((sum, c) => sum + (record(c) ? googleHistoryUnit(c, 0).baselineTokens : 0), 0)
    : 0;
  const estPromptTokens = googleTextTokens(authorityText) + toolRewrite.originalTokens + contentPromptTokens;

  const opticalHistoryPolicy = resolveOpticalHistoryPolicy({
    opticalMode: options.opticalMode,
    collapseHistory: options.collapseHistory === true ? true : undefined,
    model: modelName,
    estPromptTokens,
    textHygieneActive,
    sessionKey: resolvedSessionKey,
    sessionCold: sessionState.cold,
  });
  const hybridTextMmu = opticalHistoryPolicy === 'hybrid';

  if (priceMode() === 'kosha' && gateRatesFor(modelName, { promptTokens: estPromptTokens }) === null) {
    runGoogleHygiene({ deep: hybridTextMmu });
    info.reason = hygieneStats?.changed
      ? 'text_hygiene'
      : hygieneStats?.tailHydrated
        ? 'mmu_hydrate'
        : 'unpriced_model';
    if (hygieneStats?.changed) info.compressed = true;
    return withStampedThoughtSignatures(req, getPinBody(), info, isEnvelope ? reqRecord : undefined);
  }

  if (!hybridTextMmu) {
    runGoogleHygiene({ deep: false });
  }

  let staticImages: RenderedImage[] = [];
  let staticProfitable = false;
  let textTokens = 0;
  let imageTokens = 0;
  let nativeInjectedTokens = 0;
  let fsText: string | null = null;
  let renderedText = '';

  if (combinedRaw) {
    const combined = compactSlabWhitespace(combinedRaw).trimEnd();
    info.systemSha8 = await sha8(combined);
    const reflowNote = options.reflow !== false
      ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
      : '';
    const header = CHAT_HEADER.replace('\n====', reflowNote + '\n====');
    renderedText = prepareImagedRenderText(header + combined, options.reflow !== false);

    const maxCols = options.cols ?? profile.stripCols;
    const cols = profile.vision.regime === 'flat'
      ? Math.min(maxCols, profile.stripCols)
      : Math.min(
          shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font),
          profile.stripCols,
        );

    staticImages = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
    imageTokens = staticImages.reduce(
      (total, image) => total + geminiVisionTokens(modelName, image.width, image.height),
      0,
    );
    textTokens = Math.max(
      1,
      googleTextTokens(staticAuthorityText)
        + Math.max(0, toolRewrite.originalTokens - toolRewrite.rewrittenTokens),
    );
    fsText = factSheetText(combinedRaw, profile.factSheetFormat);
    const nativeText = SYSTEM_POINTER + (fsText ?? '');
    nativeInjectedTokens = Math.ceil(nativeText.length / 3.5);

    const slabActualTokens = imageTokens + nativeInjectedTokens;
    let slabProfitable = slabActualTokens < textTokens;
    const slabCliff = evalAndRecordGoogleCliff(
      modelName,
      `${modelName}\0${resolvedSessionKey ?? info.firstUserSha8 ?? ''}\0google_slab`,
      {
        promptTokensBefore: Math.max(textTokens, estPromptTokens),
        collapsedBaselineTokens: textTokens,
        collapsedActualTokens: slabActualTokens,
        downstreamCachedTokens: Math.max(0, estPromptTokens - textTokens),
        expectedOutputTokens: options.expectedOutputTokens,
      },
    );
    if (slabCliff) {
      if (!slabProfitable) slabProfitable = true;
      info.cliffAvoided = slabCliff;
    }
    info.gateEval = {
      site: 'slab',
      imageTokens,
      textTokens,
      burnImageSide: nativeInjectedTokens,
      burnTextSide: 0,
      profitable: slabProfitable,
    };
    staticProfitable = slabProfitable;
  }

  // Build static image parts if static slab is profitable
  const hasStaticCompression = staticProfitable && staticImages.length > 0;
  const imageParts: GooglePart[] = hasStaticCompression ? staticImages.map(imagePart) : [];
  if (hasStaticCompression && fsText) {
    imageParts.push({ text: fsText });
  }

  if (hybridTextMmu) {
    runGoogleHygiene({ deep: true, hasStaticSlabOptical: hasStaticCompression });
  }

  // Prepare transformed request. Plan history against the ORIGINAL contents;
  // inserting the slab image first would make content[0] an opaque image barrier.
  if (req.contents !== undefined && !Array.isArray(req.contents)) {
    return finishEarlyInvalid();
  }
  const originalContents = Array.isArray(req.contents) ? [...req.contents] : [];
  for (const content of originalContents) {
    if (!record(content) || (content.parts !== undefined && !Array.isArray(content.parts))) {
      return finishEarlyInvalid();
    }
  }

  const historyPlan = options.collapseHistory === false || hybridTextMmu || breakerState !== 'closed'
    ? null
    : await planGoogleHistory(
        originalContents,
        modelName,
        options.reflow !== false,
        {
          estPromptTokens,
          expectedOutputTokens: options.expectedOutputTokens,
          sessionKey: resolvedSessionKey ?? info.firstUserSha8,
          slabCoveredText: hasStaticCompression ? combinedRaw : undefined,
        },
      );
  let contents = originalContents;
  if (historyPlan) {
    const compactFraming = resolveGeminiProfile(modelName).history.framing === 'compact';
    const intro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_INTRO : HISTORY_TRANSCRIPT_INTRO;
    const outro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_OUTRO : HISTORY_TRANSCRIPT_OUTRO;
    const historyParts: GooglePart[] = [];
    for (const seg of historyPlan.segments) {
      historyParts.push({ text: intro });
      historyParts.push(...seg.images.map(imagePart));
      if (seg.factSheet) historyParts.push({ text: seg.factSheet });
      historyParts.push({ text: outro });
    }
    if (historyPlan.start > 0 && contents[historyPlan.start - 1]?.role === 'user') {
      // Keep Gemini's alternating role shape: append the synthetic prior-context
      // parts to the preceding live user turn rather than emitting user→user.
      const carrier = contents[historyPlan.start - 1]!;
      contents = [
        ...contents.slice(0, historyPlan.start - 1),
        { ...carrier, parts: [...(carrier.parts ?? []), ...historyParts] },
        ...contents.slice(historyPlan.endExclusive),
      ];
    } else {
      contents = [
        ...contents.slice(0, historyPlan.start),
        { role: 'user', parts: historyParts },
        ...contents.slice(historyPlan.endExclusive),
      ];
    }
    if (historyPlan.pinnedUserText) {
      // Keep mutable active/prior user framing OUT of contents[0] so sealed
      // optical segments remain byte-identical across turns and never bust KV cache.
      const last = contents[contents.length - 1];
      if (last && last.role === 'user') {
        contents[contents.length - 1] = {
          ...last,
          parts: [{ text: historyPlan.pinnedUserText }, ...(last.parts ?? [])],
        };
      } else {
        contents.push({ role: 'user', parts: [{ text: historyPlan.pinnedUserText }] });
      }
    }
  }

  const toolResultPlan = hybridTextMmu
    ? {
        contents,
        images: [] as RenderedImage[],
        imageSources: [] as string[],
        baselineTokens: 0,
        nativeTokens: 0,
        compressedChars: 0,
        bucketChars: {} as Record<string, number>,
        droppedChars: 0,
        droppedCodepoints: new Map<number, number>(),
      }
    : await compressGoogleToolResults(contents, modelName, {
        ...options,
        sessionKey: resolvedSessionKey,
        breakerState,
        slabCoveredText: hasStaticCompression ? combinedRaw : undefined,
      });
  contents = toolResultPlan.contents;

  const hasHistoryCompression = !!historyPlan && historyPlan.images.length > 0;
  const hasToolCompression = toolResultPlan.images.length > 0;

  if (!hasStaticCompression && !hasHistoryCompression && !hasToolCompression) {
    if (hygieneStats?.changed) {
      info.compressed = true;
      info.reason = 'text_hygiene';
    } else if (hygieneStats?.tailHydrated) {
      info.reason = 'mmu_hydrate';
    } else if (!combinedRaw) {
      info.reason = 'no_static_context';
    } else if (!staticProfitable) {
      info.reason = 'not_profitable';
    }
    return withStampedThoughtSignatures(req, getPinBody(), info, isEnvelope ? reqRecord : undefined);
  }

  if (hasStaticCompression) {
    // Static context goes first in the first user turn, matching the Anthropic path.
    // Relocate any volatile systemInstruction XML islands right after the slab images.
    const slabAndVolatileParts: GooglePart[] = dynamicAuthorityText
      ? [...imageParts, { text: dynamicAuthorityText }]
      : imageParts;
    if (contents.length > 0 && contents[0] && contents[0].role === 'user') {
      const firstTurn = contents[0];
      contents[0] = {
        ...firstTurn,
        parts: [...slabAndVolatileParts, ...(firstTurn.parts || [])],
      };
    } else {
      contents.unshift({
        role: 'user',
        parts: slabAndVolatileParts,
      });
    }
  }

  const normalizedContents = normalizeGeminiThoughtSignatures(normalizeGoogleTurnRoles(contents));

  // Keep a native system-level pointer so the imaged instruction retains its
  // original authority instead of being demoted to ordinary user content.
  const transformedReq: GoogleGenerateContentRequest = {
    ...req,
    contents: normalizedContents,
    ...(hasStaticCompression && toolRewrite.tools !== undefined ? { tools: toolRewrite.tools } : {}),
    ...(hasStaticCompression
      ? {
          systemInstruction: {
            ...req.systemInstruction,
            parts: [{ text: SYSTEM_POINTER }],
          },
        }
      : {}),
  };

  const effectiveStaticImages = hasStaticCompression ? staticImages : [];
  const mergedDroppedCodepoints = new Map<number, number>();
  let totalDroppedChars = 0;
  for (const img of effectiveStaticImages) {
    totalDroppedChars += img.droppedChars;
    for (const [codepoint, count] of img.droppedCodepoints) {
      mergedDroppedCodepoints.set(codepoint, (mergedDroppedCodepoints.get(codepoint) ?? 0) + count);
    }
  }
  info.compressed = true;
  info.imageCount = effectiveStaticImages.length;
  info.imageBytes = effectiveStaticImages.reduce((acc, img) => acc + img.png.byteLength, 0);
  info.imageTokens = hasStaticCompression ? imageTokens : 0;
  info.baselineImagedTokens = hasStaticCompression ? textTokens : 0;
  info.nativeInjectedTokens = hasStaticCompression ? nativeInjectedTokens : 0;
  info.compressedChars = hasStaticCompression ? combinedRaw.length : 0;
  info.bucketChars = hasStaticCompression ? { static_slab: combinedRaw.length } : {};
  info.firstImagePng = effectiveStaticImages[0]?.png;
  info.firstImageWidth = effectiveStaticImages[0]?.width;
  info.firstImageHeight = effectiveStaticImages[0]?.height;
  info.imagePngs = effectiveStaticImages.map((image) => image.png);
  info.imageDims = effectiveStaticImages.map((image) => ({ width: image.width, height: image.height }));
  info.imageSourceText = hasStaticCompression ? renderedText.slice(0, 65_536) : '';
  // Google renders a single combined text slab into page images; share source text across pages.
  info.imageSourceTexts = effectiveStaticImages.map(() => info.imageSourceText);

  if (historyPlan) {
      const historyImageTokens = historyPlan.images.reduce(
        (sum, image) => sum + geminiVisionTokens(modelName, image.width, image.height),
        0,
      );
      info.imageTokens += historyImageTokens;
      info.baselineImagedTokens += historyPlan.baselineTokens;
      info.nativeInjectedTokens += historyPlan.nativeTokens;
      info.imageCount += historyPlan.images.length;
      info.imageBytes += historyPlan.images.reduce((sum, image) => sum + image.png.byteLength, 0);
      info.imagePngs.push(...historyPlan.images.map((image) => image.png));
      info.imageDims.push(...historyPlan.images.map((image) => ({ width: image.width, height: image.height })));
      info.imageSourceTexts.push(...historyPlan.imageSources);
      info.compressedChars += historyPlan.text.length;
      info.bucketChars = { ...info.bucketChars, history: historyPlan.text.length };
      info.historyTextChars = historyPlan.text.length;
      info.collapsedTurns = historyPlan.collapsedTurns;
      info.collapsedChars = historyPlan.text.length;
      info.collapsedImages = historyPlan.images.length;
      info.historyReason = 'collapsed';
      if (historyPlan.cliffAvoided && !info.cliffAvoided) {
        info.cliffAvoided = historyPlan.cliffAvoided;
      }
      totalDroppedChars += historyPlan.droppedChars;
      for (const [codepoint, count] of historyPlan.droppedCodepoints) {
        mergedDroppedCodepoints.set(codepoint, (mergedDroppedCodepoints.get(codepoint) ?? 0) + count);
      }
  } else if (options.collapseHistory !== false && !hybridTextMmu) {
    info.historyReason = originalContents.length > profile.history.keepTail
      ? 'not_profitable'
      : 'no_history';
  }

  if (toolResultPlan.images.length > 0) {
    const resultImageTokens = toolResultPlan.images.reduce(
      (sum, image) => sum + geminiVisionTokens(modelName, image.width, image.height),
      0,
    );
    info.imageTokens += resultImageTokens;
    info.baselineImagedTokens += toolResultPlan.baselineTokens;
    info.nativeInjectedTokens += toolResultPlan.nativeTokens;
    info.imageCount += toolResultPlan.images.length;
    info.imageBytes += toolResultPlan.images.reduce((sum, image) => sum + image.png.byteLength, 0);
    info.imagePngs.push(...toolResultPlan.images.map((image) => image.png));
    info.imageDims.push(...toolResultPlan.images.map((image) => ({ width: image.width, height: image.height })));
    info.imageSourceTexts.push(...toolResultPlan.imageSources);
    info.compressedChars += toolResultPlan.compressedChars;
    info.toolResultImgs = toolResultPlan.images.length;
    info.bucketChars = { ...info.bucketChars, ...toolResultPlan.bucketChars };
    totalDroppedChars += toolResultPlan.droppedChars;
    for (const [codepoint, count] of toolResultPlan.droppedCodepoints) {
      mergedDroppedCodepoints.set(codepoint, (mergedDroppedCodepoints.get(codepoint) ?? 0) + count);
    }
  }
  info.droppedChars = (info.droppedChars ?? 0) + totalDroppedChars;
  info.droppedCodepointsTop = droppedCodepointsTop(mergedDroppedCodepoints) ?? {};
  if (hybridTextMmu && hasStaticCompression) {
    info.reason = 'hybrid_slab_optical';
    const stages = info.textHygieneStages ? [...info.textHygieneStages] : [];
    if (!stages.includes('hybrid_slab_optical')) stages.push('hybrid_slab_optical');
    info.textHygieneStages = stages;
  }

  const outPayload = isEnvelope ? { ...reqRecord, request: transformedReq } : transformedReq;
  const transformedBytes = new TextEncoder().encode(JSON.stringify(outPayload));
  return { body: transformedBytes, info };
}

function isNormalizedGoogleTurnRoles(contents: GoogleContent[]): boolean {
  if (contents.length === 0) return true;
  for (let i = 0; i < contents.length; i++) {
    const turn = contents[i];
    if (!turn || !Array.isArray(turn.parts) || turn.parts.length === 0) return false;
    const expectedRole = i % 2 === 0 ? 'user' : 'model';
    const role = turn.role === 'model' ? 'model' : 'user';
    if (role !== expectedRole) return false;
  }
  return contents.length % 2 === 1;
}

function withStampedThoughtSignatures(
  req: GoogleGenerateContentRequest,
  bodyBytes: Uint8Array,
  info: TransformInfo,
  envelopeRecord?: Record<string, unknown>,
): { body: Uint8Array; info: TransformInfo } {
  if (!Array.isArray(req.contents)) return { body: bodyBytes, info };
  const normalized = isNormalizedGoogleTurnRoles(req.contents)
    ? req.contents
    : normalizeGoogleTurnRoles(req.contents);
  const normalizedSignatures = normalizeGeminiThoughtSignatures(normalized);
  if (normalizedSignatures === req.contents && normalized === req.contents) return { body: bodyBytes, info };
  const outObj = envelopeRecord
    ? { ...envelopeRecord, request: { ...req, contents: normalizedSignatures } }
    : { ...req, contents: normalizedSignatures };
  return {
    body: new TextEncoder().encode(JSON.stringify(outObj)),
    info,
  };
}

function createDefaultInfo(_model: string): TransformInfo {
  return {
    compressed: false,
    reason: undefined,
    origChars: 0,
    compressedChars: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    imageCount: 0,
    imageBytes: 0,
    droppedCodepointsTop: {},
  };
}
