/**
 * Lossless PAKT stage (L1–L3) for structured leaves.
 *
 * `@sriinnu/pakt` 0.10.0 marks results `reversible` even when tabular delta
 * encoding fails to restore cyclic integers (negative deltas come back as
 * absolute values). This stage keeps a packed string only when `decompress`
 * restores the same JSON values, or the same YAML/CSV text. L4 stays off
 * unless the caller passes a positive semantic budget. No `target` is set,
 * so PAKT does not emit a cache-breakpoint hint that could be copied onto
 * a ChatGPT Codex request.
 */
import {
  compress,
  compressMixed,
  countTokens,
  createContextEngine,
  decompress,
  decompressMixed,
  detect,
  type PaktFormat,
} from '@sriinnu/pakt';

const MIN_CHARS = 180;

const LOSSLESS_LAYERS = {
  structural: true,
  dictionary: true,
  tokenizerAware: true,
  semantic: false,
  contentAware: false,
} as const;

const NO_L3_LAYERS = { ...LOSSLESS_LAYERS, tokenizerAware: false };

export interface PackResult {
  text: string;
  applied: boolean;
  format: string;
  originalTokens: number;
  packedTokens: number;
  savedTokens: number;
  savedPercent: number;
  reversible: boolean;
  via: 'none' | 'compress' | 'context-engine' | 'mixed';
}

export interface PackOptions {
  /** Count tokens as this model. No network call. */
  model?: string;
  /** Tool name forwarded to the context engine. */
  toolName?: string;
  /** L4. Ignored unless semanticBudget is a positive integer. */
  lossy?: boolean;
  semanticBudget?: number;
}

export const PAKT_LEGEND =
  'Structured blocks may be PAKT (Pipe-Aligned Kompact Text), a lossless encoding from @sriinnu/pakt. Read @from and @dict, expand $aliases, treat ~ as the previous cell, and +N/-N as numeric deltas. Do not treat a pipe table as prose.';

function tokenModel(model: string | undefined): string {
  return model && model.trim() ? model : 'gpt-4o';
}

function tokens(text: string, model: string | undefined): number {
  return countTokens(text, tokenModel(model));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function jsonEquivalent(original: string, restored: unknown): boolean {
  try {
    return canonical(JSON.parse(original)) === canonical(restored);
  } catch {
    return false;
  }
}

function roundTrips(original: string, packed: string, format: PaktFormat | 'markdown'): boolean {
  try {
    if (format === 'markdown') return decompressMixed(packed) === original;
    if (format === 'json') {
      const back = decompress(packed, 'json');
      return jsonEquivalent(original, back.data);
    }
    const back = decompress(packed, format);
    return back.text === original || back.text.trim() === original.trim();
  } catch {
    return false;
  }
}

export function structuredFormat(text: string): 'json' | 'yaml' | 'csv' | 'markdown' | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS) return null;
  if (trimmed.startsWith('@from ') || trimmed.includes('data:image/')) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object') return 'json';
    } catch {
      // not json
    }
  }
  let detected: string;
  try {
    detected = detect(trimmed).format;
  } catch {
    return null;
  }
  if (detected === 'json' || detected === 'yaml' || detected === 'csv') return detected;
  if (detected === 'markdown' && trimmed.includes('```')) return 'markdown';
  return null;
}

function empty(text: string, model: string | undefined, format = 'text'): PackResult {
  const n = tokens(text, model);
  return {
    text,
    applied: false,
    format,
    originalTokens: n,
    packedTokens: n,
    savedTokens: 0,
    savedPercent: 0,
    reversible: true,
    via: 'none',
  };
}

function fromPacked(
  original: string,
  packed: string,
  format: string,
  model: string | undefined,
  via: PackResult['via'],
  reversible: boolean,
): PackResult | null {
  const originalTokens = tokens(original, model);
  const packedTokens = tokens(packed, model);
  if (packedTokens >= originalTokens) return null;
  const savedTokens = originalTokens - packedTokens;
  return {
    text: packed,
    applied: true,
    format,
    originalTokens,
    packedTokens,
    savedTokens,
    savedPercent: Math.round((savedTokens / originalTokens) * 1000) / 10,
    reversible,
    via,
  };
}

function compressLossless(text: string, format: 'json' | 'yaml' | 'csv', model: string | undefined): PackResult | null {
  const attempts = [LOSSLESS_LAYERS, NO_L3_LAYERS];
  for (const layers of attempts) {
    let result;
    try {
      result = compress(text, {
        fromFormat: format,
        layers: { ...layers },
        semanticBudget: 0,
        targetModel: tokenModel(model),
        piiMode: 'off',
      });
    } catch {
      continue;
    }
    if (!result.reversible || result.cacheBreakpoint) continue;
    if (result.compressedTokens >= result.originalTokens) continue;
    if (!roundTrips(text, result.compressed, format)) continue;
    return fromPacked(text, result.compressed, format, model, 'compress', true);
  }
  return null;
}

/** Context engine, lossy passes forced off. Used for tool-result strings. */
function compressWithEngine(text: string, format: 'json' | 'yaml' | 'csv', toolName: string, model: string | undefined): PackResult | null {
  try {
    const engine = createContextEngine({
      strategy: 'minimal',
      toolResultTailLines: 0,
      maxContextTokens: 2_000_000,
      recentTurns: 100,
      minToolResultTokens: 40,
    });
    engine.addToolResult(toolName || 'tool_result', text);
    const optimized = engine.optimize();
    const breakdown = optimized.savings.breakdown;
    if (breakdown.summarization !== 0 || breakdown.toolResultAging !== 0) return null;
    const tool = optimized.messages.find((message) => message.role === 'tool' && message.paktCompressed);
    if (!tool?.content) return null;
    if (!roundTrips(text, tool.content, format)) return null;
    return fromPacked(text, tool.content, format, model, 'context-engine', true);
  } catch {
    return null;
  }
}

/**
 * Pack one string. Returns null when the text is not structured, would grow,
 * or would not survive decompress. Never throws.
 */
export function packStructured(text: string, options: PackOptions = {}): PackResult | null {
  const lossy = options.lossy === true && (options.semanticBudget ?? 0) > 0;
  const format = structuredFormat(text);
  if (!format) return null;

  if (lossy) {
    try {
      const result = compress(text, {
        fromFormat: format === 'markdown' ? undefined : format,
        layers: { ...LOSSLESS_LAYERS, semantic: true },
        semanticBudget: options.semanticBudget,
        targetModel: tokenModel(options.model),
        piiMode: 'off',
      });
      if (result.cacheBreakpoint) return null;
      if (result.compressedTokens >= result.originalTokens) return null;
      return fromPacked(text, result.compressed, format, options.model, 'compress', result.reversible);
    } catch {
      return null;
    }
  }

  if (format === 'markdown') {
    try {
      const mixed = compressMixed(text, {
        layers: { ...LOSSLESS_LAYERS },
        semanticBudget: 0,
        targetModel: tokenModel(options.model),
      });
      if (!mixed.reversible || mixed.compressed === text) return null;
      if (!roundTrips(text, mixed.compressed, 'markdown')) return null;
      return fromPacked(text, mixed.compressed, 'markdown', options.model, 'mixed', true);
    } catch {
      return null;
    }
  }

  const engine = options.toolName
    ? compressWithEngine(text, format, options.toolName, options.model)
    : null;
  const direct = compressLossless(text, format, options.model);
  if (engine && direct) return engine.packedTokens <= direct.packedTokens ? engine : direct;
  return engine ?? direct;
}

export function packStructuredOrOriginal(text: string, options: PackOptions = {}): PackResult {
  return packStructured(text, options) ?? empty(text, options.model);
}

export { countTokens };
