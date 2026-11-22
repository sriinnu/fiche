#!/usr/bin/env npx tsx
/**
 * bench/multiturn-all-models.mts — Multi-turn coding-agent benchmark across 16
 * model profiles & provider wire formats using the REAL core transform engines:
 *   - Anthropic Messages (`transformRequest`)
 *   - OpenAI Responses (`transformOpenAIResponses`)
 *   - OpenAI Chat Completions (`transformOpenAIChatCompletions`)
 *   - Google GenerateContent (`transformGoogleGenerateContent`)
 *
 * Usage:
 *   ./node_modules/.bin/tsx bench/multiturn-all-models.mts [--quick] [--turns N] [--json]
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { geminiVisionTokens } from '../src/core/gemini-model-profiles.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { resolveGptProfile, type GptModelProfile } from '../src/core/gpt-model-profiles.js';
import { gptTokenCount } from '../src/core/gpt-tokens.js';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from '../src/core/openai.js';
import { estimateBillUsd, resolvePriceRates } from '../src/core/pricing.js';
import { readerTier } from '../src/core/reader-tier.js';
import { clearRenderCache } from '../src/core/render.js';
import { transformRequest, type TransformInfo } from '../src/core/transform.js';
import { visionTokens } from '../src/core/vision-cost.js';

export type BenchWire = 'anthropic' | 'openai_responses' | 'openai_chat' | 'google';

export interface ModelBenchSpec {
  readonly provider: string;
  readonly model: string;
  readonly wire: BenchWire;
}

export interface ModelBenchResult {
  readonly provider: string;
  readonly model: string;
  readonly wire: BenchWire;
  readonly mode: 'optical' | 'text';
  readonly turns: number;
  readonly baselineTokens: number;
  readonly ficheTokens: number;
  readonly tokensSavedPct: number;
  readonly baselineUsd: number | null;
  readonly ficheUsd: number | null;
  readonly usdSavedPct: number | null;
  readonly cacheHitPct: number;
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly editSafe: boolean;
  readonly imageCount: number;
  readonly stages: readonly string[];
}

export const MODEL_BENCH_SPECS: readonly ModelBenchSpec[] = [
  { provider: 'OpenAI / Codex', model: 'gpt-6-astra', wire: 'openai_responses' },
  { provider: 'OpenAI / Codex', model: 'gpt-6.2-astra', wire: 'openai_responses' },
  { provider: 'OpenAI / Codex', model: 'gpt-6.2-sol', wire: 'openai_responses' },
  { provider: 'OpenAI / Codex', model: 'gpt-5.6-sol', wire: 'openai_responses' },
  { provider: 'Google / AGY', model: 'gemini-4-neon', wire: 'google' },
  { provider: 'Google / AGY', model: 'gemini-4-carbon', wire: 'google' },
  { provider: 'Google / AGY', model: 'gemini-4-hydrogen', wire: 'google' },
  { provider: 'Google / AGY', model: 'gemini-4-argon', wire: 'google' },
  { provider: 'Google / AGY', model: 'gemini-3.8-flash', wire: 'google' },
  { provider: 'Google / AGY', model: 'gemini-3.1-pro-preview', wire: 'google' },
  { provider: 'Anthropic', model: 'claude-opus-5-5', wire: 'anthropic' },
  { provider: 'Anthropic', model: 'claude-fable-5-20260609', wire: 'anthropic' },
  { provider: 'DeepSeek', model: 'deepseek-v4-pro', wire: 'openai_chat' },
  { provider: 'Moonshot', model: 'kimi-k3', wire: 'openai_chat' },
  { provider: 'z.ai', model: 'glm-5.3', wire: 'openai_chat' },
  { provider: 'xAI', model: 'grok-4.7', wire: 'openai_responses' },
];

const PROTECTED_SENTINEL_CODE = [
  'export function verifyLedgerChecksum(entries: readonly number[], seed: number): number {',
  '  let acc = seed >>> 0;',
  '  for (const item of entries) {',
  '    acc = ((acc * 33) ^ (item & 0xff)) >>> 0;',
  '  }',
  '  return acc;',
  '}',
].join('\n');

const PROTECTED_DIFF = [
  'diff --git a/src/ledger.ts b/src/ledger.ts',
  '--- a/src/ledger.ts',
  '+++ b/src/ledger.ts',
  '@@ -1,4 +1,4 @@',
  '-export const LEDGER_VERSION = 1;',
  '+export const LEDGER_VERSION = 2;',
].join('\n');

function buildStaticInstructions(): string {
  const rules = Array.from(
    { length: 96 },
    (_, i) =>
      `Rule ${i + 1}: Always validate file paths, preserve exact indentation and types, avoid speculative edits, verify schema invariants, and cite exact symbol names from tool output before patching module_${i}.ts.`,
  ).join('\n');
  return [
    '<system_instructions>',
    'You are an autonomous coding agent operating on a multi-package TypeScript monorepo.',
    '',
    '<!-- internal engineering checklist -->',
    rules,
    '',
    '```ts',
    'export interface WorkspaceContract { readonly root: string; readonly strict: boolean; }',
    '```',
    '</system_instructions>',
  ].join('\n');
}

function buildToolSchemas(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return Array.from({ length: 14 }, (_, idx) => ({
    name: `workspace_tool_${idx}`,
    description: `Execute deterministic workspace operation #${idx} with strict path validation, dry-run diff support, schema verification, and structured JSON telemetry output.`,
    input_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Repository-relative target file path.', minLength: 1 },
        encoding: { type: 'string', enum: ['utf8', 'ascii'], default: 'utf8', description: 'File text encoding.' },
        dryRun: { type: 'boolean', default: false, description: 'Validate without modifying disk state.' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 1048576, description: 'Maximum bytes to inspect.' },
        includeHidden: { type: 'boolean', default: false, description: 'Include dotfiles when enumerating directories.' },
      },
      required: ['path'],
    },
  }));
}

function buildTurnToolOutput(turn: number): string {
  const kind = turn % 5;
  if (kind === 0) {
    // Pretty tabular JSON output (triggers bijective @toon compression)
    return JSON.stringify(
      {
        status: 'ok',
        turn,
        items: Array.from({ length: 40 }, (_, i) => ({
          id: i + turn * 100,
          service: `worker-shard-${i % 7}`,
          region: i % 2 === 0 ? 'us-east-1' : 'eu-west-1',
          latencyMs: 12 + ((i * 7 + turn) % 45),
          healthy: true,
        })),
      },
      null,
      2,
    );
  }
  if (kind === 1) {
    // ANSI + \r progress bar + repetitive Drain-foldable log lines (with blank lines between entries)
    const rows: string[] = [
      `\x1b[32m[turn ${turn}] Running integration suite...\x1b[0m`,
      `downloading [==>   ] 25%\rdownloading [=====>] 75%\rdownloading [======] 100%`,
    ];
    for (let i = 0; i < 80; i++) {
      const sec = String(i % 60).padStart(2, '0');
      rows.push(
        `2026-11-20T12:${String(turn).padStart(2, '0')}:${sec}Z INFO worker=10.0.0.${(i % 4) + 1}:8080 processed job 550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')} in ${10 + i}ms`,
      );
      if (i % 2 === 1) rows.push('');
    }
    rows.push(`2026-11-20T12:${String(turn).padStart(2, '0')}:59Z ERROR AssertionError: mismatch at src/ledger.ts:${40 + turn}`);
    rows.push(`    at verifyBatch (src/ledger.ts:${40 + turn}:7)`);
    return rows.join('\n');
  }
  if (kind === 2) {
    // Multi-body line-numbered code read with a small per-turn delta (CASI-eligible, edit-protected)
    const header = Array.from({ length: 24 }, (_, i) => `${String(i + 1).padStart(4)}→  export function mod${i}(v: number): number { return v + ${i}; }`);
    const bodyLines = PROTECTED_SENTINEL_CODE.split('\n').map(
      (line, idx) => `${String(25 + idx).padStart(4)}→  ${line}`,
    );
    const tail = Array.from({ length: 48 }, (_, i) => {
      const ln = 25 + bodyLines.length + i;
      if (i === 10) return `${String(ln).padStart(4)}→  export const BUILD_REVISION = ${100 + turn};`;
      if (i === 28) return `${String(ln).padStart(4)}→  export const ACTIVE_SHARD = 'shard-${turn % 3}';`;
      return `${String(ln).padStart(4)}→  export function helper_${i}(v: number): number { return v + ${i}; }`;
    });
    return `File src/generated_module.ts:\n${[...header, ...bodyLines, ...tail].join('\n')}`;
  }
  if (kind === 3) {
    // Single-line minified tabular JSON output (tests default 'auto' single-line TOON)
    return JSON.stringify({
      ok: true,
      turn,
      metrics: Array.from({ length: 36 }, (_, i) => ({
        idx: i,
        endpoint: `/api/v2/shard/${i % 4}`,
        status: 200,
        p95Ms: 8 + ((i + turn) % 17),
        cached: i % 3 !== 0,
      })),
    });
  }
  // Structured multi-paragraph report + log block + protected unified diff
  return [
    `Report summary for turn ${turn}:`,
    ...Array.from({ length: 42 }, (_, i) => `2026-11-20T12:15:${String(i % 60).padStart(2, '0')}Z INFO checkpoint=${i} shard=alpha-1 region=us-east-1 ok=true`),
    PROTECTED_DIFF,
    `Conclusion: verified ${42} checkpoints on turn ${turn}.`,
  ].join('\n');
}

function buildTurnUserPrompt(t: number, envStamp: string): string {
  return [
    envStamp,
    `Step ${t}: verify ledger module ${t} and inspect telemetry.`,
    '```ts',
    PROTECTED_SENTINEL_CODE,
    '```',
    PROTECTED_DIFF,
  ].join('\n');
}

function buildPayloadForTurn(wire: BenchWire, model: string, turnCount: number): Record<string, unknown> {
  const staticSys = buildStaticInstructions();
  const tools = buildToolSchemas();
  const promptForTurn = (t: number): string => {
    const envStamp = `<env>\nWorking directory: /workspace/monorepo\nGit branch: main\nTimestamp: 2026-11-20T12:00:${String(t).padStart(2, '0')}Z\n</env>`;
    return buildTurnUserPrompt(t, envStamp);
  };

  if (wire === 'anthropic') {
    const messages: Array<Record<string, unknown>> = [];
    for (let t = 0; t < turnCount; t++) {
      const isLast = t === turnCount - 1;
      messages.push({ role: 'user', content: [{ type: 'text', text: promptForTurn(t) }] });
      if (!isLast) {
        const callId = `toolu_bench_${t}`;
        messages.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: callId, name: 'workspace_tool_0', input: { path: `src/mod_${t}.ts` } }],
        });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: callId, content: buildTurnToolOutput(t) }],
        });
      }
    }
    return {
      model,
      max_tokens: 1024,
      system: [{ type: 'text', text: staticSys, cache_control: { type: 'ephemeral' } }],
      tools: tools.map((t, i) =>
        i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
      ),
      messages,
    };
  }

  if (wire === 'openai_responses') {
    const input: Array<Record<string, unknown>> = [];
    for (let t = 0; t < turnCount; t++) {
      const isLast = t === turnCount - 1;
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: promptForTurn(t) }] });
      if (!isLast) {
        const callId = `call_bench_${t}`;
        input.push({
          type: 'function_call',
          call_id: callId,
          name: 'workspace_tool_0',
          arguments: JSON.stringify({ path: `src/mod_${t}.ts` }),
        });
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: buildTurnToolOutput(t),
        });
      }
    }
    return {
      model,
      instructions: staticSys,
      tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema })),
      input,
    };
  }

  if (wire === 'openai_chat') {
    const messages: Array<Record<string, unknown>> = [{ role: 'system', content: staticSys }];
    for (let t = 0; t < turnCount; t++) {
      const isLast = t === turnCount - 1;
      messages.push({ role: 'user', content: promptForTurn(t) });
      if (!isLast) {
        const callId = `chat_call_${t}`;
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name: 'workspace_tool_0', arguments: JSON.stringify({ path: `src/mod_${t}.ts` }) },
            },
          ],
        });
        messages.push({ role: 'tool', tool_call_id: callId, content: buildTurnToolOutput(t) });
      }
    }
    return {
      model,
      messages,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    };
  }

  // Google GenerateContent
  const contents: Array<Record<string, unknown>> = [];
  for (let t = 0; t < turnCount; t++) {
    const isLast = t === turnCount - 1;
    contents.push({ role: 'user', parts: [{ text: promptForTurn(t) }] });
    if (!isLast) {
      contents.push({
        role: 'model',
        parts: [{ functionCall: { name: 'workspace_tool_0', args: { path: `src/mod_${t}.ts` } } }],
      });
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: 'workspace_tool_0', response: { output: buildTurnToolOutput(t) } } }],
      });
    }
  }
  return {
    systemInstruction: { parts: [{ text: staticSys }] },
    tools: [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ],
    contents,
  };
}

/** Collect serialized text without embedded base64 PNG payloads to count text tokens cleanly. */
function extractTextOnlyForTokenCount(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    if (node.startsWith('data:image/')) return;
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) extractTextOnlyForTokenCount(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.type === 'image' && obj.source && typeof obj.source === 'object') return;
    if (obj.inlineData && typeof obj.inlineData === 'object') return;
    if (obj.type === 'input_image' || obj.type === 'image_url') return;
    for (const v of Object.values(obj)) extractTextOnlyForTokenCount(v, out);
  }
}

function countPayloadTextTokens(rawJsonBytes: Uint8Array): number {
  const parsed = JSON.parse(new TextDecoder().decode(rawJsonBytes)) as unknown;
  const parts: string[] = [];
  extractTextOnlyForTokenCount(parsed, parts);
  return gptTokenCount(parts.join('\n'));
}

interface PrefixUnit {
  readonly hash: string;
  readonly tokens: number;
}

function pngDimsFromBase64(b64: string): { width: number; height: number } | null {
  const buf = Buffer.from(b64.slice(0, 32), 'base64');
  if (buf.length < 24 || buf[0] !== 137 || buf[1] !== 80) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function unitRawTokens(
  node: unknown,
  wire: BenchWire,
  model: string,
  profile: GptModelProfile,
): number {
  const texts: string[] = [];
  let imageTokens = 0;

  const addPngB64 = (b64: string) => {
    const clean = b64.startsWith('data:image/') ? b64.slice(b64.indexOf(',') + 1) : b64;
    const dims = pngDimsFromBase64(clean);
    if (!dims) return;
    imageTokens += wire === 'google'
      ? geminiVisionTokens(model, dims.width, dims.height)
      : visionTokens(profile, dims.width, dims.height);
  };

  const walk = (n: unknown): void => {
    if (typeof n === 'string') {
      if (n.startsWith('data:image/')) {
        addPngB64(n);
        return;
      }
      texts.push(n);
      return;
    }
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (n && typeof n === 'object') {
      const obj = n as Record<string, unknown>;
      if (obj.type === 'image' && obj.source && typeof obj.source === 'object') {
        const data = (obj.source as { data?: unknown }).data;
        if (typeof data === 'string') addPngB64(data);
        return;
      }
      if (obj.inlineData && typeof obj.inlineData === 'object') {
        const data = (obj.inlineData as { data?: unknown }).data;
        if (typeof data === 'string') addPngB64(data);
        return;
      }
      if (obj.type === 'input_image' || obj.type === 'image_url') {
        const url = typeof obj.image_url === 'string'
          ? obj.image_url
          : obj.image_url && typeof obj.image_url === 'object'
            ? (obj.image_url as { url?: unknown }).url
            : undefined;
        if (typeof url === 'string') addPngB64(url);
        return;
      }
      for (const v of Object.values(obj)) walk(v);
    }
  };
  walk(node);
  return gptTokenCount(texts.join('\n')) + imageTokens;
}

/** Break a wire payload into ordered prefix units weighted by real text + vision tokens. */
function serializePrefixUnits(
  wire: BenchWire,
  bodyBytes: Uint8Array,
  totalTokens: number,
  model: string,
  profile: GptModelProfile,
): PrefixUnit[] {
  const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as Record<string, unknown>;
  const rawUnits: unknown[] = [];
  if (wire === 'anthropic') {
    if (parsed.tools !== undefined) rawUnits.push({ tools: parsed.tools });
    if (Array.isArray(parsed.system)) rawUnits.push(...parsed.system);
    else if (parsed.system !== undefined) rawUnits.push({ system: parsed.system });
    if (Array.isArray(parsed.messages)) rawUnits.push(...parsed.messages);
  } else if (wire === 'openai_responses') {
    if (parsed.instructions !== undefined) rawUnits.push({ instructions: parsed.instructions });
    if (parsed.tools !== undefined) rawUnits.push({ tools: parsed.tools });
    if (Array.isArray(parsed.input)) rawUnits.push(...parsed.input);
  } else if (wire === 'openai_chat') {
    if (parsed.tools !== undefined) rawUnits.push({ tools: parsed.tools });
    if (Array.isArray(parsed.messages)) rawUnits.push(...parsed.messages);
  } else {
    if (parsed.systemInstruction !== undefined) rawUnits.push({ systemInstruction: parsed.systemInstruction });
    if (parsed.tools !== undefined) rawUnits.push({ tools: parsed.tools });
    if (Array.isArray(parsed.contents)) {
      for (let i = 0; i < parsed.contents.length; i++) {
        const c = parsed.contents[i] as Record<string, unknown> | undefined;
        if (i === 0 && c && Array.isArray(c.parts)) {
          for (const p of c.parts) rawUnits.push({ role: c.role, part: p });
        } else {
          rawUnits.push(c);
        }
      }
    }
  }
  const unitToks = rawUnits.map((u) => Math.max(1, unitRawTokens(u, wire, model, profile)));
  const totalUnitToks = Math.max(1, unitToks.reduce((a, b) => a + b, 0));
  return rawUnits.map((u, idx) => ({
    hash: createHash('sha256').update(JSON.stringify(u)).digest('hex').slice(0, 16),
    tokens: Math.max(1, Math.round((unitToks[idx]! / totalUnitToks) * totalTokens)),
  }));
}

function collectToolTextOutputs(wire: BenchWire, bodyBytes: Uint8Array): string[] {
  const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as Record<string, unknown>;
  const out: string[] = [];
  if (wire === 'anthropic' && Array.isArray(parsed.messages)) {
    for (const m of parsed.messages as Array<{ content?: unknown }>) {
      if (!Array.isArray(m?.content)) continue;
      for (const blk of m.content as Array<{ type?: unknown; content?: unknown }>) {
        if (blk?.type !== 'tool_result') continue;
        if (typeof blk.content === 'string') out.push(blk.content);
        else if (Array.isArray(blk.content)) {
          for (const p of blk.content as Array<{ type?: unknown; text?: unknown }>) {
            if (p?.type === 'text' && typeof p.text === 'string') out.push(p.text);
          }
        }
      }
    }
  } else if (wire === 'openai_responses' && Array.isArray(parsed.input)) {
    for (const item of parsed.input as Array<{ type?: unknown; output?: unknown }>) {
      if (item?.type !== 'function_call_output') continue;
      if (typeof item.output === 'string') out.push(item.output);
    }
  } else if (wire === 'openai_chat' && Array.isArray(parsed.messages)) {
    for (const m of parsed.messages as Array<{ role?: unknown; content?: unknown }>) {
      if (m?.role === 'tool' && typeof m.content === 'string') out.push(m.content);
    }
  } else if (wire === 'google' && Array.isArray(parsed.contents)) {
    for (const c of parsed.contents as Array<{ parts?: unknown }>) {
      if (!Array.isArray(c?.parts)) continue;
      for (const p of c.parts as Array<{ functionResponse?: { response?: { output?: unknown } } }>) {
        const txt = p?.functionResponse?.response?.output;
        if (typeof txt === 'string') out.push(txt);
      }
    }
  }
  return out;
}

function commonPrefixTokens(prev: readonly PrefixUnit[], cur: readonly PrefixUnit[]): number {
  const n = Math.min(prev.length, cur.length);
  let matched = 0;
  for (let i = 0; i < n; i++) {
    if (prev[i]!.hash !== cur[i]!.hash) break;
    matched += cur[i]!.tokens;
  }
  return matched;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function runSingleTransform(
  spec: ModelBenchSpec,
  rawBytes: Uint8Array,
  imageCompress: boolean,
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const opts = {
    compress: true,
    imageCompress,
    textHygiene: 'auto' as const,
    collapseHistory: true,
    expectedOutputTokens: 400,
  };
  if (spec.wire === 'anthropic') {
    return transformRequest(rawBytes, { ...opts, model: spec.model });
  }
  if (spec.wire === 'openai_responses') {
    return transformOpenAIResponses(rawBytes, opts);
  }
  if (spec.wire === 'openai_chat') {
    return transformOpenAIChatCompletions(rawBytes, opts);
  }
  return transformGoogleGenerateContent(rawBytes, spec.model, opts);
}

export async function runAllModelsBenchmark(opts: { turns?: number; quick?: boolean } = {}): Promise<ModelBenchResult[]> {
  const turns = opts.turns ?? (opts.quick ? 8 : 16);
  const savedPrices = process.env.FICHE_PRICES;
  const savedLegacyPrices = process.env.INKLING_PRICES;
  process.env.FICHE_PRICES = 'kosha';

  const encoder = new TextEncoder();
  const results: ModelBenchResult[] = [];

  try {
    for (const spec of MODEL_BENCH_SPECS) {
      clearRenderCache();
      const tier = readerTier(spec.model, false);
      const imageCompress = tier === 'image';
      const profile = resolveGptProfile(spec.model);

      let baselineTokensTotal = 0;
      let ficheTokensTotal = 0;
      let baselineUsdTotal = 0;
      let ficheUsdTotal = 0;
      let anyUnpriced = false;
      let cachedPrefixTokens = 0;
      let totalPromptTokens = 0;
      let prevUnits: PrefixUnit[] = [];
      let prevBaseUnits: PrefixUnit[] = [];
      let editSafe = true;
      let finalImages = 0;
      const stageSet = new Set<string>();
      const turnLatencies: number[] = [];

      for (let t = 1; t <= turns; t++) {
        const payload = buildPayloadForTurn(spec.wire, spec.model, t);
        const rawBytes = encoder.encode(JSON.stringify(payload));
        const baseTokens = countPayloadTextTokens(rawBytes);

        const t0 = performance.now();
        const { body: outBytes, info } = await runSingleTransform(spec, rawBytes, imageCompress);
        const dt = performance.now() - t0;
        turnLatencies.push(dt);

        const outTextTokens = countPayloadTextTokens(outBytes);
        const imgTok = info.imageTokens ?? 0;
        const ficheTokens = outTextTokens + imgTok;
        finalImages = info.imageCount;
        if (info.imageCount > 0) stageSet.add('optical');
        for (const s of info.textHygieneStages ?? []) stageSet.add(s);

        const outText = new TextDecoder().decode(outBytes);
        if (!outText.includes('verifyLedgerChecksum') || !outText.includes('LEDGER_VERSION = 2')) {
          editSafe = false;
        }
        // Check EVERY surviving tool_result code/diff block so protected indentation and diffs never get mangled.
        for (const toolTxt of collectToolTextOutputs(spec.wire, outBytes)) {
          if (toolTxt.startsWith('[fiche cas') || toolTxt.startsWith('[fiche epoch-digest')) continue;
          if (toolTxt.includes('File src/generated_module.ts:')) {
            if (!toolTxt.includes('    let acc = seed >>> 0;') || !toolTxt.includes('export const BUILD_REVISION =')) {
              editSafe = false;
            }
          }
          if (toolTxt.includes('diff --git a/src/ledger.ts')) {
            if (!toolTxt.includes(PROTECTED_DIFF)) {
              editSafe = false;
            }
          }
        }

        // Longest-common-prefix KV cache simulation (append-only items stay cached)
        const curUnits = serializePrefixUnits(spec.wire, outBytes, ficheTokens, spec.model, profile);
        const cachedTok = t > 1 ? Math.min(ficheTokens, commonPrefixTokens(prevUnits, curUnits)) : 0;
        const tailUnitTok = curUnits.length > 0 ? curUnits[curUnits.length - 1]!.tokens : 0;
        const ficheRates = resolvePriceRates(spec.model, { promptTokens: ficheTokens });
        const ficheWriteTok = ficheRates.write > 1
          ? Math.max(0, ficheTokens - tailUnitTok - cachedTok)
          : 0;
        const uncachedTok = Math.max(0, ficheTokens - cachedTok - ficheWriteTok);
        prevUnits = curUnits;

        const baseUnits = serializePrefixUnits(spec.wire, rawBytes, baseTokens, spec.model, profile);
        const baseCachedTok = t > 1 ? Math.min(baseTokens, commonPrefixTokens(prevBaseUnits, baseUnits)) : 0;
        const baseTailTok = baseUnits.length > 0 ? baseUnits[baseUnits.length - 1]!.tokens : 0;
        const baseRates = resolvePriceRates(spec.model, { promptTokens: baseTokens });
        const baseWriteTok = baseRates.write > 1
          ? Math.max(0, baseTokens - baseTailTok - baseCachedTok)
          : 0;
        const baseUncachedTok = Math.max(0, baseTokens - baseCachedTok - baseWriteTok);
        prevBaseUnits = baseUnits;

        baselineTokensTotal += baseTokens;
        ficheTokensTotal += ficheTokens;
        cachedPrefixTokens += cachedTok;
        totalPromptTokens += ficheTokens;

        const bUsd = estimateBillUsd(spec.model, {
          uncachedTokens: baseUncachedTok,
          cachedTokens: baseCachedTok,
          cacheWriteTokens: baseWriteTok,
          outputTokens: 350,
          promptTokens: baseTokens,
        });
        const fUsd = estimateBillUsd(spec.model, {
          uncachedTokens: uncachedTok,
          cachedTokens: cachedTok,
          cacheWriteTokens: ficheWriteTok,
          outputTokens: 350,
          promptTokens: ficheTokens,
        });
        if (bUsd === undefined || fUsd === undefined) {
          anyUnpriced = true;
        } else {
          baselineUsdTotal += bUsd;
          ficheUsdTotal += fUsd;
        }
      }

      const tokensSavedPct =
        baselineTokensTotal > 0 ? ((baselineTokensTotal - ficheTokensTotal) / baselineTokensTotal) * 100 : 0;
      const usdSavedPct =
        !anyUnpriced && baselineUsdTotal > 0
          ? ((baselineUsdTotal - ficheUsdTotal) / baselineUsdTotal) * 100
          : null;
      const cacheHitPct = totalPromptTokens > 0 ? (cachedPrefixTokens / totalPromptTokens) * 100 : 0;
      const avgMs = turnLatencies.reduce((a, b) => a + b, 0) / Math.max(1, turnLatencies.length);
      const p95Ms = percentile(turnLatencies, 95);

      results.push({
        provider: spec.provider,
        model: spec.model,
        wire: spec.wire,
        mode: imageCompress && finalImages > 0 ? 'optical' : 'text',
        turns,
        baselineTokens: baselineTokensTotal,
        ficheTokens: ficheTokensTotal,
        tokensSavedPct: Math.round(tokensSavedPct * 10) / 10,
        baselineUsd: anyUnpriced ? null : Math.round(baselineUsdTotal * 10000) / 10000,
        ficheUsd: anyUnpriced ? null : Math.round(ficheUsdTotal * 10000) / 10000,
        usdSavedPct: usdSavedPct === null ? null : Math.round(usdSavedPct * 10) / 10,
        cacheHitPct: Math.round(cacheHitPct * 10) / 10,
        avgMs: Math.round(avgMs * 10) / 10,
        p95Ms: Math.round(p95Ms * 10) / 10,
        editSafe,
        imageCount: finalImages,
        stages: [...stageSet],
      });
    }
  } finally {
    if (savedPrices === undefined) delete process.env.FICHE_PRICES;
    else process.env.FICHE_PRICES = savedPrices;
    if (savedLegacyPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = savedLegacyPrices;
    clearRenderCache();
  }

  return results;
}

function parseCliArgs(argv: readonly string[]): { quick: boolean; json: boolean; turns?: number } {
  let quick = false;
  let json = false;
  let turns: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick') quick = true;
    else if (a === '--json') json = true;
    else if (a === '--turns' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (Number.isFinite(n) && n > 0) turns = n;
      i++;
    }
  }
  return { quick, json, turns };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = parseCliArgs(process.argv.slice(2));
  const rows = await runAllModelsBenchmark({ quick: cli.quick, turns: cli.turns });
  if (cli.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(`\nfiche 16-Model Multi-Turn Benchmark (${rows[0]?.turns ?? 0} turns, kosha pricing)\n`);
    console.log(
      'Model'.padEnd(26) +
        'Engine'.padEnd(10) +
        'Tok Saved'.padStart(11) +
        'USD Saved'.padStart(11) +
        'Cache Hit'.padStart(11) +
        'Avg ms'.padStart(9) +
        '  editSafe  Stages',
    );
    console.log('-'.repeat(104));
    for (const r of rows) {
      const usdStr = r.usdSavedPct === null ? 'unpriced' : `${r.usdSavedPct.toFixed(1)}%`;
      console.log(
        r.model.padEnd(26) +
          r.mode.padEnd(10) +
          `${r.tokensSavedPct.toFixed(1)}%`.padStart(11) +
          usdStr.padStart(11) +
          `${r.cacheHitPct.toFixed(1)}%`.padStart(11) +
          `${r.avgMs.toFixed(1)}ms`.padStart(9) +
          `  ${String(r.editSafe).padEnd(8)}  ${r.stages.join('+')}`,
      );
    }
  }
}
