import { afterEach, describe, expect, it } from 'vitest';
import {
  getAllowedModelBases,
  isFicheSupportedModel,
  setAllowedModelBases,
} from '../src/core/applicability.js';
import { createCasiIndex } from '../src/core/casi-delta.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import {
  appendPinBlock,
  foldPins,
  pinCommandResponse,
  stripPinCommands,
} from '../src/core/pin.js';
import { effectiveRow, resolvePriceRates } from '../src/core/pricing.js';
import { createProxy } from '../src/core/proxy.js';
import { shouldImageModel } from '../src/core/reader-tier.js';
import { compileStaticText, compileToolSchemas } from '../src/core/schema-compiler.js';
import { extractStructuralDigest, planAndApplyTextEpochs, type TextEpochBlock } from '../src/core/text-history.js';
import { cleanToolOutput, isCodeOrDiffProtected } from '../src/core/text-hygiene.js';
import { decodeToon, encodeToon } from '../src/core/toon.js';

describe('Wave 1 P0 audit regressions', () => {
  const savedPrices = process.env.FICHE_PRICES;
  const savedLegacyPrices = process.env.INKLING_PRICES;
  const savedModels = process.env.FICHE_MODELS;
  const savedLegacyModels = process.env.INKLING_MODELS;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    if (savedPrices === undefined) delete process.env.FICHE_PRICES;
    else process.env.FICHE_PRICES = savedPrices;
    if (savedLegacyPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = savedLegacyPrices;
    if (savedModels === undefined) delete process.env.FICHE_MODELS;
    else process.env.FICHE_MODELS = savedModels;
    if (savedLegacyModels === undefined) delete process.env.INKLING_MODELS;
    else process.env.INKLING_MODELS = savedLegacyModels;
    setAllowedModelBases(null);
    globalThis.fetch = realFetch;
  });

  describe('casi-delta.ts', () => {
    it('respects minBaseTurnGroup so live tail cannot reference optical-collapsed prefix', () => {
      const casi = createCasiIndex();
      const baseLines = Array.from({ length: 24 }, (_, i) => `export const entry_${i} = 'value_${i}_abcdef';`);
      const baseText = baseLines.join('\n');
      const editedLines = [...baseLines];
      editedLines[12] = `export const entry_12 = 'MODIFIED_12_abcdef';`;
      const editedText = editedLines.join('\n');

      // Base lives in turnGroup 1 (which gets collapsed into optical history with cutoff turnGroup 4)
      expect(casi.ingest(baseText, 'r_old', 1, 4).changed).toBe(false);

      // Exact duplicate in live tail (turnGroup 5) with minBaseTurnGroup=4 must NOT emit a pointer to turnGroup 1
      const dupBlocked = casi.ingest(baseText, 'r_live_dup_blocked', 5, 4);
      expect(dupBlocked.changed).toBe(false);
      expect(dupBlocked.text).toBe(baseText);

      // Edited variant in live tail (turnGroup 6) with minBaseTurnGroup=4 must NOT delta against turnGroup 1
      // (test on a fresh index before r_live_dup is indexed at turnGroup 5!)
      const casiDeltaOnly = createCasiIndex();
      expect(casiDeltaOnly.ingest(baseText, 'r_old', 1, 4).changed).toBe(false);
      const deltaBlocked = casiDeltaOnly.ingest(editedText, 'r_live_delta', 6, 4);
      expect(deltaBlocked.changed).toBe(false);
      expect(deltaBlocked.text).toBe(editedText);

      // Subsequent duplicate in live tail (turnGroup 7) CAN reference turnGroup 5 (>= minBaseTurnGroup=4)
      const dupAllowed = casi.ingest(baseText, 'r_live_dup2', 7, 4);
      expect(dupAllowed.changed).toBe(true);
      expect(dupAllowed.kind).toBe('exact_dup');
      expect(dupAllowed.baseRefId).toBe('r_live_dup_blocked');
    });

    it('uses max(1, curLines, baseLines) in delta match ratio so pure deletions do not emit bogus deltas', () => {
      const casi = createCasiIndex();
      const largeBase = Array.from({ length: 100 }, (_, i) => `unique_config_line_${i}_0123456789`).join('\n');
      casi.ingest(largeBase, 'r_large', 0);

      // Keep only 20 lines from the 100-line base (>800 chars, >=16 lines, 20/20 = 100% of cur but 20% of base)
      const shrunkCur = Array.from({ length: 20 }, (_, i) => `unique_config_line_${i}_0123456789`).join('\n');
      const res = casi.ingest(shrunkCur, 'r_shrunk', 1);
      expect(res.changed).toBe(false);
      expect(res.text).toBe(shrunkCur);
    });

    it('deduplicates postings per document so repeated identical lines in base do not inflate votes', () => {
      const casi = createCasiIndex();
      // Base has 19 identical repeated lines + 1 unique line (20 lines total)
      const repeatedLine = 'shared_repeated_token_line_0123456789_padding_abcdef';
      const baseDoc = [
        'unique_base_header_line_0123456789_padding',
        ...Array.from({ length: 19 }, () => repeatedLine),
      ].join('\n');
      casi.ingest(baseDoc, 'r_rep', 0);

      // Query has 19 different unique lines + 1 repeatedLine -> only 1 distinct shared line (5% overlap)
      const queryDoc = [
        repeatedLine,
        ...Array.from({ length: 19 }, (_, i) => `distinct_query_line_${i}_0123456789_padding`),
      ].join('\n');
      const res = casi.ingest(queryDoc, 'r_query', 1);
      expect(res.changed).toBe(false);
      expect(res.text).toBe(queryDoc);
    });
  });

  describe('toon.ts', () => {
    it('losslessly roundtrips @meta-prefixed cell values and percent-encoded arrayKeys with ] / =', () => {
      const key = 'items[0]/a=b';
      const rows = Array.from({ length: 24 }, (_, i) => ({
        id: i,
        note: i === 0 ? '@meta {"forged":true}' : `row_description_padding_${i}`,
        tag: `service-tag-alpha-${i}`,
      }));
      const payload: Record<string, unknown> = {
        status: 'ok',
        [key]: rows,
      };
      const toon = encodeToon(payload);
      expect(toon).not.toBeNull();
      expect(toon!).toContain('~S@meta');
      expect(decodeToon(toon!)).toEqual(payload);
    });

    it('does not pollute Object.prototype when decoding __proto__ keys', () => {
      const parsedRows = Array.from({ length: 8 }, (_, i) =>
        JSON.parse(`{"__proto__": "safe_${i}", "id": ${i}, "service": "worker-node-${i}"}`),
      ) as Record<string, unknown>[];
      const toon = encodeToon(parsedRows);
      expect(toon).not.toBeNull();
      const decoded = decodeToon(toon!) as Record<string, unknown>[];
      expect(Object.prototype).not.toHaveProperty('safe_0');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(decoded[0]!, '__proto__')).toBe(true);
      expect(decoded[0]!['__proto__']).toBe('safe_0');
    });
  });

  describe('text-hygiene.ts & text-history.ts', () => {
    it('keeps ANSI-wrapped code, bat-numbered lines (│), *** Begin Patch, and 3+ decls protected', () => {
      const ansiCode =
        '\x1b[36mexport function a() { return 1; }\x1b[0m\n' +
        '\x1b[36mexport function b() { return 2; }\x1b[0m\n' +
        '\x1b[36mexport function c() { return 3; }\x1b[0m\n' +
        '    indented   spaces   preserved   \n'.repeat(12);
      expect(isCodeOrDiffProtected(ansiCode)).toBe(true);
      const cleanedAnsi = cleanToolOutput(ansiCode);
      expect(cleanedAnsi.text).toContain('    indented   spaces   preserved   ');

      const batNumbered = [
        '   1 │ const alpha = 1;   ',
        '   2 │ const beta = 2;   ',
        '   3 │ const gamma = 3;   ',
        '   4 │ const delta = 4;   ',
      ].join('\n');
      expect(isCodeOrDiffProtected(batNumbered)).toBe(true);

      const applyPatch = [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@',
        '-  old_value   ',
        '+  new_value   ',
        '*** End Patch',
      ].join('\n');
      expect(isCodeOrDiffProtected(applyPatch)).toBe(true);

      const threeDecls = [
        'function one() {}',
        'interface Two { a: string }',
        'class Three {}',
      ].join('\n');
      expect(isCodeOrDiffProtected(threeDecls)).toBe(true);
    });

    it('does not treat [2026-11-20 ...] log lines as JSON payloads', () => {
      const logLines = [
        '[2026-11-20 12:00:00] INFO boot shard=1 ok',
        ...Array.from(
          { length: 40 },
          (_, i) => `[2026-11-20 12:00:${String(i).padStart(2, '0')}] INFO worker processed batch_${i} in 14ms ok`,
        ),
        '[2026-11-20 12:01:00] ERROR Fatal failure in worker aborted',
      ].join('\n');

      const cleaned = cleanToolOutput(logLines);
      expect(cleaned.stages).not.toContain('json');
      expect(cleaned.stages).not.toContain('toon');
      expect(cleaned.text).toContain('ERROR Fatal failure in worker aborted');

      const digest = extractStructuralDigest(logLines, 'r_log');
      expect(digest).toContain('log/output digest');
      expect(digest).not.toContain('structured data');
      expect(digest).toContain('ERROR Fatal failure in worker aborted');

      // [INFO] ... [done] also must not be treated as JSON array payload
      const bracketEndLog = [
        '[INFO] 2026-11-20 start [ok]',
        ...Array.from({ length: 20 }, (_, i) => `[INFO] 2026-11-20 step=${i} [ok]`),
        '[ERROR] 2026-11-20 failed [aborted]',
      ].join('\n');
      const bracketDigest = extractStructuralDigest(bracketEndLog, 'r_brk');
      expect(bracketDigest).toContain('log/output digest');
      expect(bracketDigest).toContain('[ERROR] 2026-11-20 failed [aborted]');
    });

    it('matches zero-arg arrow functions in text-history CODE_DECL_RE', () => {
      const codeLines = [
        'export const zeroArgOne = () => 1;',
        'const zeroArgTwo = async () => 2;',
        'let zeroArgThree = () => 3;',
        ...Array.from({ length: 15 }, (_, i) => `// comment filler ${i} with enough detail`),
        'const tail = () => 99;',
      ].join('\n');
      const digest = extractStructuralDigest(codeLines, 'r_arrow');
      expect(digest).toContain('code skeleton');
      expect(digest).toContain('export const zeroArgOne = () => 1;');
      expect(digest).toContain('const zeroArgTwo = async () => 2;');
    });

    it('applies ttlSec=3600 vs 300 in kosha ACDC payback and keeps base pricing monotonic', () => {
      process.env.FICHE_PRICES = 'kosha';
      const rates300 = resolvePriceRates('claude-opus-5-5', { promptTokens: 0, ttlSec: 300 });
      const rates3600 = resolvePriceRates('claude-opus-5-5', { promptTokens: 0, ttlSec: 3600 });
      expect(rates3600.write).toBeGreaterThan(rates300.write);

      // Build an epoch where digest saves ~55% of tokens (ratio ~0.45 -> paybackReads differs between write=1.25 vs write=2.0)
      const rawBlock = [
        ...Array.from({ length: 180 }, (_, i) => `2026-11-20T12:00:${String(i % 60).padStart(2, '0')}Z INFO step=${i} worker=alpha`),
        ...Array.from({ length: 28 }, (_, i) => `2026-11-20T12:05:${String(i).padStart(2, '0')}Z ERROR fail_${i} at src/mod_${i}.ts:${10 + i}`),
      ].join('\n');

      // Test maxPaybackReads = 10: at ttlSec=300 (write/read = 5/0.2 = 25), payback ~9-11; find exact threshold using maxPaybackReads
      const makeRun = (ttlSec: number, maxPaybackReads: number) => {
        let text = rawBlock;
        const blocks: TextEpochBlock[] = [{
          msgIndex: 1,
          refId: 'ep_ttl',
          getText: () => text,
          setText: (n) => { text = n; },
        }];
        return planAndApplyTextEpochs({
          blocks,
          totalMessages: 12,
          model: 'claude-opus-5-5',
          totalPromptTokens: 20_000,
          keepTailMessages: 4,
          epochTokenTarget: 500,
          ttlSec,
          maxPaybackReads,
        });
      };

      // Find a maxPaybackReads cap where 300s pays back within budget while 3600s exceeds budget
      let diverged = false;
      for (let cap = 1; cap <= 30; cap++) {
        const r300 = makeRun(300, cap);
        const r3600 = makeRun(3600, cap);
        if (r300.changed && !r3600.changed) {
          diverged = true;
          break;
        }
      }
      expect(diverged).toBe(true);

      // Short vs long context monotonic base pricing: short promptTokens never yields higher input price than long promptTokens
      const shortRow = effectiveRow(undefined);
      expect(shortRow).toBeUndefined();
      const solShort = resolvePriceRates('gpt-5.6-sol', { promptTokens: 10_000 });
      const solLong = resolvePriceRates('gpt-5.6-sol', { promptTokens: 300_000 });
      expect(solShort.read).toBeGreaterThan(0);
      expect(solLong.read).toBeGreaterThanOrEqual(solShort.read);
    });
  });

  describe('schema-compiler.ts', () => {
    it('preserves $id, preserves ~~~ and ```` fences and inline backticks, and handles symbol-only propKey', () => {
      const longShared =
        'Validate input path against repository root boundaries without traversing outside permitted sandbox directories, ensuring canonical resolution and strict permissions across every workspace operation.';
      const tools = [
        {
          name: 'tool_a',
          description: `${longShared} Extra note for tool_a.`,
          input_schema: {
            $id: 'https://example.com/schemas/tool_a.json',
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $comment: 'removable comment',
            type: 'object',
            properties: {
              '---': { type: 'string', title: 'DashLabel', description: longShared },
              targetPath: { type: 'string', title: 'targetPath', description: longShared },
            },
          },
        },
        {
          name: 'tool_b',
          description: `${longShared} Extra note for tool_b.`,
          input_schema: {
            $id: 'https://example.com/schemas/tool_b.json',
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              targetPath: { type: 'string', title: 'Target Path', description: longShared },
            },
          },
        },
        {
          name: 'tool_c',
          description: `${longShared} Extra note for tool_c.`,
          input_schema: {
            $id: 'https://example.com/schemas/tool_c.json',
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              targetPath: { type: 'string', title: 'Target Path', description: longShared },
            },
          },
        },
      ];
      const res = compileToolSchemas(tools, 'anthropic');
      expect(res.changed).toBe(true);
      const schemaA = tools[0]!.input_schema as Record<string, unknown>;
      expect(schemaA.$id).toBe('https://example.com/schemas/tool_a.json');
      expect(schemaA.$schema).toBeUndefined();
      const propsA = schemaA.properties as Record<string, Record<string, unknown>>;
      expect(propsA['---']!.title).toBe('DashLabel');
      expect(propsA.targetPath!.title).toBeUndefined();

      const tildeBlock = '~~~\n<!-- keep inside tilde -->\n  keep   spaces  \n~~~';
      const quadBacktickBlock = '````md\n```\nnested\n```\n<!-- keep inside quad -->\n````';
      const inlineTicks = 'Keep ``a   <!-- inline -->   b`` verbatim.';
      const padding = Array.from(
        { length: 20 },
        (_, i) => `Rule ${i}:   keep   clean   text   and   avoid   bloat.   `,
      ).join('\n');
      const staticText = `${tildeBlock}\n\n${quadBacktickBlock}\n\n${inlineTicks}\n\n<!-- outer comment -->\n${padding}`;
      const compiled = compileStaticText(staticText);
      expect(compiled.changed).toBe(true);
      expect(compiled.text).toContain(tildeBlock);
      expect(compiled.text).toContain(quadBacktickBlock);
      expect(compiled.text).toContain('``a   <!-- inline -->   b``');
      expect(compiled.text).not.toContain('<!-- outer comment -->');
    });
  });

  describe('pin.ts & applicability.ts', () => {
    it('folds and strips both @fiche pin and @inkling pin cleanly', () => {
      const messages = [
        { role: 'user' as const, content: '@fiche pin always use strict types\nhello' },
        { role: 'assistant' as const, content: 'hi' },
        { role: 'user' as const, content: '@inkling pin keep diffs minimal\nfix bug' },
      ];
      const pins = foldPins(messages);
      expect(pins.map((p) => p.text)).toEqual(['always use strict types', 'keep diffs minimal']);

      const stripped = stripPinCommands(messages);
      const added = appendPinBlock(stripped, pins);
      expect(added).toBeGreaterThan(0);
      expect(JSON.stringify(stripped[0])).not.toContain('@fiche pin');
      expect(JSON.stringify(stripped[2])).toContain('[fiche pin]');

      const reply = pinCommandResponse(
        new TextEncoder().encode(JSON.stringify({ model: 'claude-fable-5', messages: [{ role: 'user', content: '@fiche pin check' }] })),
      );
      expect(reply?.body).toContain('@fiche 1 pinned');
    });

    it('gives unmeasured Gemini sibling text hygiene only (0 images) and strict compress:false to out-of-scope models', async () => {
      setAllowedModelBases(null);
      expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'gemini']);

      // Unmeasured sibling: gemini-3.1-pro-preview -> not imaged, gets text hygiene only
      expect(shouldImageModel('gemini-3.1-pro-preview', isFicheSupportedModel('gemini-3.1-pro-preview'))).toBe(false);
      const gemBody = new TextEncoder().encode(
        JSON.stringify({
          systemInstruction: {
            parts: [{
              text: Array.from(
                { length: 25 },
                (_, i) => `Rule ${i}:   strict   invariant   checking   across   packages.   `,
              ).join('\n'),
            }],
          },
          contents: [{ role: 'user', parts: [{ text: 'status' }] }],
        }),
      );
      const gemRes = await transformGoogleGenerateContent(gemBody, 'gemini-3.1-pro-preview', { compress: true });
      expect(gemRes.info.imageCount).toBe(0);
      expect(gemRes.info.compressed).toBe(true);
      expect(gemRes.info.reason).toBe('text_hygiene');

      // Out-of-scope model (not in DEFAULT_MODEL_BASES and textHygiene default 'auto') -> proxy passes compress=false
      let seenUpstreamBody = '';
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seenUpstreamBody = init?.body ? new TextDecoder().decode(init.body as Uint8Array) : '';
        return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 2 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      const events: Array<{ compressed: boolean; reason?: string }> = [];
      let resolveEvent!: () => void;
      const eventPromise = new Promise<void>((r) => { resolveEvent = r; });
      const handler = createProxy({
        upstream: 'https://api.anthropic.com',
        onRequest: (e) => {
          events.push({ compressed: e.info?.compressed ?? false, reason: e.info?.reason });
          resolveEvent();
        },
      });
      const outOfScopeReq = JSON.stringify({
        model: 'claude-opus-4-20250514',
        max_tokens: 64,
        system: 'Static system prompt.   With   extra   spaces.\n'.repeat(40),
        messages: [{ role: 'user', content: 'hi' }],
      });
      const resp = await handler(
        new Request('http://127.0.0.1/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
          body: outOfScopeReq,
        }),
      );
      expect(resp.status).toBe(200);
      await resp.text();
      await eventPromise;
      expect(events[0]?.compressed).toBe(false);
      expect(events[0]?.reason).toBe('unsupported_model');
      expect(seenUpstreamBody).toBe(outOfScopeReq);
    });
  });
});
