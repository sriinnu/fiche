import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAnthropicTextHygiene,
  applyGoogleTextHygiene,
  applyOpenAIChatTextHygiene,
  applyOpenAIResponsesTextHygiene,
  cleanToolOutput,
  isCodeOrDiffProtected,
  isTextHygieneActive,
} from '../src/core/text-hygiene.js';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { createProxy } from '../src/core/proxy.js';
import { decodeToon } from '../src/core/toon.js';
import { transformRequest } from '../src/core/transform.js';

const mockCred = (...parts: string[]): string => parts.join('-');

describe('text-hygiene: deterministic prefix-safe tool cleaning', () => {
  const savedModels = process.env.INKLING_MODELS;
  const savedHygiene = process.env.INKLING_TEXT_HYGIENE;

  afterEach(() => {
    if (savedModels === undefined) delete process.env.INKLING_MODELS;
    else process.env.INKLING_MODELS = savedModels;
    if (savedHygiene === undefined) delete process.env.INKLING_TEXT_HYGIENE;
    else process.env.INKLING_TEXT_HYGIENE = savedHygiene;
    setAllowedModelBases(null);
  });

  it('strips ANSI/OSC escape sequences and resolves \\r/\\b progress bars', () => {
    const raw =
      '\x1b]0;build\x07\x1b[32mCompiling...\x1b[0m\n' +
      'downloading [==>    ] 20%\rdownloading [====>  ] 60%\rdownloading [=======] 100%\n' +
      'typoo\x08 ok\n';
    const res = cleanToolOutput(raw);
    expect(res.changed).toBe(true);
    expect(res.stages).toContain('ansi');
    expect(res.stages).toContain('cr');
    expect(res.text).toContain('Compiling...\n');
    expect(res.text).toContain('downloading [=======] 100%\n');
    expect(res.text).not.toContain('20%');
    expect(res.text).not.toContain('60%');
    expect(res.text).toContain('typo ok');
    expect(res.savedChars).toBeGreaterThan(20);
  });

  it('losslessly encodes tabular JSON as @toon and minifies non-tabular pretty JSON', () => {
    const tabularPayload = {
      status: 'ok',
      items: Array.from({ length: 24 }, (_, i) => ({
        id: i,
        name: `package-module-${i}`,
        version: '1.2.3',
        dependencies: ['alpha', 'beta', 'gamma'],
      })),
    };
    const prettyTabular = JSON.stringify(tabularPayload, null, 2);
    const resToon = cleanToolOutput(prettyTabular);
    expect(resToon.changed).toBe(true);
    expect(resToon.stages).toContain('toon');
    expect(decodeToon(resToon.text)).toEqual(tabularPayload);
    expect(resToon.savedTokens).toBeGreaterThan(0);

    const nonTabularPayload = {
      meta: { host: 'local-runner', version: '1.2.3' },
      nested: { a: { b: { c: 'alpha', d: [1, 2, 3] } }, x: { y: { z: 'beta' } } },
      entries: Array.from({ length: 8 }, (_, i) => [`key_${i}`, `val_${i}`, i]),
    };
    const prettyNonTabular = JSON.stringify(nonTabularPayload, null, 2);
    const resJson = cleanToolOutput(prettyNonTabular);
    expect(resJson.changed).toBe(true);
    expect(resJson.stages).toContain('json');
    expect(resJson.text).toBe(JSON.stringify(nonTabularPayload));
    expect(JSON.parse(resJson.text)).toEqual(nonTabularPayload);
    expect(resJson.savedTokens).toBeGreaterThan(0);
  });

  it('folds repetitive Drain log templates while preserving error, warning, and stack lines verbatim', () => {
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) lines.push(`2026-11-19T12:00:0${i}Z INFO boot step=${i}`);
    for (let i = 0; i < 60; i++) {
      const sec = String(i % 60).padStart(2, '0');
      lines.push(
        `2026-11-19T12:01:${sec}Z INFO worker=10.0.0.${(i % 4) + 1}:8080 processed job 550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')} in ${12 + i}ms`,
      );
    }
    lines.push('2026-11-19T12:02:01Z ERROR AssertionError: expected true to be false at src/app.ts:42');
    lines.push('    at runCheck (src/app.ts:42:11)');
    for (let i = 0; i < 20; i++) {
      lines.push(`2026-11-19T12:02:${String(i + 10)}Z INFO cleanup batch ${i} completed`);
    }

    const raw = lines.join('\n');
    const res = cleanToolOutput(raw);
    expect(res.changed).toBe(true);
    expect(res.stages).toContain('log_fold');
    expect(res.text).toMatch(/\[\.\.\. \d+ similar lines folded \.\.\.\]/);
    expect(res.text).toContain('ERROR AssertionError: expected true to be false at src/app.ts:42');
    expect(res.text).toContain('at runCheck (src/app.ts:42:11)');
    expect(res.text.length).toBeLessThan(raw.length);
  });

  it('protects line-numbered Read outputs, unified diffs, and fenced code blocks from structural alteration', () => {
    const readFileOutput = Array.from(
      { length: 40 },
      (_, i) => `${String(i + 1).padStart(4)}→  const item${i} = value${i} + "  keep trailing  ";`,
    ).join('\n');
    const diffOutput = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,4 +1,4 @@',
      ' line 1',
      '-line 2 old   ',
      '+line 2 new   ',
      ...Array.from({ length: 30 }, (_, i) => ` unchanged line ${i} in 12ms`),
    ].join('\n');
    const fencedOutput = [
      '```json',
      JSON.stringify({ big: Array.from({ length: 30 }, (_, i) => ({ k: i })) }, null, 2),
      '```',
    ].join('\n');

    expect(isCodeOrDiffProtected(readFileOutput)).toBe(true);
    expect(isCodeOrDiffProtected(diffOutput)).toBe(true);
    expect(isCodeOrDiffProtected(fencedOutput)).toBe(true);

    expect(cleanToolOutput(readFileOutput).text).toBe(readFileOutput);
    expect(cleanToolOutput(diffOutput).text).toBe(diffOutput);
    expect(cleanToolOutput(fencedOutput).text).toBe(fencedOutput);
  });

  it('produces byte-identical cleaned prefix blocks across turns (cache-safe invariance)', () => {
    const noisyLog = Array.from(
      { length: 50 },
      (_, i) => `2026-11-19T09:00:${String(i).padStart(2, '0')}Z INFO GET /health 200 ${10 + i}ms`,
    ).join('\n');
    const prettyJson = JSON.stringify(
      { entries: Array.from({ length: 20 }, (_, i) => ({ id: i, tag: `t-${i}` })) },
      null,
      2,
    );

    const turn1 = {
      messages: [
        { role: 'user', content: 'run tests' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: noisyLog },
            { type: 'tool_result', tool_use_id: 't2', content: prettyJson },
          ],
        },
      ],
    };
    const turn2 = {
      messages: [
        ...structuredClone(turn1.messages),
        { role: 'assistant', content: [{ type: 'text', text: 'Next check' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: '\x1b[31mfail\x1b[0m\n' }] },
      ],
    };

    applyAnthropicTextHygiene(turn1);
    applyAnthropicTextHygiene(turn2);

    expect(turn2.messages[1]).toEqual(turn1.messages[1]);
  });

  it('wire adapters clean only tool results and leave user/assistant prose untouched', () => {
    const pretty = JSON.stringify({ rows: Array.from({ length: 20 }, (_, i) => ({ idx: i, val: 'abc' })) }, null, 2);

    const chatReq = {
      messages: [
        { role: 'user', content: pretty },
        { role: 'tool', tool_call_id: 'c1', content: pretty },
      ],
    };
    const chatStats = applyOpenAIChatTextHygiene(chatReq);
    expect(chatStats.changed).toBe(true);
    expect(chatReq.messages[0]!.content).toBe(pretty);
    expect(decodeToon(chatReq.messages[1]!.content)).toEqual(JSON.parse(pretty));

    const respReq = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: pretty }] },
        { type: 'function_call_output', call_id: 'c1', output: '\x1b[33mok\x1b[0m\nstep 1\rstep 2' },
      ],
    };
    const respStats = applyOpenAIResponsesTextHygiene(respReq);
    expect(respStats.changed).toBe(true);
    expect((respReq.input[0] as { content: { text: string }[] }).content[0]!.text).toBe(pretty);
    expect((respReq.input[1] as { output: string }).output).toBe('ok\nstep 2');

    const googleReq = {
      contents: [
        { role: 'user', parts: [{ text: pretty }] },
        { role: 'user', parts: [{ functionResponse: { name: 'exec', response: { output: pretty } } }] },
      ],
    };
    const gStats = applyGoogleTextHygiene(googleReq);
    expect(gStats.changed).toBe(true);
    expect(googleReq.contents[0]!.parts[0]!.text).toBe(pretty);
    expect(
      decodeToon((googleReq.contents[1]!.parts[0] as { functionResponse: { response: { output: string } } }).functionResponse.response.output),
    ).toEqual(JSON.parse(pretty));
  });

  it('runs text hygiene for weak/text-only models when INKLING_MODELS=off if INKLING_TEXT_HYGIENE=on', async () => {
    setAllowedModelBases([]);
    process.env.INKLING_TEXT_HYGIENE = 'on';
    expect(isTextHygieneActive()).toBe(true);

    const pretty = JSON.stringify({ data: Array.from({ length: 20 }, (_, i) => ({ id: i, x: 'value' })) }, null, 2);
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 128,
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tr_1', content: pretty }],
          },
        ],
      }),
    );

    const out = await transformRequest(body, { imageCompress: false, model: 'claude-opus-5-5' });
    expect(out.info.compressed).toBe(true);
    expect(out.info.imageCount).toBe(0);
    expect(out.info.textHygieneSavedTokens).toBeGreaterThan(0);
    expect(out.body.byteLength).toBeLessThan(body.byteLength);
  });

  it('cleans DeepSeek followHosts Anthropic-compat tool results without leaking credentials or firing count_tokens', async () => {
    setAllowedModelBases(['claude-fable-5', 'gemini', 'deepseek']);
    const noisy = '\x1b[32mPASS\x1b[0m ' + JSON.stringify(
      { ok: true, items: Array.from({ length: 20 }, (_, i) => ({ i, name: `mod_${i}` })) },
      null,
      2,
    );
    const jsonOnly = JSON.stringify(
      { ok: true, items: Array.from({ length: 20 }, (_, i) => ({ i, name: `mod_${i}` })) },
      null,
      2,
    );

    const seen: { url: string; headers: Headers; body: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const r = input instanceof Request ? input : new Request(String(input), init);
      seen.push({ url: r.url, headers: r.headers, body: await r.text() });
      return new Response(
        JSON.stringify({
          id: 'ds_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    let capturedEvent: { info?: { compressed?: boolean; imageCount?: number; textHygieneSavedTokens?: number } } | undefined;
    try {
      const proxy = createProxy({
        followHosts: true,
        apiKey: mockCred('host', 'anth', 'key', 'example'),
        transform: {},
        onRequest: (e) => {
          capturedEvent = e as typeof capturedEvent;
        },
      });
      const reqBody = JSON.stringify({
        model: 'deepseek-reasoner',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tr_a', content: jsonOnly },
              { type: 'tool_result', tool_use_id: 'tr_b', content: noisy },
            ],
          },
        ],
      });
      const res = await proxy(
        new Request('http://127.0.0.1:47821/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            host: 'api.deepseek.com',
            'x-api-key': mockCred('agent', 'ds', 'key', 'example'),
            'content-type': 'application/json',
          },
          body: reqBody,
        }),
      );
      expect(res.status).toBe(200);
      await res.text();
      await new Promise((r) => setTimeout(r, 15));
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(seen[0]!.headers.get('x-api-key')).toBe('agent-ds-key-example');
    expect(seen[0]!.body).not.toContain('image');
    expect(seen[0]!.body).not.toContain('\x1b[32m');
    expect(capturedEvent?.info?.compressed).toBe(true);
    expect(capturedEvent?.info?.imageCount).toBe(0);
    expect(capturedEvent?.info?.textHygieneSavedTokens).toBeGreaterThan(0);
  });
});
