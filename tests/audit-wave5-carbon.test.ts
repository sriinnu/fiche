import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileToolSchemas } from '../src/core/schema-compiler.js';
import { parseExportArgv } from '../src/core/export.js';
import { classifyInboundCredential, createProxy } from '../src/core/proxy.js';
import { foldPins } from '../src/core/pin.js';
import { normalizeModelId } from '../src/core/price-id.js';
import { isPre47Claude } from '../src/core/claude-model-profiles.js';
import { GEMINI_LEGACY_PROFILE, GEMINI_PROFILE, resolveGeminiProfile } from '../src/core/gemini-model-profiles.js';
import {
  noteCacheOutcome,
  noteHistoryRequest,
  peekSessionState,
  resetSessionState,
} from '../src/core/session-state.js';
import { DashboardState, dispatchDashboard } from '../src/dashboard.js';
import { renderStatsTableFragment } from '../src/dashboard/fragments.js';

const mockCred = (...parts: string[]) => parts.join('-');
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

afterEach(() => {
  resetSessionState();
  vi.restoreAllMocks();
});

describe('Carbon audit Wave 1 regressions', () => {
  it('preserves $schema in TSCG compileToolSchemas so Draft-07 MCP tool schemas remain valid', () => {
    const sharedDesc =
      'Read structured workspace symbols carefully with verified path validation, deterministic line anchors, strict edit safety, and zero fabricated identifiers across all workspaces.';
    const tools = Array.from({ length: 6 }, (_, i) => ({
      name: `tool_${i}`,
      description: `${sharedDesc} Tool ${i}.`,
      input_schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $comment: 'drop comment only',
        type: 'object',
        properties: {
          pair: { type: 'array', description: sharedDesc, items: [{ type: 'string' }, { type: 'number' }] },
        },
      },
    }));

    const res = compileToolSchemas(tools, 'anthropic');
    expect(res.changed).toBe(true);
    expect(tools[0]!.input_schema).toHaveProperty('$schema', 'http://json-schema.org/draft-07/schema#');
    expect(tools[0]!.input_schema).not.toHaveProperty('$comment');
  });

  it('rejects --diff= values starting with a dash to prevent git option injection', () => {
    expect(parseExportArgv(['--diff=--output=/tmp/pwned'])).toMatchObject({ kind: 'error' });
    expect(parseExportArgv(['--diff=-p'])).toMatchObject({ kind: 'error' });
    expect(parseExportArgv(['--diff=HEAD~1'])).toMatchObject({ kind: 'opts', parsed: { diff: 'HEAD~1' } });
  });

  it('detects comma-joined Anthropic bearer tokens and strips x-anthropic-billing-header on followed hosts', async () => {
    const antCred = mockCred('sk', 'ant', 'api03', 'secretvalue');
    const openaiCred = mockCred('sk', 'proj', 'ok');
    const mixedHeaders = new Headers({
      authorization: `Bearer ${openaiCred}, Bearer ${antCred}`,
      'x-api-key': `thirdparty-key, ${antCred}`,
    });
    expect(classifyInboundCredential(mixedHeaders)).toBe('anthropic-bearer');

    const captured: Request[] = [];
    const origFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      captured.push(req);
      return new Response(
        JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'deepseek-chat', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 2 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    try {
      const proxy = createProxy({
        apiKey: mockCred('sk', 'ant', 'host', 'configured'),
        followHosts: true,
        transform: () => ({}),
      });
      const res = await proxy(new Request('http://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          host: 'api.deepseek.com',
          'content-type': 'application/json',
          'x-api-key': `agent-key, ${antCred}`,
          authorization: `Bearer tok, Bearer ${antCred}`,
          'anthropic-version': '2023-06-01',
        },
        body: enc({
          model: 'deepseek-chat',
          max_tokens: 16,
          system: 'x-anthropic-billing-header: cc_version=2.1; cch=abc\nSystem instructions here.',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }));
      expect(res.status).toBe(200);
      expect(captured).toHaveLength(1);
      const out = captured[0]!;
      expect(out.headers.get('x-api-key')).toBeNull();
      expect(out.headers.get('authorization')).toBeNull();
      expect(out.headers.get('x-anthropic-billing-header')).toBeNull();
      expect(out.headers.get('anthropic-version')).toBe('2023-06-01');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not clobber lastCacheAlive when an Anthropic turn gets 529 / 429 without usage', async () => {
    const key = 'deadbeef';
    noteHistoryRequest(key, { messages: [{ role: 'user', content: 'hi' }], nowMs: 1_000 });
    noteCacheOutcome(key, 50_000, 1_000);
    expect(peekSessionState(key)?.everCacheAlive).toBe(true);
    expect(peekSessionState(key)?.lastCacheAlive).toBe(true);

    const origFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
      { status: 529, headers: { 'content-type': 'application/json' } },
    ));

    try {
      const proxy = createProxy({ apiKey: mockCred('sk', 'ant', 'test'), transform: () => ({}) });
      const res = await proxy(new Request('http://127.0.0.1/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'client' },
        body: enc({
          model: 'claude-opus-5-5',
          max_tokens: 16,
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'next turn' },
          ],
        }),
      }));
      expect(res.status).toBe(529);
      await new Promise((r) => setTimeout(r, 20));
      // 529 overloaded without usage must NOT flip lastCacheAlive to false
      expect(peekSessionState(key)?.lastCacheAlive).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('ignores inline triple-backtick spans in pin.ts fence walker', () => {
    const pins = foldPins([
      {
        role: 'user',
        content: [
          'Use ```inline code``` safely',
          '@fiche pin keep concise outputs',
        ].join('\n'),
      },
    ]);
    expect(pins.map((p) => p.text)).toContain('keep concise outputs');
  });

  it('normalizes Claude dot minor versions, Bedrock IDs, isPre47Claude, and Gemini bracket tags', () => {
    expect(normalizeModelId('claude-fable-5.2')).toBe('claude-fable-5-2');
    expect(normalizeModelId('us.anthropic.claude-opus-5-5-20260922-v1:0')).toBe('claude-opus-5-5');
    expect(normalizeModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');

    expect(isPre47Claude('claude-sonnet-4-20250514')).toBe(true);
    expect(isPre47Claude('claude-opus-4.8')).toBe(false);
    expect(isPre47Claude('claude-3.5-sonnet')).toBe(true);

    expect(resolveGeminiProfile('gemini-3.6-flash[1m]')).toBe(GEMINI_LEGACY_PROFILE);
    expect(resolveGeminiProfile('gemini-4-argon[1m]')).toBe(GEMINI_PROFILE);
  });

  it('serves dashboard security headers, accurate bytes/char ratio, and non-zero by_model saved_pct', async () => {
    const dashboard = new DashboardState(undefined, async () => new Map(), () => {}, {
      version: '0.17.0-test',
      host: '127.0.0.1',
    });

    const htmlRes = dashboard.serveHtml(47821);
    expect(htmlRes.headers.get('x-frame-options')).toBe('DENY');
    expect(htmlRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(htmlRes.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(htmlRes.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    dashboard.update({
      method: 'POST',
      path: '/v1/messages',
      model: 'claude-opus-5-5',
      status: 200,
      durationMs: 12,
      usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      info: {
        compressed: true,
        originalMessages: 2,
        imagedMessages: 0,
        originalChars: 4000,
        compressedChars: 2000,
        imageCount: 0,
        totalImageBytes: 0,
        imageTokens: 0,
        textHygieneSavedTokens: 500,
      },
    });

    const stats = await (await dispatchDashboard(
      dashboard,
      { kind: 'stats' },
      'GET',
      new URL('http://127.0.0.1:47821/proxy-stats'),
      47821,
      async () => '',
    ))!.json() as { by_model: Record<string, { baseline_input_weighted: number; saved_tokens: number; saved_pct: number }> };
    expect(stats.by_model['claude-opus-5-5']?.baseline_input_weighted).toBe(1000);
    expect(stats.by_model['claude-opus-5-5']?.saved_tokens).toBe(500);
    expect(stats.by_model['claude-opus-5-5']?.saved_pct).toBe(50);

    const tableHtml = renderStatsTableFragment({
      parsed: 1,
      dropped: 0,
      summary: {
        total: 1,
        ok2xx: 1,
        err4xx: 0,
        err5xx: 0,
        compressed: 1,
        passthrough: 0,
        inputTokensTotal: 500,
        cacheCreateTokensTotal: 0,
        cacheReadTokensTotal: 0,
        outputTokensTotal: 20,
        cacheHitEvents: 0,
        eventsWithUsage: 1,
        origCharsTotal: 1000,
        imageBytesTotal: 350,
        durationP50: 10,
        durationP95: 10,
        firstByteP50: 10,
        firstByteP95: 10,
      },
    });
    expect(tableHtml).toContain('>0.350<');
    expect(tableHtml).not.toContain('35.000x');
  });
});
