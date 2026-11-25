/**
 * Pure Content-Addressed Prefix-State Memo Tape & Unified Seal Table (`PrefixMemoTape`).
 *
 * Leaf module: ZERO `node:` imports, ZERO `Buffer`, ZERO imports from other `src/` modules.
 *
 * Provides three bounded, prefix-cache-invariant memo subsystems:
 *  1. Stage-2 Cleaned-Slot LRU (`maxStage2Entries = 1024`, `maxStage2Chars = 12 MiB`)
 *  2. Unified Prefix Seal Table (`maxSessions = 512`, `maxSealsPerSession = 512`)
 *  3. Merkle Prefix-State CASI Memo (`maxCasiEntries = 1024`, `maxCasiChars = 8 MiB`)
 */

const DEFAULT_MAX_STAGE2_ENTRIES = 1024;
const DEFAULT_MAX_STAGE2_CHARS = 12 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 512;
const DEFAULT_MAX_SEALS_PER_SESSION = 512;
const DEFAULT_MAX_CASI_ENTRIES = 1024;
const DEFAULT_MAX_CASI_CHARS = 8 * 1024 * 1024;

export const INITIAL_PREFIX_HASH = '0000000000000000';

/**
 * Deterministic fast 64-bit dual FNV-1a digest formatted as 16 lowercase hex chars.
 */
export function tapeHash64Hex(text: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b1 >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (c ^ (i & 0xff)) >>> 0;
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export interface Stage2MemoEntry {
  readonly text: string;
  readonly changed: boolean;
  readonly stages: readonly string[];
}

export interface CommittedSlotSeal {
  readonly text: string;
  readonly stages: readonly string[];
  readonly kind: 'epoch' | 'markov';
  readonly rawLen: number;
}

export interface CasiMemoEntry {
  readonly text: string;
  readonly changed: boolean;
  readonly kind: 'none' | 'exact_dup' | 'delta' | 'slice';
}

export interface PrefixTapeStats {
  readonly stage2Entries: number;
  readonly stage2Chars: number;
  readonly stage2Hits: number;
  readonly stage2Misses: number;
  readonly sealSessions: number;
  readonly totalSeals: number;
  readonly sealHits: number;
  readonly casiEntries: number;
  readonly casiChars: number;
  readonly casiHits: number;
  readonly casiMisses: number;
}

export interface PrefixMemoTapeOptions {
  readonly maxStage2Entries?: number;
  readonly maxStage2Chars?: number;
  readonly maxSessions?: number;
  readonly maxSealsPerSession?: number;
  readonly maxCasiEntries?: number;
  readonly maxCasiChars?: number;
}

export class PrefixMemoTape {
  private readonly maxStage2Entries: number;
  private readonly maxStage2Chars: number;
  private readonly maxSessions: number;
  private readonly maxSealsPerSession: number;
  private readonly maxCasiEntries: number;
  private readonly maxCasiChars: number;

  private readonly stage2Map = new Map<string, Stage2MemoEntry>();
  private stage2Chars = 0;
  private stage2Hits = 0;
  private stage2Misses = 0;

  private readonly sealSessions = new Map<string, Map<string, CommittedSlotSeal>>();
  private totalSeals = 0;
  private sealHits = 0;

  private readonly casiMap = new Map<string, CasiMemoEntry>();
  private casiChars = 0;
  private casiHits = 0;
  private casiMisses = 0;

  constructor(opts: PrefixMemoTapeOptions = {}) {
    this.maxStage2Entries = Math.max(1, opts.maxStage2Entries ?? DEFAULT_MAX_STAGE2_ENTRIES);
    this.maxStage2Chars = Math.max(0, opts.maxStage2Chars ?? DEFAULT_MAX_STAGE2_CHARS);
    this.maxSessions = Math.max(1, opts.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.maxSealsPerSession = Math.max(1, opts.maxSealsPerSession ?? DEFAULT_MAX_SEALS_PER_SESSION);
    this.maxCasiEntries = Math.max(1, opts.maxCasiEntries ?? DEFAULT_MAX_CASI_ENTRIES);
    this.maxCasiChars = Math.max(0, opts.maxCasiChars ?? DEFAULT_MAX_CASI_CHARS);
  }

  private normalizeSession(rawSession: string | undefined): string {
    const trimmed = rawSession?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : 'default';
  }

  /** Retrieve a Stage-2 memo entry, refreshing LRU recency and cloning `stages`. */
  getStage2(key: string): Stage2MemoEntry | undefined {
    const entry = this.stage2Map.get(key);
    if (!entry) {
      this.stage2Misses++;
      return undefined;
    }
    this.stage2Hits++;
    this.stage2Map.delete(key);
    this.stage2Map.set(key, entry);
    return {
      text: entry.text,
      changed: entry.changed,
      stages: [...entry.stages],
    };
  }

  /** Insert or update a Stage-2 memo entry, evicting oldest entries on count or char cap. */
  setStage2(key: string, entry: Stage2MemoEntry): void {
    const existing = this.stage2Map.get(key);
    if (existing !== undefined) {
      this.stage2Chars -= existing.text.length;
      this.stage2Map.delete(key);
    }
    if (entry.text.length > this.maxStage2Chars) {
      return;
    }
    const stored: Stage2MemoEntry = {
      text: entry.text,
      changed: entry.changed,
      stages: [...entry.stages],
    };
    this.stage2Map.set(key, stored);
    this.stage2Chars += stored.text.length;

    while (this.stage2Map.size > this.maxStage2Entries || this.stage2Chars > this.maxStage2Chars) {
      const oldestKey = this.stage2Map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestEntry = this.stage2Map.get(oldestKey);
      if (oldestEntry) {
        this.stage2Chars -= oldestEntry.text.length;
      }
      this.stage2Map.delete(oldestKey);
    }
  }

  /** Check whether a session currently holds any committed prefix seals. */
  hasAnySessionSeals(sessionKey: string | undefined): boolean {
    const sess = this.sealSessions.get(this.normalizeSession(sessionKey));
    return sess !== undefined && sess.size > 0;
  }

  /** Retrieve a committed slot seal for a session, refreshing session LRU recency. */
  getSeal(sessionKey: string | undefined, slotSig: string): CommittedSlotSeal | undefined {
    const norm = this.normalizeSession(sessionKey);
    const sess = this.sealSessions.get(norm);
    if (!sess) return undefined;
    const seal = sess.get(slotSig);
    if (!seal) return undefined;
    this.sealSessions.delete(norm);
    this.sealSessions.set(norm, sess);
    this.sealHits++;
    return {
      text: seal.text,
      stages: [...seal.stages],
      kind: seal.kind,
      rawLen: seal.rawLen,
    };
  }

  /** Record a committed slot seal under `sessionKey`, enforcing bounded session & per-session caps. */
  setSeal(sessionKey: string | undefined, slotSig: string, seal: CommittedSlotSeal): void {
    const norm = this.normalizeSession(sessionKey);
    let sess = this.sealSessions.get(norm);
    if (sess) {
      this.sealSessions.delete(norm);
      this.sealSessions.set(norm, sess);
    } else {
      sess = new Map<string, CommittedSlotSeal>();
      this.sealSessions.set(norm, sess);
      while (this.sealSessions.size > this.maxSessions) {
        const oldestSession = this.sealSessions.keys().next().value;
        if (oldestSession === undefined) break;
        const oldestMap = this.sealSessions.get(oldestSession);
        if (oldestMap) {
          this.totalSeals -= oldestMap.size;
        }
        this.sealSessions.delete(oldestSession);
      }
    }

    const stored: CommittedSlotSeal = {
      text: seal.text,
      stages: [...seal.stages],
      kind: seal.kind,
      rawLen: seal.rawLen,
    };
    const existed = sess.has(slotSig);
    if (existed) {
      sess.delete(slotSig);
    }
    sess.set(slotSig, stored);
    if (!existed) {
      this.totalSeals++;
      while (sess.size > this.maxSealsPerSession) {
        const oldestSig = sess.keys().next().value;
        if (oldestSig === undefined) break;
        sess.delete(oldestSig);
        this.totalSeals--;
      }
    }
  }

  /** Remove all committed seals for a single session. */
  clearSession(sessionKey: string | undefined): void {
    const norm = this.normalizeSession(sessionKey);
    const sess = this.sealSessions.get(norm);
    if (!sess) return;
    this.totalSeals -= sess.size;
    this.sealSessions.delete(norm);
  }

  /** Advance a Merkle prefix-state hash deterministically from `prevHash` and `slotSig`. */
  advancePrefixHash(prevHash: string, slotSig: string): string {
    const base = prevHash || INITIAL_PREFIX_HASH;
    return tapeHash64Hex(`${base}\x00${slotSig}`);
  }

  /** Retrieve a CASI prefix-state memo entry, refreshing LRU recency. */
  getCasiMemo(key: string): CasiMemoEntry | undefined {
    const entry = this.casiMap.get(key);
    if (!entry) {
      this.casiMisses++;
      return undefined;
    }
    this.casiHits++;
    this.casiMap.delete(key);
    this.casiMap.set(key, entry);
    return {
      text: entry.text,
      changed: entry.changed,
      kind: entry.kind,
    };
  }

  /** Insert or update a CASI prefix-state memo entry, evicting oldest entries on count or char cap. */
  setCasiMemo(key: string, entry: CasiMemoEntry): void {
    const existing = this.casiMap.get(key);
    if (existing !== undefined) {
      this.casiChars -= existing.text.length;
      this.casiMap.delete(key);
    }
    if (entry.text.length > this.maxCasiChars) {
      return;
    }
    const stored: CasiMemoEntry = {
      text: entry.text,
      changed: entry.changed,
      kind: entry.kind,
    };
    this.casiMap.set(key, stored);
    this.casiChars += stored.text.length;

    while (this.casiMap.size > this.maxCasiEntries || this.casiChars > this.maxCasiChars) {
      const oldestKey = this.casiMap.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestEntry = this.casiMap.get(oldestKey);
      if (oldestEntry) {
        this.casiChars -= oldestEntry.text.length;
      }
      this.casiMap.delete(oldestKey);
    }
  }

  /** Return exact counters and sizes across all three memo subsystems. */
  getStats(): PrefixTapeStats {
    return {
      stage2Entries: this.stage2Map.size,
      stage2Chars: this.stage2Chars,
      stage2Hits: this.stage2Hits,
      stage2Misses: this.stage2Misses,
      sealSessions: this.sealSessions.size,
      totalSeals: this.totalSeals,
      sealHits: this.sealHits,
      casiEntries: this.casiMap.size,
      casiChars: this.casiChars,
      casiHits: this.casiHits,
      casiMisses: this.casiMisses,
    };
  }

  /** Clear all cached entries, seals, and hit/miss counters. */
  reset(): void {
    this.stage2Map.clear();
    this.stage2Chars = 0;
    this.stage2Hits = 0;
    this.stage2Misses = 0;
    this.sealSessions.clear();
    this.totalSeals = 0;
    this.sealHits = 0;
    this.casiMap.clear();
    this.casiChars = 0;
    this.casiHits = 0;
    this.casiMisses = 0;
  }
}

let globalPrefixTape: PrefixMemoTape | undefined;

export function getGlobalPrefixTape(): PrefixMemoTape {
  if (!globalPrefixTape) {
    globalPrefixTape = new PrefixMemoTape();
  }
  return globalPrefixTape;
}

export function resetGlobalPrefixTape(): void {
  globalPrefixTape?.reset();
}
