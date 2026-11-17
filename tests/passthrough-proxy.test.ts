/**
 * Pass-through through the real proxy wiring (createProxy). Each test fails if
 * the proxy rewrites a request it should leave alone (out-of-scope model,
 * compress off, or a weak or unmeasured reader even when listed in scope),
 * stops imaging a strong reader, or sends prompt_cache_breakpoint to Codex.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import type { TransformOptions } from '../src/core/transform.js';

// Weak readers are listed on purpose: being in scope must not image them.
const SCOPE = 'claude-opus-5-5,claude-fable-5,gpt-5.6-sol,grok-4.7,gemini';
let ambientModels: string | undefined;
let ambientForce: string | undefined;
beforeAll(() => {
  ambientModels = process.env.INKLING_MODELS;
  ambientForce = process.env.INKLING_FORCE_IMAGES;
  process.env.INKLING_MODELS = SCOPE;
  delete process.env.INKLING_FORCE_IMAGES;
});
afterAll(() => {
  if (ambientModels === undefined) delete process.env.INKLING_MODELS;
  else process.env.INKLING_MODELS = ambientModels;
  if (ambientForce === undefined) delete process.env.INKLING_FORCE_IMAGES;
  else process.env.INKLING_FORCE_IMAGES = ambientForce;
});

function rows(n: number): string {
  return JSON.stringify({
    events: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      status: 'ok',
      path: 'src/core/hybrid.ts',
      note: 'proxy wiring fixture row',
    })),
  });
}

const TOOL_JSON = rows(60);
const FENCED_DRAFT = `Plan:\n\`\`\`json\n${rows(30)}\n\`\`\``;

function anthropicBody(model: string): string {
  return JSON.stringify({
    model,
    max_tokens: 64,
    metadata: { user_id: JSON.stringify({ device: 'd'.repeat(40), session: rows(8) }) },
    system: [{ type: 'text', text: 'Follow the repository conventions.' }],
    tools: [{ name: 'Write', description: rows(10), input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: `Fix the indentation of this:\n${rows(20)}` },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: FENCED_DRAFT, signature: 'sig-abc' },
          { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { path: 'a.json', content: rows(30) } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: TOOL_JSON }] },
    ],
  });
}

const UPSTREAM_OK = () => new Response(JSON.stringify({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

async function send(
  path: string,
  body: string,
  transform: TransformOptions = {},
  extra: { openAIUpstream?: string } = {},
): Promise<{ upstream: string; url: string; event?: ProxyEvent }> {
  const real = globalThis.fetch;
  let upstream = '';
  let url = '';
  globalThis.fetch = (async (req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    url = r.url;
    upstream = await r.text();
    return UPSTREAM_OK();
  }) as typeof fetch;
  let event: ProxyEvent | undefined;
  try {
    const proxy = createProxy({ transform, onRequest: (e) => { event = e; }, ...extra });
    const res = await proxy(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }));
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = real;
  }
  return { upstream, url, event };
}

const BIG = { charsPerToken: 1, minCompressChars: 1 };

describe('proxy pass-through', () => {
  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'grok-4.7'])(
    'leaves a %s request byte-identical even with aggressive thresholds',
    async (model) => {
      const body = anthropicBody(model);
      const { upstream, event } = await send('/v1/messages', body, BIG);
      expect(upstream).toBe(body);
      expect(event?.info?.imageCount ?? 0).toBe(0);
    },
  );

  it('images Gemini 4 argon but leaves unmeasured hydrogen byte-identical', async () => {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: 'System instruction. '.repeat(300) }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    async function gemini(model: string): Promise<string> {
      const real = globalThis.fetch;
      const forwarded: string[] = [];
      globalThis.fetch = (async (req: Request | string | URL, init?: RequestInit) => {
        const r = req instanceof Request ? req : new Request(String(req), init);
        // No countTokens probe: the proxy keeps its local profitability call.
        if (r.url.includes(':countTokens')) return new Response('no', { status: 503 });
        forwarded.push(await r.text());
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 1 },
        }), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      try {
        const proxy = createProxy({ upstream: 'http://gateway.test', transform: { compress: true } });
        const res = await proxy(new Request(
          `http://localhost/google-ai-studio/v1beta/models/${model}:generateContent`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body },
        ));
        await res.text();
        await new Promise((r) => setTimeout(r, 20));
      } finally {
        globalThis.fetch = real;
      }
      expect(forwarded).toHaveLength(1);
      return forwarded[0]!;
    }
    expect(await gemini('gemini-4-argon')).toContain('inlineData');
    expect(await gemini('gemini-4-hydrogen')).toBe(body);
  });

  it('still images a strong reader', async () => {
    const fable = await send('/v1/messages', anthropicBody('claude-fable-5'), BIG);
    expect(fable.event?.info?.imageCount ?? 0).toBeGreaterThan(0);
    expect(fable.upstream).not.toBe(anthropicBody('claude-fable-5'));
  });

  it('leaves an out-of-scope model byte-identical', async () => {
    const body = anthropicBody('claude-opus-4-8');
    const { upstream } = await send('/v1/messages', body, BIG);
    expect(upstream).toBe(body);
  });

  it('leaves a strong reader byte-identical when compress is false', async () => {
    const body = anthropicBody('claude-fable-5');
    const { upstream } = await send('/v1/messages', body, { ...BIG, compress: false });
    expect(upstream).toBe(body);
  });

  it('sends no prompt_cache_breakpoint to Codex, but api.openai.com gets one', async () => {
    const body = JSON.stringify({
      model: 'gpt-5.6-sol',
      instructions: 'These are detailed instructions for the coding agent. '.repeat(400),
      input: [{ role: 'user', content: 'Reply with exactly: OK' }],
    });
    const big = { charsPerToken: 1, minCompressChars: 1 };
    const openai = await send('/v1/responses', body, big, { openAIUpstream: 'https://api.openai.com' });
    expect(openai.upstream).toContain('"prompt_cache_breakpoint"');
    const codex = await send('/backend-api/codex/responses', body, big, { openAIUpstream: 'https://chatgpt.com' });
    expect(codex.url).toContain('chatgpt.com');
    expect(codex.upstream).not.toContain('"prompt_cache_breakpoint"');
  });

});
