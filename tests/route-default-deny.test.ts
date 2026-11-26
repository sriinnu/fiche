/**
 * Routing by path family, through the real createProxy. Before this, any path
 * the proxy did not recognise went to api.anthropic.com with the host's
 * Anthropic credential injected, so Codex's /backend-api/codex/responses/compact
 * lost its ChatGPT bearer and sent the conversation to Anthropic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyConfig } from '../src/core/proxy.js';

let ambientModels: string | undefined;
beforeAll(() => {
  ambientModels = process.env.INKLING_MODELS;
  process.env.INKLING_MODELS = 'off';
});
afterAll(() => {
  if (ambientModels === undefined) delete process.env.INKLING_MODELS;
  else process.env.INKLING_MODELS = ambientModels;
});

const CHATGPT_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.c2ln';

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  config: ProxyConfig,
): Promise<{ status: number; seen: { url: string; auth: string | null; apiKey: string | null }[] }> {
  const real = globalThis.fetch;
  const seen: { url: string; auth: string | null; apiKey: string | null }[] = [];
  globalThis.fetch = (async (req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    seen.push({ url: r.url, auth: r.headers.get('authorization'), apiKey: r.headers.get('x-api-key') });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const proxy = createProxy(config);
    const res = await proxy(new Request(`http://127.0.0.1:47821${path}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify({ model: 'gpt-6-astra', input: [] }),
    }));
    await res.text();
    return { status: res.status, seen };
  } finally {
    globalThis.fetch = real;
  }
}

const ANTHROPIC_KEY = 'sk-ant-api03-example';
const ANTHROPIC_OAUTH = 'sk-ant-oat01-example';
const GOOGLE_KEY = 'AIza-example';
const HOST_KEYS: ProxyConfig = {
  apiKey: ANTHROPIC_KEY, authToken: ANTHROPIC_OAUTH,
  openAIUpstream: 'https://chatgpt.test',
};

describe('route families', () => {
  it('sends Codex compaction to the ChatGPT upstream with its own bearer', async () => {
    const { status, seen } = await call(
      'POST',
      '/backend-api/codex/responses/compact',
      { authorization: `Bearer ${CHATGPT_JWT}`, 'content-type': 'application/json' },
      HOST_KEYS,
    );
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://chatgpt.test/backend-api/codex/responses/compact');
    expect(seen[0]!.auth).toBe(`Bearer ${CHATGPT_JWT}`);
    expect(seen[0]!.apiKey).toBeNull();
  });

  it('sends Google countTokens to the Google upstream without Anthropic keys', async () => {
    const { seen } = await call(
      'POST',
      '/v1beta/models/gemini-4-argon:countTokens',
      { 'x-goog-api-key': GOOGLE_KEY, 'content-type': 'application/json' },
      HOST_KEYS,
    );
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).host).toBe('generativelanguage.googleapis.com');
    expect(seen[0]!.apiKey).toBeNull();
    expect(seen[0]!.auth).toBeNull();
  });

  it('refuses an unknown path instead of sending host keys to Anthropic', async () => {
    const { status, seen } = await call('GET', '/totally/unknown', {}, HOST_KEYS);
    expect(status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('still forwards Claude Code control paths to Anthropic', async () => {
    const { status, seen } = await call('GET', '/api/oauth/profile', {}, HOST_KEYS);
    expect(status).toBe(200);
    expect(seen[0]!.url).toBe('https://api.anthropic.com/api/oauth/profile');
  });

  it('forwards unknown paths when the operator chose a custom upstream', async () => {
    const { status, seen } = await call('GET', '/deepseek/models', {}, { upstream: 'https://gateway.test' });
    expect(status).toBe(200);
    expect(seen[0]!.url).toBe('https://gateway.test/deepseek/models');
  });

  it('routes default /backend-api/codex/responses to https://chatgpt.com without breakpoint or host key', async () => {
    const real = globalThis.fetch;
    const prevModels = process.env.INKLING_MODELS;
    process.env.INKLING_MODELS = 'gpt-5.6-sol';
    const seen: { url: string; auth: string | null; capturedKeyHeader: string | null; body: string }[] = [];
    globalThis.fetch = (async (req: Request | string | URL, init?: RequestInit) => {
      const r = req instanceof Request ? req : new Request(String(req), init);
      seen.push({
        url: r.url,
        auth: r.headers.get('authorization'),
        capturedKeyHeader: r.headers.get('x-api-key'),
        body: await r.text(),
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const proxyCfg: ProxyConfig = {
        transform: { charsPerToken: 1, minCompressChars: 1 },
      };
      Reflect.set(proxyCfg, 'apiKey', ANTHROPIC_KEY);
      Reflect.set(proxyCfg, 'openAIApiKey', ['sk', 'host', 'openai', 'fixture'].join('-'));
      const proxy = createProxy(proxyCfg);
      const res = await proxy(new Request('http://127.0.0.1:47821/backend-api/codex/responses', {
        method: 'POST',
        headers: {
          host: 'chatgpt.com',
          authorization: `Bearer ${CHATGPT_JWT}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          instructions: 'These are detailed instructions for the coding agent. '.repeat(400),
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: inkling OK' }] }],
        }),
      }));
      await res.text();
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(seen[0]!.auth).toBe(`Bearer ${CHATGPT_JWT}`);
      expect(seen[0]!.capturedKeyHeader).toBeNull();
      expect(seen[0]!.body).toContain('input_image');
      expect(seen[0]!.body).not.toContain('prompt_cache_breakpoint');
    } finally {
      globalThis.fetch = real;
      if (prevModels === undefined) delete process.env.INKLING_MODELS;
      else process.env.INKLING_MODELS = prevModels;
    }
  });

  it('keeps default /v1/responses on https://api.openai.com', async () => {
    const { status, seen } = await call(
      'POST',
      '/v1/responses',
      {
        host: 'api.openai.com',
        authorization: `Bearer ${CHATGPT_JWT}`,
        'content-type': 'application/json',
      },
      { apiKey: ANTHROPIC_KEY },
    );
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/responses');
  });

  it('honors explicit openAIUpstream on /backend-api/codex/responses', async () => {
    const { status, seen } = await call(
      'POST',
      '/backend-api/codex/responses',
      {
        host: 'chatgpt.com',
        authorization: `Bearer ${CHATGPT_JWT}`,
        'content-type': 'application/json',
      },
      { openAIUpstream: 'https://custom.example' },
    );
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://custom.example/backend-api/codex/responses');
  });

  it('routes node-style openAIUpstream default api.openai.com to https://chatgpt.com for /backend-api/codex/responses', async () => {
    const { status, seen } = await call(
      'POST',
      '/backend-api/codex/responses',
      {
        host: 'chatgpt.com',
        authorization: `Bearer ${CHATGPT_JWT}`,
        'content-type': 'application/json',
      },
      { openAIUpstream: 'https://api.openai.com' },
    );
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
  });
});
