/**
 * Fail open: when the renderer throws mid-transform, the proxy forwards the
 * request exactly as it arrived instead of answering 502. The renderer is
 * mocked to throw, so this runs the real createProxy and transform wiring.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/render.js')>();
  const boom = async (): Promise<never> => {
    throw new Error('renderer exploded');
  };
  return {
    ...actual,
    renderChunkToPng: boom,
    renderTextToPngsReflow: boom,
    renderTextToPngsWithCharLimit: boom,
    renderTextToPngs: boom,
    renderDensePages: boom,
  };
});

const { createProxy } = await import('../src/core/proxy.js');
type ProxyEvent = import('../src/core/proxy.js').ProxyEvent;

let ambientModels: string | undefined;
beforeAll(() => {
  ambientModels = process.env.INKLING_MODELS;
  process.env.INKLING_MODELS = 'claude-fable-5';
});
afterAll(() => {
  if (ambientModels === undefined) delete process.env.INKLING_MODELS;
  else process.env.INKLING_MODELS = ambientModels;
});

const rows = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, path: `src/file-${i}.ts`, note: 'row' })));

describe('fail open', () => {
  it('forwards the original body when the renderer throws', async () => {
    const body = JSON.stringify({
      model: 'claude-fable-5',
      max_tokens: 64,
      system: [{ type: 'text', text: `Conventions.\n${rows}` }],
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: rows }] },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'next' },
      ],
    });
    const real = globalThis.fetch;
    let forwarded: string | undefined;
    globalThis.fetch = (async (req: Request | string | URL, init?: RequestInit) => {
      const r = req instanceof Request ? req : new Request(String(req), init);
      if (r.url.endsWith('/count_tokens')) return new Response(JSON.stringify({ input_tokens: 1 }));
      forwarded = await r.text();
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    let event: ProxyEvent | undefined;
    let status = 0;
    try {
      const proxy = createProxy({
        transform: { charsPerToken: 1, minCompressChars: 1 },
        onRequest: (e) => { event = e; },
      });
      const res = await proxy(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }));
      status = res.status;
      await res.text();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      globalThis.fetch = real;
    }
    expect(status).toBe(200);
    expect(forwarded).toBe(body);
    expect(event?.info?.reason).toMatch(/^transform_error_fail_open: renderer exploded/);
    expect(event?.info?.imageCount).toBe(0);
  });
});
