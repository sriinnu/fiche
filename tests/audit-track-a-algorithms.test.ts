import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearGptTokenMemo,
  EXACT_BPE_MAX_CHARS,
  gptTokenCount,
  gptTokenMemoChars,
} from '../src/core/gpt-tokens.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { planResponsesPairCollapse } from '../src/core/openai-history.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import {
  clearRenderCache,
  renderCacheStats,
  renderTextToPngsWithCharLimit,
  setRenderCacheMaxBytes,
} from '../src/core/render.js';
import { resolvePriceRates } from '../src/core/pricing.js';
import { isBareDenseFable } from '../src/core/claude-model-profiles.js';
import { prefersText, readerTier } from '../src/core/reader-tier.js';
import { applyAnthropicTextHygiene } from '../src/core/text-hygiene.js';
import { planAndApplyTextEpochs, resetTextEpochStickyState } from '../src/core/text-history.js';
import {
  clearStickyMarkovEpisodesForTests,
  ContextPageStore,
  foldMarkovianEpisodes,
  isFileReadToolName,
  pruneLowDensityBlob,
  resetGlobalMmuStore,
} from '../src/core/context-mmu.js';
import { clearCasiPreparedCacheForTests, createCasiIndex } from '../src/core/casi-delta.js';
import { PrefixMemoTape, resetGlobalPrefixTape } from '../src/core/prefix-tape.js';
import {
  clearSchemaCompilerCachesForTests,
  compileSegmentedStaticText,
  compileToolSchemas,
} from '../src/core/schema-compiler.js';
import {
  clearFactSheetCache,
  extractFactSheetEntriesAllPages,
  FACTSHEET_PAGE_CHARS,
} from '../src/core/factsheet.js';
import {
  isSessionCacheCold,
  markCacheDead,
  noteCacheOutcome,
  noteHistoryRequest,
  peekSessionState,
  resetSessionState,
} from '../src/core/session-state.js';
import { resolveOpticalHistoryPolicy, transformRequest } from '../src/core/transform.js';
import { HISTORY_SYNTHETIC_INTRO } from '../src/core/history.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function resetAllState(): void {
  resetSessionState();
  resetTextEpochStickyState();
  clearStickyMarkovEpisodesForTests();
  resetGlobalMmuStore();
  resetGlobalPrefixTape();
  clearCasiPreparedCacheForTests();
  clearSchemaCompilerCachesForTests();
  clearFactSheetCache();
  clearGptTokenMemo();
  clearRenderCache();
}

beforeEach(() => {
  resetAllState();
});

describe('Track A — Codex Speed, BPE Ceiling & Pre-Render Caps', () => {
  it('enforces EXACT_BPE_MAX_CHARS ceiling, fast estimate above it, and bounded LRU memo', () => {
    expect(EXACT_BPE_MAX_CHARS).toBe(256_000);
    const small = 'function verifyOrderSettlement(id: string) { return id.length > 4; }';
    const smallTokens = gptTokenCount(small);
    expect(smallTokens).toBeGreaterThan(5);

    const huge = 'alpha_beta_gamma_delta_0123456789 '.repeat(50_000); // ~1.6M chars
    const t0 = performance.now();
    const hugeTok = gptTokenCount(huge);
    const elapsedMs = performance.now() - t0;
    expect(hugeTok).toBe(Math.ceil(huge.length / 3.5));
    expect(elapsedMs).toBeLessThan(150);

    // Populate >8 MiB of memoized tokenized strings <= 64K chars and confirm LRU keeps memo bounded
    // without wiping everything with .clear().
    const hot = 'hot_lru_entry_token_anchor_xyz '.repeat(1200);
    gptTokenCount(hot);
    for (let i = 0; i < 280; i++) {
      const filler = `entry_${i}_ ` + 'x '.repeat(17_500);
      gptTokenCount(filler);
      if (i % 50 === 0) gptTokenCount(hot); // refresh LRU recency
    }
    expect(gptTokenMemoChars()).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(gptTokenMemoChars()).toBeGreaterThan(1024 * 1024);
  });

  it('skips multi-MB image-bearing function_call_output in Responses without speculative 460-page renders', async () => {
    const hugeB64 = 'A'.repeat(2_400_000);
    const largeLogs = Array.from({ length: 120 }, (_, i) => `row=${i} status=ok payload_${i}`).join('\n');
    const req = {
      model: 'gpt-5.3-codex',
      instructions: 'System authority instructions.\n'.repeat(120),
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect screenshot & logs' }] },
        { type: 'function_call', call_id: 'call_img', name: 'take_screenshot', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_img',
          output: [
            { type: 'input_text', text: 'screenshot captured' },
            { type: 'input_image', image_url: `data:image/png;base64,${hugeB64}` },
          ],
        },
        { type: 'function_call', call_id: 'call_log', name: 'read_logs', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_log', output: largeLogs },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize current state' }] },
      ],
    };

    const t0 = performance.now();
    const res = await transformOpenAIResponses(enc.encode(JSON.stringify(req)), {
      compress: true,
      imageCompress: true,
      textHygiene: 'on',
    });
    const elapsedMs = performance.now() - t0;
    const out = JSON.parse(dec.decode(res.body)) as { input: Array<Record<string, unknown>> };
    const imgOutput = out.input.find(
      (it) => it.type === 'function_call_output' && it.call_id === 'call_img',
    );
    expect(imgOutput).toBeDefined();
    expect(Array.isArray(imgOutput?.output)).toBe(true);
    expect(elapsedMs).toBeLessThan(2000);
    expect(res.info.cachePrefixSha8).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects non-text array outputs on custom_tool_call_output and pre-caps oversized pair collapses before PNG render', async () => {
    const hugeArrayOut = [
      { type: 'input_text', text: 'diagram attached' },
      { type: 'input_image', image_url: 'data:image/png;base64,' + 'B'.repeat(4096) },
    ];
    const megaPairText = Array.from({ length: 1200 }, (_, i) => `line_${i}: ${'Z'.repeat(80)}`).join('\n');
    const items = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start task' }] },
      { type: 'custom_tool_call', call_id: 'ct_img', name: 'render_diagram', input: '{}' },
      { type: 'custom_tool_call_output', call_id: 'ct_img', output: hugeArrayOut },
      { type: 'custom_tool_call', call_id: 'ct_huge', name: 'dump_table', input: '{}' },
      { type: 'custom_tool_call_output', call_id: 'ct_huge', output: megaPairText },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tail question' }] },
    ];

    const plan = await planResponsesPairCollapse(
      items,
      () => true,
      { maxImages: 2, minSpanChars: 500, cols: 80, maxImageBytes: 18 * 1024 * 1024 },
    );
    // ct_img has input_image array output so it must NEVER be collapsed into PNG.
    expect(plan.segments.some((s) => s.start <= 1 && s.end >= 2)).toBe(false);
    // Any collapsed segment must respect remainingImages cap (<= 2 images).
    expect(plan.images.length).toBeLessThanOrEqual(2);
  });

  it('isolates volatile islands inside leading Responses developer messages so static slab prefixSha8 stays invariant', async () => {
    const staticInstr = Array.from(
      { length: 80 },
      (_, i) => `Rule ${i}: Always verify checksums before committing ledger mutations.`,
    ).join('\n');

    const makeReq = (turnTs: string) => ({
      model: 'gpt-5.3-codex',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{
            type: 'input_text',
            text: `${staticInstr}\n<environment_context>\n  <cwd>/workspace</cwd>\n  <current_date>${turnTs}</current_date>\n</environment_context>`,
          }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check repo status' }] },
      ],
    });

    const r1 = await transformOpenAIResponses(enc.encode(JSON.stringify(makeReq('2026-11-25T10:00:00Z'))), {
      compress: true,
      imageCompress: true,
    });
    const r2 = await transformOpenAIResponses(enc.encode(JSON.stringify(makeReq('2026-11-25T10:05:00Z'))), {
      compress: true,
      imageCompress: true,
    });

    expect(r1.info.cachePrefixSha8).toBeDefined();
    expect(r1.info.cachePrefixSha8).toBe(r2.info.cachePrefixSha8);
    const out2 = JSON.parse(dec.decode(r2.body)) as { input: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }> };
    const firstSlabUser = out2.input.find((m) => m.role === 'user');
    expect(firstSlabUser?.content?.some((p) => p.type === 'input_image')).toBe(true);
    expect(JSON.stringify(out2.input)).toContain('2026-11-25T10:05:00Z');
  });

  it('keeps late user/tool screenshot budget separate from already-sealed history images', async () => {
    const bigToolOut = (n: number) =>
      Array.from({ length: 65 }, (_, i) => `tool_${n}_line_${i}: ` + 'k'.repeat(90)).join('\n');

    const makeReq = (includeLateImg: boolean) => ({
      model: 'gpt-5.3-codex',
      instructions: 'System guidance\n'.repeat(100),
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start analysis' }] },
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'c1', output: bigToolOut(1) },
        { type: 'function_call', call_id: 'c2', name: 'shell', arguments: '{"cmd":"ps"}' },
        { type: 'function_call_output', call_id: 'c2', output: bigToolOut(2) },
        {
          type: 'message',
          role: 'user',
          content: includeLateImg
            ? [
                { type: 'input_text', text: 'Look at this late screenshot' },
                { type: 'input_image', image_url: 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(20) },
              ]
            : [{ type: 'input_text', text: 'Continue analysis' }],
        },
      ],
    });

    const t1 = await transformOpenAIResponses(enc.encode(JSON.stringify(makeReq(false))), {
      compress: true,
      imageCompress: true,
    });
    const t2 = await transformOpenAIResponses(enc.encode(JSON.stringify(makeReq(true))), {
      compress: true,
      imageCompress: true,
    });

    expect(t1.info.cachePrefixSha8).toBeDefined();
    expect(t2.info.cachePrefixSha8).toBe(t1.info.cachePrefixSha8);
    expect(t2.info.historyCollapseImages).toBe(t1.info.historyCollapseImages);
  });

  it('singleflight-coalesces concurrent render misses and skips oversized count when cache maxBytes === 0', async () => {
    const text = Array.from({ length: 60 }, (_, i) => `render line ${i} payload`).join('\n');
    const [a, b] = await Promise.all([
      renderTextToPngsWithCharLimit(text, 120, 4000, {}, 200_000),
      renderTextToPngsWithCharLimit(text, 120, 4000, {}, 200_000),
    ]);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
    expect(renderCacheStats().misses).toBe(2);

    setRenderCacheMaxBytes(0);
    try {
      await renderTextToPngsWithCharLimit(text + '\nunique_zero_cap', 120, 4000, {}, 200_000);
      expect(renderCacheStats().oversized).toBe(0);
    } finally {
      setRenderCacheMaxBytes();
    }
  });
});

describe('Track A — Google Turn-2 Anchor Stability & Pre-Cap', () => {
  it('keeps Google contents[0] as native anchor across Turn 1 and Turn 2 without retroactive start flip', async () => {
    const mkBody = (turn2: boolean) => ({
      systemInstruction: { parts: [{ text: 'System instruction rule.\n'.repeat(120) }] },
      contents: [
        { role: 'user', parts: [{ text: 'Initial prompt anchor that exceeds normal short prompt length' }] },
        { role: 'model', parts: [{ functionCall: { name: 'bash', args: { cmd: 'run1' } } }] },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'bash',
              response: { output: Array.from({ length: 90 }, (_, i) => `turn1_${i}_` + 'x'.repeat(60)).join('\n') },
            },
          }],
        },
        ...(turn2
          ? [
              { role: 'model', parts: [{ functionCall: { name: 'bash', args: { cmd: 'run2' } } }] },
              {
                role: 'user',
                parts: [{
                  functionResponse: {
                    name: 'bash',
                    response: { output: Array.from({ length: 90 }, (_, i) => `turn2_${i}_` + 'y'.repeat(60)).join('\n') },
                  },
                }],
              },
              { role: 'model', parts: [{ text: 'Ready for next command.' }] },
              { role: 'user', parts: [{ text: 'What did turn 2 say?' }] },
            ]
          : [{ role: 'model', parts: [{ text: 'Done turn 1.' }] }, { role: 'user', parts: [{ text: 'Run turn 2.' }] }]),
      ],
    });

    const g1 = await transformGoogleGenerateContent(enc.encode(JSON.stringify(mkBody(false))), 'gemini-2.5-pro', {
      compress: true,
      imageCompress: true,
      historyMinSpanChars: 1000,
    });
    const g2 = await transformGoogleGenerateContent(enc.encode(JSON.stringify(mkBody(true))), 'gemini-2.5-pro', {
      compress: true,
      imageCompress: true,
      historyMinSpanChars: 1000,
    });

    const p1 = JSON.parse(dec.decode(g1.body)) as { contents: Array<{ parts: unknown[] }> };
    const p2 = JSON.parse(dec.decode(g2.body)) as { contents: Array<{ parts: unknown[] }> };
    // Turn 0 user contents[0] stays invariant (never retroactively flipped into collapsed history)
    expect(p2.contents[0]).toEqual(p1.contents[0]);
  });
});

describe('Track A — Anthropic 1h / 5m KV-Cache Prefix Protection', () => {
  it('honors 1h (2.0x) and 5m (1.25x) write rates in legacy resolvePriceRates', () => {
    const r5m = resolvePriceRates('claude-opus-4-6', { ttlSec: 300 });
    const r1h = resolvePriceRates('claude-opus-4-6', { ttlSec: 3600 });
    expect(r5m.write).toBe(1.25);
    expect(r1h.write).toBe(2);

    const gpt1h = resolvePriceRates('gpt-5.2', { ttlSec: 3600 });
    expect(gpt1h.write).toBe(2);
  });

  it('protects blocks at or before a live 1h cache_control breakpoint across density_prune and epochs', () => {
    // Diverse lines so foldLogs doesn't fold them; density_prune & lsm_l1 would touch if unprotected.
    const diverseBody = Array.from(
      { length: 220 },
      (_, i) => `line_${i}_kind_${i % 7}: key_${(i * 37) % 997}=val_${i * 13}_` + 'd'.repeat(30),
    ).join('\n');
    // ~40 lines (~2.6K chars, < 1500 tokens) so t2 provides downstream cached tokens without exceeding lsmMinLargeTokens itself.
    const padLog = Array.from({ length: 40 }, (_, i) => `downstream_${i}: record_${i * 7}_ok ` + 'p'.repeat(45)).join('\n');

    const req = {
      model: 'claude-opus-4-6',
      system: [{ type: 'text', text: 'System prompt.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        { role: 'user', content: 'Analyze logs' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: diverseBody }],
        },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'bash', input: {} }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 't2',
            content: padLog,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          }],
        },
        { role: 'assistant', content: 'Checked.' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'next step' }] },
        { role: 'assistant', content: 'Still checking.' },
        { role: 'user', content: 'Final question' },
      ],
    };

    const beforeT1 = req.messages[2]!.content[0]!.content;
    const stats = applyAnthropicTextHygiene(req, {
      foldLogs: true,
      deepTextCompact: true,
      enableCasi: false,
      model: 'claude-opus-4-6',
      ttlSec: 3600,
      sessionKey: 'bp_1h_sess',
      sessionCacheCold: false,
    });
    // t1 is covered by a live 1h breakpoint at t2, so neither density_prune nor lsm_l1 may mutate it mid-prefix.
    expect(req.messages[2]!.content[0]!.content).toBe(beforeT1);
    expect(stats.stages).not.toContain('density_prune');
    expect(stats.stages).not.toContain('lsm_l1');
    expect(stats.stages).not.toContain('acdc_epoch');
  });

  it('keeps text-history stickyEpoch unchanged across ttlSec toggles (300 <-> 3600)', () => {
    const bigBlock = Array.from(
      { length: 200 },
      (_, i) => `2026-11-25T10:${String(i % 60).padStart(2, '0')}:00Z INFO step=${i} detail=${'z'.repeat(65)}`,
    ).join('\n');

    let text1 = bigBlock;
    const r1 = planAndApplyTextEpochs({
      blocks: [{ msgIndex: 1, blockIndex: 0, refId: 'b1', getText: () => text1, setText: (s) => { text1 = s; } }],
      totalMessages: 10,
      keepTailMessages: 2,
      model: 'claude-opus-4-6',
      totalPromptTokens: 12_000,
      ttlSec: 300,
      sessionKey: 'ttl_toggle_sess',
      sessionCacheCold: false,
    });
    expect(r1.changed).toBe(true);
    const sealed = text1;

    // Replay with ttlSec=3600 (1h) must still hit sticky sealed key and produce the identical bytes.
    let text2 = bigBlock;
    const r2 = planAndApplyTextEpochs({
      blocks: [{ msgIndex: 1, blockIndex: 0, refId: 'b1', getText: () => text2, setText: (s) => { text2 = s; } }],
      totalMessages: 10,
      keepTailMessages: 2,
      model: 'claude-opus-4-6',
      totalPromptTokens: 12_000,
      ttlSec: 3600,
      sessionKey: 'ttl_toggle_sess',
      sessionCacheCold: false,
    });
    expect(r2.changed).toBe(true);
    expect(text2).toBe(sealed);
  });

  it('never places a 1h relocated cache_control after an earlier 5m breakpoint and pins opticalHistoryPolicy per session', async () => {
    const prevPrices = process.env.INKLING_PRICES;
    process.env.INKLING_PRICES = 'kosha';
    try {
      // 1. Check session-pinned opticalHistoryPolicy across 160K token threshold
      const sess = 'policy_pin_160k';
      noteHistoryRequest(sess, { model: 'claude-opus-4-6', nowMs: 1_000 });
      const p1 = resolveOpticalHistoryPolicy({
        opticalMode: 'auto',
        model: 'claude-opus-4-6',
        estPromptTokens: 80_000,
        textHygieneActive: true,
        sessionKey: sess,
        sessionCold: false,
      });
      const p2 = resolveOpticalHistoryPolicy({
        opticalMode: 'auto',
        model: 'claude-opus-4-6',
        estPromptTokens: 200_000,
        textHygieneActive: true,
        sessionKey: sess,
        sessionCold: false,
      });
      expect(p1).toBe('hybrid');
      expect(p2).toBe('hybrid');
    } finally {
      if (prevPrices === undefined) delete process.env.INKLING_PRICES;
      else process.env.INKLING_PRICES = prevPrices;
    }

    // 2. Check monotonic TTL ordering in transformRequest:
    // Valid caller order: system (1h) -> messages[0] user anchor (5m).
    // Turn 2 triggers carry-over history collapse & relocates slab anchor (1h) onto historyImg AFTER messages[0]'s 5m marker:
    // relocateAnchorToHistoryImage MUST clamp the relocated marker from 1h -> 5m so 1h never appears after 5m.
    const mkTurnMsgs = (turns: number) => {
      const msgs: Array<{ role: string; content: unknown }> = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Turn 0 anchor with explicit 5m marker', cache_control: { type: 'ephemeral' } }],
        },
      ];
      for (let t = 1; t <= turns; t++) {
        msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `u${t}`, name: 'bash', input: {} }] });
        msgs.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: `u${t}`,
            content: Array.from({ length: 80 }, (_, i) => `turn_${t}_row_${i}: ` + 'm'.repeat(65)).join('\n'),
          }],
        });
        msgs.push({ role: 'assistant', content: `Completed step ${t}` });
        msgs.push({ role: 'user', content: `Proceed to step ${t + 1}` });
      }
      return msgs;
    };

    const system1h = [
      { type: 'text', text: 'System static instructions.\n'.repeat(120), cache_control: { type: 'ephemeral', ttl: '1h' } },
    ];
    await transformRequest(
      enc.encode(JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 256, system: system1h, messages: mkTurnMsgs(6) })),
      { compress: true, imageCompress: true, opticalMode: 'full', collapseHistory: true, historyMinSpanChars: 1000 },
    );
    const res = await transformRequest(
      enc.encode(JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 256, system: system1h, messages: mkTurnMsgs(14) })),
      { compress: true, imageCompress: true, opticalMode: 'full', collapseHistory: true, historyMinSpanChars: 1000 },
    );
    const out = JSON.parse(dec.decode(res.body)) as {
      messages: Array<{ content?: Array<{ type?: string; text?: string; cache_control?: { ttl?: string } }> }>;
    };
    const historyMsg = out.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'text' && b.text === HISTORY_SYNTHETIC_INTRO),
    );
    expect(historyMsg).toBeDefined();
    const historyCcs = (historyMsg?.content ?? []).filter((b) => b.cache_control).map((b) => b.cache_control!);
    expect(historyCcs.length).toBeGreaterThan(0);
    // Clamped to 5m (no ttl === '1h' placed after earlier 5m marker in messages[0])
    expect(historyCcs.some((cc) => cc.ttl === '1h')).toBe(false);
  });
});

describe('Track A — CASI >48 Replay Parity & PrefixTape Budget', () => {
  it('replays >48 indexed bases identically via replayIndexedBase up to 128 entries', () => {
    const makeDoc = (idx: number) =>
      Array.from({ length: 24 }, (_, l) => `doc_${idx}_line_${l}: shared_structure_record_${idx}_${l} ` + 'q'.repeat(30)).join('\n');

    const coldIdx = createCasiIndex();
    const docs = Array.from({ length: 65 }, (_, i) => makeDoc(i));
    for (let i = 0; i < docs.length; i++) {
      coldIdx.ingest(docs[i]!, `r_${i}`, i);
    }
    const target = makeDoc(0).replace('doc_0_line_12: shared_structure_record_0_12', 'doc_0_line_12: UPDATED_LINE_12');
    const coldRes = coldIdx.ingest(target, 'r_target', 70);

    const warmIdx = createCasiIndex();
    for (let i = 0; i < docs.length; i++) {
      warmIdx.replayIndexedBase(docs[i]!, `r_${i}`, i);
    }
    const warmRes = warmIdx.ingest(target, 'r_target', 70);

    expect(warmRes.changed).toBe(coldRes.changed);
    expect(warmRes.text).toBe(coldRes.text);
  });

  it('never leaves dangling CASI bases pointing to compacted-away preCompactTexts', () => {
    const bigFile = Array.from(
      { length: 190 },
      (_, i) => `${String(i + 1).padStart(4)}→export const ROW_${i} = "value_${i}_${'k'.repeat(40)}";`,
    ).join('\n');
    const almostSameTail = bigFile.replace('ROW_100 = "value_100_', 'ROW_100 = "MODIFIED_100_');

    const req = {
      model: 'claude-opus-4-6',
      messages: [
        { role: 'user', content: 'Inspect files' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f1', content: bigFile }] },
        { role: 'assistant', content: 'One moment' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f2', content: 'short' }] },
        { role: 'assistant', content: 'Two' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f3', content: 'short2' }] },
        { role: 'assistant', content: 'Three' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f4', content: 'short3' }] },
        { role: 'assistant', content: 'Four' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f5', content: almostSameTail }] },
      ],
    };

    applyAnthropicTextHygiene(req, {
      foldLogs: true,
      deepTextCompact: true,
      model: 'claude-opus-4-6',
      sessionKey: 'no_dangling_casi',
      sessionCacheCold: false,
    });

    const f1Text = req.messages[2]!.content[0]!.content;
    const f5Text = req.messages[10]!.content[0]!.content;
    if (f1Text.startsWith('[fiche ')) {
      expect(f5Text).not.toContain('ref=f1');
    }
  });

  it('bounds PrefixMemoTape seal memory via LRU eviction across sessions', () => {
    const tape = new PrefixMemoTape({ maxSessions: 100, maxSealChars: 20_000 });
    for (let i = 0; i < 10; i++) {
      const payload = `sess_${i}_` + 'p'.repeat(4000);
      tape.setSeal(`s_${i}`, `sig_${i}`, {
        text: payload,
        stages: ['lsm_l1'],
        kind: 'epoch',
        rawLen: payload.length + 200,
      });
    }
    expect(tape.getStats().sealChars).toBeLessThanOrEqual(20_000);
    expect(tape.getSeal('s_9', 'sig_9')).toBeDefined();
    expect(tape.getSeal('s_0', 'sig_0')).toBeUndefined();
  });
});

describe('Track A — Algorithmic P1/P2 Polish', () => {
  it('keeps earlier compiled tools/static blocks byte-invariant when deferred tools append later', () => {
    const sharedPara = 'This shared paragraph describes paginated cursor traversal with deterministic ordering and retry bounds across distributed workers.';
    const tA = { name: 'tool_a', description: `Tool A.\n\n${sharedPara}`, input_schema: { type: 'object', properties: { a: { type: 'string' } } } };
    const tB = { name: 'tool_b', description: `Tool B.\n\n${sharedPara}`, input_schema: { type: 'object', properties: { b: { type: 'string' } } } };
    const tC = { name: 'tool_c', description: `Tool C.\n\n${sharedPara}`, input_schema: { type: 'object', properties: { c: { type: 'string' } } } };

    const tools1 = [structuredClone(tA)];
    compileToolSchemas(tools1, 'anthropic');
    const tASnapshot = JSON.stringify(tools1[0]);

    const tools2 = [structuredClone(tA), structuredClone(tB), structuredClone(tC)];
    compileToolSchemas(tools2, 'anthropic');
    expect(JSON.stringify(tools2[0])).toBe(tASnapshot);

    const staticSeg1 = compileSegmentedStaticText(`Head A\n\n${sharedPara}\n\nTail A`);
    expect(staticSeg1.text).toContain('Head A');
  });

  it('tracks overlapping repacks via repackInFlightCount and isolates Haiku auxiliary probes from main-thread coldness', () => {
    const sk = 'concurrent_liveness_sess';
    markCacheDead(sk, { model: 'claude-opus-4-6' });
    expect(isSessionCacheCold(sk, { model: 'claude-opus-4-6' })).toBe(true);

    // First cold request enters repack -> repackInFlightCount === 1
    const s1 = noteHistoryRequest(sk, { model: 'claude-opus-4-6', nowMs: 10_000 });
    expect(s1.cold).toBe(true);
    expect(peekSessionState(sk)?.repackInFlightCount).toBe(1);
    expect(peekSessionState(sk)?.justRepacked).toBe(true);

    // A second cold trigger while first is in-flight increments repackInFlightCount to 2
    markCacheDead(sk, { model: 'claude-opus-4-6' });
    const s2 = noteHistoryRequest(sk, { model: 'claude-opus-4-6', nowMs: 10_050 });
    expect(s2.cold).toBe(true);
    expect(peekSessionState(sk)?.repackInFlightCount).toBe(2);
    expect(peekSessionState(sk)?.justRepacked).toBe(true);

    // First completion with implicit cache (cacheCreateTokens === undefined) decrements 2 -> 1 without marking dead
    noteCacheOutcome(sk, 0, undefined, { model: 'claude-opus-4-6' });
    expect(peekSessionState(sk)?.repackInFlightCount).toBe(1);
    expect(peekSessionState(sk)?.justRepacked).toBe(true);
    expect(peekSessionState(sk)?.lastCacheAlive).toBeUndefined();

    // Second completes cleanly with cache read -> clears repackInFlightCount to 0 and marks alive
    noteCacheOutcome(sk, 1000, 100, { model: 'claude-opus-4-6' });
    expect(peekSessionState(sk)?.repackInFlightCount).toBe(0);
    expect(peekSessionState(sk)?.justRepacked).toBe(false);
    expect(peekSessionState(sk)?.lastCacheAlive).toBe(true);

    // Auxiliary Haiku request going dead MUST NOT make primary Opus session cold
    markCacheDead(sk, { model: 'claude-3-5-haiku-latest' });
    expect(isSessionCacheCold(sk, { model: 'claude-opus-4-6' })).toBe(false);
  });

  it('accumulates global raw counts across multi-page factsheets before substring collapse and bounds large page scans', () => {
    const p1 = 'alphaServiceWorker '.repeat(12) + 'PROJ-1482 '.repeat(4) + '\n' + 'x'.repeat(FACTSHEET_PAGE_CHARS - 400);
    const p2 = 'alphaServiceWorkerV2 '.repeat(10) + 'betaPaymentGateway '.repeat(8);
    const huge = [p1, p2, ...Array.from({ length: 45 }, (_, i) => `PAGE_NUM_${i} ` + 'y'.repeat(FACTSHEET_PAGE_CHARS - 20))].join('\n');

    const t0 = performance.now();
    const res = extractFactSheetEntriesAllPages(huge, FACTSHEET_PAGE_CHARS);
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(300);
    expect(res.kept.length).toBeGreaterThan(0);
    expect(res.kept.length).toBeLessThanOrEqual(96);
  });

  it('gates Markov checkpoints on shell/test/git tools (never Read), freezes replay certificates across eviction, and saturates density prune counts', () => {
    expect(isFileReadToolName('Read')).toBe(true);
    expect(isFileReadToolName('read_file')).toBe(true);
    expect(isFileReadToolName('bash')).toBe(false);

    const fileReadText = Array.from({ length: 120 }, (_, i) => `line_${i}: data_${i}_` + 'r'.repeat(45)).join('\n');
    const failText = Array.from({ length: 80 }, (_, i) => (i === 10 ? 'FAIL src/a.test.ts' : `err_${i}: ` + 'e'.repeat(45))).join('\n');
    const stepText = Array.from({ length: 80 }, (_, i) => `step_${i}: running check ` + 's'.repeat(45)).join('\n');
    const passText = Array.from({ length: 80 }, (_, i) => (i === 75 ? 'Tests 10 passed (10)\nExit code: 0' : `ok_${i}: ` + 'p'.repeat(45))).join('\n');

    // File-read blocks alone must NOT trigger Markov episode folding
    let readOnly1 = fileReadText;
    let readOnly2 = fileReadText.replace('line_1', 'line_1b');
    let readOnly3 = fileReadText.replace('line_2', 'line_2b');
    let readOnly4 = passText; // Even if content resembles passText, toolName 'Read' must NOT trigger checkpoint
    const rRead = foldMarkovianEpisodes({
      blocks: [
        { msgIndex: 1, refId: 'r1', toolName: 'read_file', getText: () => readOnly1, setText: (s) => { readOnly1 = s; } },
        { msgIndex: 2, refId: 'r2', toolName: 'Read', getText: () => readOnly2, setText: (s) => { readOnly2 = s; } },
        { msgIndex: 3, refId: 'r3', toolName: 'view_file', getText: () => readOnly3, setText: (s) => { readOnly3 = s; } },
        { msgIndex: 4, refId: 'r4', toolName: 'Read', getText: () => readOnly4, setText: (s) => { readOnly4 = s; } },
      ],
      totalMessages: 10,
      keepTailMessages: 4,
      sessionKey: 'markov_read_only',
      model: 'claude-opus-4-6',
    });
    expect(rRead.changed).toBe(false);

    // Bash fail -> steps -> vitest pass episode (>= 4 blocks, >= 3 predecessors) freezes certificate bytes even if store pages are evicted
    const store = new ContextPageStore({ maxPages: 4, maxBytes: 128 * 1024 });
    let b1 = failText;
    let b2 = stepText;
    let b3 = stepText.replace('step_0', 'step_0_retry');
    let b4 = passText;
    const f1 = foldMarkovianEpisodes({
      blocks: [
        { msgIndex: 1, refId: 'cmd1', toolName: 'bash', getText: () => b1, setText: (s) => { b1 = s; } },
        { msgIndex: 2, refId: 'cmd2', toolName: 'bash', getText: () => b2, setText: (s) => { b2 = s; } },
        { msgIndex: 3, refId: 'cmd3', toolName: 'bash', getText: () => b3, setText: (s) => { b3 = s; } },
        { msgIndex: 4, refId: 'cmd4', toolName: 'vitest', getText: () => b4, setText: (s) => { b4 = s; } },
      ],
      totalMessages: 16,
      keepTailMessages: 4,
      sessionKey: 'markov_cert_freeze',
      model: 'claude-opus-4-6',
      store,
    });
    expect(f1.changed).toBe(true);
    const cert1 = b1;

    // Evict pages from store by inserting unrelated pages, then replay same session/episode
    for (let i = 0; i < 6; i++) {
      store.storePage({ sessionKey: 'other', refId: `o${i}`, rawText: `unrelated_${i}_` + 'u'.repeat(500) });
    }
    let b1Replay = failText;
    let b2Replay = stepText;
    let b3Replay = stepText.replace('step_0', 'step_0_retry');
    let b4Replay = passText;
    const f2 = foldMarkovianEpisodes({
      blocks: [
        { msgIndex: 1, refId: 'cmd1', toolName: 'bash', getText: () => b1Replay, setText: (s) => { b1Replay = s; } },
        { msgIndex: 2, refId: 'cmd2', toolName: 'bash', getText: () => b2Replay, setText: (s) => { b2Replay = s; } },
        { msgIndex: 3, refId: 'cmd3', toolName: 'bash', getText: () => b3Replay, setText: (s) => { b3Replay = s; } },
        { msgIndex: 4, refId: 'cmd4', toolName: 'vitest', getText: () => b4Replay, setText: (s) => { b4Replay = s; } },
      ],
      totalMessages: 16,
      keepTailMessages: 4,
      sessionKey: 'markov_cert_freeze',
      model: 'claude-opus-4-6',
      store,
    });
    expect(f2.changed).toBe(true);
    expect(b1Replay).toBe(cert1);

    // CELF++ density prune selects high-density concise signal lines over verbose prose boilerplate
    const noisyBlob = [
      'Overview of settlement audit run.',
      ...Array.from(
        { length: 45 },
        (_, i) => `The distributed worker pool periodically verifies lease status across shard ${i % 3} during normal background execution without alerts or incidents.`,
      ),
      'ERROR: payment_settlement_failed code=502 tx=tx_999',
      ...Array.from(
        { length: 45 },
        (_, i) => `Standard operational telemetry indicates nominal queue depth on background partition ${(i + 1) % 3} with zero pending alerts in region.`,
      ),
    ].join('\n');
    const pruned = pruneLowDensityBlob(noisyBlob, { targetDropRatio: 0.6 });
    expect(pruned.changed).toBe(true);
    expect(pruned.text).toContain('payment_settlement_failed');
  });

  it('fixes isBareDenseFable and prefersText/readerTier model coverage', () => {
    expect(isBareDenseFable('claude-fable-5-2')).toBe(false);
    expect(isBareDenseFable('claude-fable-5.2')).toBe(false);
    expect(isBareDenseFable('claude-fable-4-7')).toBe(false);
    expect(isBareDenseFable('claude-fable-5')).toBe(true);
    expect(isBareDenseFable('claude-fable-5-0')).toBe(true);

    expect(prefersText('claude-3-5-haiku-latest')).toBe(true);
    expect(prefersText('claude-haiku-4-5')).toBe(true);
    expect(readerTier('claude-haiku-4-5')).toBe('text');
    expect(prefersText('gpt-5.5')).toBe(true);
    expect(prefersText('o1')).toBe(true);
    expect(prefersText('o3-mini')).toBe(true);
    expect(prefersText('o4-mini')).toBe(true);
  });
});
