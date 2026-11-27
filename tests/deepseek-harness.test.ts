import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeActualInputEffWithCacheTier,
  computeBaselineInputEffWithCacheTier,
} from '../src/core/baseline.js';
import { getGlobalMmuStore, resetGlobalMmuStore } from '../src/core/context-mmu.js';
import {
  anthropicWriteRate5m,
  isImplicitAutoCacheModel,
  resolvePriceRates,
} from '../src/core/pricing.js';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { resetSessionState } from '../src/core/session-state.js';
import { transformRequest } from '../src/core/transform.js';
import { DashboardState } from '../src/dashboard.js';
import { aggregateSessions } from '../src/sessions.js';
import { readTurnReport } from '../src/turn-report.js';
import { resolveMacAppBundle } from '../src/warp/app-launch.js';
import { compatRoutes } from '../src/warp/index.js';
import { matchRoute } from '../src/warp/route.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'fiche-dsh-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('DeepSeek Harness support (wrapping, headers, trailing system, 1.0x as-input accounting)', () => {
  let prevModels: string | undefined;
  let prevPrices: string | undefined;

  beforeEach(() => {
    prevModels = process.env.INKLING_MODELS;
    prevPrices = process.env.INKLING_PRICES;
    process.env.INKLING_MODELS = 'claude-fable-5,deepseek';
    process.env.INKLING_PRICES = 'kosha';
    resetSessionState();
    resetGlobalMmuStore();
  });

  afterEach(() => {
    resetSessionState();
    resetGlobalMmuStore();
    if (prevModels === undefined) delete process.env.INKLING_MODELS;
    else process.env.INKLING_MODELS = prevModels;
    if (prevPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = prevPrices;
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('routes x-deepseek-harness-session-id upstream, isolates sessions, and bypasses x-deepseek-harness-compact=1', async () => {
    const origFetch = globalThis.fetch;
    const seenHeaders: Array<{ url: string; sessionId: string | null; compact: string | null; body: string }> = [];
    globalThis.fetch = (async (reqOrUrl: Request | string | URL, init?: RequestInit) => {
      const req = reqOrUrl instanceof Request ? reqOrUrl : new Request(String(reqOrUrl), init);
      const bodyText = await req.text();
      seenHeaders.push({
        url: req.url,
        sessionId: req.headers.get('x-deepseek-harness-session-id'),
        compact: req.headers.get('x-deepseek-harness-compact'),
        body: bodyText,
      });
      return new Response(
        JSON.stringify({
          id: 'msg_ds_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 1200,
            output_tokens: 40,
            cache_creation_input_tokens: 400,
            cache_read_input_tokens: 800,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const events: ProxyEvent[] = [];
    try {
      const proxy = createProxy({
        followHosts: true,
        enabledProviders: () => ['anthropic', 'deepseek'],
        transform: { charsPerToken: 4 },
        onRequest: (ev) => events.push(ev),
      });

      const globBody = Array.from(
        { length: 24 },
        (_, i) => `/Users/dev/repo/src/features/group_${i % 3}/item_${i}.ts`,
      ).join('\n');

      const dshAuth = crypto.randomBytes(12).toString('hex');
      const baseReqPayload = {
        model: 'deepseek-v4-pro',
        max_tokens: 4096,
        stream: false,
        system: 'You are DeepSeek Harness.',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Inspect files' }],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Planning search', signature: 'sig_ds_01' },
              { type: 'tool_use', id: 'tu_1', name: 'Glob', input: { pattern: '*.ts' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: globBody }],
          },
        ],
      };

      const res1 = await proxy(
        new Request('http://127.0.0.1/to/api.deepseek.com/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-auth-token': dshAuth,
            'x-deepseek-harness-session-id': 'dsh-sess-alpha-1',
          },
          body: JSON.stringify(baseReqPayload),
        }),
      );
      expect(res1.status).toBe(200);

      // Background compaction call carrying x-deepseek-harness-compact: 1 must pass through untouched
      const compactBodyStr = JSON.stringify({
        model: 'deepseek-flash',
        max_tokens: 1024,
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: globBody }] }],
      });
      const resCompact = await proxy(
        new Request('http://127.0.0.1/to/api.deepseek.com/anthropic/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-auth-token': dshAuth,
            'x-deepseek-harness-session-id': 'dsh-sess-alpha-1',
            'x-deepseek-harness-compact': '1',
          },
          body: compactBodyStr,
        }),
      );
      expect(resCompact.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));

      expect(seenHeaders).toHaveLength(2);
      expect(seenHeaders[0]!.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
      expect(seenHeaders[0]!.sessionId).toBe('dsh-sess-alpha-1');
      expect(seenHeaders[0]!.body).toContain('@root /Users/dev/repo/src/features/');

      expect(seenHeaders[1]!.compact).toBe('1');
      expect(seenHeaders[1]!.body).toBe(compactBodyStr);

      expect(events[0]?.info?.sessionKeySource).toBe('deepseek-harness-header');
      expect(events[0]?.info?.compressed).toBe(true);
      expect(events[1]?.info).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('hydrates Context-MMU tail across trailing in-history system messages while preserving thinking & tool_addition', async () => {
    const pagedCode = Array.from(
      { length: 40 },
      (_, i) => `export function deepSeekSpecialKernel_${i}(x: number) { return x + ${i}; }`,
    ).join('\n');

    const payload = {
      model: 'deepseek-v4-pro',
      max_tokens: 8192,
      system: 'DeepSeek Harness system prompt.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read kernel file' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Checking kernel', signature: 'ds_sig_keep_me' },
            { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: 'src/kernel.ts' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: pagedCode }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Reviewed kernel.' }],
        },
        ...Array.from({ length: 8 }, (_, k) => [
          { role: 'user', content: [{ type: 'text', text: `Follow-up ${k}` }] },
          { role: 'assistant', content: [{ type: 'text', text: `Reply ${k}` }] },
        ]).flat(),
        {
          role: 'user',
          content: [{ type: 'text', text: 'Inspect deepSeekSpecialKernel_14 behavior' }],
        },
        // DeepSeek Harness systemPromptUpdate: "in-history" appends a system update after the live user turn
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Workspace reminder' },
            { type: 'tool_addition', tool: { type: 'tool_reference', name: 'custom_dsh_tool' } },
          ],
        },
      ],
    };

    const { body: outBytes, info } = await transformRequest(
      new TextEncoder().encode(JSON.stringify(payload)),
      {
        model: 'deepseek-v4-pro',
        imageCompress: false,
        clientSessionId: 'dsh-tail-test',
        clientSessionSource: 'deepseek-harness-header',
      },
    );

    const outReq = JSON.parse(new TextDecoder().decode(outBytes)) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(info.sessionKeySource).toBe('deepseek-harness-header');

    // Store page explicitly and confirm MMU tail hydration still attaches to user message behind trailing system
    const store = getGlobalMmuStore();
    store.storePage({
      sessionKey: info.sessionKey!,
      refId: 'tu_hydrate_manual',
      filePath: 'src/hydrate_target.ts',
      rawText: Array.from(
        { length: 24 },
        (_, i) => `export function uniqueDshHydrationTarget${String.fromCharCode(65 + i)}() { return 'H_${i}'; }`,
      ).join('\n'),
    });

    const payloadWithQuery = {
      ...payload,
      messages: [
        ...payload.messages.slice(0, -2),
        {
          role: 'user',
          content: [{ type: 'text', text: 'Tell me about uniqueDshHydrationTargetF please' }],
        },
        payload.messages[payload.messages.length - 1]!,
      ],
    };
    const { body: hydratedBytes, info: hydratedInfo } = await transformRequest(
      new TextEncoder().encode(JSON.stringify(payloadWithQuery)),
      {
        model: 'deepseek-v4-pro',
        imageCompress: false,
        clientSessionId: 'dsh-tail-test',
        clientSessionSource: 'deepseek-harness-header',
      },
    );
    const hydratedReq = JSON.parse(new TextDecoder().decode(hydratedBytes)) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    const trailingSys = hydratedReq.messages[hydratedReq.messages.length - 1]!;
    const liveUser = hydratedReq.messages[hydratedReq.messages.length - 2]!;
    expect(trailingSys.role).toBe('system');
    expect(JSON.stringify(trailingSys.content)).toContain('tool_addition');
    expect(JSON.stringify(trailingSys.content)).not.toContain('[fiche vm-hydrate');
    expect(liveUser.role).toBe('user');
    expect(JSON.stringify(liveUser.content)).toContain('[fiche vm-hydrate');
    expect(JSON.stringify(liveUser.content)).toContain("return 'H_5';");
    expect(hydratedInfo.textHygieneStages).toContain('mmu_hydrate');
    expect(JSON.stringify(hydratedReq)).toContain('ds_sig_keep_me');
  });

  it('uses 1.0x as-input write pricing and implicit auto-cache handling for deepseek models', async () => {
    expect(isImplicitAutoCacheModel('deepseek-v4-pro')).toBe(true);
    expect(isImplicitAutoCacheModel('deepseek-flash')).toBe(true);
    expect(isImplicitAutoCacheModel('claude-fable-5')).toBe(false);

    expect(anthropicWriteRate5m('deepseek-v4-pro')).toBe(1);
    expect(anthropicWriteRate5m('deepseek-flash')).toBe(1);
    expect(anthropicWriteRate5m('claude-fable-5')).toBe(1.25);

    const dsRates = resolvePriceRates('deepseek-v4-pro');
    expect(dsRates.write).toBe(1);

    const dsActual = computeActualInputEffWithCacheTier(
      500,
      1000,
      2000,
      0,
      1000,
      dsRates.read,
      anthropicWriteRate5m('deepseek-v4-pro'),
    );
    expect(dsActual).toBeCloseTo(500 + 1000 * 1.0 + 2000 * dsRates.read, 6);

    const dsBase = computeBaselineInputEffWithCacheTier(
      4000,
      3000,
      500,
      1000,
      2000,
      true,
      2000,
      0,
      1000,
      dsRates.read,
      anthropicWriteRate5m('deepseek-v4-pro'),
    );
    // reused=2000*read + grown=1000*1.0 + coldTail=1000*1.0
    expect(dsBase).toBeCloseTo(2000 * dsRates.read + 1000 + 1000, 6);

    // Verify DashboardState live + replay, sessions, and turn-report agree on 1.0x write
    const dir = makeTempDir('fiche-dsh-acc-');
    const eventsFile = path.join(dir, 'events.jsonl');
    const sidecarDir = path.join(dir, '4xx-bodies');
    fs.mkdirSync(sidecarDir, { recursive: true });
    const ev = {
      ts: '2026-11-27T12:00:00Z',
      accounting_provider: 'anthropic',
      path: '/anthropic/v1/messages',
      model: 'deepseek-v4-pro',
      status: 200,
      duration_ms: 80,
      compressed: true,
      first_user_sha8: 'dsh_sess_1',
      text_hygiene_saved_tokens: 400,
      input_tokens: 600,
      cache_create_tokens: 400,
      cache_read_tokens: 0,
      output_tokens: 50,
    };
    fs.writeFileSync(eventsFile, JSON.stringify(ev) + '\n');

    const dash = new DashboardState({ eventsFile, sidecarDir });
    await dash.replay(eventsFile);
    const statsRes = dash.serveStats();
    const statsJson = (await statsRes.json()) as {
      by_model: Record<string, { saved_tokens: number; priced: boolean }>;
    };
    // With write=1.0 (not 1.25), saved tokens on hygiene-only cache_create turn = 400 * 1.0 = 400
    expect(statsJson.by_model['deepseek-v4-pro']?.priced).toBe(true);
    expect(statsJson.by_model['deepseek-v4-pro']?.saved_tokens).toBe(400);

    const agg = await aggregateSessions({ eventsFile, sidecarDir });
    expect(agg.sessions.get('dsh_sess_1')?.tokensSavedEst).toBe(400);

    const tr = readTurnReport(eventsFile);
    expect(tr.lastTurn?.savedTokens).toBe(400);
  });

  it('matches DeepSeek Anthropic compat routes in warp and discovers DeepSeek Harness app when installed', () => {
    const routes = compatRoutes(47821, ['deepseek']);
    const hit = matchRoute(routes, 'api.deepseek.com:443', '/anthropic/v1/messages');
    expect(hit).not.toBeNull();
    expect(hit?.target.origin).toBe('http://127.0.0.1:47821');

    if (fs.existsSync('/Applications/DeepSeek Harness.app/Contents/Info.plist')) {
      const app = resolveMacAppBundle('DeepSeek Harness');
      expect(app?.appName).toBe('DeepSeek Harness');
      expect(app?.isElectron).toBe(true);
    }
  });
});
