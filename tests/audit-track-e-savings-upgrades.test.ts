import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { isUsableAnthropicBaselineProbe } from '../src/core/baseline.js';
import { foldMarkovianEpisodes, resetGlobalMmuStore } from '../src/core/context-mmu.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { createProxy } from '../src/core/proxy.js';
import {
  isSessionCacheCold,
  noteCacheOutcome,
  noteHistoryRequest,
  peekSessionState,
  resetSessionState,
} from '../src/core/session-state.js';
import { applyAnthropicTextHygiene, cleanToolOutput } from '../src/core/text-hygiene.js';
import { resetTextEpochStickyState } from '../src/core/text-history.js';
import { transformRequest } from '../src/core/transform.js';
import { DashboardState } from '../src/dashboard.js';
import { fold, newSummary } from '../src/stats.js';
import { computeTurnSnapshot } from '../src/turn-report.js';

const FAKE_ANTHROPIC_CRED = ['sk', 'ant', 'test', 'track', 'e'].join('-');
const FAKE_OPENAI_CRED = ['sk', 'proj', 'test', 'track', 'e'].join('-');

describe('Track E — Savings Upgrades, Cache Soundness & Accounting Fixes', () => {
  const savedPrices = process.env.INKLING_PRICES;
  const savedHygiene = process.env.INKLING_TEXT_HYGIENE;

  beforeEach(() => {
    resetSessionState();
    resetGlobalMmuStore();
    resetTextEpochStickyState();
    setAllowedModelBases(null);
    process.env.INKLING_PRICES = 'kosha';
    process.env.INKLING_TEXT_HYGIENE = 'on';
  });

  afterEach(() => {
    if (savedPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = savedPrices;
    if (savedHygiene === undefined) delete process.env.INKLING_TEXT_HYGIENE;
    else process.env.INKLING_TEXT_HYGIENE = savedHygiene;
    setAllowedModelBases(null);
    resetSessionState();
    resetGlobalMmuStore();
    resetTextEpochStickyState();
  });

  it('seals Stage-2 pruned blocks at the frontier so Turn-N replays identical bytes behind a 1h breakpoint (0 cache bust)', () => {
    const proseBlob = Array.from(
      { length: 200 },
      (_, i) =>
        `Paragraph ${i}: documentation note explaining configuration behavior across shard ${i % 11} with supplementary prose padding ${'w'.repeat(45)}.`,
    ).join('\n');

    // Turn 1: proseBlob enters at the uncached frontier (after system breakpoint).
    const turn1 = {
      model: 'claude-opus-5-5',
      system: [{ type: 'text', text: 'System prompt.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        { role: 'user', content: 'Analyze docs' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_frontier', name: 'web_fetch', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_frontier', content: proseBlob }] },
      ],
    };

    const s1 = applyAnthropicTextHygiene(turn1, {
      foldLogs: true,
      deepTextCompact: true,
      enableCasi: false,
      model: 'claude-opus-5-5',
      ttlSec: 3600,
      sessionKey: 'sess_stage2_monotonic',
      sessionCacheCold: false,
    });
    expect(s1.changed).toBe(true);
    expect(s1.stages).toContain('density_prune');
    const compressedAtFrontier = turn1.messages[2]!.content[0]!.content;
    expect(typeof compressedAtFrontier).toBe('string');
    expect((compressedAtFrontier as string).length).toBeLessThan(proseBlob.length * 0.7);
    expect(peekSessionState('sess_stage2_monotonic')?.sealedStage2SlotKeys?.length).toBeGreaterThan(0);

    // Turn 2: 150K+ tokens of downstream cached turns arrive with a trailing 1h breakpoint covering tu_frontier.
    // Even though downstreamTokens is now huge, tu_frontier MUST replay identical bytes instead of reverting!
    const hugeDownstream = 'word '.repeat(120_000);
    const turn2 = {
      model: 'claude-opus-5-5',
      system: [{ type: 'text', text: 'System prompt.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        { role: 'user', content: 'Analyze docs' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_frontier', name: 'web_fetch', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_frontier', content: proseBlob }] },
        { role: 'assistant', content: 'Got it.' },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: hugeDownstream,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          }],
        },
        { role: 'assistant', content: 'Ready.' },
        { role: 'user', content: 'Continue.' },
      ],
    };

    const s2 = applyAnthropicTextHygiene(turn2, {
      foldLogs: true,
      deepTextCompact: true,
      enableCasi: false,
      model: 'claude-opus-5-5',
      ttlSec: 3600,
      sessionKey: 'sess_stage2_monotonic',
      sessionCacheCold: false,
    });
    expect(s2.changed).toBe(true);
    expect(turn2.messages[2]!.content[0]!.content).toBe(compressedAtFrontier);
  });

  it('protects unsealed mid-prefix blocks covered by a warm 1h breakpoint across ansi/cr/log_fold/density_prune', () => {
    const noisyLog = Array.from(
      { length: 60 },
      (_, i) => `\x1b[32m2026-11-26T07:00:${String(i).padStart(2, '0')}Z INFO worker=${i % 3} processed batch_${i} in ${10 + i}ms\x1b[0m`,
    ).join('\n');
    const bigDownstream = 'token '.repeat(40_000);

    const req = {
      model: 'claude-opus-5-5',
      system: [{ type: 'text', text: 'System', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        { role: 'user', content: 'Run' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_mid', name: 'bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_mid', content: noisyLog }] },
        { role: 'assistant', content: 'Next' },
        { role: 'user', content: [{ type: 'text', text: bigDownstream, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'assistant', content: 'Ok' },
        { role: 'user', content: 'Done' },
      ],
    };

    const before = req.messages[2]!.content[0]!.content;
    const stats = applyAnthropicTextHygiene(req, {
      foldLogs: true,
      deepTextCompact: true,
      enableCasi: false,
      model: 'claude-opus-5-5',
      ttlSec: 3600,
      sessionKey: 'sess_unsealed_1h',
      sessionCacheCold: false,
    });

    expect(req.messages[2]!.content[0]!.content).toBe(before);
    expect(stats.changed).toBe(false);
  });

  it('refuses foldMarkovianEpisodes on warm 1h prefixes with large downstream cache for small savings, but folds when cold', () => {
    const stepText = (n: number) =>
      `src/app_${n}.ts\nFAIL tests/a_${n}.test.ts\nAssertionError: mismatch step=${n}\n` +
      'detail padding line '.repeat(80);
    const makeBlocks = () => {
      const vals = [stepText(1), stepText(2), stepText(3), 'PASS tests/a_final.test.ts (all 12 tests passed)'];
      return vals.map((raw, i) => {
        let cur = raw;
        return {
          msgIndex: i * 2 + 1,
          blockIndex: 0,
          refId: `m_${i}`,
          toolName: 'bash',
          getText: () => cur,
          setText: (next: string) => {
            cur = next;
          },
        };
      });
    };

    // Warm 1h with 150K downstream tokens and small ~4K savings -> blocked
    const warmBlocks = makeBlocks();
    const warmRes = foldMarkovianEpisodes({
      blocks: warmBlocks,
      totalMessages: 16,
      keepTailMessages: 4,
      sessionKey: 'markov_warm_1h',
      model: 'claude-opus-5-5',
      sessionCacheCold: false,
      ttlSec: 3600,
      msgTotalTokens: [100, 650, 20, 650, 20, 650, 20, 80, 150_000, 50, 50, 50, 50, 50, 50, 50],
      cacheBreakpoints: [{ msgIndex: 8, blockIndex: 0, ttlSec: 3600 }],
      totalPromptTokens: 152_500,
    });
    expect(warmRes.changed).toBe(false);

    // Cold session -> folds cleanly
    const coldBlocks = makeBlocks();
    const coldRes = foldMarkovianEpisodes({
      blocks: coldBlocks,
      totalMessages: 16,
      keepTailMessages: 4,
      sessionKey: 'markov_cold_1h',
      model: 'claude-opus-5-5',
      sessionCacheCold: true,
      ttlSec: 3600,
    });
    expect(coldRes.changed).toBe(true);
    expect(coldRes.foldedEpisodes).toBeGreaterThanOrEqual(1);
  });

  it('scopes noteCacheOutcome & markCacheDead per model so Haiku 0-cache calls never mark Opus cold', async () => {
    const proxy = createProxy({
      upstream: 'https://api.anthropic.com',
      transform: { compress: false },
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const parsed = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as { model?: string };
        if (parsed.model === 'claude-haiku-5-5') {
          return new Response(
            JSON.stringify({
              id: 'msg_h',
              type: 'message',
              role: 'assistant',
              model: 'claude-haiku-5-5',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input_tokens: 500, output_tokens: 10 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            id: 'msg_o',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 5, cache_read_input_tokens: 150_000, output_tokens: 20 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    const mkReq = (model: string) =>
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': FAKE_ANTHROPIC_CRED,
          'x-fiche-session-id': 'claude-code-scoped-e',
        },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'Shared thread anchor question' }],
        }),
      });

    // Establish Opus primary session & record warm history outcome
    noteHistoryRequest('scoped-s1', { model: 'claude-opus-5-5', nowMs: 1000 });
    noteCacheOutcome('scoped-s1', 150_000, 0, { model: 'claude-opus-5-5' });
    // Auxiliary Haiku reports 0 cache
    noteHistoryRequest('scoped-s1', { model: 'claude-haiku-5-5', nowMs: 2000 });
    noteCacheOutcome('scoped-s1', 0, 0, { model: 'claude-haiku-5-5' });

    expect(isSessionCacheCold('scoped-s1', { model: 'claude-opus-5-5', nowMs: 3000 })).toBe(false);

    // Live proxy check: Haiku response followed by Opus check via proxy
    const resH = await proxy(mkReq('claude-haiku-5-5'));
    await resH.text();
    const resO = await proxy(mkReq('claude-opus-5-5'));
    await resO.text();
    expect(resO.status).toBe(200);
  });

  it('applies dir_tree, lossless pretty-JSON minification, and passing/build log_fold compactors', () => {
    const files: string[] = [];
    for (let i = 0; i < 10; i++) files.push(`M packages/api/src/core/feature_alpha_module_part_${i}.ts`);
    for (let i = 0; i < 10; i++) files.push(`packages/worker/tests/unit/suite_regression_file_part_${i}.test.ts`);
    const dirListing = files.join('\n');
    const dirRes = cleanToolOutput(dirListing);
    expect(dirRes.changed).toBe(true);
    expect(dirRes.stages).toContain('dir_tree');
    expect(dirRes.text.length).toBeLessThan(dirListing.length * 0.82);
    expect(dirRes.text).toContain('M packages/api/src/core/:');
    expect(dirRes.text).toContain('packages/worker/tests/unit/:');
    for (let i = 0; i < 10; i++) {
      expect(dirRes.text).toContain(`feature_alpha_module_part_${i}.ts`);
      expect(dirRes.text).toContain(`suite_regression_file_part_${i}.test.ts`);
    }

    const nestedConfig = {
      project: 'fiche',
      settings: { retries: 3, timeoutMs: 30_000, flags: { alpha: true, beta: false, gamma: true } },
      nested: { a: { b: { c: 1, d: 2 } }, x: { y: { z: 'val' } } },
    };
    const prettyJson = JSON.stringify(nestedConfig, null, 2);
    const jsonRes = cleanToolOutput(prettyJson);
    expect(jsonRes.changed).toBe(true);
    expect(jsonRes.stages).toContain('json');
    expect(JSON.parse(jsonRes.text)).toEqual(nestedConfig);

    const testOutput = [
      'RUN v5.1.0 /workspace/app',
      ...Array.from({ length: 18 }, (_, i) => ` ✓ tests/unit/module_${i}_spec.test.ts (${10 + i}ms)`),
      ' ✗ tests/unit/broken_spec.test.ts > fails cleanly',
      'AssertionError: expected 1 to equal 2',
      ...Array.from({ length: 12 }, (_, i) => ` ✓ tests/integration/suite_${i}_spec.test.ts (${20 + i}ms)`),
      'Test Files  1 failed | 30 passed (31)',
    ].join('\n');
    const testRes = cleanToolOutput(testOutput);
    expect(testRes.changed).toBe(true);
    expect(testRes.stages).toContain('log_fold');
    expect(testRes.text).toContain('similar lines folded');
    expect(testRes.text).toContain('AssertionError: expected 1 to equal 2');
    expect(testRes.text).toContain('Test Files  1 failed | 30 passed (31)');
  });

  it('images large frontier tool outputs in hybrid mode on gpt-6.2-sol and claude-fable-5-2 deterministically', async () => {
    const bigToolText = Array.from(
      { length: 120 },
      (_, i) => `{"id":${i},"key":"val_${i}","payload":"${'abcdefghij'.repeat(6)}"}`,
    ).join('\n');
    const smallToolText = 'ok small tool output';
    const systemPrompt = 'You are an expert assistant. '.repeat(220);

    // 1. OpenAI Responses (gpt-6.2-sol -> hybrid mode): frontier call_big kept past lsm tail is imaged optically
    const makeResponsesBody = () =>
      new TextEncoder().encode(
        JSON.stringify({
          model: 'gpt-6.2-sol',
          instructions: systemPrompt,
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'Inspect outputs' }] },
            { type: 'function_call', call_id: 'call_small', name: 'bash', arguments: '{"cmd":"echo ok"}' },
            { type: 'function_call_output', call_id: 'call_small', output: smallToolText },
            { type: 'function_call', call_id: 'call_big', name: 'bash', arguments: '{"cmd":"cat big"}' },
            { type: 'function_call_output', call_id: 'call_big', output: bigToolText },
          ],
        }),
      );

    const oRes1 = await transformOpenAIResponses(makeResponsesBody(), {
      model: 'gpt-6.2-sol',
      compress: true,
      textHygiene: 'on',
      opticalMode: 'hybrid',
      compressToolResults: true,
      sessionKey: 'codex_hybrid_tool_opt',
    });
    const parsedO1 = JSON.parse(new TextDecoder().decode(oRes1.body)) as {
      input: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };
    expect(oRes1.info.compressed).toBe(true);
    expect(oRes1.info.textHygieneStages).toContain('hybrid_tool_optical');
    const bigOut1 = parsedO1.input.find((x) => x.type === 'function_call_output' && x.call_id === 'call_big')?.output;
    const smallOut1 = parsedO1.input.find((x) => x.type === 'function_call_output' && x.call_id === 'call_small')?.output;
    expect(Array.isArray(bigOut1)).toBe(true);
    expect((bigOut1 as Array<{ type?: string }>).some((p) => p.type === 'input_image')).toBe(true);
    expect(smallOut1).toBe(smallToolText);

    // Byte stability on turn 2 replay
    const oRes2 = await transformOpenAIResponses(makeResponsesBody(), {
      model: 'gpt-6.2-sol',
      compress: true,
      textHygiene: 'on',
      opticalMode: 'hybrid',
      compressToolResults: true,
      sessionKey: 'codex_hybrid_tool_opt',
    });
    expect(oRes2.info.cachePrefixSha8).toBe(oRes1.info.cachePrefixSha8);

    // 2. Anthropic hybrid model (claude-fable-5-2) images frontier tool_result, protects unsealed warm 1h mid-prefix
    const fableFrontierBody = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude-fable-5-2',
        max_tokens: 128,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [
          { role: 'user', content: 'Inspect frontier output' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tf1', name: 'bash', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tf1', content: bigToolText }] },
        ],
      }),
    );
    const fRes = await transformRequest(fableFrontierBody, {
      model: 'claude-fable-5-2',
      compress: true,
      textHygiene: 'on',
      opticalMode: 'hybrid',
      compressToolResults: true,
      sessionKey: 'fable_hybrid_frontier',
    });
    expect(fRes.info.compressed).toBe(true);
    expect(fRes.info.textHygieneStages).toContain('hybrid_tool_optical');
    expect(fRes.info.toolResultImgs ?? 0).toBeGreaterThan(0);

    // Unsealed mid-prefix 1h-covered tool_result is skipped on fresh session
    const fableMidPrefixBody = new TextEncoder().encode(
      JSON.stringify({
        model: 'claude-fable-5-2',
        max_tokens: 128,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [
          { role: 'user', content: 'Inspect mid prefix' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tm1', name: 'bash', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tm1', content: bigToolText }] },
          { role: 'assistant', content: 'Ok.' },
          { role: 'user', content: [{ type: 'text', text: 'w '.repeat(30_000), cache_control: { type: 'ephemeral', ttl: '1h' } }] },
          { role: 'assistant', content: 'Ack.' },
          { role: 'user', content: 'Next' },
        ],
      }),
    );
    const fMid = await transformRequest(fableMidPrefixBody, {
      model: 'claude-fable-5-2',
      compress: true,
      textHygiene: 'on',
      opticalMode: 'hybrid',
      compressToolResults: true,
      sessionKey: 'fable_hybrid_midprefix_unsealed',
    });
    expect(fMid.info.toolResultImgs ?? 0).toBe(0);
    expect(fMid.info.textHygieneStages ?? []).not.toContain('hybrid_tool_optical');
  });

  it('rejects partial and thread_continue Anthropic baseline probes across stats, turn-report, and dashboard without leaking baselineOpt', async () => {
    expect(
      isUsableAnthropicBaselineProbe({
        baselineTokens: 701,
        probeStatus: 'partial',
        threadContinue: true,
        cacheReadTokens: 162_000,
      }),
    ).toBe(false);
    expect(
      isUsableAnthropicBaselineProbe({
        baselineTokens: 5189,
        probeStatus: 'ok',
        threadContinue: false,
        cacheReadTokens: 252_218,
      }),
    ).toBe(false);
    expect(
      isUsableAnthropicBaselineProbe({
        baselineTokens: 193_368,
        probeStatus: 'ok',
        threadContinue: false,
        cacheReadTokens: 172_000,
      }),
    ).toBe(true);

    // 1. stats.ts fold() excludes legacy thread_continue delta probes from measured requests
    const s = newSummary();
    fold(s, {
      ts: '2026-11-26T00:00:00Z',
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      duration_ms: 500,
      model: 'claude-opus-5-5',
      accounting_provider: 'anthropic',
      compressed: true,
      reason: 'text_hygiene',
      text_hygiene_saved_tokens: 600,
      baseline_tokens: 5189,
      baseline_probe_status: 'ok',
      input_tokens: 2,
      cache_create_tokens: 1500,
      cache_read_tokens: 252_000,
      output_tokens: 100,
      orig_chars: 0,
      image_count: 0,
      image_bytes: 0,
      static_chars: 0,
      dynamic_chars: 0,
      dynamic_block_count: 0,
    });
    expect(s.baselineMeasuredEvents).toBe(0);
    expect(s.baselineTokensTotal).toBe(0);

    // 2. turn-report.ts does not produce -248K negative savedTokens on partial/legacy delta probe
    const snap = computeTurnSnapshot({
      ts: '2026-11-26T00:00:00Z',
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      duration_ms: 500,
      model: 'claude-opus-5-5',
      accounting_provider: 'anthropic',
      compressed: true,
      reason: 'text_hygiene',
      text_hygiene_saved_tokens: 600,
      baseline_tokens: 5189,
      baseline_probe_status: 'ok',
      input_tokens: 2,
      cache_create_tokens: 1500,
      cache_read_tokens: 252_000,
      output_tokens: 100,
      orig_chars: 0,
      image_count: 0,
      image_bytes: 0,
      static_chars: 0,
      dynamic_chars: 0,
      dynamic_block_count: 0,
    });
    expect(snap.savedTokens).toBe(600);
    expect(snap.savedUsd).toBeGreaterThanOrEqual(0);

    // 3. dashboard.ts replay() does not leak 701/5189 partial baselineOpt into rawSavedTokens or pricedSavedUsd
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-track-e-dash-'));
    const eventsPath = path.join(tmpDir, 'events.jsonl');
    try {
      const evs = [
        {
          ts: '2026-11-26T00:00:00Z',
          method: 'POST',
          path: '/v1/messages',
          status: 200,
          duration_ms: 500,
          model: 'claude-opus-5-5',
          accounting_provider: 'anthropic',
          compressed: true,
          reason: 'text_hygiene',
          text_hygiene_saved_tokens: 600,
          baseline_tokens: 701,
          baseline_cacheable_tokens: 701,
          baseline_probe_status: 'partial',
          thread_continue: true,
          input_tokens: 2,
          cache_create_tokens: 487,
          cache_read_tokens: 161_731,
          output_tokens: 100,
          orig_chars: 0,
          image_count: 0,
          image_bytes: 0,
          static_chars: 0,
          dynamic_chars: 0,
          dynamic_block_count: 0,
        },
        {
          ts: '2026-11-26T00:01:00Z',
          method: 'POST',
          path: '/v1/messages',
          status: 200,
          duration_ms: 500,
          model: 'claude-opus-5-5',
          accounting_provider: 'anthropic',
          compressed: true,
          reason: 'text_hygiene',
          text_hygiene_saved_tokens: 600,
          baseline_tokens: 5189,
          baseline_cacheable_tokens: 5189,
          baseline_probe_status: 'ok',
          input_tokens: 2,
          cache_create_tokens: 1500,
          cache_read_tokens: 252_000,
          output_tokens: 100,
          orig_chars: 0,
          image_count: 0,
          image_bytes: 0,
          static_chars: 0,
          dynamic_chars: 0,
          dynamic_block_count: 0,
        },
      ];
      fs.writeFileSync(eventsPath, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const dash = new DashboardState();
      await dash.replay(eventsPath);
      const statsJson = (await dash.serveStats().json()) as {
        raw_saved_tokens: number;
        saved_input_tokens: number;
        saved_usd: number;
      };
      expect(statsJson.raw_saved_tokens).toBe(1200);
      expect(statsJson.saved_input_tokens).toBeGreaterThanOrEqual(0);
      expect(statsJson.saved_usd).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
