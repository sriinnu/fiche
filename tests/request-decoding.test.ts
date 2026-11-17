import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as zlib from 'node:zlib';
import { createProxy } from '../src/core/proxy.js';
import { decodeRequestBody } from '../src/request-decoding.js';

// Codex's built-in `openai` provider zstd-compresses its Responses POST when it
// falls back from WebSocket to HTTP (sniffed from codex-cli 0.167.1: header
// `content-encoding: zstd`, body magic 28b52ffd). Undecoded, that body is not
// JSON, the transform skips it and nothing is saved.

let ambient: string | undefined;
beforeAll(() => {
  ambient = process.env.INKLING_MODELS;
  process.env.INKLING_MODELS = 'gpt-5.6-sol';
});
afterAll(() => {
  if (ambient === undefined) delete process.env.INKLING_MODELS;
  else process.env.INKLING_MODELS = ambient;
});

const zstd = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
const BODY = JSON.stringify({
  model: 'gpt-5.6-sol',
  instructions: 'These are detailed instructions for the coding agent. '.repeat(400),
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: inkling OK' }] }],
  stream: true,
});

async function send(body: Uint8Array, encoding: string, opts: { decode?: boolean; maxRequestBytes?: number } = {}) {
  const seen: { encoding: string | null; bytes: Uint8Array }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    seen.push({ encoding: r.headers.get('content-encoding'), bytes: new Uint8Array(await r.arrayBuffer()) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const proxy = createProxy({
      transform: {},
      openAIUpstream: 'https://chatgpt.com',
      ...(opts.decode === false ? {} : { decodeRequestBody }),
      ...(opts.maxRequestBytes ? { maxRequestBytes: opts.maxRequestBytes } : {}),
    });
    const res = await proxy(new Request('http://127.0.0.1/backend-api/codex/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': encoding },
      body,
    }));
    await res.text();
  } finally {
    globalThis.fetch = real;
  }
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

const plain = new TextEncoder().encode(BODY);
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('compressed request bodies', () => {
  it.runIf(typeof zstd === 'function')('decodes a zstd Codex body, transforms it, and forwards plain JSON', async () => {
    const up = await send(new Uint8Array(zstd!(Buffer.from(plain))), 'zstd');
    expect(up.encoding).toBeNull();
    const out = JSON.parse(new TextDecoder().decode(up.bytes)) as { input: unknown[] };
    expect(JSON.stringify(out.input)).toContain('input_image');
  });

  it('decodes gzip the same way', async () => {
    const up = await send(new Uint8Array(zlib.gzipSync(plain)), 'gzip');
    expect(up.encoding).toBeNull();
    expect(new TextDecoder().decode(up.bytes)).toContain('input_image');
  });

  it('without a decoder, forwards the encoded bytes and header untouched', async () => {
    const gz = new Uint8Array(zlib.gzipSync(plain));
    const up = await send(gz, 'gzip', { decode: false });
    expect(up.encoding).toBe('gzip');
    expect(sameBytes(up.bytes, gz)).toBe(true);
  });

  it('refuses to expand past maxRequestBytes and passes the original through', async () => {
    const bomb = new Uint8Array(zlib.gzipSync(Buffer.alloc(4 << 20, 0x20)));
    const up = await send(bomb, 'gzip', { maxRequestBytes: 1 << 20 });
    expect(up.encoding).toBe('gzip');
    expect(sameBytes(up.bytes, bomb)).toBe(true);
  });

  it('passes corrupt or unknown encodings through untouched', async () => {
    const junk = new TextEncoder().encode('not really gzip');
    const a = await send(junk, 'gzip');
    expect(a.encoding).toBe('gzip');
    expect(sameBytes(a.bytes, junk)).toBe(true);
    const b = await send(plain, 'compress');
    expect(b.encoding).toBe('compress');
    expect(sameBytes(b.bytes, plain)).toBe(true);
  });

  it('undoes stacked codings in reverse order', () => {
    const stacked = zlib.brotliCompressSync(zlib.gzipSync(plain));
    const out = decodeRequestBody(new Uint8Array(stacked), 'gzip, br', 1 << 24);
    expect(out && sameBytes(out, plain)).toBe(true);
  });
});

describe('WebSocket handshakes', () => {
  it('answers 426 locally instead of forwarding a doomed GET upstream', async () => {
    let upstreamCalls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      upstreamCalls++;
      return new Response('', { status: 405 });
    }) as typeof fetch;
    try {
      const proxy = createProxy({ transform: {}, openAIUpstream: 'https://chatgpt.com' });
      const res = await proxy(new Request('http://127.0.0.1/backend-api/codex/responses', {
        method: 'GET',
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
      }));
      expect(res.status).toBe(426);
      await res.text();
    } finally {
      globalThis.fetch = real;
    }
    expect(upstreamCalls).toBe(0);
  });
});
