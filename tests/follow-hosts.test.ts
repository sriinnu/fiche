import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyConfig } from '../src/core/proxy.js';
import { guardProxyRequest } from '../src/core/request-guard.js';
import { buildUpstreamRegistry, parseUpstreamHosts, resolveFollowTarget } from '../src/core/upstream-hosts.js';
import { compatRoutes } from '../src/warp/index.js';
import { matchRoute } from '../src/warp/route.js';

// "Follow the agent": a request for a registered third-party provider goes to
// that provider over https with only the agent's own credential. Before this, a
// DeepSeek request under warp was forwarded to api.anthropic.com with the
// host's Anthropic key injected.

let ambient: string | undefined;
beforeAll(() => {
  ambient = process.env.INKLING_MODELS;
  process.env.INKLING_MODELS = 'claude-fable-5,gpt-5.6-sol';
});
afterAll(() => {
  if (ambient === undefined) delete process.env.INKLING_MODELS;
  else process.env.INKLING_MODELS = ambient;
});

const HOST_KEY = 'host-key-example';
const HOST_TOKEN = 'oauth-example';
const GATEWAY_TOKEN = 'gateway-example';
const HOST_OPENAI_KEY = 'openai-example';
const AGENT_KEY = 'agent-key-example';
const AGENT_TOKEN = 'agent-example';
const ANTHROPIC_OAUTH = 'sk-ant-oat01-example';
const ANTHROPIC_KEY = 'sk-ant-api03-example';

interface Seen { url: string; headers: Headers; body: Uint8Array; redirect: RequestRedirect | undefined }

const HOST_CREDENTIALS = { apiKey: HOST_KEY, authToken: HOST_TOKEN, openAIApiKey: HOST_OPENAI_KEY };
const HOST_CONFIG: ProxyConfig = {
  transform: {},
  followHosts: true,
  ...HOST_CREDENTIALS,
  gatewayHeaders: { 'cf-aig-authorization': `Bearer ${GATEWAY_TOKEN}` },
  openAIModels: ['gpt-5.6-sol'],
};

async function send(
  path: string,
  init: { host?: string; headers?: Record<string, string>; body?: string; method?: string } = {},
  config: ProxyConfig = HOST_CONFIG,
) {
  const seen: Seen[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, reqInit?: RequestInit) => {
    const r = input instanceof Request ? input : new Request(String(input), reqInit);
    seen.push({
      url: r.url,
      headers: r.headers,
      body: new Uint8Array(await r.arrayBuffer()),
      redirect: reqInit?.redirect,
    });
    return new Response('{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  let status = 0;
  try {
    const proxy = createProxy(config);
    const res = await proxy(new Request(`http://127.0.0.1:47821${path}`, {
      method: init.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        host: init.host ?? '127.0.0.1:47821',
        ...init.headers,
      },
      ...(init.method === 'GET' ? {} : { body: init.body ?? DEEPSEEK_BODY }),
    }));
    status = res.status;
    await res.text();
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    globalThis.fetch = real;
  }
  return { status, seen };
}

const DEEPSEEK_BODY = JSON.stringify({
  model: 'deepseek-chat',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
});
const plainBytes = (s: string) => new TextEncoder().encode(s);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe('follow the agent: routing', () => {
  it('forwards a warp Host request to the agent\'s own host, byte-identical, with only its own key', async () => {
    const { status, seen } = await send('/anthropic/v1/messages', {
      host: 'api.deepseek.com',
      headers: { 'x-api-key': AGENT_KEY, 'anthropic-version': '2023-06-01' },
    });
    expect(status).toBe(200);
    expect(seen).toHaveLength(1); // no count_tokens probe to Anthropic
    const up = seen[0]!;
    expect(up.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(up.headers.get('x-api-key')).toBe(AGENT_KEY);
    expect(up.headers.get('authorization')).toBeNull();
    expect(up.headers.get('cf-aig-authorization')).toBeNull();
    expect(up.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(same(up.body, plainBytes(DEEPSEEK_BODY))).toBe(true);
  });

  it('serves base-URL agents through /to/<host>/ with the query intact', async () => {
    const { seen } = await send('/to/api.deepseek.com/anthropic/v1/messages?beta=true', {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.deepseek.com/anthropic/v1/messages?beta=true');
    expect(seen[0]!.headers.get('authorization')).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(seen[0]!.headers.get('x-api-key')).toBeNull();
  });

  it('never follows redirects for a followed host', async () => {
    const { seen } = await send('/anthropic/v1/messages', { host: 'api.deepseek.com' });
    expect(seen[0]!.redirect).toBe('manual');
  });

  it('drops Anthropic-issued credentials before they reach a third party', async () => {
    const { seen } = await send('/anthropic/v1/messages', {
      host: 'api.deepseek.com',
      headers: { authorization: `Bearer ${ANTHROPIC_OAUTH}`, 'x-api-key': ANTHROPIC_KEY },
    });
    expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect(seen[0]!.headers.get('x-api-key')).toBeNull();
  });

  it('does not bridge a followed host\'s model to the configured OpenAI upstream', async () => {
    const body = JSON.stringify({ model: 'gpt-5.6-sol', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    const { seen } = await send('/api/v1/messages', { host: 'openrouter.ai', body });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect(same(seen[0]!.body, plainBytes(body))).toBe(true); // not rewritten as a Responses body
  });

  it('still compresses an in-scope model on a followed host, with no probe to Anthropic', async () => {
    const body = JSON.stringify({
      model: 'claude-fable-5',
      max_tokens: 16,
      system: 'Detailed operating rules for the coding agent, kept stable. '.repeat(600),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { seen } = await send('/api/v1/messages', { host: 'openrouter.ai', body });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(new TextDecoder().decode(seen[0]!.body)).toContain('"type":"image"');
  });

  it('leaves first-party and loopback routing exactly as before', async () => {
    const { seen } = await send('/v1/messages', { body: DEEPSEEK_BODY.replace('deepseek-chat', 'claude-opus-5-5') });
    const main = seen.find((s) => s.url === 'https://api.anthropic.com/v1/messages');
    expect(main).toBeDefined();
    expect(main!.headers.get('x-api-key')).toBe(HOST_KEY);
  });
});

describe('follow the agent: refusals (no upstream call)', () => {
  const bad = [
    '/to/169.254.169.254/latest/meta-data',
    '/to/127.0.0.1/v1/messages',
    '/to/localhost/v1/messages',
    '/to/evil.example.com/v1/messages',
    '/to/api.deepseek.com:8443/anthropic/v1/messages',
    '/to/api.deepseek.com@evil.com/v1/messages',
    '/to/api.deepseek.com%2f@evil.com/v1/messages',
    '/to/host.docker.internal/v1/messages',
    '/to/api.anthropic.com/v1/messages',
    '/to/',
  ];
  for (const path of bad) {
    it(`refuses ${path}`, async () => {
      const { status, seen } = await send(path);
      expect(status).toBe(400);
      expect(seen).toHaveLength(0);
    });
  }

  it('normalizes case and a trailing dot rather than refusing them', async () => {
    const { seen } = await send('/to/API.DeepSeek.com./anthropic/v1/messages');
    expect(seen[0]!.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
  });

  it('refuses a provider Host on a non-443 port instead of misrouting it', async () => {
    const { status, seen } = await send('/anthropic/v1/messages', { host: 'api.deepseek.com:8443' });
    expect(status).toBe(421);
    expect(seen).toHaveLength(0);
  });

  it('with following off, refuses a third-party Host instead of sending it to Anthropic', async () => {
    const { status, seen } = await send('/anthropic/v1/messages', { host: 'api.deepseek.com' }, { ...HOST_CONFIG, followHosts: false });
    expect(status).toBe(421);
    expect(seen).toHaveLength(0);
  });
});

describe('follow the agent: one registry for guard, router and warp', () => {
  it('trusts every registered provider Host in the request guard', () => {
    for (const host of ['api.deepseek.com', 'openrouter.ai', 'api.z.ai', 'chatgpt.com']) {
      expect(guardProxyRequest({ host }), host).toBeNull();
    }
    expect(guardProxyRequest({ host: 'evil.example.com' })?.status).toBe(421);
  });

  it('an INKLING_ALLOWED_HOSTS-style wildcard never makes a host followable', () => {
    expect(guardProxyRequest({ host: 'evil.example.com' }, { allowedHosts: ['*'] })).toBeNull();
    expect(resolveFollowTarget(new URL('http://127.0.0.1/v1/messages'), 'evil.example.com')).toBeNull();
  });

  it('extends the registry from INKLING_UPSTREAM_HOSTS but rejects junk and never re-families first-party hosts', () => {
    const extra = parseUpstreamHosts('llm.mycorp.com/anthropic, 10.0.0.1, localhost, *.evil.com, api.anthropic.com');
    expect(extra.map((e) => e.host)).toEqual(['llm.mycorp.com', 'api.anthropic.com']);
    const registry = buildUpstreamRegistry(extra);
    expect(registry.get('api.anthropic.com')?.family).toBe('anthropic');
    const t = resolveFollowTarget(new URL('http://127.0.0.1/to/llm.mycorp.com/anthropic/v1/messages'), null, registry);
    expect(t && 'origin' in t ? t.wirePathname : null).toBe('/v1/messages');
  });

  it('never follows an IP literal or local name, even if a caller plants one in the registry', () => {
    const planted = new Map(buildUpstreamRegistry());
    for (const host of ['169.254.169.254', 'metadata.internal', 'localhost']) {
      planted.set(host, { host, family: 'compat', prefixes: [''] });
      const viaPath = resolveFollowTarget(new URL(`http://127.0.0.1/to/${host}/v1/messages`), null, planted);
      expect(viaPath && 'status' in viaPath ? viaPath.status : 'followed', host).toBe(400);
      expect(resolveFollowTarget(new URL('http://127.0.0.1/v1/messages'), host, planted), host).toBeNull();
    }
    expect(buildUpstreamRegistry([{ host: '10.0.0.1', family: 'compat', prefixes: [''] }]).has('10.0.0.1')).toBe(false);
  });

  it('warp diverts registered third-party inference paths, and nothing else on those hosts', () => {
    const routes = compatRoutes(47821);
    expect(matchRoute(routes, 'api.deepseek.com', '/anthropic/v1/messages')).not.toBeNull();
    expect(matchRoute(routes, 'openrouter.ai', '/api/v1/chat/completions')).not.toBeNull();
    expect(matchRoute(routes, 'api.deepseek.com', '/user/balance')).toBeNull();
    expect(matchRoute(routes, 'evil.example.com', '/v1/messages')).toBeNull();
  });
});
