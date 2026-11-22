import { afterEach, describe, expect, it } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { createCasiIndex } from '../src/core/casi-delta.js';
import { gptTokenCount } from '../src/core/gpt-tokens.js';
import { createProxy } from '../src/core/proxy.js';
import { prefersText, readerTier } from '../src/core/reader-tier.js';
import { compileStaticText, compileToolSchemas } from '../src/core/schema-compiler.js';
import { extractStructuralDigest, planAndApplyTextEpochs } from '../src/core/text-history.js';
import { decodeToon, encodeToon } from '../src/core/toon.js';

describe('novel 4-layer text compression (TOON, CASI, TSCG, ACDC) & gemini-4-neon', () => {
  const savedPrices = process.env.INKLING_PRICES;
  const savedModels = process.env.INKLING_MODELS;
  const savedForce = process.env.INKLING_FORCE_IMAGES;

  afterEach(() => {
    if (savedPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = savedPrices;
    if (savedModels === undefined) delete process.env.INKLING_MODELS;
    else process.env.INKLING_MODELS = savedModels;
    if (savedForce === undefined) delete process.env.INKLING_FORCE_IMAGES;
    else process.env.INKLING_FORCE_IMAGES = savedForce;
    setAllowedModelBases(null);
  });

  it('TOON encodes uniform tables losslessly with exact bijective round-trip and >=40% savings over minified JSON', () => {
    const topArray = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      service: `svc-${i % 3}`,
      healthy: i % 2 === 0,
      note: i === 0 ? 'true' : i === 1 ? '123' : i === 2 ? '~U' : i === 3 ? '[1,2]' : `line1|line2\nrow_${i}\\end`,
      tags: ['a', `b|${i}`],
      err: i % 5 === 0 ? null : undefined,
      ratio: i * 0.25,
    }));

    const toonArr = encodeToon(topArray);
    expect(toonArr).not.toBeNull();
    expect(decodeToon(toonArr!)).toEqual(topArray);

    const minTokens = gptTokenCount(JSON.stringify(topArray));
    const toonTokens = gptTokenCount(toonArr!);
    expect(toonTokens).toBeLessThanOrEqual(minTokens * 0.8);

    const realisticRows = Array.from({ length: 40 }, (_, i) => ({
      requestId: `req_${1000 + i}`,
      region: i % 2 === 0 ? 'us-central1' : 'europe-west1',
      service: 'checkout-api',
      status: 200,
      latencyMs: 12 + (i % 19),
      cacheHit: i % 3 !== 0,
    }));
    const toonRealistic = encodeToon(realisticRows);
    expect(toonRealistic).not.toBeNull();
    expect(decodeToon(toonRealistic!)).toEqual(realisticRows);
    expect(gptTokenCount(toonRealistic!)).toBeLessThanOrEqual(gptTokenCount(JSON.stringify(realisticRows)) * 0.6);

    const wrappedObj = {
      status: 'ok',
      total: 25,
      records: Array.from({ length: 25 }, (_, i) => ({
        file: `src/module_${i}.ts`,
        owner: 'team-core',
        coverage: 90 + (i % 10),
        trailingSpace: '  keep_ws  ',
        emptyStr: '',
      })),
    };
    const toonObj = encodeToon(wrappedObj);
    expect(toonObj).not.toBeNull();
    expect(decodeToon(toonObj!)).toEqual(wrappedObj);
  });

  it('CASI emits exact duplicates and anchor-aligned deltas with strict prefix invariance', () => {
    const baseLines = Array.from(
      { length: 70 },
      (_, i) => `export function computeStep_${i}(val: number): number { return val * ${i + 1}; }`,
    );
    const editedLines = [...baseLines];
    editedLines[20] = 'export function computeStep_20(val: number): number { return val * 999; }';
    editedLines[45] = 'export function computeStep_45(val: number): number { return val + 42; }';

    const fileV1 = baseLines.join('\n');
    const fileV2 = editedLines.join('\n');

    // Turn 1
    const c1 = createCasiIndex();
    const t1a = c1.ingest(fileV1, 'read_1');
    const t1b = c1.ingest(fileV1, 'read_2');
    const t1c = c1.ingest(fileV2, 'read_3');
    expect(t1a.changed).toBe(false);
    expect(t1b.changed).toBe(true);
    expect(t1b.kind).toBe('exact_dup');
    expect(t1b.savedChars / fileV1.length).toBeGreaterThan(0.95);
    expect(t1c.changed).toBe(true);
    expect(t1c.kind).toBe('delta');
    expect(t1c.text).toContain('+export function computeStep_20');
    expect(t1c.text).toContain('-export function computeStep_20');
    expect(t1c.savedChars / fileV2.length).toBeGreaterThan(0.75);

    // Turn 2 appends a 4th read — outputs 1..3 remain 100% byte-identical
    const c2 = createCasiIndex();
    const t2a = c2.ingest(fileV1, 'read_1');
    const t2b = c2.ingest(fileV1, 'read_2');
    const t2c = c2.ingest(fileV2, 'read_3');
    const t2d = c2.ingest(fileV2, 'read_4');
    expect(t2a.text).toBe(t1a.text);
    expect(t2b.text).toBe(t1b.text);
    expect(t2c.text).toBe(t1c.text);
    expect(t2d.changed).toBe(true);
  });

  it('TSCG compacts schema bloat and deduplicates boilerplate while preserving schemas & OAuth identity', () => {
    const sharedBoilerplate =
      'Follow the workspace safety protocol strictly: verify file existence before modifying, ' +
      'never fabricate identifiers, preserve formatting conventions, and confirm tests pass after changes.';

    const anthropicTools = Array.from({ length: 8 }, (_, i) => ({
      name: `tool_${i}`,
      description: `${sharedBoilerplate}\n\nExecutes action ${i} cleanly.\n----------------`,
      input_schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $comment: 'auto-generated schema metadata to strip',
        type: 'object',
        required: ['file_path'],
        properties: {
          file_path: { type: 'string', title: 'File Path', description: sharedBoilerplate },
          mode: { type: 'string', enum: ['fast', 'full'], description: '' },
        },
        additionalProperties: false,
      },
    }));

    const resAnth = compileToolSchemas(anthropicTools, 'anthropic');
    expect(resAnth.changed).toBe(true);
    expect(resAnth.savedTokens).toBeGreaterThan(100);
    expect(anthropicTools[0]!.input_schema).not.toHaveProperty('$schema');
    expect(anthropicTools[0]!.input_schema.properties.file_path).not.toHaveProperty('title');
    expect(anthropicTools[0]!.input_schema.properties.mode).not.toHaveProperty('description');
    expect(anthropicTools[0]!.input_schema.required).toEqual(['file_path']);
    expect(anthropicTools[0]!.input_schema.properties.mode.enum).toEqual(['fast', 'full']);
    expect(anthropicTools[1]!.description).toContain('See [#T1] above.');

    const singleLine = 'System rule instruction. '.repeat(100);
    expect(compileStaticText(singleLine).changed).toBe(false);

    const multiParaStatic = [
      'You are Claude Code, Anthropic\'s official CLI for Claude.',
      sharedBoilerplate +
        ' Additional context paragraph detail line describing project conventions, error handling guarantees, and strict path validation rules.',
      '```ts\nconst keep   =   1;\n```',
      'Always keep edits scoped to the requested modules, preserve public API signatures, verify unit tests cleanly, and cite only directly observed file paths and symbol names in final reports.',
      '<!-- internal build comment to strip safely -->\n========================================\n' +
        sharedBoilerplate +
        ' Additional context paragraph detail line describing project conventions, error handling guarantees, and strict path validation rules.',
      'When inspecting multi-provider routing telemetry, ensure prompt prefixes remain byte-identical across consecutive turns so server KV cache warmth is preserved without invalidation.',
      sharedBoilerplate +
        ' Additional context paragraph detail line describing project conventions, error handling guarantees, and strict path validation rules.',
    ].join('\n\n');
    const sRes = compileStaticText(multiParaStatic);
    expect(sRes.changed).toBe(true);
    expect(sRes.text).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(sRes.text).toContain('const keep   =   1;');
    expect(sRes.text).toContain('See [#S1] above.');
  });

  it('ACDC freezes completed epochs, preserves code signatures, keeps tail verbatim, and maintains prefix stability', () => {
    process.env.INKLING_PRICES = 'kosha';

    const makeCode = (idx: number) =>
      [
        `import { dep_${idx} } from './dep_${idx}.js';`,
        `export interface Config_${idx} { id: string; enabled: boolean; }`,
        ...Array.from(
          { length: 14 },
          (_, k) =>
            [
              `export function computeItem_${idx}_${k}(n: number): number {`,
              `  const normalized = Math.max(0, Math.min(1000, n + ${k}));`,
              `  const weight = dep_${idx}(normalized, ${k});`,
              `  const scaled = (normalized * 3 + weight) % 997;`,
              `  let acc = scaled;`,
              `  for (let step = 0; step < 4; step++) {`,
              `    acc = (acc * 31 + step + ${k}) >>> 0;`,
              `  }`,
              `  const bias = (acc ^ normalized) & 0xff;`,
              `  const clamped = Math.min(10_000, acc + bias);`,
              `  return clamped * 2 + ${k};`,
              `}`,
            ].join('\n'),
        ),
      ].join('\n');

    const preview = extractStructuralDigest(makeCode(0), 'r0');
    expect(preview).toContain('export function computeItem_0_0');
    expect(preview).toContain('[fiche epoch-digest r0');

    const turn1Blocks = Array.from({ length: 4 }, (_, i) => {
      let val = makeCode(i);
      return {
        msgIndex: i + 1,
        refId: `tr_${i}`,
        getText: () => val,
        setText: (next: string) => {
          val = next;
        },
      };
    });

    const res1 = planAndApplyTextEpochs({
      blocks: turn1Blocks,
      totalMessages: 6,
      model: 'gpt-6-astra',
      totalPromptTokens: 10_000,
      keepTailMessages: 3,
    });
    expect(res1.changed).toBe(true);
    expect(res1.sealedEpochs).toBeGreaterThanOrEqual(1);
    expect(res1.savedTokens).toBeGreaterThan(2000);
    // Live tail blocks (msgIndex >= 6 - 3 = 3) must stay untouched.
    expect(turn1Blocks[2]!.getText()).not.toContain('[fiche epoch-digest');
    expect(turn1Blocks[3]!.getText()).not.toContain('[fiche epoch-digest');

    // Append more messages on Turn 2: Epoch 0 blocks remain bit-identical and new tail stays verbatim!
    const turn2Blocks = Array.from({ length: 15 }, (_, i) => {
      let val = makeCode(i);
      return {
        msgIndex: i + 1,
        refId: `tr_${i}`,
        getText: () => val,
        setText: (next: string) => {
          val = next;
        },
      };
    });
    planAndApplyTextEpochs({
      blocks: turn2Blocks,
      totalMessages: 20,
      model: 'gpt-6-astra',
      totalPromptTokens: 35_000,
    });
    expect(turn2Blocks[0]!.getText()).toBe(turn1Blocks[0]!.getText());
    expect(turn2Blocks[1]!.getText()).toBe(turn1Blocks[1]!.getText());
    expect(turn2Blocks[13]!.getText()).not.toContain('[fiche epoch-digest');
    expect(turn2Blocks[14]!.getText()).not.toContain('[fiche epoch-digest');
  });

  it('guards gemini-4-neon as text-only with deep text compression and supports AI Studio & CloudCode-PA', async () => {
    expect(prefersText('gemini-4-neon', false)).toBe(true);
    expect(prefersText('google/gemini-4-neon-preview', false)).toBe(true);
    expect(readerTier('gemini-4-neon', false)).toBe('text');
    expect(prefersText('gemini-4-neon', true)).toBe(false);

    setAllowedModelBases(['gemini']);
    const noisyLog = [
      '2026-11-20T10:00:00Z INFO start suite',
      ...Array.from(
        { length: 45 },
        (_, i) => `2026-11-20T10:01:${String(i % 60).padStart(2, '0')}Z INFO worker=10.0.0.${(i % 3) + 1}:8080 job ${i} ok in ${10 + i}ms`,
      ),
      '2026-11-20T10:02:00Z ERROR boom at src/neon.ts:7',
    ].join('\n');
    const tabular = JSON.stringify(
      { rows: Array.from({ length: 20 }, (_, i) => ({ id: i, host: 'neon', ok: true })) },
      null,
      2,
    );

    const seenUrls: string[] = [];
    const seenBodies: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const r = input instanceof Request ? input : new Request(String(input), init);
      seenUrls.push(r.url);
      seenBodies.push(await r.text());
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const events: Array<{ info?: { compressed?: boolean; imageCount?: number; textHygieneSavedTokens?: number } }> = [];
    try {
      const proxy = createProxy({
        passthroughUpstream: 'https://gemini.test',
        transform: {},
        onRequest: (e) => {
          events.push({ info: e.info });
        },
      });
      const reqPayload = {
        contents: [
          { role: 'user', parts: [{ text: 'run checks' }] },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'bash', response: { output: noisyLog } } },
              { functionResponse: { name: 'metrics', response: { output: tabular } } },
            ],
          },
        ],
      };

      const r1 = await proxy(
        new Request('http://127.0.0.1/v1beta/models/gemini-4-neon:generateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(reqPayload),
        }),
      );
      expect(r1.status).toBe(200);
      await r1.text();
      await new Promise((r) => setTimeout(r, 15));
      expect(events.at(-1)!.info?.compressed).toBe(true);
      expect(events.at(-1)!.info?.imageCount).toBe(0);
      expect(events.at(-1)!.info?.textHygieneSavedTokens ?? 0).toBeGreaterThan(0);
      expect(seenBodies.at(-1)!).toContain('@toon');
      expect(seenBodies.at(-1)!).not.toContain('inlineData');
      expect(seenUrls.some((u) => u.includes(':countTokens'))).toBe(false);

      const r2 = await proxy(
        new Request('http://127.0.0.1/v1internal:streamGenerateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-4-neon', request: reqPayload }),
        }),
      );
      expect(r2.status).toBe(200);
      await r2.text();
      await new Promise((r) => setTimeout(r, 15));
      expect(events.at(-1)!.info?.compressed).toBe(true);
      expect(events.at(-1)!.info?.imageCount).toBe(0);
      expect(seenUrls.some((u) => u.includes(':countTokens'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
