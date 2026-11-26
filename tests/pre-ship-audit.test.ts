import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearCalibratedProfiles,
  getCalibratedProfileMatch,
  setCalibratedProfile,
} from '../src/core/calibration.js';
import { createCasiIndex } from '../src/core/casi-delta.js';
import {
  ContextPageStore,
  clearStickyMarkovEpisodesForTests,
  computeTailHydration,
  extractFaultSignalSnippet,
  extractSymbolSpans,
  foldMarkovianEpisodes,
  getGlobalMmuStore,
  resetGlobalMmuStore,
} from '../src/core/context-mmu.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { createProxy } from '../src/core/proxy.js';
import { prefersText, readerTier } from '../src/core/reader-tier.js';
import { compileStaticText } from '../src/core/schema-compiler.js';
import { resetSessionState } from '../src/core/session-state.js';
import { planAndApplyTextEpochs, resetTextEpochStickyState } from '../src/core/text-history.js';
import { applyAnthropicTextHygiene } from '../src/core/text-hygiene.js';
import { DEFAULTS, applyClientSessionIdentity, transformRequest } from '../src/core/transform.js';
import { normalizeKoshaModelBase } from '../src/kosha-sync.js';
import { fileMmuPersistenceStore } from '../src/mmu-store.js';

const tmpDirs: string[] = [];

afterEach(() => {
  resetGlobalMmuStore();
  resetSessionState();
  resetTextEpochStickyState();
  clearStickyMarkovEpisodesForTests();
  clearCalibratedProfiles();
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('P0/P1/P2 Pre-Ship Audit Regressions & Novel Algorithms', () => {
  it('PMISL invariant: warm turns replay Turn-1 Markov folds without Stage 3a overwriting certificates', () => {
    const makeFailBlock = (stepNum: number) =>
      `FAILED AssertionError step=${stepNum}\n` +
      Array.from(
        { length: 65 },
        (_, i) => `frame_${stepNum}_${i}: module_${(stepNum * 31 + i) % 97} -> hash_${(i * 7919 + stepNum * 104729).toString(16)}`,
      ).join('\n');
    const buildHistory = (extraTailTurns: number) => {
      const msgs: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
        { role: 'user', content: 'Debug ledger checksum failure' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 't1' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: makeFailBlock(1) }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'bash', input: { cmd: 't2' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: makeFailBlock(2) }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_3', name: 'bash', input: { cmd: 't3' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: makeFailBlock(3) }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_4', name: 'bash', input: { cmd: 't4' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_4', content: 'Test Files 1 passed\nTests 4 passed' }] },
      ];
      for (let e = 0; e < extraTailTurns; e++) {
        const idx = 5 + e;
        const tailBlob = `output_${idx}: ` + Array.from({ length: 40 }, (_, k) => `sym_${idx}_${k}=${k * 13}`).join(' ');
        msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_${idx}`, name: 'read_file', input: { path: `f${idx}.ts` } }] });
        msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${idx}`, content: tailBlob }] });
      }
      msgs.push({ role: 'assistant', content: 'Checking next step.' });
      msgs.push({ role: 'user', content: 'Proceed.' });
      return {
        model: 'claude-opus-5-5',
        messages: msgs,
      };
    };

    // Turn 1 (extra=1, totalMessages=13): Stage 3a pending < epochTarget, Stage 3b folds [tu_1..tu_3] into causal episode.
    // Turn 2 (extra=8, totalMessages=27): Stage 3a cutoff advances & pending exceeds epochTarget — PMISL replays Turn 1's fold first!
    const req1 = buildHistory(1);
    const req2 = buildHistory(8);
    const opts = {
      model: 'claude-opus-5-5',
      textHygiene: 'on' as const,
      deepTextCompact: true,
      sessionKey: 'pmisl-sess-1',
    };

    applyAnthropicTextHygiene(req1, opts);
    const turn1Slots = req1.messages.slice(0, 9).map((m) => JSON.stringify(m));

    applyAnthropicTextHygiene(req2, opts);
    const turn2Slots = req2.messages.slice(0, 9).map((m) => JSON.stringify(m));

    expect(turn1Slots.some((s) => s.includes('[fiche causal-episode '))).toBe(true);
    expect(turn2Slots).toEqual(turn1Slots);
  });

  it('SB-SMP prefetcher: full AST function bounds, IDF fusion ranking, newest-first scan, case-insensitive skills, fault filtering', () => {
    const store = new ContextPageStore({ maxPages: 64, maxBytes: 4 * 1024 * 1024 });
    const paddingNoise = Array.from({ length: 12 }, (_, i) => `export function commonHelper_${i}() { return ${i}; }`).join('\n');
    const longFn = [
      'export function verifyLedgerSignatureStrict(payload: string, sig: string): boolean {',
      ...Array.from({ length: 24 }, (_, i) => `  const step_${i} = payload.length + ${i};`),
      '  const FINAL_LEDGER_GUARD = sig.length === 64;',
      '  return FINAL_LEDGER_GUARD;',
      '}',
    ].join('\n');

    store.storePage({
      sessionKey: 'sbsmp-sess',
      refId: 'tu_generic',
      filePath: 'src/ledger/common.ts',
      rawText: paddingNoise,
      nowMs: 1000,
    });
    store.storePage({
      sessionKey: 'sbsmp-sess',
      refId: 'tu_target',
      filePath: 'src/ledger/checksum.ts',
      rawText: `// header\n${paddingNoise}\n${longFn}`,
      nowMs: 1000,
    });
    store.storePage({
      sessionKey: 'sbsmp-sess',
      refId: 'skill-catalog',
      toolName: 'skill-catalog',
      filePath: 'skills/bigquery/SKILL.md',
      rawText: '# BigQuery\nAlways partition tables cleanly.',
      extraSymbols: ['bigquery'],
      nowMs: 1000,
    });

    // 1. AST span slicing includes the full 28-line function (not truncated at +15 lines)
    //    AND matches capitalized "BigQuery" case-insensitively.
    // 2. Precede with noisy earlier turn > 64 identifiers to prove newest-first scan prevents starvation.
    const noisyOlderTurn = Array.from({ length: 90 }, (_, i) => `noisyCamSym${i} old_snake_${i} f${i}.txt`).join(' ');
    const latestPrompt = 'Fix FINAL_LEDGER_GUARD inside verifyLedgerSignatureStrict in checksum.ts using BigQuery.';
    const hyd = computeTailHydration({
      store,
      sessionKey: 'sbsmp-sess',
      liveTailTexts: [noisyOlderTurn, latestPrompt],
      maxSlices: 2,
    });

    expect(hyd.changed).toBe(true);
    expect(hyd.text).toContain('FINAL_LEDGER_GUARD');
    expect(hyd.text).toContain('return FINAL_LEDGER_GUARD;');
    expect(hyd.text).toContain('Always partition tables cleanly.');

    // 3. Intent-stratified tool filter ignores routine read_file, keeps failures & pg_* pointers
    expect(extractFaultSignalSnippet('export const clean = 1;\nTests 10 passed')).toBeUndefined();
    expect(extractFaultSignalSnippet('AssertionError: expected 1 to equal 2\n  at check (a.ts:4)')).toContain('AssertionError');
    expect(extractFaultSignalSnippet('See archived page pg_0123456789ab for raw log')).toContain('pg_0123456789ab');
  });

  it('SB-SMP across wires: hydrates on failing tool output while skipping routine clean tool outputs', async () => {
    const dummyInfo = {
      compressed: false,
      origChars: 0,
      compressedChars: 0,
      staticChars: 0,
      dynamicChars: 0,
      dynamicBlockCount: 0,
      imageCount: 0,
      imageBytes: 0,
    };
    const resolvedSession = await applyClientSessionIdentity(dummyInfo, 'first user', {
      clientSessionId: 'wire-hyd-1',
      clientSessionSource: 'fiche-header',
    });
    const store = getGlobalMmuStore();
    const targetBody = [
      'export function verifyWireChecksumStrict(input: string): number {',
      '  if (!input) throw new Error("EMPTY_WIRE_INPUT");',
      '  return input.length;',
      '}',
    ].join('\n');
    const pad = Array.from({ length: 22 }, (_, i) => `const filler_${i} = ${i};`).join('\n');
    store.storePage({
      sessionKey: resolvedSession!,
      refId: 'tu_prev',
      filePath: 'src/wire/check.ts',
      rawText: `${pad}\n${targetBody}`,
    });

    const req = {
      model: 'gpt-6-astra',
      input: [
        { type: 'function_call_output', call_id: 'c1', output: 'TypeError in verifyWireChecksumStrict\n  at run (check.ts:2)' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate that.' }] },
      ],
    };
    const res = await transformOpenAIResponses(new TextEncoder().encode(JSON.stringify(req)), {
      model: 'gpt-6-astra',
      clientSessionId: 'wire-hyd-1',
      clientSessionSource: 'fiche-header',
      imageCompress: false,
      textHygiene: 'on',
    });
    const out = new TextDecoder().decode(res.body);
    expect(out).toContain('[fiche vm-hydrate]');
    expect(out).toContain('EMPTY_WIRE_INPUT');
  });

  it('ReDoS & complexity bounds: sub-50ms on adversarial paths, commit brackets, deep braces, backticks & 120 blocks', () => {
    const store = new ContextPageStore();
    store.storePage({ sessionKey: 'perf-s', refId: 'r1', filePath: 'a.ts', rawText: 'export function alpha() { return 1; }' });

    const evilPathInput = 'a/'.repeat(15_000) + 'end';
    const t0 = performance.now();
    computeTailHydration({ store, sessionKey: 'perf-s', liveTailTexts: [evilPathInput] });
    expect(performance.now() - t0).toBeLessThan(50);

    const evilBracket = '[' + 'branch '.repeat(5_000) + '\n1 file changed';
    const t1 = performance.now();
    const mBlocks = Array.from({ length: 4 }, (_, i) => ({
      msgIndex: i + 1,
      refId: `b${i}`,
      getText: () => (i === 3 ? evilBracket : 'x'.repeat(2000)),
      setText: () => {},
    }));
    foldMarkovianEpisodes({ blocks: mBlocks, totalMessages: 12, keepTailMessages: 4, sessionKey: 'perf-s' });
    expect(performance.now() - t1).toBeLessThan(50);

    const deepBraces = Array.from({ length: 2000 }, (_, i) => `function fn_${i}() {`).join('\n') + '\n' + '}'.repeat(2000);
    const t2 = performance.now();
    const syms = extractSymbolSpans(deepBraces);
    expect(syms).toHaveLength(2000);
    expect(performance.now() - t2).toBeLessThan(100);

    const manyBackticks =
      Array.from({ length: 800 }, (_, i) => `\`code_${i}\``).join(' ') +
      `\n<!-- ${'strip_comment_padding_'.repeat(30)} -->\nkept line`;
    const t3 = performance.now();
    const compiled = compileStaticText(manyBackticks);
    expect(compiled.changed).toBe(true);
    expect(compiled.text).not.toContain('strip_comment_padding_');
    expect(compiled.text).toContain('`code_799`');
    expect(performance.now() - t3).toBeLessThan(50);

    const epochBlocks = Array.from({ length: 120 }, (_, i) => {
      let cur = `line ${i} `.repeat(200);
      return {
        msgIndex: i + 1,
        refId: `e${i}`,
        getText: () => cur,
        setText: (n: string) => {
          cur = n;
        },
      };
    });
    const t4 = performance.now();
    planAndApplyTextEpochs({ blocks: epochBlocks, totalMessages: 140, sessionKey: 'perf-epochs', model: 'gpt-6-astra' });
    expect(performance.now() - t4).toBeLessThan(350);
  });

  it('Normalized Two-Mask FastCDC-8 rolling window sensitivity & non-inverted hunk headers on trailing \\n', () => {
    const baseLines = Array.from({ length: 64 }, (_, i) => `${i + 1}\tconst row_${i} = computeNormalizedValue(${i});`);
    const shiftedLines = [`1\tconst addedTopHeader = true;`, ...baseLines.map((l, idx) => `${idx + 2}\t${l.split('\t')[1]}`)];
    const baseStr = baseLines.join('\n') + '\n';
    const shiftedStr = shiftedLines.join('\n') + '\n';

    const casi = createCasiIndex();
    casi.ingest(baseStr, 'f1', 1);
    const res = casi.ingest(shiftedStr, 'f2', 2);
    expect(res.changed).toBe(true);
    // Verify FastCDC chunks or LIS delta does not produce an inverted header like `base:64-1`
    const modifiedTrailing = baseLines.map((l, idx) => (idx === 62 ? '63\tconst row_62 = CHANGED_VAL(62);' : l)).join('\n') + '\n';
    const casi2 = createCasiIndex();
    casi2.ingest(baseStr, 'g1', 1);
    const hunkRes = casi2.ingest(modifiedTrailing, 'g2', 2);
    expect(hunkRes.changed).toBe(true);
    const hdr = /@@ base:(\d+)-(\d+) -> cur:(\d+)-(\d+) @@/.exec(hunkRes.text);
    expect(hdr).not.toBeNull();
    expect(Number(hdr![2])).toBeGreaterThanOrEqual(Number(hdr![1]));
    expect(Number(hdr![4])).toBeGreaterThanOrEqual(Number(hdr![3]));

    // Verify 2-line change inside an inserted header + rewritten region yields a compact delta/slice
    const mkLargeBody = (mutLine: number, alt: string) =>
      Array.from({ length: 72 }, (_, i) => `const entry_${i} = "${i === mutLine ? alt : 'payload_value_' + i}";`).join('\n');
    const c1 = createCasiIndex();
    c1.ingest(mkLargeBody(2, 'variant_A'), 'a1', 1);
    const e2 = c1.ingest(mkLargeBody(40, 'variant_B'), 'a2', 2);
    expect(e2.changed).toBe(true);
    expect(e2.text).toMatch(/\[fiche cas-(?:delta|slice)/);
  });

  it('Calibration prefix isolation: parent calibration never promotes TEXT_ONLY sub-variants while valid suffixes work', () => {
    const pass = { hexScore: 1, codeScore: 1, numScore: 1, guardScore: 1, overallScore: 1, passed: true };
    setCalibratedProfile({
      model: 'gemini-4',
      band: 'spleen-5x8',
      cols: 312,
      maxHeightPx: 728,
      calibratedAtIso: '2026-11-24T00:00:00Z',
      scores: pass,
      source: 'probe',
    });
    setCalibratedProfile({
      model: 'claude-opus-5',
      band: 'jetbrains-mono-12',
      cols: 112,
      maxHeightPx: 1232,
      calibratedAtIso: '2026-11-24T00:00:00Z',
      scores: pass,
      source: 'probe',
    });

    expect(prefersText('gemini-4-hydrogen', false)).toBe(true);
    expect(readerTier('gemini-4-hydrogen', false)).toBe('text');
    expect(prefersText('gemini-4-neon', false)).toBe(true);
    expect(prefersText('claude-opus-5-5', false)).toBe(true);
    expect(readerTier('claude-opus-5-5', false)).toBe('text');
    expect(getCalibratedProfileMatch('claude-opus-5-20261101')?.exact).toBe(false);
    expect(readerTier('claude-opus-5-20261101', false)).toBe('image');

    setCalibratedProfile({
      model: 'gemini-4-neon',
      band: 'spleen-5x8',
      cols: 312,
      maxHeightPx: 728,
      calibratedAtIso: '2026-11-24T00:00:00Z',
      scores: pass,
      source: 'probe',
    });
    expect(getCalibratedProfileMatch('gemini-4-neon')?.exact).toBe(true);
    expect(readerTier('gemini-4-neon', false)).toBe('image');
  });

  it('P2 regressions: non-resident Markov page omission, scaled mmu-store maxFileBytes, Kosha aliases & DEFAULTS.clientSessionSource', async () => {
    // 1. Markov omits pg_* IDs when store maxBytes rejects oversized pages
    const tinyStore = new ContextPageStore({ maxPages: 8, maxBytes: 128 });
    const bigFail = 'AssertionError fail detail\n' + 'x'.repeat(1600);
    const { blocks } = makeEpochHelper([
      { msgIndex: 1, refId: 'r1', text: bigFail },
      { msgIndex: 2, refId: 'r2', text: bigFail },
      { msgIndex: 3, refId: 'r3', text: bigFail },
      { msgIndex: 4, refId: 'r4', text: 'Tests 4 passed' },
    ]);
    const res = foldMarkovianEpisodes({
      blocks,
      totalMessages: 10,
      keepTailMessages: 4,
      sessionKey: 'tiny-store-s',
      store: tinyStore,
    });
    expect(res.changed).toBe(true);
    const certBlock = blocks.find((b) => b.getText().startsWith('[fiche causal-episode '))?.getText() ?? '';
    expect(certBlock).toContain('archived pages: none');
    expect(certBlock).not.toMatch(/pg_[0-9a-f]{8,}/);

    // 2. fileMmuPersistenceStore honors scaled maxFileBytes
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-mmustore-'));
    tmpDirs.push(dir);
    const mmuFile = path.join(dir, 'mmu-pages.json');
    const bigPayload = JSON.stringify({
      format: 1,
      savedAtMs: Date.now(),
      pages: [
        {
          id: 'pg_0123456789ab',
          sessionKey: 's1',
          refId: 'r1',
          createdAtMs: Date.now(),
          rawText: 'a'.repeat(1_500_000),
          lineCount: 1,
          symbols: [],
          factTokens: [],
        },
      ],
    });
    fs.writeFileSync(mmuFile, bigPayload, 'utf8');
    expect(fileMmuPersistenceStore(mmuFile, { maxFileBytes: 1_048_576 }).load()).toBeUndefined();
    expect(fileMmuPersistenceStore(mmuFile, { maxFileBytes: 4 * 1024 * 1024 }).load()).toBe(bigPayload);

    // 3. Kosha normalizer keeps o1/o3/o4 and strips Vertex @date
    expect(normalizeKoshaModelBase('openai/o1')).toBe('o1');
    expect(normalizeKoshaModelBase('openai/o3-2025-04-16')).toBe('o3');
    expect(normalizeKoshaModelBase('openai/o4')).toBe('o4');
    expect(normalizeKoshaModelBase('google/claude-opus-5-5@20261001')).toBe('claude-opus-5-5');

    // 4. Default clientSessionSource resolves to 'fiche-header'
    const tr = await transformRequest(
      new TextEncoder().encode('{"model":"claude-opus-5-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'),
      { imageCompress: false, clientSessionId: 'default-src-check' },
    );
    expect(tr.info.sessionKeySource).toBe('fiche-header');

    // 5. Transform Google non-error tool output does not trigger spurious hydration
    const cleanReq = {
      contents: [
        { role: 'user', parts: [{ text: 'Check wire' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'src/wire/check.ts' } } }] },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'read_file', response: { content: 'export function cleanOk() { return true; }' } } },
            { text: 'Looks good, continue.' },
          ],
        },
      ],
    };
    const gRes = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(cleanReq)),
      'gemini-4-neon',
      { compress: true, imageCompress: false, textHygiene: 'on', clientSessionId: 'wire-hyd-1', clientSessionSource: 'fiche-header' },
    );
    expect(new TextDecoder().decode(gRes.body)).not.toContain('[fiche vm-hydrate]');

    // 6. Proxy 409 duplicate rejection still passes clean status & body
    let resolveUpstream!: (r: Response) => void;
    const proxy = createProxy({
      upstream: 'https://api.anthropic.com',
      port: 0,
      duplicateHoldMs: 5000,
      fetch: ((url: RequestInfo | URL) => {
        if (String(url).includes('count_tokens')) {
          return Promise.resolve(new Response(JSON.stringify({ input_tokens: 10 }), { status: 200 }));
        }
        return new Promise<Response>((r) => {
          resolveUpstream = r;
        });
      }) as typeof fetch,
    });
    const mkReq = () =>
      new Request('http://127.0.0.1/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fiche-session-id': 'dup-s' },
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
      });
    const p1 = proxy(mkReq());
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await proxy(mkReq());
    expect(r2.status).toBe(409);
    resolveUpstream(new Response(JSON.stringify({ id: 'msg_1', type: 'message', content: [] }), { status: 200 }));
    const r1 = await p1;
    expect(r1.status).toBe(200);
    await transformRequest(new TextEncoder().encode('{"model":"claude-opus-5-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'), {
      imageCompress: false,
    });
  });
});

function makeEpochHelper(items: Array<{ msgIndex: number; refId: string; text: string }>) {
  const state = items.map((x) => ({ ...x }));
  const blocks = state.map((entry) => ({
    msgIndex: entry.msgIndex,
    refId: entry.refId,
    getText: () => entry.text,
    setText: (next: string) => {
      entry.text = next;
    },
  }));
  return { blocks };
}
