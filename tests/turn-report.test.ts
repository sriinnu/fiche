import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { createProxy } from '../src/core/proxy.js';
import { toTrackEvent, type TrackEvent } from '../src/core/tracker.js';
import { handleMcpMessage, resetMcpStatsForTests } from '../src/mcp/server.js';
import {
  computeTurnSnapshot,
  formatAgyHookJson,
  formatClaudeStatusLine,
  formatCliLine,
  readTurnReport,
  runTurnReportCli,
} from '../src/turn-report.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('per-turn savings telemetry, proxy headers, MCP live stats & plugin hook', () => {
  const savedLog = process.env.INKLING_LOG;
  const savedFicheLog = process.env.FICHE_LOG;
  const savedPrices = process.env.INKLING_PRICES;
  const savedFichePrices = process.env.FICHE_PRICES;
  const savedFetch = globalThis.fetch;
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-turn-report-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    if (savedLog === undefined) delete process.env.INKLING_LOG;
    else process.env.INKLING_LOG = savedLog;
    if (savedFicheLog === undefined) delete process.env.FICHE_LOG;
    else process.env.FICHE_LOG = savedFicheLog;
    if (savedPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = savedPrices;
    if (savedFichePrices === undefined) delete process.env.FICHE_PRICES;
    else process.env.FICHE_PRICES = savedFichePrices;
    globalThis.fetch = savedFetch;
    setAllowedModelBases(null);
    resetMcpStatsForTests();
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('computes turn & session rollups across text-only (gpt-6-astra / gemini-4-neon) and imaged models and deduplicates via cursor', () => {
    process.env.INKLING_PRICES = 'kosha';
    const dir = makeTmpDir();
    const eventsFile = path.join(dir, 'events.jsonl');
    const cursorFile = path.join(dir, 'cursor.json');

    const rows: TrackEvent[] = [
      {
        ts: '2026-11-20T12:00:00.000Z',
        method: 'POST',
        path: '/v1/messages/count_tokens',
        model: 'claude-fable-5',
        status: 200,
        duration_ms: 15,
      },
      {
        ts: '2026-11-20T12:01:00.000Z',
        method: 'POST',
        path: '/v1/responses',
        model: 'gpt-6-astra',
        accounting_provider: 'openai',
        status: 200,
        duration_ms: 420,
        compressed: false,
        text_hygiene_saved_tokens: 4200,
        text_hygiene_stages: ['tscg', 'toon'],
        input_tokens: 18_000,
        cached_tokens: 16_200,
        first_user_sha8: 'sess1111',
      },
      {
        ts: '2026-11-20T12:02:00.000Z',
        method: 'POST',
        path: '/v1/responses',
        model: 'gpt-6-astra',
        accounting_provider: 'openai',
        status: 200,
        duration_ms: 510,
        compressed: false,
        text_hygiene_saved_tokens: 9800,
        text_hygiene_stages: ['tscg', 'casi_delta', 'acdc_epoch'],
        cliff_avoided_at: 272_000,
        cliff_saved_usd: 0.125,
        input_tokens: 20_000,
        cached_tokens: 18_800,
        first_user_sha8: 'sess1111',
      },
      {
        ts: '2026-11-20T12:03:00.000Z',
        method: 'POST',
        path: '/v1beta/models/gemini-4-neon:generateContent',
        model: 'gemini-4-neon',
        accounting_provider: 'google',
        status: 200,
        duration_ms: 300,
        compressed: false,
        text_hygiene_saved_tokens: 6100,
        text_hygiene_stages: ['tscg', 'casi_dup'],
        input_tokens: 20_000,
        cached_tokens: 18_000,
        first_user_sha8: 'sess2222',
      },
    ];
    fs.writeFileSync(eventsFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // Verify Astra snapshot directly
    const astraSnap = computeTurnSnapshot(rows[2]!);
    expect(astraSnap.savedTokens).toBe(9800);
    expect(astraSnap.cacheHitPct).toBe(94);
    expect(astraSnap.savedUsd).toBeCloseTo(0.125, 6);
    expect(astraSnap.cliffAvoidedAt).toBe(272_000);
    expect(astraSnap.stages).toEqual(['tscg', 'casi_delta', 'acdc_epoch']);

    // Verify Gemini 4 Neon (latest row, unpriced model still reports tokens + cache cleanly)
    const first = readTurnReport(eventsFile, { cursorFile, updateCursor: true });
    expect(first.hasNewTurn).toBe(true);
    expect(first.lastTurn?.model).toBe('gemini-4-neon');
    expect(first.lastTurn?.savedTokens).toBe(6100);
    expect(first.lastTurn?.cacheHitPct).toBe(90);
    expect(first.lastTurn?.savedUsd).toBe(0);
    expect(first.session.turns).toBe(1);

    const agy1 = formatAgyHookJson(first) as {
      injectSteps?: Array<{ systemMessage?: { systemMessage?: string; metadata?: { user_markdown?: string } } }>;
    };
    expect(agy1.injectSteps).toHaveLength(1);
    expect(agy1.injectSteps![0]!.systemMessage!.systemMessage).toBe('');
    const md = agy1.injectSteps![0]!.systemMessage!.metadata!.user_markdown!;
    expect(md).toContain('gemini-4-neon');
    expect(md).toContain('6.10k tok');
    expect(md).toContain('tscg+casi_dup');

    // Second read with same cursor reports hasNewTurn=false and produces {} for AGY hook
    const second = readTurnReport(eventsFile, { cursorFile, updateCursor: true });
    expect(second.hasNewTurn).toBe(false);
    expect(formatAgyHookJson(second)).toEqual({});

    expect(formatClaudeStatusLine(first)).toContain('gemini-4-neon -6.10k tok | 90% cache');
    expect(formatCliLine(first)).toContain('tscg+casi_dup');

    // CLI runner handles json and unknown option cleanly
    const cliOk = runTurnReportCli(['--format=json', '--file', eventsFile], eventsFile);
    expect(cliOk.code).toBe(0);
    expect(JSON.parse(cliOk.out).lastTurn.model).toBe('gemini-4-neon');
    expect(runTurnReportCli(['--bad-flag'], eventsFile).code).toBe(2);
  });

  it('persists text_hygiene_stages in TrackEvent and emits x-fiche-* downstream proxy headers', async () => {
    setAllowedModelBases(['gpt-6-astra']);
    const sharedDesc =
      'Strict workspace validation rule: verify files on disk before proposing edits, inspect full surrounding context carefully, preserve formatting conventions cleanly, and confirm all tests pass after edits.';
    const tools = Array.from({ length: 6 }, (_, i) => ({
      type: 'function',
      name: `tool_${i}`,
      description: `${sharedDesc}\n\nExecutes step ${i}.\n----------------`,
      parameters: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { path: { type: 'string', title: 'Path', description: sharedDesc } },
        additionalProperties: false,
      },
    }));
    const bigTabular = JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({
        id: i,
        service: 'billing-worker',
        status: 'healthy',
        latencyMs: 14 + (i % 10),
        cached: i % 2 === 0,
      })),
      null,
      2,
    );

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'gpt-6-astra',
          usage: {
            input_tokens: 1500,
            input_tokens_details: { cached_tokens: 1200 },
            output_tokens: 20,
          },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const capturedEvents: TrackEvent[] = [];
    const proxy = createProxy({
      passthroughOpenAIUpstream: 'https://openai.test',
      transform: {},
      onRequest: (e) => {
        capturedEvents.push(toTrackEvent(e));
      },
    });

    const reqBody = {
      model: 'gpt-6-astra',
      tools,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check cluster' }] },
        { type: 'function_call', call_id: 'call_1', name: 'tool_0', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: bigTabular },
      ],
    };

    const res = await proxy(
      new Request('http://127.0.0.1/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-example' },
        body: JSON.stringify(reqBody),
      }),
    );

    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 20));

    const savedHdr = Number(res.headers.get('x-fiche-saved-tokens'));
    const stagesHdr = res.headers.get('x-fiche-stages') ?? '';
    expect(savedHdr).toBeGreaterThan(200);
    expect(stagesHdr).toContain('tscg');
    expect(stagesHdr).toContain('toon');

    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]!.text_hygiene_stages).toContain('tscg');
    expect(capturedEvents[0]!.text_hygiene_stages).toContain('toon');
  });

  it('surfaces live proxy stats via fiche-mcp stats & textEngine via check_model', async () => {
    process.env.FICHE_PRICES = 'kosha';
    const dir = makeTmpDir();
    const logPath = path.join(dir, 'events.jsonl');
    process.env.FICHE_LOG = logPath;

    const sample: TrackEvent = {
      ts: '2026-11-20T12:10:00.000Z',
      method: 'POST',
      path: '/v1/responses',
      model: 'gpt-6-astra',
      accounting_provider: 'openai',
      status: 200,
      duration_ms: 210,
      text_hygiene_saved_tokens: 7500,
      text_hygiene_stages: ['tscg', 'toon', 'casi_delta'],
      input_tokens: 10_000,
      cached_tokens: 9000,
      first_user_sha8: 'abcd1234',
    };
    fs.writeFileSync(logPath, JSON.stringify(sample) + '\n');

    const statRes = (await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'stats', arguments: {} },
    })) as {
      result: {
        structuredContent: {
          calls: number;
          proxy: { lastTurn: { model: string; savedTokens: number }; session: { turns: number; savedTokens: number } };
        };
      };
    };

    expect(statRes.result.structuredContent.calls).toBe(1);
    expect(statRes.result.structuredContent.proxy.lastTurn.model).toBe('gpt-6-astra');
    expect(statRes.result.structuredContent.proxy.lastTurn.savedTokens).toBe(7500);
    expect(statRes.result.structuredContent.proxy.session.turns).toBe(1);

    const checkRes = (await handleMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'check_model', arguments: { model: 'gpt-6-astra' } },
    })) as {
      result: { structuredContent: { readerTier: string; textEngine: string } };
    };
    expect(checkRes.result.structuredContent.readerTier).toBe('text');
    expect(checkRes.result.structuredContent.textEngine).toBe('TSCG+TOON+CASI+ACDC');
  });

  it('executes Antigravity PostInvocation hook script end-to-end with 0 LLM tokens and cursor dedup', () => {
    const dir = makeTmpDir();
    const eventsFile = path.join(dir, 'events.jsonl');
    const pluginDataDir = path.join(dir, 'plugin-data');
    const distMod = path.join(repoRoot, 'dist', 'turn-report.js');
    expect(fs.existsSync(distMod)).toBe(true);

    const ev: TrackEvent = {
      ts: '2026-11-20T12:15:00.000Z',
      method: 'POST',
      path: '/v1/responses',
      model: 'gpt-6.2-astra',
      accounting_provider: 'openai',
      status: 200,
      duration_ms: 180,
      text_hygiene_saved_tokens: 14_200,
      text_hygiene_stages: ['tscg', 'toon', 'casi_delta', 'acdc_epoch'],
      input_tokens: 20_000,
      cached_tokens: 18_800,
      first_user_sha8: 'hook1234',
    };
    fs.writeFileSync(eventsFile, JSON.stringify(ev) + '\n');

    const hookScript = path.join(repoRoot, 'plugins', 'fiche-companion', 'scripts', 'post-invocation.mjs');
    const hookEnv = {
      ...process.env,
      FICHE_LOG: eventsFile,
      PLUGIN_DATA: pluginDataDir,
      FICHE_PRICES: 'kosha',
    };

    const run1 = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify({ conversationId: 'conv-42' }),
      encoding: 'utf8',
      env: hookEnv,
    });
    expect(run1.status).toBe(0);
    const out1 = JSON.parse(run1.stdout) as {
      injectSteps?: Array<{ systemMessage?: { systemMessage?: string; metadata?: { user_markdown?: string } } }>;
    };
    expect(out1.injectSteps).toHaveLength(1);
    expect(out1.injectSteps![0]!.systemMessage!.systemMessage).toBe('');
    expect(out1.injectSteps![0]!.systemMessage!.metadata!.user_markdown).toContain('gpt-6.2-astra');
    expect(out1.injectSteps![0]!.systemMessage!.metadata!.user_markdown).toContain('14.2k tok');

    // Legacy INKLING_LOG alias also resolves in the plugin script when FICHE_LOG is unset
    const legacyHookEnv = {
      ...process.env,
      INKLING_LOG: eventsFile,
      PLUGIN_DATA: path.join(dir, 'plugin-data-legacy'),
      INKLING_PRICES: 'kosha',
    };
    delete (legacyHookEnv as Record<string, string | undefined>).FICHE_LOG;
    delete (legacyHookEnv as Record<string, string | undefined>).FICHE_PRICES;
    const legacyRun = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify({ conversationId: 'conv-legacy' }),
      encoding: 'utf8',
      env: legacyHookEnv,
    });
    expect(legacyRun.status).toBe(0);
    const legacyOut = JSON.parse(legacyRun.stdout) as {
      injectSteps?: Array<{ systemMessage?: { metadata?: { user_markdown?: string } } }>;
    };
    expect(legacyOut.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown).toContain('gpt-6.2-astra');

    // Second invocation for the same turn returns {} (never duplicates)
    const run2 = spawnSync(process.execPath, [hookScript], {
      input: JSON.stringify({ conversationId: 'conv-42' }),
      encoding: 'utf8',
      env: hookEnv,
    });
    expect(run2.status).toBe(0);
    expect(JSON.parse(run2.stdout)).toEqual({});
  });
});
