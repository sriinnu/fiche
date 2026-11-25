import { describe, expect, it } from 'vitest';
import {
  ContextPageStore,
  computeHorizonPaybackLimit,
  computeTailHydration,
  pruneLowDensityBlob,
} from '../src/core/context-mmu.js';

describe('Context-TLB Anti-Thrash Hydration Lease', () => {
  it('suppresses overlapping slices within 3 cooldown turns, re-hydrates on Turn 5, and resets cleanly', () => {
    const store = new ContextPageStore();
    const lines = Array.from({ length: 60 }, (_, idx) => {
      const ln = idx + 1;
      if (ln === 25) return 'export function verifyTlbLeaseTarget(id: string): boolean {';
      if (ln === 26) return '  return id.startsWith("tlb_");';
      if (ln === 27) return '}';
      return `// filler line ${ln}`;
    }).join('\n');

    const page = store.storePage({
      sessionKey: 's-tlb',
      refId: 'src/tlb.ts',
      rawText: lines,
    });

    // Turn 1: hydrates pg_A
    const t1 = computeTailHydration({
      store,
      sessionKey: 's-tlb',
      liveTailTexts: ['Inspect verifyTlbLeaseTarget failure'],
    });
    expect(t1.changed).toBe(true);
    expect(t1.slices).toHaveLength(1);
    expect(t1.slices[0]!.pageId).toBe(page.id);

    // Turn 2 & Turn 3: identical slice suppressed by TLB
    const t2 = computeTailHydration({
      store,
      sessionKey: 's-tlb',
      liveTailTexts: ['Re-check verifyTlbLeaseTarget'],
    });
    expect(t2.changed).toBe(false);
    expect(t2.slices).toHaveLength(0);

    const t3 = computeTailHydration({
      store,
      sessionKey: 's-tlb',
      liveTailTexts: ['Still debugging verifyTlbLeaseTarget'],
    });
    expect(t3.changed).toBe(false);

    // Turn 4 (4 - 1 = 3 <= cooldown 3): still suppressed for implicit symbol hit
    const t4 = computeTailHydration({
      store,
      sessionKey: 's-tlb',
      liveTailTexts: ['One more check on verifyTlbLeaseTarget'],
    });
    expect(t4.changed).toBe(false);

    // Turn 5 (5 - 1 = 4 > cooldown 3): lease expired -> re-hydrates!
    const t5 = computeTailHydration({
      store,
      sessionKey: 's-tlb',
      liveTailTexts: ['Now inspect verifyTlbLeaseTarget again'],
    });
    expect(t5.changed).toBe(true);
    expect(t5.slices).toHaveLength(1);
    expect(t5.slices[0]!.pageId).toBe(page.id);

    // Explicit pg_<hex> pointer ALWAYS bypasses TLB suppression (even immediately on Turn 6)
    const t6Explicit = computeTailHydration({
      store,
      sessionKey: 's-tlb',
      liveTailTexts: [`Force dereference ${page.id} right now`],
    });
    expect(t6Explicit.changed).toBe(true);
    expect(t6Explicit.slices[0]!.pageId).toBe(page.id);

    // Store reset clears TLB leases and turn counters
    store.reset();
    expect(store.isTlbSuppressed('s-tlb', page.id, 20, 35, 1)).toBe(false);
    expect(store.nextHydrationTurn('s-tlb')).toBe(1);
  });

  it('bounds TLB to 64 leases per session and 512 sessions LRU', () => {
    const store = new ContextPageStore();

    // 64 leases per session LRU eviction
    for (let i = 0; i < 70; i++) {
      store.recordHydrationLease('s-cap', `pg_${String(i).padStart(12, '0')}`, 1, 20, 1);
    }
    expect(store.isTlbSuppressed('s-cap', 'pg_000000000000', 1, 20, 2)).toBe(false);
    expect(store.isTlbSuppressed('s-cap', 'pg_000000000005', 1, 20, 2)).toBe(false);
    expect(store.isTlbSuppressed('s-cap', 'pg_000000000006', 1, 20, 2)).toBe(true);
    expect(store.isTlbSuppressed('s-cap', 'pg_000000000069', 1, 20, 2)).toBe(true);

    // ±4 line overlap boundary
    store.recordHydrationLease('s-pad', 'pg_pad', 10, 20, 1);
    expect(store.isTlbSuppressed('s-pad', 'pg_pad', 24, 35, 2)).toBe(true);
    expect(store.isTlbSuppressed('s-pad', 'pg_pad', 25, 35, 2)).toBe(false);

    // 512 session LRU bound
    for (let s = 0; s < 520; s++) {
      store.nextHydrationTurn(`sess-${s}`);
    }
    // Evicted oldest sessions restart at turn 1
    expect(store.nextHydrationTurn('sess-0')).toBe(1);
    expect(store.nextHydrationTurn('sess-519')).toBe(2);
  });

  it('gates weak bare basename-only noise while hydrating basename + symbol co-hits', () => {
    const store = new ContextPageStore();
    const lines = Array.from({ length: 30 }, (_, idx) => {
      const ln = idx + 1;
      if (ln === 15) return 'export function verifyLedgerChecksum(payload: string): boolean {';
      if (ln === 16) return '  return payload.length > 0;';
      if (ln === 17) return '}';
      return `// padding line ${ln}`;
    }).join('\n');

    store.storePage({
      sessionKey: 's-base',
      refId: 'src/utils/config.ts',
      filePath: 'src/utils/config.ts',
      rawText: lines,
    });

    // Bare generic basename without symbol/error signal -> gated out
    const weakOnly = computeTailHydration({
      store,
      sessionKey: 's-base',
      liveTailTexts: ['Look at config.ts when you have a moment'],
    });
    expect(weakOnly.changed).toBe(false);
    expect(weakOnly.slices).toHaveLength(0);

    // Basename + symbol co-hit -> high signal, hydrates cleanly
    const coHit = computeTailHydration({
      store,
      sessionKey: 's-base',
      liveTailTexts: ['Check verifyLedgerChecksum in config.ts'],
    });
    expect(coHit.changed).toBe(true);
    expect(coHit.slices).toHaveLength(1);
    expect(coHit.text).toContain('verifyLedgerChecksum');
  });
});

describe('Lazy Greedy Submodular Token-Coverage Pruning', () => {
  it('retains distinct technical sections over repeated high-IDF jargon paragraphs in < 15ms', () => {
    const store = new ContextPageStore();
    const lines: string[] = [
      '# Distributed Engine Architecture Notes',
      'System: storage-core',
      'Status: active',
      'Revision: 2026-11-24',
    ];

    // Sections 1-8 repeat the same rare jargon paragraph with minor line numbers
    for (let sec = 1; sec <= 8; sec++) {
      lines.push(`Section ${sec} overview notes:`);
      for (let lineNo = 1; lineNo <= 8; lineNo++) {
        lines.push(
          `Obsidian magnetosphere synchrotron heliopause coronal baryonic flux telemetry entry ${sec}.${lineNo} describes baseline plasma modulation.`,
        );
      }
    }

    // Sections 9-12 hold distinct technical facts with non-repeating terms
    lines.push(
      'Section 9 fact: Raft quorum election timeout must exceed broadcast heartbeat interval to prevent split votes.',
      'Section 10 fact: B-tree latch crabbing releases parent mutex immediately after verifying child page split headroom.',
      'Section 11 fact: Write-ahead log fsync barrier commits transaction durability before dirty buffer eviction.',
      'Section 12 fact: Paxos ballot monotonicity guarantees prepare promise ordering across partitioned replicas.',
    );

    lines.push(
      'Summary: review complete',
      'Owner: core-systems',
      'Checklist: verified',
      'End of document',
    );

    const blob = lines.join('\n');
    expect(blob.length).toBeGreaterThan(4000);

    // Warm up once outside measurement, then measure exact latency
    pruneLowDensityBlob(blob, { refId: 'warmup' });
    const t0 = performance.now();
    const res = pruneLowDensityBlob(blob, { store, sessionKey: 's-submod', refId: 'arch-doc' });
    const elapsedMs = performance.now() - t0;

    expect(res.changed).toBe(true);
    expect(elapsedMs).toBeLessThan(50);
    expect(res.text).toContain('Raft quorum election timeout');
    expect(res.text).toContain('B-tree latch crabbing');
    expect(res.text).toContain('Write-ahead log fsync barrier');
    expect(res.text).toContain('Paxos ballot monotonicity');
    expect(store.derefPage(res.pageId!, { sessionKey: 's-submod' })?.text).toBe(blob);
  });
});

describe('Horizon-Aware Online Compaction Gate (computeHorizonPaybackLimit)', () => {
  it('admits fast at append frontier and scales conservatively mid-prefix', () => {
    // Append frontier (downstreamCachedTokens <= 0)
    expect(
      computeHorizonPaybackLimit({
        turnsObserved: 2,
        baseMaxPayback: 12,
        downstreamCachedTokens: 0,
      }),
    ).toBe(16);
    expect(
      computeHorizonPaybackLimit({
        turnsObserved: 2,
        baseMaxPayback: 20,
        downstreamCachedTokens: 0,
      }),
    ).toBe(20);

    // Immature mid-prefix session (downstreamCachedTokens > 0)
    expect(
      computeHorizonPaybackLimit({
        turnsObserved: 1,
        baseMaxPayback: 12,
        downstreamCachedTokens: 4000,
      }),
    ).toBe(4);
    expect(
      computeHorizonPaybackLimit({
        turnsObserved: 5,
        baseMaxPayback: 12,
        downstreamCachedTokens: 4000,
      }),
    ).toBe(5);

    // Mid-session horizon
    expect(
      computeHorizonPaybackLimit({
        turnsObserved: 10,
        baseMaxPayback: 12,
        downstreamCachedTokens: 4000,
      }),
    ).toBe(8);

    // Mature session saturates at baseMaxPayback
    expect(
      computeHorizonPaybackLimit({
        turnsObserved: 30,
        baseMaxPayback: 12,
        downstreamCachedTokens: 4000,
      }),
    ).toBe(12);
  });
});
