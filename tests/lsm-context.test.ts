import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getPinnedSessionSkills,
  hasSealedEpochKey,
  isSessionCacheCold,
  markCacheDead,
  noteCacheOutcome,
  noteHistoryRequest,
  peekSessionState,
  recordSealedEpochKey,
  resetSessionState,
  restoreSessionState,
  serializeSessionState,
  sessionStateSize,
  setPinnedSessionSkills,
} from '../src/core/session-state.js';
import {
  planAndApplyTextEpochs,
  resetTextEpochStickyState,
  type TextEpochBlock,
} from '../src/core/text-history.js';

const T0 = 1_760_000_000_000;

function makeLogBlock(seed: number, lines = 320): string {
  return [
    `2026-11-23T10:00:00Z INFO batch=${seed} start`,
    ...Array.from(
      { length: lines },
      (_, i) =>
        `2026-11-23T10:01:${String(i % 60).padStart(2, '0')}Z INFO worker=${seed} step=${i} host=10.2.0.${(i % 15) + 1} dur_ms=${50 + i} ok=true`,
    ),
    `2026-11-23T10:09:00Z ERROR batch=${seed} summary_check_failed at src/mod_${seed}.ts:42`,
  ].join('\n');
}

function makeSmallLogBlock(seed: number): string {
  return makeLogBlock(seed, 28); // > 1000 chars, ~500-700 tokens (< 1500)
}

function makeCodeBlock(seed: number, fnCount = 14): string {
  return [
    `import { helper_${seed} } from './helper_${seed}.js';`,
    `export interface State_${seed} { readonly id: string; count: number; }`,
    ...Array.from({ length: fnCount }, (_, k) =>
      [
        `export function transform_${seed}_${k}(input: number): number {`,
        `  const scaled = Math.max(0, Math.min(4096, input * 3 + ${k}));`,
        `  const base = helper_${seed}(scaled, ${k});`,
        `  let acc = (base ^ scaled) >>> 0;`,
        `  for (let i = 0; i < 6; i++) {`,
        `    acc = ((acc * 31) + i + ${k}) >>> 0;`,
        `  }`,
        `  return acc + (scaled & 0xff);`,
        `}`,
      ].join('\n'),
    ),
  ].join('\n');
}

function wrapBlocks(items: Array<{ msgIndex: number; refId: string; text: string }>): TextEpochBlock[] {
  return items.map((item) => {
    let current = item.text;
    return {
      msgIndex: item.msgIndex,
      refId: item.refId,
      toolName: 'read_file',
      getText: () => current,
      setText: (next: string) => {
        current = next;
      },
    };
  });
}

beforeEach(() => {
  resetSessionState();
  resetTextEpochStickyState();
  process.env.FICHE_PRICES = 'kosha';
});

afterEach(() => {
  resetSessionState();
  resetTextEpochStickyState();
  delete process.env.FICHE_PRICES;
});

describe('session-state LSM & skill-pin extensions', () => {
  it('checks cache coldness non-mutatingly across unknown, dead, server-gone, and horizon states', () => {
    // Unknown/unseen session returns false and does not allocate a record.
    expect(isSessionCacheCold(undefined, T0)).toBe(false);
    expect(isSessionCacheCold('unseen', T0)).toBe(false);
    expect(sessionStateSize()).toBe(0);

    // Server-observed alive stays warm even past horizon.
    noteHistoryRequest('sess-warm', T0);
    noteCacheOutcome('sess-warm', 25_000, 0);
    expect(isSessionCacheCold('sess-warm', T0 + 2 * 3_600_000)).toBe(false);

    // Had cache, then server reports read=0 & create=0 -> cold.
    noteCacheOutcome('sess-warm', 0, 0);
    expect(isSessionCacheCold('sess-warm', T0 + 2 * 3_600_000 + 1000)).toBe(true);

    // markCacheDead marks cold without mutating clock; unknown unobserved past horizon becomes cold.
    noteHistoryRequest('sess-horizon', T0);
    expect(isSessionCacheCold('sess-horizon', T0 + 1_800_000)).toBe(false);
    expect(isSessionCacheCold('sess-horizon', T0 + 3_700_000)).toBe(true);

    markCacheDead('sess-dead');
    expect(isSessionCacheCold('sess-dead', T0)).toBe(true);
    // Calling isSessionCacheCold must NOT clear cacheDead (unlike noteHistoryRequest).
    expect(peekSessionState('sess-dead')?.cacheDead).toBe(true);
  });

  it('retains head 512 sealedEpochKeys, pins skills per catalogHash up to 32, and preserves PERSIST_FORMAT=1', () => {
    noteHistoryRequest('sess-clean', T0);
    const cleanJson = serializeSessionState(T0);
    const cleanParsed = JSON.parse(cleanJson) as { format: number; sessions: Array<Record<string, unknown>> };
    expect(cleanParsed.format).toBe(1);
    expect(cleanParsed.sessions[0]).not.toHaveProperty('sealedEpochKeys');
    expect(cleanParsed.sessions[0]).not.toHaveProperty('pinnedSkills');
    expect(cleanParsed.sessions[0]).not.toHaveProperty('pinnedSkillCatalogHash');

    noteHistoryRequest('sess-ext', T0);
    for (let i = 0; i < 520; i++) {
      recordSealedEpochKey('sess-ext', `epoch_${i}`);
    }
    expect(hasSealedEpochKey('sess-ext', 'epoch_0')).toBe(true);
    expect(hasSealedEpochKey('sess-ext', 'epoch_511')).toBe(true);
    expect(hasSealedEpochKey('sess-ext', 'epoch_512')).toBe(false);
    expect(hasSealedEpochKey('sess-ext', 'epoch_519')).toBe(false);

    const manySkills = Array.from({ length: 40 }, (_, i) => `skill_${i}`);
    setPinnedSessionSkills('sess-ext', 'cat_v1', [...manySkills, 'skill_0', '']);
    const gotV1 = getPinnedSessionSkills('sess-ext', 'cat_v1');
    expect(gotV1).toHaveLength(32);
    expect(gotV1?.[0]).toBe('skill_0');
    expect(getPinnedSessionSkills('sess-ext', 'cat_v2')).toBeUndefined();

    // Round-trip through serialize / restore.
    const serialized = serializeSessionState(T0 + 1000);
    resetSessionState();
    expect(restoreSessionState(serialized, T0 + 2000)).toBe(2);
    expect(hasSealedEpochKey('sess-ext', 'epoch_0')).toBe(true);
    expect(hasSealedEpochKey('sess-ext', 'epoch_511')).toBe(true);
    expect(getPinnedSessionSkills('sess-ext', 'cat_v1')).toHaveLength(32);

    // Clearing pinned skills removes them cleanly.
    setPinnedSessionSkills('sess-ext', 'cat_v1', []);
    expect(getPinnedSessionSkills('sess-ext', 'cat_v1')).toBeUndefined();
    const afterClear = JSON.parse(serializeSessionState(T0 + 3000)) as {
      sessions: Array<Record<string, unknown>>;
    };
    const recExt = afterClear.sessions.find((s) => s.key === 'sess-ext')!;
    expect(recExt).not.toHaveProperty('pinnedSkills');
    expect(recExt).not.toHaveProperty('pinnedSkillCatalogHash');
  });

  it('sanitizes invalid elements in optional arrays on restore', () => {
    const raw = JSON.stringify({
      format: 1,
      sessions: [
        {
          key: 'sess-san',
          lastSeenMs: T0,
          freezeStep: 0,
          cacheDead: false,
          sealedEpochKeys: ['ok_1', 42, '', null, 'ok_2', 'ok_1'],
          pinnedSkills: [false, '', 'git', 'test', 'git'],
          pinnedSkillCatalogHash: 'hash_abc',
        },
      ],
    });
    expect(restoreSessionState(raw, T0 + 100)).toBe(1);
    expect(peekSessionState('sess-san')?.sealedEpochKeys).toEqual(['ok_1', 'ok_2']);
    expect(getPinnedSessionSkills('sess-san', 'hash_abc')).toEqual(['git', 'test']);
  });
});

describe('LSM-Context (L0 / L1 / L2 cold-cache repack & onPageOut)', () => {
  it('L1 compacts large blocks behind cutoffL1 early while leaving small blocks and edit tail verbatim', () => {
    // totalMessages = 7 -> cutoffMsg = 1, cutoffL1 = 5.
    // msg 1: small (< 1500 tok), msg 2: large (>= 1500 tok), msg 3: small (< 1500 tok), msg 6: edit tail (>= 5).
    const blocks = wrapBlocks([
      { msgIndex: 1, refId: 'small_1', text: makeSmallLogBlock(1) },
      { msgIndex: 2, refId: 'large_2', text: makeLogBlock(2, 420) },
      { msgIndex: 3, refId: 'small_3', text: makeSmallLogBlock(3) },
      { msgIndex: 6, refId: 'tail_6', text: makeLogBlock(6, 420) },
    ]);

    const res = planAndApplyTextEpochs({
      blocks,
      totalMessages: 7,
      model: 'claude-opus-5-5',
      totalPromptTokens: 25_000,
      enableLsm: true,
    });

    expect(res.changed).toBe(true);
    expect(res.compactedBlocks).toBe(1);
    expect(blocks[0]!.getText()).not.toContain('[fiche epoch-digest');
    expect(blocks[1]!.getText()).toContain('[fiche epoch-digest large_2');
    expect(blocks[2]!.getText()).not.toContain('[fiche epoch-digest');
    expect(blocks[3]!.getText()).not.toContain('[fiche epoch-digest');

    // Explicit enableLsm: false disables L1 even if sessionKey/onPageOut are provided.
    const disabledBlocks = wrapBlocks([
      { msgIndex: 2, refId: 'large_2', text: makeLogBlock(2, 420) },
    ]);
    let pageOutCalls = 0;
    const disabledRes = planAndApplyTextEpochs({
      blocks: disabledBlocks,
      totalMessages: 7,
      model: 'claude-opus-5-5',
      totalPromptTokens: 25_000,
      enableLsm: false,
      sessionKey: 'sess-off',
      sessionCacheCold: true,
      onPageOut: () => {
        pageOutCalls++;
        return undefined;
      },
    });
    expect(disabledRes.changed).toBe(false);
    expect(pageOutCalls).toBe(0);
  });

  it('respects Kosha paybackReads in L1 when large downstream mass sits behind a block', () => {
    // msg 2 (large >= 1500 tok) is separated from msg 4 by small msg 3 (< 1500 tok).
    // msg 2 evaluates alone with huge downstream mass at msg 4 (< totalMessages - 2) -> payback > 12 (skipped).
    // msg 4 has 0 downstream mass -> seals in L1!
    const blocks = wrapBlocks([
      { msgIndex: 2, refId: 'blocked_l1', text: makeCodeBlock(2, 14) },
      { msgIndex: 3, refId: 'small_gap', text: makeSmallLogBlock(3) },
      { msgIndex: 4, refId: 'downstream_l1', text: makeLogBlock(4, 1400) },
    ]);

    const res = planAndApplyTextEpochs({
      blocks,
      totalMessages: 7, // cutoffMsg = 1, cutoffL1 = 5 -> msg 2..4 in L1 zone, msg 4 < 7 - 2 = 5!
      model: 'claude-opus-5-5',
      totalPromptTokens: 40_000,
      enableLsm: true,
    });

    expect(res.changed).toBe(true);
    expect(blocks[0]!.getText()).not.toContain('[fiche epoch-digest');
    expect(blocks[1]!.getText()).not.toContain('[fiche epoch-digest');
    expect(blocks[2]!.getText()).toContain('[fiche epoch-digest downstream_l1');
  });

  it('L2 cold-cache repack ignores downstream penalty and keeps sealed epochs sticky across restarts', () => {
    const raw0 = makeSmallLogBlock(10); // ~600 tokens < epochTokenTarget
    const raw1 = makeLogBlock(11, 160); // ~3500 tokens (raw0+raw1 >= 4000)
    const raw2 = makeLogBlock(12, 140); // ~3100 tokens (< 4000 trailing remainder)
    const raw3 = makeLogBlock(13, 900); // ~20000 tokens (downstream mass in [cutoffMsg..cutoffL1))

    // Warm turn (same epochTokenTarget=4000): [raw0, raw1] is blocked by downstream raw2+raw3;
    // raw2 (< 4000) is trailing remainder; raw3 sits in [cutoffMsg..cutoffL1) above high L1 floor.
    const warmBlocked = wrapBlocks([
      { msgIndex: 1, refId: 'b0', text: raw0 },
      { msgIndex: 2, refId: 'b1', text: raw1 },
      { msgIndex: 3, refId: 'b2', text: raw2 },
      { msgIndex: 4, refId: 'b3', text: raw3 },
    ]);
    const warmRes = planAndApplyTextEpochs({
      blocks: warmBlocked,
      totalMessages: 10, // cutoffMsg = 4, cutoffL1 = 8
      model: 'claude-opus-5-5',
      totalPromptTokens: 30_000,
      epochTokenTarget: 4_000,
      sessionKey: 'sess-cold-repack',
      sessionCacheCold: false,
      lsmMinLargeBlockTokens: 50_000,
    });
    expect(warmRes.changed).toBe(false);

    // Cold turn: downstreamCachedTokens * 0 allows L2 repack across all eligible blocks behind cutoffL1.
    noteHistoryRequest('sess-cold-repack', T0);
    const coldBlocks = wrapBlocks([
      { msgIndex: 1, refId: 'b0', text: raw0 },
      { msgIndex: 2, refId: 'b1', text: raw1 },
      { msgIndex: 3, refId: 'b2', text: raw2 },
      { msgIndex: 4, refId: 'b3', text: raw3 },
    ]);
    const coldRes = planAndApplyTextEpochs({
      blocks: coldBlocks,
      totalMessages: 7, // cutoffL1 = 5, cutoffMsg = 1
      model: 'claude-opus-5-5',
      totalPromptTokens: 30_000,
      epochTokenTarget: 4_000,
      sessionKey: 'sess-cold-repack',
      sessionCacheCold: true,
    });
    expect(coldRes.changed).toBe(true);
    expect(coldRes.compactedBlocks).toBe(4);
    const snap0 = coldBlocks[0]!.getText();
    const snap1 = coldBlocks[1]!.getText();
    const snap2 = coldBlocks[2]!.getText();
    const snap3 = coldBlocks[3]!.getText();
    expect(snap0).toContain('[fiche epoch-digest b0');
    expect(snap1).toContain('[fiche epoch-digest b1');
    expect(snap2).toContain('[fiche epoch-digest b2');
    expect(snap3).toContain('[fiche epoch-digest b3');
    expect(peekSessionState('sess-cold-repack')?.sealedEpochKeys?.length).toBeGreaterThanOrEqual(2);

    // Simulate full proxy process restart: persist session state, wipe all in-memory maps, restore.
    const persisted = serializeSessionState(T0 + 1000);
    resetSessionState();
    resetTextEpochStickyState();
    expect(restoreSessionState(persisted, T0 + 2000)).toBe(1);

    // Subsequent WARM turn with new messages: L2-sealed epochs must remain 100% cache-identical!
    const nextTurnBlocks = wrapBlocks([
      { msgIndex: 1, refId: 'b0', text: raw0 },
      { msgIndex: 2, refId: 'b1', text: raw1 },
      { msgIndex: 3, refId: 'b2', text: raw2 },
      { msgIndex: 4, refId: 'b3', text: raw3 },
      { msgIndex: 5, refId: 'b4', text: makeSmallLogBlock(14) },
    ]);
    const nextRes = planAndApplyTextEpochs({
      blocks: nextTurnBlocks,
      totalMessages: 12, // cutoffMsg = 6 -> b0..b4 all < cutoffMsg
      model: 'claude-opus-5-5',
      totalPromptTokens: 35_000,
      epochTokenTarget: 4_000,
      sessionKey: 'sess-cold-repack',
      sessionCacheCold: false,
      lsmMinLargeBlockTokens: 50_000,
    });
    expect(nextRes.changed).toBe(true);
    expect(nextTurnBlocks[0]!.getText()).toBe(snap0);
    expect(nextTurnBlocks[1]!.getText()).toBe(snap1);
    expect(nextTurnBlocks[2]!.getText()).toBe(snap2);
    expect(nextTurnBlocks[3]!.getText()).toBe(snap3);
    expect(nextTurnBlocks[4]!.getText()).not.toContain('[fiche epoch-digest');
  });

  it('invokes onPageOut only for accepted sealed epochs and reflects decorated replacement savings', () => {
    const pagedOutRefs: string[] = [];

    // Rejected by payback gate (large downstream mass behind msg 1): onPageOut must NOT run.
    const paybackRejectedBlocks = wrapBlocks([
      { msgIndex: 1, refId: 'reject_payback', text: makeCodeBlock(20, 14) },
      { msgIndex: 2, refId: 'huge_downstream', text: makeLogBlock(21, 900) },
    ]);
    const paybackRes = planAndApplyTextEpochs({
      blocks: paybackRejectedBlocks,
      totalMessages: 9,
      model: 'claude-opus-5-5',
      totalPromptTokens: 30_000,
      keepTailMessages: 6, // cutoffMsg = 3 -> msg 1 and 2 in aged zone, msg 1+2? Set epochTokenTarget=1500 so msg 1 alone evaluates first
      epochTokenTarget: 1500,
      enableLsm: false,
      onPageOut: (block) => {
        pagedOutRefs.push(block.refId);
        return undefined;
      },
    });
    expect(paybackRes.changed).toBe(true); // huge_downstream (epoch 1) seals, reject_payback (epoch 0) does NOT
    expect(pagedOutRefs).toEqual(['huge_downstream']);

    // Rejected by 0.55 ratio gate: onPageOut must NOT run.
    pagedOutRefs.length = 0;
    const rejectedBlocks = wrapBlocks([
      { msgIndex: 1, refId: 'unprofitable', text: 'x'.repeat(1200) }, // single-line incompressible -> >= 0.55 ratio
    ]);
    const rejRes = planAndApplyTextEpochs({
      blocks: rejectedBlocks,
      totalMessages: 10,
      model: 'claude-opus-5-5',
      totalPromptTokens: 10_000,
      epochTokenTarget: 100,
      enableLsm: true,
      onPageOut: (block) => {
        pagedOutRefs.push(block.refId);
        return undefined;
      },
    });
    expect(rejRes.changed).toBe(false);
    expect(pagedOutRefs).toEqual([]);

    const okBlocks = wrapBlocks([
      { msgIndex: 3, refId: 'page_3', text: makeLogBlock(30, 420) },
    ]);
    const okRes = planAndApplyTextEpochs({
      blocks: okBlocks,
      totalMessages: 6,
      model: 'claude-opus-5-5',
      totalPromptTokens: 20_000,
      enableLsm: true,
      onPageOut: (block, _raw, digest) => {
        pagedOutRefs.push(block.refId);
        return `[fiche vm-page pg_${block.refId}]\n${digest}`;
      },
    });
    expect(okRes.changed).toBe(true);
    expect(pagedOutRefs).toEqual(['page_3']);
    expect(okBlocks[0]!.getText().startsWith('[fiche vm-page pg_page_3]\n')).toBe(true);
  });
});
