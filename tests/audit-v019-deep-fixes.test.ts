import * as fs from 'node:fs';
import { createServer as createNodeHttpServer } from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import {
  ContextPageStore,
  foldMarkovianEpisodes,
  getGlobalMmuStore,
  resetGlobalMmuStore,
} from '../src/core/context-mmu.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { createProxy } from '../src/core/proxy.js';
import { guardProxyRequest } from '../src/core/request-guard.js';
import { transformAnyRequest } from '../src/core/request-transform.js';
import {
  isCacheCircuitBreakerOpen,
  noteRollingCacheHealth,
  resetSessionState,
} from '../src/core/session-state.js';
import { planAndApplyTextEpochs, resetTextEpochStickyState } from '../src/core/text-history.js';
import { DashboardState, dashboardPath, dispatchDashboard } from '../src/dashboard.js';
import { eventLogFiles } from '../src/file-tracker.js';
import { startHttpServer } from '../src/mcp/server.js';
import { fileMmuPersistenceStore } from '../src/mmu-store.js';
import { aggregateSessions } from '../src/sessions.js';
import { aggregateEventsFile } from '../src/stats.js';
import { runTurnReportCli } from '../src/turn-report.js';
import { loadOrCreateWarpToken } from '../src/warp/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_OPENAI_KEY = ['sk', 'proj', 'audit', 'v019', 'deep', 'fixes'].join('-');
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function reserveUnusedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('Fiche v0.19 Deep Audit Fixes (P0 / P1 / P2 / V20)', () => {
  const prevPrices = process.env.INKLING_PRICES;
  const prevHygiene = process.env.INKLING_TEXT_HYGIENE;

  beforeEach(() => {
    resetSessionState();
    resetGlobalMmuStore();
    resetTextEpochStickyState();
    setAllowedModelBases(null);
    process.env.INKLING_PRICES = 'kosha';
    process.env.INKLING_TEXT_HYGIENE = 'on';
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      await fn();
    }
    if (prevPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = prevPrices;
    if (prevHygiene === undefined) delete process.env.INKLING_TEXT_HYGIENE;
    else process.env.INKLING_TEXT_HYGIENE = prevHygiene;
    setAllowedModelBases(null);
  });

  it('P0-4: loadOrCreateWarpToken closes directory descriptors on new directory creation', () => {
    const parent = makeTempDir('fiche-warp-fd-');
    const before = fs.existsSync('/dev/fd') ? fs.readdirSync('/dev/fd').length : 0;
    for (let i = 0; i < 12; i += 1) {
      const sub = path.join(parent, `d-${i}`);
      const tok = loadOrCreateWarpToken(sub);
      expect(tok).toMatch(/^[0-9a-f]{64}$/);
    }
    if (fs.existsSync('/dev/fd')) {
      const after = fs.readdirSync('/dev/fd').length;
      expect(after - before).toBeLessThan(5);
    }
  });

  it('P0-6: tightens MCP HTTP Origin/Sec-Fetch-Site checks and scopes GET /api/mmu/page', async () => {
    const port = await reserveUnusedPort();
    const srv = await startHttpServer(port, { ipv4Only: true });
    cleanups.push(() => srv.close());

    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });

    const crossPortRes = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:9999',
      },
      body: initBody,
    });
    expect(crossPortRes.status).toBe(403);

    const sameSiteRes = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-site',
      },
      body: initBody,
    });
    expect(sameSiteRes.status).toBe(403);

    const sameOriginRes = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${srv.port}`,
      },
      body: initBody,
    });
    expect(sameOriginRes.status).toBe(200);

    const store = getGlobalMmuStore();
    const p = store.storePage({
      sessionKey: 'sess-alpha',
      refId: 'src/secret-check.ts',
      rawText: 'export function uniqueAuditSymbol() {\n  return 42;\n}\n// trailing\n',
    });
    const dash = new DashboardState(undefined, undefined, undefined, { controlToken: 'tok-valid-123' });

    const unscoped = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/page')!,
      'GET',
      new URL(`http://127.0.0.1:47821/api/mmu/page?id=${p.id}`),
      47821,
      async () => '',
    );
    expect(unscoped?.status).toBe(400);

    const badToken = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/page')!,
      'GET',
      new URL(`http://127.0.0.1:47821/api/mmu/page?id=${p.id}`),
      47821,
      async () => '',
      { headers: { 'x-fiche-control-token': 'wrong-token' } },
    );
    expect(badToken?.status).toBe(403);

    const goodToken = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/page')!,
      'GET',
      new URL(`http://127.0.0.1:47821/api/mmu/page?id=${p.id}`),
      47821,
      async () => '',
      { headers: { 'x-fiche-control-token': 'tok-valid-123' } },
    );
    expect(goodToken?.status).toBe(200);
    const json = (await goodToken!.json()) as { text: string };
    expect(json.text).toContain('uniqueAuditSymbol');

    const scopedOwn = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/page')!,
      'GET',
      new URL(`http://127.0.0.1:47821/api/mmu/page?id=${p.id}&sessionKey=sess-alpha`),
      47821,
      async () => '',
    );
    expect(scopedOwn?.status).toBe(200);

    const scopedOther = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/page')!,
      'GET',
      new URL(`http://127.0.0.1:47821/api/mmu/page?id=${p.id}&sessionKey=sess-other`),
      47821,
      async () => '',
    );
    expect(scopedOther?.status).toBe(404);
  });

  it('P0-7: protects >=3 parallel read_file outputs in trailing round even on cold cache Turn 1', async () => {
    setAllowedModelBases(['gpt-6.2-sol']);
    const bigFile = (tag: string) =>
      `// File: src/${tag}.ts\n` +
      Array.from({ length: 120 }, (_, i) => `export const ${tag}_${i} = "${'x'.repeat(28)}_${i}";`).join('\n');

    const payload = {
      model: 'gpt-6.2-sol',
      instructions: Array.from({ length: 40 }, (_, i) => `Instruction rule ${i}: ${'detail '.repeat(12)}`).join('\n'),
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Read 3 files cleanly and edit pkgA.' }] },
        { type: 'function_call', call_id: 'r1', name: 'read_file', arguments: '{"path":"src/pkgA.ts"}' },
        { type: 'function_call', call_id: 'r2', name: 'read_file', arguments: '{"path":"src/pkgB.ts"}' },
        { type: 'function_call', call_id: 'r3', name: 'read_file', arguments: '{"path":"src/pkgC.ts"}' },
        { type: 'function_call_output', call_id: 'r1', output: bigFile('pkgA') },
        { type: 'function_call_output', call_id: 'r2', output: bigFile('pkgB') },
        { type: 'function_call_output', call_id: 'r3', output: bigFile('pkgC') },
      ],
    };

    const res = await transformOpenAIResponses(enc.encode(JSON.stringify(payload)), {
      model: 'gpt-6.2-sol',
      compress: true,
      clientSessionId: 'cold-parallel-reads',
      clientSessionSource: 'fiche-header',
    });
    const out = JSON.parse(dec.decode(res.body)) as { input: Array<{ type?: string; call_id?: string; output?: unknown }> };
    for (const cid of ['r1', 'r2', 'r3']) {
      const fco = out.input.find((x) => x.type === 'function_call_output' && x.call_id === cid);
      expect(typeof fco?.output).toBe('string');
      expect(String(fco?.output)).toContain(`export const ${cid === 'r1' ? 'pkgA' : cid === 'r2' ? 'pkgB' : 'pkgC'}_0`);
    }
  });

  it('P1-1 & P1-10: uncached gemini-4-hydrogen-sonar text hygiene yields positive savings and per-model priced flags', async () => {
    setAllowedModelBases(['gemini']);
    const dir = makeTempDir('fiche-sonar-');
    const eventsFile = path.join(dir, 'events.jsonl');
    const events = [0, 1, 2, 3].map((i) => ({
      ts: `2026-11-23T20:4${i}:10.000Z`,
      method: 'POST',
      path: '/v1internal:streamGenerateContent',
      status: 200,
      duration_ms: 4000,
      model: 'gemini-4-hydrogen-sonar',
      accounting_provider: 'google',
      compressed: true,
      reason: 'text_hygiene',
      text_hygiene_saved_tokens: 41250,
      first_user_sha8: '8de86f12',
      session_key: '8de86f12',
      input_tokens: 57000,
      output_tokens: 400,
    }));
    fs.writeFileSync(eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const dash = new DashboardState();
    await dash.replay(eventsFile);
    const stats = (await dash.serveStats().json()) as {
      by_model: Record<
        string,
        {
          saved_tokens: number;
          saved_pct: number;
          priced?: boolean;
          usd_priced_requests?: number;
          usd_unpriced_requests?: number;
        }
      >;
    };
    const sonar = stats.by_model['gemini-4-hydrogen-sonar'];
    expect(sonar).toBeDefined();
    expect(sonar!.saved_tokens).toBeGreaterThan(0);
    expect(sonar!.saved_pct).toBeGreaterThan(0);
    expect(typeof sonar!.priced).toBe('boolean');
    expect(typeof sonar!.usd_priced_requests).toBe('number');
    expect(typeof sonar!.usd_unpriced_requests).toBe('number');

    const agg = await aggregateSessions({ eventsFile, sidecarDir: path.join(dir, 's') });
    const sess = agg.sessions.get('8de86f12');
    expect(sess?.tokensSavedEst ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('P1-2, V20-1 & P1-7: isolates skill-catalog slab, filters trivial acks in episodes, and scrubs expanded secrets', () => {
    const store = new ContextPageStore({ maxPages: 4, maxBytes: 1024 * 1024 });
    // Store 20 skill pages across 4 sessions -> must NOT evict code pages in `entries`!
    for (let s = 0; s < 4; s += 1) {
      for (let k = 0; k < 5; k += 1) {
        store.storePage({
          sessionKey: `s-${s}`,
          refId: `skill:sk-${k}`,
          toolName: 'skill-catalog',
          rawText: `# Skill ${k}\nSkill description line ${k}.`,
        });
      }
    }
    const codePageIds: string[] = [];
    for (let c = 0; c < 4; c += 1) {
      const codePage = store.storePage({
        sessionKey: 's-0',
        refId: `src/file-${c}.ts`,
        toolName: 'read_file',
        rawText: `// File: src/file-${c}.ts\nexport function fn${c}() {\n  return ${c};\n}\n`,
      });
      codePageIds.push(codePage.id);
    }
    expect(store.getStats().activePages).toBe(9);
    expect(store.getStats().pagesEvicted).toBe(0);
    for (const pid of codePageIds) {
      expect(store.derefPage(pid, { sessionKey: 's-0' })).not.toBeNull();
    }
    store.storePage({
      sessionKey: 's-0',
      refId: 'ack-1',
      toolName: 'bash',
      rawText: 'ok',
      admissionFilter: true,
    });
    expect(store.getStats().activePages).toBe(9);

    // P1-7 expanded secrets
    const dir = makeTempDir('fiche-secret-');
    const mmuPath = path.join(dir, 'mmu-pages.json');
    const pStore = new ContextPageStore({ persistence: fileMmuPersistenceStore(mmuPath) });
    pStore.storePage({
      sessionKey: 'sec',
      refId: 'src/jwt.ts',
      rawText: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c\nline2\nline3\nline4',
    });
    pStore.flush();
    expect(fs.readFileSync(mmuPath, 'utf8')).not.toContain('eyJhbGciOiJIUzI1NiI');

    // Permissive directory fails closed
    const badDir = makeTempDir('fiche-permissive-');
    fs.chmodSync(badDir, 0o777);
    const blockedPath = path.join(badDir, 'mmu-pages.json');
    const adapter = fileMmuPersistenceStore(blockedPath);
    adapter.save('{"format":1,"savedAtMs":1,"pages":[]}');
    expect(fs.existsSync(blockedPath)).toBe(false);
  });

  it('P1-4 & P2-1 & P2-6: follows .1 rotation, accepts turn-report --json, and prioritizes accounting_provider', async () => {
    const dir = makeTempDir('fiche-rot-');
    const eventsFile = path.join(dir, 'events.jsonl');
    const rowOld = {
      ts: '2026-11-26T01:00:00.000Z',
      method: 'POST',
      path: '/google-ai-studio/v1beta/openai/chat/completions',
      status: 200,
      duration_ms: 100,
      model: 'gpt-6.2-sol',
      accounting_provider: 'openai',
      compressed: true,
      session_key: 's-rot',
      first_user_sha8: 's-rot',
      input_tokens: 1000,
      output_tokens: 50,
      cached_tokens: 900,
      text_hygiene_saved_tokens: 200,
    };
    const rowNew = { ...rowOld, ts: '2026-11-26T02:00:00.000Z', output_tokens: 60 };
    fs.writeFileSync(`${eventsFile}.1`, JSON.stringify(rowOld) + '\n');
    fs.writeFileSync(eventsFile, JSON.stringify(rowNew) + '\n');

    expect(eventLogFiles(eventsFile)).toEqual([`${eventsFile}.1`, eventsFile]);
    const statsAgg = await aggregateEventsFile(eventsFile);
    expect(statsAgg?.parsed).toBe(2);

    const sessAgg = await aggregateSessions({ eventsFile, sidecarDir: path.join(dir, 's') });
    expect(sessAgg.sessions.get('s-rot')?.requestCount).toBe(2);

    const cliRes = runTurnReportCli(['--json'], eventsFile);
    expect(cliRes.code).toBe(0);
    expect(JSON.parse(cliRes.out).session.turns).toBe(2);
  });

  it('P1-5 & P2-2 & P2-3 & P2-4 & P2-7: scope parity, CLI subcommands, /health, 499 abort, Host check & sticky order', async () => {
    // P1-5
    const savedInkHyg = process.env.INKLING_TEXT_HYGIENE;
    const savedFicheHyg = process.env.FICHE_TEXT_HYGIENE;
    delete process.env.INKLING_TEXT_HYGIENE;
    delete process.env.FICHE_TEXT_HYGIENE;
    try {
      const outScope = await transformAnyRequest(
        enc.encode(JSON.stringify({ model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] })),
        { model: 'grok-4.7', wire: 'anthropic' },
      );
      expect(outScope.report.reason).toBe('unsupported_model');
    } finally {
      if (savedInkHyg === undefined) delete process.env.INKLING_TEXT_HYGIENE;
      else process.env.INKLING_TEXT_HYGIENE = savedInkHyg;
      if (savedFicheHyg === undefined) delete process.env.FICHE_TEXT_HYGIENE;
      else process.env.FICHE_TEXT_HYGIENE = savedFicheHyg;
    }

    // P2-3 /health
    const dash = new DashboardState();
    expect(dashboardPath('/health')).toEqual({ kind: 'api-health' });
    const hRes = await dispatchDashboard(dash, dashboardPath('/health')!, 'GET', new URL('http://127.0.0.1:47821/health'), 47821, async () => '');
    expect(hRes?.status).toBe(200);

    // P2-7 HTTP/1.1 missing Host refused
    expect(guardProxyRequest({ host: '' }, { httpVersionMajor: 1, httpVersionMinor: 1 })?.status).toBe(400);

    // P2-4 pending flushed cleanly before singleSticky [item]
    const makeLog = (tag: string, lines: number) =>
      Array.from({ length: lines }, () => `INFO ${tag} steady worker tick payload detail line`).join('\n');
    const alphaRaw = makeLog('alpha', 160);
    const betaRaw = makeLog('beta', 240);
    const makeEpochBlock = (msgIndex: number, refId: string, raw: string, onSet?: (ref: string) => void) => {
      let cur = raw;
      return {
        msgIndex,
        blockIndex: 0,
        refId,
        toolName: 'bash',
        getText: () => cur,
        setText: (next: string) => {
          cur = next;
          onSet?.(refId);
        },
      };
    };
    const resSticky1 = planAndApplyTextEpochs({
      blocks: [
        makeEpochBlock(1, 'b-1', alphaRaw),
        makeEpochBlock(4, 'b-2', betaRaw),
      ],
      totalMessages: 8,
      keepTailMessages: 6,
      lsmEditTailMessages: 2,
      lsmMinLargeBlockTokens: 1200,
      epochTokenTarget: 9000,
      maxPaybackReads: 100,
      totalPromptTokens: 3200,
      model: 'claude-opus-5-5',
      sessionKey: 'sticky-order-sess',
    });
    expect(resSticky1.changed).toBe(true);

    const setOrder: string[] = [];
    const resSticky2 = planAndApplyTextEpochs({
      blocks: [
        makeEpochBlock(1, 'b-1', alphaRaw, (r) => setOrder.push(r)),
        makeEpochBlock(4, 'b-2', betaRaw, (r) => setOrder.push(r)),
      ],
      totalMessages: 12,
      keepTailMessages: 6,
      lsmEditTailMessages: 2,
      lsmMinLargeBlockTokens: 1200,
      epochTokenTarget: 9000,
      maxPaybackReads: 100,
      totalPromptTokens: 3200,
      model: 'claude-opus-5-5',
      sessionKey: 'sticky-order-sess',
    });
    expect(resSticky2.changed).toBe(true);
    expect(setOrder).toEqual(['b-1', 'b-2']);

    // P2-2 unknown CLI subcommand exits 2 (only if dist/node.js exists)
    const distNode = path.join(repoRoot, 'dist', 'node.js');
    if (fs.existsSync(distNode)) {
      let exitCode = 0;
      try {
        execFileSync(process.execPath, [distNode, 'totally-unknown-cmd'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      expect(exitCode).toBe(2);
    }

    // P2-3 proxy client disconnect -> 499
    const upstream = createNodeHttpServer(() => {
      // keep open until aborted
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));
    const upPort = (upstream.address() as net.AddressInfo).port;
    const events: number[] = [];
    const proxy = createProxy({
      upstream: `http://127.0.0.1:${upPort}`,
      onRequest: (ev) => {
        events.push(ev.status);
      },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('client disconnected')), 25);
    const pRes = await proxy(
      new Request(`http://127.0.0.1:${upPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': FAKE_OPENAI_KEY },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }),
        signal: ac.signal,
      }),
    );
    expect(pRes.status).toBe(499);
    await new Promise((r) => setTimeout(r, 40));
    expect(events).toContain(499);
  });

  it('V20-2: opens 10-turn circuit breaker on 1h low-hit turns and recovers after 2 healthy >=85% turns', () => {
    const sk = 'breaker-sess';
    const scope = { model: 'claude-opus-5-5' };
    expect(isCacheCircuitBreakerOpen(sk, scope)).toBe(false);
    for (let i = 0; i < 3; i += 1) {
      noteRollingCacheHealth(
        sk,
        { cacheReadTokens: 1000, cacheCreate1hTokens: 2000, totalInputTokens: 4000 },
        scope,
      );
    }
    expect(isCacheCircuitBreakerOpen(sk, scope)).toBe(true);

    // 2 consecutive >= 85% healthy turns close the breaker early
    noteRollingCacheHealth(sk, { cacheReadTokens: 9000, cacheCreate1hTokens: 0, totalInputTokens: 10000 }, scope);
    expect(isCacheCircuitBreakerOpen(sk, scope)).toBe(true);
    noteRollingCacheHealth(sk, { cacheReadTokens: 9200, cacheCreate1hTokens: 0, totalInputTokens: 10000 }, scope);
    expect(isCacheCircuitBreakerOpen(sk, scope)).toBe(false);
  });
});
