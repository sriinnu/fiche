import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { extractFactSheetEntries, extractFactSheetEntriesAllPages } from '../src/core/factsheet.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { hasLongUnbrokenBpeChunk } from '../src/core/gpt-tokens.js';
import { transformOpenAIChatCompletions } from '../src/core/openai.js';
import { encodeGrayPng } from '../src/core/png.js';
import { createProxy } from '../src/core/proxy.js';
import { DENSE_RENDER_STYLE, renderDensePages } from '../src/core/render.js';
import { parseAllowedHosts } from '../src/core/request-guard.js';
import { transformRequest } from '../src/core/transform.js';
import { visionTokens } from '../src/core/vision-cost.js';
import { prune as pruneSessions } from '../src/sessions.js';
import { fold, newSummary, renderTextReport, summaryToJson } from '../src/stats.js';
import { readTurnReport } from '../src/turn-report.js';
import worker from '../src/worker.js';

describe('Wave 2 P1 audit regressions', () => {
  const realFetch = globalThis.fetch;
  const tempDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {
    FICHE_GPT_PROFILES: process.env.FICHE_GPT_PROFILES,
    INKLING_GPT_PROFILES: process.env.INKLING_GPT_PROFILES,
    FICHE_PRICES: process.env.FICHE_PRICES,
    INKLING_PRICES: process.env.INKLING_PRICES,
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
    setAllowedModelBases(null);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of tempDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function mkTempDir(prefix = 'fiche-wave2-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  describe('google.ts', () => {
    it('renders/preserves Turn 0 >= 500 chars and keeps Turn 0 in recentPrior when >6 prior turns', async () => {
      const turn0Prompt =
        'TURN0_ANCHOR_ID=deadbeef1234 ' +
        Array.from({ length: 18 }, (_, i) => `Initial specification rule ${i}: preserve Turn 0 requirements carefully.`).join(' ');
      expect(turn0Prompt.length).toBeGreaterThanOrEqual(500);

      const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [
        { role: 'user', parts: [{ text: turn0Prompt }] },
        { role: 'model', parts: [{ text: 'Understood Turn 0.' }] },
      ];
      // Add >7 subsequent user/model tool-bearing turns past READABLE_CHARS_PER_IMAGE so sealed history collapses
      for (let t = 1; t <= 12; t++) {
        contents.push({ role: 'user', parts: [{ text: `Follow-up task ${t}` }] });
        contents.push({
          role: 'model',
          parts: [{ functionCall: { name: 'read_file', args: { path: `src/f${t}.ts` } } }],
        });
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'read_file',
              response: {
                output: Array.from(
                  { length: 65 },
                  (_, line) => `file src/f${t}.ts line=${line} val=${t * 100 + line} sha=abc${t}def${line}`,
                ).join('\n'),
              },
            },
          }],
        });
        contents.push({ role: 'model', parts: [{ text: `Completed step ${t}.` }] });
      }
      contents.push({ role: 'user', parts: [{ text: 'Final live question' }] });

      const body = new TextEncoder().encode(JSON.stringify({ contents }));
      const res = await transformGoogleGenerateContent(body, 'gemini-4-argon', {
        compress: true,
        imageCompress: true,
        collapseHistory: true,
        minToolResultChars: 50_000,
      });

      expect(res.info.compressed).toBe(true);
      expect(res.info.imageCount).toBeGreaterThan(0);
      const out = JSON.parse(new TextDecoder().decode(res.body)) as {
        contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: unknown }> }>;
      };
      const allText = out.contents
        .flatMap((c) => c.parts.map((p) => p.text ?? ''))
        .join('\n');
      // Turn 0 >= 500 chars was rendered into history (factsheet carries TURN0_ANCHOR_ID) AND kept in recentPrior (<user t="0">)
      expect(allText).toContain('TURN0_ANCHOR_ID=deadbeef1234');
      expect(allText).toContain('<user t="0">');
    });

    it('preserves tool-bearing Turn 0 cleanly without silent loss', async () => {
      const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [
        {
          role: 'model',
          parts: [{
            functionCall: {
              name: 'init',
              args: { marker: 'TURN0_TOOL_MARKER=feedface0123' },
            },
          }],
        },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'init',
              response: {
                output: Array.from({ length: 40 }, (_, i) => `init payload line ${i} with context value_${i}_abc.`).join('\n'),
              },
            },
          }],
        },
      ];
      for (let t = 1; t <= 14; t++) {
        contents.push({
          role: 'user',
          parts: [{ text: Array.from({ length: 28 }, (_, i) => `Step ${t} instruction line ${i}: validate pkg_${t}_${i}.`).join('\n') }],
        });
        contents.push({
          role: 'model',
          parts: [{ text: Array.from({ length: 28 }, (_, i) => `Done ${t} diagnostic line ${i}: passed check_${t}_${i}.`).join('\n') }],
        });
      }
      contents.push({ role: 'user', parts: [{ text: 'Now summarize.' }] });

      const res = await transformGoogleGenerateContent(
        new TextEncoder().encode(JSON.stringify({ contents })),
        'gemini-4-argon',
        { compress: true, imageCompress: true, collapseHistory: true, minToolResultChars: 50_000 },
      );
      expect(res.info.compressed).toBe(true);
      expect(res.info.imageCount).toBeGreaterThan(0);
      const outText = JSON.parse(new TextDecoder().decode(res.body)) as {
        contents: Array<{ parts: Array<{ text?: string }> }>;
      };
      const joined = outText.contents.flatMap((c) => c.parts.map((p) => p.text ?? '')).join('\n');
      expect(joined).toContain('TURN0_TOOL_MARKER=feedface0123');
    });

    it('skips pins/hygiene on compress=false while still normalizing thoughtSignature', async () => {
      const body = new TextEncoder().encode(
        JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: '@fiche pin keep strict mode\nrun check' }] },
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'run_tool',
                    args: { x: 1 },
                    thought_signature: 'sig_legacy_123',
                  },
                },
              ],
            },
          ],
        }),
      );
      const res = await transformGoogleGenerateContent(body, 'gemini-3.8-flash', { compress: false });
      expect(res.info.compressed).toBe(false);
      expect(res.info.reason).toBe('compression_disabled');
      const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      // Pins untouched
      expect(parsed.contents[0]!.parts[0]!.text).toContain('@fiche pin keep strict mode');
      // Thought signature normalized onto part & stripped from functionCall
      const fcPart = parsed.contents[1]!.parts[0]!;
      expect(fcPart.thoughtSignature).toBe('sig_legacy_123');
      expect((fcPart.functionCall as Record<string, unknown>).thought_signature).toBeUndefined();
    });
  });

  describe('transform.ts & openai.ts', () => {
    it('relocates pins even when imageCompress=false and populates imageTokens + baselineImagedTokens on Anthropic', async () => {
      const reqNoImg = new TextEncoder().encode(
        JSON.stringify({
          model: 'claude-opus-5-5',
          max_tokens: 128,
          system: 'System rules.',
          messages: [
            { role: 'user', content: '@fiche pin always quote line numbers\nhello' },
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'next task' },
          ],
        }),
      );
      const resNoImg = await transformRequest(reqNoImg, { compress: true, imageCompress: false });
      expect(resNoImg.info.pinChars).toBeGreaterThan(0);
      const parsedNoImg = JSON.parse(new TextDecoder().decode(resNoImg.body)) as {
        messages: Array<{ content: unknown }>;
      };
      expect(JSON.stringify(parsedNoImg.messages[0])).not.toContain('@fiche pin');
      expect(JSON.stringify(parsedNoImg.messages[2])).toContain('[fiche pin]');

      // Anthropic optical slab + tool_result + history populates imageTokens and baselineImagedTokens
      const bigSys = Array.from(
        { length: 140 },
        (_, i) => `Rule ${i}: Keep deterministic behavior across src/module_${i}.ts with sha deadbeef${i}.`,
      ).join('\n');
      const reqOptical = new TextEncoder().encode(
        JSON.stringify({
          model: 'claude-fable-5-20260609',
          max_tokens: 128,
          system: [{ type: 'text', text: bigSys, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: 'inspect' }],
        }),
      );
      const resOptical = await transformRequest(reqOptical, { compress: true, imageCompress: true });
      expect(resOptical.info.compressed).toBe(true);
      expect(resOptical.info.imageCount).toBeGreaterThan(0);
      expect(resOptical.info.imageTokens).toBeGreaterThan(0);
      expect(resOptical.info.baselineImagedTokens).toBeGreaterThan(0);
    });

    it('preserves static system & tools without dangling pointers when firstUserIdx < 0 while stripping billingLine', async () => {
      const bigSys =
        'x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=cli\n' +
        Array.from(
          { length: 140 },
          (_, i) => `Static instruction ${i}: enforce strict invariants in package_${i}.ts.`,
        ).join('\n');
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: 'claude-fable-5-20260609',
          max_tokens: 64,
          system: [{ type: 'text', text: bigSys, cache_control: { type: 'ephemeral' } }],
          tools: [
            {
              name: 'ping',
              description: 'Ping workspace service.',
              input_schema: { type: 'object', properties: { target: { type: 'string' } } },
            },
          ],
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'prefill only' }] }],
        }),
      );
      const res = await transformRequest(body, { compress: true, imageCompress: true });
      expect(res.info.billingLine).toBe('x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=cli');
      expect(res.info.imageCount).toBe(0);
      const out = JSON.parse(new TextDecoder().decode(res.body)) as {
        system: Array<{ text?: string }>;
        tools: unknown[];
      };
      const sysJson = JSON.stringify(out.system);
      expect(sysJson).not.toContain('x-anthropic-billing-header');
      expect(sysJson).not.toContain('in the first user message');
      expect(sysJson).toContain('Static instruction 0');
      expect(out.tools).toHaveLength(1);
    });

    it('enforces Chat Completions maxSerializedRequestBytes fallback cleanly', async () => {
      process.env.FICHE_GPT_PROFILES = JSON.stringify({
        'gpt-5.6-sol': { maxSerializedRequestBytes: 500 },
      });
      const bigSys = Array.from(
        { length: 120 },
        (_, i) => `System rule ${i}: preserve exact types and invariants in pkg_${i}.ts.`,
      ).join('\n');
      const rawBytes = new TextEncoder().encode(
        JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [
            { role: 'system', content: bigSys },
            { role: 'user', content: 'hello' },
          ],
        }),
      );
      const res = await transformOpenAIChatCompletions(rawBytes, {
        compress: true,
        imageCompress: true,
      });
      expect(res.info.reason).toBe('serialized_request_limit');
      expect(Buffer.from(res.body).equals(Buffer.from(rawBytes))).toBe(true);
    });
  });

  describe('gpt-tokens.ts', () => {
    it('flags long whitespace/symbol BPE runs while allowing normal spaced and JSON text', () => {
      expect(hasLongUnbrokenBpeChunk(' '.repeat(3000))).toBe(true);
      expect(hasLongUnbrokenBpeChunk('='.repeat(3000))).toBe(true);
      expect(hasLongUnbrokenBpeChunk('normal spaced prose words '.repeat(300))).toBe(false);
      expect(
        hasLongUnbrokenBpeChunk(
          JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: i, svc: `svc-${i}`, ok: true }))),
        ),
      ).toBe(false);
    });
  });

  describe('factsheet.ts', () => {
    it('extracts 2-char-prefix CONST_IDS, clamps charsPerPage=0, and deduplicates substrings across pages', () => {
      const entries = extractFactSheetEntries('Encountered IO_ERR while reading DB_URL from config.');
      const tokens = entries.map((e) => e.token);
      expect(tokens).toContain('IO_ERR');
      expect(tokens).toContain('DB_URL');

      // charsPerPage=0 must clamp without looping endlessly
      const clamped = extractFactSheetEntriesAllPages('IO_ERR DB_URL /var/log/app.log', 0);
      expect(clamped.kept.map((e) => e.token)).toContain('IO_ERR');

      // Cross-page substring dedup removes short path when full URL appears on next page
      const page1 = 'See /api/v2/orders/status for details. ' + 'filler text '.repeat(40);
      const page2 = 'Full endpoint https://api.example.com/api/v2/orders/status verified.';
      const combined = page1 + ' ' + page2;
      const merged = extractFactSheetEntriesAllPages(combined, page1.length + 5);
      const mergedTokens = merged.kept.map((e) => e.token);
      expect(mergedTokens).toContain('https://api.example.com/api/v2/orders/status');
      expect(mergedTokens).not.toContain('/api/v2/orders/status');
    });
  });

  describe('render.ts, png.ts, vision-cost.ts', () => {
    it('measures cols using style in renderDensePages, throws on 0-width PNG, and floors tile vision >= 1x1', async () => {
      const customStyle = { ...DENSE_RENDER_STYLE, font: 'jetbrains-mono-14' as const, markerScale: 2 };
      const pages = await renderDensePages('short line\nsecond line', {
        cols: 120,
        shrink: true,
        style: customStyle,
      });
      expect(pages.length).toBe(1);
      expect(pages[0]!.width).toBeLessThan(1568);

      await expect(encodeGrayPng(new Uint8Array(0), 0, 10)).rejects.toThrow(/invalid dimensions/);

      const extremeTile = visionTokens(
        { vision: { regime: 'tile', base: 85, perTile: 170 } },
        100_000,
        1,
      );
      expect(extremeTile).toBeGreaterThanOrEqual(85 + 170);
    });
  });

  describe('proxy.ts, request-guard.ts, worker.ts', () => {
    it('strips Anthropic auth headers on /openai/v1/responses, 404s unknown routes, and tolerates invalid billingLine', async () => {
      const seenAuth: Array<{ path: string; xApiKey: string | null; auth: string | null; hdrs: Headers }> = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(typeof url === 'string' ? url : url.toString());
        const hdrs = new Headers(init?.headers);
        seenAuth.push({
          path: u.pathname,
          xApiKey: hdrs.get('x-api-key'),
          auth: hdrs.get('authorization'),
          hdrs,
        });
        if (u.pathname.includes('responses')) {
          return new Response(
            JSON.stringify({
              id: 'resp_1',
              status: 'completed',
              model: 'gpt-6-astra',
              output: [
                { type: 'message', content: [{ type: 'output_text', text: 'Done!' }] },
                { type: 'reasoning', summary: [{ text: 'Think step' }] },
                { type: 'function_call', arguments: '{"ok":true}' },
              ],
              usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 50, output_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;

      const recorded: Array<{ outputChars?: number; thinkingChars?: number; toolUseChars?: number }> = [];
      let resolveRecorded!: () => void;
      const recordedReady = new Promise<void>((r) => { resolveRecorded = r; });
      const gatewayHandler = createProxy({
        upstream: 'https://gateway.example.com',
        openAIUpstream: 'https://api.openai.com',
        onRequest: (e) => {
          recorded.push({
            outputChars: e.measurement?.textChars,
            thinkingChars: e.measurement?.thinkingChars,
            toolUseChars: e.measurement?.toolUseChars,
          });
          resolveRecorded();
        },
      });
      const defaultHandler = createProxy({
        upstream: 'https://api.anthropic.com',
        openAIUpstream: 'https://api.openai.com',
      });

      // 1) /openai/v1/responses strips x-api-key and Bearer sk-ant-* and measures output[]
      const respOpenAI = await gatewayHandler(
        new Request('http://127.0.0.1/openai/v1/responses', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'sk-ant-leak',
            authorization: 'Bearer sk-ant-oat01-leak',
          },
          body: JSON.stringify({
            model: 'gpt-6-astra',
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          }),
        }),
      );
      expect(respOpenAI.status).toBe(200);
      await respOpenAI.text();
      await recordedReady;
      expect(seenAuth[0]?.xApiKey).toBeNull();
      expect(seenAuth[0]?.auth).toBeNull();
      expect(recorded[0]).toEqual({
        outputChars: 'Done!'.length,
        thinkingChars: 'Think step'.length,
        toolUseChars: '{"ok":true}'.length,
      });

      // 2) Unknown route /foo/chat/completions on DEFAULT_UPSTREAM returns 404 unknown_route
      const respUnknown = await defaultHandler(
        new Request('http://127.0.0.1/foo/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect(respUnknown.status).toBe(404);
      expect(await respUnknown.json()).toMatchObject({ error: 'unknown_route' });

      // 3) Invalid billingLine header name doesn't throw / 502
      setAllowedModelBases(['claude-fable-5']);
      const respBadBilling = await defaultHandler(
        new Request('http://127.0.0.1/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-ok' },
          body: JSON.stringify({
            model: 'claude-fable-5-20260609',
            max_tokens: 32,
            system:
              'x-anthropic-billing-header invalid name: val\n' +
              'System text line.\n'.repeat(120),
            messages: [{ role: 'user', content: 'hi' }],
          }),
        }),
      );
      expect(respBadBilling.status).toBe(200);
      await respBadBilling.text();
    });

    it('parseAllowedHosts extracts host from full URLs and worker enforces secret & strips x-fiche-secret', async () => {
      expect(parseAllowedHosts('https://example.com:8443/path, http://foo.bar/x')).toEqual([
        'example.com',
        'foo.bar',
      ]);

      let forwardedHeaders: Headers | undefined;
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        forwardedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({ id: 'msg_w', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 2 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;

      const ctx = { waitUntil: () => {} } as unknown as Parameters<typeof worker.fetch>[2];

      // Worker enforces FICHE_WORKER_SECRET even with no *_API_KEY configured
      const unauthRes = await worker.fetch(
        new Request('https://worker.example/v1/messages', { method: 'POST', body: '{}' }),
        { FICHE_WORKER_SECRET: 'top-secret' },
        ctx,
      );
      expect(unauthRes.status).toBe(401);

      // Strips x-fiche-secret even when no FICHE_WORKER_SECRET is set, and handles MIN_COMPRESS_CHARS=bad cleanly
      const okRes = await worker.fetch(
        new Request('https://worker.example/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'sk-ant-caller',
            'x-fiche-secret': 'stray-secret',
            'x-inkling-secret': 'stray-legacy',
          },
          body: JSON.stringify({
            model: 'claude-opus-4-20250514',
            max_tokens: 32,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        }),
        { MIN_COMPRESS_CHARS: 'bad', FICHE_TRACK: '0' },
        ctx,
      );
      expect(okRes.status).toBe(200);
      expect(forwardedHeaders?.has('x-fiche-secret')).toBe(false);
      expect(forwardedHeaders?.has('x-inkling-secret')).toBe(false);
    });
  });

  describe('stats.ts, turn-report.ts, sessions.ts', () => {
    it('avoids double-counting inclusive OpenAI/Google cached_tokens in summaryToJson and CLI report', () => {
      const s = newSummary();
      fold(s, {
        ts: '2026-11-20T12:00:00.000Z',
        path: '/openai/v1/responses',
        status: 200,
        duration_ms: 20,
        compressed: true,
        accounting_provider: 'openai',
        input_tokens: 1000,
        cached_tokens: 800,
        output_tokens: 50,
      });
      const json = summaryToJson(s) as {
        inputTokensTotal: number;
        cacheReadTokensTotal: number;
        inclusiveCacheReadTotal: number;
      };
      expect(json.inputTokensTotal).toBe(1000);
      expect(json.cacheReadTokensTotal).toBe(800);
      expect(json.inclusiveCacheReadTotal).toBe(800);
      const report = renderTextReport(s);
      // totalIn = 1000 + 0 + 800 - 800 = 1000 -> hit rate = 800/1000 = 80.0%
      expect(report).toContain('80.0%');
    });

    it('turn-report handles negative cache-bust savings, subtracts native_injected_tokens, preserves cliff_saved_usd once, and uses lastLineAbsOffset cursor', () => {
      const dir = mkTempDir();
      const eventsPath = path.join(dir, 'events.jsonl');
      const cursorPath = path.join(dir, 'cursor.json');

      const ev1 = {
        ts: '2026-11-20T12:00:00.000Z',
        status: 200,
        compressed: true,
        model: 'claude-fable-5-20260609',
        baseline_probe_status: 'ok',
        baseline_tokens: 1000,
        input_tokens: 1500, // negative savedTokens = -500 on cache bust!
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        cliff_avoided_at: 200_000,
        cliff_saved_usd: 0.25,
        session_id: 's1',
      };
      const ev2 = {
        ts: '2026-11-20T12:00:01.000Z',
        status: 200,
        compressed: true,
        model: 'claude-fable-5-20260609',
        baseline_imaged_tokens: 5000,
        image_tokens: 1000,
        native_injected_tokens: 300,
        text_hygiene_saved_tokens: 100,
        input_tokens: 1000,
        cache_read_tokens: 2000,
        cache_create_tokens: 0,
        session_id: 's1',
      };
      fs.writeFileSync(eventsPath, `${JSON.stringify(ev1)}\n`);
      const r1 = readTurnReport(eventsPath, { cursorFile: cursorPath });
      expect(r1.hasNewTurn).toBe(true);
      expect(r1.lastTurn?.savedTokens).toBe(-500);
      expect(r1.session.cliffSavedUsd).toBeCloseTo(0.25, 6);

      // Re-reading with same file -> cursor dedups (hasNewTurn = false)
      const r1Dup = readTurnReport(eventsPath, { cursorFile: cursorPath });
      expect(r1Dup.hasNewTurn).toBe(false);

      // Append ev2 with identical timestamp as edge case? Use ev2 ts and verify offset-based cursor triggers
      fs.appendFileSync(eventsPath, `${JSON.stringify(ev2)}\n`);
      const r2 = readTurnReport(eventsPath, { cursorFile: cursorPath });
      expect(r2.hasNewTurn).toBe(true);
      // Estimated: 100 + (5000 - 1000 - 300) = 3800
      expect(r2.lastTurn?.savedTokens).toBe(3800);
      // cliff_saved_usd counted once (0.25, not added into savedUsd + cliffSavedUsd twice)
      expect(r2.session.cliffSavedUsd).toBeCloseTo(0.25, 6);
    });

    it('sessions.prune writes pruned events.jsonl with 0o600 permissions', async () => {
      const dir = mkTempDir('fiche-prune-');
      const eventsFile = path.join(dir, 'events.jsonl');
      const sidecarDir = path.join(dir, '4xx-bodies');
      const claudeProjectsDir = path.join(dir, 'claude-projects');
      const oldEv = {
        ts: '2025-01-01T00:00:00.000Z',
        path: '/v1/messages',
        status: 200,
        compressed: true,
        first_user_sha8: 'aaaa1111',
        input_tokens: 100,
      };
      const newEv = {
        ts: '2026-11-20T12:00:00.000Z',
        path: '/v1/messages',
        status: 200,
        compressed: true,
        first_user_sha8: 'bbbb2222',
        input_tokens: 100,
      };
      fs.writeFileSync(eventsFile, `${JSON.stringify(oldEv)}\n${JSON.stringify(newEv)}\n`, { mode: 0o644 });

      await pruneSessions(
        { eventsFile, sidecarDir, claudeProjectsDir },
        { olderThanDays: 30, force: true },
      );
      const mode = fs.statSync(eventsFile).mode & 0o777;
      expect(mode).toBe(0o600);
      const remaining = fs.readFileSync(eventsFile, 'utf8');
      expect(remaining).toContain('bbbb2222');
      expect(remaining).not.toContain('aaaa1111');
    });
  });
});
