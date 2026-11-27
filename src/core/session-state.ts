/**
 * Per-session cache-liveness state for the history collapse.
 *
 * ## Why this exists
 *
 * The history grid is append-only: chunk N's pixels are a pure function of its
 * message range, so old chunks stay byte-identical as the conversation grows and
 * ride Anthropic's prompt cache as `cache_read` forever. That freeze is worth a
 * lot — but only while a cache actually exists. Where there is none, the freeze
 * protects nothing and the grid is free to be re-cut for *density* instead:
 * {@link HistoryCollapseOptions.packFill} raises the freeze step until the pages
 * are nearly full, which roughly halves image tokens on long sessions of short
 * turns (#161: 317 images at 43% fill).
 *
 * ## How we know whether a cache exists
 *
 * The provider tells us, and that beats inferring it. {@link noteCacheOutcome}
 * feeds each response's accounting back in: a `cache_read` proves the prefix was
 * live, a `cache_create` proves one was just written. Only when both are zero is
 * there nothing to lose by re-cutting.
 *
 * This module used to decide from the wall clock alone, treating any gap past the
 * ephemeral 5-minute TTL as cold. That was wrong most of the times it fired —
 * measured over 143 gaps on a production host, the cache was still warm in 66% of
 * gaps past 5.5 minutes, 40% past 15 minutes, 13% past an hour. Claude Code marks
 * some blocks with the 1-hour TTL, so the short constant never described this
 * traffic. The worst case was a session repacked three times in one hour on
 * ~10-minute gaps, each repack re-keying the whole prefix — and each preceded by a
 * turn that had just *written* a cache, which the clock could not see.
 *
 * The clock survives only as a backstop for responses whose accounting never
 * arrived: {@link COLD_HORIZON_MS}. And a rejected request still marks the session
 * dead outright ({@link markCacheDead}) — but only a 413 or a too-long 400, not
 * a transient 5xx: see {@link responseLeftNoCache}.
 *
 * ## Why the step is sticky
 *
 * Once a session has been repacked coarse, every later turn must keep at least
 * that step. Falling back to the fine grid would re-cut the same messages into
 * different chunks — every chunk's bytes change, and the whole history re-keys as
 * `cache_create`. {@link recordFreezeStep} pins the floor; the collapse only ever
 * doubles it.
 *
 * ## Why the state survives a restart
 *
 * The map lives in this process. A restart used to lose it, and the module
 * called that an accepted failure mode: an unknown session is treated as WARM
 * (no repack), so at worst we keep paying the old image count. That covers
 * `cold`, but not the floor. {@link recordFreezeStep} exists because a render at
 * a finer grid than the session was last frozen at re-keys every chunk (see
 * above), and after a restart the floor is 0 again: the next collapse is free to
 * pick a finer step than the one the cache was built on, and whether it does
 * depends on that request's image budget — exactly what the pin was added to
 * stop mattering.
 *
 * So the host may attach a {@link SessionStateStore}. Every mutation schedules a
 * debounced save ({@link PERSIST_DEBOUNCE_MS}); the record shape on disk is the
 * in-memory record plus its key. On configure the file is read back and records
 * idle for more than {@link PERSIST_MAX_IDLE_MS} are dropped — past the cold
 * horizon the clock already declares them cold, so nothing they pin is protecting
 * a live cache. Records already in memory win over the file. The core never
 * touches a filesystem: without a store the module behaves exactly as before.
 */

/** Default sessions tracked before the oldest is evicted. One small record each. */
const DEFAULT_SESSIONS_MAX = 512;
const MIN_SESSIONS_MAX = 64;
const MAX_SESSIONS_MAX = 8192;
let maxSessions = DEFAULT_SESSIONS_MAX;

/**
 * Grace added to the provider TTL before we call a cache dead. Our clock is the
 * request-arrival time, the provider's is its own; a request that lands one
 * second inside the window can still miss. Only gaps clearly past the TTL flip
 * the session cold, so a borderline case keeps the (cheap, correct) warm path.
 */
const COLD_GRACE_MS = 30_000;

/**
 * Idle gap past which we treat an unobserved cache as gone.
 *
 * Not the ephemeral-tier TTL (`CACHE_TTL_SEC`, 5 minutes). Using that here declared sessions cold while their caches were
 * demonstrably alive: 66% of gaps past 5.5 minutes still cache-read, 40% past
 * 15 minutes, 13% past an hour (143 gaps, one production host). Claude Code marks
 * some blocks with the 1-hour TTL, so the short constant never described this
 * traffic.
 *
 * An hour plus the grace is where the evidence turns: past it, warmth is the
 * exception. This is only a backstop anyway — {@link noteCacheOutcome} answers
 * from the provider's own accounting whenever a response has been seen.
 */
const COLD_HORIZON_MS = 3_600_000 + COLD_GRACE_MS;

/** On-disk format tag. Bump when a field changes meaning; older files are ignored. */
const PERSIST_FORMAT = 1;

/**
 * Records idle longer than this are not persisted and not restored. Well past
 * {@link COLD_HORIZON_MS}, where the clock alone already declares the session
 * cold and a repack is free — a pin that old protects nothing. 24 hours.
 */
const PERSIST_MAX_IDLE_MS = 24 * 3_600_000;

/**
 * Coalesce saves. Every request touches `lastSeenMs`, and a Claude Code turn can
 * be several requests in a burst; one write per burst is plenty. Short enough
 * that a supervisor hard-kill (no signal on Windows) loses at most this window
 * of clock updates — never a pin recorded on an earlier turn.
 */
const PERSIST_DEBOUNCE_MS = 250;

/** Maximum sealed epoch keys retained per session (head-retaining cap so epoch_0 is never evicted). */
const SEALED_EPOCH_KEYS_MAX = 512;

/** Maximum pinned skill names retained per session. */
const PINNED_SKILLS_MAX = 32;

/** Maximum persisted folded Markovian episode IDs per session. */
const FOLDED_EPISODE_IDS_MAX = 256;

/** Maximum per-session liveness scopes retained (e.g. opus vs haiku vs systemSha8). */
const LIVENESS_SCOPES_MAX = 16;

export type OpticalHistoryPolicy = 'hybrid' | 'full';
export type CacheCircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface CacheHealthSample {
  readonly hitRatio: number;
  readonly wrote1h: boolean;
}

const CACHE_HEALTH_WINDOW_MAX = 5;
const CACHE_BREAKER_MAX_TURNS = 32;
const CACHE_BREAKER_COLD_MIN_TOKENS = 1024;
const CACHE_BREAKER_CUSUM_DRIFT = 0.12;
const CACHE_BREAKER_CUSUM_ALARM = 0.50;
const CACHE_BREAKER_REGRET_ALARM = 1.80;
const CACHE_BREAKER_REGRET_DECAY = 0.70;
const CACHE_BREAKER_INTERTURN_MIN_SEC = 1;
const CACHE_BREAKER_INTERTURN_MAX_SEC = 86_400;

export interface SessionLivenessScopeOpts {
  readonly nowMs?: number;
  readonly model?: string;
  readonly modelFamily?: string;
  readonly systemSha8?: string;
  readonly scope?: string;
}

export type SessionScopeOptions = SessionLivenessScopeOpts;

interface ScopedLivenessRecord {
  lastSeenMs: number;
  freezeStep: number;
  cacheDead: boolean;
  repackInFlightCount?: number;
  repackGeneration?: number;
  lastCacheAlive?: boolean;
  everCacheAlive?: boolean;
  opticalHistoryPolicy?: OpticalHistoryPolicy;
  recentCacheWindow?: CacheHealthSample[];
  circuitBreakerTurnsLeft?: number;
  prevPromptTokens?: number;
  cusum?: number;
  ewmaRegret?: number;
  ewmaHitRatio?: number;
  breakerState?: 0 | 1 | 2;
  breakerTurnsLeft?: number;
  breakerTripCount?: number;
  cleanStreak?: number;
  ewmaInterTurnSec?: number;
  lastTurnTsMs?: number;
}

interface SessionRecord extends ScopedLivenessRecord {
  primaryScope?: string;
  livenessScopes?: Record<string, ScopedLivenessRecord>;
  /** Sticky sealed LSM/ACDC text epoch keys (head-retained up to 512 keys). */
  sealedEpochKeys?: string[];
  /** Sticky sealed Stage-2 text hygiene & frontier optical slot keys (head-retained up to 512 keys). */
  sealedStage2SlotKeys?: string[];
  /** Session-pinned skill names (capped to 32 names) for cache prefix stability. */
  pinnedSkills?: string[];
  /** Hash of the skill catalog under which `pinnedSkills` were chosen. */
  pinnedSkillCatalogHash?: string;
  /** Persisted causal episode IDs folded for this session. */
  foldedMarkovEpisodeIds?: string[];
  /** Frozen certificate bytes keyed by folded episode ID so page eviction never mutates replay. */
  foldedMarkovCertificates?: Record<string, string>;
}

const sessions = new Map<string, SessionRecord>();

function touch(key: string): SessionRecord {
  const existing = sessions.get(key);
  if (existing) {
    sessions.delete(key); // refresh LRU position
    sessions.set(key, existing);
    return existing;
  }
  const fresh: SessionRecord = { lastSeenMs: 0, freezeStep: 0, cacheDead: false };
  sessions.set(key, fresh);
  evictToCapacity();
  return fresh;
}

function evictToCapacity(): void {
  while (sessions.size > maxSessions) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

/**
 * Configure the maximum tracked sessions kept in RAM (clamped to `[64, 8192]`),
 * evicting oldest entries immediately if capacity shrinks.
 */
export function configureMaxSessions(limit?: number): number {
  if (limit !== undefined && Number.isFinite(limit)) {
    maxSessions = Math.min(MAX_SESSIONS_MAX, Math.max(MIN_SESSIONS_MAX, Math.floor(limit)));
  } else {
    maxSessions = DEFAULT_SESSIONS_MAX;
  }
  evictToCapacity();
  return maxSessions;
}

/** Current maximum tracked session count. */
export function getMaxSessions(): number {
  return maxSessions;
}

// --- persistence ------------------------------------------------------------

/**
 * Host-supplied storage for the session map. The core stays filesystem-free;
 * `node.ts` backs this with `~/.inkling/session-state.json`, tests with a string.
 * `load` returns the last saved text or `undefined` when nothing was saved yet.
 * `save` must be atomic from the reader's point of view (write-then-rename).
 */
export interface SessionStateStore {
  load(): string | undefined;
  save(text: string): void;
}

let store: SessionStateStore | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

interface PersistedRecord extends SessionRecord {
  key: string;
}

interface PersistedState {
  format: number;
  saved_at_ms: number;
  sessions: PersistedRecord[];
}

/**
 * Attach (or with `undefined`, detach) the store and restore what it holds.
 * Flushes pending changes to the previous store first. Returns how many
 * sessions were restored. Never throws: a store that cannot be read leaves the
 * map as it was — the pre-persistence behaviour, which is safe (unknown = warm).
 */
export function configureSessionStateStore(
  next: SessionStateStore | undefined,
  nowMs: number = Date.now(),
): number {
  flushSessionState();
  store = next;
  if (!next) return 0;
  let text: string | undefined;
  try {
    text = next.load();
  } catch {
    return 0;
  }
  return restoreSessionState(text, nowMs);
}

/**
 * Merge a serialized snapshot into the map. Records already in memory win (they
 * are newer by construction); records idle past {@link PERSIST_MAX_IDLE_MS} or
 * malformed in any field are skipped. Returns the number restored.
 */
export function restoreSessionState(text: string | undefined, nowMs: number = Date.now()): number {
  if (!text) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 0;
  }
  if (!isPersistedState(parsed)) return 0;
  let restored = 0;
  for (const entry of parsed.sessions) {
    const rec = validRecord(entry, nowMs);
    if (!rec || sessions.has(entry.key)) continue;
    sessions.set(entry.key, rec);
    restored++;
  }
  evictToCapacity();
  return restored;
}

function isPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<PersistedState>;
  return v.format === PERSIST_FORMAT && Array.isArray(v.sessions);
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function sanitizeStringArray(raw: unknown, maxLen: number, keepTail: boolean): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') continue;
    if (keepTail) {
      if (seen.has(item)) {
        const idx = deduped.indexOf(item);
        if (idx >= 0) deduped.splice(idx, 1);
      } else {
        seen.add(item);
      }
      deduped.push(item);
    } else if (!seen.has(item)) {
      seen.add(item);
      deduped.push(item);
      if (deduped.length >= maxLen) break;
    }
  }
  if (deduped.length === 0) return undefined;
  return keepTail && deduped.length > maxLen ? deduped.slice(-maxLen) : deduped;
}

function sanitizeCacheWindow(raw: unknown): CacheHealthSample[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CacheHealthSample[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const sample = item as Partial<CacheHealthSample>;
    if (
      typeof sample.hitRatio !== 'number' ||
      !Number.isFinite(sample.hitRatio) ||
      sample.hitRatio < 0 ||
      sample.hitRatio > 1 ||
      typeof sample.wrote1h !== 'boolean'
    ) {
      continue;
    }
    out.push({ hitRatio: sample.hitRatio, wrote1h: sample.wrote1h });
  }
  if (out.length === 0) return undefined;
  return out.length > CACHE_HEALTH_WINDOW_MAX ? out.slice(-CACHE_HEALTH_WINDOW_MAX) : out;
}

function sanitizeBreakerTurns(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(CACHE_BREAKER_MAX_TURNS, Math.floor(raw));
}

function sanitizeFiniteNonNeg(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function sanitizeScopedHealthFields(src: Partial<ScopedLivenessRecord>, dst: ScopedLivenessRecord): void {
  const win = sanitizeCacheWindow(src.recentCacheWindow);
  if (win) dst.recentCacheWindow = win;
  const legacyTurns = sanitizeBreakerTurns(src.circuitBreakerTurnsLeft);
  if (legacyTurns !== undefined) dst.circuitBreakerTurnsLeft = legacyTurns;

  const prevPrompt = sanitizeFiniteNonNeg(src.prevPromptTokens);
  if (prevPrompt !== undefined) dst.prevPromptTokens = Math.floor(prevPrompt);
  const cusum = sanitizeFiniteNonNeg(src.cusum);
  if (cusum !== undefined) dst.cusum = cusum;
  const regret = sanitizeFiniteNonNeg(src.ewmaRegret);
  if (regret !== undefined) dst.ewmaRegret = regret;
  if (typeof src.ewmaHitRatio === 'number' && Number.isFinite(src.ewmaHitRatio) && src.ewmaHitRatio >= 0 && src.ewmaHitRatio <= 1) {
    dst.ewmaHitRatio = src.ewmaHitRatio;
  }
  if (src.breakerState === 0 || src.breakerState === 1 || src.breakerState === 2) {
    dst.breakerState = src.breakerState;
  }
  const turnsLeft = sanitizeFiniteNonNeg(src.breakerTurnsLeft);
  if (turnsLeft !== undefined) dst.breakerTurnsLeft = Math.min(CACHE_BREAKER_MAX_TURNS, Math.floor(turnsLeft));
  const tripCount = sanitizeFiniteNonNeg(src.breakerTripCount);
  if (tripCount !== undefined) dst.breakerTripCount = Math.min(4, Math.floor(tripCount));
  const cleanStreak = sanitizeFiniteNonNeg(src.cleanStreak);
  if (cleanStreak !== undefined) dst.cleanStreak = Math.floor(cleanStreak);
  if (typeof src.ewmaInterTurnSec === 'number' && Number.isFinite(src.ewmaInterTurnSec) && src.ewmaInterTurnSec > 0) {
    dst.ewmaInterTurnSec = Math.min(CACHE_BREAKER_INTERTURN_MAX_SEC, Math.max(CACHE_BREAKER_INTERTURN_MIN_SEC, src.ewmaInterTurnSec));
  }
  if (typeof src.lastTurnTsMs === 'number' && Number.isFinite(src.lastTurnTsMs) && src.lastTurnTsMs > 0) {
    dst.lastTurnTsMs = src.lastTurnTsMs;
  }
  if (dst.breakerState === undefined && legacyTurns !== undefined && legacyTurns > 0) {
    dst.breakerState = 1;
    dst.breakerTurnsLeft = dst.breakerTurnsLeft ?? legacyTurns;
  }
}

function serializeScopedHealthFields(src: ScopedLivenessRecord, dst: ScopedLivenessRecord): void {
  if (src.recentCacheWindow && src.recentCacheWindow.length > 0) {
    dst.recentCacheWindow = src.recentCacheWindow.slice(-CACHE_HEALTH_WINDOW_MAX);
  }
  if ((src.circuitBreakerTurnsLeft ?? 0) > 0) {
    dst.circuitBreakerTurnsLeft = src.circuitBreakerTurnsLeft;
  }
  if (src.prevPromptTokens !== undefined) dst.prevPromptTokens = src.prevPromptTokens;
  if (src.cusum !== undefined && src.cusum > 0) dst.cusum = src.cusum;
  if (src.ewmaRegret !== undefined && src.ewmaRegret > 0) dst.ewmaRegret = src.ewmaRegret;
  if (src.ewmaHitRatio !== undefined) dst.ewmaHitRatio = src.ewmaHitRatio;
  if (src.breakerState !== undefined && src.breakerState !== 0) dst.breakerState = src.breakerState;
  if ((src.breakerTurnsLeft ?? 0) > 0) dst.breakerTurnsLeft = src.breakerTurnsLeft;
  if ((src.breakerTripCount ?? 0) > 0) dst.breakerTripCount = src.breakerTripCount;
  if ((src.cleanStreak ?? 0) > 0) dst.cleanStreak = src.cleanStreak;
  if (src.ewmaInterTurnSec !== undefined) dst.ewmaInterTurnSec = src.ewmaInterTurnSec;
  if (src.lastTurnTsMs !== undefined) dst.lastTurnTsMs = src.lastTurnTsMs;
}

function validRecord(entry: unknown, nowMs: number): SessionRecord | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as Partial<PersistedRecord>;
  if (typeof e.key !== 'string' || e.key === '') return undefined;
  if (typeof e.lastSeenMs !== 'number' || !Number.isFinite(e.lastSeenMs) || e.lastSeenMs <= 0) return undefined;
  if (nowMs - e.lastSeenMs > PERSIST_MAX_IDLE_MS) return undefined;
  if (typeof e.freezeStep !== 'number' || !Number.isFinite(e.freezeStep) || e.freezeStep < 0) return undefined;
  if (!isBool(e.cacheDead)) return undefined;
  const rec: SessionRecord = { lastSeenMs: e.lastSeenMs, freezeStep: e.freezeStep, cacheDead: e.cacheDead };
  if (isBool(e.lastCacheAlive)) rec.lastCacheAlive = e.lastCacheAlive;
  if (isBool(e.everCacheAlive)) rec.everCacheAlive = e.everCacheAlive;
  const sealed = sanitizeStringArray(e.sealedEpochKeys, SEALED_EPOCH_KEYS_MAX, false);
  if (sealed) rec.sealedEpochKeys = sealed;
  const stage2Sealed = sanitizeStringArray(e.sealedStage2SlotKeys, SEALED_EPOCH_KEYS_MAX, false);
  if (stage2Sealed) rec.sealedStage2SlotKeys = stage2Sealed;
  const skills = sanitizeStringArray(e.pinnedSkills, PINNED_SKILLS_MAX, false);
  if (skills) rec.pinnedSkills = skills;
  if (typeof e.pinnedSkillCatalogHash === 'string' && e.pinnedSkillCatalogHash !== '') {
    rec.pinnedSkillCatalogHash = e.pinnedSkillCatalogHash;
  }
  const folded = sanitizeStringArray(e.foldedMarkovEpisodeIds, FOLDED_EPISODE_IDS_MAX, false);
  if (folded) rec.foldedMarkovEpisodeIds = folded;
  if (e.foldedMarkovCertificates && typeof e.foldedMarkovCertificates === 'object' && !Array.isArray(e.foldedMarkovCertificates)) {
    const certs: Record<string, string> = {};
    let count = 0;
    for (const [k, v] of Object.entries(e.foldedMarkovCertificates)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v && count < FOLDED_EPISODE_IDS_MAX) {
        certs[k] = v;
        count++;
      }
    }
    if (count > 0) rec.foldedMarkovCertificates = certs;
  }
  if (e.opticalHistoryPolicy === 'hybrid' || e.opticalHistoryPolicy === 'full') {
    rec.opticalHistoryPolicy = e.opticalHistoryPolicy;
  }
  sanitizeScopedHealthFields(e, rec);
  if (typeof e.primaryScope === 'string' && e.primaryScope) {
    rec.primaryScope = e.primaryScope;
  }
  if (e.livenessScopes && typeof e.livenessScopes === 'object' && !Array.isArray(e.livenessScopes)) {
    const scopes: Record<string, ScopedLivenessRecord> = {};
    let sc = 0;
    for (const [sk, rawScope] of Object.entries(e.livenessScopes)) {
      if (sc >= LIVENESS_SCOPES_MAX || typeof sk !== 'string' || !sk || !rawScope || typeof rawScope !== 'object') continue;
      const sr = rawScope as Partial<ScopedLivenessRecord>;
      if (
        typeof sr.lastSeenMs !== 'number' || !Number.isFinite(sr.lastSeenMs) || sr.lastSeenMs < 0 ||
        typeof sr.freezeStep !== 'number' || !Number.isFinite(sr.freezeStep) || sr.freezeStep < 0 ||
        !isBool(sr.cacheDead)
      ) {
        continue;
      }
      const cleanScope: ScopedLivenessRecord = {
        lastSeenMs: sr.lastSeenMs,
        freezeStep: sr.freezeStep,
        cacheDead: sr.cacheDead,
      };
      if (isBool(sr.lastCacheAlive)) cleanScope.lastCacheAlive = sr.lastCacheAlive;
      if (isBool(sr.everCacheAlive)) cleanScope.everCacheAlive = sr.everCacheAlive;
      if (sr.opticalHistoryPolicy === 'hybrid' || sr.opticalHistoryPolicy === 'full') {
        cleanScope.opticalHistoryPolicy = sr.opticalHistoryPolicy;
      }
      sanitizeScopedHealthFields(sr, cleanScope);
      scopes[sk] = cleanScope;
      sc++;
    }
    if (sc > 0) rec.livenessScopes = scopes;
  }
  return rec;
}

/** The map as JSON, oldest session first (LRU order), stale records omitted. */
export function serializeSessionState(nowMs: number = Date.now()): string {
  const out: PersistedRecord[] = [];
  for (const [key, rec] of sessions) {
    if (rec.lastSeenMs <= 0 || nowMs - rec.lastSeenMs > PERSIST_MAX_IDLE_MS) continue;
    const item: PersistedRecord = {
      key,
      lastSeenMs: rec.lastSeenMs,
      freezeStep: rec.freezeStep,
      cacheDead: rec.cacheDead,
    };
    if (rec.lastCacheAlive !== undefined) item.lastCacheAlive = rec.lastCacheAlive;
    if (rec.everCacheAlive !== undefined) item.everCacheAlive = rec.everCacheAlive;
    if (rec.opticalHistoryPolicy !== undefined) item.opticalHistoryPolicy = rec.opticalHistoryPolicy;
    serializeScopedHealthFields(rec, item);
    if (rec.primaryScope !== undefined) item.primaryScope = rec.primaryScope;
    if (rec.livenessScopes) {
      const persistedScopes: Record<string, ScopedLivenessRecord> = {};
      let sc = 0;
      for (const [sk, sr] of Object.entries(rec.livenessScopes)) {
        if (sc >= LIVENESS_SCOPES_MAX) break;
        const ps: ScopedLivenessRecord = {
          lastSeenMs: sr.lastSeenMs,
          freezeStep: sr.freezeStep,
          cacheDead: sr.cacheDead,
          ...(sr.lastCacheAlive !== undefined ? { lastCacheAlive: sr.lastCacheAlive } : {}),
          ...(sr.everCacheAlive !== undefined ? { everCacheAlive: sr.everCacheAlive } : {}),
          ...(sr.opticalHistoryPolicy !== undefined ? { opticalHistoryPolicy: sr.opticalHistoryPolicy } : {}),
        };
        serializeScopedHealthFields(sr, ps);
        persistedScopes[sk] = ps;
        sc++;
      }
      if (sc > 0) item.livenessScopes = persistedScopes;
    }
    if (rec.sealedEpochKeys && rec.sealedEpochKeys.length > 0) {
      item.sealedEpochKeys = rec.sealedEpochKeys.slice(0, SEALED_EPOCH_KEYS_MAX);
    }
    if (rec.sealedStage2SlotKeys && rec.sealedStage2SlotKeys.length > 0) {
      item.sealedStage2SlotKeys = rec.sealedStage2SlotKeys.slice(0, SEALED_EPOCH_KEYS_MAX);
    }
    if (rec.pinnedSkills && rec.pinnedSkills.length > 0) {
      item.pinnedSkills = rec.pinnedSkills.slice(0, PINNED_SKILLS_MAX);
    }
    if (rec.pinnedSkillCatalogHash !== undefined && rec.pinnedSkillCatalogHash !== '') {
      item.pinnedSkillCatalogHash = rec.pinnedSkillCatalogHash;
    }
    if (rec.foldedMarkovEpisodeIds && rec.foldedMarkovEpisodeIds.length > 0) {
      item.foldedMarkovEpisodeIds = rec.foldedMarkovEpisodeIds.slice(0, FOLDED_EPISODE_IDS_MAX);
    }
    if (rec.foldedMarkovCertificates) {
      const certs: Record<string, string> = {};
      let count = 0;
      for (const [k, v] of Object.entries(rec.foldedMarkovCertificates)) {
        if (count >= FOLDED_EPISODE_IDS_MAX) break;
        certs[k] = v;
        count++;
      }
      if (count > 0) item.foldedMarkovCertificates = certs;
    }
    out.push(item);
  }
  const state: PersistedState = { format: PERSIST_FORMAT, saved_at_ms: nowMs, sessions: out };
  return JSON.stringify(state);
}

function scheduleSave(): void {
  if (!store) return;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    flushSessionState();
  }, PERSIST_DEBOUNCE_MS);
  // Never keep the process alive for a bookkeeping write.
  (saveTimer as { unref?: () => void }).unref?.();
}

/**
 * Write pending changes now. Returns true when a save happened. Called by the
 * debounce timer, on store change, and by the host on shutdown. A failing store
 * is swallowed: persistence is an optimisation and must never fail a request.
 */
export function flushSessionState(): boolean {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (!store || !dirty) return false;
  dirty = false;
  try {
    store.save(serializeSessionState());
    return true;
  } catch {
    return false;
  }
}

// --- request-path API -------------------------------------------------------

export interface HistorySessionState {
  /** The upstream prefix cache is provably gone — re-cutting the grid is free. */
  cold: boolean;
  /** Floor for the freeze step, in messages. 0 = no constraint. */
  minFreezeStep: number;
}

/** Neutral answer for callers without a session identity (no fingerprint yet). */
const UNKNOWN_STATE: HistorySessionState = { cold: false, minFreezeStep: 0 };

/** Normalize a model ID to its liveness family so auxiliary Haiku calls never clobber main-thread liveness. */
export function normalizeSessionModelFamily(model: string | undefined): string {
  const raw = (model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]/g, '');
  if (!raw) return '';
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  const bare = tail.split('@')[0]!;
  if (bare.includes('claude') || bare.includes('anthropic')) {
    if (bare.includes('haiku')) return 'claude-haiku';
    if (bare.includes('opus')) return 'claude-opus';
    if (bare.includes('sonnet')) return 'claude-sonnet';
    if (bare.includes('fable')) return 'claude-fable';
    return 'claude';
  }
  return bare.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function resolveScopeKey(opts?: SessionLivenessScopeOpts): string | undefined {
  if (!opts) return undefined;
  if (opts.scope) return opts.scope;
  const family = opts.modelFamily ?? (opts.model ? normalizeSessionModelFamily(opts.model) : '');
  if (family && opts.systemSha8) return `${family}:${opts.systemSha8}`;
  if (family) return family;
  if (opts.systemSha8) return opts.systemSha8;
  return undefined;
}

function isAuxiliaryScope(scope: string | undefined): boolean {
  return scope !== undefined && (scope === 'claude-haiku' || scope.startsWith('claude-haiku:'));
}

function getOrCreateScopeRecord(rec: SessionRecord, scope: string): ScopedLivenessRecord {
  if (!rec.livenessScopes) rec.livenessScopes = {};
  const existing = rec.livenessScopes[scope];
  if (existing) return existing;
  const keys = Object.keys(rec.livenessScopes);
  if (keys.length >= LIVENESS_SCOPES_MAX) {
    let oldestKey = keys[0];
    for (const k of keys) {
      if (k !== rec.primaryScope && (oldestKey === rec.primaryScope || rec.livenessScopes[k]!.lastSeenMs < rec.livenessScopes[oldestKey!]!.lastSeenMs)) {
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined && oldestKey !== rec.primaryScope) {
      delete rec.livenessScopes[oldestKey];
    }
  }
  const fresh: ScopedLivenessRecord = { lastSeenMs: 0, freezeStep: 0, cacheDead: false };
  rec.livenessScopes[scope] = fresh;
  return fresh;
}

function computeCold(target: ScopedLivenessRecord, nowMs: number): boolean {
  const known = target.lastSeenMs > 0;
  const idleMs = nowMs - target.lastSeenMs;
  const serverSaysAlive = target.lastCacheAlive === true;
  const serverSaysGone = target.lastCacheAlive === false && target.everCacheAlive === true;
  const beyondHorizon = known && idleMs > COLD_HORIZON_MS;
  return target.cacheDead || (!serverSaysAlive && (serverSaysGone || beyondHorizon));
}

function applyHistoryRequestToTarget(target: ScopedLivenessRecord, nowMs: number): HistorySessionState {
  const cold = computeCold(target, nowMs);
  target.lastSeenMs = nowMs;
  target.cacheDead = false; // consumed: this request gets the repack
  if (cold) {
    target.repackInFlightCount = (target.repackInFlightCount ?? 0) + 1;
    target.repackGeneration = (target.repackGeneration ?? 0) + 1;
    target.lastCacheAlive = undefined;
  }
  return { cold, minFreezeStep: target.freezeStep };
}

/**
 * Record a request for `sessionKey` and report what the history collapse may
 * assume about the upstream cache. Call once per transformed request, BEFORE the
 * collapse runs; it advances the session's last-seen clock.
 *
 * A session we have never seen counts as warm (see module docs) — unknown must
 * never authorize a repack.
 */
export function noteHistoryRequest(
  sessionKey: string | undefined,
  nowMsOrOpts: number | SessionLivenessScopeOpts = Date.now(),
): HistorySessionState {
  if (!sessionKey) return UNKNOWN_STATE;
  const nowMs = typeof nowMsOrOpts === 'number' ? nowMsOrOpts : (nowMsOrOpts.nowMs ?? Date.now());
  const scope = typeof nowMsOrOpts === 'number' ? undefined : resolveScopeKey(nowMsOrOpts);
  const rec = touch(sessionKey);

  if (scope) {
    if (!rec.primaryScope && !isAuxiliaryScope(scope)) {
      rec.primaryScope = scope;
    }
    const scoped = getOrCreateScopeRecord(rec, scope);
    const result = applyHistoryRequestToTarget(scoped, nowMs);
    if (rec.primaryScope === scope || (!rec.primaryScope && !isAuxiliaryScope(scope))) {
      applyHistoryRequestToTarget(rec, nowMs);
    } else if (rec.lastSeenMs <= 0) {
      // Keep record non-stale for persistence without triggering primary coldness.
      rec.lastSeenMs = nowMs;
    }
    scheduleSave();
    return result;
  }

  const result = applyHistoryRequestToTarget(rec, nowMs);
  scheduleSave();
  return result;
}

/**
 * Non-mutating read checking whether `sessionKey`'s upstream cache is currently cold.
 * Unknown/unseen sessions return `false` (warm by default).
 */
export function isSessionCacheCold(
  sessionKey: string | undefined,
  nowMsOrOpts: number | SessionLivenessScopeOpts = Date.now(),
): boolean {
  if (!sessionKey) return false;
  const rec = sessions.get(sessionKey);
  if (!rec) return false;
  const nowMs = typeof nowMsOrOpts === 'number' ? nowMsOrOpts : (nowMsOrOpts.nowMs ?? Date.now());
  const scope = typeof nowMsOrOpts === 'number' ? undefined : resolveScopeKey(nowMsOrOpts);
  if (scope) {
    const scoped = rec.livenessScopes?.[scope];
    if (scoped) return computeCold(scoped, nowMs);
    if (isAuxiliaryScope(scope) && rec.primaryScope && rec.primaryScope !== scope) {
      return false;
    }
  }
  return computeCold(rec, nowMs);
}

export function getPinnedOpticalHistoryPolicy(
  sessionKey: string | undefined,
  opts?: SessionLivenessScopeOpts,
): OpticalHistoryPolicy | undefined {
  if (!sessionKey) return undefined;
  const rec = sessions.get(sessionKey);
  if (!rec) return undefined;
  const scope = resolveScopeKey(opts);
  if (scope && rec.livenessScopes?.[scope]?.opticalHistoryPolicy !== undefined) {
    return rec.livenessScopes[scope]!.opticalHistoryPolicy;
  }
  if (scope && isAuxiliaryScope(scope) && rec.primaryScope && rec.primaryScope !== scope) {
    return undefined;
  }
  return rec.opticalHistoryPolicy;
}

export function setPinnedOpticalHistoryPolicy(
  sessionKey: string | undefined,
  policy: OpticalHistoryPolicy,
  opts?: SessionLivenessScopeOpts,
): void {
  if (!sessionKey) return;
  const rec = touch(sessionKey);
  if (rec.lastSeenMs <= 0) rec.lastSeenMs = Date.now();
  const scope = resolveScopeKey(opts);
  if (scope) {
    const scoped = getOrCreateScopeRecord(rec, scope);
    if (scoped.lastSeenMs <= 0) scoped.lastSeenMs = rec.lastSeenMs;
    if (scoped.opticalHistoryPolicy !== policy) {
      scoped.opticalHistoryPolicy = policy;
      scheduleSave();
    }
    if (rec.primaryScope === scope || (!rec.primaryScope && !isAuxiliaryScope(scope))) {
      if (rec.opticalHistoryPolicy !== policy) {
        rec.opticalHistoryPolicy = policy;
        scheduleSave();
      }
    }
    return;
  }
  if (rec.opticalHistoryPolicy !== policy) {
    rec.opticalHistoryPolicy = policy;
    scheduleSave();
  }
}

export function recordSealedEpochKey(
  sessionKey: string | undefined,
  epochKey: string,
): void {
  if (!sessionKey || !epochKey) return;
  const rec = touch(sessionKey);
  if (rec.lastSeenMs <= 0) rec.lastSeenMs = Date.now();
  if (!rec.sealedEpochKeys) {
    rec.sealedEpochKeys = [epochKey];
    scheduleSave();
    return;
  }
  if (rec.sealedEpochKeys.includes(epochKey)) return;
  if (rec.sealedEpochKeys.length >= SEALED_EPOCH_KEYS_MAX) return; // retain earliest head epochs
  rec.sealedEpochKeys.push(epochKey);
  scheduleSave();
}

export function hasSealedEpochKey(
  sessionKey: string | undefined,
  epochKey: string,
): boolean {
  if (!sessionKey || !epochKey) return false;
  const rec = sessions.get(sessionKey);
  return Boolean(rec?.sealedEpochKeys?.includes(epochKey));
}

/**
 * Record a Stage-2 text-hygiene or hybrid optical slot seal key (head-retaining
 * cap 512) so any compression performed at the uncached frontier replays
 * bit-identically once downstream cache_control breakpoints cover that slot.
 */
export function recordStage2SealKey(
  sessionKey: string | undefined,
  slotKey: string,
): void {
  if (!sessionKey || !slotKey) return;
  const rec = touch(sessionKey);
  if (rec.lastSeenMs <= 0) rec.lastSeenMs = Date.now();
  if (!rec.sealedStage2SlotKeys) {
    rec.sealedStage2SlotKeys = [slotKey];
    scheduleSave();
    return;
  }
  if (rec.sealedStage2SlotKeys.includes(slotKey)) return;
  if (rec.sealedStage2SlotKeys.length >= SEALED_EPOCH_KEYS_MAX) return;
  rec.sealedStage2SlotKeys.push(slotKey);
  scheduleSave();
}

export function hasStage2SealKey(
  sessionKey: string | undefined,
  slotKey: string,
): boolean {
  if (!sessionKey || !slotKey) return false;
  const rec = sessions.get(sessionKey);
  return Boolean(rec?.sealedStage2SlotKeys?.includes(slotKey));
}

export function removeStage2SealKeys(
  sessionKey: string | undefined,
  slotKeys: readonly string[],
): void {
  if (!sessionKey || slotKeys.length === 0) return;
  const rec = sessions.get(sessionKey);
  if (!rec?.sealedStage2SlotKeys || rec.sealedStage2SlotKeys.length === 0) return;
  const drop = new Set(slotKeys);
  const next = rec.sealedStage2SlotKeys.filter((k) => !drop.has(k));
  if (next.length !== rec.sealedStage2SlotKeys.length) {
    rec.sealedStage2SlotKeys = next;
    scheduleSave();
  }
}

export function recordFoldedEpisodeId(
  sessionKey: string | undefined,
  episodeId: string,
  certificate?: string,
): void {
  if (!sessionKey || !episodeId) return;
  const rec = touch(sessionKey);
  if (rec.lastSeenMs <= 0) rec.lastSeenMs = Date.now();
  let updated = false;
  if (!rec.foldedMarkovEpisodeIds) {
    rec.foldedMarkovEpisodeIds = [episodeId];
    updated = true;
  } else if (!rec.foldedMarkovEpisodeIds.includes(episodeId) && rec.foldedMarkovEpisodeIds.length < FOLDED_EPISODE_IDS_MAX) {
    rec.foldedMarkovEpisodeIds.push(episodeId);
    updated = true;
  }
  if (certificate) {
    if (!rec.foldedMarkovCertificates) rec.foldedMarkovCertificates = {};
    if (rec.foldedMarkovCertificates[episodeId] !== certificate && Object.keys(rec.foldedMarkovCertificates).length < FOLDED_EPISODE_IDS_MAX) {
      rec.foldedMarkovCertificates[episodeId] = certificate;
      updated = true;
    }
  }
  if (updated) scheduleSave();
}

export function getFoldedEpisodeCertificate(
  sessionKey: string | undefined,
  episodeId: string,
): string | undefined {
  if (!sessionKey || !episodeId) return undefined;
  return sessions.get(sessionKey)?.foldedMarkovCertificates?.[episodeId];
}

export function hasFoldedEpisodeId(
  sessionKey: string | undefined,
  episodeId: string,
): boolean {
  if (!sessionKey || !episodeId) return false;
  const rec = sessions.get(sessionKey);
  return Boolean(rec?.foldedMarkovEpisodeIds?.includes(episodeId));
}

export function hasAnyFoldedEpisodeId(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  const rec = sessions.get(sessionKey);
  return Boolean(rec?.foldedMarkovEpisodeIds && rec.foldedMarkovEpisodeIds.length > 0);
}

export function getPinnedSessionSkills(
  sessionKey: string | undefined,
  catalogHash: string,
): readonly string[] | undefined {
  if (!sessionKey || !catalogHash) return undefined;
  const rec = sessions.get(sessionKey);
  if (!rec || rec.pinnedSkillCatalogHash !== catalogHash || !rec.pinnedSkills) {
    return undefined;
  }
  return [...rec.pinnedSkills];
}

export function setPinnedSessionSkills(
  sessionKey: string | undefined,
  catalogHash: string,
  skills: readonly string[],
): void {
  if (!sessionKey || !catalogHash) return;
  const cleaned = sanitizeStringArray(skills, PINNED_SKILLS_MAX, false);
  const rec = touch(sessionKey);
  if (rec.lastSeenMs <= 0) rec.lastSeenMs = Date.now();
  if (!cleaned) {
    if (rec.pinnedSkills !== undefined || rec.pinnedSkillCatalogHash !== undefined) {
      delete rec.pinnedSkills;
      delete rec.pinnedSkillCatalogHash;
      scheduleSave();
    }
    return;
  }
  const sameHash = rec.pinnedSkillCatalogHash === catalogHash;
  const sameSkills =
    sameHash &&
    rec.pinnedSkills !== undefined &&
    rec.pinnedSkills.length === cleaned.length &&
    rec.pinnedSkills.every((s, idx) => s === cleaned[idx]);
  if (sameSkills) return;
  rec.pinnedSkills = cleaned;
  rec.pinnedSkillCatalogHash = catalogHash;
  scheduleSave();
}

/**
 * Feed the provider's cache accounting back in, once per response.
 *
 * `read > 0` proves the prefix was live. `create > 0` proves one was just
 * written, which is the case the wall clock got wrong: a turn that paid to build
 * a cache looks identical to a turn that found none, and repacking on top of it
 * discards the thing just paid for.
 *
 * Both zero means nothing is cached for this session, so a repack costs nothing
 * — unless the session just repacked under an implicit-cache provider
 * (`cacheCreateTokens === undefined`), where a cold miss on that repack turn is
 * expected while the provider populates its new implicit cache.
 */
function applyCacheOutcomeToTarget(
  target: ScopedLivenessRecord,
  alive: boolean,
  cacheCreateTokens: number | undefined,
): void {
  if (alive) {
    target.cacheDead = false;
    target.repackInFlightCount = 0;
    target.lastCacheAlive = true;
    target.everCacheAlive = true;
  } else if ((target.repackInFlightCount ?? 0) > 0 && cacheCreateTokens === undefined) {
    // Implicit-cache provider reporting expected zero-read on a freshly repacked turn.
    target.repackInFlightCount = Math.max(0, (target.repackInFlightCount ?? 0) - 1);
    target.lastCacheAlive = undefined;
  } else {
    target.repackInFlightCount = Math.max(0, (target.repackInFlightCount ?? 0) - 1);
    target.lastCacheAlive = false;
  }
}

export function noteCacheOutcome(
  sessionKey: string | undefined,
  cacheReadTokens: number | undefined,
  cacheCreateTokens: number | undefined,
  opts?: SessionLivenessScopeOpts,
): void {
  if (!sessionKey) return;
  const rec = sessions.get(sessionKey);
  if (!rec) return; // never transformed under this key — nothing to attribute
  const alive = (cacheReadTokens ?? 0) > 0 || (cacheCreateTokens ?? 0) > 0;
  const scope = resolveScopeKey(opts);
  if (scope) {
    const scoped = getOrCreateScopeRecord(rec, scope);
    applyCacheOutcomeToTarget(scoped, alive, cacheCreateTokens);
    if (rec.primaryScope === scope || (!rec.primaryScope && !isAuxiliaryScope(scope))) {
      applyCacheOutcomeToTarget(rec, alive, cacheCreateTokens);
    }
    scheduleSave();
    return;
  }
  applyCacheOutcomeToTarget(rec, alive, cacheCreateTokens);
  if (rec.primaryScope && rec.livenessScopes?.[rec.primaryScope]) {
    applyCacheOutcomeToTarget(rec.livenessScopes[rec.primaryScope]!, alive, cacheCreateTokens);
  }
  scheduleSave();
}

interface NormalizedCacheHealthSample {
  readonly cacheReadTokens: number;
  readonly totalInputTokens: number;
  readonly writeRate: number;
  readonly readRate: number;
  readonly nowMs: number;
}

function resolveBreakerState(target: ScopedLivenessRecord): CacheCircuitBreakerState {
  if (target.breakerState === 1) return 'open';
  if (target.breakerState === 2) return 'half_open';
  if (target.breakerState === 0) return 'closed';
  return (target.circuitBreakerTurnsLeft ?? 0) > 0 ? 'open' : 'closed';
}

function readScopedTarget(
  sessionKey: string | undefined,
  opts?: SessionLivenessScopeOpts,
): ScopedLivenessRecord | undefined {
  if (!sessionKey) return undefined;
  const rec = sessions.get(sessionKey);
  if (!rec) return undefined;
  const scope = resolveScopeKey(opts);
  if (scope) {
    const scoped = rec.livenessScopes?.[scope];
    if (scoped) return scoped;
    if (isAuxiliaryScope(scope) && rec.primaryScope && rec.primaryScope !== scope) {
      return undefined;
    }
  }
  return rec;
}

function applyRollingCacheHealthToTarget(
  target: ScopedLivenessRecord,
  sample: NormalizedCacheHealthSample,
): void {
  const { cacheReadTokens, totalInputTokens, writeRate, readRate, nowMs } = sample;

  if (Number.isFinite(nowMs) && nowMs > 0) {
    if (target.lastTurnTsMs !== undefined && target.lastTurnTsMs > 0) {
      const dtSec = Math.min(
        CACHE_BREAKER_INTERTURN_MAX_SEC,
        Math.max(CACHE_BREAKER_INTERTURN_MIN_SEC, (nowMs - target.lastTurnTsMs) / 1000),
      );
      target.ewmaInterTurnSec =
        target.ewmaInterTurnSec === undefined
          ? dtSec
          : 0.7 * target.ewmaInterTurnSec + 0.3 * dtSec;
    }
    target.lastTurnTsMs = nowMs;
  }

  const prevPrompt = target.prevPromptTokens;
  let cacheable: number;
  if (prevPrompt === undefined) {
    if (cacheReadTokens === 0 || totalInputTokens < CACHE_BREAKER_COLD_MIN_TOKENS) {
      target.prevPromptTokens = totalInputTokens;
      return;
    }
    // Mid-session warm entry: prior prefix already existed.
    cacheable = totalInputTokens;
  } else {
    if (prevPrompt < CACHE_BREAKER_COLD_MIN_TOKENS && cacheReadTokens === 0) {
      target.prevPromptTokens = totalInputTokens;
      return;
    }
    cacheable = Math.min(prevPrompt, totalInputTokens);
  }

  const rho = Math.min(1, Math.max(0, cacheReadTokens / Math.max(1, cacheable)));
  const loss = 1 - rho;
  const wasted = loss * cacheable;
  target.ewmaHitRatio = target.ewmaHitRatio === undefined ? rho : 0.75 * target.ewmaHitRatio + 0.25 * rho;

  const state: 0 | 1 | 2 =
    target.breakerState ?? ((target.circuitBreakerTurnsLeft ?? 0) > 0 ? 1 : 0);
  let tripCount = target.breakerTripCount ?? 0;

  if (state === 0) {
    const cusum = Math.max(0, (target.cusum ?? 0) + (loss - CACHE_BREAKER_CUSUM_DRIFT));
    const x =
      loss *
      Math.min(2.5, wasted / 8000) *
      Math.max(0.25, (writeRate - readRate) / 1.15);
    const ewmaRegret = CACHE_BREAKER_REGRET_DECAY * (target.ewmaRegret ?? 0) + x;
    if (cusum >= CACHE_BREAKER_CUSUM_ALARM || ewmaRegret >= CACHE_BREAKER_REGRET_ALARM) {
      tripCount = Math.min(4, tripCount + 1);
      const turnsLeft = Math.min(CACHE_BREAKER_MAX_TURNS, 4 << (tripCount - 1));
      target.breakerState = 1;
      target.breakerTripCount = tripCount;
      target.breakerTurnsLeft = turnsLeft;
      target.circuitBreakerTurnsLeft = turnsLeft;
      target.cusum = 0;
      target.ewmaRegret = 0;
      target.cleanStreak = 0;
    } else {
      target.breakerState = 0;
      target.cusum = cusum;
      target.ewmaRegret = ewmaRegret;
    }
  } else if (state === 1) {
    const curTurns = target.breakerTurnsLeft ?? target.circuitBreakerTurnsLeft ?? 0;
    const turnsLeft = Math.max(0, curTurns - 1);
    const cleanStreak = loss <= 0.05 ? (target.cleanStreak ?? 0) + 1 : 0;
    if (turnsLeft <= 0 || cleanStreak >= 2) {
      target.breakerState = 2;
      target.breakerTurnsLeft = 0;
      target.circuitBreakerTurnsLeft = 0;
      target.cleanStreak = 0;
      target.cusum = 0;
      target.ewmaRegret = 0;
    } else {
      target.breakerState = 1;
      target.breakerTurnsLeft = turnsLeft;
      target.circuitBreakerTurnsLeft = turnsLeft;
      target.cleanStreak = cleanStreak;
    }
  } else {
    if (loss > 0.20) {
      tripCount = Math.min(4, tripCount + 1);
      const turnsLeft = Math.min(CACHE_BREAKER_MAX_TURNS, 4 << (tripCount - 1));
      target.breakerState = 1;
      target.breakerTripCount = tripCount;
      target.breakerTurnsLeft = turnsLeft;
      target.circuitBreakerTurnsLeft = turnsLeft;
      target.cusum = 0;
      target.ewmaRegret = 0;
      target.cleanStreak = 0;
    } else if (loss <= 0.08) {
      const cleanStreak = (target.cleanStreak ?? 0) + 1;
      if (cleanStreak >= 2) {
        target.breakerState = 0;
        target.breakerTripCount = Math.max(0, tripCount - 1);
        target.breakerTurnsLeft = 0;
        target.circuitBreakerTurnsLeft = 0;
        target.cleanStreak = 0;
        target.cusum = 0;
        target.ewmaRegret = 0;
      } else {
        target.breakerState = 2;
        target.cleanStreak = cleanStreak;
      }
    } else {
      target.breakerState = 2;
      target.cleanStreak = 0;
    }
  }

  target.prevPromptTokens = totalInputTokens;
}

/**
 * Record a turn's prompt-cache health via CUSUM + cost-weighted regret FSM
 * to detect genuine mid-prefix cache busts without false-tripping on healthy
 * growing 1h sessions.
 */
export function noteRollingCacheHealth(
  sessionKey: string | undefined,
  usage: {
    cacheReadTokens?: number;
    cacheCreate1hTokens?: number;
    cacheCreate5mTokens?: number;
    totalInputTokens?: number;
    writeRate?: number;
    readRate?: number;
    nowMs?: number;
  },
  opts?: SessionLivenessScopeOpts,
): void {
  if (!sessionKey) return;
  if (usage.totalInputTokens !== undefined && (!Number.isFinite(usage.totalInputTokens) || usage.totalInputTokens <= 0)) {
    return;
  }
  const cacheReadTokens = Math.max(0, usage.cacheReadTokens ?? 0);
  const cc1h = Math.max(0, usage.cacheCreate1hTokens ?? 0);
  const cc5m = Math.max(0, usage.cacheCreate5mTokens ?? 0);
  const rawTotal = Math.max(0, usage.totalInputTokens ?? 0);
  const totalInputTokens = rawTotal > 0 ? Math.max(rawTotal, cacheReadTokens) : cacheReadTokens + cc1h + cc5m;
  if (totalInputTokens <= 0) return;

  const writeRate =
    usage.writeRate !== undefined && Number.isFinite(usage.writeRate) && usage.writeRate >= 0
      ? usage.writeRate
      : cc1h > 0
        ? 2.0
        : 1.25;
  const readRate =
    usage.readRate !== undefined && Number.isFinite(usage.readRate) && usage.readRate >= 0
      ? usage.readRate
      : 0.10;
  const nowMs = usage.nowMs ?? opts?.nowMs ?? Date.now();

  const sample: NormalizedCacheHealthSample = {
    cacheReadTokens,
    totalInputTokens,
    writeRate,
    readRate,
    nowMs,
  };

  const rec = touch(sessionKey);
  if (rec.lastSeenMs <= 0) rec.lastSeenMs = nowMs;

  const scope = resolveScopeKey(opts);
  if (scope) {
    if (!rec.primaryScope && !isAuxiliaryScope(scope)) {
      rec.primaryScope = scope;
    }
    const scoped = getOrCreateScopeRecord(rec, scope);
    if (scoped.lastSeenMs <= 0) scoped.lastSeenMs = nowMs;
    applyRollingCacheHealthToTarget(scoped, sample);
    if (rec.primaryScope === scope || (!rec.primaryScope && !isAuxiliaryScope(scope))) {
      applyRollingCacheHealthToTarget(rec, sample);
    }
    scheduleSave();
    return;
  }

  applyRollingCacheHealthToTarget(rec, sample);
  if (rec.primaryScope && rec.livenessScopes?.[rec.primaryScope]) {
    applyRollingCacheHealthToTarget(rec.livenessScopes[rec.primaryScope]!, sample);
  }
  scheduleSave();
}

/**
 * Non-mutating read of the cache circuit breaker FSM state (`'closed' | 'open' | 'half_open'`).
 * Unknown sessions return `'closed'`.
 */
export function getCacheCircuitBreakerState(
  sessionKey: string | undefined,
  opts?: SessionLivenessScopeOpts,
): CacheCircuitBreakerState {
  const target = readScopedTarget(sessionKey, opts);
  return target ? resolveBreakerState(target) : 'closed';
}

/**
 * Non-mutating check: true when the cache overhead circuit breaker is open
 * for `(sessionKey, opts)`. Unknown sessions return `false`.
 */
export function isCacheCircuitBreakerOpen(
  sessionKey: string | undefined,
  opts?: SessionLivenessScopeOpts,
): boolean {
  return getCacheCircuitBreakerState(sessionKey, opts) === 'open';
}

/**
 * Non-mutating read of smoothed EWMA cache hit ratio and inter-turn interval (seconds)
 * for `(sessionKey, opts)`.
 */
export function getSessionCacheHealthSignals(
  sessionKey: string | undefined,
  opts?: SessionLivenessScopeOpts,
): { ewmaHitRatio: number; ewmaInterTurnSec: number } {
  const target = readScopedTarget(sessionKey, opts);
  return {
    ewmaHitRatio: target?.ewmaHitRatio ?? 1,
    ewmaInterTurnSec: target?.ewmaInterTurnSec ?? 0,
  };
}

/**
 * Compatibility helper: reports whether the cache overhead circuit breaker is open
 * without double-decrementing (turns are advanced once per response in {@link noteRollingCacheHealth}).
 */
export function consumeCacheCircuitBreakerTurn(
  sessionKey: string | undefined,
  opts?: SessionLivenessScopeOpts,
): boolean {
  return isCacheCircuitBreakerOpen(sessionKey, opts);
}

/**
 * Pin the grid this session was last rendered at. Monotonic: the floor only ever
 * rises, because a later, finer render would re-key every chunk it re-cuts.
 */
export function recordFreezeStep(
  sessionKey: string | undefined,
  step: number | undefined,
  opts?: SessionLivenessScopeOpts,
): void {
  if (!sessionKey || !step || !Number.isFinite(step) || step <= 0) return;
  const rec = touch(sessionKey);
  const scope = resolveScopeKey(opts);
  let changed = false;
  if (scope) {
    const scoped = getOrCreateScopeRecord(rec, scope);
    if (step > scoped.freezeStep) {
      scoped.freezeStep = step;
      changed = true;
    }
    if ((rec.primaryScope === scope || (!rec.primaryScope && !isAuxiliaryScope(scope))) && step > rec.freezeStep) {
      rec.freezeStep = step;
      changed = true;
    }
  } else if (step > rec.freezeStep) {
    rec.freezeStep = step;
    changed = true;
  }
  if (changed) scheduleSave();
}

/**
 * Mark this session's upstream cache as gone: the last request was rejected, so
 * nothing was cached and the next one may re-cut the grid for density. Call on
 * the failure paths that leave no cache entry (oversized request → opaque 500).
 */
export function markCacheDead(sessionKey: string | undefined, opts?: SessionLivenessScopeOpts): void {
  if (!sessionKey) return;
  const rec = touch(sessionKey);
  const scope = resolveScopeKey(opts);
  if (scope) {
    const scoped = getOrCreateScopeRecord(rec, scope);
    scoped.cacheDead = true;
    if (rec.primaryScope === scope || (!rec.primaryScope && !isAuxiliaryScope(scope))) {
      rec.cacheDead = true;
    }
  } else {
    rec.cacheDead = true;
    if (rec.primaryScope && rec.livenessScopes?.[rec.primaryScope]) {
      rec.livenessScopes[rec.primaryScope]!.cacheDead = true;
    }
  }
  scheduleSave();
}

/**
 * Did this response leave the upstream prefix cache unpopulated?
 *
 * A cache entry is written by a request the provider actually *accepted*. Three
 * outcomes mean it never got that far, so the frozen grid we were protecting
 * protects nothing and the next turn may re-cut for density:
 *
 *  - `413` — the payload was rejected outright;
 *  - `400` whose body says the prompt is too long (Anthropic's wording varies:
 *    `prompt is too long`, `prompt_too_long`, `request_too_large`).
 *
 * NOT any 5xx, which is what this used to say. Production disagreed: of 20871
 * requests on one host the 5xx population was 177 × `529 overloaded`, 2 × `500`
 * and 1 × `503` — and 129 of 250 repacks fired directly after one of them. A 529
 * means the provider declined to process the request; the prefix cache it never
 * touched is still there, and re-cutting the grid threw it away for nothing.
 *
 * Nor any other 4xx. A bad key or a rate limit says nothing about the cache.
 *
 * A cache that genuinely died needs no error to be noticed: {@link
 * noteCacheOutcome} sees the next response report neither a read nor a write, and
 * that is both accurate and free.
 */
export function responseLeftNoCache(status: number, errorBody?: string): boolean {
  if (status === 413) return true;
  if (status === 400 && errorBody) {
    return /prompt[\s_-]*(is\s*)?too[\s_-]*long|request[\s_-]*too[\s_-]*large|too many (images|tokens)/i
      .test(errorBody);
  }
  return false;
}

import { resetGlobalPrefixTape } from './prefix-tape.js';

/** Test seam: drop all session state and any pending save. The store stays attached. */
export function resetSessionState(): void {
  sessions.clear();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  dirty = false;
  resetGlobalPrefixTape();
}

/** Test/inspection seam: inspect a session without mutating its clock. */
export function peekSessionState(
  sessionKey: string,
): {
  lastSeenMs: number;
  freezeStep: number;
  cacheDead: boolean;
  repackInFlightCount?: number;
  justRepacked: boolean;
  lastCacheAlive?: boolean;
  everCacheAlive?: boolean;
  opticalHistoryPolicy?: OpticalHistoryPolicy;
  sealedEpochKeys?: string[];
  sealedStage2SlotKeys?: string[];
  pinnedSkills?: string[];
  pinnedSkillCatalogHash?: string;
} | undefined {
  const rec = sessions.get(sessionKey);
  if (!rec) return undefined;
  return {
    ...rec,
    justRepacked: (rec.repackInFlightCount ?? 0) > 0,
    ...(rec.sealedEpochKeys ? { sealedEpochKeys: [...rec.sealedEpochKeys] } : {}),
    ...(rec.sealedStage2SlotKeys ? { sealedStage2SlotKeys: [...rec.sealedStage2SlotKeys] } : {}),
    ...(rec.pinnedSkills ? { pinnedSkills: [...rec.pinnedSkills] } : {}),
  };
}

/** Complete client boilerplate elements, with no user prose between them. */
const BOILERPLATE_ELEMENT_RE =
  /<(system-notice|system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

export function isBoilerplateText(text: string): boolean {
  return text.replace(BOILERPLATE_ELEMENT_RE, '').trim() === '';
}

/**
 * Pick the text that identifies a conversation, from the text blocks of its
 * opening user turn(s) in order (everything before the first assistant message).
 *
 * Blocks that are wholly a harness envelope are skipped: they are boilerplate
 * the client injects into every session (omp opens each one with the same
 * `<system-notice>` device inventory; Claude Code with the project's CLAUDE.md
 * `<system-reminder>` and local slash-command output), so keying on them merges
 * every concurrent session into one record, and each session's cache outcomes
 * then re-cut the others' history grids. The first non-envelope block is the
 * user's own prompt. When every block is an envelope, the first one is still
 * better than no key. Capped at 4 KiB.
 */
export function sessionAnchorText(texts: readonly string[]): string {
  const anchor = texts.find((t) => !isBoilerplateText(t)) ?? texts[0] ?? '';
  return anchor.slice(0, 4096);
}

/** Inspection seam: how many sessions are currently tracked. */
export function sessionStateSize(): number {
  return sessions.size;
}
