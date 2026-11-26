import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { newSummary, fold, renderTextReport } from '../src/stats.js';
import { aggregateSessions } from '../src/sessions.js';
import {
  createProxy,
  parseRejectedBetas,
  resetCountTokensRejectedBetasForTests,
  resolveTrustAdjacentToolRoundsEnv,
  withClientToolRoundShape,
  type ProxyEvent,
} from '../src/core/proxy.js';
import { isThreadContinuation } from '../src/core/measurement.js';
import { findClosedPrefixBoundary } from '../src/core/history.js';
import { resetSessionState, sessionAnchorText } from '../src/core/session-state.js';
import { transformRequest } from '../src/core/transform.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { stripSchemaDescriptions } from '../src/core/schema-strip.js';
import { parseExportArgv } from '../src/core/export.js';
import { toTrackEvent, type TrackEvent } from '../src/core/tracker.js';
import { resetGlobalMmuStore } from '../src/core/context-mmu.js';

let prevModels: string | undefined;
let prevDisable: string | undefined;

beforeAll(() => {
  prevModels = process.env.INKLING_MODELS;
  prevDisable = process.env.INKLING_DISABLE;
  process.env.INKLING_MODELS = 'claude-fable-5,gemini';
  delete process.env.INKLING_DISABLE;
});

afterAll(() => {
  if (prevModels === undefined) delete process.env.INKLING_MODELS;
  else process.env.INKLING_MODELS = prevModels;
  if (prevDisable === undefined) delete process.env.INKLING_DISABLE;
  else process.env.INKLING_DISABLE = prevDisable;
});

afterEach(() => {
  resetCountTokensRejectedBetasForTests();
  resetSessionState();
  resetGlobalMmuStore();
});

describe('teamchong/pxpipe parity fixes', () => {
  it('stats.fold() handles Google/OpenAI inclusive cached_tokens without double-subtraction and uses generic header', () => {
    const s = newSummary();
    fold(s, {
      ts: '2026-11-24T00:00:00Z',
      method: 'POST',
      path: '/v1beta/models/gemini-3.8-flash:streamGenerateContent',
      accounting_provider: 'google',
      status: 200,
      duration_ms: 100,
      input_tokens: 1000,
      output_tokens: 50,
      cached_tokens: 800,
      baseline_tokens: 1500,
      baseline_probe_status: 'ok',
    });

    expect(s.eventsWithUsage).toBe(1);
    expect(s.cacheHitEvents).toBe(1);
    expect(s.cacheReadTokensTotal).toBe(800);
    expect(s.inclusiveCacheReadTotal).toBe(800);
    expect(s.baselineTokensTotal).toBe(1500);
    // input_tokens (1000) already includes cached_tokens (800); actual input must stay 1000, not 200.
    expect(s.measuredActualTokensTotal).toBe(1000);

    const report = renderTextReport(s);
    expect(report).toContain('token usage:');
    expect(report).not.toContain('Anthropic token usage:');
    expect(report).toMatch(/cache hit rate \(by tokens\):\s+80\.0%/);
  });

  it('countTokensUpstream learns rejected anthropic-beta on 400 and records error on probe failure', async () => {
    const realFetch = globalThis.fetch;
    const seenBetas: Array<string | null> = [];
    let force500 = false;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      if (url.pathname.endsWith('/count_tokens')) {
        const beta = req.headers.get('anthropic-beta');
        seenBetas.push(beta);
        if (force500) {
          return new Response(JSON.stringify({ error: { message: 'upstream overloaded' } }), { status: 500 });
        }
        if (beta && beta.includes('tool-provenance-2026')) {
          return new Response(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'Unexpected value(s) `tool-provenance-2026` for the `anthropic-beta` header',
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ input_tokens: 1234 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 50, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      expect(
        parseRejectedBetas('Unexpected value(s) `foo-beta`, `bar-beta` for the `anthropic-beta` header'),
      ).toEqual(['foo-beta', 'bar-beta']);

      const events: ProxyEvent[] = [];
      const handle = createProxy({
        upstream: 'https://api.anthropic.com',
        onRequest: (e) => {
          events.push(e);
        },
      });

      const body = JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const res1 = await handle(
        new Request('http://127.0.0.1:47821/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'sk-ant-test',
            'anthropic-beta': 'prompt-caching-2024-07-31,tool-provenance-2026',
          },
          body,
        }),
      );
      await res1.text();
      await new Promise((r) => setTimeout(r, 20));
      expect(seenBetas).toEqual([
        'prompt-caching-2024-07-31,tool-provenance-2026',
        'prompt-caching-2024-07-31',
      ]);
      expect(events[0]?.info?.baselineTokens).toBe(1234);
      expect(events[0]?.info?.baselineProbeStatus).toBe('ok');

      force500 = true;
      const res2 = await handle(
        new Request('http://127.0.0.1:47821/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'sk-ant-test',
            'anthropic-beta': 'prompt-caching-2024-07-31,tool-provenance-2026',
          },
          body,
        }),
      );
      await res2.text();
      await new Promise((r) => setTimeout(r, 20));
      expect(events[1]?.info?.baselineProbeStatus).toBe('failed');
      expect(events[1]?.info?.baselineProbeError).toContain('http_500');
      expect(toTrackEvent(events[1]!).baseline_probe_error).toContain('http_500');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('detects server-side thread continuations and marks baselineProbeStatus=partial', async () => {
    const enc = new TextEncoder();
    expect(isThreadContinuation(enc.encode(JSON.stringify({ thread: { type: 'continue' } })))).toBe(true);
    expect(isThreadContinuation(enc.encode(JSON.stringify({ thread: { type: 'create' } })))).toBe(false);
    expect(isThreadContinuation(enc.encode(JSON.stringify({ messages: [] })))).toBe(false);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (new URL(req.url).pathname.endsWith('/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 90 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, cache_read_input_tokens: 50000, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const events: ProxyEvent[] = [];
      const handle = createProxy({
        upstream: 'https://api.anthropic.com',
        onRequest: (e) => {
          events.push(e);
        },
      });
      const res = await handle(
        new Request('http://127.0.0.1:47821/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
          body: JSON.stringify({
            model: 'claude-fable-5',
            max_tokens: 16,
            thread: { type: 'continue', previous_message_id: 'msg_prev' },
            messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] }],
          }),
        }),
      );
      await res.text();
      await new Promise((r) => setTimeout(r, 20));
      expect(events[0]?.info?.threadContinue).toBe(true);
      expect(events[0]?.info?.baselineProbeStatus).toBe('partial');
      const track = toTrackEvent(events[0]!);
      expect(track.thread_continue).toBe(true);
      expect(track.baseline_probe_status).toBe('partial');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('oversizedBodyPolicy=passthrough streams >limit payloads upstream on loopback while fail-closing on bridged models', async () => {
    const realFetch = globalThis.fetch;
    const forwardedBodies: string[] = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      forwardedBodies.push(await req.text());
      return new Response(
        JSON.stringify({ id: 'msg_big', type: 'message', role: 'assistant', content: [], usage: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const events: ProxyEvent[] = [];
      const handlePass = createProxy({
        upstream: 'https://api.anthropic.com',
        maxRequestBytes: 512,
        oversizedBodyPolicy: 'passthrough',
        onRequest: (e) => {
          events.push(e);
        },
      });
      const payload = JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'A'.repeat(2048) }],
      });
      // Chunked stream without Content-Length exceeding limit
      const chunkBytes = new TextEncoder().encode(payload);
      let off = 0;
      const streamBody = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (off >= chunkBytes.byteLength) {
            ctrl.close();
            return;
          }
          ctrl.enqueue(chunkBytes.slice(off, off + 256));
          off += 256;
        },
      });
      const resPass = await handlePass(
        new Request('http://127.0.0.1:47821/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
          body: streamBody,
          // @ts-expect-error duplex needed for ReadableStream Request body
          duplex: 'half',
        }),
      );
      expect(resPass.status).toBe(200);
      await resPass.text();
      await new Promise((r) => setTimeout(r, 20));
      expect(forwardedBodies).toEqual([payload]);
      expect(events[0]?.info?.compressed).toBe(false);
      expect(events[0]?.info?.reason).toBe('body_too_large');

      // Bridged model routes cannot forward unparsed Anthropic JSON across provider boundaries -> 413.
      const handleBridged = createProxy({
        upstream: 'https://api.anthropic.com',
        openAIApiKey: 'sk-openai-test',
        openAIModels: ['gpt-6-astra'],
        maxRequestBytes: 512,
        oversizedBodyPolicy: 'passthrough',
      });
      const resBridged = await handleBridged(
        new Request('http://127.0.0.1:47821/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
          body: payload,
        }),
      );
      expect(resBridged.status).toBe(413);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('collapses pure tool loops only when separateAdjacentToolPairs is active and never closes on tool_use', () => {
    const pureToolLoop = [
      { role: 'user' as const, content: 'start' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't1', name: 'Read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: 'ok1' }] },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't2', name: 'Read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't2', content: 'ok2' }] },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't3', name: 'Read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't3', content: 'ok3' }] },
    ];
    // Conservative mode treats consecutive pairs ending at cutoff=5 followed by tool_use as one round -> boundary=0
    expect(findClosedPrefixBoundary(pureToolLoop, 5, false)).toBe(0);
    // Separate adjacent pairs mode lets cutoff=5 close after t2/ok2 (index 4)
    expect(findClosedPrefixBoundary(pureToolLoop, 5, true)).toBe(4);

    // Non-string id on assistant tool_use must NEVER close on that assistant message (index 1)
    const malformedToolUse = [
      { role: 'user' as const, content: 'start' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: undefined as unknown as string, name: 'Read', input: {} }] },
    ];
    expect(findClosedPrefixBoundary(malformedToolUse, 2, true)).toBe(0);

    const ccHeaders = new Headers({ 'user-agent': 'claude-cli/2.1.329', 'x-app': 'cli' });
    const genericHeaders = new Headers({ 'user-agent': 'opencode/1.0' });
    expect(withClientToolRoundShape({}, ccHeaders)?.separateAdjacentToolPairs).toBe(true);
    expect(withClientToolRoundShape({}, genericHeaders)?.separateAdjacentToolPairs).toBeUndefined();
    expect(withClientToolRoundShape({ separateAdjacentToolPairs: false }, ccHeaders)?.separateAdjacentToolPairs).toBe(false);
    expect(resolveTrustAdjacentToolRoundsEnv('1').value).toBe(true);
    expect(resolveTrustAdjacentToolRoundsEnv('0').value).toBe(false);
    expect(resolveTrustAdjacentToolRoundsEnv('maybe').warning).toContain('FICHE_TRUST_ADJACENT_TOOL_ROUNDS');
  });

  it('skips slash-command boilerplate in sessionAnchorText and isolates sessions by claudeCodeSessionId', async () => {
    const anchor = sessionAnchorText([
      '<local-command-caveat>caveat</local-command-caveat>\n<command-name>/effort</command-name>',
      '<local-command-stdout>Set effort level to high</local-command-stdout>',
      'actual user task prompt',
    ]);
    expect(anchor).toBe('actual user task prompt');

    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude-fable-5',
        system: 'Static instructions.\n'.repeat(400),
        messages: [{ role: 'user', content: 'same opening prompt across two terminals' }],
      }),
    );
    const a = await transformRequest(body, { claudeCodeSessionId: 'session-alpha-1111' });
    const b = await transformRequest(body, { claudeCodeSessionId: 'session-beta-2222' });
    expect(a.info.firstUserSha8).toBe(b.info.firstUserSha8);
    expect(a.info.sessionKey).not.toBe(b.info.sessionKey);
    expect(a.info.sessionKeySource).toBe('claude-code-header');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-sess-iso-'));
    try {
      const eventsFile = path.join(dir, 'events.jsonl');
      const sidecarDir = path.join(dir, '4xx-bodies');
      const rows: TrackEvent[] = [
        {
          ts: '2026-11-24T00:00:00Z',
          method: 'POST',
          path: '/v1/messages',
          status: 200,
          duration_ms: 50,
          first_user_sha8: a.info.firstUserSha8,
          session_key: a.info.sessionKey,
        },
        {
          ts: '2026-11-24T00:00:01Z',
          method: 'POST',
          path: '/v1/messages',
          status: 200,
          duration_ms: 50,
          first_user_sha8: b.info.firstUserSha8,
          session_key: b.info.sessionKey,
        },
      ];
      fs.writeFileSync(eventsFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const { sessions } = await aggregateSessions({ eventsFile, sidecarDir });
      expect(sessions.size).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves property names inside dependentSchemas/dependencies/dependentRequired in stripSchemaDescriptions', () => {
    const stripped = stripSchemaDescriptions({
      type: 'object',
      description: 'root desc stripped',
      properties: {
        description: { type: 'string', description: 'prop desc stripped' },
      },
      dependentSchemas: {
        description: {
          type: 'object',
          description: 'nested desc stripped',
          properties: {
            title: { type: 'string', title: 'title attr stripped' },
          },
          required: ['title'],
        },
      },
      dependencies: {
        default: ['description'],
      },
      dependentRequired: {
        examples: ['title'],
      },
    }) as Record<string, unknown>;

    expect(stripped.description).toBeUndefined();
    const depSchemas = stripped.dependentSchemas as Record<string, Record<string, unknown>>;
    expect(depSchemas.description).toBeDefined();
    expect(depSchemas.description?.description).toBeUndefined();
    expect((depSchemas.description?.properties as Record<string, unknown>)?.title).toEqual({ type: 'string' });
    expect(stripped.dependencies).toEqual({ default: ['description'] });
    expect(stripped.dependentRequired).toEqual({ examples: ['title'] });
  });

  it('rejects flag-shaped --out and --model values in parseExportArgv', () => {
    expect(parseExportArgv(['--out', '--json', 'src/'])).toEqual({
      kind: 'error',
      message: '--out requires a value',
    });
    expect(parseExportArgv(['--model', '--json', 'src/'])).toEqual({
      kind: 'error',
      message: '--model requires a value',
    });
  });

  it('populates systemSha8 on Google requests and keeps live-tail file reads verbatim while imaging bash outputs', async () => {
    const bigFile = Array.from({ length: 120 }, (_, i) => `const line_${i} = ${i};`).join('\n');
    const bigLog = Array.from({ length: 180 }, (_, i) => `2026-11-24T12:00:00Z INFO step ${i} completed cleanly`).join('\n');
    const body = new TextEncoder().encode(
      JSON.stringify({
        systemInstruction: { parts: [{ text: 'System instruction. '.repeat(250) }] },
        contents: [
          { role: 'user', parts: [{ text: 'inspect files' }] },
          {
            role: 'model',
            parts: [
              { functionCall: { name: 'default_api:read_file', args: { path: 'src/a.ts' } } },
              { functionCall: { name: 'run_command', args: { cmd: 'cat log' } } },
            ],
          },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'default_api:read_file', response: { content: bigFile } } },
              { functionResponse: { name: 'run_command', response: { output: bigLog } } },
            ],
          },
        ],
      }),
    );

    const res = await transformGoogleGenerateContent(body, 'gemini-3.8-flash', {
      compress: true,
      compressToolResults: true,
      minToolResultChars: 500,
    });
    expect(res.info.systemSha8).toMatch(/^[0-9a-f]{8}$/);
    const outJson = JSON.parse(new TextDecoder().decode(res.body)) as {
      contents: Array<{ parts?: Array<{ functionResponse?: { name?: string; response?: { content?: string; output?: string } } }> }>;
    };
    const respTurn = outJson.contents[outJson.contents.length - 1]!;
    const readPart = respTurn.parts?.find((p) => p.functionResponse?.name === 'default_api:read_file');
    const bashPart = respTurn.parts?.find((p) => p.functionResponse?.name === 'run_command');
    expect(readPart?.functionResponse?.response?.content).toBe(bigFile);
    expect(bashPart?.functionResponse?.response?.output).not.toBe(bigLog);
  });
});
