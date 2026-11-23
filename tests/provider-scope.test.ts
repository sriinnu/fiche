import { afterEach, describe, expect, it } from 'vitest';

import { createProxy } from '../src/core/proxy.js';
import {
  buildUpstreamRegistry,
  detectProvidersFromEnv,
  getEnabledProviders,
  isFollowRefusal,
  normalizeProviderId,
  parseProvidersSpec,
  parseUpstreamHosts,
  PROVIDER_CATALOG,
  resolveFollowTarget,
  setEnabledProviders,
} from '../src/core/upstream-hosts.js';
import {
  DashboardState,
  dashboardPath,
  dispatchDashboard,
  isDashboardMutation,
} from '../src/dashboard.js';
import { compatRoutes, defaultRoutes } from '../src/warp/index.js';
import { matchRoute } from '../src/warp/route.js';

afterEach(() => {
  setEnabledProviders(null);
  delete process.env.FICHE_PROVIDERS;
  delete process.env.INKLING_PROVIDERS;
  delete process.env.FICHE_UPSTREAM_HOSTS;
});

describe('opt-in provider scoping', () => {
  it('defaults defaultRoutes to first-party providers only (anthropic, openai, google)', () => {
    const routes = defaultRoutes(47821);

    expect(matchRoute(routes, 'api.anthropic.com', '/v1/messages')).not.toBeNull();
    expect(matchRoute(routes, 'api.openai.com', '/v1/responses')).not.toBeNull();
    expect(matchRoute(routes, 'chatgpt.com', '/backend-api/codex/responses')).not.toBeNull();
    expect(matchRoute(routes, 'cloudcode-pa.googleapis.com', '/v1internal:generateContent')).not.toBeNull();
    expect(matchRoute(routes, 'generativelanguage.googleapis.com', '/v1beta/models/gemini-4:generateContent')).not.toBeNull();

    // Unselected third-party providers must not be intercepted by warp by default.
    expect(matchRoute(routes, 'api.mistral.ai', '/v1/chat/completions')).toBeNull();
    expect(matchRoute(routes, 'api.together.xyz', '/v1/chat/completions')).toBeNull();
    expect(matchRoute(routes, 'api.sambanova.ai', '/v1/chat/completions')).toBeNull();
    expect(matchRoute(routes, 'api.deepseek.com', '/anthropic/v1/messages')).toBeNull();
  });

  it('filters defaultRoutes and compatRoutes by explicit enabledProviders while preserving custom hosts', () => {
    const noOpenAI = defaultRoutes(47821, ['anthropic', 'google']);
    expect(matchRoute(noOpenAI, 'api.anthropic.com', '/v1/messages')).not.toBeNull();
    expect(matchRoute(noOpenAI, 'generativelanguage.googleapis.com', '/v1beta/models/gemini-4:generateContent')).not.toBeNull();
    expect(matchRoute(noOpenAI, 'api.openai.com', '/v1/responses')).toBeNull();
    expect(matchRoute(noOpenAI, 'chatgpt.com', '/backend-api/codex/responses')).toBeNull();

    const withMistral = defaultRoutes(47821, ['anthropic', 'mistral']);
    expect(matchRoute(withMistral, 'api.mistral.ai', '/v1/chat/completions')).not.toBeNull();
    expect(matchRoute(withMistral, 'api.together.xyz', '/v1/chat/completions')).toBeNull();

    // Unfiltered compatRoutes(port) preserves full catalog for direct callers.
    const allCompat = compatRoutes(47821);
    expect(matchRoute(allCompat, 'api.mistral.ai', '/v1/chat/completions')).not.toBeNull();
    expect(matchRoute(allCompat, 'api.together.xyz', '/v1/chat/completions')).not.toBeNull();

    process.env.FICHE_UPSTREAM_HOSTS = 'llm.mycorp.com/anthropic';
    const openRouterPlusCustom = compatRoutes(47821, ['openrouter']);
    expect(matchRoute(openRouterPlusCustom, 'openrouter.ai', '/api/v1/chat/completions')).not.toBeNull();
    expect(matchRoute(openRouterPlusCustom, 'llm.mycorp.com', '/anthropic/v1/messages')).not.toBeNull();
    expect(matchRoute(openRouterPlusCustom, 'api.mistral.ai', '/v1/chat/completions')).toBeNull();
  });

  it('refuses disabled built-in compat providers in resolveFollowTarget and proxy instead of falling back', async () => {
    const customHosts = parseUpstreamHosts('llm.mycorp.com/anthropic');
    const registry = buildUpstreamRegistry(customHosts);
    const firstPartyOnly = new Set<string>(['anthropic', 'openai', 'google']);

    const refusedHost = resolveFollowTarget(
      new URL('http://127.0.0.1:47821/v1/chat/completions'),
      'api.mistral.ai',
      registry,
      firstPartyOnly,
    );
    expect(isFollowRefusal(refusedHost)).toBe(true);
    expect(isFollowRefusal(refusedHost) ? refusedHost.status : null).toBe(421);

    const refusedPath = resolveFollowTarget(
      new URL('http://127.0.0.1:47821/to/api.mistral.ai/v1/chat/completions'),
      null,
      registry,
      firstPartyOnly,
    );
    expect(isFollowRefusal(refusedPath)).toBe(true);
    expect(isFollowRefusal(refusedPath) ? refusedPath.status : null).toBe(400);

    // Explicitly custom FICHE_UPSTREAM_HOSTS stay allowed even when only first-party built-ins are on.
    const customAllowed = resolveFollowTarget(
      new URL('http://127.0.0.1:47821/to/llm.mycorp.com/anthropic/v1/messages'),
      null,
      registry,
      firstPartyOnly,
    );
    expect(isFollowRefusal(customAllowed)).toBe(false);
    expect(customAllowed && 'origin' in customAllowed ? customAllowed.origin : null).toBe('https://llm.mycorp.com');

    // Enabling mistral immediately unblocks it.
    const withMistral = new Set<string>(['anthropic', 'mistral']);
    const allowed = resolveFollowTarget(
      new URL('http://127.0.0.1:47821/v1/chat/completions'),
      'api.mistral.ai',
      registry,
      withMistral,
    );
    expect(allowed && 'origin' in allowed ? allowed.origin : null).toBe('https://api.mistral.ai');

    // Live proxy respects dynamic enabledProviders callback.
    let active: Array<'anthropic' | 'mistral'> = ['anthropic'];
    const proxy = createProxy({
      upstream: 'http://127.0.0.1:9',
      followHosts: true,
      enabledProviders: () => active,
    });
    const blockedRes = await proxy(
      new Request('http://127.0.0.1:47821/v1/chat/completions', {
        method: 'POST',
        headers: { host: 'api.mistral.ai', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(blockedRes.status).toBe(421);
    const blockedBody = (await blockedRes.json()) as { error: string; message: string };
    expect(blockedBody.error).toBe('follow_refused');
    expect(blockedBody.message).toContain('mistral');

    active = ['anthropic', 'mistral'];
    expect(getEnabledProviders()).toEqual(['anthropic', 'openai', 'google']);
  });

  it('normalizes provider aliases, special specs, and env key presence detection without leaking secrets', () => {
    expect(normalizeProviderId('grok')).toBe('xai');
    expect(normalizeProviderId('moonshot')).toBe('kimi');
    expect(normalizeProviderId('zai')).toBe('glm');
    expect(normalizeProviderId('claude')).toBe('anthropic');
    expect(normalizeProviderId('codex')).toBe('openai');
    expect(normalizeProviderId('antigravity')).toBe('google');

    const parsed = parseProvidersSpec('claude, grok, unknown_vendor');
    expect(parsed.providers).toEqual(['anthropic', 'xai']);
    expect(parsed.unknown).toEqual(['unknown_vendor']);

    const allParsed = parseProvidersSpec('all');
    expect(allParsed.providers).toHaveLength(PROVIDER_CATALOG.length);
    expect(parseProvidersSpec('none').providers).toEqual([]);

    const secretToken = ['sk', 'mistral', 'supersecret', 'value'].join('-');
    const detected = detectProvidersFromEnv({
      OPENAI_API_KEY: 'sk-test-openai',
      MISTRAL_API_KEY: secretToken,
      DEEPSEEK_API_KEY: '   ',
    });
    expect(detected).toEqual([
      { id: 'openai', matchedEnvKey: 'OPENAI_API_KEY' },
      { id: 'mistral', matchedEnvKey: 'MISTRAL_API_KEY' },
    ]);
    expect(JSON.stringify(detected)).not.toContain(secretToken);
  });

  it('exposes /api/providers and /fragments/models provider toggles with persistence and validation', async () => {
    const persisted: string[][] = [];
    const dash = new DashboardState(undefined, undefined, undefined, {
      onProvidersPersist: (next) => persisted.push([...next]),
    });

    const getRoute = dashboardPath('/api/providers')!;
    expect(isDashboardMutation(getRoute, 'GET')).toBe(false);
    expect(isDashboardMutation(getRoute, 'POST')).toBe(true);

    const initialRes = await dispatchDashboard(dash, getRoute, 'GET', new URL('http://127.0.0.1/api/providers'), 47821, async () => '');
    expect(initialRes.status).toBe(200);
    const initialJson = (await initialRes.json()) as { enabled: string[]; providers: Array<{ id: string; enabled: boolean }> };
    expect(initialJson.enabled).toEqual(['anthropic', 'openai', 'google']);
    expect(initialJson.providers.find((p) => p.id === 'mistral')?.enabled).toBe(false);

    const toggleRes = await dispatchDashboard(
      dash,
      getRoute,
      'POST',
      new URL('http://127.0.0.1/api/providers'),
      47821,
      async () => JSON.stringify({ provider: 'mistral', on: true }),
    );
    expect(toggleRes.status).toBe(200);
    const toggleJson = (await toggleRes.json()) as { enabled: string[] };
    expect(toggleJson.enabled).toContain('mistral');
    expect(persisted.at(-1)).toContain('mistral');

    const badRes = await dispatchDashboard(
      dash,
      getRoute,
      'POST',
      new URL('http://127.0.0.1/api/providers'),
      47821,
      async () => JSON.stringify({ providers: ['anthropic', 'nonexistent'] }),
    );
    expect(badRes.status).toBe(400);

    // Fragment toggle enables deepseek and reflects it in rendered HTML.
    const fragRoute = dashboardPath('/fragments/models')!;
    const fragRes = await dispatchDashboard(
      dash,
      fragRoute,
      'POST',
      new URL('http://127.0.0.1/fragments/models'),
      47821,
      async () => JSON.stringify({ provider: 'deepseek', on: true }),
    );
    expect(fragRes.status).toBe(200);
    const fragHtml = await fragRes.text();
    expect(fragHtml).toContain('My Providers');
    expect(fragHtml).toContain('DeepSeek ✓');
  });
});
