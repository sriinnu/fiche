#!/usr/bin/env npx tsx
/**
 * bench/latency-p99.mts — Cold vs. warm P50/P95/P99 latency microbenchmarks
 * across optical slab/history transforms, 4-stage text hygiene (`tscg`, `toon`,
 * `casi_delta`, `acdc_epoch`), and adversarial hot-path guards.
 *
 * Usage:
 *   ./node_modules/.bin/tsx bench/latency-p99.mts [--quick] [--iterations N] [--json]
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCasiIndex } from '../src/core/casi-delta.js';
import { clearFactSheetCache } from '../src/core/factsheet.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { clearGptTokenMemo } from '../src/core/gpt-tokens.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { clearRenderCache } from '../src/core/render.js';
import { compileStaticText, compileToolSchemas } from '../src/core/schema-compiler.js';
import { extractStructuralDigest, planAndApplyTextEpochs, type TextEpochBlock } from '../src/core/text-history.js';
import { cleanToolOutput } from '../src/core/text-hygiene.js';
import { encodeToon } from '../src/core/toon.js';
import { transformRequest } from '../src/core/transform.js';
import { readTurnReport } from '../src/turn-report.js';

export interface LatencyBenchRow {
  readonly label: string;
  readonly sublabel: string;
  readonly kind: 'text' | 'optical' | 'guard' | 'stage';
  readonly iterations: number;
  readonly coldMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly tailMs: number; // p95 for request benchmarks, p99 for guards/stages
}

export interface LatencyBenchSuite {
  readonly requests: readonly LatencyBenchRow[];
  readonly guards: readonly LatencyBenchRow[];
  readonly stages: readonly LatencyBenchRow[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function measureAsync(
  label: string,
  sublabel: string,
  kind: LatencyBenchRow['kind'],
  iterations: number,
  tailPct: 95 | 99,
  coldSetup: () => void,
  fn: (runIdx: number) => Promise<void>,
): Promise<LatencyBenchRow> {
  coldSetup();
  const c0 = performance.now();
  await fn(0);
  const coldMs = performance.now() - c0;

  // 2 warmup runs so JIT stabilizes before warm samples (distinct run indices)
  await fn(1);
  await fn(2);

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn(i + 3);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p50Ms = percentile(samples, 50);
  const p95Ms = percentile(samples, 95);
  const p99Ms = percentile(samples, 99);
  const tailMs = tailPct === 95 ? p95Ms : p99Ms;
  return {
    label,
    sublabel,
    kind,
    iterations,
    coldMs: round2(coldMs),
    p50Ms: round2(p50Ms),
    p95Ms: round2(p95Ms),
    p99Ms: round2(p99Ms),
    tailMs: round2(tailMs),
  };
}

function measureSync(
  label: string,
  sublabel: string,
  kind: LatencyBenchRow['kind'],
  iterations: number,
  tailPct: 95 | 99,
  coldSetup: () => void,
  fn: (runIdx: number) => void,
): LatencyBenchRow {
  coldSetup();
  const c0 = performance.now();
  fn(0);
  const coldMs = performance.now() - c0;

  fn(1);
  fn(2);

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn(i + 3);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p50Ms = percentile(samples, 50);
  const p95Ms = percentile(samples, 95);
  const p99Ms = percentile(samples, 99);
  const tailMs = tailPct === 95 ? p95Ms : p99Ms;
  return {
    label,
    sublabel,
    kind,
    iterations,
    coldMs: round2(coldMs),
    p50Ms: round2(p50Ms),
    p95Ms: round2(p95Ms),
    p99Ms: round2(p99Ms),
    tailMs: round2(tailMs),
  };
}

function buildIncrementalPayloads(count: number): {
  anthropic: Uint8Array[];
  openaiResponsesText: Uint8Array[];
  openaiResponsesImaged: Uint8Array[];
  googleText: Uint8Array[];
  googleImaged: Uint8Array[];
} {
  const encoder = new TextEncoder();
  const staticSys = Array.from(
    { length: 80 },
    (_, i) => `Rule ${i + 1}: Keep edits minimal, preserve existing behavior, and verify schema types in pkg_${i}.ts.`,
  ).join('\n');
  const toolSchemas = Array.from({ length: 10 }, (_, idx) => ({
    name: `tool_${idx}`,
    description: `Workspace helper tool #${idx} for deterministic repository operations.`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Target file path' },
        dryRun: { type: 'boolean', default: false },
      },
      required: ['path'],
    },
  }));

  const turnOutput = (t: number, nonce = 0): string => {
    if (t % 3 === 0) {
      return JSON.stringify(
        {
          ok: true,
          nonce,
          rows: Array.from({ length: 24 }, (_, i) => ({
            id: i + t * 100 + nonce,
            svc: `worker-${i % 5}`,
            ms: 10 + i,
            healthy: true,
          })),
        },
        null,
        2,
      );
    }
    if (t % 3 === 1) {
      return Array.from(
        { length: 40 },
        (_, i) => `2026-11-20T12:${String(t % 60).padStart(2, '0')}:${String(i).padStart(2, '0')}Z INFO job=${i} n=${nonce} shard=s1 ok`,
      ).join('\n');
    }
    return Array.from(
      { length: 45 },
      (_, i) => `export function mod${t}_n${nonce}_fn${i}(x: number): number { return x + ${i}; }`,
    ).join('\n');
  };

  // Anthropic base 19 turns + incremental Turn 20 with fresh nonce k
  const antBaseMsgs: Array<Record<string, unknown>> = [];
  for (let t = 0; t < 19; t++) {
    antBaseMsgs.push({ role: 'user', content: [{ type: 'text', text: `Step ${t}: run diagnostic` }] });
    antBaseMsgs.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `tu_${t}`, name: 'tool_0', input: { path: `src/f${t}.ts` } }],
    });
    antBaseMsgs.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tu_${t}`, content: turnOutput(t) }],
    });
  }
  const anthropic = Array.from({ length: count }, (_, k) =>
    encoder.encode(
      JSON.stringify({
        model: 'claude-fable-5-20260609',
        max_tokens: 1024,
        system: [{ type: 'text', text: staticSys, cache_control: { type: 'ephemeral' } }],
        tools: toolSchemas,
        messages: [
          ...antBaseMsgs,
          { role: 'assistant', content: [{ type: 'tool_use', id: `tu_19_${k}`, name: 'tool_0', input: { path: `src/f19_${k}.ts` } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_19_${k}`, content: turnOutput(19, k) }] },
          { role: 'user', content: [{ type: 'text', text: `Step 20.${k}: finalize diagnostic` }] },
        ],
      }),
    ),
  );

  // OpenAI Responses base 19 turns + incremental Turn 20
  const respBaseInput: Array<Record<string, unknown>> = [];
  for (let t = 0; t < 19; t++) {
    respBaseInput.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Step ${t}` }] });
    respBaseInput.push({
      type: 'function_call',
      call_id: `c_${t}`,
      name: 'tool_0',
      arguments: JSON.stringify({ path: `src/f${t}.ts` }),
    });
    respBaseInput.push({ type: 'function_call_output', call_id: `c_${t}`, output: turnOutput(t) });
  }
  const flatRespTools = toolSchemas.map((s) => ({
    type: 'function',
    name: s.name,
    description: s.description,
    parameters: s.input_schema,
  }));
  const makeRespSeries = (model: string): Uint8Array[] =>
    Array.from({ length: count }, (_, k) =>
      encoder.encode(
        JSON.stringify({
          model,
          instructions: staticSys,
          tools: flatRespTools,
          input: [
            ...respBaseInput,
            { type: 'function_call', call_id: `c_19_${k}`, name: 'tool_0', arguments: JSON.stringify({ path: `src/f19_${k}.ts` }) },
            { type: 'function_call_output', call_id: `c_19_${k}`, output: turnOutput(19, k) },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Step 20.${k}` }] },
          ],
        }),
      ),
    );

  // Google base 19 turns + incremental Turn 20
  const gBaseContents: Array<Record<string, unknown>> = [];
  for (let t = 0; t < 19; t++) {
    gBaseContents.push({ role: 'user', parts: [{ text: `Step ${t}` }] });
    gBaseContents.push({
      role: 'model',
      parts: [{ functionCall: { name: 'tool_0', args: { path: `src/f${t}.ts` } } }],
    });
    gBaseContents.push({
      role: 'user',
      parts: [{ functionResponse: { name: 'tool_0', response: { output: turnOutput(t) } } }],
    });
  }
  const googleTools = [
    {
      functionDeclarations: toolSchemas.map((s) => ({
        name: s.name,
        description: s.description,
        parameters: s.input_schema,
      })),
    },
  ];
  const googleSeries = Array.from({ length: count }, (_, k) =>
    encoder.encode(
      JSON.stringify({
        systemInstruction: { parts: [{ text: staticSys }] },
        tools: googleTools,
        contents: [
          ...gBaseContents,
          { role: 'model', parts: [{ functionCall: { name: 'tool_0', args: { path: `src/f19_${k}.ts` } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'tool_0', response: { output: turnOutput(19, k) } } }] },
          { role: 'user', parts: [{ text: `Step 20.${k}` }] },
        ],
      }),
    ),
  );

  return {
    anthropic,
    openaiResponsesText: makeRespSeries('gpt-6-astra'),
    openaiResponsesImaged: makeRespSeries('gpt-6.2-sol'),
    googleText: googleSeries,
    googleImaged: googleSeries,
  };
}

export async function runLatencyBenchmarks(
  opts: { iterations?: number; quick?: boolean } = {},
): Promise<LatencyBenchSuite> {
  const reqIters = opts.iterations ?? (opts.quick ? 15 : 40);
  const guardIters = opts.iterations ?? (opts.quick ? 25 : 80);
  const opticalIters = Math.max(8, Math.floor(reqIters / 2));
  const payloads = buildIncrementalPayloads(Math.max(reqIters, opticalIters) + 3);
  const resetAllCaches = () => {
    clearRenderCache();
    clearFactSheetCache();
    clearGptTokenMemo();
  };

  const requests: LatencyBenchRow[] = [];
  requests.push(
    await measureAsync(
      'gpt-6-astra',
      '20T Text · OpenAI Responses (T→T+1)',
      'text',
      reqIters,
      95,
      resetAllCaches,
      async (idx) => {
        await transformOpenAIResponses(payloads.openaiResponsesText[idx]!, {
          compress: true,
          imageCompress: false,
          textHygiene: 'auto',
        });
      },
    ),
  );

  requests.push(
    await measureAsync(
      'gemini-4-neon',
      '20T Text · Google Gemini (T→T+1)',
      'text',
      reqIters,
      95,
      resetAllCaches,
      async (idx) => {
        await transformGoogleGenerateContent(payloads.googleText[idx]!, 'gemini-4-neon', {
          compress: true,
          imageCompress: false,
          textHygiene: 'auto',
        });
      },
    ),
  );

  requests.push(
    await measureAsync(
      'gpt-6.2-sol',
      '20T Imaged · OpenAI Sol (T→T+1)',
      'optical',
      opticalIters,
      95,
      resetAllCaches,
      async (idx) => {
        await transformOpenAIResponses(payloads.openaiResponsesImaged[idx]!, {
          compress: true,
          imageCompress: true,
          textHygiene: 'auto',
          collapseHistory: true,
        });
      },
    ),
  );

  requests.push(
    await measureAsync(
      'claude-fable-5',
      '20T Imaged · Anthropic Fable (T→T+1)',
      'optical',
      opticalIters,
      95,
      resetAllCaches,
      async (idx) => {
        await transformRequest(payloads.anthropic[idx]!, {
          model: 'claude-fable-5-20260609',
          compress: true,
          imageCompress: true,
          textHygiene: 'auto',
          collapseHistory: true,
        });
      },
    ),
  );

  requests.push(
    await measureAsync(
      'gemini-4-argon',
      '20T Imaged · Gemini Argon (T→T+1)',
      'optical',
      opticalIters,
      95,
      resetAllCaches,
      async (idx) => {
        await transformGoogleGenerateContent(payloads.googleImaged[idx]!, 'gemini-4-argon', {
          compress: true,
          imageCompress: true,
          textHygiene: 'auto',
          collapseHistory: true,
        });
      },
    ),
  );

  // 4-stage text hygiene microbenchmarks
  const totalGuardRuns = guardIters + 3;
  const stages: LatencyBenchRow[] = [];
  const sampleSchemas = Array.from({ length: 12 }, (_, idx) => ({
    name: `tool_${idx}`,
    description: `Schema description for tool_${idx} verifying workspace state.`,
    input_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { path: { type: 'string', description: 'Path' }, dryRun: { type: 'boolean', default: false } },
      required: ['path'],
    },
  }));
  const tscgSchemas = Array.from({ length: totalGuardRuns }, (_, k) => {
    const cloned = structuredClone(sampleSchemas);
    cloned[0]!.description += ` [run ${k}]`;
    return cloned;
  });
  const sampleStatic = Array.from({ length: 80 }, (_, i) => `Rule ${i}: Keep strict schema & path invariants.`).join('\n\n');
  const tscgStatics = Array.from({ length: totalGuardRuns }, (_, k) => `${sampleStatic}\n\nRun marker ${k}.`);
  stages.push(
    measureSync('tscg', 'compileStaticText + compileToolSchemas', 'stage', guardIters, 99, () => {}, (idx) => {
      compileStaticText(tscgStatics[idx]!);
      compileToolSchemas(tscgSchemas[idx]!, 'anthropic');
    }),
  );

  const toonRows = Array.from({ length: 48 }, (_, i) => ({
    id: i,
    service: `svc-${i % 6}`,
    region: i % 2 === 0 ? 'us-east-1' : 'eu-west-1',
    latencyMs: 10 + i,
  }));
  stages.push(
    measureSync('toon', 'Bijective tabular JSON -> @toon', 'stage', guardIters, 99, () => {}, () => {
      encodeToon({ status: 'ok', items: toonRows });
    }),
  );

  const casiBase = Array.from({ length: 800 }, (_, i) => `const line_${i} = ${i};`).join('\n');
  const casiNext = Array.from({ length: 800 }, (_, i) => (i === 200 ? `const line_${i} = 9999;` : `const line_${i} = ${i};`)).join('\n');
  stages.push(
    measureSync('casi_delta', 'Cross-turn inverted-index delta', 'stage', guardIters, 99, () => {}, () => {
      const idx = createCasiIndex();
      idx.ingest(casiBase, 'r0', 0);
      idx.ingest(casiNext, 'r1', 1);
    }),
  );

  // Adversarial & hot-path stress guards (fresh nonces prevent Map.get() short-circuits)
  const guards: LatencyBenchRow[] = [];

  const unclosedBody = Array.from({ length: 8 }, (_, i) => `Rule ${i}: keep strict API boundaries.`.repeat(4)).join('\n\n');
  const unclosedInputs = Array.from(
    { length: totalGuardRuns },
    (_, k) => '<!--unclosed '.repeat(2700) + `\n\n${unclosedBody}\nnonce=${k}`,
  );
  guards.push(
    measureSync('35 KB unclosed <!--', 'compileStaticText (linear, uncached)', 'guard', guardIters, 99, () => {}, (idx) => {
      compileStaticText(unclosedInputs[idx]!);
    }),
  );

  // 15 x 40 KB ACDC epochs (unique tail nonce per run exercises real digest + payback math)
  const epochRaw = Array.from(
    { length: 15 },
    (_, idx) =>
      Array.from(
        { length: 650 },
        (__, line) => `2026-11-20T12:00:${String(line % 60).padStart(2, '0')}Z INFO epoch=${idx} item=${line} ok=true`,
      ).join('\n'),
  );
  const acdcRunSets = Array.from({ length: totalGuardRuns }, (_, k) =>
    epochRaw.map((blk, idx) => (idx === 14 ? `${blk}\n2026-11-20T12:59:00Z INFO run=${k}` : blk)),
  );
  const runEpochPass = (idx: number) => {
    const texts = [...acdcRunSets[idx]!];
    const blocks: TextEpochBlock[] = texts.map((_, bIdx) => ({
      msgIndex: bIdx + 1,
      refId: `ep_${bIdx}`,
      getText: () => texts[bIdx]!,
      setText: (next) => {
        texts[bIdx] = next;
      },
    }));
    planAndApplyTextEpochs({
      blocks,
      totalMessages: texts.length + 8,
      model: 'claude-opus-5-5',
      totalPromptTokens: 160_000,
      keepTailMessages: 6,
    });
  };
  const acdcRow = measureSync(
    '600 KB ACDC epochs',
    '15×40 KB digest + payback (uncached)',
    'guard',
    guardIters,
    99,
    () => {},
    runEpochPass,
  );
  guards.push(acdcRow);
  stages.push({ ...acdcRow, label: 'acdc_epoch', kind: 'stage' });

  const blob = 'x'.repeat(30_000);
  const blobToonInput = Array.from({ length: 10 }, (_, i) => ({ id: i, payload: blob.slice(0, 3000) }));
  const blobCleanInputs = Array.from({ length: totalGuardRuns }, (_, k) => `${blob}\n\n\n\n\ntail_${k}`);
  const blobDigestInputs = Array.from({ length: totalGuardRuns }, (_, k) => `${blob}\nerror line ${k}`);
  const blobStaticInputs = Array.from({ length: totalGuardRuns }, (_, k) => `${blob}\n${'line two\n'.repeat(10)}n=${k}`);
  guards.push(
    measureSync('30 KB unbroken blob', 'clean + digest + static + toon (uncached)', 'guard', guardIters, 99, () => {}, (idx) => {
      cleanToolOutput(blobCleanInputs[idx]!);
      extractStructuralDigest(blobDigestInputs[idx]!, 'r_blob');
      compileStaticText(blobStaticInputs[idx]!);
      encodeToon(blobToonInput);
    }),
  );

  const enc = new TextEncoder();
  const respBlobIters = Math.min(guardIters, 40);
  const respBlobPayloads = Array.from({ length: respBlobIters + 3 }, (_, k) =>
    enc.encode(
      JSON.stringify({
        model: 'gpt-6-astra',
        instructions: 'Follow repository guidelines strictly.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `${'a'.repeat(30_000)}\nnonce=${k}` }],
          },
        ],
      }),
    ),
  );
  guards.push(
    await measureAsync(
      '30 KB blob (Responses)',
      'OpenAI Responses (no O(M^2) BPE)',
      'guard',
      respBlobIters,
      99,
      resetAllCaches,
      async (idx) => {
        await transformOpenAIResponses(respBlobPayloads[idx]!, { compress: true });
      },
    ),
  );

  const dottedLine = 'sub.domain.segment.'.repeat(2600);
  const dottedBase = [
    '2026-11-20T10:00:00Z INFO start run',
    ...Array.from({ length: 1200 }, (_, i) => `2026-11-20T10:00:${String(i % 60).padStart(2, '0')}Z INFO worker step ${i} in 11ms`),
    `2026-11-20T10:01:00Z INFO ${dottedLine}`,
    '2026-11-20T10:02:00Z INFO see pkg.sub-module.handler.ts:42',
  ].join('\n');
  const dottedInputs = Array.from({ length: totalGuardRuns }, (_, k) => `${dottedBase}\n2026-11-20T10:03:00Z INFO run=${k}`);
  guards.push(
    measureSync('50 KB dotted line', 'cleanToolOutput (no backtrack)', 'guard', guardIters, 99, () => {}, (idx) => {
      cleanToolOutput(dottedInputs[idx]!);
    }),
  );

  // 1.90 MiB events.jsonl reverse tail scan
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-bench-lat-'));
  try {
    const eventsPath = path.join(tmpDir, 'events.jsonl');
    const makeEventLine = (sessionId: string, ts: string) =>
      JSON.stringify({
        ts,
        model: 'claude-fable-5-20260609',
        status: 200,
        compressed: true,
        input_tokens: 1200,
        cache_read_tokens: 18000,
        cache_create_tokens: 0,
        compressed_chars: 42000,
        image_tokens: 2156,
        text_hygiene_saved_tokens: 640,
        text_hygiene_stages: ['tscg', 'toon', 'casi_delta'],
        session_id: sessionId,
        note: 'x'.repeat(900),
      });
    const oldLine = makeEventLine('bench-sess-old', '2026-11-20T08:00:00.000Z');
    const curLine = makeEventLine('bench-sess-cur', '2026-11-20T12:00:00.000Z');
    const lineBytes = Buffer.byteLength(oldLine) + 1;
    const targetBytes = Math.round(1.9 * 1024 * 1024);
    const oldCount = Math.max(1, Math.ceil(targetBytes / lineBytes) - 16);
    fs.writeFileSync(eventsPath, `${oldLine}\n`.repeat(oldCount) + `${curLine}\n`.repeat(16));

    guards.push(
      measureSync('1.90 MiB events.jsonl', 'readTurnReport reverse tail', 'guard', guardIters, 99, () => {}, () => {
        readTurnReport(eventsPath);
      }),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRenderCache();
    clearFactSheetCache();
  }

  return { requests, guards, stages };
}

function parseCliArgs(argv: readonly string[]): { quick: boolean; json: boolean; iterations?: number } {
  let quick = false;
  let json = false;
  let iterations: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick') quick = true;
    else if (a === '--json') json = true;
    else if (a === '--iterations' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (Number.isFinite(n) && n > 0) iterations = n;
      i++;
    }
  }
  return { quick, json, iterations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = parseCliArgs(process.argv.slice(2));
  const suite = await runLatencyBenchmarks({ quick: cli.quick, iterations: cli.iterations });
  if (cli.json) {
    console.log(JSON.stringify(suite, null, 2));
  } else {
    const printSection = (title: string, rows: readonly LatencyBenchRow[]) => {
      console.log(`\n${title}`);
      console.log('Label'.padEnd(26) + 'Iters'.padStart(7) + 'Cold ms'.padStart(10) + 'p50 ms'.padStart(10) + 'p95 ms'.padStart(10) + 'p99 ms'.padStart(10) + '  Details');
      console.log('-'.repeat(92));
      for (const r of rows) {
        console.log(
          r.label.padEnd(26) +
            String(r.iterations).padStart(7) +
            r.coldMs.toFixed(2).padStart(10) +
            r.p50Ms.toFixed(2).padStart(10) +
            r.p95Ms.toFixed(2).padStart(10) +
            r.p99Ms.toFixed(2).padStart(10) +
            `  ${r.sublabel}`,
        );
      }
    };
    printSection('20-Turn Agent Request Latency', suite.requests);
    printSection('4-Stage Text Hygiene Microbenchmarks', suite.stages);
    printSection('Adversarial & Hot-Path Stress Guards', suite.guards);
  }
}
