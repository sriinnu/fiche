import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { bodyHasPromptCacheBreakpoint } from '../src/core/codex-cache.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import {
  computeOpenAISessionBaselineInputEff,
  deriveOpenAIBaselineWarmth,
} from '../src/core/openai-savings.js';
import { openAIImageDetail, transformOpenAIResponses } from '../src/core/openai.js';
import { estimateBillUsd, evaluateCliffAvoidance } from '../src/core/pricing.js';
import { createProxy } from '../src/core/proxy.js';
import { prefersText, readerTier } from '../src/core/reader-tier.js';
import { clearRenderCache, renderCacheStats } from '../src/core/render.js';
import type { TrackEvent } from '../src/core/tracker.js';
import { DashboardState } from '../src/dashboard.js';
import { aggregateSessions, type SessionsPaths } from '../src/sessions.js';
import { fold, newSummary, summaryToJson } from '../src/stats.js';
import { defaultRoutes } from '../src/warp/index.js';
import { matchRoute } from '../src/warp/route.js';

describe('cliff avoidance, kosha pricing & multi-provider support', () => {
  const savedPrices = process.env.INKLING_PRICES;
  const savedModels = process.env.INKLING_MODELS;
  const savedSyncProbe = process.env.INKLING_GOOGLE_SYNC_PROBE;
  const savedForceImages = process.env.INKLING_FORCE_IMAGES;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (savedPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = savedPrices;
    if (savedModels === undefined) delete process.env.INKLING_MODELS;
    else process.env.INKLING_MODELS = savedModels;
    if (savedSyncProbe === undefined) delete process.env.INKLING_GOOGLE_SYNC_PROBE;
    else process.env.INKLING_GOOGLE_SYNC_PROBE = savedSyncProbe;
    if (savedForceImages === undefined) delete process.env.INKLING_FORCE_IMAGES;
    else process.env.INKLING_FORCE_IMAGES = savedForceImages;
    setAllowedModelBases(null);
    for (const d of tempDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makePaths(): SessionsPaths {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkling-multi-'));
    tempDirs.push(dir);
    return {
      eventsFile: path.join(dir, 'events.jsonl'),
      sidecarDir: path.join(dir, '4xx-bodies'),
      claudeProjectsDir: path.join(dir, 'claude-projects'),
    };
  }

  it('evaluates long-context pricing cliffs in kosha mode across OpenAI, Gemini, and Haiku 5.5', () => {
    delete process.env.INKLING_PRICES;
    expect(
      evaluateCliffAvoidance('gpt-5.6-sol', { promptTokensBefore: 290_000, promptTokensAfter: 250_000 }),
    ).toBeNull();
    expect(estimateBillUsd('gpt-5.6-sol', { uncachedTokens: 1000 })).toBeUndefined();

    process.env.INKLING_PRICES = 'kosha';

    // OpenAI GPT-5.6 Sol crosses 272K band (doubles rate above 272K)
    const solCliff = evaluateCliffAvoidance('gpt-5.6-sol', {
      promptTokensBefore: 290_000,
      promptTokensAfter: 250_000,
      collapsedBaselineTokens: 45_000,
      collapsedActualTokens: 5_000,
      expectedOutputTokens: 2_000,
    });
    expect(solCliff).not.toBeNull();
    expect(solCliff!.crossesCliff).toBe(true);
    expect(solCliff!.cliffAt).toBe(272_000);
    expect(solCliff!.multiplier).toBeCloseTo(2.0, 2);
    expect(solCliff!.netSingleTurnUsd).toBeGreaterThan(0);

    // Gemini 3.1 Pro Preview crosses 200K band
    const gemCliff = evaluateCliffAvoidance('gemini-3.1-pro-preview', {
      promptTokensBefore: 220_000,
      promptTokensAfter: 185_000,
      collapsedBaselineTokens: 40_000,
      collapsedActualTokens: 5_000,
      expectedOutputTokens: 1_500,
    });
    expect(gemCliff).not.toBeNull();
    expect(gemCliff!.crossesCliff).toBe(true);
    expect(gemCliff!.cliffAt).toBe(200_000);
    expect(gemCliff!.multiplier).toBeCloseTo(2.0, 2);

    // Haiku 5.5 crosses 100K band (5x jump)
    const haikuCliff = evaluateCliffAvoidance('claude-haiku-5-5', {
      promptTokensBefore: 120_000,
      promptTokensAfter: 85_000,
      collapsedBaselineTokens: 40_000,
      collapsedActualTokens: 5_000,
      expectedOutputTokens: 1_000,
    });
    expect(haikuCliff).not.toBeNull();
    expect(haikuCliff!.crossesCliff).toBe(true);
    expect(haikuCliff!.cliffAt).toBe(100_000);
    expect(haikuCliff!.multiplier).toBeCloseTo(5.0, 2);
  });

  it('refuses image compression for unpriced models in kosha mode on OpenAI and Google', async () => {
    process.env.INKLING_PRICES = 'kosha';
    const denseDocs = Array.from(
      { length: 40 },
      (_, i) => `tool_${i}: Verify schema and constraints for resource namespace item_${i} in config.`,
    ).join('\n');

    const gptBody = new TextEncoder().encode(
      JSON.stringify({
        model: 'gpt-unpriced-mystery-99',
        instructions: '<instructions>\n' + denseDocs + '\n</instructions>',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }],
      }),
    );
    const gptRes = await transformOpenAIResponses(gptBody, { compress: true });
    expect(gptRes.info.imageCount).toBe(0);

    const gBody = new TextEncoder().encode(
      JSON.stringify({
        systemInstruction: { parts: [{ text: denseDocs + '\n' + denseDocs }] },
        contents: [{ role: 'user', parts: [{ text: 'go' }] }],
      }),
    );
    const gRes = await transformGoogleGenerateContent(gBody, 'gemini-99-unpriced', { compress: true });
    expect(gRes.info.compressed).toBe(false);
    expect(gRes.info.reason).toBe('unpriced_model');
  });

  it('normalizes DeepSeek prompt_cache_hit_tokens and prompt_cache_miss_tokens in proxy', async () => {
    setAllowedModelBases(['deepseek-reasoner']);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'ds_chat',
          object: 'chat.completion',
          model: 'deepseek-reasoner',
          choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
          usage: {
            prompt_cache_hit_tokens: 900,
            prompt_cache_miss_tokens: 100,
            completion_tokens: 25,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    let capturedUsage: Record<string, unknown> | undefined;
    try {
      const proxy = createProxy({
        followHosts: true,
        transform: { compress: false },
        onRequest: (e) => {
          capturedUsage = e.usage as Record<string, unknown> | undefined;
        },
      });
      const res = await proxy(
        new Request('http://127.0.0.1:47821/v1/chat/completions', {
          method: 'POST',
          headers: {
            host: 'api.deepseek.com',
            authorization: 'Bearer ds-key-example',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'deepseek-reasoner',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        }),
      );
      expect(res.status).toBe(200);
      await res.text();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(capturedUsage?.input_tokens).toBe(1000);
    expect(capturedUsage?.cached_tokens).toBe(900);
    expect(capturedUsage?.output_tokens).toBe(25);
  });

  it('routes direct /v1beta/models/:generateContent and skips :countTokens on /v1internal:', async () => {
    setAllowedModelBases(['gemini']);
    const seenUrls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      seenUrls.push(url);
      if (url.includes(':countTokens')) {
        return new Response(JSON.stringify({ totalTokens: 5000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 20, cachedContentTokenCount: 150 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const denseSystem = Array.from(
      { length: 60 },
      (_, i) => `<rule id="${i}">Always validate module_${i} invariants cleanly.</rule>`,
    ).join('\n');

    try {
      const proxy = createProxy({ passthroughUpstream: 'https://gemini.test', transform: {} });

      // Direct /v1beta/models/... without /google-ai-studio prefix
      const resDirect = await proxy(
        new Request('http://127.0.0.1/v1beta/models/gemini-3.6-flash:generateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: denseSystem }] },
            contents: [{ role: 'user', parts: [{ text: 'check' }] }],
          }),
        }),
      );
      expect(resDirect.status).toBe(200);
      await resDirect.text();

      seenUrls.length = 0;

      // CloudCode-PA /v1internal:generateContent must NEVER call :countTokens
      const resCloudCode = await proxy(
        new Request('http://127.0.0.1/v1internal:generateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-3.6-flash',
            request: {
              systemInstruction: { parts: [{ text: denseSystem }] },
              contents: [{ role: 'user', parts: [{ text: 'check' }] }],
            },
          }),
        }),
      );
      expect(resCloudCode.status).toBe(200);
      await resCloudCode.text();
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(seenUrls.some((u) => u.includes(':countTokens'))).toBe(false);
    expect(seenUrls.some((u) => u.includes('/v1internal:generateContent'))).toBe(true);
  });

  it('keeps Gemini older history PNG chunks byte-stable when new turns append', async () => {
    const turnToolPairs = Array.from({ length: 28 }, (_, i) => [
      { role: 'model', parts: [{ functionCall: { name: `tool_${i}`, args: { path: `src/file_${i}.ts` } } }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: `tool_${i}`,
              response: {
                output: `Detailed log output for file_${i}: ` + 'verification record entry '.repeat(45),
              },
            },
          },
        ],
      },
    ]).flat();

    const baseContents = [
      { role: 'user', parts: [{ text: 'Initial user objective for repository inspection.' }] },
      ...turnToolPairs,
      { role: 'user', parts: [{ text: 'Latest question turn 1' }] },
    ];

    const appendedContents = [
      ...baseContents.slice(0, -1),
      { role: 'user', parts: [{ text: 'Followup user prompt 1' }] },
      { role: 'model', parts: [{ text: 'Model intermediate answer 1' }] },
      { role: 'user', parts: [{ text: 'Followup user prompt 2' }] },
      { role: 'model', parts: [{ text: 'Model intermediate answer 2' }] },
      { role: 'user', parts: [{ text: 'Tail turn' }] },
    ];

    const res1 = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify({ contents: baseContents })),
      'gemini-4-argon',
      { compress: true, collapseHistory: true, charsPerToken: 1 },
    );
    const res2 = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify({ contents: appendedContents })),
      'gemini-4-argon',
      { compress: true, collapseHistory: true, charsPerToken: 1 },
    );

    expect(res1.info.imageCount).toBeGreaterThan(0);
    expect(res2.info.imageCount).toBeGreaterThanOrEqual(res1.info.imageCount);
    const firstChunkTurn1 = res1.info.imagePngs?.[0];
    const firstChunkTurn2 = res2.info.imagePngs?.[0];
    expect(firstChunkTurn1).toBeDefined();
    expect(firstChunkTurn2).toBeDefined();
    expect(Buffer.from(firstChunkTurn1!).equals(Buffer.from(firstChunkTurn2!))).toBe(true);
  });

  it('honestly charges OpenAI self-busts and computes real kosha USD for Google & OpenAI', async () => {
    process.env.INKLING_PRICES = 'kosha';
    setAllowedModelBases(['gpt-5.6-sol', 'gemini']);

    const wSelfBust = deriveOpenAIBaselineWarmth(
      { ts: 1000, cachedOrPrefixTokens: 20_000, prefixSha: 'sys1', model: 'gpt-5.6-sol' },
      1050,
      0,
      'sys1',
      'gpt-5.6-sol',
    );
    expect(wSelfBust.selfBusted).toBe(true);

    const bustedBaseline = computeOpenAISessionBaselineInputEff({
      inputTokens: 15_000,
      cachedTokens: 0,
      imageTokens: 3_000,
      baselineImagedTokens: 10_000,
      model: 'gpt-5.6-sol',
      warmth: wSelfBust,
    });
    // Actual paid 15_000 @ 1x while warm baseline would have reused 20_000 @ readRate + 2_000 @ 1x
    expect(bustedBaseline).toBeLessThan(15_000);

    const dash = new DashboardState();
    dash.update({
      method: 'POST',
      path: '/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent',
      model: 'gemini-3.6-flash',
      accountingProvider: 'google',
      status: 200,
      durationMs: 50,
      usage: { input_tokens: 1_200, output_tokens: 100, cached_tokens: 400 },
      info: {
        compressed: true,
        baselineTokens: 20_000,
        baselineProbeStatus: 'ok',
        imageCount: 1,
        textHygieneSavedTokens: 500,
        textHygieneSavedChars: 2000,
        cliffAvoided: { at: 200_000, multiplier: 2, savedUsd: 0.1234 },
      },
    } as never);

    const stats = (await dash.serveStats().json()) as Record<string, unknown>;
    expect(stats.saved_usd as number).toBeGreaterThan(0);
    expect(stats.compressed_actual_usd as number).toBeGreaterThan(0);
    expect(stats.text_hygiene_saved_tokens).toBe(500);
    expect(stats.text_hygiene_saved_chars).toBe(2000);
    expect(stats.cliff_avoided_events).toBe(1);
    expect(stats.cliff_saved_usd).toBeCloseTo(0.1234, 4);
  });

  it('warp defaultRoutes matches Anthropic, OpenAI, Codex, Google AI Studio, and CloudCode-PA', () => {
    const routes = defaultRoutes(47821);
    const urls = [
      'https://api.anthropic.com/v1/messages?beta=true',
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/chat/completions',
      'https://chatgpt.com/backend-api/codex/responses',
      'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent',
    ];
    for (const u of urls) {
      const parsed = new URL(u);
      expect(
        matchRoute(routes, parsed.host, parsed.pathname + parsed.search),
        `expected route match for ${u}`,
      ).not.toBeNull();
    }
    expect(matchRoute(routes, 'api.openai.com', '/v1/models')).toBeNull();
  });

  it('rolls up OpenAI cached_tokens, Google/OpenAI sessions, text hygiene, and cliff savings in stats & sessions', async () => {
    const s = newSummary();
    const openAiEv: TrackEvent = {
      ts: '2026-11-19T12:00:00Z',
      method: 'POST',
      path: '/v1/responses',
      model: 'gpt-5.6-sol',
      accounting_provider: 'openai',
      status: 200,
      duration_ms: 80,
      compressed: true,
      input_tokens: 4000,
      output_tokens: 100,
      cached_tokens: 3000,
      image_tokens: 800,
      baseline_imaged_tokens: 6000,
      text_hygiene_saved_tokens: 250,
      text_hygiene_saved_chars: 1000,
      cliff_avoided_at: 272_000,
      cliff_saved_usd: 0.05,
      first_user_sha8: 'sess_multi_1',
    };
    const googleEv: TrackEvent = {
      ts: '2026-11-19T12:01:00Z',
      method: 'POST',
      path: '/v1internal:generateContent',
      model: 'gemini-3.6-flash',
      accounting_provider: 'google',
      status: 200,
      duration_ms: 60,
      compressed: true,
      input_tokens: 500,
      output_tokens: 50,
      cached_tokens: 200,
      baseline_tokens: 3500,
      baseline_probe_status: 'ok',
      first_user_sha8: 'sess_multi_2',
    };

    fold(s, openAiEv);
    fold(s, googleEv);
    const json = summaryToJson(s);
    expect(json.cacheHitEvents).toBe(2);
    expect(json.cacheReadTokensTotal).toBe(3200);
    expect(json.textHygieneSavedTokensTotal).toBe(250);
    expect(json.cliffAvoidedEvents).toBe(1);

    const paths = makePaths();
    fs.writeFileSync(paths.eventsFile, `${JSON.stringify(openAiEv)}\n${JSON.stringify(googleEv)}\n`);
    const agg = await aggregateSessions(paths);
    const s1 = agg.sessions.get('sess_multi_1');
    const s2 = agg.sessions.get('sess_multi_2');
    expect(s1).toBeDefined();
    expect(s1!.tokensSavedEst).toBeGreaterThan(0);
    expect(s1!.cacheReadTokens).toBe(3000);
    expect(s2).toBeDefined();
    expect(s2!.tokensSavedEst).toBe(3000);
    expect(s2!.cacheReadTokens).toBe(200);
  });

  it('openai-history full-run fast path avoids redundant binary-search PNG renders', async () => {
    setAllowedModelBases(['gpt-5.6-sol']);
    clearRenderCache();
    const bigText = 'Detailed inspection output for step ';
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first turn' }] },
      ...Array.from({ length: 14 }, (_, i) => [
        { type: 'function_call', call_id: `fc_${i}`, name: 'read_log', arguments: `{"n":${i}}` },
        { type: 'function_call_output', call_id: `fc_${i}`, output: bigText.repeat(50) + String(i) },
      ]).flat(),
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'latest question' }] },
    ];
    const body = new TextEncoder().encode(
      JSON.stringify({
        model: 'gpt-5.6-sol',
        instructions: 'System prompt stays short here.',
        input,
      }),
    );

    const res = await transformOpenAIResponses(body, {
      compress: true,
      charsPerToken: 1,
      collapseHistory: true,
    });
    const stats = renderCacheStats();
    expect(res.info.compressed).toBe(true);
    expect(res.info.collapsedTurns ?? 0).toBeGreaterThan(0);
    // Clean single-segment collapse renders only once without binary search retries.
    expect(stats.misses).toBeLessThanOrEqual(3);
  });

  it('resolves GPT-6.2 Sol 14px profile, guards GPT-6/6.2 Astra as text-only with 3-stage hygiene, and evaluates 272K cliffs', async () => {
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-sol-codex', 'gpt-6.2-sol[1m]', 'openai/gpt-6.2-sol']) {
      const p = resolveGptProfile(id);
      expect(p.style.font, id).toBe('jetbrains-mono-14');
      expect(p.stripCols, id).toBe(84);
      expect(p.maxHeightPx, id).toBe(1954);
      expect(openAIImageDetail(id), id).toBe('high');
      expect(readerTier(id, false), id).toBe('image');
    }

    for (const id of ['gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.2-astra[1m]', 'openai/gpt-6.2-astra']) {
      const p = resolveGptProfile(id);
      expect(p.stripCols, id).toBe(152);
      expect(p.style.font, id).toBe('spleen-5x8');
      expect(p.imageDetail, id).toBe('original');
      expect(prefersText(id, false), id).toBe(true);
      expect(readerTier(id, false), id).toBe('text');
      expect(prefersText(id, true), id).toBe(false);
    }

    process.env.INKLING_PRICES = 'kosha';
    for (const model of ['gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.2-astra-law', 'gpt-6.2-sol']) {
      const cliff = evaluateCliffAvoidance(model, {
        promptTokensBefore: 290_000,
        promptTokensAfter: 250_000,
        collapsedBaselineTokens: 45_000,
        collapsedActualTokens: 5_000,
        expectedOutputTokens: 2_000,
      });
      expect(cliff, model).not.toBeNull();
      expect(cliff!.crossesCliff, model).toBe(true);
      expect(cliff!.cliffAt, model).toBe(272_000);
      expect(cliff!.multiplier, model).toBeCloseTo(2.0, 2);
      expect(cliff!.netSingleTurnUsd, model).toBeGreaterThan(0);
    }

    setAllowedModelBases(['gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.2-sol']);
    const denseDocs = Array.from(
      { length: 80 },
      (_, i) => `<rule id="${i}">Validate schema and state invariants strictly across module_${i}.</rule>`,
    ).join('\n');
    const noisyLog = [
      '2026-11-20T10:00:00Z INFO start suite',
      ...Array.from(
        { length: 50 },
        (_, i) => `2026-11-20T10:01:${String(i % 60).padStart(2, '0')}Z INFO worker=10.0.0.${(i % 4) + 1}:8080 job ${i} ok in ${10 + i}ms`,
      ),
      '2026-11-20T10:02:00Z ERROR boom at src/mod.ts:12',
    ].join('\n');
    const prettyJson = JSON.stringify(
      { items: Array.from({ length: 24 }, (_, i) => ({ id: i, tag: `t_${i}` })) },
      null,
      2,
    );
    const protectedDiff = [
      'diff --git a/src/mod.ts b/src/mod.ts',
      '--- a/src/mod.ts',
      '+++ b/src/mod.ts',
      '@@ -10,2 +10,2 @@',
      '-oldLine();',
      '+newLine();',
    ].join('\n');

    const sent: Array<{ url: string; body: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const r = input instanceof Request ? input : new Request(String(input), init);
      sent.push({ url: r.url, body: await r.text() });
      return new Response(
        JSON.stringify({ id: 'resp_1', output: [], usage: { input_tokens: 800, output_tokens: 20 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const events: Array<{ model?: string; info?: { compressed?: boolean; imageCount?: number; textHygieneSavedTokens?: number } }> = [];
    try {
      const proxy = createProxy({
        openAIUpstream: 'https://api.openai.com',
        transform: {},
        onRequest: (e) => {
          events.push({ model: e.model, info: e.info });
        },
      });

      const mkReqBody = (model: string) =>
        JSON.stringify({
          model,
          instructions: denseDocs,
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check' }] },
            { type: 'function_call_output', call_id: 'c1', output: '\x1b[32mPASS\x1b[0m\n' + noisyLog },
            { type: 'function_call_output', call_id: 'c2', output: prettyJson },
            { type: 'function_call_output', call_id: 'c3', output: protectedDiff },
          ],
        });

      // Astra default -> text-only 3-stage hygiene (0 images, cleaned ANSI/JSON/Drain, diff intact)
      for (const m of ['gpt-6-astra', 'gpt-6.2-astra']) {
        const res = await proxy(
          new Request('http://127.0.0.1/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: mkReqBody(m),
          }),
        );
        expect(res.status, m).toBe(200);
        await res.text();
        await new Promise((r) => setTimeout(r, 15));
        const ev = events.at(-1)!;
        expect(ev.info?.compressed, m).toBe(true);
        expect(ev.info?.imageCount, m).toBe(0);
        expect(ev.info?.textHygieneSavedTokens ?? 0, m).toBeGreaterThan(0);
        const wireBody = sent.at(-1)!.body;
        expect(wireBody, m).not.toContain('data:image/png');
        expect(wireBody, m).not.toContain('\x1b[32m');
        expect(wireBody, m).toContain('similar lines folded');
        expect(wireBody, m).toContain('-oldLine();');
      }

      // INKLING_FORCE_IMAGES=1 opts Astra into GPT6_PROFILE imaging
      process.env.INKLING_FORCE_IMAGES = '1';
      const forcedRes = await proxy(
        new Request('http://127.0.0.1/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: mkReqBody('gpt-6.2-astra'),
        }),
      );
      expect(forcedRes.status).toBe(200);
      await forcedRes.text();
      await new Promise((r) => setTimeout(r, 15));
      expect(events.at(-1)!.info?.imageCount ?? 0).toBeGreaterThan(0);
      delete process.env.INKLING_FORCE_IMAGES;

      // gpt-6.2-sol images natively on /v1/responses (keeps breakpoint) and strips breakpoint on Codex path
      const solDirect = await proxy(
        new Request('http://127.0.0.1/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: mkReqBody('gpt-6.2-sol'),
        }),
      );
      expect(solDirect.status).toBe(200);
      await solDirect.text();
      await new Promise((r) => setTimeout(r, 15));
      expect(events.at(-1)!.info?.imageCount ?? 0).toBeGreaterThan(0);
      expect(bodyHasPromptCacheBreakpoint(sent.at(-1)!.body)).toBe(true);

      const solCodex = await proxy(
        new Request('http://127.0.0.1/backend-api/codex/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: mkReqBody('gpt-6.2-sol'),
        }),
      );
      expect(solCodex.status).toBe(200);
      await solCodex.text();
      await new Promise((r) => setTimeout(r, 15));
      expect(events.at(-1)!.info?.imageCount ?? 0).toBeGreaterThan(0);
      expect(bodyHasPromptCacheBreakpoint(sent.at(-1)!.body)).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('handles new Google models across AI Studio & CloudCode-PA plus kosha pricing checks', async () => {
    process.env.INKLING_PRICES = 'kosha';
    setAllowedModelBases(['gemini']);

    // Kosha pricing validation (pre/post Dec 2026 dated step on Argon/Carbon + Hydrogen + 3.8 Cyber)
    expect(
      estimateBillUsd('gemini-4-argon', {
        uncachedTokens: 1_000_000,
        cachedTokens: 1_000_000,
        at: 1_795_000_000_000,
      }),
    ).toBeCloseTo(2.1, 4);
    expect(
      estimateBillUsd('gemini-4-carbon', {
        uncachedTokens: 1_000_000,
        cachedTokens: 1_000_000,
        at: 1_797_000_000_000,
      }),
    ).toBeCloseTo(4.2, 4);
    expect(
      estimateBillUsd('gemini-4-hydrogen', {
        uncachedTokens: 1_000_000,
        cachedTokens: 1_000_000,
      }),
    ).toBeCloseTo(1.575, 4);
    expect(
      estimateBillUsd('gemini-3.8-flash-cyber', {
        uncachedTokens: 1_000_000,
        cachedTokens: 1_000_000,
      }),
    ).toBeCloseTo(1.65, 4);

    const denseSystem = Array.from(
      { length: 80 },
      (_, i) => `<rule id="${i}">Follow architectural contract_${i} and never fabricate output.</rule>`,
    ).join('\n');
    const noisyLog = [
      '2026-11-20T10:00:00Z INFO start suite',
      ...Array.from(
        { length: 50 },
        (_, i) => `2026-11-20T10:01:${String(i % 60).padStart(2, '0')}Z INFO worker=10.0.0.${(i % 4) + 1}:8080 check ${i} ok in ${8 + i}ms`,
      ),
      '2026-11-20T10:02:00Z ERROR assert failed at src/app.ts:9',
    ].join('\n');

    const mkGoogleReq = (envelopeModel?: string) => {
      const inner = {
        systemInstruction: { parts: [{ text: denseSystem }] },
        contents: [
          { role: 'user', parts: [{ text: 'inspect workspace' }] },
          { role: 'model', parts: [{ functionCall: { name: 'run', args: {} } }] },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'run',
                  response: { output: '\x1b[32mRUN\x1b[0m\n' + noisyLog },
                },
              },
            ],
          },
        ],
      };
      return JSON.stringify(envelopeModel ? { model: envelopeModel, request: inner } : inner);
    };

    const seenUrls: string[] = [];
    const seenBodies: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const r = input instanceof Request ? input : new Request(String(input), init);
      seenUrls.push(r.url);
      seenBodies.push(await r.text());
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 15, cachedContentTokenCount: 200 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const events: Array<{ model?: string; info?: { compressed?: boolean; imageCount?: number; textHygieneSavedTokens?: number } }> = [];
    try {
      const proxy = createProxy({
        passthroughUpstream: 'https://gemini.test',
        transform: {},
        onRequest: (e) => {
          events.push({ model: e.model, info: e.info });
        },
      });

      // Tier 1 imaged models via AI Studio and CloudCode-PA /v1internal:
      for (const tc of [
        { path: '/v1beta/models/gemini-4-argon:generateContent', envelope: undefined, model: 'gemini-4-argon' },
        { path: '/v1internal:generateContent', envelope: 'gemini-3.8-flash', model: 'gemini-3.8-flash' },
        { path: '/v1beta/models/gemini-3.8-flash-cyber:generateContent', envelope: undefined, model: 'gemini-3.8-flash-cyber' },
      ]) {
        seenUrls.length = 0;
        const res = await proxy(
          new Request(`http://127.0.0.1${tc.path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: mkGoogleReq(tc.envelope),
          }),
        );
        expect(res.status, tc.model).toBe(200);
        await res.text();
        await new Promise((r) => setTimeout(r, 15));
        expect(events.at(-1)!.info?.imageCount ?? 0, tc.model).toBeGreaterThan(0);
        expect(seenBodies.at(-1)!, tc.model).toContain('inlineData');
        if (tc.path.startsWith('/v1internal:')) {
          expect(seenUrls.some((u) => u.includes(':countTokens')), tc.model).toBe(false);
        }
      }

      // Unpriced forward-compatible gemini-5-pro safely stays on text hygiene under kosha mode,
      // and images cleanly in legacy mode while skipping /v1internal:countTokens.
      seenUrls.length = 0;
      const g5Kosha = await proxy(
        new Request('http://127.0.0.1/v1internal:streamGenerateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: mkGoogleReq('gemini-5-pro'),
        }),
      );
      expect(g5Kosha.status).toBe(200);
      await g5Kosha.text();
      await new Promise((r) => setTimeout(r, 15));
      expect(events.at(-1)!.info?.compressed).toBe(true);
      expect(events.at(-1)!.info?.imageCount).toBe(0);
      expect(events.at(-1)!.info?.textHygieneSavedTokens ?? 0).toBeGreaterThan(0);

      delete process.env.INKLING_PRICES;
      const g5Legacy = await proxy(
        new Request('http://127.0.0.1/v1internal:streamGenerateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: mkGoogleReq('gemini-5-pro'),
        }),
      );
      expect(g5Legacy.status).toBe(200);
      await g5Legacy.text();
      await new Promise((r) => setTimeout(r, 15));
      expect(events.at(-1)!.info?.imageCount ?? 0).toBeGreaterThan(0);
      expect(seenBodies.at(-1)!).toContain('inlineData');
      expect(seenUrls.some((u) => u.includes(':countTokens'))).toBe(false);
      process.env.INKLING_PRICES = 'kosha';

      // Text-only / unmeasured Google models stay text + get 3-stage text hygiene (no :countTokens)
      for (const m of ['gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-3.1-pro-preview']) {
        seenUrls.length = 0;
        const res = await proxy(
          new Request(`http://127.0.0.1/v1beta/models/${m}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: mkGoogleReq(),
          }),
        );
        expect(res.status, m).toBe(200);
        await res.text();
        await new Promise((r) => setTimeout(r, 15));
        const ev = events.at(-1)!;
        expect(ev.info?.compressed, m).toBe(true);
        expect(ev.info?.imageCount, m).toBe(0);
        expect(ev.info?.textHygieneSavedTokens ?? 0, m).toBeGreaterThan(0);
        expect(seenBodies.at(-1)!, m).not.toContain('inlineData');
        expect(seenBodies.at(-1)!, m).toContain('similar lines folded');
        expect(seenUrls.some((u) => u.includes(':countTokens')), m).toBe(false);
      }

      // INKLING_FORCE_IMAGES=1 opts Carbon/Hydrogen into imaging
      process.env.INKLING_FORCE_IMAGES = '1';
      const forcedCarbon = await proxy(
        new Request('http://127.0.0.1/v1beta/models/gemini-4-carbon:generateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: mkGoogleReq(),
        }),
      );
      expect(forcedCarbon.status).toBe(200);
      await forcedCarbon.text();
      await new Promise((r) => setTimeout(r, 15));
      expect(events.at(-1)!.info?.imageCount ?? 0).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
