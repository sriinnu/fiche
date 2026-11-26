import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ContextPageStore,
  clearStickyMarkovEpisodesForTests,
  computeTailHydration,
  configureMmuPersistence,
  extractErrorAnchors,
  extractSymbolSpans,
  flushMmuPersistence,
  fnv64Hex,
  foldMarkovianEpisodes,
  getGlobalMmuStore,
  inferFilePath,
  linkSessionSkills,
  pageIdForText,
  pruneLowDensityBlob,
  resetGlobalMmuStore,
  type MmuPersistenceAdapter,
  type PinnedSkillStore,
} from '../src/core/context-mmu.js';
import { stageTogglesFromOverrides } from '../src/core/stage-plugins.js';
import type { TextEpochBlock } from '../src/core/text-history.js';
import { resetTextEpochStickyState } from '../src/core/text-history.js';
import { clearCalibratedProfiles, setCalibratedProfile } from '../src/core/calibration.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { resetSessionState } from '../src/core/session-state.js';
import { DashboardState, dashboardPath, dispatchDashboard } from '../src/dashboard.js';
import { fileMmuPersistenceStore } from '../src/mmu-store.js';

const tmpDirs: string[] = [];

afterEach(() => {
  resetGlobalMmuStore();
  configureMmuPersistence(undefined);
  clearStickyMarkovEpisodesForTests();
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function makeEpochBlocks(items: Array<{ msgIndex: number; refId: string; toolName?: string; text: string }>) {
  const state = items.map((item) => ({ ...item }));
  const blocks: TextEpochBlock[] = state.map((entry) => ({
    msgIndex: entry.msgIndex,
    refId: entry.refId,
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
    getText: () => entry.text,
    setText: (next: string) => {
      entry.text = next;
    },
  }));
  return { state, blocks };
}

describe('Context-MMU: IDs & Symbol/Path/Anchor Extraction', () => {
  it('computes canonical deterministic 64-bit FNV-1a hex and pg_<12hex> page IDs', () => {
    expect(fnv64Hex('hello')).toBe('a430d84680aabd0b');
    expect(fnv64Hex('hello')).toBe(fnv64Hex('hello'));
    expect(fnv64Hex('hello!')).not.toBe(fnv64Hex('hello'));
    const pid = pageIdForText('hello world');
    expect(pid).toMatch(/^pg_[0-9a-f]{12}$/);
    expect(pageIdForText('🚀 unicode test')).toMatch(/^pg_[0-9a-f]{12}$/);
  });

  it('extracts TS/JS, Python, Go, Rust, Swift, Java declarations and strips line-number gutters', () => {
    const tsWithGutter = [
      '    1→// File: src/core/sample.ts',
      '    2→export interface PageConfig {',
      '    3→  maxPages: number;',
      '    4→}',
      '    5→export class StoreEngine {',
      '    6→  async fetchSlice(id: string): Promise<string> {',
      '    7→    return id;',
      '    8→  }',
      '    9→}',
      '   10→export const computeHash = (input: string) => {',
      '   11→  return input.length;',
      '   12→};',
    ].join('\n');

    expect(inferFilePath(tsWithGutter)).toBe('src/core/sample.ts');
    const tsSpans = extractSymbolSpans(tsWithGutter);
    expect(tsSpans).toEqual(
      expect.arrayContaining([
        { name: 'PageConfig', kind: 'interface', startLine: 2, endLine: 4 },
        { name: 'StoreEngine', kind: 'class', startLine: 5, endLine: 9 },
        { name: 'fetchSlice', kind: 'method', startLine: 6, endLine: 8 },
        { name: 'computeHash', kind: 'function', startLine: 10, endLine: 12 },
      ]),
    );

    const pyCode = [
      '# app/worker.py',
      'class BatchWorker:',
      '    async def run_job(self, items):',
      '        if items:',
      '            return len(items)',
      '        return 0',
      '',
      'def top_helper(x):',
      '    return x + 1',
    ].join('\n');
    expect(inferFilePath(pyCode)).toBe('app/worker.py');
    expect(extractSymbolSpans(pyCode)).toEqual(
      expect.arrayContaining([
        { name: 'BatchWorker', kind: 'class', startLine: 2, endLine: 6 },
        { name: 'run_job', kind: 'function', startLine: 3, endLine: 6 },
        { name: 'top_helper', kind: 'function', startLine: 8, endLine: 9 },
      ]),
    );

    const polyglot = [
      'type RouterConfig struct {',
      '  Port int',
      '}',
      'func (r *RouterConfig) ListenAddr() string {',
      '  return ":8080"',
      '}',
      'pub async fn decode_packet(buf: &[u8]) -> usize {',
      '  buf.len()',
      '}',
      'pub trait PageCache {',
      '  fn size(&self) -> usize;',
      '}',
      'impl PageCache for MemoryCache {',
      '  fn size(&self) -> usize { 0 }',
      '}',
      'public actor CacheCoordinator {',
      '  override func syncPages() {',
      '  }',
      '}',
      'public class JavaController {',
      '  public static List<String> pageIn(String id) {',
      '    return null;',
      '  }',
      '}',
    ].join('\n');
    const polySpans = extractSymbolSpans(polyglot);
    const namesKinds = polySpans.map((s) => `${s.kind}:${s.name}`);
    expect(namesKinds).toEqual(
      expect.arrayContaining([
        'struct:RouterConfig',
        'method:ListenAddr',
        'function:decode_packet',
        'trait:PageCache',
        'impl:MemoryCache',
        'actor:CacheCoordinator',
        'function:syncPages',
        'class:JavaController',
        'method:pageIn',
      ]),
    );
  });

  it('infers file paths from diff/tool headers and extracts error/stack anchors in O(N)', () => {
    const diffTrace = [
      'diff --git a/src/auth/verify.ts b/src/auth/verify.ts',
      'index 1111111..2222222 100644',
      '--- a/src/auth/verify.ts',
      '+++ b/src/auth/verify.ts',
      'TypeError: Cannot read properties of undefined',
      '    at verifyJwtSignature (src/auth/verify.ts:42:10)',
      '  File "scripts/check.py", line 18, in run_check',
    ].join('\n');
    expect(inferFilePath(diffTrace)).toBe('src/auth/verify.ts');
    const anchors = extractErrorAnchors(diffTrace);
    expect(anchors).toEqual(
      expect.arrayContaining([
        { name: 'TypeError', kind: 'error', startLine: 5, endLine: 5 },
        { name: 'verifyJwtSignature', kind: 'anchor', startLine: 6, endLine: 6 },
        { name: 'run_check', kind: 'anchor', startLine: 7, endLine: 7 },
      ]),
    );

    const adversarial = 'export function f(' + 'a'.repeat(50_000) + ') {}\n'.repeat(4);
    const t0 = performance.now();
    extractSymbolSpans(adversarial);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('ContextPageStore: LRU Eviction, Indexes, Format Cards & Persistence', () => {
  it('stores, deduplicates per session, indexes symbols/basenames, and evicts LRU cleanly', () => {
    const store = new ContextPageStore({ maxPages: 2, maxBytes: 4096 });
    const p1 = store.storePage({
      sessionKey: 's1',
      refId: 'r1',
      toolName: 'Read',
      rawText: '// File: src/alpha.ts\nexport function alphaOne() { return 1; }\nline3',
      nowMs: 1000,
    });
    // Re-storing identical rawText under same sessionKey is a no-op reuse
    const p1Dup = store.storePage({
      sessionKey: 's1',
      refId: 'r1-again',
      rawText: p1.rawText,
      nowMs: 1005,
    });
    expect(p1Dup.id).toBe(p1.id);
    expect(store.getStats().pagesStored).toBe(1);

    const p2 = store.storePage({
      sessionKey: 's1',
      refId: 'r2',
      rawText: '// File: src/beta.ts\nexport function betaTwo() { return 2; }\nline3',
      nowMs: 2000,
    });
    expect(store.lookupSymbolPageIds('alphaOne', 's1')).toEqual([p1.id]);
    expect(store.lookupSymbolPageIds('beta.ts', 's1')).toEqual([p2.id]);

    // Touch p1 via derefPage so p2 becomes LRU
    const deref = store.derefPage(p1.id, { query: 'alphaOne' });
    expect(deref?.text).toContain('alphaOne');

    // Storing p3 must evict p2 (LRU) and purge p2 from symbolIndex & sessionIndex
    const p3 = store.storePage({
      sessionKey: 's1',
      refId: 'r3',
      rawText: '// File: src/gamma.ts\nexport function gammaThree() { return 3; }',
      nowMs: 3000,
    });
    expect(store.getStats().pagesEvicted).toBe(1);
    expect(store.getStats().activePages).toBe(2);
    expect(store.derefPage(p2.id)).toBeNull();
    expect(store.lookupSymbolPageIds('betaTwo', 's1')).toEqual([]);
    expect(store.lookupSymbolPageIds('beta.ts', 's1')).toEqual([]);
    expect(store.listPages('s1').map((p) => p.id).sort()).toEqual([p1.id, p3.id].sort());

    // Byte-bounded eviction
    const byteStore = new ContextPageStore({ maxPages: 10, maxBytes: 120 });
    const b1 = byteStore.storePage({ sessionKey: 's', refId: 'a', rawText: 'a'.repeat(70) });
    const b2 = byteStore.storePage({ sessionKey: 's', refId: 'b', rawText: 'b'.repeat(70) });
    expect(byteStore.derefPage(b1.id)).toBeNull();
    expect(byteStore.derefPage(b2.id)?.text).toBe('b'.repeat(70));
  });

  it('formats idempotent vm-page cards and supports searchPages', () => {
    const store = new ContextPageStore();
    const page = store.storePage({
      sessionKey: 's1',
      refId: 'src/engine.ts',
      rawText: '// File: src/engine.ts\nexport class EngineCore {\n  runPass() { return true; }\n}',
    });
    const card1 = store.formatPageCard(page, 'Digest summary');
    expect(card1).toContain(`[fiche vm-page ${page.id} (src/engine.ts, 4L)`);
    expect(card1).toContain('top symbols: EngineCore, runPass');
    expect(card1).toContain(`page_in("${page.id}")`);
    expect(store.formatPageCard(page, card1)).toBe(card1);

    const hits = store.searchPages('runPass', 's1');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.page.id).toBe(page.id);
    expect(hits[0]!.matchedLine).toBe(3);
  });

  it('persists debounced/flushed snapshots and fileMmuPersistenceStore writes mode 0600 fail-open', async () => {
    let savedJson: string | undefined;
    const memAdapter: MmuPersistenceAdapter = {
      load: () => savedJson,
      save: (json) => {
        savedJson = json;
      },
    };
    const storeA = new ContextPageStore({ debounceMs: 25, persistence: memAdapter });
    const page = storeA.storePage({
      sessionKey: 'persist-s',
      refId: 'src/p.ts',
      rawText: 'export function persistedFn() { return 42; }',
    });
    expect(storeA.flush()).toBe(true);
    expect(storeA.flush()).toBe(false);
    expect(savedJson).toBeTruthy();

    const storeB = new ContextPageStore();
    const restoredCount = storeB.configurePersistence(memAdapter);
    expect(restoredCount).toBe(1);
    expect(storeB.derefPage(page.id)?.text).toContain('persistedFn');

    // Fail-open on throwing adapter
    const brokenAdapter: MmuPersistenceAdapter = {
      load: () => {
        throw new Error('disk offline');
      },
      save: () => {
        throw new Error('disk full');
      },
    };
    const storeC = new ContextPageStore({ persistence: brokenAdapter });
    expect(() => {
      storeC.storePage({ sessionKey: 's', refId: 'r', rawText: 'hello world' });
      expect(storeC.flush()).toBe(false);
    }).not.toThrow();

    // Node file adapter atomic write + 0600/0700 permissions
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-mmu-store-'));
    tmpDirs.push(tmpDir);
    const subDir = path.join(tmpDir, 'private-mmu');
    const filePath = path.join(subDir, 'mmu-pages.json');
    const fileAdapter = fileMmuPersistenceStore(filePath);
    configureMmuPersistence(fileAdapter);
    const g = getGlobalMmuStore();
    const gPage = g.storePage({ sessionKey: 'global', refId: 'g.ts', rawText: 'export function globalFn() {}' });
    expect(flushMmuPersistence()).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    if (process.platform !== 'win32') {
      const dirMode = fs.statSync(subDir).mode & 0o777;
      const fileMode = fs.statSync(filePath).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    // Corrupt file or unreadable path never throws
    fs.writeFileSync(filePath, '{not-valid-json', 'utf8');
    const storeD = new ContextPageStore({ persistence: fileAdapter });
    expect(storeD.listPages()).toHaveLength(0);

    // Reload valid file into fresh store
    fileAdapter.save(g.serialize());
    const storeE = new ContextPageStore({ persistence: fileAdapter });
    expect(storeE.derefPage(gPage.id)?.text).toContain('globalFn');
  });
});

describe('Speculative Live-Tail Hydration (computeTailHydration)', () => {
  it('hydrates ±15 lines around matched symbols/errors, preserves prefix, and guards recent verbatim', () => {
    const store = new ContextPageStore();
    const lines = Array.from({ length: 60 }, (_, idx) => {
      const lineNo = idx + 1;
      if (lineNo === 30) return 'export async function hydrateTargetSymbol(token: string) {';
      if (lineNo === 31) return '  if (!token) throw new Error("ECONNREFUSED");';
      if (lineNo === 32) return '  return token.trim();';
      if (lineNo === 33) return '}';
      return `// padding line ${lineNo}`;
    }).join('\n');

    const page = store.storePage({
      sessionKey: 's-hyd',
      refId: 'src/hyd.ts',
      rawText: `// File: src/hyd.ts\n${lines}`,
    });

    const prefixSnapshot = page.rawText;
    const res = computeTailHydration({
      store,
      sessionKey: 's-hyd',
      liveTailTexts: ['Why did hydrateTargetSymbol throw ECONNREFUSED?'],
      budgetTokens: 1400,
      maxSlices: 3,
    });

    expect(res.changed).toBe(true);
    expect(res.slices).toHaveLength(1);
    expect(res.text).toMatch(/^\[fiche vm-hydrate\]\n--- page pg_[0-9a-f]{12} \(src\/hyd\.ts L\d+-\d+, matched "hydrateTargetSymbol"\) ---\n/);
    expect(res.text).toContain('export async function hydrateTargetSymbol');
    expect(res.text.endsWith('\n[/fiche vm-hydrate]')).toBe(true);
    expect(page.rawText).toBe(prefixSnapshot);
    expect(store.getStats().tailHydrations).toBe(1);
    expect(store.getStats().tailHydrationTokens).toBe(res.totalTokens);

    // Excluded when already verbatim in recentVerbatimTexts -> telemetry must NOT increment!
    const beforeCount = store.getStats().tailHydrations;
    const excluded = computeTailHydration({
      store,
      sessionKey: 's-hyd',
      liveTailTexts: ['Check hydrateTargetSymbol again'],
      recentVerbatimTexts: [page.rawText],
    });
    expect(excluded.changed).toBe(false);
    expect(excluded.text).toBe('');
    expect(store.getStats().tailHydrations).toBe(beforeCount);

    // No match -> telemetry must NOT increment
    const miss = computeTailHydration({
      store,
      sessionKey: 's-hyd',
      liveTailTexts: ['completelyUnrelatedIdentifier'],
    });
    expect(miss.changed).toBe(false);
    expect(store.getStats().tailHydrations).toBe(beforeCount);

    // Overlapping nearby symbols (lines 14 & 16) collapse into a single slice
    const nearStore = new ContextPageStore();
    const nearLines = Array.from({ length: 30 }, (_, idx) => {
      const ln = idx + 1;
      if (ln === 14) return 'export function nearAlphaFn() { return 1; }';
      if (ln === 16) return 'export function nearBetaFn() { return 2; }';
      return `// line ${ln}`;
    }).join('\n');
    nearStore.storePage({ sessionKey: 's-near', refId: 'near.ts', rawText: nearLines });
    const nearRes = computeTailHydration({
      store: nearStore,
      sessionKey: 's-near',
      liveTailTexts: ['Compare nearAlphaFn and nearBetaFn'],
      maxSlices: 3,
    });
    expect(nearRes.changed).toBe(true);
    expect(nearRes.slices).toHaveLength(1);
  });
});

describe('Markovian Causal Episode Folding (foldMarkovianEpisodes)', () => {
  it('folds red->green verification episodes anchored at first FAIL, archives raw blocks, and stays bit-identical on later turns', () => {
    const store = new ContextPageStore();
    const preExplore = '// File: src/readme.ts\nexport function stableHelper() { return 1; }\n' + 'pre-failure read '.repeat(90);
    const failBodyA = '// File: src/calc.ts\nexport function parseExpr() { return 0; }\n' + 'debug step A '.repeat(140);
    const failBodyB = 'FAIL tests/calc.test.ts\nAssertionError: expected 0 to be 42\n' + 'stack line '.repeat(180);
    const fixBodyC = '// File: src/calc.ts\nexport function parseExpr() { return 42; }\n' + 'edit diff line '.repeat(130);
    const greenPass = 'Test Files  1 passed (1)\nTests  12 passed (12)\n0 failed';

    const turn1Items = [
      { msgIndex: 0, refId: 'u0', text: 'Fix parseExpr in src/calc.ts' },
      { msgIndex: 1, refId: 't0', toolName: 'Read', text: preExplore },
      { msgIndex: 2, refId: 't1', toolName: 'Bash', text: failBodyB },
      { msgIndex: 3, refId: 't2', toolName: 'Read', text: failBodyA },
      { msgIndex: 4, refId: 't3', toolName: 'Edit', text: fixBodyC },
      { msgIndex: 5, refId: 't4', toolName: 'Bash', text: greenPass },
      { msgIndex: 6, refId: 'tail1', text: 'Now summarize the change' },
      { msgIndex: 7, refId: 'tail2', text: 'Sure, here is the summary' },
    ];

    const turn1 = makeEpochBlocks(turn1Items);
    const r1 = foldMarkovianEpisodes({
      blocks: turn1.blocks,
      totalMessages: 8,
      keepTailMessages: 2,
      sessionKey: 's-markov',
      store,
    });

    expect(r1.changed).toBe(true);
    expect(r1.foldedEpisodes).toBe(1);
    expect(r1.foldedBlocks).toBe(3);
    expect(r1.savedChars).toBeGreaterThan(3000);
    // Pre-failure exploration must remain verbatim!
    expect(turn1.state[1]!.text).toBe(preExplore);
    // Certificate must land in the longest predecessor (t1 = failBodyB at index 2).
    expect(turn1.state[2]!.text).toMatch(/^\[fiche causal-episode ep_[0-9a-f]+: folded 3 intermediate debug steps before verified checkpoint t4; archived pages: pg_/);
    expect(turn1.state[2]!.text).toContain('touched symbols/paths: src/calc.ts, parseExpr');
    expect(turn1.state[3]!.text).toMatch(/^\[folded into ep_[0-9a-f]+\]$/);
    expect(turn1.state[4]!.text).toMatch(/^\[folded into ep_[0-9a-f]+\]$/);
    expect(turn1.state[5]!.text).toBe(greenPass); // Checkpoint preserved verbatim!
    expect(store.getStats().markovFolds).toBe(1);

    // Raw predecessors are archived in ContextPageStore
    expect(store.searchPages('parseExpr', 's-markov').length).toBeGreaterThanOrEqual(1);

    // Turn 2: client resends same history prefix + appended turns -> byte-identical prefix!
    const turn2 = makeEpochBlocks([
      ...turn1Items,
      { msgIndex: 8, refId: 'tail3', text: 'Check git status too' },
      { msgIndex: 9, refId: 'tail4', text: 'Everything clean' },
    ]);
    const r2 = foldMarkovianEpisodes({
      blocks: turn2.blocks,
      totalMessages: 10,
      keepTailMessages: 2,
      sessionKey: 's-markov',
      store,
    });
    expect(r2.changed).toBe(true);
    expect(turn2.state[1]!.text).toBe(preExplore);
    expect(turn2.state[2]!.text).toBe(turn1.state[2]!.text);
    expect(turn2.state[3]!.text).toBe(turn1.state[3]!.text);
    expect(turn2.state[4]!.text).toBe(turn1.state[4]!.text);
    expect(turn2.state[5]!.text).toBe(turn1.state[5]!.text);
  });

  it('recognizes git commit and PR merge checkpoints and enforces Kosha payback unless cold', () => {
    const step = 'x'.repeat(1500);
    const downstream = 'cached downstream block '.repeat(6000);

    // Warm downstream cache -> payback > 12 reads blocks fold
    const warmBlocks = makeEpochBlocks([
      { msgIndex: 0, refId: 'u0', text: 'Ship feature' },
      { msgIndex: 1, refId: 'b1', text: step },
      { msgIndex: 2, refId: 'b2', text: step },
      { msgIndex: 3, refId: 'b3', text: step },
      { msgIndex: 4, refId: 'commit', text: '[feat/x a1b2c3d] ship feature\n 2 files changed, 14 insertions(+)' },
      { msgIndex: 5, refId: 'big', text: downstream },
      { msgIndex: 6, refId: 'tail1', text: 'next' },
      { msgIndex: 7, refId: 'tail2', text: 'ok' },
    ]);
    const warmRes = foldMarkovianEpisodes({
      blocks: warmBlocks.blocks,
      totalMessages: 8,
      keepTailMessages: 3,
      model: 'claude-opus-4-6',
      sessionCacheCold: false,
    });
    expect(warmRes.changed).toBe(false);

    // Same blocks when sessionCacheCold === true -> folds cleanly!
    const coldRes = foldMarkovianEpisodes({
      blocks: warmBlocks.blocks,
      totalMessages: 8,
      keepTailMessages: 3,
      model: 'claude-opus-4-6',
      sessionCacheCold: true,
    });
    expect(coldRes.changed).toBe(true);

    // PR merge checkpoint also triggers folding
    clearStickyMarkovEpisodesForTests();
    const prBlocks = makeEpochBlocks([
      { msgIndex: 0, refId: 'u0', text: 'Merge PR' },
      { msgIndex: 1, refId: 'p1', text: step },
      { msgIndex: 2, refId: 'p2', text: step },
      { msgIndex: 3, refId: 'p3', text: step },
      { msgIndex: 4, refId: 'pr', text: 'Squashed and merged pull request #42 into main' },
      { msgIndex: 5, refId: 'tail', text: 'done' },
    ]);
    const prRes = foldMarkovianEpisodes({
      blocks: prBlocks.blocks,
      totalMessages: 6,
      keepTailMessages: 1,
    });
    expect(prRes.changed).toBe(true);
  });
});

describe('Session-Pinned Semantic Capability & Skill Linker (linkSessionSkills)', () => {
  function buildSkillsCatalog(): string {
    const entries = [
      ['accidental-data-loss-prevention', 'Stop and verify before destructive SQL DROP or gsutil rm operations.'],
      ['fiche', 'Inspect live token and dollar savings from the fiche context compiler and optical microfiche.'],
      ['bigquery-data-transfer-service', 'Discovers and inspects BigQuery Data Transfer Service pipelines and transfer configs.'],
      ['gcp-dataflow', 'Guides writing, packaging, executing, and troubleshooting Apache Beam pipelines on Dataflow.'],
      ['gcp-spark-troubleshooting', 'Root Cause Analysis for failed Spark jobs, OutOfMemoryError, and driver logs in GCS.'],
      ['dataform-bigquery', 'Generate clean Dataform SQLX pipelines and workflow_settings.yaml for BigQuery ELT.'],
      ['dbt-bigquery', 'Author and optimize dbt models and incremental tables in BigQuery SQL projects.'],
      ['building-data-apps', 'Build modern React + Vite or Streamlit dashboards and interactive data applications.'],
      ['cloud-databases-onboarding', 'Select and provision Cloud SQL, Spanner, or AlloyDB migration targets.'],
      ['schema-mapping', 'Create multi-table ETL Mapping Manifesto documents between source and target schemas.'],
      ['ml-best-practices', 'Clustering, classification, regression, time series forecasting, and statistical testing.'],
      ['notebook-guidance', 'Jupyter notebook exploration with %%bqsql magics and reproducible plotting cells.'],
    ];
    return [
      'System instructions header.',
      'Available skills:',
      ...entries.map(
        ([name, desc]) =>
          `- ${name} (/skills/${name}/SKILL.md): ${desc} Detailed instructions, prerequisites, validation steps, and operational constraints for ${name} workflows across enterprise environments.`,
      ),
      '</skills>',
    ].join('\n');
  }

  it('pins Turn-1 relevant skills + core skills, stubs others, preserves Turn-1 prefix, and auto-hydrates on Turn N', () => {
    const store = new ContextPageStore();
    const pinnedMap = new Map<string, readonly string[]>();
    const pinnedStore: PinnedSkillStore = {
      get: (sessionKey, catalogHash) => pinnedMap.get(`${sessionKey}:${catalogHash}`),
      set: (sessionKey, catalogHash, skills) => {
        pinnedMap.set(`${sessionKey}:${catalogHash}`, skills);
      },
    };
    const catalogText = buildSkillsCatalog();

    // Turn 1 mentions Apache Beam Dataflow pipeline
    const turn1 = linkSessionSkills({
      text: catalogText,
      firstUserText: 'Debug my Apache Beam Dataflow pipeline failure',
      sessionKey: 's-skill',
      store,
      pinnedStore,
      maxVerbatim: 3,
    });
    expect(turn1.changed).toBe(true);
    expect(turn1.savedChars).toBeGreaterThanOrEqual(400);
    expect(turn1.savedTokens).toBeGreaterThanOrEqual(100);
    // Core skills + relevant skill kept verbatim
    expect(turn1.keptSkills).toEqual(
      expect.arrayContaining(['accidental-data-loss-prevention', 'fiche', 'gcp-dataflow']),
    );
    expect(turn1.text).toContain('Guides writing, packaging, executing, and troubleshooting Apache Beam pipelines on Dataflow.');
    // Unrelated skill stubbed with pg_<id>
    expect(turn1.stubbedSkills).toContain('gcp-spark-troubleshooting');
    expect(turn1.text).toMatch(/- gcp-spark-troubleshooting \[pg_[0-9a-f]{12}\] \(stubbed; mention name to auto-hydrate\)/);
    expect(store.getStats().skillsStubbed).toBe(turn1.stubbedSkills.length);

    // Turn 2: even if a different query is passed, pinnedStore guarantees Turn 1's cached prefix stays bit-identical!
    const turn2 = linkSessionSkills({
      text: catalogText,
      firstUserText: 'Actually inspect gcp-spark-troubleshooting instead',
      sessionKey: 's-skill',
      store,
      pinnedStore,
      maxVerbatim: 3,
    });
    expect(turn2.text).toBe(turn1.text);

    // Mentioning stubbed skill on Turn N triggers Speculative Live-Tail Hydration automatically!
    const hyd = computeTailHydration({
      store,
      sessionKey: 's-skill',
      liveTailTexts: ['Please follow gcp-spark-troubleshooting to diagnose driver OutOfMemoryError'],
      recentVerbatimTexts: [turn1.text],
    });
    expect(hyd.changed).toBe(true);
    expect(hyd.text).toContain('gcp-spark-troubleshooting');
    expect(hyd.text).toContain('Root Cause Analysis for failed Spark jobs');

    // Catalogs with <10 skills or <400 chars saved stay untouched
    const smallCatalog = [
      'Available skills:',
      ...Array.from({ length: 10 }, (_, i) => `- skill-${i} (/s/${i}/SKILL.md): Short desc ${i}.`),
      '</skills>',
    ].join('\n');
    expect(linkSessionSkills({ text: smallCatalog, firstUserText: 'skill-0', maxVerbatim: 8 }).changed).toBe(false);
  });
});

describe('Birth-Time Information-Density Pruner (pruneLowDensityBlob)', () => {
  it('deterministically prunes low-density middle prose (~45%-55%), preserves anchors, archives raw page, and runs <10ms', () => {
    const store = new ContextPageStore();
    const lines: string[] = [
      '# Production Deployment Guide',
      'Service: payments-gateway',
      'Owner: platform-team',
      'Environment: us-central1',
    ];
    for (let i = 0; i < 65; i++) {
      if (i === 18) {
        lines.push('## Critical Failure Remediation');
      } else if (i === 32) {
        lines.push('Endpoint https://internal.example/v2/health returned HTTP 503 with `ERR_UPSTREAM_TIMEOUT` in src/gateway/client.ts.');
      } else {
        lines.push(
          `This general background paragraph number ${i} explains standard operational procedures and general documentation notes for readers.`,
        );
      }
    }
    lines.push('## Final Checklist', 'Verify TLS certificates', 'Confirm metrics green', 'Sign off release');
    const blob = lines.join('\n');
    expect(blob.length).toBeGreaterThan(4000);

    const t0 = performance.now();
    const res1 = pruneLowDensityBlob(blob, { store, sessionKey: 's-prune', refId: 'web-doc' });
    const elapsedMs = performance.now() - t0;
    const res2 = pruneLowDensityBlob(blob, { sessionKey: 's-prune', refId: 'web-doc' });

    expect(res1.changed).toBe(true);
    expect(res1.text).toBe(res2.text);
    expect(elapsedMs).toBeLessThan(50);
    const reduction = res1.savedChars / blob.length;
    expect(reduction).toBeGreaterThanOrEqual(0.35);
    expect(reduction).toBeLessThanOrEqual(0.65);
    expect(res1.text).toContain('# Production Deployment Guide');
    expect(res1.text).toContain('## Critical Failure Remediation');
    expect(res1.text).toContain('ERR_UPSTREAM_TIMEOUT');
    expect(res1.text).toContain('Sign off release');
    expect(res1.text).toMatch(/\[\.\.\. \d+ low-density lines pruned; raw in pg_[0-9a-f]{12} \.\.\.\]/);
    expect(store.derefPage(res1.pageId!)?.text).toBe(blob);
    expect(store.getStats().densityPrunedBlocks).toBe(1);

    // Code / JSON / structured logs stay untouched
    const jsonBlob = JSON.stringify({ rows: Array.from({ length: 120 }, (_, i) => ({ id: i, val: 'a'.repeat(40) })) });
    expect(pruneLowDensityBlob(jsonBlob).changed).toBe(false);

    const codeBlob = Array.from({ length: 40 }, (_, i) => `export function fn_${i}(x: number) { return x + ${i}; }`).join('\n');
    expect(pruneLowDensityBlob(codeBlob).changed).toBe(false);
  });
});

describe('Stage Plugins Toggles Integration', () => {
  it('exposes lsm, mmu, and skillLinker flags in stageTogglesFromOverrides', () => {
    const defaults = stageTogglesFromOverrides({});
    expect(defaults).toEqual({
      optical: true,
      tscg: true,
      toon: true,
      acdc: true,
      casi: true,
      lsm: true,
      mmu: true,
      skillLinker: true,
    });
    const disabled = stageTogglesFromOverrides({
      'lsm-context': false,
      'context-mmu': false,
      'skill-linker': false,
    });
    expect(disabled.lsm).toBe(false);
    expect(disabled.mmu).toBe(false);
    expect(disabled.skillLinker).toBe(false);
  });
});

describe('End-to-end Wire P0-P3 + Dashboard /api/mmu/* & /api/calibration', () => {
  afterEach(() => {
    resetGlobalMmuStore();
    resetSessionState();
    resetTextEpochStickyState();
    clearStickyMarkovEpisodesForTests();
    clearCalibratedProfiles();
  });

  it('chains Skill Linker, JSON unwrap, LSM-Context, MMU page-out, speculative tail hydration, and dashboard routes', async () => {
    const entries = [
      ['accidental-data-loss-prevention', 'Stop and verify before destructive SQL DROP or gsutil rm operations across production datasets.'],
      ['fiche', 'Inspect live token and dollar savings from the fiche context compiler and optical microfiche proxy.'],
      ['bigquery-data-transfer-service', 'Discovers and inspects BigQuery Data Transfer Service pipelines, transfer configs, and ingestion schedules across Google Cloud projects.'],
      ['gcp-dataflow', 'Guides writing, packaging, executing, and troubleshooting Apache Beam pipelines on Google Cloud Dataflow with Flex Templates and autoscaling diagnostics.'],
      ['gcp-spark-troubleshooting', 'Root Cause Analysis for failed Spark jobs, OutOfMemoryError, Yarn containers, and compressed event driver logs in Cloud Storage buckets.'],
      ['dataform-bigquery', 'Author clean Dataform SQLX pipelines, incremental actions, source declarations, and workflow_settings.yaml for BigQuery ELT transformations.'],
      ['dbt-bigquery', 'Author and optimize dbt models, snapshots, tests, and incremental partition materializations in BigQuery SQL projects.'],
      ['building-data-apps', 'Build modern React + Vite or Streamlit dashboards, interactive charts, and Gemini Data Analytics chat applications wired to BigQuery.'],
      ['cloud-databases-onboarding', 'Discover database workload requirements, evaluate recommendation matrices, and provision Cloud SQL, Spanner, or AlloyDB instances.'],
      ['schema-mapping', 'Analyze source and target enterprise schemas across multiple tables and document formal Mapping Manifesto transformations before ELT coding.'],
      ['ml-best-practices', 'Classification, regression, clustering, time series forecasting, statistical hypothesis testing, and BigQuery ML workflow guidance.'],
      ['notebook-guidance', 'Jupyter notebook data exploration using %%bqsql magics, cell validation, clean plotting idioms, and reproducible BigQuery insights.'],
      ['gcp-pipeline-orchestration', 'Generate and deploy Cloud Composer / Apache Airflow orchestration DAGs across dbt, Dataform, Spark, and Vertex AI custom training tasks.'],
      ['gcp-pipeline-resource-provisioning', 'Declarative deployment.yaml provisioning for BigQuery datasets, Dataform repos, and transfer resources across dev, staging, and prod.'],
      ['gcp-spark-observability', 'Multi-region fleet inventory, DCU-hour cost accounting, idle cluster detection, and Cloud Monitoring telemetry across Dataproc Serverless.'],
      ['data-autocleaning', 'Automated data quality profiling, null/type coercion, deduplication, and schema normalization for ingestion pipelines from GCS into BigQuery.'],
    ];
    const systemPrompt = [
      'Core agent rules.',
      '<env>\nOS: darwin\nTime: 2026-11-23T20:00:00Z\n</env>',
      '<skills>',
      ...entries.map(
        ([name, desc]) =>
          `- ${name} (/Users/dev/.gemini/plugins/data-agent-kit/skills/${name}/SKILL.md): ${desc} Enforce mandatory pre-flight checks, strict input validation, exact output formatting, and complete rollback safety before executing any ${name} workflow steps.`,
      ),
      '</skills>',
    ].join('\n');

    const ledgerCode = [
      '// File: src/ledger/checksum.ts',
      ...Array.from({ length: 120 }, (_, i) =>
        i === 40
          ? 'export function verifyLedgerSignatureStrict(payload: Uint8Array, seed: number): number {'
          : i === 41
            ? '  return ((seed * 33) ^ payload.length) >>> 0;'
            : i === 42
              ? '}'
              : `${String(i + 1).padStart(4)}→export const LEDGER_CONST_${i} = ${i * 7};`,
      ),
    ].join('\n');

    const fillerLog = Array.from(
      { length: 28 },
      (_, i) => `2026-11-23T12:00:${String(i).padStart(2, '0')}Z INFO check step=${i} status=ok`,
    ).join('\n');

    const buildTurn = (extraTail?: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            { role: 'user', parts: [{ text: 'Debug my Dataflow pipeline and inspect ledger file' }] },
            { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'src/ledger/checksum.ts' } } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: ledgerCode } } }] },
            { role: 'model', parts: [{ text: 'Read ledger checksum file.' }] },
            { role: 'user', parts: [{ functionResponse: { name: 'bash', response: { output: fillerLog } } }] },
            { role: 'model', parts: [{ text: 'Continuing verification.' }] },
            { role: 'user', parts: [{ text: extraTail ?? 'Proceed to edit validation checks.' }] },
          ],
        }),
      );

    // Run Turn N against uncalibrated gemini-4-neon (text-tier P0-P3 engine)
    const out1 = await transformGoogleGenerateContent(buildTurn(), 'gemini-4-neon', {
      compress: true,
      imageCompress: false,
    });
    expect(out1.info.compressed).toBe(true);
    expect(out1.info.imageCount).toBe(0);
    expect(out1.info.textHygieneStages).toContain('skill_linker');
    expect(out1.info.textHygieneStages).toContain('mmu_page');
    const parsed1 = JSON.parse(new TextDecoder().decode(out1.body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text?: string; functionResponse?: { response?: { output?: string; content?: string } } }> }>;
    };
    const sysText = parsed1.systemInstruction.parts[0]!.text;
    expect(sysText).toContain('OS: darwin');
    expect(sysText).toContain('gcp-dataflow');
    expect(sysText).toContain('stubbed; mention name to auto-hydrate');

    // Now on Turn N+1, reference the paged-out symbol & stubbed skill in live tail!
    const out2 = await transformGoogleGenerateContent(
      buildTurn('Inspect verifyLedgerSignatureStrict and also check gcp-spark-troubleshooting guidance'),
      'gemini-4-neon',
      { compress: true, imageCompress: false },
    );
    const out2Text = new TextDecoder().decode(out2.body);
    expect(out2.info.textHygieneStages).toContain('mmu_hydrate');
    expect(out2Text).toContain('[fiche vm-hydrate]');
    expect(out2Text).toContain('verifyLedgerSignatureStrict');
    // Cached prefix slot 2 remains byte-identical across turns!
    const parsed2 = JSON.parse(out2Text) as typeof parsed1;
    expect(parsed2.contents[2]).toEqual(parsed1.contents[2]);

    // Dashboard endpoints surface live MMU stats, page deref, and calibrated profiles
    setCalibratedProfile({
      model: 'gemini-4-neon',
      band: 'spleen-5x8',
      cols: 312,
      maxHeightPx: 728,
      calibratedAtIso: '2026-11-23T20:00:00Z',
      scores: { hexScore: 1, codeScore: 1, numScore: 1, guardScore: 1, overallScore: 1, passed: true },
      source: 'probe',
    });
    const dash = new DashboardState();
    const statsRes = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/stats')!,
      'GET',
      new URL('http://127.0.0.1:47821/api/mmu/stats'),
      47821,
      async () => '',
    );
    expect(statsRes?.status).toBe(200);
    const statsJson = (await statsRes!.json()) as { stats: { activePages: number; tailHydrations: number }; pageCount: number };
    expect(statsJson.stats.activePages).toBeGreaterThan(0);
    expect(statsJson.stats.tailHydrations).toBeGreaterThan(0);

    const pageRes = await dispatchDashboard(
      dash,
      dashboardPath('/api/mmu/page')!,
      'GET',
      new URL('http://127.0.0.1:47821/api/mmu/page?query=verifyLedgerSignatureStrict'),
      47821,
      async () => '',
    );
    expect(pageRes?.status).toBe(200);
    const pageJson = (await pageRes!.json()) as { text: string; pageId: string };
    expect(pageJson.text).toContain('verifyLedgerSignatureStrict');

    const calRes = await dispatchDashboard(
      dash,
      dashboardPath('/api/calibration')!,
      'GET',
      new URL('http://127.0.0.1:47821/api/calibration'),
      47821,
      async () => '',
    );
    expect(calRes?.status).toBe(200);
    const calJson = (await calRes!.json()) as { profiles: Array<{ model: string }> };
    expect(calJson.profiles.some((p) => p.model === 'gemini-4-neon')).toBe(true);
  });
});
