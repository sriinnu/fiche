import * as fs from 'node:fs';
import { createServer as createNodeHttpServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { runCalibrationCli } from '../src/calibrate.js';
import {
  clearCalibratedProfiles,
  getCalibratedProfile,
  scoreCalibrationResponse,
  setCalibratedProfile,
} from '../src/core/calibration.js';
import { createCasiIndex } from '../src/core/casi-delta.js';
import {
  ContextPageStore,
  clearStickyMarkovEpisodesForTests,
  computeTailHydration,
  fnv64Hex,
  foldMarkovianEpisodes,
  getGlobalMmuStore,
  linkSessionSkills,
  pruneLowDensityBlob,
  resetGlobalMmuStore,
  type PinnedSkillStore,
} from '../src/core/context-mmu.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import {
  transformOpenAIChatCompletions,
  transformOpenAIResponses,
} from '../src/core/openai.js';
import { createProxy } from '../src/core/proxy.js';
import {
  compileSegmentedStaticText,
  compileToolSchemas,
  factorSharedSchemaSubtrees,
} from '../src/core/schema-compiler.js';
import {
  isSessionCacheCold,
  markCacheDead,
  noteCacheOutcome,
  noteHistoryRequest,
  peekSessionState,
  resetSessionState,
  restoreSessionState,
  serializeSessionState,
} from '../src/core/session-state.js';
import {
  planAndApplyTextEpochs,
  resetTextEpochStickyState,
  type TextEpochBlock,
} from '../src/core/text-history.js';
import { applyAnthropicTextHygiene } from '../src/core/text-hygiene.js';
import { transformRequest } from '../src/core/transform.js';
import { DashboardState, dashboardPath, dispatchDashboard } from '../src/dashboard.js';
import { handleMcpMessage, resetMcpStatsForTests } from '../src/mcp/server.js';
import { fileMmuPersistenceStore, parseMmuCliArgs } from '../src/mmu-store.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const cleanupDirs: string[] = [];
const originalFetch = globalThis.fetch;

function makeTmpDir(prefix = 'fiche-hardening-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function makeMutableBlocks(items: Array<{ msgIndex: number; refId: string; toolName?: string; text: string }>) {
  const state = items.map((item) => ({ ...item }));
  const blocks: TextEpochBlock[] = state.map((entry) => ({
    msgIndex: entry.msgIndex,
    refId: entry.refId,
    toolName: entry.toolName,
    getText: () => entry.text,
    setText: (next: string) => {
      entry.text = next;
    },
  }));
  return { state, blocks };
}

beforeEach(() => {
  resetGlobalMmuStore();
  resetSessionState();
  resetTextEpochStickyState();
  clearStickyMarkovEpisodesForTests();
  clearCalibratedProfiles();
  resetMcpStatsForTests();
});

afterEach(() => {
  setAllowedModelBases(null);
  globalThis.fetch = originalFetch;
  delete process.env.PORT;
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('1. Cross-Session Tenant Isolation & OpenAI Session Anchoring', () => {
  it('strictly scopes ContextPageStore.getPage, derefPage, and computeTailHydration by sessionKey', () => {
    const store = new ContextPageStore();
    const secretCode = [
      '// File: src/tenants/alpha-vault.ts',
      'export function alphaSecretSigningHelper() {',
      '  return "ALPHA_CONFIDENTIAL_TOKEN_VALUE";',
      '}',
    ].join('\n');
    const pageA = store.storePage({
      sessionKey: 'sess-alpha',
      refId: 'src/tenants/alpha-vault.ts',
      rawText: secretCode,
    });

    // Explicit wrong sessionKey must never fall back across keysByPageId.
    expect(store.getPage(pageA.id, 'sess-beta')).toBeNull();
    expect(store.derefPage(pageA.id, { sessionKey: 'sess-beta' })).toBeNull();
    expect(store.getPage(pageA.id, '')).toBeNull();
    expect(store.derefPage(pageA.id, { sessionKey: 'sess-alpha' })?.text).toContain('ALPHA_CONFIDENTIAL');

    // Explicit pg_<id> mention in sess-beta must NOT hydrate sess-alpha page.
    const crossHyd = computeTailHydration({
      store,
      sessionKey: 'sess-beta',
      liveTailTexts: [`Please inspect ${pageA.id} and alphaSecretSigningHelper`],
    });
    expect(crossHyd.changed).toBe(false);
    expect(crossHyd.text).toBe('');

    // Keyless/empty sessionKey fails closed rather than scanning all sessions.
    const keylessHyd = computeTailHydration({
      store,
      sessionKey: '',
      liveTailTexts: [`Read ${pageA.id} and alphaSecretSigningHelper`],
    });
    expect(keylessHyd.changed).toBe(false);
    expect(keylessHyd.slices).toHaveLength(0);
  });

  it('enforces sessionKey, query length caps, cache headers, and unscoped factTokens redaction in dashboard MMU APIs', async () => {
    const store = getGlobalMmuStore();
    const pageA = store.storePage({
      sessionKey: 'tenant-A',
      refId: 'src/a.ts',
      rawText: 'export function alphaHandler() { return "INTERNAL_KEY_ALPHA"; }',
    });
    const dash = new DashboardState();

    // Unscoped /api/mmu/stats omits raw factTokens; scoped /api/mmu/stats retains them.
    const unscopedStats = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/stats')!,
      'GET',
      new URL('http://127.0.0.1:47821/api/mmu/stats'),
      47821,
      async () => '',
    );
    expect(unscopedStats?.status).toBe(200);
    expect(unscopedStats?.headers.get('cache-control')).toBe('no-store');
    expect(unscopedStats?.headers.get('x-content-type-options')).toBe('nosniff');
    const unscopedBody = (await unscopedStats!.json()) as { pages: Array<Record<string, unknown>> };
    expect(unscopedBody.pages[0]).not.toHaveProperty('factTokens');

    const scopedStats = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/stats')!,
      'GET',
      new URL('http://127.0.0.1:47821/api/mmu/stats?sessionKey=tenant-A'),
      47821,
      async () => '',
    );
    const scopedBody = (await scopedStats!.json()) as { pages: Array<Record<string, unknown>> };
    expect(scopedBody.pages[0]).toHaveProperty('factTokens');

    // Cross-tenant /api/mmu/page id & query return 404; oversized query returns 400.
    const crossId = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/page')!,
      'GET',
      new URL(`http://127.0.0.1:47821/api/mmu/page?id=${pageA.id}&sessionKey=tenant-B`),
      47821,
      async () => '',
    );
    expect(crossId?.status).toBe(404);
    expect(crossId?.headers.get('cache-control')).toBe('no-store');

    const longQuery = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/page')!,
      'GET',
      new URL(`http://127.0.0.1:47821/api/mmu/page?query=${'q'.repeat(513)}`),
      47821,
      async () => '',
    );
    expect(longQuery?.status).toBe(400);
  });

  it('strips harness <system-reminder> envelopes in OpenAI Chat & Responses sessionAnchorText hashing', async () => {
    const sharedReminder = '<system-reminder>Workspace rules loaded at 2026-11-23T22:00:00Z</system-reminder>';
    const chatA = await transformOpenAIChatCompletions(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: `${sharedReminder}\nFix billing rounding bug in invoice.ts` }],
      })),
      { compress: true, imageCompress: false },
    );
    const chatB = await transformOpenAIChatCompletions(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: `${sharedReminder}\nRefactor OAuth token exchange in auth.ts` }],
      })),
      { compress: true, imageCompress: false },
    );
    expect(chatA.info.firstUserSha8).toBeTruthy();
    expect(chatB.info.firstUserSha8).toBeTruthy();
    expect(chatA.info.firstUserSha8).not.toBe(chatB.info.firstUserSha8);

    const respA = await transformOpenAIResponses(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `${sharedReminder}\nAudit settlement cron` }],
          },
        ],
      })),
      { compress: true, imageCompress: false },
    );
    const respB = await transformOpenAIResponses(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `${sharedReminder}\nFix TLS ALPN parser` }],
          },
        ],
      })),
      { compress: true, imageCompress: false },
    );
    expect(respA.info.firstUserSha8).toBeTruthy();
    expect(respB.info.firstUserSha8).toBeTruthy();
    expect(respA.info.firstUserSha8).not.toBe(respB.info.firstUserSha8);
  });
});

describe('2. Live User Prompt Preservation & Density Pruner Safeguards', () => {
  it('leaves large (>=4.5 KB) human Turn-1 prompts untouched across all 4 wire transforms by default', async () => {
    const longSpec = [
      '# Architecture Migration RFC',
      ...Array.from({ length: 65 }, (_, i) => `Requirement ${i}: preserve exact SLA invariants and rollback safety without omitting edge case ${i}.`),
    ].join('\n');
    expect(longSpec.length).toBeGreaterThan(4500);

    const antRes = await transformRequest(
      enc.encode(JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: longSpec }],
      })),
      { compress: true, imageCompress: false, textHygiene: 'on' },
    );
    expect((JSON.parse(dec.decode(antRes.body)) as { messages: Array<{ content: string }> }).messages[0]!.content).toBe(longSpec);

    const chatRes = await transformOpenAIChatCompletions(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: longSpec }],
      })),
      { compress: true, imageCompress: false, textHygiene: 'on' },
    );
    expect((JSON.parse(dec.decode(chatRes.body)) as { messages: Array<{ content: string }> }).messages[0]!.content).toBe(longSpec);

    const respRes = await transformOpenAIResponses(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: longSpec }] }],
      })),
      { compress: true, imageCompress: false, textHygiene: 'on' },
    );
    const respText = (JSON.parse(dec.decode(respRes.body)) as { input: Array<{ content: Array<{ text: string }> }> }).input[0]!.content[0]!.text;
    expect(respText).toBe(longSpec);

    const gglRes = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: longSpec }] }],
      })),
      'gemini-4-neon',
      { compress: true, imageCompress: false, textHygiene: 'on' },
    );
    const gglText = (JSON.parse(dec.decode(gglRes.body)) as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0]!.parts[0]!.text;
    expect(gglText).toBe(longSpec);
  });

  it('preserves blank-line-surrounded headings, errors, and stack frames while skipping HTTP JSON & YAML blobs', () => {
    const store = new ContextPageStore();
    const proseWithHeading = [
      '# System Runbook Header',
      'Owner: core-infra',
      'Scope: global',
      'Version: 2.4',
      ...Array.from({ length: 24 }, (_, i) => `Routine compliance summary clause ${i} repeating generic archival review procedures for internal teams.`),
      '',
      '## Breaking Error: ECONNREFUSED',
      '',
      '  at connectLedgerSocket (index.js:42:5)',
      '',
      ...Array.from({ length: 24 }, (_, i) => `Secondary review committee notice ${i} describing quarterly operational audit signoff checklists.`),
      'Footer line 1.',
      'Footer line 2.',
      'Footer line 3.',
      'Footer line 4.',
    ].join('\n');

    const res = pruneLowDensityBlob(proseWithHeading, { store, sessionKey: 's-prose' });
    expect(res.changed).toBe(true);
    expect(res.text).toContain('## Breaking Error: ECONNREFUSED');
    expect(res.text).toContain('at connectLedgerSocket (index.js:42:5)');

    const httpJson = [
      'HTTP/1.1 200 OK',
      'Content-Type: application/json',
      '',
      JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ id: i, value: `v_${i}` })) }, null, 2),
    ].join('\n');
    expect(pruneLowDensityBlob(httpJson, { minChars: 400 }).changed).toBe(false);

    const yamlBlob = Array.from({ length: 50 }, (_, i) => `  service_key_${i}: configured_value_${i}`).join('\n');
    expect(yamlBlob.length).toBeGreaterThan(1200);
    expect(pruneLowDensityBlob(yamlBlob, { minChars: 800 }).changed).toBe(false);
  });
});

describe('3. String-Content User Tail Hydration & OpenAI Chat Prefix Immutability', () => {
  it('preserves appended [fiche vm-hydrate] on string user messages without mutating Turn-0 msg[1] in tool loops', async () => {
    const codeA = [
      '// File: src/ledger/anchor.ts',
      ...Array.from({ length: 185 }, (_, i) =>
        i === 60
          ? 'export function verifyAnchorTokenStrict(tok: string): boolean {\n  return tok.startsWith("anchor_ok_");\n}'
          : `${String(i + 1).padStart(4)}→export const ANCHOR_ROW_${i}_PADDING = "anchor_ledger_constant_value_${i * 11}";`,
      ),
    ].join('\n');
    const logPad = Array.from({ length: 30 }, (_, i) => `2026-11-23T12:00:${String(i).padStart(2, '0')}Z INFO pad=${i}`).join('\n');

    // Anthropic with plain-string final user message
    const antRes = await transformRequest(
      enc.encode(JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Inspect src/ledger/anchor.ts' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'src/ledger/anchor.ts' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: codeA }] },
          { role: 'assistant', content: 'Checking logs.' },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: logPad }] },
          { role: 'assistant', content: 'Ready.' },
          { role: 'user', content: 'Please check verifyAnchorTokenStrict implementation now.' },
        ],
      })),
      { compress: true, imageCompress: false, textHygiene: 'on' },
    );
    const antMsgs = (JSON.parse(dec.decode(antRes.body)) as { messages: Array<{ role: string; content: unknown }> }).messages;
    const antLast = antMsgs[antMsgs.length - 1]!;
    expect(typeof antLast.content).toBe('string');
    expect(antLast.content).toContain('[fiche vm-hydrate]');
    expect(antLast.content).toContain('verifyAnchorTokenStrict');
    expect(antMsgs[0]!.content).toBe('Inspect src/ledger/anchor.ts');

    // OpenAI Chat with tool outputs at tail (must NEVER touch Turn-0 user message at index 0!)
    resetGlobalMmuStore();
    resetSessionState();
    resetTextEpochStickyState();
    const chatRes = await transformOpenAIChatCompletions(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Inspect src/ledger/anchor.ts' }] },
          { role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'tc1', content: codeA },
          { role: 'assistant', tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'tc2', content: logPad },
          { role: 'assistant', tool_calls: [{ id: 'tc3', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'tc3', content: 'Called verifyAnchorTokenStrict with invalid prefix' },
        ],
      })),
      { compress: true, imageCompress: false, textHygiene: 'on' },
    );
    const chatMsgs = (JSON.parse(dec.decode(chatRes.body)) as { messages: Array<{ role: string; content: unknown }> }).messages;
    // Turn-0 message[0] stays byte-identical (still 1 part)!
    expect(chatMsgs[0]!.content).toEqual([{ type: 'text', text: 'Inspect src/ledger/anchor.ts' }]);
    const chatLast = chatMsgs[chatMsgs.length - 1]!;
    expect(typeof chatLast.content).toBe('string');
    expect(chatLast.content).toContain('[fiche vm-hydrate]');
    expect(chatLast.content).toContain('verifyAnchorTokenStrict');

    // OpenAI Responses with final string-content user message
    resetGlobalMmuStore();
    resetSessionState();
    resetTextEpochStickyState();
    const respRes = await transformOpenAIResponses(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect src/ledger/anchor.ts' }] },
          { type: 'function_call', call_id: 'rc1', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output', call_id: 'rc1', output: codeA },
          { type: 'function_call', call_id: 'rc2', name: 'bash', arguments: '{}' },
          { type: 'function_call_output', call_id: 'rc2', output: logPad },
          { type: 'message', role: 'user', content: 'Review verifyAnchorTokenStrict details.' },
        ],
      })),
      { compress: true, imageCompress: false, textHygiene: 'on' },
    );
    const respInput = (JSON.parse(dec.decode(respRes.body)) as { input: Array<{ content?: unknown }> }).input;
    const respLast = respInput[respInput.length - 1]!;
    expect(typeof respLast.content).toBe('string');
    expect(respLast.content).toContain('[fiche vm-hydrate]');
    expect(respLast.content).toContain('verifyAnchorTokenStrict');
  });
});

describe('4. Proxy SSE Cache Liveness, Persistence, justRepacked & markCacheDead Recovery', () => {
  it('propagates upstream cached_tokens through createProxy SSE, clears cacheDead on warm turn, and avoids justRepacked thrash', async () => {
    setAllowedModelBases(['gpt-6-astra']);
    const T0 = Date.now();
    let turnNum = 0;

    globalThis.fetch = (async () => {
      turnNum += 1;
      const ssePayload = [
        'data: {"id":"resp_1","type":"response.created","response":{"id":"resp_1","model":"gpt-6-astra"}}',
        `data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-6-astra","usage":{"input_tokens":5000,"output_tokens":40,"input_tokens_details":{"cached_tokens":${turnNum === 2 ? 0 : 4200}}}}}`,
        '',
      ].join('\n\n');
      return new Response(ssePayload, {
        status: turnNum === 2 ? 413 : 200,
        headers: { 'content-type': turnNum === 2 ? 'application/json' : 'text/event-stream' },
      });
    }) as typeof fetch;

    const waitUntilPromises: Promise<unknown>[] = [];
    const proxy = createProxy({
      upstream: 'https://api.anthropic.com',
      openAIUpstream: 'https://api.openai.com',
      waitUntil: (p) => waitUntilPromises.push(p),
    });

    const mkReq = (prompt: string) =>
      new Request('http://127.0.0.1:47821/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        body: JSON.stringify({
          model: 'gpt-6-astra',
          stream: true,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        }),
      });

    // Turn 1: SSE 200 with cached_tokens: 4200 -> sessionState persisted with lastSeenMs > 0
    const res1 = await proxy(mkReq('Analyze settlement ledger in src/settlement.ts'));
    await res1.text();
    await Promise.allSettled(waitUntilPromises);
    const snap = JSON.parse(serializeSessionState(Date.now())) as { sessions: Array<{ key: string; everCacheAlive: boolean }> };
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]!.everCacheAlive).toBe(true);
    const sk = snap.sessions[0]!.key;

    // Turn 2: 413 sets cacheDead = true -> isSessionCacheCold is true
    const res2 = await proxy(mkReq('Analyze settlement ledger in src/settlement.ts'));
    await res2.text();
    await Promise.allSettled(waitUntilPromises);
    expect(peekSessionState(sk)?.cacheDead).toBe(true);
    expect(isSessionCacheCold(sk, T0 + 1000)).toBe(true);

    // Turn 3: warm 200 SSE with cached_tokens: 4200 clears cacheDead via noteHistoryRequest/noteCacheOutcome!
    const res3 = await proxy(mkReq('Analyze settlement ledger in src/settlement.ts'));
    await res3.text();
    await Promise.allSettled(waitUntilPromises);
    expect(peekSessionState(sk)?.cacheDead).toBe(false);
    expect(isSessionCacheCold(sk, T0 + 2000)).toBe(false);

    // Implicit cache (cacheCreateTokens === undefined) on Turn N+1 right after justRepacked L2 cold repack must NOT thrash cold!
    resetSessionState();
    noteHistoryRequest('implicit-sess', T0);
    noteCacheOutcome('implicit-sess', 4000, 0);
    noteCacheOutcome('implicit-sess', 0, 0); // now cold
    expect(isSessionCacheCold('implicit-sess', T0 + 300)).toBe(true);
    noteHistoryRequest('implicit-sess', T0 + 400); // simulates L2 repack setting justRepacked=true
    noteCacheOutcome('implicit-sess', 0, undefined); // implicit cache misses read on repack turn
    expect(peekSessionState('implicit-sess')?.lastCacheAlive).toBeUndefined();
    expect(isSessionCacheCold('implicit-sess', T0 + 600)).toBe(false);
  });
});

describe('5. LSM-Context Zero Oscillation & Sticky Key Isolation', () => {
  it('never oscillates L1->L0 or L2->Warm across cutoffMsg and isolates identical prefix/suffix blocks by hash+session', () => {
    const mkBody = (tag: string) =>
      [
        `// File: src/mod_${tag}.ts`,
        ...Array.from({ length: 170 }, (_, i) => `2026-11-23T12:00:00Z INFO [${tag}] row=${i} payload_marker_step_${i}`),
      ].join('\n');

    const blockA = mkBody('alpha');
    const blockB = mkBody('beta');
    const blockC = mkBody('gamma');

    // Turn T: totalMessages=8, cutoffMsg=2, cutoffL1=6 -> A(msg2) & B(msg4) are both in l1Zone (~2,200 tok each)
    const t0Items = [
      { msgIndex: 2, refId: 'r_a', text: blockA },
      { msgIndex: 4, refId: 'r_b', text: blockB },
    ];
    const t0 = makeMutableBlocks(t0Items);
    const r0 = planAndApplyTextEpochs({
      blocks: t0.blocks,
      totalMessages: 8,
      keepTailMessages: 6,
      lsmEditTailMessages: 2,
      lsmMinLargeBlockTokens: 1500,
      model: 'claude-opus-4-6',
      totalPromptTokens: 6000,
      sessionKey: 'sess-osc',
      enableLsm: true,
    });
    expect(r0.changed).toBe(true);
    const aDigest0 = t0.state[0]!.text;
    const bDigest0 = t0.state[1]!.text;
    expect(aDigest0).toMatch(/^\[fiche epoch-digest/);
    expect(bDigest0).toMatch(/^\[fiche epoch-digest/);

    // Turn T+1: totalMessages=10, cutoffMsg=4 -> A moves to agedEligible while B stays in l1Zone!
    // Must stay byte-identical (no revert A->verbatim->compacted!).
    const t1 = makeMutableBlocks([...t0Items, { msgIndex: 6, refId: 'r_c', text: blockC }]);
    planAndApplyTextEpochs({
      blocks: t1.blocks,
      totalMessages: 10,
      keepTailMessages: 6,
      lsmEditTailMessages: 2,
      lsmMinLargeBlockTokens: 1500,
      model: 'claude-opus-4-6',
      totalPromptTokens: 9000,
      sessionKey: 'sess-osc',
      enableLsm: true,
    });
    expect(t1.state[0]!.text).toBe(aDigest0);
    expect(t1.state[1]!.text).toBe(bDigest0);

    // L2 Cold Repack multi-block transition across cutoffMsg into Warm turn stays byte-identical too!
    const l2A = mkBody('l2_a');
    const l2B = mkBody('l2_b');
    const l2Run = makeMutableBlocks([
      { msgIndex: 4, refId: 'l2_1', text: l2A },
      { msgIndex: 6, refId: 'l2_2', text: l2B },
    ]);
    planAndApplyTextEpochs({
      blocks: l2Run.blocks,
      totalMessages: 9,
      keepTailMessages: 4,
      lsmEditTailMessages: 2,
      epochTokenTarget: 20_000, // force multi-block pending flush on coldRepack
      model: 'claude-opus-4-6',
      totalPromptTokens: 8000,
      sessionKey: 'sess-l2-warm',
      sessionCacheCold: true,
      enableLsm: true,
    });
    const l2DigA = l2Run.state[0]!.text;
    const l2DigB = l2Run.state[1]!.text;
    expect(l2DigA).toMatch(/^\[fiche epoch-digest/);
    expect(l2DigB).toMatch(/^\[fiche epoch-digest/);

    // Now cutoffMsg advances to 5 on a WARM turn: l2_1 (msg 4) is in agedEligible, l2_2 (msg 6) in l1Zone!
    const warmAfterL2 = makeMutableBlocks([
      { msgIndex: 4, refId: 'l2_1', text: l2A },
      { msgIndex: 6, refId: 'l2_2', text: l2B },
    ]);
    planAndApplyTextEpochs({
      blocks: warmAfterL2.blocks,
      totalMessages: 10,
      keepTailMessages: 5,
      lsmEditTailMessages: 2,
      epochTokenTarget: 20_000,
      model: 'claude-opus-4-6',
      totalPromptTokens: 250_000,
      sessionKey: 'sess-l2-warm',
      sessionCacheCold: false,
      enableLsm: true,
    });
    expect(warmAfterL2.state[0]!.text).toBe(l2DigA);
    expect(warmAfterL2.state[1]!.text).toBe(l2DigB);
  });
});

describe('6. Markovian Episode Folding Hardening', () => {
  it('anchors at first FAIL, writes certificate into longest predecessor, skips tiny blocks, avoids store pollution on rejected payback, and persists across restart', () => {
    const store = new ContextPageStore();
    const preRead = '// File: src/boot.ts\n' + 'pre-failure config context '.repeat(60);
    const smallStep = 'short retry 1';
    const failShort = 'FAIL tests/x.test.ts\nAssertionError: mismatch\n' + 'err '.repeat(350);
    const hugeTrace = 'Traceback / stack trace detail\n' + 'stack frame line '.repeat(450);
    const fixStep = '// File: src/x.ts\nexport function fixed() { return 1; }\n' + 'patch line '.repeat(140);
    const green = 'Test Files 1 passed (1)\nTests 10 passed (10)\n0 failed';

    // Warm huge downstream -> payback fails -> ContextPageStore must remain EMPTY (0 pagesStored)!
    const rejected = makeMutableBlocks([
      { msgIndex: 1, refId: 'f1', text: failShort },
      { msgIndex: 2, refId: 'f2', text: hugeTrace },
      { msgIndex: 3, refId: 'f3', text: fixStep },
      { msgIndex: 4, refId: 'cp', text: green },
      { msgIndex: 5, refId: 'down', text: 'cached downstream '.repeat(6000) },
    ]);
    const rejRes = foldMarkovianEpisodes({
      blocks: rejected.blocks,
      totalMessages: 8,
      keepTailMessages: 2,
      sessionKey: 's-mk-rej',
      model: 'claude-opus-4-6',
      sessionCacheCold: false,
      store,
    });
    expect(rejRes.changed).toBe(false);
    expect(store.getStats().pagesStored).toBe(0);

    // Accepted episode (with preRead before FAIL and tiny smallStep inside FAIL->green):
    const acc = makeMutableBlocks([
      { msgIndex: 1, refId: 'pre', text: preRead },
      { msgIndex: 2, refId: 'f1', text: failShort },
      { msgIndex: 3, refId: 'tiny', text: smallStep },
      { msgIndex: 4, refId: 'big', text: hugeTrace },
      { msgIndex: 5, refId: 'f3', text: fixStep },
      { msgIndex: 6, refId: 'cp', text: green },
    ]);
    const accRes = foldMarkovianEpisodes({
      blocks: acc.blocks,
      totalMessages: 9,
      keepTailMessages: 2,
      sessionKey: 's-mk-acc',
      model: 'claude-opus-4-6',
      sessionCacheCold: false,
      store,
    });
    expect(accRes.changed).toBe(true);
    expect(acc.state[0]!.text).toBe(preRead); // Pre-failure exploration preserved verbatim
    expect(acc.state[2]!.text).toBe(smallStep); // Tiny block untouched (avoid continuation bloat)
    expect(acc.state[3]!.text).toMatch(/^\[fiche causal-episode ep_/); // Certificate in longest pred
    expect(acc.state[1]!.text).toMatch(/^\[folded into ep_/);

    // Simulate proxy restart via serializeSessionState -> clear sticky -> restoreSessionState:
    const persisted = serializeSessionState();
    resetSessionState();
    clearStickyMarkovEpisodesForTests();
    restoreSessionState(persisted);

    const replayWithDownstream = makeMutableBlocks([
      { msgIndex: 1, refId: 'pre', text: preRead },
      { msgIndex: 2, refId: 'f1', text: failShort },
      { msgIndex: 3, refId: 'tiny', text: smallStep },
      { msgIndex: 4, refId: 'big', text: hugeTrace },
      { msgIndex: 5, refId: 'f3', text: fixStep },
      { msgIndex: 6, refId: 'cp', text: green },
      { msgIndex: 7, refId: 'down', text: 'cached downstream '.repeat(6000) },
    ]);
    const replayRes = foldMarkovianEpisodes({
      blocks: replayWithDownstream.blocks,
      totalMessages: 10,
      keepTailMessages: 2,
      sessionKey: 's-mk-acc',
      model: 'claude-opus-4-6',
      sessionCacheCold: false,
    });
    // Because episode ID persisted in session-state.ts, huge downstream STILL stays sealed & byte-identical!
    expect(replayRes.changed).toBe(true);
    expect(replayWithDownstream.state[3]!.text).toBe(acc.state[3]!.text);
  });
});

describe('7. CASI v2, Schema-Compiler, Calibration, Skill Linker, & Optical Guarantees', () => {
  it('CASI v2 distinguishes guttered/code numeric durations, handles trailing newlines, and matches Write->Read', () => {
    const casi = createCasiIndex();
    const linesA = Array.from({ length: 24 }, (_, i) => `${String(i + 1).padStart(4)}→const latency_${i} = ${10 + i};`).join('\n') + '\n';
    const linesB = Array.from({ length: 24 }, (_, i) => `${String(i + 1).padStart(4)}→const latency_${i} = ${200 + i};`).join('\n') + '\n';
    expect(casi.ingest(linesA, 'r1', 1).changed).toBe(false);
    // Different numeric values inside code/guttered lines MUST NOT falsely match!
    const diffRes = casi.ingest(linesB, 'r2', 2);
    expect(diffRes.changed).toBe(false);
    expect(diffRes.text).toBe(linesB);

    // Unguttered Write seed matches guttered Read exact_dup!
    const casiSeed = createCasiIndex();
    const rawCode = Array.from({ length: 24 }, (_, i) => `export const row_${i} = ${i * 3};`).join('\n');
    const gutterRead = Array.from({ length: 24 }, (_, i) => `${String(i + 1).padStart(4)}→export const row_${i} = ${i * 3};`).join('\n');
    casiSeed.seedBase(rawCode, 'write_1', 1);
    const matchRead = casiSeed.ingest(gutterRead, 'read_2', 2);
    expect(matchRead.changed).toBe(true);
    expect(matchRead.kind).toBe('exact_dup');
  });

  it('keeps Google Optical active tail diffs verbatim (no orphan CASI pointers into PNGs) and keeps contents[0] immutable between segment seals', async () => {
    setCalibratedProfile({
      model: 'gemini-4-neon',
      band: 'spleen-5x8',
      cols: 312,
      maxHeightPx: 728,
      calibratedAtIso: '2026-11-23T20:00:00Z',
      scores: { hexScore: 1, codeScore: 1, numScore: 1, guardScore: 1, overallScore: 1, passed: true },
      source: 'probe',
    });

    const activeDiff = [
      'diff --git a/src/verify.ts b/src/verify.ts',
      '--- a/src/verify.ts',
      '+++ b/src/verify.ts',
      '@@ -1,5 +1,5 @@',
      ...Array.from({ length: 26 }, (_, i) => `+export const chk_${i} = ${i};`),
    ].join('\n');

    const contents: Array<Record<string, unknown>> = [
      { role: 'user', parts: [{ text: 'Debug verify.ts across 18 turns' }] },
    ];
    for (let t = 1; t <= 18; t++) {
      contents.push({ role: 'model', parts: [{ functionCall: { name: 'bash', args: { step: t } } }] });
      const textBody =
        t === 10 || t === 17 || t === 18
          ? activeDiff
          : Array.from({ length: 85 }, (_, k) => `2026-11-23T12:${String(t).padStart(2, '0')}:00Z INFO batch_${t}_line=${k} worker=payments-settlement-alpha status=ok`).join('\n');
      contents.push({
        role: 'user',
        parts: [
          { functionResponse: { name: 'bash', response: { output: textBody } } },
          { text: `Continue step ${t}` },
        ],
      });
    }

    const r17 = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify({ contents: contents.slice(0, 35) })),
      'gemini-4-neon',
      { compress: true, imageCompress: true, textHygiene: 'on' },
    );
    const p17 = JSON.parse(dec.decode(r17.body)) as { contents: unknown[] };

    const r18 = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify({ contents })),
      'gemini-4-neon',
      { compress: true, imageCompress: true, textHygiene: 'on' },
    );
    const p18 = JSON.parse(dec.decode(r18.body)) as { contents: Array<{ parts?: Array<{ functionResponse?: { response?: { output?: string } } }> }> };

    // contents[0] stays immutable when no new optical segment sealed, AND last turn keeps activeDiff verbatim!
    expect(p17.contents.length).toBeGreaterThan(2);
    expect(r18.info.imageCount).toBeGreaterThan(0);
    const lastTurnJson = JSON.stringify(p18.contents[p18.contents.length - 1]);
    expect(lastTurnJson).toContain('+export const chk_25 = 25;');
    expect(lastTurnJson).not.toContain('[fiche cas:');

    // Also verify contents[0] immutability between consecutive short-turn appends after first collapse:
    const contentsNext = [
      ...contents,
      { role: 'model', parts: [{ functionCall: { name: 'bash', args: { step: 19 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'bash', response: { output: 'short ok' } } }, { text: 'Step 19' }] },
    ];
    const r19 = await transformGoogleGenerateContent(
      enc.encode(JSON.stringify({ contents: contentsNext })),
      'gemini-4-neon',
      { compress: true, imageCompress: true, textHygiene: 'on' },
    );
    const p19 = JSON.parse(dec.decode(r19.body)) as { contents: unknown[] };
    expect(JSON.stringify(p19.contents[0])).toBe(JSON.stringify(p18.contents[0]));
  });

  it('schema-compiler preserves fenced code/backticks, guards #/ refs & strict tools, and hoists Draft-07 definitions safely', () => {
    const repeatedPara = 'Mandatory compliance instruction paragraph repeated cleanly across sections for architectural consistency and deterministic audit trails.';
    const fenceBlock = ['```ts', repeatedPara, '```'].join('\n');
    const inlineSpan = '`' + repeatedPara + '`';
    const doc = `${repeatedPara}\n\n${fenceBlock}\n\n${inlineSpan}\n\n${repeatedPara}`;
    const comp = compileSegmentedStaticText(doc);
    // Code fence and inline backtick span must remain untouched verbatim!
    expect(comp.text).toContain(fenceBlock);
    expect(comp.text).toContain(inlineSpan);

    // Unsafe #/ internal JSON pointer targeting inlined property is left untouched even with duplicate subtrees:
    const sub = {
      type: 'object',
      description: 'Reusable payload metadata block with sufficient characters to trigger hoisting threshold when duplicated across fields cleanly.',
      properties: { id: { type: 'string' }, ts: { type: 'string' } },
    };
    const unsafeTool = {
      type: 'object',
      properties: {
        a: structuredClone(sub),
        b: structuredClone(sub),
        refField: { $ref: '#/properties/a' },
      },
    };
    expect(factorSharedSchemaSubtrees(unsafeTool)).toBe(false);

    // Draft-07 `definitions` hoists cleanly, and `strict: true` Anthropic tools are skipped:
    const draft07 = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { a: structuredClone(sub), b: structuredClone(sub) },
    };
    expect(factorSharedSchemaSubtrees(draft07)).toBe(true);
    expect(draft07).toHaveProperty('definitions._f1');

    const tools = [
      {
        name: 'strict_tool',
        strict: true,
        input_schema: {
          type: 'object',
          properties: { a: structuredClone(sub), b: structuredClone(sub) },
        },
      },
    ];
    compileToolSchemas('anthropic', tools);
    expect(tools[0]!.input_schema).not.toHaveProperty('$defs');
  });

  it('enforces calibration prefix delimiter boundaries, GUARDS_OK fail-closed, ANTHROPIC_AUTH_TOKEN, and skillLinker safeguards', async () => {
    setCalibratedProfile({
      model: 'gemini-4-neon',
      band: 'spleen-5x8',
      cols: 312,
      maxHeightPx: 728,
      calibratedAtIso: '2026-11-23T20:00:00Z',
      scores: { hexScore: 1, codeScore: 1, numScore: 1, guardScore: 1, overallScore: 1, passed: true },
      source: 'probe',
    });
    expect(getCalibratedProfile('gemini-4-neon')?.band).toBe('spleen-5x8');
    expect(getCalibratedProfile('gemini-4-neon2')).toBeUndefined();

    const probeScores = scoreCalibrationResponse(
      JSON.stringify({
        HEX_0: 'a1b2c3d4e5f6',
        CODE_0: 'verifyLedgerSignatureStrict',
        NUM_0: '18432.75',
        GUARDS_OK: 'false',
      }),
      {
        band: 'spleen-5x8',
        cols: 312,
        maxHeightPx: 728,
        pngBytes: new Uint8Array(),
        promptText: '',
        expectedHex: ['a1b2c3d4e5f6'],
        expectedCode: ['verifyLedgerSignatureStrict'],
        expectedNums: ['18432.75'],
        forbiddenGuards: ['DROP_SENTINEL_ALPHA'],
        selfVerified: true,
        estimatedImageTokens: 100,
      },
    );
    expect(probeScores.guardScore).toBe(0);
    expect(probeScores.passed).toBe(false);

    // calibrate.ts ANTHROPIC_AUTH_TOKEN Bearer auth
    let seenAuth = '';
    const calPath = path.join(makeTmpDir(), 'cal.json');
    await runCalibrationCli(
      ['claude-opus-5-5', '--provider', 'anthropic', '--band', 'jetbrains-mono-12', '--json'],
      {
        filePath: calPath,
        env: { ANTHROPIC_AUTH_TOKEN: 'oauth-token-xyz' },
        fetchImpl: (async (_url, init) => {
          seenAuth = new Headers(init?.headers).get('authorization') ?? '';
          return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }), { status: 200 });
        }) as typeof fetch,
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(seenAuth).toBe('Bearer oauth-token-xyz');

    // linkSessionSkills: ignores non-skill parenthetical bullet lists, requires store, and hydrates single-word skills!
    const store = new ContextPageStore();
    const pinnedMap = new Map<string, readonly string[]>();
    const pinned: PinnedSkillStore = {
      get: (k, h) => pinnedMap.get(`${k}:${h}`),
      set: (k, h, v) => {
        pinnedMap.set(`${k}:${h}`, v);
      },
    };
    const errorCodeList = [
      'API Error Codes:',
      ...Array.from({ length: 16 }, (_, i) => `- ERR_CODE_${i} (HTTP 50${i % 5}): Operational failure handler step and retry documentation for error ${i}.`),
    ].join('\n');
    expect(
      linkSessionSkills({ text: errorCodeList, firstUserText: 'debug', sessionKey: 's-nsk', store, pinnedStore: pinned }).changed,
    ).toBe(false);
    expect(pinnedMap.size).toBe(0);

    // Single-word skill (`kubernetes`) stubs when long catalog qualifies, pins AFTER threshold, and hydrates on bare word!
    const realSkills = [
      '<skills>',
      '- kubernetes (/skills/kubernetes/SKILL.md): Orchestrate pods, deployments, services, ConfigMaps, Secrets, Ingresses, and rollout health checks cleanly across clusters with pre-flight quota verification and namespace RBAC safety audits.',
      ...Array.from({ length: 14 }, (_, i) => `- skill-item-${i} (/skills/skill-item-${i}/SKILL.md): Comprehensive operational workflow guidance, validation gates, schema verification rules, pre-flight credential checks, and rollback procedures for skill-item-${i} across distributed production clusters.`),
      '</skills>',
    ].join('\n');
    const skillRes = linkSessionSkills({
      text: realSkills,
      firstUserText: 'Work on skill-item-0 only',
      sessionKey: 's-single',
      store,
      pinnedStore: pinned,
      maxVerbatim: 1,
    });
    expect(skillRes.changed).toBe(true);
    expect(skillRes.stubbedSkills).toContain('kubernetes');
    const hydSingle = computeTailHydration({
      store,
      sessionKey: 's-single',
      liveTailTexts: ['Please use the kubernetes skill to inspect CrashLoopBackOff pods'],
      recentVerbatimTexts: [skillRes.text],
    });
    expect(hydSingle.changed).toBe(true);
    expect(hydSingle.text).toContain('Orchestrate pods, deployments, services');
  });

  it('respects enableMmu: false in text-hygiene without touching MMU store', () => {
    const store = new ContextPageStore();
    const blob = [
      '# Long Reference',
      ...Array.from({ length: 65 }, (_, i) => `Archival line ${i} documenting generic compliance review cycles across distributed teams.`),
    ].join('\n');
    applyAnthropicTextHygiene(
      {
        model: 'claude-opus-5-5',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'search_web', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: blob }] },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'next' },
        ],
      },
      { deepTextCompact: true, enableMmu: false, mmuStore: store, sessionKey: 's-off' },
    );
    expect(store.getStats().pagesStored).toBe(0);
  });
});

describe('8. Persistence Redaction/TTL, CLI Strictness, & MCP Daemon Fallback', () => {
  it('enforces 24h TTL, secret skipping, and 32 MiB size limit on MMU persistence', () => {
    const T0 = 1_760_000_000_000;
    const store = new ContextPageStore();
    store.storePage({ sessionKey: 's1', refId: 'safe', rawText: 'export const OK = 1;\n'.repeat(5), nowMs: T0 });
    const syntheticOpenAiKey = ['sk-proj-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
    store.storePage({
      sessionKey: 's1',
      refId: 'secret-sk',
      rawText: `OPENAI_API_KEY=${syntheticOpenAiKey}`,
      nowMs: T0,
    });
    const syntheticPemHeader = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');
    const syntheticPemFooter = ['-----END ', 'RSA PRIVATE KEY-----'].join('');
    store.storePage({
      sessionKey: 's1',
      refId: 'secret-pem',
      rawText: `${syntheticPemHeader}\nMIIEowIBAAKCAQEA...\n${syntheticPemFooter}`,
      nowMs: T0,
    });
    store.storePage({ sessionKey: 's1', refId: 'expired', rawText: 'old text content', nowMs: T0 - 25 * 60 * 60 * 1000 });

    const serialized = store.serialize(T0);
    expect(serialized).toContain('export const OK = 1;');
    expect(serialized).not.toContain(syntheticOpenAiKey);
    expect(serialized).not.toContain(['BEGIN ', 'RSA PRIVATE KEY'].join(''));
    expect(serialized).not.toContain('old text content');

    const restoredStore = new ContextPageStore();
    expect(restoredStore.restore(serialized, T0)).toBe(1);

    // 32 MiB cap in fileMmuPersistenceStore.load()
    const oversizedPath = path.join(makeTmpDir(), 'huge-mmu.json');
    fs.writeFileSync(oversizedPath, ' ', 'utf8');
    fs.truncateSync(oversizedPath, 33 * 1024 * 1024);
    expect(fileMmuPersistenceStore(oversizedPath).load()).toBeUndefined();
  });

  it('validates fiche mmu CLI flags strictly and falls back to daemon on local page_in miss', async () => {
    expect(parseMmuCliArgs(['--help'])).toEqual({ ok: true, help: true });
    expect(parseMmuCliArgs(['bogus']).ok).toBe(false);
    expect(parseMmuCliArgs(['page', '--badflag']).ok).toBe(false);
    expect(parseMmuCliArgs(['page']).ok).toBe(false);
    expect(parseMmuCliArgs(['stats', '--port', '99999']).ok).toBe(false);
    const okParsed = parseMmuCliArgs(['page', 'pg_abc123456789', '--session=s-cli', '--json'], 'not-a-number');
    expect(okParsed).toEqual({
      ok: true,
      help: false,
      sub: 'page',
      asJson: true,
      port: 47821,
      query: undefined,
      pageId: 'pg_abc123456789',
      sessionKey: 's-cli',
    });

    // Populate local MCP store with ONE page so store.listPages() is non-empty,
    // then request a DIFFERENT pageId that lives only on the mock daemon.
    const store = new ContextPageStore();
    void store; // test uses global MMU store inside handleMcpMessage
    const localPage = (await import('../src/core/context-mmu.js')).getGlobalMmuStore().storePage({
      sessionKey: 'sess-local',
      refId: 'local.ts',
      rawText: 'export const localVal = 1;',
    });
    expect(localPage.id).toMatch(/^pg_/);

    let capturedSession = '';
    const srv = createNodeHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      capturedSession = url.searchParams.get('sessionKey') ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        pageId: 'pg_feedfacedead',
        startLine: 1,
        endLine: 1,
        text: 'from daemon fallback',
      }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const addr = srv.address() as { port: number };
      process.env.PORT = String(addr.port);

      const missFallback = await handleMcpMessage({
        jsonrpc: '2.0',
        id: 77,
        method: 'tools/call',
        params: {
          name: 'page_in',
          arguments: { pageId: 'pg_feedfacedead', sessionKey: 'sess-remote' },
        },
      }) as { result: { isError: boolean; structuredContent: { source: string; text: string } } };

      expect(missFallback.result.isError).toBe(false);
      expect(missFallback.result.structuredContent.source).toBe('daemon');
      expect(missFallback.result.structuredContent.text).toBe('from daemon fallback');
      expect(capturedSession).toBe('sess-remote');

      const badFloat = await handleMcpMessage({
        jsonrpc: '2.0',
        id: 78,
        method: 'tools/call',
        params: { name: 'page_in', arguments: { pageId: localPage.id, startLine: 1.5 } },
      }) as { result: { isError: boolean } };
      expect(badFloat.result.isError).toBe(true);

      const badLen = await handleMcpMessage({
        jsonrpc: '2.0',
        id: 79,
        method: 'tools/call',
        params: { name: 'page_in', arguments: { query: 'x'.repeat(513) } },
      }) as { result: { isError: boolean } };
      expect(badLen.result.isError).toBe(true);

      // Verify UTF-8 fnv64Hex injects '→' (U+2192) distinctly from Latin-1 "\x92!"
      expect(fnv64Hex('\u2192')).not.toBe(fnv64Hex('\x92!'));
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('9. Post-Audit Core, Security, MCP & Calibration Hardening', () => {
  it('preserves justRepacked implicit-cache grace on bridged /v1/messages -> OpenAI routes', async () => {
    setAllowedModelBases(['gpt-6-astra', 'claude-fable-5', 'gemini']);
    const waitUntilPromises: Promise<unknown>[] = [];
    let callNum = 0;

    globalThis.fetch = (async () => {
      callNum += 1;
      const payload = {
        id: `resp_${callNum}`,
        object: 'response',
        model: 'gpt-6-astra',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: {
          input_tokens: 2400,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: callNum === 1 ? 1800 : 0 },
        },
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const proxy = createProxy({
      upstream: 'https://api.anthropic.com',
      openAIUpstream: 'https://api.openai.com',
      openAIApiKey: 'sk-openai-test',
      openAIModels: ['gpt-6-astra'],
      waitUntil: (p) => waitUntilPromises.push(p),
    });

    const mkReq = () =>
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
        body: JSON.stringify({
          model: 'gpt-6-astra',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Audit payment settlement pipeline' }],
        }),
      });

    const r1 = await proxy(mkReq());
    expect(r1.status).toBe(200);
    await r1.text();
    await Promise.allSettled(waitUntilPromises.splice(0));
    const snap = JSON.parse(serializeSessionState(Date.now())) as {
      sessions: Array<{ key: string; everCacheAlive: boolean }>;
    };
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]!.everCacheAlive).toBe(true);
    const sk = snap.sessions[0]!.key;

    // Simulate upstream cache expiry (cacheDead=true) before Turn 2 triggers cold repack.
    markCacheDead(sk);
    expect(isSessionCacheCold(sk)).toBe(true);
    expect(peekSessionState(sk)?.cacheDead).toBe(true);

    // Turn 2 clears cacheDead + sets justRepacked=true inside noteHistoryRequest(),
    // then receives bridged cached_tokens=0 + synthesized cache_creation_input_tokens=0.
    // Proxy must omit synthesized cacheCreateTokens so justRepacked stays protected (not lastCacheAlive=false).
    const r2 = await proxy(mkReq());
    expect(r2.status).toBe(200);
    await r2.text();
    await Promise.allSettled(waitUntilPromises.splice(0));
    expect(peekSessionState(sk)?.justRepacked).toBe(false);
    expect(peekSessionState(sk)?.lastCacheAlive).toBeUndefined();
    expect(isSessionCacheCold(sk)).toBe(false);
  });

  it('keeps canonical pre-hygiene firstUserSha8 when cleanUserPayloads shrinks Turn-1 user prompts', async () => {
    const dirtyLines = Array.from(
      { length: 40 },
      (_, i) => `\x1b[32m[INFO]\x1b[0m   Audit checklist item ${i}: verify settlement batch execution cleanly.`,
    ).join('\n');
    expect(dirtyLines.length).toBeGreaterThan(2000);

    const antRaw = await transformRequest(
      enc.encode(JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: dirtyLines }],
      })),
      { compress: true, imageCompress: false, cleanUserPayloads: false },
    );
    const antClean = await transformRequest(
      enc.encode(JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: dirtyLines }],
      })),
      { compress: true, imageCompress: false, textHygiene: 'on', cleanUserPayloads: true },
    );
    expect(antClean.info.firstUserSha8).toBe(antRaw.info.firstUserSha8);

    const chatRaw = await transformOpenAIChatCompletions(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: dirtyLines }],
      })),
      { compress: true, imageCompress: false, cleanUserPayloads: false },
    );
    const chatClean = await transformOpenAIChatCompletions(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: dirtyLines }],
      })),
      { compress: true, imageCompress: false, textHygiene: 'on', cleanUserPayloads: true },
    );
    expect(chatClean.info.firstUserSha8).toBe(chatRaw.info.firstUserSha8);

    const respRaw = await transformOpenAIResponses(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: dirtyLines }] }],
      })),
      { compress: true, imageCompress: false, cleanUserPayloads: false },
    );
    const respClean = await transformOpenAIResponses(
      enc.encode(JSON.stringify({
        model: 'gpt-6-astra',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: dirtyLines }] }],
      })),
      { compress: true, imageCompress: false, textHygiene: 'on', cleanUserPayloads: true },
    );
    expect(respClean.info.firstUserSha8).toBe(respRaw.info.firstUserSha8);
  });

  it('fails closed on empty/whitespace sessionKey across Core MMU, MCP, HTTP API, TTL restore, and oversized prune', async () => {
    const store = new ContextPageStore({ maxBytes: 1024 });
    const p1 = store.storePage({ sessionKey: 'tenant-1', refId: 'a.ts', rawText: 'export const alphaToken = 1;', nowMs: 1_760_000_000_000 });
    expect(store.listPages('   ')).toEqual([]);
    expect(store.listPages('')).toEqual([]);
    expect(store.searchPages('alphaToken', '  ')).toEqual([]);
    expect(store.searchPages('alphaToken', '')).toEqual([]);
    expect(store.listPages('tenant-1')).toHaveLength(1);
    expect(p1.id).toMatch(/^pg_/);

    // Oversized blob > maxBytes must NOT emit dangling pg_* marker or bump densityPrunedBlocks
    const oversizedBlob = Array.from(
      { length: 65 },
      (_, i) => `Generic archival log filler item number ${i} repeated across distributed audit checkpoints.`,
    ).join('\n');
    expect(oversizedBlob.length).toBeGreaterThan(2048);
    const pruneOversized = pruneLowDensityBlob(oversizedBlob, { store, sessionKey: 'tenant-1', refId: 'big-blob' });
    expect(pruneOversized.changed).toBe(false);
    expect(store.getStats().densityPrunedBlocks).toBe(0);

    // Restore drops records missing positive finite createdAtMs
    const forgedJson = JSON.stringify({
      format: 1,
      savedAtMs: 1_760_000_000_000,
      pages: [
        { id: 'pg_000011112222', sessionKey: 'tenant-1', refId: 'bad', createdAtMs: 0, rawText: 'zero timestamp bypass' },
        { id: 'pg_000011113333', sessionKey: 'tenant-1', refId: 'bad2', createdAtMs: -5, rawText: 'negative timestamp bypass' },
      ],
    });
    expect(new ContextPageStore().restore(forgedJson, 1_900_000_000_000)).toBe(0);

    // MCP rejects empty/whitespace sessionKey on page_in & mmu_stats
    const mcpPageIn = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 91,
      method: 'tools/call',
      params: { name: 'page_in', arguments: { pageId: p1.id, sessionKey: '   ' } },
    }) as { result: { isError: boolean } };
    expect(mcpPageIn.result.isError).toBe(true);

    const mcpStats = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 92,
      method: 'tools/call',
      params: { name: 'mmu_stats', arguments: { sessionKey: '' } },
    }) as { result: { isError: boolean } };
    expect(mcpStats.result.isError).toBe(true);

    // Dashboard HTTP returns 400 on ?sessionKey= whitespace and emits no-store on /api/calibration
    const dash = new DashboardState({ modelBases: ['gemini'], priceMode: 'kosha', startedAt: Date.now(), compressionEnabled: true });
    const badStatsRes = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/stats')!,
      'GET',
      new URL('http://127.0.0.1:47821/api/mmu/stats?sessionKey=%20%20'),
      47821,
      async () => '',
    );
    expect(badStatsRes?.status).toBe(400);

    const badPageRes = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/page')!,
      'GET',
      new URL(`http://127.0.0.1:47821/api/mmu/page?id=${p1.id}&sessionKey=`),
      47821,
      async () => '',
    );
    expect(badPageRes?.status).toBe(400);

    const calRes = await dispatchDashboard(
      dash,
      dashboardPath('/api/calibration')!,
      'GET',
      new URL('http://127.0.0.1:47821/api/calibration'),
      47821,
      async () => '',
    );
    expect(calRes?.status).toBe(200);
    expect(calRes?.headers.get('cache-control')).toBe('no-store');
    expect(calRes?.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
