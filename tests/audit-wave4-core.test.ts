import { afterEach, describe, expect, it } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { gptTokenCount } from '../src/core/gpt-tokens.js';
import { renderTextToImages } from '../src/core/library.js';
import { openAIChatToAnthropicMessage } from '../src/core/messages-chat-bridge.js';
import { openAIResponseToAnthropicMessage } from '../src/core/messages-responses-bridge.js';
import { computeOpenAISessionBaselineInputEff } from '../src/core/openai-savings.js';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from '../src/core/openai.js';
import { effectiveRow, resolvePriceRates } from '../src/core/pricing.js';
import { NL_SENTINEL } from '../src/core/render.js';
import { compileStaticText, compileToolSchemas } from '../src/core/schema-compiler.js';
import { extractStructuralDigest, planAndApplyTextEpochs, type TextEpochBlock } from '../src/core/text-history.js';
import { applyAnthropicTextHygiene, cleanToolOutput } from '../src/core/text-hygiene.js';
import { decodeToon, encodeToon } from '../src/core/toon.js';
import { countVisualRows, transformRequest, truncateForBudget } from '../src/core/transform.js';

describe('Wave 4 Core Engine & Benchmark P0/P1 Regressions', () => {
  const savedEnv: Record<string, string | undefined> = {
    FICHE_PRICES: process.env.FICHE_PRICES,
    INKLING_PRICES: process.env.INKLING_PRICES,
    FICHE_GPT_PROFILES: process.env.FICHE_GPT_PROFILES,
    INKLING_GPT_PROFILES: process.env.INKLING_GPT_PROFILES,
    FICHE_MODELS: process.env.FICHE_MODELS,
    INKLING_MODELS: process.env.INKLING_MODELS,
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setAllowedModelBases(null);
  });

  describe('schema-compiler.ts', () => {
    it('preserves $&, $$, $\', $` inside inline backticks during HTML comment removal', () => {
      const special = '`echo "$& $$ $\' $`"`';
      const body = Array.from(
        { length: 20 },
        (_, i) => `Rule ${i}:   strictly   preserve   inline   tokens   and   whitespace.   `,
      ).join('\n');
      const input = `<!-- strip this comment -->\nUse ${special} carefully.\n\n${body}`;
      const res = compileStaticText(input);
      expect(res.changed).toBe(true);
      expect(res.text).toContain(special);
      expect(res.text).not.toContain('<!-- strip this comment -->');
    });

    it('protects Claude Agent SDK identity line and treats line-leading closed ```foo``` as prose', () => {
      const sdkLine = "You are a Claude agent, built on Anthropic's Claude Agent SDK.   keep";
      const inlineTriple = '```inline``` word   with   extra   spaces';
      const body = Array.from(
        { length: 18 },
        (_, i) => `Guideline ${i}:   maintain   invariants   cleanly   across   files.   `,
      ).join('\n');
      const input = `${sdkLine}\n\n${inlineTriple}\n\n<!-- outer -->\n${body}`;
      const res = compileStaticText(input);
      expect(res.changed).toBe(true);
      expect(res.text).toContain(sdkLine);
      expect(res.text).toContain('```inline``` word with extra spaces');
      expect(res.text).not.toContain('<!-- outer -->');
    });

    it('keeps shared multi-paragraph fenced blocks intact inside deduplicateSharedParagraphs', () => {
      const sharedFence = [
        '```json',
        '{"step": 1, "note": "' + 'x'.repeat(130) + '"}',
        '',
        '{"step": 2, "note": "' + 'y'.repeat(130) + '"}',
        '```',
      ].join('\n');
      const sharedProse =
        'Always validate absolute paths before invoking any filesystem mutation tool across workspace packages, and verify canonical realpath resolution against symlinks before writing files.';
      const tools = [0, 1, 2].map((idx) => ({
        name: `tool_${idx}`,
        description: `${sharedProse}\n\n${sharedFence}\n\nExecutes action ${idx}.`,
        input_schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { path: { type: 'string', title: 'Path', description: 'Canonical workspace path' } },
        },
      }));
      const res = compileToolSchemas(tools, 'anthropic');
      expect(res.changed).toBe(true);
      expect(tools[1]!.description).toContain(sharedFence);
      expect(tools[1]!.description).toContain('See [#T1] above.');
    });
  });

  describe('google.ts', () => {
    it('leaves unsealed tail native, keeps sealed chunks byte-identical across turns, and populates firstUserSha8', async () => {
      process.env.FICHE_PRICES = 'kosha';
      const buildReq = (extraTurns: number) => {
        const contents: Array<Record<string, unknown>> = [
          { role: 'user', parts: [{ text: 'SESSION_ANCHOR_42: inspect module state' }] },
        ];
        for (let i = 0; i < 20 + extraTurns; i++) {
          contents.push({
            role: 'model',
            parts: [{ functionCall: { name: 'read', args: { path: `src/f${i}.ts` } } }],
          });
          contents.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name: 'read',
                response: { output: (`line_${i}_payload_entry `).repeat(120) },
              },
            }],
          });
        }
        contents.push({ role: 'user', parts: [{ text: `Follow-up question ${extraTurns}` }] });
        return new TextEncoder().encode(JSON.stringify({ contents }));
      };

      const r1 = await transformGoogleGenerateContent(buildReq(0), 'gemini-4-argon', {
        compress: true,
        collapseHistory: true,
        compressToolResults: false,
      });
      const r2 = await transformGoogleGenerateContent(buildReq(1), 'gemini-4-argon', {
        compress: true,
        collapseHistory: true,
        compressToolResults: false,
      });

      expect(r1.info.firstUserSha8).toBeTruthy();
      expect(r2.info.firstUserSha8).toBe(r1.info.firstUserSha8);
      expect(r1.info.historyReason).toBe('collapsed');
      expect(r1.info.collapsedTurns).toBe(r2.info.collapsedTurns);
      expect(r1.info.imageCount).toBeGreaterThan(0);
      expect(r1.info.imagePngs).toHaveLength(r2.info.imagePngs?.length ?? 0);
      for (let i = 0; i < (r1.info.imagePngs?.length ?? 0); i++) {
        expect(Buffer.from(r2.info.imagePngs![i]!).equals(Buffer.from(r1.info.imagePngs![i]!))).toBe(true);
      }
      const out1 = JSON.parse(new TextDecoder().decode(r1.body)) as { contents: Array<{ parts: unknown[] }> };
      const out2 = JSON.parse(new TextDecoder().decode(r2.body)) as { contents: Array<{ parts: unknown[] }> };
      expect(JSON.stringify(out2.contents[0]!.parts[0])).toBe(JSON.stringify(out1.contents[0]!.parts[0]));
    });

    it('preserves hygiene telemetry on malformed-contents early exits and merges droppedCodepoints', async () => {
      const prettyJson = JSON.stringify(
        { items: Array.from({ length: 24 }, (_, i) => ({ id: i, host: `h-${i}`, ok: true })) },
        null,
        2,
      );
      const malformedSysParts = new TextEncoder().encode(
        JSON.stringify({
          systemInstruction: { parts: 'bad' },
          contents: [
            { role: 'user', parts: [{ text: 'anchor user' }] },
            { role: 'user', parts: [{ functionResponse: { name: 'fetch', response: { output: prettyJson } } }] },
          ],
        }),
      );
      const resEarly = await transformGoogleGenerateContent(malformedSysParts, 'gemini-3.6-flash', {
        compress: true,
        textHygiene: 'on',
      });
      expect(resEarly.info.compressed).toBe(true);
      expect(resEarly.info.reason).toBe('text_hygiene');
      expect(resEarly.info.textHygieneSavedTokens ?? 0).toBeGreaterThan(0);
      expect(resEarly.info.firstUserSha8).toBeTruthy();

      const bigSysWithDroppedCp =
        'System rule with unmapped selector\uFE0F marker. '.repeat(260);
      const longToolWithDroppedCp =
        Array.from({ length: 220 }, (_, i) => `row_${i} status=ok symbol=\uFE0F`).join('\n');
      const resMerge = await transformGoogleGenerateContent(
        new TextEncoder().encode(
          JSON.stringify({
            systemInstruction: { parts: [{ text: bigSysWithDroppedCp }] },
            contents: [
              { role: 'user', parts: [{ text: 'inspect' }] },
              { role: 'model', parts: [{ functionCall: { name: 'dump', args: {} } }] },
              { role: 'user', parts: [{ functionResponse: { name: 'dump', response: { output: longToolWithDroppedCp } } }] },
            ],
          }),
        ),
        'gemini-3.6-flash',
        { compress: true, collapseHistory: false, minToolResultChars: 1000 },
      );
      expect(resMerge.info.compressed).toBe(true);
      expect(resMerge.info.droppedChars ?? 0).toBeGreaterThan(0);
      expect(Object.keys(resMerge.info.droppedCodepointsTop ?? {}).length).toBeGreaterThan(0);
    });
  });

  describe('casi-delta & text-hygiene', () => {
    it('keeps CASI blocks strictly monotonic across turn appends without verbatim<->delta flapping', () => {
      const docA = Array.from({ length: 40 }, (_, i) => `export const alpha_${i} = ${i};`).join('\n');
      const makeTurnReq = (extraPairs: number) => {
        const messages: Array<Record<string, unknown>> = [
          { role: 'user', content: [{ type: 'text', text: 'start' }] },
        ];
        for (let i = 0; i < 6 + extraPairs; i++) {
          messages.push({
            role: 'assistant',
            content: [{ type: 'tool_use', id: `t_${i}`, name: 'read', input: { i } }],
          });
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: `t_${i}`, content: i === 0 || i === 5 ? docA : `step ${i}` }],
          });
        }
        return { model: 'claude-fable-5-20260609', messages };
      };

      const reqT1 = makeTurnReq(0);
      const reqT2 = makeTurnReq(2);
      applyAnthropicTextHygiene(reqT1);
      applyAnthropicTextHygiene(reqT2);

      // Message index 12 (i=5) was compressed on Turn 1 and stays identical on Turn 2
      expect(reqT2.messages[12]).toEqual(reqT1.messages[12]);
      expect(JSON.stringify(reqT1.messages[12])).toContain('[fiche cas:');
    });

    it('encodes single-line minified tabular JSON to @toon in auto mode and folds logs across blank lines', () => {
      const tabular = {
        status: 'ok',
        rows: Array.from({ length: 24 }, (_, i) => ({
          id: i,
          shard: `shard-${i % 4}`,
          region: 'us-east-1',
          ok: true,
        })),
      };
      const singleLineJson = JSON.stringify(tabular);
      expect(singleLineJson.includes('\n')).toBe(false);
      const resToon = cleanToolOutput(singleLineJson);
      expect(resToon.changed).toBe(true);
      expect(resToon.stages).toContain('toon');
      expect(decodeToon(resToon.text)).toEqual(tabular);

      const spacedLog = [
        '2026-11-21T10:00:00Z INFO start',
        ...Array.from(
          { length: 20 },
          (_, i) => `2026-11-21T10:01:${String(i).padStart(2, '0')}Z INFO worker=10.0.0.1:8080 job ${i} ok\n`,
        ),
        '2026-11-21T10:02:00Z ERROR failed at src/app.ts:9',
      ].join('\n');
      const resFold = cleanToolOutput(spacedLog);
      expect(resFold.changed).toBe(true);
      expect(resFold.stages).toContain('log_fold');
      const foldMarkers = resFold.text.match(/\[\.\.\. \d+ similar lines folded \.\.\.\]/g) ?? [];
      expect(foldMarkers).toHaveLength(1);
    });
  });

  describe('gpt-tokens & openai.ts', () => {
    it('handles 30 KB unbroken blob in transformOpenAIResponses under 50ms', async () => {
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: 'gpt-6-astra',
          instructions: 'Keep edits concise.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'a'.repeat(30_000) }] }],
        }),
      );
      const t0 = performance.now();
      const res = await transformOpenAIResponses(body, { compress: true });
      const dt = performance.now() - t0;
      expect(dt).toBeLessThan(50);
      expect(res.body.byteLength).toBeGreaterThan(0);
      expect(gptTokenCount('a'.repeat(30_000))).toBe(Math.ceil(30_000 / 3.5));
    });

    it('keeps Segment 0 byte-identical under factSheetScope=combined and never sets compressed=true on raw serializedByteLimit fallback', async () => {
      const buildGrokItems = (pairs: number) => {
        const items: Array<Record<string, unknown>> = [
          { role: 'user', content: 'start task with key deadbeef0123' },
        ];
        for (let i = 0; i < pairs; i++) {
          items.push({ role: 'assistant', content: `Working step ${i} `.repeat(35) });
          items.push({ type: 'function_call', call_id: `c_${i}`, name: 'read', arguments: `{"path":"src/f${i}.ts"}` });
          items.push({ type: 'function_call_output', call_id: `c_${i}`, output: (`entry_${i} path=/tmp/a${i}.ts `).repeat(95) });
        }
        items.push({ role: 'user', content: 'latest ask' });
        return items;
      };

      const g1 = await transformOpenAIResponses(
        new TextEncoder().encode(JSON.stringify({ model: 'grok-4.5', instructions: 'Rule '.repeat(300), input: buildGrokItems(4) })),
        { minCompressChars: 1 },
      );
      const g2 = await transformOpenAIResponses(
        new TextEncoder().encode(JSON.stringify({ model: 'grok-4.5', instructions: 'Rule '.repeat(300), input: buildGrokItems(8) })),
        { minCompressChars: 1 },
      );
      const out1 = JSON.parse(new TextDecoder().decode(g1.body)) as { input: Array<{ content?: unknown[] }> };
      const out2 = JSON.parse(new TextDecoder().decode(g2.body)) as { input: Array<{ content?: unknown[] }> };
      // Static slab (0) and Segment 0 (1) remain byte-identical as later segments seal
      expect(JSON.stringify(out2.input[0])).toBe(JSON.stringify(out1.input[0]));
      expect(JSON.stringify(out2.input[1])).toBe(JSON.stringify(out1.input[1]));

      // serializedByteLimit fallback when raw body fits under limit must NOT report compressed: true
      process.env.FICHE_GPT_PROFILES = JSON.stringify({
        'gpt-5.6-sol': { maxSerializedRequestBytes: 40_000 },
      });
      const rawChat = new TextEncoder().encode(
        JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [
            { role: 'system', content: Array.from({ length: 140 }, (_, i) => `Rule ${i}: check invariant ${i} cleanly.`).join('\n') },
            { role: 'user', content: 'hello' },
          ],
        }),
      );
      expect(rawChat.byteLength).toBeLessThan(40_000);
      const chatRes = await transformOpenAIChatCompletions(rawChat, { compress: true, imageCompress: true });
      expect(chatRes.info.reason).toBe('serialized_request_limit');
      expect(chatRes.info.sizeLimitOutcome).toBe('fallback');
      expect(chatRes.info.compressed).toBe(false);
      expect(chatRes.info.imageCount).toBe(0);
      expect(chatRes.info.imageTokens).toBe(0);
      expect(chatRes.info.baselineImagedTokens).toBe(0);
      expect(Buffer.from(chatRes.body).equals(Buffer.from(rawChat))).toBe(true);
    });
  });

  describe('text-history.ts & transform.ts', () => {
    it('rejects bracketed timestamped logs as JSON and makes cliff-triggered epochs sticky across turns', () => {
      const tsLog = [
        '[2026-11-21T10:00:00Z] INFO shard=1 [ok]',
        ...Array.from({ length: 24 }, (_, i) => `[2026-11-21T10:00:${String(i).padStart(2, '0')}Z] INFO job=${i} [ok]`),
        '[2026-11-21T10:01:00Z] ERROR aborted [fail]',
      ].join('\n');
      const digest = extractStructuralDigest(tsLog, 'r_ts');
      expect(digest).toContain('log/output digest');
      expect(digest).not.toContain('structured data');

      process.env.FICHE_PRICES = 'kosha';
      const makeLog = (idx: number) =>
        [
          `2026-11-21T10:00:00Z INFO batch=${idx} start`,
          ...Array.from({ length: 420 }, (_, i) => `2026-11-21T10:01:${String(i % 60).padStart(2, '0')}Z INFO worker=${idx} item=${i} ok=true`),
          `2026-11-21T10:02:00Z INFO batch=${idx} done`,
        ].join('\n');

      // Turn T: 103k -> 98k crosses Haiku 5.5 100k cliff (5x jump), sealing Epoch 0 even with downstream blocks
      const makeBlocks = (count: number) =>
        Array.from({ length: count }, (_, i) => {
          let val = makeLog(i);
          return {
            msgIndex: i + 1,
            refId: `ep_${i}`,
            getText: () => val,
            setText: (next: string) => {
              val = next;
            },
          } satisfies TextEpochBlock;
        });

      const bT1 = makeBlocks(6);
      const rT1 = planAndApplyTextEpochs({
        blocks: bT1,
        totalMessages: 10,
        model: 'claude-haiku-5-5',
        totalPromptTokens: 103_000,
        keepTailMessages: 6,
        expectedOutputTokens: 2000,
      });
      expect(rT1.changed).toBe(true);
      expect(rT1.cliffAvoided?.at).toBe(100_000);

      // Turn T+1: prompt grows past cliff (108k -> 103k > 100k). Epoch 0 must stay sealed (never revert to verbatim)!
      const bT2 = makeBlocks(7);
      const rT2 = planAndApplyTextEpochs({
        blocks: bT2,
        totalMessages: 11,
        model: 'claude-haiku-5-5',
        totalPromptTokens: 108_000,
        keepTailMessages: 6,
        expectedOutputTokens: 2000,
      });
      expect(rT2.changed).toBe(true);
      expect(bT2[0]!.getText()).toBe(bT1[0]!.getText());
    });

    it('accounts for NL_SENTINEL padding in truncateForBudget and does not count phantom truncations on budget skip', async () => {
      const reflowed = Array.from({ length: 2500 }, (_, i) => `2026-11-21T12:00:00Z log entry ${i} val=${i}`).join(
        NL_SENTINEL,
      );
      const cols = 120;
      const paged = truncateForBudget(reflowed, 3, cols, 6000, 50);
      expect(paged.truncated).toBe(true);
      expect(paged.text).toContain('[ fiche paging:');
      const totalRows = countVisualRows(paged.text.split('\n\n[ fiche paging:')[0]!, cols);
      expect(totalRows).toBeLessThanOrEqual(3 * 50);

      // Request with 99 native images (headroom left = 100 - 4 - 99 = 0? Use 95 native images so 1 image headroom left,
      // then a 2-image tool_result fails imgs.length > imageHeadroom(info) after truncateForBudget ran).
      const bigTool = Array.from({ length: 2400 }, (_, i) => `line_${i}: ` + 'x'.repeat(30)).join('\n');
      const fillerImg = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
      const req = {
        model: 'claude-fable-5-20260609',
        max_tokens: 64,
        system: 'Short system.',
        messages: [
          { role: 'user', content: Array.from({ length: 95 }, () => fillerImg) },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: bigTool }] },
        ],
      };
      const out = await transformRequest(new TextEncoder().encode(JSON.stringify(req)), {
        compress: true,
        collapseHistory: false,
        maxImagesPerToolResult: 4,
      });
      expect(out.info.imageBudgetSkips ?? 0).toBeGreaterThan(0);
      expect(out.info.truncatedToolResults ?? 0).toBe(0);
      expect(out.info.omittedChars ?? 0).toBe(0);
    });
  });

  describe('toon.ts, pricing.ts, openai-savings.ts, library.ts, bridges', () => {
    it('guards lone surrogates in toon, honors band 3600s cwt, prices selfBusted/hygiene savings, and uses msg_fiche fallback', async () => {
      const surrogateKey = 'bad_\uD800_key';
      const payload = {
        [surrogateKey]: Array.from({ length: 8 }, (_, i) => ({ id: i, svc: `svc-${i}`, ok: true })),
      };
      expect(() => encodeToon(payload)).not.toThrow();
      expect(encodeToon(payload)).toBeNull();

      process.env.FICHE_PRICES = 'kosha';
      const customBandRow = {
        p: 'anthropic',
        in: 1,
        out: 5,
        cr: 0.1,
        cw: 1.25,
        cw1h: 2,
        cwt: [[300, 1.25], [3600, 2]] as Array<[number, number]>,
        bands: [
          {
            at: 100_000,
            in: 2,
            out: 10,
            cr: 0.2,
            cwt: [[300, 2.5], [3600, 4.75]] as Array<[number, number]>,
          },
        ],
      };
      const eff = effectiveRow(customBandRow, { promptTokens: 150_000 });
      expect(eff?.cw1h).toBe(4.75);
      expect(resolvePriceRates('claude-opus-5-5', { promptTokens: 0, ttlSec: 3600 }).write).toBe(2);

      // selfBusted growth priced at writeRate when cacheWriteTokens > 0
      const busted = computeOpenAISessionBaselineInputEff({
        inputTokens: 10_000,
        cachedTokens: 0,
        cacheWriteTokens: 2_000,
        imageTokens: 0,
        baselineImagedTokens: 0,
        textHygieneSavedTokens: 500,
        model: 'claude-opus-5-5',
        warmth: { warm: true, selfBusted: true, prevPrefixTokens: 8_000 },
      });
      // Unproxied would have reused 8,000 @ 0.05 + (10,500 - 8,000) @ 1.25 = 400 + 3,125 = 3,525
      expect(busted).toBeCloseTo(3_525, 1);

      const hygieneEff = computeOpenAISessionBaselineInputEff({
        inputTokens: 10_000,
        cachedTokens: 8_000,
        cacheWriteTokens: 0,
        imageTokens: 0,
        baselineImagedTokens: 0,
        textHygieneSavedTokens: 1_500,
        prevHygieneSavedTokens: 1_000,
        model: 'gpt-5.6-sol',
      });
      // Actual = 2000 + 8000*0.1 = 2800; baseline adds 1000*0.1 + 500*1.0 = 600 -> 3400
      expect(hygieneEff).toBeCloseTo(3400, 1);

      const rendered = await renderTextToImages('hello world', { model: 'gpt-6.2-sol' });
      expect(rendered.pages.length).toBe(1);

      expect(openAIChatToAnthropicMessage({ choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] }, 'm').id).toBe('msg_fiche');
      expect(openAIResponseToAnthropicMessage({ output: [] }, 'm').id).toBe('msg_fiche');
    });
  });
});
