/**
 * One place every price ratio comes from.
 *
 * inkling compares token counts weighted by price ratios (cached input,
 * cache write and output, each divided by the uncached input price). The
 * compression gate and the savings math must use the same ratios for the same
 * model, so both ask here.
 *
 * Two sources, chosen by `INKLING_PRICES`:
 *  - `legacy` (default): the values inkling has always used. Profile fields
 *    for the savings math; Anthropic's 5-minute-tier ratios (1.25x write,
 *    0.1x read) for the gate, whatever the model. These are NOT the official
 *    per-model prices (Opus 5.5 reads at 0.05x).
 *  - `kosha`: the build-time table in prices.generated.ts (first-party rows
 *    of a kosha snapshot; `pnpm prices:gen`). An explicit pricing field in
 *    INKLING_GPT_PROFILES still wins. A model with no sane row is UNPRICED:
 *    the gate passes it through untouched, the savings math falls back to the
 *    profile and reports the source as unpriced.
 *
 * Kosha mode also reads the snapshot's TTL write tiers, long-context bands and
 * dated changes through a {@link PriceContext}: the cache TTL the request
 * writes, its prompt size (cached tokens included) and the time. Bands keep
 * the ratios nearly flat (OpenAI, xAI and Haiku 5.5 double input, read and
 * write together); they matter for absolute dollars. The TTL tier matters for
 * the gate: an Anthropic 1h write costs 2x input, not 1.25x.
 *
 * Workers-safe: no node:, no fs. Reads process.env only behind a typeof guard,
 * like gpt-model-profiles.ts.
 */

import { CACHE_CREATE_RATE, CACHE_READ_RATE } from './baseline.js';
import { readBrandEnv } from './env.js';
import { envPricingOverride, resolveGptProfile } from './gpt-model-profiles.js';
import { normalizeModelId } from './price-id.js';
import { PRICES, PRICE_ALIASES, PRICE_SNAPSHOT, type PriceRow } from './prices.generated.js';

/** What the request looks like, for picking a TTL tier, a band and a dated
 *  change. Every field is optional; an empty context prices the base row. */
export interface PriceContext {
  /** Cache TTL the request writes, in seconds (Anthropic `ttl: "1h"` = 3600). */
  ttlSec?: number;
  /** Prompt tokens, cached included: what a provider compares to a band line. */
  promptTokens?: number;
  /** Epoch ms the request is billed at. Default now. */
  at?: number;
}

/** Price ratios relative to the model's uncached input price. */
export interface PriceRates {
  /** Cached-input (cache read) price ÷ input price. */
  read: number;
  /** Shortest-TTL cache write price ÷ input price. 1 when the provider charges
   *  no write premium (the write bills as ordinary input). */
  write: number;
  /** Output price ÷ input price. */
  output: number;
}

export type PriceSource = 'legacy' | 'env' | 'kosha' | 'unpriced';

export { PRICE_SNAPSHOT };

/** The ratios the Anthropic gate has always priced with: 5-minute write tier,
 *  0.1x read, for every Claude model. */
export const ANTHROPIC_GATE_RATES: Readonly<PriceRates> = Object.freeze({
  read: CACHE_READ_RATE,
  write: CACHE_CREATE_RATE,
  output: 5,
});

/** Which source is active. Anything other than `kosha` is legacy. */
export function priceMode(): 'legacy' | 'kosha' {
  const raw = readBrandEnv('PRICES') || '';
  return raw.trim().toLowerCase() === 'kosha' ? 'kosha' : 'legacy';
}

const PRICE_ROW_CACHE = new Map<string, PriceRow | null>();

/** The snapshot row for a model: exact normalised id, then a kosha alias, then
 *  the longest snapshot id that prefixes it at a `-` boundary (a `-codex` or
 *  `-latest` variant prices as its base). */
export function priceRowFor(model: string | null | undefined): PriceRow | undefined {
  const id = normalizeModelId(model);
  if (!id) return undefined;
  const cached = PRICE_ROW_CACHE.get(id);
  if (cached !== undefined) return cached ?? undefined;
  const exact = PRICES[id] ?? (PRICE_ALIASES[id] ? PRICES[PRICE_ALIASES[id]!] : undefined);
  let resolved: PriceRow | undefined = exact;
  if (!resolved) {
    let best: string | undefined;
    for (const key of Object.keys(PRICES)) {
      if (id.startsWith(key + '-') && (best === undefined || key.length > best.length)) best = key;
    }
    resolved = best ? PRICES[best] : undefined;
  }
  if (PRICE_ROW_CACHE.size < 512) {
    PRICE_ROW_CACHE.set(id, resolved ?? null);
  }
  return resolved;
}

/** The row as billed under `ctx`: due dated changes applied, then the band the
 *  prompt falls in (above `at`, or from `at` when `incl`) replacing the base
 *  rates. A band without its own read or write tiers scales the base ones by
 *  its input ratio. */
export function effectiveRow(row: PriceRow | undefined, ctx: PriceContext = {}): PriceRow | undefined {
  if (!row) return undefined;
  let r: PriceRow = { ...row };
  const at = ctx.at ?? Date.now();
  for (const c of row.chg ?? []) {
    if (c.at > at) continue;
    const { at: _at, ...rates } = c;
    r = { ...r, ...rates };
    // A dated write price supersedes the tier list it was cut from.
    if (rates.cw !== undefined || rates.cw1h !== undefined) delete r.cwt;
  }
  const n = ctx.promptTokens;
  if (typeof n === 'number' && Number.isFinite(n)) {
    let band: NonNullable<PriceRow['bands']>[number] | undefined;
    for (const b of r.bands ?? []) if (n > b.at || (b.incl === true && n >= b.at)) band = b;
    if (band && r.in > 0) {
      const k = band.in / r.in;
      const bandCw1h = band.cwt?.find(([ttl]) => ttl === 3600)?.[1];
      r = {
        ...r,
        in: band.in,
        out: band.out ?? (r.out !== undefined ? r.out * k : undefined),
        cr: band.cr ?? (r.cr !== undefined ? r.cr * k : undefined),
        cw: band.cwt?.[0]?.[1] ?? (r.cw !== undefined ? r.cw * k : undefined),
        cw1h: bandCw1h ?? (r.cw1h !== undefined ? r.cw1h * k : undefined),
        cwt: band.cwt ?? r.cwt?.map(([ttl, per]) => [ttl, per * k] as [number, number]),
      };
    }
  }
  return r;
}

/** Write price for a TTL: explicit 3600s tier in `cwt` (e.g. band override) or `cw1h` first when ttlSec === 3600, else the shortest tier that lasts at least `ttlSec`, else `cw`. */
function writePriceFor(row: PriceRow, ttlSec: number | undefined): number | undefined {
  if (ttlSec === 3600) {
    const tier3600 = row.cwt?.find(([ttl]) => ttl === 3600)?.[1];
    if (typeof tier3600 === 'number') return tier3600;
    if (typeof row.cw1h === 'number') return row.cw1h;
  }
  const tiers = row.cwt;
  if (!ttlSec || !tiers || tiers.length === 0) return row.cw;
  const sorted = [...tiers].sort((a, b) => a[0] - b[0]);
  return (sorted.find(([ttl]) => ttl >= ttlSec) ?? sorted[sorted.length - 1]!)[1];
}

/** Ratios from a snapshot row, or undefined when the row can't be trusted for
 *  ratios: no positive input or output, no cache read, a read at or above
 *  input, or a write outside [input, 3x input]. A write of 0 or none means no
 *  write premium (DeepSeek, z.ai, xAI bill the write as ordinary input). */
export function ratesFromRow(row: PriceRow | undefined, ttlSec?: number): PriceRates | undefined {
  if (!row || !(row.in > 0) || !(typeof row.out === 'number' && row.out > 0)) return undefined;
  if (typeof row.cr !== 'number') return undefined;
  const read = row.cr / row.in;
  if (!(read > 0 && read < 1)) return undefined;
  // `as-input`: the write bills as plain input (DeepSeek, xAI, z.ai, Google).
  const cw = writePriceFor(row, ttlSec);
  const write = row.cwb === 'as-input' ? 1
    : typeof cw === 'number' && cw > 0 ? cw / row.in : 1;
  if (!(write >= 1 && write <= 3)) return undefined;
  return { read, write, output: row.out / row.in };
}

function profileRates(model: string | undefined): PriceRates {
  const profile = resolveGptProfile(model);
  return {
    read: profile.cacheReadRate,
    write: profile.cacheWriteRate ?? 1,
    output: profile.outputRate,
  };
}

let cachedEnvProfilesRaw = '';
const cachedEnvPricingMap = new Map<string, ReturnType<typeof envPricingOverride>>();

function memoizedEnvPricingOverride(model: string | null | undefined) {
  const raw = readBrandEnv('GPT_PROFILES') || '';
  if (!raw) return undefined;
  if (raw !== cachedEnvProfilesRaw) {
    cachedEnvProfilesRaw = raw;
    cachedEnvPricingMap.clear();
  }
  const key = model ?? '';
  if (cachedEnvPricingMap.has(key)) return cachedEnvPricingMap.get(key);
  const resolved = envPricingOverride(model);
  if (cachedEnvPricingMap.size >= 256) cachedEnvPricingMap.clear();
  cachedEnvPricingMap.set(key, resolved);
  return resolved;
}

/** Kosha-mode ratios with their source; env fields override field by field. */
function koshaRates(model: string | undefined, ctx: PriceContext = {}): { rates: PriceRates; source: PriceSource } | undefined {
  const env = memoizedEnvPricingOverride(model);
  const fromRow = ratesFromRow(effectiveRow(priceRowFor(model), ctx), ctx.ttlSec);
  if (!env) return fromRow ? { rates: fromRow, source: 'kosha' } : undefined;
  const base = fromRow ?? profileRates(model);
  return {
    rates: {
      read: env.cacheReadRate ?? base.read,
      write: env.cacheWriteRate ?? base.write,
      output: env.outputRate ?? base.output,
    },
    source: 'env',
  };
}

/** Where this model's savings ratios come from under the active mode. */
export function priceSourceFor(model: string | undefined): PriceSource {
  if (priceMode() === 'legacy') return 'legacy';
  return koshaRates(model)?.source ?? 'unpriced';
}

/** Ratios for a model as the savings math prices it. In kosha mode an
 *  unpriced model falls back to its profile; check {@link priceSourceFor}
 *  before presenting that number as a measured saving. */
export function resolvePriceRates(model: string | undefined, ctx?: PriceContext): PriceRates {
  if (priceMode() === 'kosha') {
    const k = koshaRates(model, ctx);
    if (k) return k.rates;
  }
  return profileRates(model);
}

/** Ratios the image/text gate in transform.ts prices with, or null when the
 *  model is unpriced in kosha mode (the gate then passes the text through).
 *  Legacy mode keeps the historical Anthropic ratios for every model. */
export function gateRatesFor(model: string | undefined, ctx?: PriceContext): Readonly<PriceRates> | null {
  if (priceMode() === 'legacy') return ANTHROPIC_GATE_RATES;
  return koshaRates(model, ctx)?.rates ?? null;
}

/** Cache-read ratio for the Anthropic savings math (baseline.ts). Legacy and
 *  unpriced models keep the historical 0.1x. Writes stay at Anthropic's
 *  published 1.25x (5m) / 2x (1h), which hold for every Claude model. */
export function anthropicReadRate(model: string | undefined, ctx?: PriceContext): number {
  if (priceMode() === 'legacy') return CACHE_READ_RATE;
  return gateRatesFor(model, ctx)?.read ?? CACHE_READ_RATE;
}

/** USD per 1M uncached input tokens for converting saved token-equivalents to
 *  dollars, at the band and date in `ctx`, or undefined when legacy mode or
 *  the model is unpriced. */
export function inputUsdPerMtok(model: string | undefined, ctx?: PriceContext): number | undefined {
  if (priceMode() === 'legacy' || !koshaRates(model, ctx)) return undefined;
  const row = effectiveRow(priceRowFor(model), ctx);
  return row && row.in > 0 ? row.in : undefined;
}

export interface CliffSavingsEval {
  readonly crossesCliff: boolean;
  readonly cliffAt: number;
  readonly multiplier: number;
  readonly inputUsdBefore: number;
  readonly inputUsdAfter: number;
  /** Immediate single-turn USD saved assuming the unproxied path stayed warm on the higher tier. */
  readonly netSingleTurnUsd: number;
  /** Input+output band-step savings across the remaining prompt alone. */
  readonly cliffSavedUsd: number;
}

function bandWriteUsdPerMtok(row: PriceRow, ttlSec?: number): number {
  if (row.cwb === 'as-input') return row.in;
  const cw = writePriceFor(row, ttlSec);
  return typeof cw === 'number' && cw > 0 ? cw : row.in;
}

/**
 * Evaluate whether shrinking a prompt from `promptTokensBefore` to
 * `promptTokensAfter` drops the entire request below a long-context pricing
 * cliff (e.g. OpenAI 272K, Gemini/Grok 200K, Haiku 5.5 100K, MiniMax M3 512K),
 * turning an amortized multi-turn trade-off into an immediate turn-1 win.
 *
 * Returns null in legacy mode, on unpriced models, or if no cliff is crossed.
 */
export function evaluateCliffAvoidance(
  model: string | null | undefined,
  args: {
    promptTokensBefore: number;
    promptTokensAfter: number;
    collapsedBaselineTokens?: number;
    collapsedActualTokens?: number;
    downstreamCachedTokens?: number;
    expectedOutputTokens?: number;
    ttlSec?: number;
    at?: number;
  },
): CliffSavingsEval | null {
  if (priceMode() === 'legacy') return null;
  const baseRow = priceRowFor(model);
  if (!baseRow) return null;
  const { promptTokensBefore: beforeTok, promptTokensAfter: afterTok } = args;
  if (!(beforeTok > afterTok) || afterTok < 0) return null;
  const rowBefore = effectiveRow(baseRow, { promptTokens: beforeTok, at: args.at });
  const rowAfter = effectiveRow(baseRow, { promptTokens: afterTok, at: args.at });
  if (!rowBefore || !rowAfter || !(rowAfter.in > 0) || !(rowBefore.in > rowAfter.in)) return null;
  if (typeof rowBefore.cr !== 'number' || typeof rowAfter.cr !== 'number') return null;

  const baseDated = effectiveRow(baseRow, { at: args.at });
  let cliffAt = 0;
  for (const b of baseDated?.bands ?? []) {
    const inBefore = beforeTok > b.at || (b.incl === true && beforeTok >= b.at);
    const inAfter = afterTok > b.at || (b.incl === true && afterTok >= b.at);
    if (inBefore && !inAfter && b.at > cliffAt) cliffAt = b.at;
  }

  const collapsedBase = Math.max(0, args.collapsedBaselineTokens ?? (beforeTok - afterTok));
  const collapsedActual = Math.max(0, args.collapsedActualTokens ?? Math.max(0, afterTok - (beforeTok - collapsedBase)));
  const downstreamCached = Math.max(0, Math.min(args.downstreamCachedTokens ?? 0, Math.max(0, beforeTok - collapsedBase)));
  const keptPrefix = Math.max(0, beforeTok - collapsedBase - downstreamCached);
  const outTok = Math.max(0, args.expectedOutputTokens ?? 0);

  // Conservative comparison: unproxied path reads 100% of prompt at the upper
  // tier's cache-read rate, while compressed path pays write rate on the
  // newly imaged/emitted section plus any invalidated downstream suffix, and
  // lower-tier cache-read on kept prefix tokens.
  const unproxiedUsd =
    (beforeTok * rowBefore.cr + outTok * (rowBefore.out ?? 0)) / 1e6;
  const writeUsd = bandWriteUsdPerMtok(rowAfter, args.ttlSec);
  const compressedUsd =
    (keptPrefix * rowAfter.cr + (collapsedActual + downstreamCached) * writeUsd + outTok * (rowAfter.out ?? 0)) / 1e6;
  const netSingleTurnUsd = unproxiedUsd - compressedUsd;
  const cliffSavedUsd =
    (keptPrefix * (rowBefore.cr - rowAfter.cr) + outTok * Math.max(0, (rowBefore.out ?? 0) - (rowAfter.out ?? 0))) / 1e6;

  return {
    crossesCliff: true,
    cliffAt,
    multiplier: rowBefore.in / rowAfter.in,
    inputUsdBefore: rowBefore.in,
    inputUsdAfter: rowAfter.in,
    netSingleTurnUsd,
    cliffSavedUsd,
  };
}

/**
 * Exact kosha USD bill for one request's token buckets at its billed prompt band,
 * or undefined in legacy mode or when the model lacks input/output/read rates.
 */
export function estimateBillUsd(
  model: string | null | undefined,
  args: {
    uncachedTokens: number;
    cachedTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    ttlSec?: number;
    promptTokens?: number;
    at?: number;
  },
): number | undefined {
  if (priceMode() === 'legacy') return undefined;
  const base = priceRowFor(model);
  if (!base || memoizedEnvPricingOverride(model ?? undefined)) return undefined;
  const totalPrompt =
    args.promptTokens ??
    Math.max(0, (args.uncachedTokens || 0) + (args.cachedTokens || 0) + (args.cacheWriteTokens || 0));
  const row = effectiveRow(base, { promptTokens: totalPrompt, at: args.at });
  if (!row || !(row.in > 0)) return undefined;
  const uncached = Math.max(0, args.uncachedTokens || 0);
  const cached = Math.max(0, args.cachedTokens || 0);
  const write = Math.max(0, args.cacheWriteTokens || 0);
  const output = Math.max(0, args.outputTokens || 0);
  const crRate = typeof row.cr === 'number' ? row.cr : row.in;
  const cwRate = bandWriteUsdPerMtok(row, args.ttlSec);
  const outRate = typeof row.out === 'number' ? row.out : 0;
  return (uncached * row.in + cached * crRate + write * cwRate + output * outRate) / 1e6;
}
