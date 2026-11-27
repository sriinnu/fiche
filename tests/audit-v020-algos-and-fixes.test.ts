import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CasiIndex } from '../src/core/casi-delta.js';
import {
  ContextPageStore,
  computeHorizonPaybackLimit,
  computeTailHydration,
  foldMarkovianEpisodes,
  getGlobalMmuStore,
  pruneLowDensityBlob,
  resetGlobalMmuStore,
} from '../src/core/context-mmu.js';
import { MAX_TOKENS as FACTSHEET_MAX_TOKENS, factSheetText } from '../src/core/factsheet.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { PrefixMemoTape, resetGlobalPrefixTape } from '../src/core/prefix-tape.js';
import { createProxy } from '../src/core/proxy.js';
import { optimizePatchCols } from '../src/core/render.js';
import { compileToolSchemas } from '../src/core/schema-compiler.js';
import {
  consumeCacheCircuitBreakerTurn,
  getCacheCircuitBreakerState,
  getSessionCacheHealthSignals,
  isCacheCircuitBreakerOpen,
  noteRollingCacheHealth,
  resetSessionState,
} from '../src/core/session-state.js';
import { extractStructuralDigest, planAndApplyTextEpochs } from '../src/core/text-history.js';
import { applyAnthropicTextHygiene, cleanToolOutput } from '../src/core/text-hygiene.js';
import { decodeToon, encodeToon, encodeToonJsonl } from '../src/core/toon.js';
import { DashboardState, dashboardPath, dispatchDashboard } from '../src/dashboard.js';
import { aggregateSessions, diskUsage, prune } from '../src/sessions.js';
import { readTurnReport } from '../src/turn-report.js';
import { loadOrCreateWarpToken } from '../src/warp/index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'fiche-v020-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('Fiche v0.20.0 Deep Audit Fixes & Algorithmic Upgrades', () => {
  let prevModels: string | undefined;
  let prevPrices: string | undefined;

  beforeEach(() => {
    prevModels = process.env.INKLING_MODELS;
    prevPrices = process.env.INKLING_PRICES;
    process.env.INKLING_MODELS = 'claude-fable-5,gpt-5.6-sol,gpt-6-astra,gemini-3.6-flash';
    process.env.INKLING_PRICES = 'kosha';
    resetSessionState();
    resetGlobalMmuStore();
    resetGlobalPrefixTape();
  });

  afterEach(() => {
    resetSessionState();
    resetGlobalMmuStore();
    resetGlobalPrefixTape();
    if (prevModels === undefined) delete process.env.INKLING_MODELS;
    else process.env.INKLING_MODELS = prevModels;
    if (prevPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = prevPrices;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P0-A / P0-B: creates 0600 warp-token idempotently and gates /api/mmu/stats pages behind token or session scope', async () => {
    const dir = makeTempDir('fiche-p0ab-');
    const tok1 = loadOrCreateWarpToken(dir);
    const tok2 = loadOrCreateWarpToken(dir);
    expect(tok1.length).toBeGreaterThanOrEqual(32);
    expect(tok2).toBe(tok1);
    expect(fs.statSync(path.join(dir, 'warp-token')).mode & 0o777).toBe(0o600);

    const store = getGlobalMmuStore();
    store.storePage({
      sessionKey: 'sess-alpha',
      refId: 'toolu_alpha',
      rawText: Array.from({ length: 24 }, (_, i) => `export function alphaFn${i}() { return ${i}; }`).join('\n'),
    });
    store.storePage({
      sessionKey: 'sess-beta',
      refId: 'toolu_beta',
      rawText: Array.from({ length: 24 }, (_, i) => `export function betaFn${i}() { return ${i}; }`).join('\n'),
    });

    const dash = new DashboardState(undefined, undefined, undefined, { controlToken: tok1 });
    const route = dashboardPath('/api/mmu/stats')!;

    // Unauthenticated & unscoped -> pageCount present, pages hidden, scoped: false
    const anon = await dispatchDashboard(
      dash,
      route,
      'GET',
      new URL('http://127.0.0.1:47821/api/mmu/stats'),
      47821,
      async () => '',
    );
    expect(anon?.status).toBe(200);
    const anonBody = (await anon!.json()) as { pageCount: number; pages: unknown[]; scoped: boolean };
    expect(anonBody.pageCount).toBe(2);
    expect(anonBody.pages).toEqual([]);
    expect(anonBody.scoped).toBe(false);

    // Invalid token header -> 403
    const badTok = await dispatchDashboard(
      dash,
      route,
      'GET',
      new URL('http://127.0.0.1:47821/api/mmu/stats'),
      47821,
      async () => '',
      { headers: { 'x-fiche-control-token': 'wrong-token' }, controlTokenAuthorized: false },
    );
    expect(badTok?.status).toBe(403);

    // Scoped via ?sessionKey=... -> returns only that session's pages
    const scoped = await dispatchDashboard(
      dash,
      route,
      'GET',
      new URL('http://127.0.0.1:47821/api/mmu/stats?sessionKey=sess-alpha'),
      47821,
      async () => '',
    );
    expect(scoped?.status).toBe(200);
    const scopedBody = (await scoped!.json()) as {
      scoped: boolean;
      pages: Array<{ sessionKey: string }>;
    };
    expect(scopedBody.scoped).toBe(true);
    expect(scopedBody.pages).toHaveLength(1);
    expect(scopedBody.pages[0]!.sessionKey).toBe('sess-alpha');

    // Authorized via control token -> returns all pages
    const authed = await dispatchDashboard(
      dash,
      route,
      'GET',
      new URL('http://127.0.0.1:47821/api/mmu/stats'),
      47821,
      async () => '',
      { headers: { 'x-fiche-control-token': tok1 }, controlTokenAuthorized: true },
    );
    expect(authed?.status).toBe(200);
    const authedBody = (await authed!.json()) as { scoped: boolean; pages: unknown[] };
    expect(authedBody.scoped).toBe(true);
    expect(authedBody.pages).toHaveLength(2);
  });

  it('P0-C / P0-D / A1: Page-Hinkley CUSUM + EWMA regret 3-state FSM protects healthy growth, trips on severe busts, and freezes unsealed edits', () => {
    const sk = 'sess-cusum-1';
    const scope = { model: 'claude-fable-5' };
    let t = 1_000_000;

    // Healthy Turn 1..5 growing 1h Anthropic session never trips breaker
    noteRollingCacheHealth(
      sk,
      { cacheReadTokens: 0, cacheCreate1hTokens: 20_000, totalInputTokens: 20_000, nowMs: (t += 15_000) },
      scope,
    );
    for (let turn = 2; turn <= 5; turn++) {
      noteRollingCacheHealth(
        sk,
        {
          cacheReadTokens: 18_000 + turn * 2000,
          cacheCreate1hTokens: 2_500,
          totalInputTokens: 20_500 + turn * 2000,
          nowMs: (t += 15_000),
        },
        scope,
      );
      expect(getCacheCircuitBreakerState(sk, scope)).toBe('closed');
    }
    const signals = getSessionCacheHealthSignals(sk, scope);
    expect(signals.ewmaHitRatio).toBeGreaterThan(0.6);
    expect(signals.ewmaInterTurnSec).toBeCloseTo(15, 0);

    // Single severe cache bust (cacheRead drops to 0 on large 1h create) trips immediately
    noteRollingCacheHealth(
      sk,
      { cacheReadTokens: 0, cacheCreate1hTokens: 50_000, totalInputTokens: 50_000, nowMs: (t += 15_000) },
      scope,
    );
    expect(getCacheCircuitBreakerState(sk, scope)).toBe('open');
    expect(isCacheCircuitBreakerOpen(sk, scope)).toBe(true);

    // Open breaker forces stickyOnly on both planAndApplyTextEpochs and applyAnthropicTextHygiene
    const largeRaw = Array.from({ length: 80 }, (_, i) => `export function fn_${i}(v: number) { return v + ${i}; }`).join(
      '\n',
    );
    let b0 = largeRaw;
    const stickyRes = planAndApplyTextEpochs({
      sessionKey: sk,
      model: 'claude-fable-5',
      totalMessages: 12,
      totalPromptTokens: 60_000,
      keepTailMessages: 2,
      blocks: [
        {
          msgIndex: 1,
          refId: 'r_open',
          getText: () => b0,
          setText: (next) => {
            b0 = next;
          },
        },
      ],
    });
    expect(stickyRes.changed).toBe(false);
    expect(b0).toBe(largeRaw);

    const anthReq: Record<string, unknown> = {
      model: 'claude-fable-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'check this logs' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'src/a.ts' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: largeRaw }],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'src/b.ts' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'next turn prompt' }],
        },
      ],
    };
    const hygRes = applyAnthropicTextHygiene(anthReq, { sessionKey: sk, mode: 'kosha' });
    expect(hygRes.changed).toBe(false);

    // 2 clean turns transition open -> half_open cleanly (or 4 turns without bursts)
    noteRollingCacheHealth(
      sk,
      { cacheReadTokens: 49_000, cacheCreate1hTokens: 0, totalInputTokens: 49_000, nowMs: (t += 15_000) },
      scope,
    );
    expect(getCacheCircuitBreakerState(sk, scope)).toBe('open');
    noteRollingCacheHealth(
      sk,
      { cacheReadTokens: 49_000, cacheCreate1hTokens: 0, totalInputTokens: 49_000, nowMs: (t += 15_000) },
      scope,
    );
    expect(getCacheCircuitBreakerState(sk, scope)).toBe('half_open');

    // Half-open probes frontier-only and blocks mid-prefix seals
    let midRaw = largeRaw;
    const halfOpenMid = planAndApplyTextEpochs({
      model: 'claude-fable-5',
      circuitBreakerState: 'half_open',
      totalMessages: 10,
      totalPromptTokens: 40_000,
      keepTailMessages: 2,
      blocks: [
        { msgIndex: 1, refId: 'mid1', getText: () => midRaw, setText: (n) => (midRaw = n) },
        { msgIndex: 4, refId: 'mid2', getText: () => largeRaw, setText: () => {} },
      ],
    });
    expect(halfOpenMid.changed).toBe(false);

    // 2 healthy turns transition half_open -> closed without Turn-6 re-open
    noteRollingCacheHealth(
      sk,
      { cacheReadTokens: 45_000, cacheCreate1hTokens: 2_000, totalInputTokens: 47_000, nowMs: (t += 15_000) },
      scope,
    );
    expect(getCacheCircuitBreakerState(sk, scope)).toBe('half_open');
    noteRollingCacheHealth(
      sk,
      { cacheReadTokens: 47_000, cacheCreate1hTokens: 2_000, totalInputTokens: 49_000, nowMs: (t += 15_000) },
      scope,
    );
    expect(getCacheCircuitBreakerState(sk, scope)).toBe('closed');
  });

  it('P0-E / P0-F: protects Round 2 >=3 parallel reads in Responses loop and rejects oversized Chat & Responses with 413 compressed=false', async () => {
    const fileBody = (tag: string) =>
      Array.from({ length: 65 }, (_, i) => `${i + 1}\texport const ${tag}_${i} = ${i * 7};`).join('\n');

    const inputItems: unknown[] = [
      { role: 'user', content: 'Inspect Round 1 and Round 2 files' },
      // Round 1 parallel reads (3 files, older completed round)
      { type: 'function_call', call_id: 'r1_a', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'r1_a', output: fileBody('R1A') },
      { type: 'function_call', call_id: 'r1_b', name: 'read_file', arguments: '{"path":"b.ts"}' },
      { type: 'function_call_output', call_id: 'r1_b', output: fileBody('R1B') },
      { type: 'function_call', call_id: 'r1_c', name: 'read_file', arguments: '{"path":"c.ts"}' },
      { type: 'function_call_output', call_id: 'r1_c', output: fileBody('R1C') },
      // Assistant text separates Round 1 from Round 2
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking round 2 files next.' }] },
      // Round 2 trailing 3 parallel reads (live round)
      { type: 'function_call', call_id: 'r2_a', name: 'read_file', arguments: '{"path":"d.ts"}' },
      { type: 'function_call_output', call_id: 'r2_a', output: fileBody('R2A') },
      { type: 'function_call', call_id: 'r2_b', name: 'read_file', arguments: '{"path":"e.ts"}' },
      { type: 'function_call_output', call_id: 'r2_b', output: fileBody('R2B') },
      { type: 'function_call', call_id: 'r2_c', name: 'read_file', arguments: '{"path":"f.ts"}' },
      { type: 'function_call_output', call_id: 'r2_c', output: fileBody('R2C') },
    ];
    const req = { model: 'gpt-5.6-sol', input: inputItems };
    const { body: respOutBody } = await transformOpenAIResponses(
      new TextEncoder().encode(JSON.stringify(req)),
      { imageCompress: false, sessionKey: 'resp-multi-round' },
    );
    const transformedResp = JSON.parse(new TextDecoder().decode(respOutBody)) as {
      input: Array<{ call_id?: string; output?: unknown }>;
    };

    const outItems = transformedResp.input;
    const findOut = (id: string) =>
      String(outItems.find((x: Record<string, unknown>) => x.type === 'function_call_output' && x.call_id === id)?.output ?? '');
    // Round 2 trailing parallel reads stay verbatim
    expect(findOut('r2_a')).toBe(fileBody('R2A'));
    expect(findOut('r2_b')).toBe(fileBody('R2B'));
    expect(findOut('r2_c')).toBe(fileBody('R2C'));

    // P0-F: HTTP 413 compressed=false for BOTH Chat Completions & Responses when maxSerializedRequestBytes exceeded
    const prevProfiles = process.env.INKLING_GPT_PROFILES;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const events: Array<{ compressed: boolean | undefined; sizeLimitOutcome?: string; status: number }> = [];
    try {
      process.env.INKLING_GPT_PROFILES = JSON.stringify({
        'gpt-5.6-sol': { maxSerializedRequestBytes: 1 },
      });
      const proxy = createProxy({
        upstream: 'http://mock',
        openAIUpstream: 'http://mock',
        transform: { charsPerToken: 1, minCompressChars: 1 },
        onRequest: (ev) =>
          events.push({
            compressed: ev.info?.compressed,
            sizeLimitOutcome: ev.info?.sizeLimitOutcome,
            status: ev.status,
          }),
      });
      const bigSys = 'System instruction. '.repeat(900);
      const chatRes = await proxy(
        new Request('http://localhost/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.6-sol',
            messages: [
              { role: 'system', content: bigSys },
              { role: 'user', content: 'hi' },
            ],
          }),
        }),
      );
      const respRes = await proxy(
        new Request('http://localhost/openai/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.6-sol',
            instructions: bigSys,
            input: [{ role: 'user', content: 'hi' }],
          }),
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(chatRes.status).toBe(413);
      expect(respRes.status).toBe(413);
      expect(events).toHaveLength(2);
      for (const ev of events) {
        expect(ev.status).toBe(413);
        expect(ev.sizeLimitOutcome).toBe('rejected');
        expect(ev.compressed).toBe(false);
      }
    } finally {
      globalThis.fetch = origFetch;
      if (prevProfiles === undefined) delete process.env.INKLING_GPT_PROFILES;
      else process.env.INKLING_GPT_PROFILES = prevProfiles;
    }
  });

  it('P1 / P2: reconciles .1 rotated events in prune/diskUsage/dashboard, flags by_model.priced, aligns accounting_provider & restores MMU skill metadata', async () => {
    const dir = makeTempDir('fiche-p12-');
    const eventsFile = path.join(dir, 'events.jsonl');
    const rotatedFile = `${eventsFile}.1`;
    const sidecarDir = path.join(dir, '4xx-bodies');
    fs.mkdirSync(sidecarDir, { recursive: true });

    const evOld = {
      ts: '2026-11-26T10:00:00Z',
      accounting_provider: 'google',
      path: '/v1/messages',
      model: 'gemini-3.6-flash',
      status: 200,
      duration_ms: 50,
      compressed: true,
      first_user_sha8: 'sess_rot_1',
      baseline_tokens: 2000,
      baseline_probe_status: 'ok',
      text_hygiene_saved_tokens: 100,
      input_tokens: 800,
      cached_tokens: 200,
      output_tokens: 100,
    };
    const evKeep = {
      ts: '2026-11-27T11:00:00Z',
      accounting_provider: 'openai',
      path: '/v1/chat/completions',
      model: 'unlisted-custom-model',
      status: 200,
      duration_ms: 40,
      compressed: true,
      first_user_sha8: 'sess_keep_1',
      text_hygiene_saved_tokens: 100,
      input_tokens: 900,
      output_tokens: 50,
    };
    fs.writeFileSync(rotatedFile, JSON.stringify(evOld) + '\n');
    fs.writeFileSync(eventsFile, JSON.stringify(evKeep) + '\n');

    const duBefore = diskUsage({ eventsFile, sidecarDir });
    expect(duBefore.eventsJsonlBytes).toBe(fs.statSync(rotatedFile).size + fs.statSync(eventsFile).size);

    const dash = new DashboardState({ eventsFile, sidecarDir });
    await dash.replay(eventsFile);
    const proxyStatsRes = dash.serveStats();
    expect(proxyStatsRes.status).toBe(200);
    const proxyStatsJson = (await proxyStatsRes.json()) as {
      by_model: Record<string, { priced: boolean }>;
    };
    expect(proxyStatsJson.by_model['gemini-3.6-flash']?.priced).toBe(true);
    expect(proxyStatsJson.by_model['unlisted-custom-model']?.priced).toBe(false);

    // Mutating .1 invalidates serveApiStats cache (eventLogStatSig covers rotated + active)
    const statsRes = await dash.serveApiStats();
    expect(statsRes.status).toBe(200);
    const statsJson = (await statsRes.json()) as { parsed: number };
    expect(statsJson.parsed).toBe(2);

    fs.writeFileSync(rotatedFile, JSON.stringify(evOld) + '\n' + JSON.stringify(evOld) + '\n');
    const statsRes2 = await dash.serveApiStats();
    const statsJson2 = (await statsRes2.json()) as { parsed: number };
    expect(statsJson2.parsed).toBe(3);

    const agg = await aggregateSessions({ eventsFile, sidecarDir });
    expect(agg.sessions.has('sess_rot_1')).toBe(true);
    expect(agg.sessions.get('sess_rot_1')?.requestCount).toBe(2);

    // readTurnReport picks up active + rotated .1 and respects accounting_provider: 'google'
    const rotOnlyEvents = path.join(dir, 'rot-only.jsonl');
    fs.writeFileSync(`${rotOnlyEvents}.1`, JSON.stringify(evOld) + '\n');
    const rotReport = readTurnReport(rotOnlyEvents);
    expect(rotReport.lastTurn?.model).toBe('gemini-3.6-flash');
    expect(rotReport.session.turns).toBe(1);

    const pr = await prune({ eventsFile, sidecarDir }, { sessionId: 'sess_rot_1', force: true });
    expect(pr.applied).toBe(true);
    expect(pr.sessionsRemoved).toEqual(['sess_rot_1']);
    expect(fs.existsSync(rotatedFile)).toBe(false);

    // Skill-catalog persist/restore + cross-session derefPage boundary
    const skillNow = Date.now() - 5000;
    const mmu1 = new ContextPageStore({ maxPages: 32, maxBytes: 1024 * 1024 });
    const skillPage = mmu1.storePage({
      sessionKey: 'sk-owner',
      refId: 'skill:deploy',
      toolName: 'skill-catalog',
      rawText: 'Deploy runbook: invoke deployAlphaCluster and verifyRolloutHealth',
      extraSymbols: ['customSkillSymbol'],
      nowMs: skillNow,
    });
    mmu1.storePage({
      sessionKey: 'sk-partner',
      refId: 'skill:deploy',
      toolName: 'skill-catalog',
      rawText: 'Deploy runbook: invoke deployAlphaCluster and verifyRolloutHealth',
      nowMs: skillNow + 1000,
    });
    const dump = mmu1.serialize();
    const mmu2 = new ContextPageStore({ maxPages: 32, maxBytes: 1024 * 1024 });
    mmu2.restore(dump);

    // Cross-session deref denied unless linked; linked sessions succeed with scoped sessionKey
    expect(mmu2.derefPage(skillPage.id, { sessionKey: 'sk-other' })).toBeNull();
    const ownerDeref = mmu2.derefPage(skillPage.id, { sessionKey: 'sk-owner' });
    const partnerDeref = mmu2.derefPage(skillPage.id, { sessionKey: 'sk-partner' });
    expect(ownerDeref?.text).toContain('deployAlphaCluster');
    expect(partnerDeref?.page.sessionKey).toBe('sk-partner');
  });

  it('A2–A7: exercises horizon frontierOnly, L1 fail deferral + Markov fold, CASI Histogram & sub-window, S3-FIFO, BM25F/knapsack, Vision tile/patch, TOON, Glob/Drain, CodeComp, FactSheet & TSCG', async () => {
    // A2: frontierOnly vs mid-prefix payback limits + adverse telemetry survival
    const limitFrontier = computeHorizonPaybackLimit({
      turnsObserved: 3,
      baseMaxPayback: 12,
      downstreamCachedTokens: 2100,
      frontierOnly: true,
      writeRate: 1.0,
    });
    const limitMidEarly = computeHorizonPaybackLimit({
      turnsObserved: 3,
      baseMaxPayback: 12,
      downstreamCachedTokens: 2100,
      frontierOnly: false,
      writeRate: 1.0,
    });
    const limitLowSurvival = computeHorizonPaybackLimit({
      turnsObserved: 12,
      baseMaxPayback: 12,
      downstreamCachedTokens: 2100,
      frontierOnly: true,
      ttlSec: 300,
      ewmaInterTurnSec: 250,
      ewmaHitRatio: 0.4,
      writeRate: 1.25,
    });
    expect(limitFrontier).toBe(12);
    expect(limitMidEarly).toBeLessThan(12);
    expect(limitLowSurvival).toBeLessThan(limitFrontier);

    // L1 failure deferral + Markov fold with resolved errors
    const store = new ContextPageStore({ maxPages: 64, maxBytes: 2 * 1024 * 1024 });
    const hugeOk = Array.from({ length: 70 }, (_, i) => `const okLine_${i} = ${i};`).join('\n');
    const hugeFail = 'FAIL tests/auth.test.ts\nTypeError: missing token\n' + hugeOk;
    let l1Fail = hugeFail;
    let l1Ok = hugeOk;
    planAndApplyTextEpochs({
      sessionKey: 'l1-defer',
      enableLsm: true,
      model: 'claude-fable-5',
      totalMessages: 7,
      totalPromptTokens: 25_000,
      keepTailMessages: 4,
      lsmEditTailMessages: 1,
      lsmMinLargeBlockTokens: 200,
      blocks: [
        { msgIndex: 3, refId: 'fail1', getText: () => l1Fail, setText: (n) => (l1Fail = n) },
        { msgIndex: 4, refId: 'ok1', getText: () => l1Ok, setText: (n) => (l1Ok = n) },
      ],
    });
    expect(l1Fail).toBe(hugeFail);
    expect(l1Ok).toContain('[fiche epoch-digest');

    let bFail1 = 'FAIL src/db.test.ts\nAssertionError: pool closed\n' + 'detail trace line '.repeat(220);
    let bRetry = 'retrying pool query\n' + 'trace output line '.repeat(220);
    let bFix = 'updated src/db.ts retry guard\n' + 'diff hunk line '.repeat(220);
    let bRead = 'reading src/db.ts\n' + 'context body line '.repeat(220);
    let bPass = 'Test Files 5 passed (5)\nTests 25 passed (25)\n' + 'ok passed line '.repeat(60);
    const foldRes = foldMarkovianEpisodes({
      store,
      sessionKey: 'markov-ep',
      totalMessages: 15,
      keepTailMessages: 4,
      blocks: [
        { msgIndex: 1, refId: 'm1', getText: () => bFail1, setText: (n) => (bFail1 = n) },
        { msgIndex: 2, refId: 'm2', getText: () => bRetry, setText: (n) => (bRetry = n) },
        { msgIndex: 3, refId: 'm3', getText: () => bFix, setText: (n) => (bFix = n) },
        { msgIndex: 4, refId: 'm4', getText: () => bRead, setText: (n) => (bRead = n) },
        { msgIndex: 5, refId: 'm5', getText: () => bPass, setText: (n) => (bPass = n) },
      ],
    });
    expect(foldRes.changed).toBe(true);
    expect(bFail1).toContain('[fiche causal-episode');
    expect(bFail1).toContain('resolved errors:');

    // PrefixMemoTape bounded casiSnapshots (24 max) + 0-char unchanged CASI memo
    const tape = new PrefixMemoTape();
    for (let i = 0; i < 30; i++) tape.putCasiSnapshot(`snap-${i}`, { n: i });
    expect(tape.takeCasiSnapshot('snap-0')).toBeUndefined();
    expect(tape.takeCasiSnapshot<{ n: number }>('snap-29')).toEqual({ n: 29 });

    // CASI sub-window delta & JGit Histogram stray-line diff
    const casi = new CasiIndex();
    const baseLines = Array.from(
      { length: 180 },
      (_, i) => `line_${String(i).padStart(3, '0')}: computeDeterministicallyBalancedHashStepWithAnchorToken(${i});`,
    );
    const baseDoc = baseLines.join('\n');
    expect(casi.ingest(baseDoc, 'base1').changed).toBe(false);
    const subWin = baseLines.slice(25, 80).join('\n');
    const subRes = casi.ingest(subWin, 'sub1');
    expect(subRes.changed).toBe(true);
    expect(subRes.text).toContain('base1:26..80');

    // S3-FIFO scan resistance: keep hot code page accessed >= 2 across large log dump flood
    const fifoStore = new ContextPageStore({ maxPages: 6, maxBytes: 4096 });
    const hotPage = fifoStore.storePage({
      sessionKey: 'fifo',
      refId: 'hot',
      rawText: 'export function hotSymbolS3Fifo() { return 42; }\n'.repeat(8),
      nowMs: 1,
    });
    // Re-access hotPage so freq >= 1 (promoted on probation eviction)
    expect(fifoStore.derefPage(hotPage.id, { sessionKey: 'fifo' })?.text).toContain('hotSymbolS3Fifo');
    for (let i = 0; i < 8; i++) {
      fifoStore.storePage({
        sessionKey: 'fifo',
        refId: `scan_${i}`,
        rawText: `log dump batch ${i}: status ok entry_${i}\n`.repeat(12),
        nowMs: 10 + i,
      });
    }
    expect(fifoStore.getPage(hotPage.id, 'fifo')?.id).toBe(hotPage.id);

    // BM25F + submodular knapsack + zero-floor stopword-free pruneLowDensityBlob
    const hydrateStore = new ContextPageStore({ maxPages: 32, maxBytes: 1024 * 1024 });
    hydrateStore.storePage({
      sessionKey: 'hyd',
      refId: 'p1',
      filePath: 'src/cfg.ts',
      rawText: Array.from(
        { length: 20 },
        (_, i) => `export const SPECIAL_TICKET_FLAG_${i} = 'sha_${i}';`,
      ).join('\n'),
    });
    const hydrated = computeTailHydration({
      store: hydrateStore,
      sessionKey: 'hyd',
      liveTailTexts: ['Check SPECIAL_TICKET_FLAG_3 in cfg.ts'],
      budgetTokens: 400,
    });
    expect(hydrated.changed).toBe(true);
    expect(hydrated.text).toContain('SPECIAL_TICKET_FLAG_3');

    const proseBlob = Array.from({ length: 80 }, (_, i) =>
      i === 40
        ? 'The critical root cause is ECONNREFUSED on port 47821 in src/node.ts.'
        : 'the and with that this from have will your about more some into only other been very just then',
    ).join('\n');
    const pruned = pruneLowDensityBlob(proseBlob, { minChars: 1000 });
    expect(pruned.changed).toBe(true);
    expect(pruned.text).toContain('ECONNREFUSED');

    // OpenAI tile profile 100x2048 & optimizePatchCols
    const tileProfile = resolveGptProfile('gpt-5');
    expect(tileProfile.stripCols).toBe(100);
    expect(tileProfile.maxHeightPx).toBe(2048);
    const optCols = optimizePatchCols(400, 100, 5, 8, {
      vision: { regime: 'patch28', pxPerToken: 784, overhead: 0 },
      cacheReadRate: 0.1,
      outputRate: 5,
    });
    expect(optCols).toBeLessThanOrEqual(100);

    // Gemini flat non-overshoot via transformGoogleGenerateContent
    const gReq = {
      systemInstruction: { parts: [{ text: 'System rules' }] },
      contents: Array.from({ length: 18 }, (_, i) => [
        { role: 'user', parts: [{ text: `Turn ${i}: inspect module ${i}` }] },
        {
          role: 'model',
          parts: [
            {
              text:
                i < 12
                  ? Array.from({ length: 80 }, (__, k) => `line_${i}_${k}: computed_value=${i * 100 + k};`).join('\n')
                  : 'Recent model note',
            },
          ],
        },
      ]).flat(),
    };
    const { info: gInfo } = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(gReq)),
      'gemini-3.6-flash',
      {
        imageCompress: true,
        sessionKey: 'gem-cap',
      },
    );
    expect(gInfo.imageCount ?? 0).toBeLessThanOrEqual(12);

    // Bijective TOON JSONL + depth-2 @meta round-trip
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      service: 'auth-proxy',
      region: 'us-east-1',
      status: i % 2 === 0 ? 'ok' : 'warn',
      latencyMs: 12 + i,
    }));
    const ndjson = rows.map((r) => JSON.stringify(r)).join('\n');
    const toonJsonl = encodeToonJsonl(ndjson);
    expect(toonJsonl).not.toBeNull();
    expect(decodeToon(toonJsonl!)).toBe(ndjson);

    const wrapped = { status: 'ok', total: rows.length, items: rows };
    const toonWrapped = encodeToon(wrapped);
    expect(toonWrapped).not.toBeNull();
    expect(decodeToon(toonWrapped!)).toEqual(wrapped);

    // Glob @root compaction + pytest PASSED Drain clustering
    const globList = Array.from(
      { length: 24 },
      (_, i) => `/Users/dev/project/src/features/module_${i % 4}/handler_${i}.ts`,
    ).join('\n');
    const globClean = cleanToolOutput(globList, { mode: 'kosha' });
    expect(globClean.changed).toBe(true);
    expect(globClean.text).toContain('@root /Users/dev/project/src/features/');

    const pytestLog = Array.from(
      { length: 45 },
      (_, i) => `PASSED tests/unit/test_worker_${i}.py::test_exec_${i} [ 4%]`,
    ).join('\n');
    const pytestClean = cleanToolOutput(pytestLog, { mode: 'kosha', foldLogs: true });
    expect(pytestClean.changed).toBe(true);
    expect(pytestClean.stages).toContain('log_fold');

    // CodeComp multi-line signature skeleton + FactSheet Tier 0a SHA survival
    const multiSigCode = [
      'export class PaymentLedgerService {',
      '  async reconcileSettlementBatch(',
      '    batchId: string,',
      '    cursorToken: string,',
      '    strictMode = true,',
      '  ): Promise<number> {',
      ...Array.from({ length: 40 }, (_, i) => `    const step_${i} = ${i} * 3;`),
      '    return 1;',
      '  }',
      '}',
    ].join('\n');
    const digest = extractStructuralDigest(multiSigCode, 'ledger');
    expect(digest).toContain('reconcileSettlementBatch');
    expect(digest).toContain('batchId: string');

    const camelFlood = Array.from({ length: FACTSHEET_MAX_TOKENS * 2 }, (_, i) => `camelIdentNum${i}`).join(' ');
    const shaBlob = `${camelFlood}\ncommit deadbeef1234567890abcdef`;
    const sheet = factSheetText(shaBlob);
    expect(sheet).toContain('deadbeef1234567890abcdef');

    // TSCG Draft 2020-12 $ref sibling factoring on repeated large sub-schemas
    const sharedSub = {
      type: 'object',
      description: 'Large shared request configuration block for service validation.',
      properties: {
        endpointUrl: { type: 'string', description: 'Target HTTPS endpoint URL' },
        timeoutMillis: { type: 'integer', description: 'Timeout in milliseconds' },
        retryLimit: { type: 'integer', description: 'Max retry count' },
        headers: { type: 'object', description: 'Extra request headers map' },
        enableTlsVerify: { type: 'boolean', description: 'Verify TLS certificates' },
      },
      required: ['endpointUrl', 'timeoutMillis'],
    };
    const tools = [
      {
        name: 'dispatchJob',
        description: 'Dispatch work',
        input_schema: {
          type: 'object',
          properties: {
            primary: { ...sharedSub, description: 'Primary config override' },
            secondary: { ...sharedSub, description: 'Secondary config override' },
          },
        },
      },
    ];
    const schemaRes = compileToolSchemas(tools, 'anthropic');
    expect(schemaRes.changed).toBe(true);
    expect(JSON.stringify(tools)).toContain('$defs');
  });
});
