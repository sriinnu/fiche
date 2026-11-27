import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCasiPreparedCacheForTests,
  createCasiIndex,
} from '../src/core/casi-delta.js';
import { getGlobalMmuStore, resetGlobalMmuStore } from '../src/core/context-mmu.js';
import {
  INITIAL_PREFIX_HASH,
  PrefixMemoTape,
  getGlobalPrefixTape,
  resetGlobalPrefixTape,
  tapeHash64Hex,
} from '../src/core/prefix-tape.js';
import { DashboardState } from '../src/dashboard.js';

afterEach(() => {
  clearCasiPreparedCacheForTests();
  resetGlobalMmuStore();
  resetGlobalPrefixTape();
});

describe('PrefixMemoTape (Stage-2 LRU, Unified Seal Table, Merkle CASI Memo)', () => {
  it('computes deterministic 16-char lowercase hex tapeHash64Hex digests and order-sensitive advancePrefixHash', () => {
    const h1 = tapeHash64Hex('alpha-beta-gamma');
    const h2 = tapeHash64Hex('alpha-beta-gamma');
    const h3 = tapeHash64Hex('alpha-beta-gammb');
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);

    const tape = new PrefixMemoTape();
    const a1 = tape.advancePrefixHash(INITIAL_PREFIX_HASH, 'slot_a');
    const a2 = tape.advancePrefixHash(INITIAL_PREFIX_HASH, 'slot_a');
    const ab = tape.advancePrefixHash(a1, 'slot_b');
    const ba = tape.advancePrefixHash(tape.advancePrefixHash(INITIAL_PREFIX_HASH, 'slot_b'), 'slot_a');
    const split1 = tape.advancePrefixHash(tape.advancePrefixHash(INITIAL_PREFIX_HASH, 'ab'), 'c');
    const split2 = tape.advancePrefixHash(tape.advancePrefixHash(INITIAL_PREFIX_HASH, 'a'), 'bc');

    expect(a1).toMatch(/^[0-9a-f]{16}$/);
    expect(a1).toBe(a2);
    expect(ab).not.toBe(ba);
    expect(split1).not.toBe(split2);
  });

  it('enforces Stage-2 LRU entry count, char-cap eviction, and defensive array cloning', () => {
    const tape = new PrefixMemoTape({ maxStage2Entries: 3, maxStage2Chars: 20 });
    const stages = ['compile', 'hygiene'];
    tape.setStage2('k1', { text: '123456', changed: true, stages });
    stages.push('mutated');
    tape.setStage2('k2', { text: 'abcdef', changed: false, stages: [] });
    tape.setStage2('k3', { text: 'uvwxyz', changed: true, stages: ['trim'] });

    // Promote k1 so k2 becomes LRU
    const got1 = tape.getStage2('k1');
    expect(got1).toEqual({ text: '123456', changed: true, stages: ['compile', 'hygiene'] });
    got1!.stages.push('caller-mutation');
    expect(tape.getStage2('k1')!.stages).toEqual(['compile', 'hygiene']);

    // Inserting k4 exceeds maxStage2Entries (3) and maxStage2Chars (20), evicting k2 first
    tape.setStage2('k4', { text: '789012', changed: true, stages: ['s'] });
    expect(tape.getStage2('k2')).toBeUndefined();
    expect(tape.getStage2('k1')).toBeDefined();
    expect(tape.getStage2('k3')).toBeDefined();
    expect(tape.getStage2('k4')).toBeDefined();

    // Large entry exceeding char cap causes LRU eviction down to cap
    tape.setStage2('k5', { text: 'x'.repeat(16), changed: true, stages: ['big'] });
    const stats = tape.getStats();
    expect(stats.stage2Chars).toBeLessThanOrEqual(20);
    expect(stats.stage2Entries).toBe(1);
    expect(tape.getStage2('k5')!.text).toHaveLength(16);

    // Oversized entry > maxStage2Chars is skipped cleanly without exceeding cap
    tape.setStage2('too-big', { text: 'y'.repeat(25), changed: true, stages: [] });
    expect(tape.getStage2('too-big')).toBeUndefined();
    expect(tape.getStats().stage2Chars).toBeLessThanOrEqual(20);
  });

  it('enforces default 12 MiB Stage-2 char cap on default PrefixMemoTape', () => {
    const tape = new PrefixMemoTape();
    const fiveMiB = 'a'.repeat(5 * 1024 * 1024);
    tape.setStage2('m1', { text: fiveMiB, changed: true, stages: ['s1'] });
    tape.setStage2('m2', { text: fiveMiB, changed: true, stages: ['s2'] });
    tape.setStage2('m3', { text: fiveMiB, changed: true, stages: ['s3'] });

    const stats = tape.getStats();
    expect(stats.stage2Entries).toBe(2);
    expect(stats.stage2Chars).toBe(10 * 1024 * 1024);
    expect(tape.getStage2('m1')).toBeUndefined();
    expect(tape.getStage2('m2')).toBeDefined();
    expect(tape.getStage2('m3')).toBeDefined();
  });

  it('isolates Unified Seal Table per session, normalizes blank sessions, and evicts LRU sessions', () => {
    const tape = new PrefixMemoTape({ maxSessions: 2, maxSealsPerSession: 2 });

    expect(tape.hasAnySessionSeals(undefined)).toBe(false);
    tape.setSeal(undefined, 'sig0', {
      text: '[epoch 0]',
      stages: ['epoch'],
      kind: 'epoch',
      rawLen: 1200,
    });
    expect(tape.hasAnySessionSeals('')).toBe(true);
    expect(tape.hasAnySessionSeals('   ')).toBe(true);
    expect(tape.getSeal('   ', 'sig0')?.text).toBe('[epoch 0]');
    expect(tape.hasAnySessionSeals('other')).toBe(false);

    tape.setSeal('sess-a', 'sig1', {
      text: '[markov 1]',
      stages: ['markov'],
      kind: 'markov',
      rawLen: 900,
    });
    // Promote default session above sess-a, then add sess-b -> sess-a evicted
    expect(tape.getSeal(undefined, 'sig0')).toBeDefined();
    tape.setSeal('sess-b', 'sig2', {
      text: '[epoch 2]',
      stages: ['epoch'],
      kind: 'epoch',
      rawLen: 800,
    });
    expect(tape.hasAnySessionSeals('sess-a')).toBe(false);
    expect(tape.hasAnySessionSeals('default')).toBe(true);
    expect(tape.hasAnySessionSeals('sess-b')).toBe(true);

    // Per-session seal cap (2) retains earliest seals (epoch_0 / sig2) and skips tail overflow (sig4)
    tape.setSeal('sess-b', 'sig3', { text: '[e3]', stages: ['epoch'], kind: 'epoch', rawLen: 500 });
    tape.setSeal('sess-b', 'sig4', { text: '[e4]', stages: ['epoch'], kind: 'epoch', rawLen: 500 });
    expect(tape.getSeal('sess-b', 'sig2')?.text).toBe('[epoch 2]');
    expect(tape.getSeal('sess-b', 'sig3')?.text).toBe('[e3]');
    expect(tape.getSeal('sess-b', 'sig4')).toBeUndefined();

    tape.clearSession('sess-b');
    expect(tape.hasAnySessionSeals('sess-b')).toBe(false);
    expect(tape.getStats().sealSessions).toBe(1);
    expect(tape.getStats().totalSeals).toBe(1);
  });

  it('evicts CASI memo LRU by entry & char caps and resets global singleton cleanly', () => {
    const tape = new PrefixMemoTape({ maxCasiEntries: 2, maxCasiChars: 12 });
    tape.setCasiMemo('c1', { text: '123456', changed: true, kind: 'delta' });
    tape.setCasiMemo('c2', { text: 'abcdef', changed: true, kind: 'slice' });
    expect(tape.getCasiMemo('c1')?.kind).toBe('delta'); // promotes c1

    tape.setCasiMemo('c3', { text: 'ghijkl', changed: false, kind: 'none' });
    expect(tape.getCasiMemo('c2')).toBeUndefined();
    expect(tape.getCasiMemo('c1')).toBeDefined();
    expect(tape.getCasiMemo('c3')).toBeDefined();

    const stats = tape.getStats();
    expect(stats.casiEntries).toBe(2);
    // Unchanged memo entries use zero-copy sentinel (0 bytes charged)
    expect(stats.casiChars).toBe(6);
    expect(stats.casiHits).toBe(3);
    expect(stats.casiMisses).toBe(1);

    const g1 = getGlobalPrefixTape();
    g1.setStage2('gk', { text: 'global', changed: true, stages: ['s'] });
    expect(getGlobalPrefixTape().getStage2('gk')?.text).toBe('global');
    resetGlobalPrefixTape();
    expect(getGlobalPrefixTape().getStage2('gk')).toBeUndefined();
    expect(getGlobalPrefixTape().getStats().stage2Entries).toBe(0);
  });
});

describe('CASI v3: PREPARED_LINES_CACHE & Recursive Histogram Diff', () => {
  it('maintains bit-identical ingest parity across cold and warm PREPARED_LINES_CACHE and >192 LRU overflow', () => {
    const makeDoc = (variant: number, editedLine?: number) =>
      Array.from({ length: 48 }, (_, i) => {
        if (editedLine === i) {
          return `${String(i + 1).padStart(4)}→export const item_${variant}_${i} = "EDITED_${variant}";`;
        }
        return `${String(i + 1).padStart(4)}→export const item_${variant}_${i} = "value_${variant}_${i}";`;
      }).join('\n');

    const baseDoc = makeDoc(0);
    const editedDoc = makeDoc(0, 22);

    clearCasiPreparedCacheForTests();
    const idxCold = createCasiIndex();
    const coldBase = idxCold.ingest(baseDoc, 'r_base', 0);
    const coldDelta = idxCold.ingest(editedDoc, 'r_edit', 1);

    // Second run hits warm PREPARED_LINES_CACHE (without clearing cache)
    const idxWarm = createCasiIndex();
    const warmBase = idxWarm.ingest(baseDoc, 'r_base', 0);
    const warmDelta = idxWarm.ingest(editedDoc, 'r_edit', 1);

    expect(warmBase).toEqual(coldBase);
    expect(warmDelta).toEqual(coldDelta);
    expect(warmDelta.changed).toBe(true);
    expect(warmDelta.kind).toBe('delta');

    // Overflow >192 cache slots cleanly and verify baseDoc still yields exact parity on re-prepare
    for (let k = 1; k <= 210; k++) {
      const idxTmp = createCasiIndex();
      idxTmp.seedBase(makeDoc(k), `seed_${k}`, 0);
    }
    const idxAfterOverflow = createCasiIndex();
    idxAfterOverflow.seedBase(baseDoc, 'r_base', 0);
    const postOverflowDelta = idxAfterOverflow.ingest(editedDoc, 'r_edit', 1);
    expect(postOverflowDelta).toEqual(coldDelta);
  });

  it('emits tight, exact hunks on 90-line boilerplate-heavy TypeScript/JSON where unique lines are sparse around edited middle blocks', () => {
    const topUnique = Array.from(
      { length: 24 },
      (_, i) => `export const routeSchema_${i} = { id: "route_${i}", version: ${i + 1}, strict: true };`,
    );

    const repeatedBoilerplateBlock = (tagValue: string) => [
      '  try {',
      '    const ok = validateEnvelope(payload);',
      '    if (!ok) {',
      '      return { status: "error", code: 400 };',
      '    }',
      `    const res = dispatchPayload(payload, "${tagValue}");`,
      '    return ok;',
      '  } catch (err) {',
      '    logFailure(err);',
      '    return false;',
      '  },',
    ];

    const bottomUnique = Array.from(
      { length: 22 },
      (_, i) => `export const footerRegistry_${i} = { slot: "footer_${i}", checksum: ${i * 97 + 11} };`,
    );

    // 24 + (4 * 11 = 44) + 22 = 90 lines; middle 44 lines consist entirely of 4 identical 11-line blocks!
    const baseLines = [
      ...topUnique,
      ...repeatedBoilerplateBlock('STANDARD_MODE'),
      ...repeatedBoilerplateBlock('STANDARD_MODE'),
      ...repeatedBoilerplateBlock('STANDARD_MODE'),
      ...repeatedBoilerplateBlock('STANDARD_MODE'),
      ...bottomUnique,
    ];
    expect(baseLines).toHaveLength(90);

    // Edit TWO spots inside the repeated 44-line boilerplate region separated by an untouched repeated block:
    // line 29 (in block 1) and line 62 (in block 4), leaving blocks 2 & 3 untouched in between.
    const curLines = [...baseLines];
    curLines[29] = '    const res = dispatchPayload(payload, "STRICT_MODE_A");';
    curLines[62] = '    const res = dispatchPayload(payload, "STRICT_MODE_B");';

    const baseText = baseLines.join('\n') + '\n';
    const curText = curLines.join('\n') + '\n';

    const casi = createCasiIndex();
    expect(casi.ingest(baseText, 'file_v1', 0).changed).toBe(false);
    const res = casi.ingest(curText, 'file_v2', 1);

    expect(res.changed).toBe(true);
    expect(res.kind).toBe('delta');
    expect(res.baseRefId).toBe('file_v1');
    expect(res.text).toContain('[fiche cas-delta vs file_v1:');
    expect(res.text).toContain('89/91 lines unchanged');

    // Histogram diff must split around the unchanged middle boilerplate blocks into TWO tight hunks,
    // NOT one degraded whole-gap diff spanning lines 30..63!
    const headers = [...res.text.matchAll(/@@ base:(\d+)-(\d+) -> cur:(\d+)-(\d+) @@/g)];
    expect(headers).toHaveLength(2);
    for (const m of headers) {
      const bStart = Number(m[1]);
      const bEnd = Number(m[2]);
      const cStart = Number(m[3]);
      const cEnd = Number(m[4]);
      expect(bEnd).toBeGreaterThanOrEqual(bStart);
      expect(cEnd).toBeGreaterThanOrEqual(cStart);
      expect(bEnd - bStart).toBeLessThanOrEqual(8);
      expect(cEnd - cStart).toBeLessThanOrEqual(8);
    }

    expect(res.text).toContain('-    const res = dispatchPayload(payload, "STANDARD_MODE");');
    expect(res.text).toContain('+    const res = dispatchPayload(payload, "STRICT_MODE_A");');
    expect(res.text).toContain('+    const res = dispatchPayload(payload, "STRICT_MODE_B");');
  });

  it('handles repeated JSON/schema boilerplate blocks with deep structural shifts without inverted hunk headers', () => {
    const schemaHeader = Array.from(
      { length: 24 },
      (_, i) => `  "field_header_${i}": { "type": "string", "minLength": ${i + 1}, "required": true },`,
    );
    const repeatedJsonBlock = [
      '  "nestedBlock": {',
      '    "validate": true,',
      '    "retries": 3,',
      '    "fallback": "reject",',
      '    "auditLog": true',
      '  },',
    ];
    const schemaFooter = Array.from(
      { length: 24 },
      (_, i) => `  "field_footer_${i}": { "type": "number", "minimum": ${i * 10}, "nullable": false },`,
    );

    const baseJsonLines = [
      '{',
      ...schemaHeader,
      ...repeatedJsonBlock,
      ...repeatedJsonBlock,
      ...repeatedJsonBlock,
      ...repeatedJsonBlock,
      ...repeatedJsonBlock,
      ...schemaFooter,
      '}',
    ];
    // Total: 1 + 24 + 30 + 24 + 1 = 80 lines; insert 1 line in block 2 & edit 1 line in block 4
    const curJsonLines = [...baseJsonLines];
    curJsonLines.splice(33, 0, '    "strictMode": true,');
    curJsonLines[46] = '    "fallback": "dead_letter",';

    const casi = createCasiIndex();
    casi.ingest(baseJsonLines.join('\n'), 'schema_1', 0);
    const res = casi.ingest(curJsonLines.join('\n'), 'schema_2', 1);

    expect(res.changed).toBe(true);
    expect(res.kind).toBe('delta');
    const headers = [...res.text.matchAll(/@@ base:(\d+)-(\d+) -> cur:(\d+)-(\d+) @@/g)];
    expect(headers.length).toBeGreaterThanOrEqual(2);
    for (const m of headers) {
      expect(Number(m[2])).toBeGreaterThanOrEqual(Number(m[1]));
      expect(Number(m[4])).toBeGreaterThanOrEqual(Number(m[3]));
    }
    expect(res.text).toContain('+    "strictMode": true,');
    expect(res.text).toContain('+    "fallback": "dead_letter",');
  });

  it('DashboardState.serveMmuStats returns additive limits and prefixTape counters', async () => {
    const store = getGlobalMmuStore();
    store.storePage({
      sessionKey: 'sess-dash-mmu',
      refId: 'r1',
      rawText: 'line 1\nline 2\nline 3',
    });
    const tape = getGlobalPrefixTape();
    tape.setStage2('k1', { text: 'ok', changed: true, stages: ['toon'] });
    expect(tape.getStage2('k1')?.changed).toBe(true);
    tape.setSeal('sess-dash-mmu', 'sig1', {
      text: '[fiche epoch-digest]',
      stages: ['acdc_epoch'],
      kind: 'epoch',
      rawLen: 1200,
    });
    expect(tape.getSeal('sess-dash-mmu', 'sig1')?.kind).toBe('epoch');

    const dash = new DashboardState();
    const res = dash.serveMmuStats();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: { activePages: number };
      pageCount: number;
      limits: { maxPages: number; maxBytes: number; persisted: boolean };
      prefixTape: { stage2Hits: number; sealHits: number; totalSeals: number; casiHits: number };
    };
    expect(body.pageCount).toBe(1);
    expect(body.stats.activePages).toBe(1);
    expect(body.limits).toEqual({
      maxPages: 512,
      maxBytes: 16 * 1024 * 1024,
      persisted: false,
    });
    expect(body.prefixTape.stage2Hits).toBe(1);
    expect(body.prefixTape.sealHits).toBe(1);
    expect(body.prefixTape.totalSeals).toBe(1);
    expect(body.prefixTape.casiHits).toBe(0);
  });
});
