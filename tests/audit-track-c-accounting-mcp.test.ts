import { createServer as createNodeHttpServer } from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { clearCalibratedProfiles, setCalibratedProfile } from '../src/core/calibration.js';
import { getGlobalMmuStore, resetGlobalMmuStore } from '../src/core/context-mmu.js';
import { transformAnyRequest } from '../src/core/request-transform.js';
import type { TrackEvent } from '../src/core/tracker.js';
import { DashboardState } from '../src/dashboard.js';
import type { StatsPayload } from '../src/dashboard/types.js';
import {
  MCP_MAX_BYTES,
  handleMcpMessage,
  pushMcpChunk,
  resetMcpStatsForTests,
} from '../src/mcp/server.js';
import { claudeCodeMap, prune, type SessionsPaths } from '../src/sessions.js';
import { fold, newSummary, summaryToJson } from '../src/stats.js';
import { computeTurnSnapshot, readTurnReport } from '../src/turn-report.js';

const enc = new TextEncoder();

async function reserveUnusedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('Track C audit: accounting honesty, dashboard, sessions & MCP parity', () => {
  const tmpDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {
    PORT: process.env.PORT,
    FICHE_PRICES: process.env.FICHE_PRICES,
    INKLING_PRICES: process.env.INKLING_PRICES,
    FICHE_MODELS: process.env.FICHE_MODELS,
    INKLING_MODELS: process.env.INKLING_MODELS,
    FICHE_CONFIG: process.env.FICHE_CONFIG,
    FICHE_TEXT_HYGIENE: process.env.FICHE_TEXT_HYGIENE,
    FICHE_OPTICAL_MODE: process.env.FICHE_OPTICAL_MODE,
    FICHE_FORCE_IMAGES: process.env.FICHE_FORCE_IMAGES,
    FICHE_GPT_PROFILES: process.env.FICHE_GPT_PROFILES,
  };

  function mkTmpDir(prefix = 'fiche-track-c-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setAllowedModelBases(null);
    clearCalibratedProfiles();
    resetMcpStatsForTests();
    resetGlobalMmuStore();
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. stats.ts
  // =========================================================================
  describe('stats.ts honesty, topN ordering & bounded reservoir', () => {
    it('excludes 5xx, 4xx, aborted/no-usage, zero-actual, and passthrough rows with OK probe from measured savings', () => {
      const s = newSummary();
      const base = {
        ts: '2026-11-25T10:00:00Z',
        method: 'POST',
        path: '/v1/messages',
        duration_ms: 50,
      };
      // 5xx with completed count_tokens probe -> must NOT fabricate 100% savings
      fold(s, {
        ...base,
        status: 502,
        compressed: true,
        baseline_probe_status: 'ok',
        baseline_tokens: 50_000,
        input_tokens: 100,
      });
      // 4xx with completed probe
      fold(s, {
        ...base,
        status: 400,
        compressed: true,
        baseline_probe_status: 'ok',
        baseline_tokens: 50_000,
        input_tokens: 100,
      });
      // Aborted 200 without usage
      fold(s, {
        ...base,
        status: 200,
        compressed: true,
        baseline_probe_status: 'ok',
        baseline_tokens: 50_000,
      });
      // 200 with zero actualInput
      fold(s, {
        ...base,
        status: 200,
        compressed: true,
        baseline_probe_status: 'ok',
        baseline_tokens: 50_000,
        input_tokens: 0,
        output_tokens: 10,
      });
      // Passthrough (compressed: false) with completed probe
      fold(s, {
        ...base,
        status: 200,
        compressed: false,
        reason: 'below_threshold',
        baseline_probe_status: 'ok',
        baseline_tokens: 50_000,
        input_tokens: 49_000,
      });
      // Valid compressed 2xx with usage
      fold(s, {
        ...base,
        status: 200,
        compressed: true,
        baseline_probe_status: 'ok',
        baseline_tokens: 10_000,
        input_tokens: 2_000,
        cache_create_tokens: 500,
      });

      expect(s.baselineMeasuredEvents).toBe(1);
      expect(s.baselineTokensTotal).toBe(10_000);
      expect(s.measuredActualTokensTotal).toBe(2_500);
    });

    it('sorts topN descending by count in summaryToJson and bounds latency reservoirs to <= 4096 samples', () => {
      const s = newSummary();
      // Insert 25 distinct skipReasons, with the highest counts inserted LAST
      for (let i = 1; i <= 25; i++) {
        for (let c = 0; c < i; c++) {
          fold(s, {
            ts: '2026-11-25T10:00:00Z',
            method: 'POST',
            path: '/v1/messages',
            status: 200,
            duration_ms: i,
            first_byte_ms: i,
            compressed: false,
            reason: `reason_${String(i).padStart(2, '0')}`,
            cwd: `/proj/${String(i).padStart(2, '0')}`,
            system_sha8: `sha_${String(i).padStart(2, '0')}`,
            unknown_static_tags: [`tag_${String(i).padStart(2, '0')}`],
          });
        }
      }
      // Feed 5000 more events to push durationMs & firstByteMs well past 4096
      for (let i = 0; i < 5000; i++) {
        fold(s, {
          ts: '2026-11-25T10:00:00Z',
          method: 'POST',
          path: '/v1/messages',
          status: 200,
          duration_ms: 100 + (i % 50),
          first_byte_ms: 20 + (i % 10),
        });
      }

      expect(s.durationMs.length).toBeLessThanOrEqual(4096);
      expect(s.firstByteMs.length).toBeLessThanOrEqual(4096);

      const json = summaryToJson(s) as {
        skipReasons: Array<[string, number]>;
        byCwd: Array<[string, { count: number }]>;
        systemShaHist: Array<[string, number]>;
        unknownTags: Array<[string, number]>;
        durationP50: number;
      };
      expect(json.skipReasons).toHaveLength(20);
      expect(json.skipReasons[0]).toEqual(['reason_25', 25]);
      expect(json.skipReasons[19]).toEqual(['reason_06', 6]);
      expect(json.byCwd[0]![0]).toBe('/proj/25');
      expect(json.systemShaHist[0]).toEqual(['sha_25', 25]);
      expect(json.unknownTags[0]).toEqual(['tag_25', 25]);
      expect(json.durationP50).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 2. turn-report.ts
  // =========================================================================
  describe('turn-report.ts cache-weighted USD, self-bust negative delta, Google inclusive & cursor', () => {
    it('charges 1.25x 5m vs 2.0x 1h write surcharges and never hides negative tokUsd behind cliffUsd', () => {
      process.env.FICHE_PRICES = 'kosha';

      const ev5m: TrackEvent = {
        ts: '2026-11-25T10:00:00.000Z',
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        duration_ms: 100,
        compressed: true,
        baseline_probe_status: 'ok',
        baseline_tokens: 10_000,
        baseline_cacheable_tokens: 9_000,
        input_tokens: 1_000,
        cache_create_tokens: 2_000,
        cache_create_5m_tokens: 2_000,
        cache_create_1h_tokens: 0,
        cache_read_tokens: 0,
      };
      const ev1h: TrackEvent = {
        ...ev5m,
        cache_create_5m_tokens: 0,
        cache_create_1h_tokens: 2_000,
      };
      // Fable 5 = $10/MTok.
      // 5m cold: baseline = 9000*1.25 + 1000 = 12250; actual = 1000 + 2000*1.25 = 3500 -> saved = 8750 -> $0.0875
      // 1h cold: baseline = 9000*2.0 + 1000 = 19000; actual = 1000 + 2000*2.0 = 5000 -> saved = 14000 -> $0.14
      const snap5m = computeTurnSnapshot(ev5m);
      const snap1h = computeTurnSnapshot(ev1h);
      expect(snap5m.savedUsd).toBeCloseTo(0.0875, 6);
      expect(snap1h.savedUsd).toBeCloseTo(0.14, 6);

      // Cache bust causing negative tokUsd EVEN WHEN cliff_saved_usd > 0 -> must stay negative!
      const bustWithCliff: TrackEvent = {
        ts: '2026-11-25T10:01:00.000Z',
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        duration_ms: 100,
        compressed: true,
        baseline_probe_status: 'ok',
        baseline_tokens: 10_000,
        baseline_cacheable_tokens: 9_000,
        input_tokens: 1_000,
        cache_create_tokens: 12_000, // huge bust -> actual = 1000 + 12000*1.25 = 16000 > baseline 12250
        cache_read_tokens: 0,
        cliff_avoided_at: 200_000,
        cliff_saved_usd: 0.25,
      };
      const bustSnap = computeTurnSnapshot(bustWithCliff);
      expect(bustSnap.savedTokens).toBe(-3_000);
      expect(bustSnap.savedUsd).toBeLessThan(0);
      expect(bustSnap.savedUsd).toBeCloseTo(-0.0375, 6);
    });

    it('detects multi-turn session self-busts in readTurnReport and writes cursor with 0o600 permissions', () => {
      delete process.env.FICHE_PRICES;
      delete process.env.INKLING_PRICES;
      const dir = mkTmpDir();
      const eventsFile = path.join(dir, 'events.jsonl');
      const cursorFile = path.join(dir, 'cursor.json');

      const t1: TrackEvent = {
        ts: '2026-11-25T10:00:00.000Z',
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        duration_ms: 500,
        compressed: true,
        first_user_sha8: 'sess_bust',
        system_sha8: 'sys_a',
        cache_prefix_sha8: 'px_1',
        baseline_probe_status: 'ok',
        baseline_tokens: 30_000,
        baseline_cacheable_tokens: 20_000,
        input_tokens: 100,
        cache_create_tokens: 0,
        cache_read_tokens: 20_000,
      };
      const t2: TrackEvent = {
        ts: '2026-11-25T10:00:30.000Z',
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        duration_ms: 500,
        compressed: true,
        first_user_sha8: 'sess_bust',
        system_sha8: 'sys_a',
        cache_prefix_sha8: 'px_2', // changed prefix -> self-bust!
        baseline_probe_status: 'ok',
        baseline_tokens: 30_000,
        baseline_cacheable_tokens: 20_000,
        input_tokens: 100,
        cache_create_tokens: 20_000,
        cache_read_tokens: 0,
      };
      fs.writeFileSync(eventsFile, `${JSON.stringify(t1)}\n${JSON.stringify(t2)}\n`);

      const report = readTurnReport(eventsFile, { cursorFile });
      expect(report.hasNewTurn).toBe(true);
      // Warm text baseline = 20000*0.1 + 10000 = 12000; actual = 100 + 20000*1.25 = 25100 -> -13100 weighted -> -$0.131 at legacy $10/MTok
      expect(report.lastTurn?.savedUsd).toBeCloseTo(-0.131, 6);
      expect(fs.statSync(cursorFile).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toHaveLength(0);
    });

    it('treats Google cached_tokens as inclusive subset of input_tokens and matches stats/proxy', () => {
      process.env.FICHE_PRICES = 'kosha';
      const gEv: TrackEvent = {
        ts: '2026-11-25T10:05:00.000Z',
        method: 'POST',
        path: '/v1beta/models/gemini-3.6-flash:generateContent',
        model: 'gemini-3.6-flash',
        accounting_provider: 'google',
        status: 200,
        duration_ms: 80,
        compressed: true,
        baseline_probe_status: 'ok',
        baseline_tokens: 10_000,
        input_tokens: 4_000,
        cached_tokens: 3_000,
      };
      const snap = computeTurnSnapshot(gEv);
      expect(snap.inputTokens).toBe(4_000);
      expect(snap.cachedTokens).toBe(3_000);
      expect(snap.cacheHitPct).toBe(75);
      expect(snap.savedTokens).toBe(6_000);
    });
  });

  // =========================================================================
  // 3. dashboard.ts & sessions.ts
  // =========================================================================
  describe('dashboard.ts & sessions.ts reconciliation, LRU, warmth, catalog, headers & caching', () => {
    it('keeps rawSaved signed, reconciles sum(by_model) with headline totals, uses model output rate, and includes cliffUsd without double counting', async () => {
      process.env.FICHE_PRICES = 'kosha';
      setAllowedModelBases(['claude-fable-5']);

      const dash = new DashboardState();
      // 1) Normal compressed event with cliff avoidance
      dash.update({
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        durationMs: 100,
        usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 5_000,
        },
        info: {
          compressed: true,
          baselineTokens: 10_000,
          baselineCacheableTokens: 8_000,
          baselineProbeStatus: 'ok',
          cliffAvoided: { at: 200_000, multiplier: 2, savedUsd: 0.42 },
          firstUserSha8: 's1',
        },
      } as never);

      // 2) Negative raw token expansion event (actual > baseline)
      dash.update({
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        durationMs: 100,
        usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          cache_creation_input_tokens: 15_000,
          cache_read_input_tokens: 0,
        },
        info: {
          compressed: true,
          baselineTokens: 10_000,
          baselineCacheableTokens: 8_000,
          baselineProbeStatus: 'ok',
          firstUserSha8: 's2',
        },
      } as never);

      // 3) Disabled model event (must be excluded consistently from headline, daily, AND by_model)
      dash.update({
        method: 'POST',
        path: '/v1/messages',
        model: 'gpt-5.6-sol',
        status: 200,
        durationMs: 100,
        usage: { input_tokens: 1_000, output_tokens: 10, cached_tokens: 500 },
        info: {
          compressed: true,
          imageTokens: 200,
          baselineImagedTokens: 5_000,
          firstUserSha8: 's3',
        },
      } as never);

      const statsRes = dash.serveStats();
      expect(statsRes.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(statsRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(statsRes.headers.get('cache-control')).toBe('no-store');

      const stats = (await statsRes.json()) as StatsPayload;
      expect(stats.by_model?.['gpt-5.6-sol']).toBeUndefined();
      // Event 1 raw = 10000 - 6000 = +4000; Event 2 raw = 10000 - 16000 = -6000 -> total raw = -2000 (signed!)
      expect(stats.raw_saved_tokens).toBe(-2_000);
      expect(stats.today?.raw_saved_tokens).toBe(-2_000);

      // Reconcile sum(by_model) against headline totals
      const models = Object.values(stats.by_model ?? {});
      const sumReq = models.reduce((acc, m) => acc + m.requests, 0);
      const sumSaved = models.reduce((acc, m) => acc + m.saved_tokens, 0);
      const sumRaw = models.reduce((acc, m) => acc + m.raw_saved_tokens, 0);
      const sumUsd = models.reduce((acc, m) => acc + m.saved_usd, 0);
      expect(sumReq).toBe(stats.requests);
      expect(sumSaved).toBe(stats.saved_input_tokens);
      expect(sumRaw).toBe(stats.raw_saved_tokens);
      expect(sumUsd).toBeCloseTo(stats.saved_usd, 4);
      // Event 1 cliffUsd (0.42) minus Event 2 bust (-0.0875) -> ~0.3325 (not double counted)
      expect(stats.cliff_saved_usd).toBeCloseTo(0.42, 4);
      expect(stats.saved_usd).toBeLessThan(0.42);
      expect(stats.saved_usd).toBeGreaterThan(0.30);

      // Verify Anthropic branch outputEquiv uses resolvePriceRates(model).output instead of hardcoded 5.0
      process.env.FICHE_GPT_PROFILES = JSON.stringify({ 'claude-fable-5': { outputRate: 3 } });
      setAllowedModelBases(['claude-fable-5']);
      const dashCustomOut = new DashboardState();
      dashCustomOut.update({
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        durationMs: 10,
        usage: { input_tokens: 1_000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        info: { compressed: true, baselineTokens: 2_000, baselineCacheableTokens: 1_500, baselineProbeStatus: 'ok' },
      } as never);
      const customOutStats = (await dashCustomOut.serveStats().json()) as StatsPayload;
      expect(customOutStats.output_weighted).toBe(300);
    });

    it('tracks Google warmth and Anthropic text-hygiene self-busts, enforces true LRU and <=256 model cap', async () => {
      process.env.FICHE_PRICES = 'kosha';
      setAllowedModelBases(['gemini', 'claude-opus-5-5', 'claude-fable-5']);
      const dash = new DashboardState();

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
        // Google self-bust across two turns in same session
        dash.update({
          method: 'POST',
          path: '/v1beta/models/gemini-3.6-flash:generateContent',
          model: 'gemini-3.6-flash',
          accountingProvider: 'google',
          status: 200,
          durationMs: 100,
          usage: { input_tokens: 20_000, output_tokens: 10, cached_tokens: 18_000 },
          info: {
            compressed: true,
            firstUserSha8: 'gsess',
            systemSha8: 'gsys',
            cachePrefixSha8: 'gpx1',
            baselineTokens: 25_000,
            baselineProbeStatus: 'ok',
          },
        } as never);
        vi.setSystemTime(new Date('2026-11-25T10:00:10Z'));
        dash.update({
          method: 'POST',
          path: '/v1beta/models/gemini-3.6-flash:generateContent',
          model: 'gemini-3.6-flash',
          accountingProvider: 'google',
          status: 200,
          durationMs: 100,
          usage: { input_tokens: 20_000, output_tokens: 10, cached_tokens: 0 }, // busted!
          info: {
            compressed: true,
            firstUserSha8: 'gsess',
            systemSha8: 'gsys',
            cachePrefixSha8: 'gpx2',
            baselineTokens: 25_000,
            baselineProbeStatus: 'ok',
          },
        } as never);

        // Anthropic text-hygiene self-bust: must NOT credit +hygieneTok*1.25
        vi.setSystemTime(new Date('2026-11-25T10:01:00Z'));
        dash.update({
          method: 'POST',
          path: '/v1/messages',
          model: 'claude-opus-5-5',
          status: 200,
          durationMs: 100,
          usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 },
          info: {
            compressed: true,
            imageCount: 0,
            textHygieneSavedTokens: 500,
            firstUserSha8: 'asess',
            systemSha8: 'asys',
            cachePrefixSha8: 'apx1',
          },
        } as never);
        vi.setSystemTime(new Date('2026-11-25T10:01:10Z'));
        dash.update({
          method: 'POST',
          path: '/v1/messages',
          model: 'claude-opus-5-5',
          status: 200,
          durationMs: 100,
          usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000 },
          info: {
            compressed: true,
            imageCount: 0,
            textHygieneSavedTokens: 500,
            firstUserSha8: 'asess',
            systemSha8: 'asys',
            cachePrefixSha8: 'apx2',
          },
        } as never);
      } finally {
        vi.useRealTimers();
      }

      const recent = (await dash.serveRecent().json()) as { recent: Array<{ session_saved_so_far_delta?: number }> };
      // Google turn 2 self-bust must be negative (18000*readRate + 7000 - 20000 < 0)
      expect(recent.recent[1]!.session_saved_so_far_delta!).toBeLessThan(0);
      // Anthropic text-hygiene turn 2 self-bust must be negative
      expect(recent.recent[3]!.session_saved_so_far_delta!).toBeLessThan(0);

      // True LRU for sessions: keep 'pinned-lru' alive by reading it via serveCurrentSessionJson / update
      const lruDash = new DashboardState();
      lruDash.update({
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        durationMs: 10,
        usage: { input_tokens: 100, output_tokens: 10 },
        info: { compressed: true, baselineTokens: 500, baselineCacheableTokens: 400, baselineProbeStatus: 'ok', firstUserSha8: 'pinned-lru' },
      } as never);
      for (let i = 0; i < 45; i++) {
        lruDash.update({
          method: 'POST',
          path: '/v1/messages',
          model: 'claude-fable-5',
          status: 200,
          durationMs: 10,
          usage: { input_tokens: 100, output_tokens: 10 },
          info: { compressed: true, baselineTokens: 500, baselineCacheableTokens: 400, baselineProbeStatus: 'ok', firstUserSha8: `other-${i}` },
        } as never);
      }
      // Refresh 'pinned-lru'
      lruDash.update({
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        durationMs: 10,
        usage: { input_tokens: 100, output_tokens: 10 },
        info: { compressed: true, baselineTokens: 500, baselineCacheableTokens: 400, baselineProbeStatus: 'ok', firstUserSha8: 'pinned-lru' },
      } as never);
      // Push 10 more sessions so oldest un-refreshed ('other-0'..) evict, while 'pinned-lru' survives
      for (let i = 45; i < 55; i++) {
        lruDash.update({
          method: 'POST',
          path: '/v1/messages',
          model: 'claude-fable-5',
          status: 200,
          durationMs: 10,
          usage: { input_tokens: 100, output_tokens: 10 },
          info: { compressed: true, baselineTokens: 500, baselineCacheableTokens: 400, baselineProbeStatus: 'ok', firstUserSha8: `other-${i}` },
        } as never);
      }
      // Switch currentSessionId back via one more call — 'pinned-lru' should still have 2+ requests accumulated (not evicted!)
      lruDash.update({
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        durationMs: 10,
        usage: { input_tokens: 100, output_tokens: 10 },
        info: { compressed: true, baselineTokens: 500, baselineCacheableTokens: 400, baselineProbeStatus: 'ok', firstUserSha8: 'pinned-lru' },
      } as never);
      const curSess = (await lruDash.serveCurrentSessionJson().json()) as { baselineMeasuredCount: number };
      expect(curSess.baselineMeasuredCount).toBe(3);

      // <= 256 model cap with 'other' rollup
      const capDash = new DashboardState();
      for (let i = 0; i < 280; i++) {
        capDash.update({
          method: 'POST',
          path: '/v1/messages',
          model: `claude-fable-5-v${i}`,
          status: 200,
          durationMs: 1,
          usage: { input_tokens: 10, output_tokens: 1 },
          info: { compressed: true, baselineTokens: 50, baselineCacheableTokens: 40, baselineProbeStatus: 'ok' },
        } as never);
      }
      const capStats = (await capDash.serveStats().json()) as StatsPayload;
      const keys = Object.keys(capStats.by_model ?? {});
      expect(keys.length).toBeLessThanOrEqual(256);
      expect(capStats.by_model?.['other']).toBeDefined();
      expect(capStats.requests).toBe(280);
      expect(keys.reduce((s, k) => s + capStats.by_model![k]!.requests, 0)).toBe(280);
    });

    it('serves CORP/nosniff/no-store headers on servePng/jsonResponse, canonical catalog on /api/models, and caches stats/sessions/claudeCodeMap', async () => {
      process.env.FICHE_PRICES = 'kosha';
      setCalibratedProfile({
        model: 'grok-4.6',
        band: 'jetbrains-mono-14',
        cols: 120,
        maxHeightPx: 4096,
        calibratedAtIso: '2026-11-25T10:00:00Z',
        source: 'probe',
        scores: { hexScore: 1, codeScore: 1, numScore: 1, guardScore: 1, overallScore: 1, passed: true },
      });

      const dir = mkTmpDir();
      const eventsFile = path.join(dir, 'events.jsonl');
      const sidecarDir = path.join(dir, '4xx-bodies');
      const paths: SessionsPaths = { eventsFile, sidecarDir };
      const ccRoot = path.join(dir, 'claude-projects');
      const projDir = path.join(ccRoot, '-tmp-demo');
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, 'sess1.jsonl'),
        JSON.stringify({ type: 'user', message: { content: 'hello track c' } }) + '\n',
      );
      fs.writeFileSync(
        eventsFile,
        JSON.stringify({
          ts: '2026-11-25T10:00:00.000Z',
          method: 'POST',
          path: '/v1/messages',
          model: 'claude-fable-5',
          status: 200,
          duration_ms: 50,
          compressed: true,
          input_tokens: 100,
          first_user_sha8: 'abc12345',
        }) + '\n',
      );

      let ccCalls = 0;
      const dash = new DashboardState(paths, async () => {
        ccCalls++;
        return claudeCodeMap(ccRoot);
      });
      dash.captureImage({
        imagePngs: [new Uint8Array([137, 80, 78, 71])],
        imageDims: [{ width: 10, height: 10 }],
      } as never);

      const pngRes = dash.servePng();
      expect(pngRes.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(pngRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(pngRes.headers.get('cache-control')).toBe('no-store');

      const modelsRes = dash.serveModels();
      expect(modelsRes.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(modelsRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(modelsRes.headers.get('cache-control')).toBe('no-store');
      const modelsBody = (await modelsRes.json()) as {
        models: string[];
        allowed_models: string[];
        catalog: Array<{ id: string; label: string; family: string; engine_mode: string }>;
      };
      expect(modelsBody.allowed_models).toEqual(modelsBody.models);
      const fable = modelsBody.catalog.find((m) => m.id === 'claude-fable-5');
      const opus55 = modelsBody.catalog.find((m) => m.id === 'claude-opus-5-5');
      const grokCal = modelsBody.catalog.find((m) => m.id === 'grok-4.6');
      expect(fable?.engine_mode).toBe('hybrid');
      expect(opus55?.engine_mode).toBe('text');
      expect(grokCal?.engine_mode).toBe('optical');

      // Singleflight + mtime/size/ino cache on /api/stats.json, /api/sessions.json & claudeCodeMap
      const [st1, st2] = await Promise.all([dash.serveApiStats(), dash.serveApiStats()]);
      expect(((await st1.json()) as { parsed: number }).parsed).toBe(1);
      expect(((await st2.json()) as { parsed: number }).parsed).toBe(1);

      const [se1, se2, cc1, cc2] = await Promise.all([
        dash.serveSessionsJson(),
        dash.serveSessionsJson(),
        claudeCodeMap(ccRoot),
        claudeCodeMap(ccRoot),
      ]);
      expect(((await se1.json()) as { count: number }).count).toBe(1);
      expect(((await se2.json()) as { count: number }).count).toBe(1);
      expect(ccCalls).toBe(2);
      expect(cc1.size).toBe(1);
      expect(cc2.size).toBe(1);

      // Appending invalidates stat sig
      fs.appendFileSync(
        eventsFile,
        JSON.stringify({
          ts: '2026-11-25T10:01:00.000Z',
          method: 'POST',
          path: '/v1/messages',
          model: 'claude-fable-5',
          status: 200,
          duration_ms: 50,
          compressed: true,
          input_tokens: 100,
          first_user_sha8: 'def67890',
        }) + '\n',
      );
      const st3 = (await (await dash.serveApiStats()).json()) as { parsed: number };
      expect(st3.parsed).toBe(2);

      // Prune uses O_EXCL/O_NOFOLLOW + 0o600
      await prune(paths, { sessionId: 'abc12345', force: true });
      expect(fs.statSync(eventsFile).mode & 0o777).toBe(0o600);
    });
  });

  // =========================================================================
  // 4. mcp/server.ts & core/request-transform.ts
  // =========================================================================
  describe('MCP & request-transform routing parity, signed stats, combined mmu_stats & UTF-8 framing', () => {
    it('transformAnyRequest honors FICHE_MODELS scope, textHygiene mode, forceImages, and calibrated profiles', async () => {
      const repetitive = JSON.stringify({
        rows: Array.from({ length: 40 }, (_, i) => ({ id: i, svc: 'auth', ok: true, msg: 'line' })),
      });
      const solBody = enc.encode(JSON.stringify({
        model: 'gpt-5.6-sol',
        instructions: 'You are a helpful coding assistant. '.repeat(250),
        input: [{ role: 'user', content: 'hi' }],
      }));
      // Out of scope (default scope = claude-fable-5, gemini): gpt-5.6-sol must NOT image
      const outScope = await transformAnyRequest(solBody, { model: 'gpt-5.6-sol', wire: 'responses' });
      expect(outScope.report.readerTier).toBe('text');
      expect(outScope.report.imaged).toBe(false);

      // textHygiene: 'off' disables text hygiene
      const opusBody = enc.encode(JSON.stringify({
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: repetitive }] }],
      }));
      const hygOff = await transformAnyRequest(opusBody, {
        model: 'claude-opus-5-5',
        wire: 'anthropic',
        textHygiene: 'off',
      });
      expect(hygOff.report.textCompressed).toBeUndefined();
      expect(hygOff.body).toBe(opusBody);

      // Out-of-scope model with forceImages=true still does NOT image
      const forcedOut = await transformAnyRequest(opusBody, {
        model: 'claude-opus-5-5',
        wire: 'anthropic',
        forceImages: true,
        charsPerToken: 1,
        minCompressChars: 1,
      });
      expect(forcedOut.report.imaged).toBe(false);

      // Calibrated profile promotes grok-4.6 when in scope
      setAllowedModelBases(['grok-4.6']);
      setCalibratedProfile({
        model: 'grok-4.6',
        band: 'jetbrains-mono-14',
        cols: 120,
        maxHeightPx: 4096,
        calibratedAtIso: '2026-11-25T10:00:00Z',
        source: 'probe',
        scores: { hexScore: 1, codeScore: 1, numScore: 1, guardScore: 1, overallScore: 1, passed: true },
      });
      const grokBody = enc.encode(JSON.stringify({
        model: 'grok-4.6',
        messages: [
          { role: 'system', content: 'System prompt '.repeat(300) },
          { role: 'user', content: 'hi' },
        ],
      }));
      const grokRes = await transformAnyRequest(grokBody, {
        model: 'grok-4.6',
        wire: 'chat',
        charsPerToken: 1,
        minCompressChars: 1,
      });
      expect(grokRes.report.readerTier).toBe('image');
    });

    it('check_model queries live daemon /api/models and falls back to FICHE_CONFIG config.json', async () => {
      const daemon = createNodeHttpServer((req, res) => {
        if (req.url === '/api/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            allowed_models: ['gpt-5.6-sol'],
            compression_enabled: true,
            catalog: [{ id: 'gpt-5.6-sol', engine_mode: 'optical' }],
          }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', () => resolve()));
      try {
        process.env.PORT = String((daemon.address() as net.AddressInfo).port);
        const res = (await handleMcpMessage({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'check_model', arguments: { model: 'gpt-5.6-sol' } },
        })) as { result: { structuredContent: { inScope: boolean; readerTier: string; scopeSource: string } } };
        expect(res.result.structuredContent.inScope).toBe(true);
        expect(res.result.structuredContent.readerTier).toBe('image');
        expect(res.result.structuredContent.scopeSource).toBe('daemon');
      } finally {
        await new Promise<void>((resolve) => daemon.close(() => resolve()));
      }

      // Fallback to config.json when daemon unreachable
      process.env.PORT = String(await reserveUnusedPort());
      const dir = mkTmpDir();
      const cfgPath = path.join(dir, 'config.json');
      fs.writeFileSync(cfgPath, JSON.stringify({ models: ['gpt-6.1-sol'] }));
      process.env.FICHE_CONFIG = cfgPath;
      const cfgRes = (await handleMcpMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'check_model', arguments: { model: 'gpt-6.1-sol' } },
      })) as { result: { structuredContent: { inScope: boolean; scopeSource: string } } };
      expect(cfgRes.result.structuredContent.inScope).toBe(true);
      expect(cfgRes.result.structuredContent.scopeSource).toBe('config');
    });

    it('mmu_stats combines local + daemon without shadowing live daemon, and stats accumulates signed tokensSaved', async () => {
      const store = getGlobalMmuStore();
      store.storePage({
        sessionKey: 'local-s',
        refId: 'a.ts',
        toolName: 'Read',
        rawText: 'export const x = 1;\nexport const y = 2;\n',
      });

      const daemon = createNodeHttpServer((req, res) => {
        if ((req.url ?? '').startsWith('/api/mmu/stats')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            stats: { pagesStored: 10, derefHits: 3 },
            pageCount: 10,
            pages: [{ id: 'pg_daemon1', refId: 'daemon.ts' }],
          }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', () => resolve()));
      try {
        process.env.PORT = String((daemon.address() as net.AddressInfo).port);
        const mmuRes = (await handleMcpMessage({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'mmu_stats', arguments: {} },
        })) as {
          result: {
            structuredContent: {
              source: string;
              pageCount: number;
              stats: { pagesStored: number };
              local: { pageCount: number };
              daemon: { pageCount: number };
            };
          };
        };
        expect(mmuRes.result.structuredContent.source).toBe('combined');
        expect(mmuRes.result.structuredContent.pageCount).toBe(11);
        expect(mmuRes.result.structuredContent.stats.pagesStored).toBeGreaterThanOrEqual(11);
        expect(mmuRes.result.structuredContent.local.pageCount).toBe(1);
        expect(mmuRes.result.structuredContent.daemon.pageCount).toBe(10);
      } finally {
        await new Promise<void>((resolve) => daemon.close(() => resolve()));
      }

      // Signed tokensSaved in MCP stats when transform_request expands tokens (negative savedVsOriginal)
      process.env.PORT = String(await reserveUnusedPort());
      setAllowedModelBases(['claude-fable-5']);
      // First record a positive transform
      const positiveReq = {
        model: 'claude-fable-5',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: JSON.stringify({
                  rows: Array.from({ length: 40 }, (_, i) => ({ id: i, svc: 'auth', ok: true, msg: 'line' })),
                }),
              },
            ],
          },
        ],
      };
      const posRes = (await handleMcpMessage({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'transform_request', arguments: { request: positiveReq } },
      })) as { result: { structuredContent: { report: { savedVsOriginal: number } } } };
      const posSaved = posRes.result.structuredContent.report.savedVsOriginal;
      expect(posSaved).toBeGreaterThan(0);

      // Next send a sparse whitespace-heavy payload where forced imaging costs more vision tokens than o200k text tokens -> negative savedVsOriginal!
      const sparseLine = `${' '.repeat(40)}x\n`;
      const smallExpandReq = {
        model: 'claude-fable-5',
        system: sparseLine.repeat(60),
        messages: [{ role: 'user', content: 'hi' }],
      };
      const negRes = (await handleMcpMessage({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'transform_request', arguments: { request: smallExpandReq, forceImages: true } },
      })) as { result: { structuredContent: { report: { savedVsOriginal: number } } } };
      const negSaved = negRes.result.structuredContent.report.savedVsOriginal;
      expect(negSaved).toBeLessThan(0);

      const statRes = (await handleMcpMessage({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'stats', arguments: {} },
      })) as { result: { structuredContent: { tokensSaved: number } } };
      expect(statRes.result.structuredContent.tokensSaved).toBe(posSaved + negSaved);
    });

    it('pushMcpChunk enforces UTF-8 Buffer.byteLength and drains oversized LSP frames cleanly', () => {
      // Multi-byte UTF-8 line: 3M * 3 bytes = 9 MB > MCP_MAX_BYTES (8 MB), even though string.length < 8M!
      const cjk = '中'.repeat(3_000_000);
      const utf8Msgs: unknown[] = [];
      const onUtf8 = (m: unknown) => utf8Msgs.push(m);
      const rest1 = pushMcpChunk('', cjk, onUtf8);
      expect(rest1).toBe('');
      expect(JSON.stringify(utf8Msgs[0])).toContain('message exceeds');
      // Finish draining that oversized line and send a valid frame next
      const rest2 = pushMcpChunk(rest1, 'trailing\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n', onUtf8);
      expect(rest2).toBe('');
      expect(utf8Msgs).toHaveLength(2);
      expect(utf8Msgs[1]).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });

      // Oversized Content-Length frame arriving across 2 chunks drains cleanly and parses next LSP frame
      const lspMsgs: Array<{ msg: unknown; framed: boolean }> = [];
      const onLsp = (msg: unknown, framed: boolean) => lspMsgs.push({ msg, framed });
      const bigLen = MCP_MAX_BYTES + 10;
      const half = Math.floor(bigLen / 2);
      let buf = pushMcpChunk('', `Content-Length: ${bigLen}\r\n\r\n` + 'a'.repeat(half), onLsp);
      expect(buf).toBe('');
      expect(lspMsgs).toHaveLength(1);
      expect((lspMsgs[0]!.msg as { error?: { code: number } }).error?.code).toBe(-32600);

      const ping = '{"jsonrpc":"2.0","id":2,"method":"ping"}';
      buf = pushMcpChunk(
        buf,
        'a'.repeat(bigLen - half) + `Content-Length: ${Buffer.byteLength(ping, 'utf8')}\r\n\r\n${ping}`,
        onLsp,
      );
      expect(buf).toBe('');
      expect(lspMsgs).toHaveLength(2);
      expect(lspMsgs[1]).toEqual({ msg: { jsonrpc: '2.0', id: 2, method: 'ping' }, framed: true });
    });
  });
});
