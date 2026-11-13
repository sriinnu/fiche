/**
 * PAKT through the real proxy wiring (createProxy), not hybridTransform.
 * Each test here fails if the proxy stops applying PAKT, rewrites anything
 * outside tool results, ignores the model scope or compress switch, sends a
 * prompt_cache_breakpoint to Codex, or images a PAKT-only reader.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import type { TransformOptions } from '../src/core/transform.js';

const SCOPE = 'claude-opus-5-5,claude-fable-5,gpt-5.6-sol';
let ambientModels: string | undefined;
let ambientPakt: string | undefined;
beforeAll(() => {
  ambientModels = process.env.INKLING_MODELS;
  ambientPakt = process.env.INKLING_PAKT;
  process.env.INKLING_MODELS = SCOPE;
});
afterAll(() => {
  if (ambientModels === undefined) delete process.env.INKLING_MODELS;
  else process.env.INKLING_MODELS = ambientModels;
  if (ambientPakt === undefined) delete process.env.INKLING_PAKT;
  else process.env.INKLING_PAKT = ambientPakt;
});
afterEach(() => {
  delete process.env.INKLING_PAKT;
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

describe('PAKT in the proxy', () => {
  it('packs only the tool result on an Anthropic request', async () => {
    const body = anthropicBody('claude-opus-5-5');
    const { upstream, event } = await send('/v1/messages', body);
    const sent = JSON.parse(upstream);
    const orig = JSON.parse(body);

    const tool = sent.messages[2].content[0].content as string;
    expect(tool).toContain('Pipe-Aligned Kompact Text');
    expect(tool).toContain('@from json');
    expect(event?.info?.reason).toBe('pakt_text');

    // Everything outside the tool result is byte-for-byte what the client sent.
    expect(sent.system).toEqual(orig.system);
    expect(sent.tools).toEqual(orig.tools);
    expect(sent.metadata).toEqual(orig.metadata);
    expect(sent.messages[0]).toEqual(orig.messages[0]);
    expect(sent.messages[1]).toEqual(orig.messages[1]);
  });

  it('never images a PAKT-only reader, while an image reader is imaged', async () => {
    const big = { charsPerToken: 1, minCompressChars: 1 };
    const opus = await send('/v1/messages', anthropicBody('claude-opus-5-5'), big);
    expect(opus.event?.info?.imageCount ?? 0).toBe(0);
    const fable = await send('/v1/messages', anthropicBody('claude-fable-5'), big);
    expect(fable.event?.info?.imageCount ?? 0).toBeGreaterThan(0);
  });

  it('leaves an out-of-scope model byte-identical', async () => {
    const body = anthropicBody('claude-opus-4-8');
    const { upstream } = await send('/v1/messages', body);
    expect(upstream).toBe(body);
  });

  it('leaves the body byte-identical when compress is false', async () => {
    const body = anthropicBody('claude-opus-5-5');
    const { upstream } = await send('/v1/messages', body, { compress: false });
    expect(upstream).toBe(body);
  });

  it('leaves the body byte-identical when INKLING_PAKT=off', async () => {
    process.env.INKLING_PAKT = 'off';
    const body = anthropicBody('claude-opus-5-5');
    const { upstream } = await send('/v1/messages', body);
    expect(upstream).toBe(body);
  });

  it('does not pack a tool result holding an integer past 2^53', async () => {
    const big = TOOL_JSON.replace('"id":1,', '"id":12345678901234567890,');
    const body = JSON.stringify({
      model: 'claude-opus-5-5',
      max_tokens: 64,
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: big }] }],
    });
    const { upstream } = await send('/v1/messages', body);
    expect(upstream).toBe(body);
    expect(JSON.parse(upstream).messages[0].content[0].content).toContain('12345678901234567890');
  });

  it('does not reserialize a request whose own JSON holds an integer past 2^53', async () => {
    const body = anthropicBody('claude-opus-5-5').replace('"max_tokens":64', '"max_tokens":64,"trace":12345678901234567890');
    expect(body).toContain('"trace":12345678901234567890');
    const { upstream } = await send('/v1/messages', body);
    expect(upstream).toContain('"trace":12345678901234567890');
  });

  it('packs a Chat tool message and leaves tool_calls arguments valid JSON', async () => {
    const args = rows(20);
    const body = JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: args } }] },
        { role: 'tool', tool_call_id: 'c1', content: TOOL_JSON },
      ],
    });
    const { upstream } = await send('/v1/chat/completions', body);
    const sent = JSON.parse(upstream);
    expect(sent.messages[1].tool_calls[0].function.arguments).toBe(args);
    expect(sent.messages[2].content).toContain('@from json');
  });

  it('packs a Responses function_call_output and keeps function_call.arguments', async () => {
    const args = rows(20);
    const body = JSON.stringify({
      model: 'gpt-5.6-sol',
      instructions: 'short',
      input: [
        { role: 'user', content: 'go' },
        { type: 'function_call', call_id: 'c1', name: 'w', arguments: args },
        { type: 'function_call_output', call_id: 'c1', output: TOOL_JSON },
      ],
    });
    const { upstream } = await send('/v1/responses', body);
    const sent = JSON.parse(upstream);
    expect(sent.input[1].arguments).toBe(args);
    expect(JSON.stringify(sent.input[2])).toContain('@from json');
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

  it('decides each tool result on its own, so an earlier turn is not rewritten later', async () => {
    const small = rows(3);
    const turn1 = JSON.stringify({
      model: 'claude-opus-5-5',
      max_tokens: 64,
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: small }] },
      ],
    });
    const first = await send('/v1/messages', turn1);
    const turn2Obj = JSON.parse(turn1);
    turn2Obj.messages.push(
      { role: 'assistant', content: 'next' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: TOOL_JSON }] },
    );
    const second = await send('/v1/messages', JSON.stringify(turn2Obj));
    const a = JSON.parse(first.upstream);
    const b = JSON.parse(second.upstream);
    expect(b.system).toEqual(a.system);
    expect(b.messages[0]).toEqual(a.messages[0]);
    expect(b.messages[2].content[0].content).toContain('@from json');
  });
});
