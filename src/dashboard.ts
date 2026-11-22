/**
 * Live dashboard for the Node host. Serves the main HTML page and JSON
 * polling endpoints. All "/api/*.json" endpoints recompute from disk on
 * every request — inkling doesn't have a query layer, but a 1.5 MB JSONL
 * streams in well under 100 ms.
 *
 * Legacy live-poll endpoints (left in place, the existing tick() loop uses
 * them):
 *
 *   GET  /, /dashboard               → main HTML page
 *   GET  /proxy-stats                → JSON aggregate over the in-mem ring
 *   GET  /proxy-recent               → JSON ring buffer of recent requests
 *   GET  /proxy-latest-png[?crop=N]  → raw PNG of the latest rendered image
 *
 * Session endpoints (read-only telemetry — no destructive operations):
 *
 *   GET  /api/sessions.json          → grouped sessions (sha8 + project + counts)
 *   GET  /api/stats.json             → full-history aggregate (formerly `inkling stats`)
 *
 * Metric formulas and HTML shell originally ported from the Python reference
 * implementation (deleted after live cache-rate validation hit 98.7% by tokens).
 *
 * Node-only by design. Workers host has no dashboard; use Workers Logs.
 *
 * Memory bound: ring buffer cap 50 events + a parallel ring of the last 50
 * rendered PNGs (images are never persisted to disk, so this ring is the
 * only place to view them). At a typical 75 KB PNG that's ~3-4 MB resident;
 * a process restart starts the image ring empty.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as readline from 'node:readline';
import type { ProxyEvent } from './core/proxy.js';
import type { TrackEvent } from './core/tracker.js';
import { anthropicReadRate, estimateBillUsd, inputUsdPerMtok, priceMode, PRICE_SNAPSHOT, resolvePriceRates } from './core/pricing.js';
import { readTurnReport } from './turn-report.js';
import {
  computeActualInputEffWithCacheTier,
  computeBaselineInputEffWithCacheTier,
  deriveBaselineWarmth,
  observedCacheTtlSec,
  type BaselineWarmthPrev,
} from './core/baseline.js';
import {
  computeOpenAIActualInputEff,
  computeOpenAIBaselineRawTokens,
  computeOpenAISessionBaselineInputEff,
  deriveOpenAIBaselineWarmth,
  OPENAI_CACHE_TTL_SEC,
  openAIOutputRate,
  type OpenAIWarmthPrev,
} from './core/openai-savings.js';
import { renderCacheMaxBytes, renderCacheStats } from './core/render.js';
import {
  aggregateSessions,
  claudeCodeMap,
  filterSessions,
  type ClaudeCodeSessionRef,
  type ListOptions,
  type SessionsPaths,
} from './sessions.js';
import { aggregateEventsFile, summaryToJson } from './stats.js';
// Server-rendered UI (htmx + Alpine, vendored). No client bundle - the
// fragments module renders finished HTML from the same payloads the JSON
// endpoints serve.
import {
  FICHE_ICON_SVG,
  renderPage,
  renderToggleFragment,
  renderModelsFragment,
  renderPluginsFragment,
  renderContextMapFragment,
  renderSessionSummaryFragment,
  renderHeaderFragment,
  renderAnalyticsFragment,
  renderRecentFragment,
  renderLatestFragment,
  renderSessionsFragment,
  renderStatsTableFragment,
  type ContextMapData,
} from './dashboard/fragments.js';
export { FICHE_ICON_SVG };
import { readBrandEnv } from './core/env.js';
import {
  getAllowedModelBases,
  getConfiguredModelBases,
  isFicheSupportedModel,
  setAllowedModelBases,
} from './core/applicability.js';
import {
  isThirdPartyPlugin,
  mergeStagePlugins,
  type PluginOverrides,
  type StagePluginDescriptor,
} from './core/stage-plugins.js';
import type {
  DailySavingsPoint,
  ModelStatsPayload,
  StatsPayload,
  RecentPayload,
  SessionsPayload,
  FullStatsPayload,
  CurrentSessionPayload,
} from './dashboard/types.js';

const RECENT_CAP = 50;
const DAILY_CHART_DAYS = 14;
const MAX_DAILY_BUCKETS = 90;

function localDateKey(ms: number): string {
  const d = new Date(ms);
  const year = String(d.getFullYear()).padStart(4, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface DailyBucket {
  requests: number;
  compressed: number;
  imaged: number;
  textCompressed: number;
  textHygieneSavedTokens: number;
  baselineInputWeighted: number;
  actualInputWeighted: number;
  rawSavedTokens: number;
  pricedBaselineInputWeighted: number;
  pricedActualInputWeighted: number;
  pricedSavedUsd: number;
  cliffSavedUsd: number;
}

function emptyDailyBucket(): DailyBucket {
  return {
    requests: 0,
    compressed: 0,
    imaged: 0,
    textCompressed: 0,
    textHygieneSavedTokens: 0,
    baselineInputWeighted: 0,
    actualInputWeighted: 0,
    rawSavedTokens: 0,
    pricedBaselineInputWeighted: 0,
    pricedActualInputWeighted: 0,
    pricedSavedUsd: 0,
    cliffSavedUsd: 0,
  };
}

/** How many rendered PNGs to keep in the in-memory image ring. Matches
 *  RECENT_CAP so every visible recent-requests row can still resolve its
 *  image. Images are never written to disk — this ring is the only store. */
const IMAGE_RING_CAP = 50;

/** One rendered image held in the in-memory ring. `id` is a monotonic
 *  counter (never reused) so a RecentRow can reference its image even after
 *  older entries are evicted; the dashboard pulls it via
 *  /proxy-latest-png?id=${id}. */
interface ImageEntry {
  id: number;
  png: Uint8Array;
  /** Human-readable "WxH · NN KB · N images total" line for the caption. */
  meta: string;
  width: number;
  height: number;
  ts: number;
  /** The source text this PNG was rendered from (shared across all pages of
   *  one render; capped upstream at 64 KiB). Lets the dashboard show the
   *  text → image pair so the operator can see what got converted. */
  sourceText?: string;
}

/** One row in the dashboard's "recent requests" table. Compact on purpose —
 *  this lives in memory and gets serialized on every poll.
 *
 *  The "input" numbers (`actual_input`, `baseline_input`) are input-side
 *  only — input + cache_create×1.25 + cache_read×0.10 — because that's
 *  the slice the proxy can move. `output_tokens` is reported separately so
 *  the operator can see what fraction of the bill is unaffected by
 *  compression (and decide whether the headline % makes sense for their
 *  workload). */
export interface RecentRow {
  ts: number;
  method: string;
  path: string;
  model?: string;
  status: number;
  size_in?: number;
  compressed: boolean;
  cc_added?: number;
  image_count?: number;
  compression_mode?: 'optical' | 'text' | 'none';
  text_hygiene_stages?: string[];
  input_tokens?: number;
  /** From /v1/messages `usage.output_tokens`. Identical with/without
   *  compression — shown so the operator can see why an output-heavy
   *  turn moves the headline less than a cache-create-heavy one. */
  output_tokens?: number;
  cache_create?: number;
  cache_read?: number;
  /** input + cache_create×1.25 + cache_read×0.10, from the upstream usage
   *  block. Missing when the request 4xx'd or wasn't /v1/messages. */
  actual_input?: number;
  /** /v1/messages/count_tokens(originalBody).input_tokens. Missing when the
   *  side-probe failed or the request body wasn't an Anthropic Messages payload. */
  baseline_input?: number;
  /** How much the running "saved" total moved on this request. */
  session_saved_so_far_delta?: number;
  /** Id of the image rendered for this request, if any — resolves against
   *  the image ring via /proxy-latest-png?id=${img_id}. Absent when the
   *  request rendered no image, or once the image has been evicted from the
   *  ring (the id stays on the row but no longer fetches). */
  img_id?: number;
  img_ids?: number[];
}

/** Aggregate over the whole session. Reset on process restart unless
 *  replay() is called to seed from the JSONL file.
 *
 *  The savings numerator is input-only — output is identical with and
 *  without compression, so it cancels. The denominator is the FULL bill
 *  (input + output×5 in input-token-equivalents) so the headline percentage
 *  drops honestly toward zero on output-heavy workloads instead of hiding
 *  the fact that the proxy only moves part of the cost.
 *
 *    Per event (see src/core/baseline.ts for the derivation):
 *      cacheable = baseline_cacheable_tokens || 0     (tokens up to last cache_control)
 *      cold_tail = baseline_tokens − cacheable        (always-cold input on both paths)
 *      warm      = did THIS request read a warm cache? (cache_read > 0)
 *      The text counterfactual is WARMTH-AWARE and grounded in OBSERVED cache
 *      state: inkling images the cached prefix in place (moves the caller's
 *      cache_control marker onto the image), so image and text share cache fate.
 *      cache_read>0 ⇒ a warm cache existed for both paths; cache_read===0 ⇒ cold
 *      for both, so text re-creates its prefix too (no phantom warm read on a
 *      cold turn — that would fabricate a loss out of a real token win):
 *        warm:  baseline_input_eff = reused×0.10 + grown×observed_create_rate + cold_tail×1.0
 *               where reused = min(prevCacheable, cacheable), grown = cacheable − reused
 *        cold:  baseline_input_eff = cacheable×observed_create_rate + cold_tail×1.0
 *      actual_input_eff   = input + cache_create_5m×1.25 + cache_create_1h×2 + cache_read×0.10
 *      output_equiv       = output × 5                (input-token-equivalent at the 5× output rate)
 *      saved              = baseline_input_eff − actual_input_eff
 *      baseline_total     = baseline_input_eff + output_equiv
 *      actual_total       = actual_input_eff + output_equiv
 *
 *    Roll-up:
 *      saved_pct = Σ saved / Σ baseline_total × 100
 *
 *  This is what Anthropic's weekly-limit meter actually counts — input +
 *  output×5 in input-token-equivalents. The dashboard headline matches it
 *  so a "20% saved" number means weekly-limit consumption dropped by 20%,
 *  not "20% off the slice we touched while the other half stayed full." */
/**
 * Per-session aggregate. Same dollar-weighted savings math as the global
 * `Totals` block, but partitioned by `info.firstUserSha8` so the dashboard
 * can show "what's happening RIGHT NOW" instead of stale lifetime numbers.
 * Field names mirror the JSON wire shape served by `serveCurrentSessionJson`.
 */
interface SessionTotals {
  sessionId: string;
  // Dollar-weighted accumulators. baseline/actual are the SAME math as the
  // global `Totals.allBaselineEquivalentWeighted` / `allActualInputWeighted`,
  // but scoped to a single session. Output is excluded because the proxy
  // doesn't touch it.
  baselineInputWeighted: number;
  actualInputWeighted: number;
  // Honest denominator for the headline: count of requests that contributed
  // to `baselineInputWeighted` (events that carried a baseline measurement,
  // matching the global `Totals.baselineMeasuredCount`).
  baselineMeasuredCount: number;
  // ALL-rows session totals (measured + unmeasured + passthrough). These pair
  // up to form the full session bill in $ — used as the honest denominator
  // for saved-% so the ratio matches the global `saved_pct_of_all_spend`
  // math but scoped to a single session. Mirrors the global
  // `Totals.allActualInputWeighted` / `allOutputWeighted` accumulators.
  allActualInputWeighted: number;
  allOutputWeighted: number;
  // RAW token sums — NO rate weighting, NO baseline construction. The honest,
  // server-sourced compression: 1 − rawActualTokens/rawBaselineTokens.
  //   rawActualTokens   = Σ(input + cache_create + cache_read)  (real usage)
  //   rawBaselineTokens = Σ baseline_tokens                     (count_tokens of
  //                       the SAME body as text)
  // Two real numbers, one division — nothing in between to get wrong. This is
  // the headline; the weighted $ figures are diagnostics below it.
  rawActualTokens: number;
  rawBaselineTokens: number;
  // Raw output tokens (the model's reply). inkling does NOT compress output, so
  // the HONEST total reduction adds it to BOTH sides:
  //   1 − (rawActual + rawOutput) / (rawBaseline + rawOutput)
  // Headlining input-only would cherry-pick the part that compresses.
  rawOutputTokens: number;
}

interface Totals {
  requests: number;
  compressedRequests: number;
  imagedRequests: number;
  textCompressedRequests: number;
  rawSavedTokens: number;
  /** Sum of weighted actual input tokens we paid for, across all events that
   *  also carried a baseline_tokens measurement (input + cache_create×1.25 +
   *  cache_read×0.10). */
  actualInputWeighted: number;
  /** Sum of the cache-aware baseline (see formula above) across the same
   *  events that contributed to `actualInputWeighted`. The honest counter-
   *  factual cost of the unproxied path. */
  baselineInputWeighted: number;
  /** Sum of output_tokens × OUTPUT_TOKEN_RATE across the same events. Added
   *  to BOTH sides of the savings math denominator so the headline % counts
   *  output toward the total bill (it cancels in the numerator — proxy
   *  doesn't touch output). Without this the headline ignores half the
   *  bill on output-heavy sessions. */
  outputWeighted: number;
  /** Claude-priced subset of the measured totals. Google rows contribute to
   * token savings above, but not to dollar estimates based on Claude rates. */
  pricedActualInputWeighted: number;
  pricedBaselineInputWeighted: number;
  pricedOutputWeighted: number;
  /** Kosha mode: saved dollars at each row's own input price. */
  pricedSavedUsd: number;
  /** Rows converted to dollars at their own price / rows with no price. */
  usdPricedRequests: number;
  usdUnpricedRequests: number;
  /** Sum of weighted COUNTERFACTUAL input tokens across ALL requests
   *  with a usage block. For measured rows: cache-aware baseline (what the
   *  unproxied path would have billed). For unmeasured/probe-failed rows:
   *  actual_input_eff (best available estimate — these rows didn't run
   *  inkling or we can't measure what it would have cost, so the
   *  counterfactual ≈ actual).
   *
   *  This is the right denominator for "share of bill saved": dividing
   *  by what-you-would-have-paid is bounded at 100% (you can't save more
   *  than you would have spent). Dividing by what-you-DID-pay is not
   *  bounded — a single big cold-miss compressed request can make
   *  saved/actual exceed 100% because inkling shrunk the actual to
   *  near zero. */
  allBaselineEquivalentWeighted: number;
  /** Sum of weighted ACTUAL input tokens across the same all-rows set.
   *  Kept for the diagnostic sub-line and the back-compat saved_usd math. */
  allActualInputWeighted: number;
  /** Sum of output_tokens × OUTPUT_TOKEN_RATE across the same all-rows set.
   *  Output is identical with/without compression, so it appears in both
   *  numerator and denominator at the same value and cancels in the savings
   *  numerator. Included in the denominator so the headline drops honestly
   *  toward zero on output-heavy workloads. */
  allOutputWeighted: number;
  /** Count of requests that contributed to allActualInputWeighted (had a
   *  usage block). Lets the UI annotate "N of M paid requests". */
  allUsageRequests: number;
  /** Direct compressed-vs-passthrough actual-cost split. No counterfactuals,
   *  no probe gating — just sum what each path actually billed.
   *
   *  These accumulate over `haveUsage` rows only (same gate as the all-rows
   *  counters above) and partition that set by `info.compressed`. The point
   *  is to answer "did the compressed path actually cost less per request
   *  than the passthrough path, on real traffic" without inventing a
   *  counterfactual. Selection bias is real (the gate decides which path
   *  each turn lands on), so the UI surfaces sample counts so the operator
   *  can judge sufficiency — the dashboard does not auto-claim significance. */
  compressedPaidRequests: number;
  compressedActualInputWeighted: number;
  compressedOutputWeighted: number;
  passthroughPaidRequests: number;
  passthroughActualInputWeighted: number;
  passthroughOutputWeighted: number;
  /** Sum of ground-truth output character counts from the SSE/JSON scanner
   *  (see `OutputMeasurement` in proxy.ts). These three accumulators are
   *  independent of Anthropic's `usage.output_tokens` — they let the operator
   *  compare what we measured vs what Anthropic billed and surface the gap
   *  the redacted_thinking opaque blocks create. Counted in Unicode code
   *  units (UTF-16 string .length). */
  textCharsMeasured: number;
  thinkingCharsMeasured: number;
  toolUseCharsMeasured: number;
  /** Number of `redacted_thinking` content blocks we saw. We can't read
   *  their length (server-encrypted bytes) so we count blocks instead. */
  redactedBlockCountMeasured: number;
  /** How many events contributed measurement counters. Lets the UI annotate
   *  the panel ("N of M events measured") when the scanner fell back. */
  eventsWithMeasurement: number;
  /** Kosha mode: exact per-row USD across compressed vs passthrough paths. */
  compressedActualUsdKosha: number;
  passthroughActualUsdKosha: number;
  /** Prefix-safe text-hygiene token/char savings and cliff avoidance telemetry. */
  textHygieneSavedTokens: number;
  textHygieneSavedChars: number;
  cliffAvoidedEvents: number;
  cliffSavedUsd: number;
  startedAt: number;
}

function emptyTotals(startedAt = Date.now() / 1000): Totals {
  return {
    requests: 0,
    compressedRequests: 0,
    imagedRequests: 0,
    textCompressedRequests: 0,
    rawSavedTokens: 0,
    actualInputWeighted: 0,
    baselineInputWeighted: 0,
    outputWeighted: 0,
    pricedActualInputWeighted: 0,
    pricedBaselineInputWeighted: 0,
    pricedOutputWeighted: 0,
    pricedSavedUsd: 0,
    usdPricedRequests: 0,
    usdUnpricedRequests: 0,
    allBaselineEquivalentWeighted: 0,
    allActualInputWeighted: 0,
    allOutputWeighted: 0,
    allUsageRequests: 0,
    compressedPaidRequests: 0,
    compressedActualInputWeighted: 0,
    compressedOutputWeighted: 0,
    passthroughPaidRequests: 0,
    passthroughActualInputWeighted: 0,
    passthroughOutputWeighted: 0,
    textCharsMeasured: 0,
    thinkingCharsMeasured: 0,
    toolUseCharsMeasured: 0,
    redactedBlockCountMeasured: 0,
    eventsWithMeasurement: 0,
    compressedActualUsdKosha: 0,
    passthroughActualUsdKosha: 0,
    textHygieneSavedTokens: 0,
    textHygieneSavedChars: 0,
    cliffAvoidedEvents: 0,
    cliffSavedUsd: 0,
    startedAt,
  };
}

/*
 * ─────────────────────────────────────────────────────────────────────────
 *  PROVENANCE — every magic number below should trace to one of these:
 *
 *  [docs-pricing]   docs.anthropic.com/en/docs/about-claude/pricing
 *                   Verified 2026-05-19 via WebFetch. The page lists per-model
 *                   per-million-token rates and the cache-tier multipliers.
 *
 *  [count_tokens]   docs.anthropic.com/en/api/messages-count-tokens
 *                   The dashboard's baseline number comes from a free side
 *                   call to /v1/messages/count_tokens on the PRE-COMPRESSION
 *                   body. No estimation, no α, no regression.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Output-token rate multiplier (referenced to the input base rate).
 *  Source: [docs-pricing] — Opus 4.7 lists $5/Mtok input and $25/Mtok
 *  output (5×); Sonnet 4.7 lists $3/Mtok input and $15/Mtok output (5×).
 *  Same ratio holds on Haiku 4.5 ($1/$5). */
const OUTPUT_TOKEN_RATE = 5.0;

/** Per-million-token input rate ASSUMED for the headline dollar figure.
 *  Source: https://docs.claude.com/en/docs/about-claude/pricing — Opus 4.7
 *  input is $5/Mtok (same as Opus 4.5 / 4.6; the previous "$2.50" value
 *  here was a regression). Cache-write 5m = $6.25/Mtok (1.25×),
 *  cache-read = $0.50/Mtok (0.10×).
 *
 *  This is exposed on /proxy-stats as `pricing_assumptions.input_per_mtok`
 *  so the operator can see what we assumed and override if they're
 *  running against a non-default deployment (Bedrock/Vertex add a 10%
 *  premium; Sonnet would be $3/Mtok, etc.).
 *
 *  NOTE: Opus 4.7 uses a different tokenizer than 4.5/4.6 (per
 *  docs.claude.com/en/docs/about-claude/pricing), so even at the same
 *  $/Mtok rate, the same string maps to a different token count. The
 *  honest oracle for "tokens in this body" is `count_tokens` against the
 *  actual target model; do not trust hardcoded chars-per-token or
 *  tokens-per-image constants on 4.7 without verifying against the
 *  upstream probe. */
// 2026-06-09: gate is Fable-5-only and Fable 5 bills $10/MTok input,
// so the dashboard dollar figure uses that rate. Output tokens are
// excluded entirely (the proxy can't move them), so this still
// understates the real bill - treat it as "input-side $ saved".
export const ASSUMED_INPUT_USD_PER_MTOK = 10.0;

/** Route per-event accounting by upstream. OpenAI paths use the GPT cost
 *  model (vision-token imaging, automatic 0.1× prefix cache, no count_tokens
 *  probe, 8× output); everything else uses the Anthropic cache-aware baseline.
 *  Anthropic paths are `/v1/messages[/count_tokens]`; neither word appears. */
function isOpenAIEvent(
  path: string | undefined,
  accountingProvider?: 'anthropic' | 'openai' | 'google',
): boolean {
  if (accountingProvider) return accountingProvider === 'openai';
  if (!path) return false;
  return path.includes('responses') || path.includes('chat/completions');
}

function googleEff(args: {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  compressed: boolean;
  baselineTokens: number;
  baselineProbeStatus: string | undefined;
  imageTokens: number;
  baselineImagedTokens: number;
  nativeInjectedTokens: number;
  textHygieneSavedTokens?: number;
}): {
  haveUsage: boolean;
  haveBaseline: boolean;
  creditSaving: boolean;
  actualInputEff: number;
  baselineInputEff: number;
  outputEquiv: number;
  rawBaseline: number;
  warmForRow: boolean;
} {
  const { inputTokens: inp, outputTokens: out, compressed } = args;
  const haveUsage = inp > 0 || out > 0;
  const measuredBaseline = args.baselineProbeStatus === 'ok' && args.baselineTokens > 0
    ? args.baselineTokens
    : 0;
  const hygieneTok = Math.max(0, args.textHygieneSavedTokens ?? 0);
  const estimatedBaseline = compressed
    && ((args.imageTokens > 0 && args.baselineImagedTokens > 0) || hygieneTok > 0)
    ? Math.max(0, inp - args.imageTokens - args.nativeInjectedTokens + args.baselineImagedTokens + hygieneTok)
    : 0;
  const baseline = measuredBaseline || estimatedBaseline;
  const haveBaseline = baseline > 0;
  const creditSaving = haveBaseline && haveUsage && compressed;
  if (priceMode() === 'kosha') {
    const rates = resolvePriceRates(args.model, { promptTokens: inp });
    const cached = Math.min(inp, Math.max(0, args.cachedTokens ?? 0));
    const actualInputEff = haveUsage ? (inp - cached) + cached * rates.read : 0;
    const delta = baseline - inp;
    const baselineInputEff = creditSaving
      ? actualInputEff + delta * (cached > 0 ? rates.read : 1)
      : actualInputEff;
    const outputEquiv = haveUsage ? out * rates.output : 0;
    return {
      haveUsage,
      haveBaseline,
      creditSaving,
      actualInputEff,
      baselineInputEff,
      outputEquiv,
      rawBaseline: creditSaving ? baseline : inp,
      warmForRow: cached > 0,
    };
  }
  return {
    haveUsage,
    haveBaseline,
    creditSaving,
    actualInputEff: inp,
    baselineInputEff: creditSaving ? baseline : inp,
    outputEquiv: out,
    rawBaseline: creditSaving ? baseline : inp,
    warmForRow: false,
  };
}

function gptEff(args: {
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  imageTokens: number;
  baselineImagedTokens: number;
  nativeInjectedTokens: number;
  textHygieneSavedTokens?: number;
  warmth?: { warm: boolean; selfBusted: boolean; prevPrefixTokens: number };
  compressed: boolean;
}): {
  haveUsage: boolean;
  haveBaseline: boolean;
  creditSaving: boolean;
  actualInputEff: number;
  baselineInputEff: number;
  outputEquiv: number;
  rawActual: number;
  rawBaseline: number;
} {
  const { model, inputTokens: inp, outputTokens: out, cachedTokens: cached } = args;
  const { imageTokens, baselineImagedTokens, nativeInjectedTokens, compressed } = args;
  const hygieneTok = Math.max(0, args.textHygieneSavedTokens ?? 0);
  const haveUsage = inp > 0 || out > 0;
  // The transform measured what the imaged content would have cost as o200k
  // text (or deterministic text hygiene saved tokens); without it there is no
  // counterfactual to credit.
  const haveBaseline = baselineImagedTokens > 0 || hygieneTok > 0;
  const actualInputEff = haveUsage ? computeOpenAIActualInputEff(inp, cached, model, args.cacheWriteTokens) : 0;
  const creditSaving = haveBaseline && haveUsage && compressed;
  const baselineInputEff = creditSaving
    ? computeOpenAISessionBaselineInputEff({
        inputTokens: inp,
        cachedTokens: cached,
        imageTokens,
        baselineImagedTokens,
        nativeInjectedTokens,
        textHygieneSavedTokens: hygieneTok,
        cacheWriteTokens: args.cacheWriteTokens,
        model,
        warmth: args.warmth,
      })
    : actualInputEff;
  const outputEquiv = haveUsage ? out * openAIOutputRate(model) : 0;
  // Raw, rate-free token counts for the session's compression ratio and the
  // Details panel: actual = what we sent; baseline = the text-only equivalent.
  const rawActual = inp;
  const rawBaseline = computeOpenAIBaselineRawTokens(
    inp, imageTokens, baselineImagedTokens, nativeInjectedTokens, hygieneTok,
  );
  return {
    haveUsage,
    haveBaseline,
    creditSaving,
    actualInputEff,
    baselineInputEff,
    outputEquiv,
    rawActual,
    rawBaseline,
  };
}

declare const __FICHE_VERSION__: string | undefined;

function defaultDashboardVersion(): string {
  return typeof __FICHE_VERSION__ !== 'undefined' ? __FICHE_VERSION__ : '0.18.0';
}

export interface DashboardHooks {
  readonly version?: string;
  readonly host?: string;
  readonly listPlugins?: () => StagePluginDescriptor[];
  readonly setPluginEnabled?: (
    id: string,
    enabled: boolean,
  ) => { plugin: StagePluginDescriptor; plugins: StagePluginDescriptor[] } | null;
  readonly setThirdPartyPluginsEnabled?: (
    enabled: boolean,
  ) => { updatedCount: number; enabled: boolean; plugins: StagePluginDescriptor[] };
  readonly onShutdown?: () => void;
}

export class DashboardState {
  private recent: RecentRow[] = [];
  /** Per-session dollar-weighted totals, keyed by `info.firstUserSha8`. The
   *  dashboard surfaces ONLY the most-recently-active session via the
   *  `serveCurrentSessionJson` endpoint — older sessions linger in the Map
   *  so a tab refresh during a brief lull still finds the previous session,
   *  but get evicted at `SESSION_CAP` to bound memory in long-running hosts. */
  private sessions: Map<string, SessionTotals> = new Map();
  /** sha8 of the most-recently-active session id. null when no events have
   *  ever carried a `firstUserSha8` (e.g. a cold start with only passthrough
   *  hits that the upstream probe never tagged). */
  private currentSessionId: string | null = null;
  /** Per-session prior row for the cache-aware TEXT baseline. A fresh
   *  same-prefix prior makes the text path warm (see deriveBaselineWarmth) and
   *  sizes its reused vs grown prefix tokens. Reconstructed identically in
   *  replay() from persisted timestamps, so live and restored numbers agree.
   *  Capped with sessions. */
  private baselineWarmth: Map<string, BaselineWarmthPrev> = new Map();
  private openaiWarmth: Map<string, OpenAIWarmthPrev> = new Map();
  /** Default max age of a prior row that can still make the text path warm.
   *  A prior that wrote 1h-tier tokens carries its own 3600 s window instead. */
  private static readonly CACHE_TTL_SEC = 300;
  /** Hard cap on `sessions` Map entries. Keeps memory bounded in
   *  long-running deployments. 50 sessions × ~13 numeric fields each is
   *  comfortably under a MB even with fat bucket/passthrough histograms. */
  private static readonly SESSION_CAP = 50;
  private readonly startedAt = Date.now() / 1000;
  /** Lifetime accounting partitioned by exact model id. The dashboard sums
   * only currently enabled model families, so toggling a model updates the
   * overall numbers without discarding its history. */
  private readonly totalsByModel = new Map<string, Totals>();
  /** Daily accounting partitioned by local YYYY-MM-DD and exact model id.
   *  Capped to MAX_DAILY_BUCKETS days in memory. */
  private readonly dailyByDateModel = new Map<string, Map<string, DailyBucket>>();
  /** Bounded ring of the most recently rendered images (last IMAGE_RING_CAP).
   *  Each request that rendered an image pushes one entry; the matching
   *  RecentRow carries `img_id` so the dashboard can pull any image still in
   *  the ring via /proxy-latest-png?id=N. In-memory only — images are never
   *  persisted, so a restart starts this empty. */
  private images: ImageEntry[] = [];
  /** Monotonic image id source. Never reset, never reused — an evicted id
   *  stays dangling on its RecentRow rather than pointing at a new image. */
  private nextImageId = 1;
  /** Runtime kill switch for compression. When false, the proxy forwards
   *  /v1/messages unchanged to upstream — pure passthrough, no images,
   *  no transforms. Controlled by the dashboard "passthrough" toggle so
   *  the operator can toggle the proxy's transform instantly.
   *
   *  Defaults to TRUE since 2026-06-09: scope is Fable 5 only, which reads
   *  renders at 100/100 (no Opus read tax) with the same image billing, and
   *  the live proxy record measured ~68% real input-token savings on dense
   *  traffic — the old off-default rationale ("cache-illusory savings")
   *  cited the superseded dead verdict. Grok stays opt-in until quality
   *  matches Fable. Verbatim recall is still lossy; the dashboard toggle
   *  remains the kill switch. See FINDINGS.md. */
  private compressionEnabled = true;
  /** Recent requests' transform breakdowns, for the Context Map panel + its
   *  history selector. In-memory ring, newest last. */
  private contextHistory: ContextMapData[] = [];
  setCompressionEnabled(on: boolean): void {
    this.compressionEnabled = on;
  }
  getCompressionEnabled(): boolean {
    return this.compressionEnabled;
  }
  /** Resolved disk paths for the events.jsonl + 4xx-bodies sidecar dir. The
   *  new sessions / cleanup endpoints need this; legacy callers that don't
   *  pass `paths` opt out of those endpoints by returning 503. */
  private readonly paths: SessionsPaths | undefined;

  /** Test hook: when set, /api/sessions.json and /api/sessions/${id}.json
   *  call this instead of `claudeCodeMap()` with the real `~/.claude/projects/`
   *  path. Lets unit tests run in tens of ms instead of scanning hundreds of
   *  the developer's actual Claude Code session files. */
  private readonly ccMapFn: () => Promise<Map<string, ClaudeCodeSessionRef>>;

  /** Host-provided persistence hook for the runtime model scope. The core
   *  override stays in-memory (Edge-safe); a Node host passes a saver that
   *  writes the `models` key of the config file so chip toggles survive a
   *  restart. Best-effort: failures are the hook's problem, never the API's. */
  private readonly persistModelBases: ((bases: readonly string[]) => void) | undefined;
  private readonly hooks: DashboardHooks;
  private pluginOverrides: PluginOverrides = {};

  constructor(
    paths?: SessionsPaths,
    ccMapFn?: () => Promise<Map<string, ClaudeCodeSessionRef>>,
    persistModelBases?: (bases: readonly string[]) => void,
    hooks: DashboardHooks = {},
  ) {
    this.paths = paths;
    this.ccMapFn = ccMapFn ?? (() => claudeCodeMap());
    this.persistModelBases = persistModelBases;
    this.hooks = hooks;
  }

  private totalsForModel(model: string | undefined): Totals {
    const key = model ?? '';
    let totals = this.totalsByModel.get(key);
    if (!totals) {
      totals = emptyTotals(this.startedAt);
      this.totalsByModel.set(key, totals);
    }
    return totals;
  }

  private enabledTotals(): Totals {
    const combined = emptyTotals(this.startedAt);
    for (const [model, totals] of this.totalsByModel) {
      if (!isFicheSupportedModel(model) && totals.textHygieneSavedTokens <= 0) continue;
      for (const key of Object.keys(combined) as Array<keyof Totals>) {
        if (key !== 'startedAt') combined[key] += totals[key];
      }
    }
    return combined;
  }

  private dailyBucketFor(dateKey: string, model: string | undefined): DailyBucket {
    let byModel = this.dailyByDateModel.get(dateKey);
    if (!byModel) {
      byModel = new Map<string, DailyBucket>();
      this.dailyByDateModel.set(dateKey, byModel);
      if (this.dailyByDateModel.size > MAX_DAILY_BUCKETS) {
        let oldestKey: string | undefined;
        for (const k of this.dailyByDateModel.keys()) {
          if (oldestKey === undefined || k < oldestKey) oldestKey = k;
        }
        if (oldestKey !== undefined) this.dailyByDateModel.delete(oldestKey);
      }
    }
    const modelKey = model ?? '';
    let bucket = byModel.get(modelKey);
    if (!bucket) {
      bucket = emptyDailyBucket();
      byModel.set(modelKey, bucket);
    }
    return bucket;
  }

  private classifyCompressionMode(
    compressed: boolean,
    imageCount: number,
    hygieneTok: number,
    hygieneStages?: readonly string[],
    reason?: string,
  ): {
    opticalCompressed: boolean;
    textOnlyCompressed: boolean;
    compressionMode: 'optical' | 'text' | 'none';
  } {
    const textOnlyCompressed =
      compressed &&
      imageCount === 0 &&
      (hygieneTok > 0 || (hygieneStages?.length ?? 0) > 0 || reason === 'text_hygiene');
    const opticalCompressed = compressed && !textOnlyCompressed;
    const compressionMode: 'optical' | 'text' | 'none' = opticalCompressed
      ? 'optical'
      : textOnlyCompressed
        ? 'text'
        : 'none';
    return { opticalCompressed, textOnlyCompressed, compressionMode };
  }

  private recordAccumulators(args: {
    model: string | undefined;
    eventMs: number;
    compressed: boolean;
    opticalCompressed: boolean;
    textOnlyCompressed: boolean;
    haveUsage: boolean;
    creditSaving: boolean;
    dollarEligible: boolean;
    actualInputEff: number;
    baselineInputEff: number;
    outputEquiv: number;
    rawActual: number;
    rawBaseline: number;
    inp: number;
    out: number;
    cc: number;
    cr: number;
    cc1h: number;
    cachedTok: number;
    writeTok: number;
    googleOrGpt: boolean;
    sid: string | undefined;
    hygieneTok: number;
    hygieneChars: number;
    cliffAvoided: boolean;
    cliffUsd: number;
    measurement?: {
      textChars: number;
      thinkingChars: number;
      toolUseChars: number;
      redactedBlockCount: number;
    };
  }): void {
    const {
      model,
      eventMs,
      compressed,
      opticalCompressed,
      textOnlyCompressed,
      haveUsage,
      creditSaving,
      dollarEligible,
      actualInputEff,
      baselineInputEff,
      outputEquiv,
      rawActual,
      rawBaseline,
      inp,
      out,
      cc,
      cr,
      cc1h,
      cachedTok,
      writeTok,
      googleOrGpt,
      sid,
      hygieneTok,
      hygieneChars,
      cliffAvoided,
      cliffUsd,
      measurement,
    } = args;

    const totals = this.totalsForModel(model);
    const daily = this.dailyBucketFor(localDateKey(eventMs), model);

    totals.requests += 1;
    daily.requests += 1;
    if (compressed) {
      totals.compressedRequests += 1;
      daily.compressed += 1;
    }
    if (opticalCompressed) {
      totals.imagedRequests += 1;
      daily.imaged += 1;
    }
    if (textOnlyCompressed) {
      totals.textCompressedRequests += 1;
      daily.textCompressed += 1;
    }
    if (hygieneTok > 0) {
      totals.textHygieneSavedTokens += hygieneTok;
      daily.textHygieneSavedTokens += hygieneTok;
    }
    if (hygieneChars > 0) totals.textHygieneSavedChars += hygieneChars;
    if (cliffAvoided) {
      totals.cliffAvoidedEvents += 1;
      totals.cliffSavedUsd += cliffUsd;
      daily.cliffSavedUsd += cliffUsd;
    }

    const rawSaved = creditSaving && rawBaseline > 0 ? Math.max(0, rawBaseline - rawActual) : 0;

    if (creditSaving) {
      totals.baselineInputWeighted += baselineInputEff;
      totals.actualInputWeighted += actualInputEff;
      totals.outputWeighted += outputEquiv;
      totals.rawSavedTokens += rawSaved;

      daily.baselineInputWeighted += baselineInputEff;
      daily.actualInputWeighted += actualInputEff;
      daily.rawSavedTokens += rawSaved;

      if (dollarEligible) {
        totals.pricedBaselineInputWeighted += baselineInputEff;
        totals.pricedActualInputWeighted += actualInputEff;
        totals.pricedOutputWeighted += outputEquiv;

        daily.pricedBaselineInputWeighted += baselineInputEff;
        daily.pricedActualInputWeighted += actualInputEff;

        const usdPerMtok = inputUsdPerMtok(model, { promptTokens: inp + cc + cr, at: eventMs });
        if (usdPerMtok !== undefined) {
          const rowUsd = ((baselineInputEff - actualInputEff) * usdPerMtok) / 1e6;
          totals.pricedSavedUsd += rowUsd;
          totals.usdPricedRequests += 1;
          daily.pricedSavedUsd += rowUsd;
        } else {
          totals.usdUnpricedRequests += 1;
        }
      }
    }

    if (haveUsage && dollarEligible) {
      totals.allBaselineEquivalentWeighted += baselineInputEff;
      totals.allActualInputWeighted += actualInputEff;
      totals.allOutputWeighted += outputEquiv;
      totals.allUsageRequests += 1;
      let rowActualUsdKosha = 0;
      if (priceMode() === 'kosha') {
        const bill = googleOrGpt
          ? estimateBillUsd(model, {
              uncachedTokens: Math.max(0, inp - cachedTok - writeTok),
              cachedTokens: cachedTok,
              cacheWriteTokens: writeTok,
              outputTokens: out,
              promptTokens: inp,
              at: eventMs,
            })
          : estimateBillUsd(model, {
              uncachedTokens: inp,
              cachedTokens: cr,
              cacheWriteTokens: cc,
              outputTokens: out,
              ttlSec: cc1h > 0 && cc1h >= cc ? 3600 : 300,
              promptTokens: inp + cc + cr,
              at: eventMs,
            });
        rowActualUsdKosha = bill ?? ((actualInputEff + outputEquiv) * ASSUMED_INPUT_USD_PER_MTOK) / 1e6;
      }
      if (compressed) {
        totals.compressedPaidRequests += 1;
        totals.compressedActualInputWeighted += actualInputEff;
        totals.compressedOutputWeighted += outputEquiv;
        totals.compressedActualUsdKosha += rowActualUsdKosha;
      } else {
        totals.passthroughPaidRequests += 1;
        totals.passthroughActualInputWeighted += actualInputEff;
        totals.passthroughOutputWeighted += outputEquiv;
        totals.passthroughActualUsdKosha += rowActualUsdKosha;
      }
    }

    if (typeof sid === 'string' && sid.length > 0) {
      this.currentSessionId = sid;
      let s = this.sessions.get(sid);
      if (!s) {
        s = {
          sessionId: sid,
          baselineInputWeighted: 0,
          actualInputWeighted: 0,
          baselineMeasuredCount: 0,
          allActualInputWeighted: 0,
          allOutputWeighted: 0,
          rawActualTokens: 0,
          rawBaselineTokens: 0,
          rawOutputTokens: 0,
        };
        this.sessions.set(sid, s);
        if (this.sessions.size > DashboardState.SESSION_CAP) {
          const firstKey = this.sessions.keys().next().value;
          if (firstKey !== undefined) this.sessions.delete(firstKey);
        }
      }
      if (creditSaving && dollarEligible) {
        s.baselineInputWeighted += baselineInputEff;
        s.actualInputWeighted += actualInputEff;
        s.baselineMeasuredCount += 1;
        s.rawActualTokens += rawActual;
        s.rawBaselineTokens += rawBaseline;
        s.rawOutputTokens += out;
      }
      if (haveUsage && dollarEligible) {
        s.allActualInputWeighted += actualInputEff;
        s.allOutputWeighted += outputEquiv;
      }
    }

    if (measurement) {
      totals.textCharsMeasured += measurement.textChars;
      totals.thinkingCharsMeasured += measurement.thinkingChars;
      totals.toolUseCharsMeasured += measurement.toolUseChars;
      totals.redactedBlockCountMeasured += measurement.redactedBlockCount;
      totals.eventsWithMeasurement += 1;
    }
  }

  /** Stash every rendered image into the ring (called from onRequest with the
   *  raw ProxyEvent before info.firstImagePng is dropped by toTrackEvent).
   *  Returns the assigned image ids in render order; empty array when there
   *  are no images. The caller stamps ids[0] onto the RecentRow as `img_id`
   *  for back-compat and the full list as `img_ids`. */
  captureImage(info: NonNullable<ProxyEvent['info']>): number[] {
    const pngs = info.imagePngs ?? (info.firstImagePng ? [info.firstImagePng] : []);
    if (pngs.length === 0) return [];
    const dims =
      info.imageDims ??
      (info.firstImagePng
        ? [{ width: info.firstImageWidth ?? 0, height: info.firstImageHeight ?? 0 }]
        : []);
    const ids: number[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const id = this.nextImageId++;
      const width = dims[i]?.width ?? 0;
      const height = dims[i]?.height ?? 0;
      const kb = (pngs[i]!.length / 1024).toFixed(1);
      const meta = `${width}×${height} · ${kb} KB · image ${i + 1}/${pngs.length}`;
      this.images.push({
        id,
        png: pngs[i]!,
        meta,
        width,
        height,
        ts: Date.now() / 1000,
        sourceText: info.imageSourceTexts?.[i] ?? info.imageSourceText,
      });
      ids.push(id);
    }
    // Evict the oldest entries past the cap. splice() keeps insertion order
    // so images[images.length - 1] is always the latest render.
    if (this.images.length > IMAGE_RING_CAP) {
      this.images.splice(0, this.images.length - IMAGE_RING_CAP);
    }
    return ids;
  }

  /** Fold one event into the running totals + ring buffer.
   *
   *  Savings math is gated on a per-request `baseline_tokens` measurement
   *  from the parallel count_tokens probe or model-profile estimation (Google/GPT),
   *  plus an upstream usage block. When both probe and estimation are missing,
   *  we still count the request but skip its savings contribution. */
  update(ev: ProxyEvent): void {
    // Stash the image bytes before they get GC'd by the request finishing.
    // The returned id (if any) is stamped onto this request's RecentRow so
    // the dashboard can pull the exact image that request rendered.
    const imgIds = ev.info?.compressed ? this.captureImage(ev.info) : [];
    const imgId = imgIds[0];

    const u = ev.usage;
    const info = ev.info;
    const compressed = info?.compressed === true;
    const eventMs = Date.now();

    const inp = u?.input_tokens ?? 0;
    const out = u?.output_tokens ?? 0;
    const cc = u?.cache_creation_input_tokens ?? 0;
    const cc5m = u?.cache_creation?.ephemeral_5m_input_tokens;
    const cc1h = u?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cr = u?.cache_read_input_tokens ?? 0;
    const gpt = isOpenAIEvent(ev.path, ev.accountingProvider);
    const google = ev.accountingProvider === 'google'
      || ev.path.includes('google-ai-studio') || ev.path.toLowerCase().includes('generatecontent');

    // Unified per-row accounting, filled by the provider branch below. The
    // downstream totals / per-session / recent-row code reads only these —
    // it never re-derives cache math, so Anthropic and GPT can't drift.
    let haveUsage: boolean;
    let haveBaseline: boolean;
    let creditSaving: boolean;
    let actualInputEff: number;
    let baselineInputEff: number;
    let outputEquiv: number;
    let rawActual: number; // raw tokens sent (session ratio + Details realInput)
    let rawBaseline: number; // raw text-only counterfactual tokens
    let baselineForRow: number; // baseline token count for contextHistory/recent
    let cacheReadForRow: number; // tokens to surface in the "Cache hits" column
    let warmForRow: boolean; // did the TEXT baseline read warm? Server-observed:
    // Anthropic cr>0 or GPT cached_tokens>0. Drives Context Map narration.

    if (google) {
      const e = googleEff({
        model: ev.model,
        inputTokens: inp,
        outputTokens: out,
        cachedTokens: u?.cached_tokens ?? 0,
        compressed,
        baselineTokens: info?.baselineTokens ?? 0,
        baselineProbeStatus: info?.baselineProbeStatus,
        imageTokens: info?.imageTokens ?? 0,
        baselineImagedTokens: info?.baselineImagedTokens ?? 0,
        nativeInjectedTokens: info?.nativeInjectedTokens ?? 0,
        textHygieneSavedTokens: info?.textHygieneSavedTokens ?? 0,
      });
      haveUsage = e.haveUsage;
      haveBaseline = e.haveBaseline;
      creditSaving = e.creditSaving;
      actualInputEff = e.actualInputEff;
      baselineInputEff = e.baselineInputEff;
      outputEquiv = e.outputEquiv;
      rawActual = inp;
      rawBaseline = e.rawBaseline;
      baselineForRow = creditSaving ? e.rawBaseline : 0;
      cacheReadForRow = u?.cached_tokens ?? 0;
      warmForRow = e.warmForRow;
    } else if (gpt) {
      const sidGpt = info?.firstUserSha8;
      const cachedGpt = u?.cached_tokens ?? 0;
      const completionSecGpt = Date.now() / 1000;
      const requestStartSecGpt = completionSecGpt - Math.max(0, ev.durationMs || 0) / 1000;
      const gptPrev = typeof sidGpt === 'string' && sidGpt.length > 0
        ? this.openaiWarmth.get(sidGpt)
        : undefined;
      const pxShaGpt = info?.cachePrefixSha8 ?? info?.historyImageSha;
      const warmthGpt = deriveOpenAIBaselineWarmth(
        gptPrev,
        requestStartSecGpt,
        cachedGpt,
        info?.systemSha8,
        ev.model,
        OPENAI_CACHE_TTL_SEC,
        pxShaGpt,
      );
      const e = gptEff({
        model: ev.model,
        inputTokens: inp,
        outputTokens: out,
        cachedTokens: cachedGpt,
        cacheWriteTokens: u?.cache_write_tokens ?? 0,
        imageTokens: info?.imageTokens ?? 0,
        baselineImagedTokens: info?.baselineImagedTokens ?? 0,
        nativeInjectedTokens: info?.nativeInjectedTokens ?? 0,
        textHygieneSavedTokens: info?.textHygieneSavedTokens ?? 0,
        warmth: warmthGpt,
        compressed,
      });
      if (typeof sidGpt === 'string' && sidGpt.length > 0 && e.haveUsage) {
        this.openaiWarmth.set(sidGpt, {
          ts: completionSecGpt,
          cachedOrPrefixTokens: cachedGpt > 0 ? cachedGpt : Math.max(gptPrev?.cachedOrPrefixTokens ?? 0, inp),
          prefixSha: info?.systemSha8 ?? gptPrev?.prefixSha,
          pxPrefixSha: pxShaGpt ?? gptPrev?.pxPrefixSha,
          model: ev.model ?? gptPrev?.model,
        });
        if (this.openaiWarmth.size > DashboardState.SESSION_CAP) {
          const firstKey = this.openaiWarmth.keys().next().value;
          if (firstKey !== undefined) this.openaiWarmth.delete(firstKey);
        }
      }
      haveUsage = e.haveUsage;
      haveBaseline = e.haveBaseline;
      creditSaving = e.creditSaving;
      actualInputEff = e.actualInputEff;
      baselineInputEff = e.baselineInputEff;
      outputEquiv = e.outputEquiv;
      rawActual = e.rawActual;
      rawBaseline = e.rawBaseline;
      baselineForRow = e.rawBaseline;
      cacheReadForRow = cachedGpt;
      warmForRow = warmthGpt.warm;
    } else {
      haveUsage = u !== undefined && (inp > 0 || out > 0 || cc > 0 || cr > 0);
      const baseline = info?.baselineTokens;

      // Honest gating: only attribute savings when BOTH baseline probes
      // resolved (status === 'ok'). When the cacheable-prefix probe failed
      // (status === 'partial') we previously fell through to cacheable=0,
      // which silently charges the unproxied counterfactual the cold-input
      // rate on tokens that actually would have been cache-discounted —
      // fabricating "$ saved". Excluding the row is the only honest move
      // until the probe succeeds.
      const probeOk = info?.baselineProbeStatus === 'ok'
        // Back-compat: hosts that haven't adopted baselineProbeStatus yet
        // still see fields land; we accept legacy rows where the full-body
        // probe resolved AND (either no markers existed OR cacheable did too).
        || (info?.baselineProbeStatus === undefined && baseline !== undefined && baseline > 0);
      haveBaseline = typeof baseline === 'number' && baseline > 0 && probeOk;

      // Weighted INPUT cost we actually paid this turn.
      actualInputEff = haveUsage
        ? computeActualInputEffWithCacheTier(inp, cc, cr, cc1h, cc5m, anthropicReadRate(ev.model))
        : 0;

      // inkling only reduces input by imaging the static slab. An UNCOMPRESSED
      // row had its body forwarded untouched, so its unproxied counterfactual
      // IS exactly what it paid — crediting the cache-modeled baseline there
      // (which prices the prefix at the cache-READ rate) fabricates savings on
      // passthrough traffic. Only credit the counterfactual when the row was
      // actually compressed AND we have a usable probe.
      creditSaving = haveBaseline && haveUsage && compressed;

      // Cache-aware baseline. INVARIANT: inkling is credited ONLY for the text it
      // imaged away — NEVER for caching. The imagined text path is warm when
      // cr>0, or when a same-prefix prior completed within the TTL (text would
      // have read its own cache even if inkling's image busted the real one).
      // Uncompressed rows fall back to actualInputEff → zero savings.
      const cacheable = info?.baselineCacheableTokens ?? 0;
      // Use request start for the prior lookup; an overlapping request that had
      // not completed could not have warmed the text cache for this one.
      const sidNow = info?.firstUserSha8;
      const prefixShaNow = info?.systemSha8;
      const completionSec = Date.now() / 1000;
      const requestStartSec = completionSec - Math.max(0, ev.durationMs || 0) / 1000;
      const warmthPrev =
        typeof sidNow === 'string' && sidNow.length > 0
          ? this.baselineWarmth.get(sidNow)
          : undefined;
      // Centralised in deriveBaselineWarmth so update()/replay()/sessions can't drift.
      const toolsShaNow = info?.cachePrefixToolsSha8;
      const { warm, prevCacheable } = deriveBaselineWarmth(
        warmthPrev,
        requestStartSec,
        cacheable,
        cr,
        DashboardState.CACHE_TTL_SEC,
        prefixShaNow,
        toolsShaNow,
        { pxPrefixSha: info?.cachePrefixSha8, model: ev.model },
      );
      baselineInputEff = creditSaving
        ? computeBaselineInputEffWithCacheTier(
            baseline as number,
            cacheable,
            inp,
            cc,
            cr,
            warm,
            prevCacheable,
            cc1h,
            cc5m,
            anthropicReadRate(ev.model),
          )
        : actualInputEff;
      const hygieneTok = info?.textHygieneSavedTokens ?? 0;
      if (!haveBaseline && compressed && haveUsage && hygieneTok > 0 && (info?.imageCount ?? 0) === 0) {
        haveBaseline = true;
        creditSaving = true;
        const deltaWeight = cr > 0
          ? anthropicReadRate(ev.model)
          : cc > 0 ? (cc1h > 0 && cc1h >= cc ? 2.0 : 1.25) : 1.0;
        baselineInputEff = actualInputEff + hygieneTok * deltaWeight;
      }
      // Record this completed turn's prefix for later warmth/split decisions.
      // Carry the prior cacheable when this row has no probe.
      if (typeof sidNow === 'string' && sidNow.length > 0 && haveUsage) {
        this.baselineWarmth.set(sidNow, {
          ts: completionSec,
          cacheable: cacheable > 0 ? cacheable : (warmthPrev?.cacheable ?? 0),
          prefixSha: prefixShaNow ?? warmthPrev?.prefixSha,
          toolsSha: toolsShaNow ?? warmthPrev?.toolsSha,
          pxPrefixSha: info?.cachePrefixSha8 ?? warmthPrev?.pxPrefixSha,
          model: ev.model ?? warmthPrev?.model,
          ttlSec: observedCacheTtlSec(cc1h, warmthPrev?.ttlSec),
        });
        if (this.baselineWarmth.size > DashboardState.SESSION_CAP) {
          const firstKey = this.baselineWarmth.keys().next().value;
          if (firstKey !== undefined) this.baselineWarmth.delete(firstKey);
        }
      }

      // Output tokens are identical with/without compression — the proxy never
      // touches the response body. They show up on BOTH sides of the savings
      // ratio at their actual rate (OUTPUT_TOKEN_RATE × input rate) so the
      // denominator reflects the full bill the user actually pays. Without
      // this, an output-heavy turn would silently inflate the "saved %"
      // headline relative to what Anthropic's weekly limit meters as token
      // consumption (input + output × 5).
      outputEquiv = haveUsage ? out * OUTPUT_TOKEN_RATE : 0;
      rawActual = inp + cc + cr;
      rawBaseline = baseline ?? (creditSaving && hygieneTok > 0 ? rawActual + hygieneTok : 0);
      baselineForRow = rawBaseline;
      cacheReadForRow = cr;
      warmForRow = warm; // server-observed cache read (cr>0)
    }

    // Record the request's transform breakdown for the Context Map panel. This
    // runs AFTER the eff-tokens are computed so the Details headline reads the
    // SAME cache-weighted pair as the recent row's As-text / Sent / Saved
    // columns (baselineInputEff / actualInputEff) — the two panels can no longer
    // disagree. Raw counts are kept for the cache-blind sub-line. Gate on
    // haveUsage so an in-flight request doesn't render a bogus "-100%".
    if (info && haveUsage && imgId !== undefined) {
      // Key by the request's first image id so the recent table's "view" link
      // (which carries that id) maps straight to this breakdown.
      this.contextHistory.push({
        id: imgId,
        baselineTokens: baselineForRow,
        realInput: rawActual,
        baselineInputEff,
        actualInputEff,
        haveBaseline,
        cacheRead: cacheReadForRow,
        warm: warmForRow,
        output: out,
        imageCount: info.imageCount ?? 0,
        nativeImages: info.nativeImages,
        wireImages: info.wireImages,
        imageBudgetSkips: info.imageBudgetSkips,
        baselineImagedTokens: info.baselineImagedTokens,
        buckets: { ...(info.bucketChars ?? {}) },
        imageIds: [...imgIds],
        compressed,
        model: ev.model,
        responsesComposition: info.responsesComposition,
        responsesUnexplainedTokens: info.responsesComposition
          ? Math.max(0, rawBaseline - info.responsesComposition.totalLocal)
          : undefined,
      });
      // Keep in lockstep with RECENT_CAP so every "view" link in the recent
      // table resolves to a real breakdown (was 30 < 50, so older visible rows
      // silently fell back to the latest request's data).
      if (this.contextHistory.length > RECENT_CAP) {
        this.contextHistory.splice(0, this.contextHistory.length - RECENT_CAP);
      }
    }

    const imageCount = info?.imageCount ?? 0;
    const hygieneTok = info?.textHygieneSavedTokens ?? 0;
    const hygieneChars = info?.textHygieneSavedChars ?? 0;
    const hygieneStages = info?.textHygieneStages;
    const { opticalCompressed, textOnlyCompressed, compressionMode } = this.classifyCompressionMode(
      compressed,
      imageCount,
      hygieneTok,
      hygieneStages,
      info?.reason,
    );
    const dollarEligible = !google || priceMode() === 'kosha';

    this.recordAccumulators({
      model: ev.model,
      eventMs,
      compressed,
      opticalCompressed,
      textOnlyCompressed,
      haveUsage,
      creditSaving,
      dollarEligible,
      actualInputEff,
      baselineInputEff,
      outputEquiv,
      rawActual,
      rawBaseline,
      inp,
      out,
      cc,
      cr,
      cc1h,
      cachedTok: u?.cached_tokens ?? 0,
      writeTok: u?.cache_write_tokens ?? 0,
      googleOrGpt: google || gpt,
      sid: info?.firstUserSha8,
      hygieneTok,
      hygieneChars,
      cliffAvoided: Boolean(info?.cliffAvoided),
      cliffUsd: info?.cliffAvoided?.savedUsd ?? 0,
      measurement: ev.measurement,
    });

    const row: RecentRow = {
      ts: eventMs / 1000,
      method: ev.method,
      path: ev.path,
      model: ev.model,
      status: ev.status,
      compressed,
      cc_added: opticalCompressed ? 1 : undefined,
      image_count: imageCount,
      compression_mode: compressionMode,
      ...(hygieneStages && hygieneStages.length > 0 ? { text_hygiene_stages: [...hygieneStages] } : {}),
      input_tokens: haveUsage ? inp : undefined,
      output_tokens: haveUsage ? out : undefined,
      cache_create: haveUsage ? cc : undefined,
      cache_read: haveUsage ? cacheReadForRow : undefined,
      actual_input: haveUsage ? round1(actualInputEff) : undefined,
      baseline_input: creditSaving ? round1(baselineInputEff) : undefined,
      session_saved_so_far_delta:
        creditSaving ? round1(baselineInputEff - actualInputEff) : undefined,
      img_id: imgId,
      img_ids: imgIds,
    };
    this.recent.push(row);
    if (this.recent.length > RECENT_CAP) this.recent.splice(0, this.recent.length - RECENT_CAP);
  }


  /** On startup, stream historical JSONL logs (`${filePath}.1` then `filePath`)
   *  line-by-line to restore full lifetime, per-model, daily, and active-session
   *  accumulators across restarts while keeping `recent` & `contextHistory`
   *  bounded to `RECENT_CAP`. */
  async replay(filePath: string): Promise<void> {
    const candidates = [`${filePath}.1`, filePath];
    let anyReadable = false;
    const finiteNum = (v: unknown, fallback = 0): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    const finiteOptNum = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;

    interface ReplayTailEntry {
      t: TrackEvent;
      eventMs: number;
      compressed: boolean;
      haveUsage: boolean;
      haveBaseline: boolean;
      creditSaving: boolean;
      actualInputEff: number;
      baselineInputEff: number;
      rawActual: number;
      rawBaseline: number;
      baselineForRow: number;
      cacheReadForRow: number;
      warmForRow: boolean;
      out: number;
      imageCount: number;
      opticalCompressed: boolean;
      compressionMode: 'optical' | 'text' | 'none';
      hygieneStages: string[] | undefined;
      gpt: boolean;
      google: boolean;
    }
    const tailBuffer: ReplayTailEntry[] = [];

    for (const candidate of candidates) {
      try {
        await fs.promises.access(candidate, fs.constants.R_OK);
        anyReadable = true;
      } catch {
        continue;
      }
      try {
        const stream = fs.createReadStream(candidate, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // skip malformed line
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          const t = parsed as TrackEvent;
          if (typeof t.path !== 'string' || typeof t.ts !== 'string') continue;
          const parsedMs = Date.parse(t.ts);
          if (!Number.isFinite(parsedMs)) continue;
          const eventMs = parsedMs;
          const inp = finiteNum(t.input_tokens);
          const out = finiteNum(t.output_tokens);
          const cc = finiteNum(t.cache_create_tokens);
          const cc5m = finiteOptNum(t.cache_create_5m_tokens);
          const cc1h = finiteNum(t.cache_create_1h_tokens);
          const cr = finiteNum(t.cache_read_tokens);
          const compressed = t.compressed === true;
          const gpt = isOpenAIEvent(t.path, t.accounting_provider);
          const google = t.accounting_provider === 'google'
            || t.path.includes('google-ai-studio') || t.path.toLowerCase().includes('generatecontent');

          // Same unified accounting as update(); see the branch comments there.
          let haveUsage: boolean;
          let haveBaseline: boolean;
          let creditSaving: boolean;
          let actualInputEff: number;
          let baselineInputEff: number;
          let outputEquiv: number;
          let rawActual: number;
          let rawBaseline: number;
          let baselineForRow: number;
          let cacheReadForRow: number;
          let warmForRow: boolean; // text-baseline warmth for the Context Map narration

          const cachedTok = finiteNum((t as { cached_tokens?: unknown }).cached_tokens);
          const baselineTok = finiteNum((t as { baseline_tokens?: unknown }).baseline_tokens);
          const imageTok = finiteNum((t as { image_tokens?: unknown }).image_tokens);
          const baselineImagedTok = finiteNum((t as { baseline_imaged_tokens?: unknown }).baseline_imaged_tokens);
          const nativeInjectedTok = finiteNum((t as { native_injected_tokens?: unknown }).native_injected_tokens);
          const hygieneTok = finiteNum(t.text_hygiene_saved_tokens);
          const hygieneChars = finiteNum(t.text_hygiene_saved_chars);
          const writeTok = finiteNum(t.cache_write_tokens);
          const imageCount = finiteNum((t as { image_count?: unknown }).image_count);
          const durationMs = Math.max(0, finiteNum(t.duration_ms));

          if (google) {
            const e = googleEff({
              model: t.model,
              inputTokens: inp,
              outputTokens: out,
              cachedTokens: cachedTok,
              compressed,
              baselineTokens: baselineTok,
              baselineProbeStatus:
                (t as { baseline_probe_status?: string }).baseline_probe_status,
              imageTokens: imageTok,
              baselineImagedTokens: baselineImagedTok,
              nativeInjectedTokens: nativeInjectedTok,
              textHygieneSavedTokens: hygieneTok,
            });
            haveUsage = e.haveUsage;
            haveBaseline = e.haveBaseline;
            creditSaving = e.creditSaving;
            actualInputEff = e.actualInputEff;
            baselineInputEff = e.baselineInputEff;
            outputEquiv = e.outputEquiv;
            rawActual = inp;
            rawBaseline = e.rawBaseline;
            baselineForRow = creditSaving ? e.rawBaseline : 0;
            cacheReadForRow = cachedTok;
            warmForRow = e.warmForRow;
          } else if (gpt) {
            const sidGptR = (t as { first_user_sha8?: string }).first_user_sha8;
            const completionSecGptR = eventMs / 1000;
            const requestStartSecGptR = completionSecGptR - durationMs / 1000;
            const gptPrevR = typeof sidGptR === 'string' && sidGptR.length > 0
              ? this.openaiWarmth.get(sidGptR)
              : undefined;
            const pxShaGptR = t.cache_prefix_sha8 ?? (t as { history_image_sha8?: string }).history_image_sha8;
            const warmthGptR = deriveOpenAIBaselineWarmth(
              gptPrevR,
              requestStartSecGptR,
              cachedTok,
              (t as { system_sha8?: string }).system_sha8,
              t.model,
              OPENAI_CACHE_TTL_SEC,
              pxShaGptR,
            );
            const e = gptEff({
              model: t.model,
              inputTokens: inp,
              outputTokens: out,
              cachedTokens: cachedTok,
              cacheWriteTokens: writeTok,
              imageTokens: imageTok,
              baselineImagedTokens: baselineImagedTok,
              nativeInjectedTokens: nativeInjectedTok,
              textHygieneSavedTokens: hygieneTok,
              warmth: warmthGptR,
              compressed,
            });
            if (typeof sidGptR === 'string' && sidGptR.length > 0 && e.haveUsage) {
              this.openaiWarmth.set(sidGptR, {
                ts: completionSecGptR,
                cachedOrPrefixTokens: cachedTok > 0 ? cachedTok : Math.max(gptPrevR?.cachedOrPrefixTokens ?? 0, inp),
                prefixSha: (t as { system_sha8?: string }).system_sha8 ?? gptPrevR?.prefixSha,
                pxPrefixSha: pxShaGptR ?? gptPrevR?.pxPrefixSha,
                model: t.model ?? gptPrevR?.model,
              });
              if (this.openaiWarmth.size > DashboardState.SESSION_CAP) {
                const firstKey = this.openaiWarmth.keys().next().value;
                if (firstKey !== undefined) this.openaiWarmth.delete(firstKey);
              }
            }
            haveUsage = e.haveUsage;
            haveBaseline = e.haveBaseline;
            creditSaving = e.creditSaving;
            actualInputEff = e.actualInputEff;
            baselineInputEff = e.baselineInputEff;
            outputEquiv = e.outputEquiv;
            rawActual = e.rawActual;
            rawBaseline = e.rawBaseline;
            baselineForRow = e.rawBaseline;
            cacheReadForRow = cachedTok;
            warmForRow = warmthGptR.warm;
          } else {
            haveUsage = inp > 0 || out > 0 || cc > 0 || cr > 0;
            const baselineOpt = finiteOptNum((t as { baseline_tokens?: unknown }).baseline_tokens);
            const cacheable = finiteNum((t as { baseline_cacheable_tokens?: unknown }).baseline_cacheable_tokens);
            const probeStatus = (t as { baseline_probe_status?: string }).baseline_probe_status;
            // Same gating rule as update(): require an explicit 'ok' status when
            // present; fall back to "have a baseline number" for legacy JSONL.
            const probeOk = probeStatus === 'ok'
              || (probeStatus === undefined && baselineOpt !== undefined && baselineOpt > 0);
            haveBaseline = baselineOpt !== undefined && baselineOpt > 0 && probeOk;
            actualInputEff = haveUsage
              ? computeActualInputEffWithCacheTier(inp, cc, cr, cc1h, cc5m, anthropicReadRate(t.model, { at: eventMs }))
              : 0;
            // Mirror update(): only credit the cache-modeled counterfactual on
            // compressed rows. Uncompressed/passthrough rows fall back to the
            // actual cost so they show zero saved (no fabricated savings).
            creditSaving = haveBaseline && haveUsage && compressed;
            // Warmth is reconstructed from persisted completion ts + duration_ms
            // exactly as update() saw it live.
            const sidR = (t as { first_user_sha8?: string }).first_user_sha8;
            const prefixShaR = (t as { system_sha8?: string }).system_sha8;
            const completionSecR = eventMs / 1000;
            const requestStartSecR = completionSecR - durationMs / 1000;
            const warmthPrevR =
              typeof sidR === 'string' && sidR.length > 0 ? this.baselineWarmth.get(sidR) : undefined;
            const toolsShaR = (t as { cache_prefix_tools_sha8?: string }).cache_prefix_tools_sha8;
            const { warm: warmR, prevCacheable: prevCacheableR } = deriveBaselineWarmth(
              warmthPrevR,
              requestStartSecR,
              cacheable,
              cr,
              DashboardState.CACHE_TTL_SEC,
              prefixShaR,
              toolsShaR,
              { pxPrefixSha: t.cache_prefix_sha8, model: t.model },
            );
            baselineInputEff = creditSaving
              ? computeBaselineInputEffWithCacheTier(
                  baselineOpt as number,
                  cacheable,
                  inp,
                  cc,
                  cr,
                  warmR,
                  prevCacheableR,
                  cc1h,
                  cc5m,
                  anthropicReadRate(t.model, { at: eventMs }),
                )
              : actualInputEff;
            if (!haveBaseline && compressed && haveUsage && hygieneTok > 0 && imageCount === 0) {
              haveBaseline = true;
              creditSaving = true;
              const deltaWeightR = cr > 0
                ? anthropicReadRate(t.model, { at: eventMs })
                : cc > 0 ? (cc1h > 0 && cc1h >= cc ? 2.0 : 1.25) : 1.0;
              baselineInputEff = actualInputEff + hygieneTok * deltaWeightR;
            }
            if (typeof sidR === 'string' && sidR.length > 0 && haveUsage) {
              this.baselineWarmth.set(sidR, {
                ts: completionSecR,
                cacheable: cacheable > 0 ? cacheable : (warmthPrevR?.cacheable ?? 0),
                prefixSha: prefixShaR ?? warmthPrevR?.prefixSha,
                toolsSha: toolsShaR ?? warmthPrevR?.toolsSha,
                pxPrefixSha: t.cache_prefix_sha8 ?? warmthPrevR?.pxPrefixSha,
                model: t.model ?? warmthPrevR?.model,
                ttlSec: observedCacheTtlSec(cc1h, warmthPrevR?.ttlSec),
              });
              if (this.baselineWarmth.size > DashboardState.SESSION_CAP) {
                const firstKey = this.baselineWarmth.keys().next().value;
                if (firstKey !== undefined) this.baselineWarmth.delete(firstKey);
              }
            }
            outputEquiv = haveUsage ? out * OUTPUT_TOKEN_RATE : 0;
            rawActual = inp + cc + cr;
            rawBaseline = baselineOpt ?? (creditSaving && hygieneTok > 0 ? rawActual + hygieneTok : 0);
            baselineForRow = rawBaseline;
            cacheReadForRow = cr;
            warmForRow = warmR;
          }

          const hygieneStages = Array.isArray(t.text_hygiene_stages)
            ? t.text_hygiene_stages.filter((s): s is string => typeof s === 'string')
            : undefined;
          const { opticalCompressed, textOnlyCompressed, compressionMode } = this.classifyCompressionMode(
            compressed,
            imageCount,
            hygieneTok,
            hygieneStages,
            t.reason,
          );
          const dollarEligible = !google || priceMode() === 'kosha';
          const textMeas = finiteOptNum(t.text_chars_measured);
          const thinkMeas = finiteOptNum(t.thinking_chars_measured);
          const toolMeas = finiteOptNum(t.tool_use_chars_measured);
          const redactMeas = finiteOptNum(t.redacted_block_count_measured);
          const hasMeas =
            textMeas !== undefined ||
            thinkMeas !== undefined ||
            toolMeas !== undefined ||
            redactMeas !== undefined;
          const measurement = hasMeas
            ? {
                textChars: textMeas ?? 0,
                thinkingChars: thinkMeas ?? 0,
                toolUseChars: toolMeas ?? 0,
                redactedBlockCount: redactMeas ?? 0,
              }
            : undefined;
          const cliffUsd = finiteNum(t.cliff_saved_usd);
          const cliffAvoided = cliffUsd > 0 || t.cliff_avoided_at !== undefined;

          this.recordAccumulators({
            model: t.model,
            eventMs,
            compressed,
            opticalCompressed,
            textOnlyCompressed,
            haveUsage,
            creditSaving,
            dollarEligible,
            actualInputEff,
            baselineInputEff,
            outputEquiv,
            rawActual,
            rawBaseline,
            inp,
            out,
            cc,
            cr,
            cc1h,
            cachedTok,
            writeTok,
            googleOrGpt: google || gpt,
            sid: (t as { first_user_sha8?: string }).first_user_sha8,
            hygieneTok,
            hygieneChars,
            cliffAvoided,
            cliffUsd,
            measurement,
          });

          if (tailBuffer.length >= RECENT_CAP) tailBuffer.shift();
          tailBuffer.push({
            t,
            eventMs,
            compressed,
            haveUsage,
            haveBaseline,
            creditSaving,
            actualInputEff,
            baselineInputEff,
            rawActual,
            rawBaseline,
            baselineForRow,
            cacheReadForRow,
            warmForRow,
            out,
            imageCount,
            opticalCompressed,
            compressionMode,
            hygieneStages,
            gpt,
            google,
          });
        }
      } catch {
        // One unreadable/corrupt rotated file must never prevent replaying newer candidates.
        continue;
      }
    }
    if (!anyReadable) return;

    // Construct RecentRow / ContextMapData only for the trailing RECENT_CAP entries.
    for (const item of tailBuffer) {
      const {
        t, eventMs, compressed, haveUsage, haveBaseline, creditSaving,
        actualInputEff, baselineInputEff, rawActual, rawBaseline, baselineForRow,
        cacheReadForRow, warmForRow, out, imageCount, opticalCompressed,
        compressionMode, hygieneStages, gpt, google,
      } = item;
      let imgId: number | undefined;
      if (compressed && haveUsage && imageCount > 0) {
        imgId = this.nextImageId++;
        const rawBuckets = (t as { bucket_chars?: unknown }).bucket_chars;
        const safeBuckets: Record<string, number> = {};
        if (rawBuckets && typeof rawBuckets === 'object' && !Array.isArray(rawBuckets)) {
          for (const [k, v] of Object.entries(rawBuckets as Record<string, unknown>)) {
            if (typeof v === 'number' && Number.isFinite(v)) safeBuckets[k] = v;
          }
        }
        const rawRc = (t as { responses_composition?: unknown }).responses_composition as
          | ContextMapData['responsesComposition']
          | undefined;
        const rc = rawRc && typeof rawRc === 'object' && !Array.isArray(rawRc) ? rawRc : undefined;
        this.contextHistory.push({
          id: imgId,
          baselineTokens: baselineForRow,
          realInput: rawActual,
          baselineInputEff,
          actualInputEff,
          haveBaseline,
          cacheRead: cacheReadForRow,
          warm: warmForRow,
          output: out,
          imageCount,
          nativeImages: finiteOptNum((t as { native_images?: unknown }).native_images),
          wireImages: finiteOptNum((t as { wire_images?: unknown }).wire_images),
          imageBudgetSkips: finiteOptNum((t as { image_budget_skips?: unknown }).image_budget_skips),
          baselineImagedTokens: finiteOptNum((t as { baseline_imaged_tokens?: unknown }).baseline_imaged_tokens),
          buckets: safeBuckets,
          imageIds: [],
          compressed,
          model: t.model,
          responsesComposition: rc,
          responsesUnexplainedTokens: rc
            ? Math.max(0, rawBaseline - finiteNum(rc.totalLocal))
            : undefined,
          restored: true,
        });
        if (this.contextHistory.length > RECENT_CAP) {
          this.contextHistory.splice(0, this.contextHistory.length - RECENT_CAP);
        }
      }
      const statusNum = finiteOptNum(t.status);
      const row: RecentRow = {
        ts: eventMs / 1000,
        method: typeof t.method === 'string' ? t.method : 'POST',
        path: t.path,
        model: typeof t.model === 'string' ? t.model : undefined,
        status: statusNum !== undefined ? Math.trunc(statusNum) : 0,
        compressed,
        cc_added: opticalCompressed ? 1 : undefined,
        image_count: imageCount,
        compression_mode: compressionMode,
        ...(hygieneStages && hygieneStages.length > 0 ? { text_hygiene_stages: [...hygieneStages] } : {}),
        input_tokens: finiteOptNum(t.input_tokens),
        output_tokens: finiteOptNum(t.output_tokens),
        cache_create: finiteOptNum(t.cache_create_tokens),
        cache_read: gpt || google ? cacheReadForRow : finiteOptNum(t.cache_read_tokens),
        actual_input: haveUsage ? round1(actualInputEff) : undefined,
        baseline_input: creditSaving ? round1(baselineInputEff) : undefined,
        session_saved_so_far_delta: creditSaving ? round1(baselineInputEff - actualInputEff) : undefined,
        img_id: imgId,
        img_ids: imgId !== undefined ? [imgId] : undefined,
      };
      this.recent.push(row);
      if (this.recent.length > RECENT_CAP) this.recent.shift();
    }
  }

  // ---- HTTP handlers ------------------------------------------------------

  /**
   * Per-session "what's happening right now" payload backing the
   * `SessionSummary` panel. Scopes the dollar-weighted savings ratio + the
   * per-bucket char attribution + the passthrough-reason histogram to the
   * most-recently-active session (tracked via `info.firstUserSha8`) so the
   * top-of-dashboard headline reflects the live session rather than stale
   * lifetime aggregates from a previous run.
   *
   * Returns `{ sessionId: null, message: 'no active session yet' }` when no
   * events have been received yet (or the first events were all untagged —
   * cold start, probe failures) — `update()` only sets `currentSessionId`
   * when a `firstUserSha8`-tagged event lands. The client renders a stale
   * panel rather than zeroes when a session goes idle (NO `lastSeen >
   * threshold` check here; see comment in `update()` for the rationale).
   */
  serveCurrentSessionJson(): Response {
    if (!this.currentSessionId) {
      return jsonResponse({
        sessionId: null,
        message: 'no active session yet',
      });
    }
    const s = this.sessions.get(this.currentSessionId);
    if (!s) {
      return jsonResponse({ sessionId: null, message: 'no active session yet' });
    }
    // Headline payload: the same dollar-weighted baseline/actual input
    // accumulators the global Totals block exposes, plus the honest
    // denominator (`baselineMeasuredCount` — only requests that carried a
    // baseline measurement). We ALSO ship the ALL-rows session bill
    // (`allActualInputWeighted` + `allOutputWeighted`) so the Svelte panel
    // can compute saved-% against the full session bill instead of just
    // the measured slice — matching the global `saved_pct_of_all_spend`
    // math but scoped to one session. The Svelte panel does the dollar
    // conversion itself so we don't round-trip pricing through the wire.
    return jsonResponse({
      sessionId: s.sessionId,
      baselineInputWeighted: s.baselineInputWeighted,
      actualInputWeighted: s.actualInputWeighted,
      baselineMeasuredCount: s.baselineMeasuredCount,
      allActualInputWeighted: s.allActualInputWeighted,
      allOutputWeighted: s.allOutputWeighted,
      rawActualTokens: s.rawActualTokens,
      rawBaselineTokens: s.rawBaselineTokens,
      rawOutputTokens: s.rawOutputTokens,
    });
  }

  serveStats(): Response {
    // Two headline numbers, derived from the same per-event accumulators:
    //
    //   saved_pct_input_only = Σ saved / Σ baseline_input_eff × 100
    //     What the proxy actually saved on the slice it can move (input).
    //     Numerator = input tokens we didn't pay for (cache-aware).
    //     Denominator = input tokens we WOULD have paid (cache-aware).
    //     Output is excluded because the proxy doesn't touch it.
    //
    //   saved_pct_of_total_bill = Σ saved / Σ (baseline_input + output × 5) × 100
    //     What share of the TOTAL bill the proxy saved. Honest counter to the
    //     input-only number: on output-heavy sessions (long thinking blocks,
    //     big edits) the percentage shrinks because output dominates.
    //
    //   token_equivalent_total = Σ (actual_input + output × 5)
    //     What Anthropic's weekly limit actually meters — input × 1.0 +
    //     output × 5.0 (the same ratio as the per-MTok price card). This is
    //     the number that moves your "%% used this week" indicator.
    const totals = this.enabledTotals();
    const baseline = totals.baselineInputWeighted;
    const actual = totals.actualInputWeighted;
    const output = totals.outputWeighted; // already × OUTPUT_TOKEN_RATE
    const saved = baseline - actual;
    const pricedBaseline = totals.pricedBaselineInputWeighted;
    const pricedActual = totals.pricedActualInputWeighted;
    const pricedOutput = totals.pricedOutputWeighted;
    const pricedSaved = pricedBaseline - pricedActual;
    const pctInput = baseline > 0 ? (saved / baseline) * 100 : 0;
    const baselineTotal = baseline + output;
    const actualTotal = actual + output;
    const pricedBaselineTotal = pricedBaseline + pricedOutput;
    const pctTotal = pricedBaselineTotal > 0 ? (pricedSaved / pricedBaselineTotal) * 100 : 0;

    // Share-of-all-spend: honest denominator. The numerator can only credit
    // savings against rows where we have a probe baseline (otherwise it's
    // estimation), but the denominator MUST include every request the user
    // actually paid for — including passthrough rows, probe-failed rows,
    // and untransformed turns the gate said no to. Otherwise the headline
    // answers "did inkling help on the rows where it ran" instead of
    // "did inkling move my real bill". The first is a cherry-pick.
    const allBaselineEquiv = totals.allBaselineEquivalentWeighted;
    const allActual = totals.allActualInputWeighted;
    const allOutput = totals.allOutputWeighted;
    // Denominator = counterfactual all-rows bill: what the user would have
    // paid with no inkling. Bounded ratio at 100%; a single cold-miss
    // compressed request on an otherwise empty session shows ~99% saved,
    // not 280%.
    const allCounterfactualBill = allBaselineEquiv + allOutput;
    const pctAllSpend =
      allCounterfactualBill > 0 ? (pricedSaved / allCounterfactualBill) * 100 : 0;

    // Direct observed split — actual $ per request, partitioned by which
    // path ran. Token-equivalent (input × 1.0 + cache_create × 1.25 +
    // cache_read × 0.10 + output × 5) → $ at the assumed Opus 4.7 input
    // rate. Same $/Mtok rate is applied to both buckets, so the bias from
    // the rate assumption cancels in the delta. Selection bias from the
    // gate is NOT cancelled — the operator interprets that via the
    // sample-count caveat below.
    const compressedTokenEquiv =
      totals.compressedActualInputWeighted +
      totals.compressedOutputWeighted;
    const passthroughTokenEquiv =
      totals.passthroughActualInputWeighted +
      totals.passthroughOutputWeighted;
    const compressedActualUsd = priceMode() === 'kosha'
      ? totals.compressedActualUsdKosha
      : (compressedTokenEquiv * ASSUMED_INPUT_USD_PER_MTOK) / 1e6;
    const passthroughActualUsd = priceMode() === 'kosha'
      ? totals.passthroughActualUsdKosha
      : (passthroughTokenEquiv * ASSUMED_INPUT_USD_PER_MTOK) / 1e6;
    const compressedAvgUsd =
      totals.compressedPaidRequests > 0
        ? compressedActualUsd / totals.compressedPaidRequests
        : 0;
    const passthroughAvgUsd =
      totals.passthroughPaidRequests > 0
        ? passthroughActualUsd / totals.passthroughPaidRequests
        : 0;
    // Sufficient-sample threshold is a soft heuristic. 20 paid requests per
    // bucket is enough to see a real effect on Opus 4.7 traffic (a single
    // big cold-miss can dominate at lower n). Below this, the UI shows the
    // bucket numbers but hides the delta and surfaces "small sample".
    const SUFFICIENT = 20;
    const splitSufficient =
      totals.compressedPaidRequests >= SUFFICIENT &&
      totals.passthroughPaidRequests >= SUFFICIENT;
    const splitDeltaUsd = compressedAvgUsd - passthroughAvgUsd;

    const nowMs = Date.now();
    const todayDate = new Date(nowMs);
    const todayKey = localDateKey(nowMs);
    const daily: DailySavingsPoint[] = [];
    for (let offset = DAILY_CHART_DAYS - 1; offset >= 0; offset--) {
      const d = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() - offset);
      const dateKey = localDateKey(d.getTime());
      const byModelMap = this.dailyByDateModel.get(dateKey);
      const sum = emptyDailyBucket();
      if (byModelMap) {
        for (const [model, b] of byModelMap) {
          if (!isFicheSupportedModel(model) && b.textHygieneSavedTokens <= 0) {
            continue;
          }
          sum.requests += b.requests;
          sum.compressed += b.compressed;
          sum.imaged += b.imaged;
          sum.textCompressed += b.textCompressed;
          sum.baselineInputWeighted += b.baselineInputWeighted;
          sum.actualInputWeighted += b.actualInputWeighted;
          sum.rawSavedTokens += b.rawSavedTokens;
          sum.pricedBaselineInputWeighted += b.pricedBaselineInputWeighted;
          sum.pricedActualInputWeighted += b.pricedActualInputWeighted;
          sum.pricedSavedUsd += b.pricedSavedUsd;
          sum.cliffSavedUsd += b.cliffSavedUsd;
        }
      }
      const daySaved = sum.baselineInputWeighted - sum.actualInputWeighted;
      const dayPricedSaved = sum.pricedBaselineInputWeighted - sum.pricedActualInputWeighted;
      const dayUsd = priceMode() === 'kosha'
        ? sum.pricedSavedUsd
        : (dayPricedSaved * ASSUMED_INPUT_USD_PER_MTOK) / 1e6;
      daily.push({
        date: dateKey,
        requests: sum.requests,
        compressed: sum.compressed,
        imaged: sum.imaged,
        text_compressed: sum.textCompressed,
        baseline_input_weighted: Math.round(sum.baselineInputWeighted),
        actual_input_weighted: Math.round(sum.actualInputWeighted),
        saved_tokens: Math.round(daySaved),
        raw_saved_tokens: Math.round(sum.rawSavedTokens),
        saved_pct: sum.baselineInputWeighted > 0 ? round1((daySaved / sum.baselineInputWeighted) * 100) : 0,
        saved_usd: round4(dayUsd),
        cliff_saved_usd: round4(sum.cliffSavedUsd),
        is_today: dateKey === todayKey,
      });
    }

    const uptimeSec = nowMs / 1000 - totals.startedAt;
    const payload = {
      requests: totals.requests,
      compressed_requests: totals.compressedRequests,
      imaged_requests: totals.imagedRequests,
      text_compressed_requests: totals.textCompressedRequests,
      baseline_input_weighted: Math.round(baseline),
      actual_input_weighted: Math.round(actual),
      saved_input_tokens: Math.round(saved),
      raw_saved_tokens: Math.round(totals.rawSavedTokens),
      // saved_pct kept for back-compat with existing dashboard HTML; it is
      // the input-only number. New code should read saved_pct_input_only.
      saved_pct: round1(pctInput),
      saved_pct_input_only: round1(pctInput),
      saved_pct_of_total_bill: round1(pctTotal),
      // Honest "share of total bill saved" — measured-rows numerator over
      // ALL paid requests in the denominator (compressed + passthrough +
      // probe-failed). This is the number users actually want when they
      // ask "is inkling helping". Negative when flap-pollution from
      // passthrough turns exceeds the collapse win on measured turns.
      saved_pct_of_all_spend: round1(pctAllSpend),
      all_baseline_equivalent_weighted: Math.round(allBaselineEquiv),
      all_actual_input_weighted: Math.round(allActual),
      all_output_weighted: Math.round(allOutput),
      all_usage_requests: totals.allUsageRequests,
      // Direct observed split — replaces "share of spend saved" as the
      // headline. Total actual $ and average $/req per path, plus a delta
      // gated on `split_sufficient_sample`. No counterfactual: each
      // bucket is what each path actually billed.
      compressed_paid_requests: totals.compressedPaidRequests,
      passthrough_paid_requests: totals.passthroughPaidRequests,
      compressed_actual_usd: round4(compressedActualUsd),
      passthrough_actual_usd: round4(passthroughActualUsd),
      compressed_avg_usd_per_request: round4(compressedAvgUsd),
      passthrough_avg_usd_per_request: round4(passthroughAvgUsd),
      compressed_minus_passthrough_avg_usd: round4(splitDeltaUsd),
      split_sufficient_sample: splitSufficient,
      split_min_sample_per_bucket: SUFFICIENT,
      // Legacy: every saved token at the assumed $10/MTok. Kosha: each row at
      // its own model's input price; unpriced rows are left out and counted.
      saved_usd: round4(priceMode() === 'kosha'
        ? totals.pricedSavedUsd
        : (pricedSaved * ASSUMED_INPUT_USD_PER_MTOK) / 1e6),
      output_weighted: Math.round(output),
      baseline_token_equivalent: Math.round(baselineTotal),
      actual_token_equivalent: Math.round(actualTotal),
      pricing_assumptions: {
        input_per_mtok: ASSUMED_INPUT_USD_PER_MTOK,
        output_multiplier: OUTPUT_TOKEN_RATE,
        cache_write_5m_multiplier: 1.25,
        cache_write_1h_multiplier: 2.0,
        cache_read_multiplier: 0.1,
        source: 'docs.anthropic.com/en/docs/about-claude/pricing (verified 2026-05-19)',
        price_mode: priceMode(),
        price_snapshot: PRICE_SNAPSHOT,
        usd_priced_requests: totals.usdPricedRequests,
        usd_unpriced_requests: totals.usdUnpricedRequests,
      },
      // Honest output measurement — char counts from the SSE/JSON scanner,
      // independent of Anthropic's `usage.output_tokens`. Surfaces the gap
      // the May-2026 weekly-meter audit hypothesized (redacted_thinking adds
      // billed tokens that we can't see). `events_with_measurement` lets the
      // operator weigh how representative the numbers are; when it's near
      // `requests`, the gap is real. When it's 0, the scanner never landed
      // (5xx-heavy session, no /v1/messages traffic).
      measured_text_chars: totals.textCharsMeasured,
      measured_thinking_chars: totals.thinkingCharsMeasured,
      measured_tool_use_chars: totals.toolUseCharsMeasured,
      measured_redacted_block_count: totals.redactedBlockCountMeasured,
      events_with_measurement: totals.eventsWithMeasurement,
      text_hygiene_saved_tokens: totals.textHygieneSavedTokens,
      text_hygiene_saved_chars: totals.textHygieneSavedChars,
      cliff_avoided_events: totals.cliffAvoidedEvents,
      cliff_saved_usd: round4(totals.cliffSavedUsd),
      uptime_sec: uptimeSec,
      compression_enabled: this.compressionEnabled,
      allowed_models: getAllowedModelBases(),
      by_model: (() => {
        const byModel: Record<string, ModelStatsPayload> = {};
        for (const [model, t] of this.totalsByModel) {
          const key = model || 'unknown';
          const baseline = Math.round(t.baselineInputWeighted);
          const actual = Math.round(t.actualInputWeighted);
          const savedTokens = Math.round(t.baselineInputWeighted - t.actualInputWeighted);
          const rawSaved = Math.round(t.rawSavedTokens);
          const savedUsd = round4(
            priceMode() === 'kosha'
              ? t.pricedSavedUsd
              : ((t.pricedBaselineInputWeighted - t.pricedActualInputWeighted) * ASSUMED_INPUT_USD_PER_MTOK) / 1e6,
          );
          const prev = byModel[key];
          if (prev) {
            const nextBaseline = prev.baseline_input_weighted + baseline;
            const nextSaved = prev.saved_tokens + savedTokens;
            byModel[key] = {
              requests: prev.requests + t.requests,
              compressed: prev.compressed + t.compressedRequests,
              imaged: prev.imaged + t.imagedRequests,
              text_compressed: prev.text_compressed + t.textCompressedRequests,
              baseline_input_weighted: nextBaseline,
              actual_input_weighted: prev.actual_input_weighted + actual,
              saved_tokens: nextSaved,
              raw_saved_tokens: prev.raw_saved_tokens + rawSaved,
              saved_pct: nextBaseline > 0 ? Math.round((nextSaved / nextBaseline) * 1000) / 10 : 0,
              saved_usd: round4(prev.saved_usd + savedUsd),
              cliff_avoided_events: prev.cliff_avoided_events + t.cliffAvoidedEvents,
              cliff_saved_usd: round4(prev.cliff_saved_usd + t.cliffSavedUsd),
            };
          } else {
            byModel[key] = {
              requests: t.requests,
              compressed: t.compressedRequests,
              imaged: t.imagedRequests,
              text_compressed: t.textCompressedRequests,
              baseline_input_weighted: baseline,
              actual_input_weighted: actual,
              saved_tokens: savedTokens,
              raw_saved_tokens: rawSaved,
              saved_pct: baseline > 0 ? Math.round((savedTokens / baseline) * 1000) / 10 : 0,
              saved_usd: savedUsd,
              cliff_avoided_events: t.cliffAvoidedEvents,
              cliff_saved_usd: round4(t.cliffSavedUsd),
            };
          }
        }
        return byModel;
      })(),
      today: daily[daily.length - 1],
      daily,
      // Rendered-page cache — a live process gauge, not a fold over the event
      // ring, so it is the one number here that survives no traffic at all.
      // `max_bytes` ships alongside `bytes` because utilisation is the actionable
      // reading: a hit rate near zero means something different when the budget is
      // full (working set too big) than when `oversized` is climbing (a single
      // render exceeds the whole budget and is never stored).
      render_cache: {
        ...renderCacheStats(),
        max_bytes: renderCacheMaxBytes(),
      },
    };
    return new Response(JSON.stringify(payload, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  }

  serveRecent(): Response {
    const latest = this.images[this.images.length - 1];
    const payload = {
      recent: this.recent,
      has_preview: latest !== undefined,
      preview_meta: latest?.meta ?? '',
      // Image ids currently resident in the ring. The dashboard uses this to
      // tell which RecentRow.img_id values still resolve — older ones have
      // been evicted and their "view" button should be disabled.
      image_ids: this.images.map((im) => im.id),
    };
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    });
  }

  /** GET /proxy-latest-png[?id=N] — raw PNG from the image ring. With no id
   *  (or an unknown id) the latest render is returned; ?id=N pulls that
   *  specific image while it's still in the ring. 404 once evicted. */
  servePng(id?: number): Response {
    // Cropping is done client-side via CSS (object-position + overflow:hidden).
    // Python decoded the PNG to crop server-side; we skip that to avoid
    // pulling a PNG decoder back in — the CSS approach renders identically.
    const entry =
      id !== undefined
        ? this.images.find((im) => im.id === id)
        : this.images[this.images.length - 1];
    if (!entry) {
      return new Response('no image yet', { status: 404 });
    }
    return new Response(entry.png as unknown as BodyInit, {
      headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
    });
  }

  /** GET /api/image-source[?id=N] — the source text the PNG was rendered
   *  from, so the operator can see the text → image conversion side by side.
   *  Falls back to the latest image; 404 if evicted or text wasn't captured. */
  serveImageSource(id?: number): Response {
    const entry =
      id !== undefined
        ? this.images.find((im) => im.id === id)
        : this.images[this.images.length - 1];
    if (!entry || entry.sourceText === undefined) {
      return new Response(JSON.stringify({ error: 'no source text' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ id: entry.id, meta: entry.meta, source_text: entry.sourceText }),
      { headers: { 'content-type': 'application/json' } },
    );
  }

  serveHtml(port: number): Response {
    return htmlResponse(renderPage(port, dashboardHostLabel()));
  }

  /** GET /fragments/<name> — server-rendered htmx fragments. Each one reuses
   *  the corresponding JSON endpoint's payload (via Response.json()) so the
   *  HTML and JSON surfaces can't drift apart. */
  async serveFragment(name: string, url: URL, port: number): Promise<Response> {
    switch (name) {
      case 'toggle':
        return htmlResponse(renderToggleFragment(this.compressionEnabled));
      case 'models':
        return htmlResponse(
          renderModelsFragment(
            getAllowedModelBases(),
            getConfiguredModelBases(),
            this.compressionEnabled,
          ),
        );
      case 'plugins': {
        const plugins = this.hooks.listPlugins
          ? this.hooks.listPlugins()
          : mergeStagePlugins([], this.pluginOverrides);
        return htmlResponse(renderPluginsFragment(plugins));
      }
      case 'context-map': {
        const reqParam = url.searchParams.get('req');
        if (reqParam) {
          // Explicit request: show ONLY that one. If its breakdown was evicted
          // or never recorded (no usage on that completion), say so — don't
          // silently fall back to the latest request's data under its label.
          const found = this.contextHistory.find((h) => h.id === Number(reqParam));
          return htmlResponse(renderContextMapFragment(found, this.contextHistory, !found));
        }
        // No specific request → default to the latest.
        return htmlResponse(
          renderContextMapFragment(this.contextHistory[this.contextHistory.length - 1], this.contextHistory),
        );
      }
      case 'session-summary': {
        // Lifetime hero — same cumulative payload as the header strip so the
        // headline and the "$ saved" tiles never disagree and it stops jumping.
        const s = (await this.serveStats().json()) as StatsPayload;
        return htmlResponse(renderSessionSummaryFragment(s));
      }
      case 'header': {
        const s = (await this.serveStats().json()) as StatsPayload;
        return htmlResponse(renderHeaderFragment(s, port));
      }
      case 'analytics': {
        const s = (await this.serveStats().json()) as StatsPayload;
        return htmlResponse(renderAnalyticsFragment(s));
      }
      case 'recent': {
        const r = (await this.serveRecent().json()) as RecentPayload;
        return htmlResponse(renderRecentFragment(r));
      }
      case 'latest': {
        const r = (await this.serveRecent().json()) as RecentPayload;
        const pinRaw = url.searchParams.get('pin');
        const pinNum = pinRaw != null && pinRaw !== '' ? Number(pinRaw) : NaN;
        const pin = Number.isFinite(pinNum) ? pinNum : null;
        const showSource = url.searchParams.get('source') === '1';
        let sourceText: string | null = null;
        if (showSource) {
          const entry =
            pin != null
              ? this.images.find((im) => im.id === pin)
              : this.images[this.images.length - 1];
          sourceText = entry?.sourceText ?? null;
        }
        return htmlResponse(renderLatestFragment({ payload: r, pin, showSource, sourceText }));
      }
      case 'sessions': {
        const res = await this.serveSessionsJson();
        if (!res.ok) return htmlResponse(`<div class="status">sessions unavailable</div>`);
        const p = (await res.json()) as SessionsPayload;
        return htmlResponse(renderSessionsFragment(p));
      }
      case 'stats': {
        const res = await this.serveApiStats();
        const p = (await res.json()) as FullStatsPayload;
        return htmlResponse(renderStatsTableFragment(p));
      }
      default:
        return new Response('unknown fragment', { status: 404 });
    }
  }

  // ---- session / cleanup endpoints --------------------------------------
  //
  // Every endpoint below recomputes from disk on demand. The dashboard polls
  // these on a 5s cadence, which is fine for a single-user dev tool — even at
  // ~3k events / 1.5 MB the round-trip is <100ms on a warm SSD.

  /** GET /api/sessions.json — grouped sessions enriched with the Claude Code
   *  cross-reference. The body is the top-level `sessions` array; the client
   *  renders a bar chart of the top savers. */
  async serveSessionsJson(opts: ListOptions = {}): Promise<Response> {
    if (!this.paths) return notConfigured('sessions');
    const [{ sessions }, ccMap] = await Promise.all([
      aggregateSessions(this.paths),
      this.ccMapFn(),
    ]);
    const rows = filterSessions(sessions, opts);
    const enriched = rows.map((s) => ({
      ...s,
      claudeCode: ccMap.get(s.id) ?? null,
    }));
    return jsonResponse({ sessions: enriched, count: enriched.length });
  }

  /** GET /api/stats.json — full-history aggregate. Migrated from the
   *  former `inkling stats` CLI. */
  async serveApiStats(): Promise<Response> {
    if (!this.paths) return notConfigured('stats');
    const result = await aggregateEventsFile(this.paths.eventsFile);
    if (!result) {
      return jsonResponse({
        error: 'no events file yet',
        path: this.paths.eventsFile,
      }, 404);
    }
    return jsonResponse({
      parsed: result.parsed,
      dropped: result.dropped,
      summary: summaryToJson(result.summary),
    });
  }

  /** GET /api/last-turn.json — latest turn & active session savings summary. */
  serveApiLastTurn(): Response {
    if (!this.paths) return notConfigured('last-turn');
    return jsonResponse(readTurnReport(this.paths.eventsFile));
  }

  /** GET /api/health — live daemon status & runtime metadata. */
  serveHealth(port = 47821): Response {
    return jsonResponse({
      ok: true,
      name: 'fiche',
      version: this.hooks.version ?? defaultDashboardVersion(),
      pid: process.pid,
      host: this.hooks.host ?? '127.0.0.1',
      port,
      uptime_sec: round1(Math.max(0, Date.now() / 1000 - this.startedAt)),
      compression_enabled: this.compressionEnabled,
      price_mode: priceMode(),
      allowed_models: getAllowedModelBases(),
      events_file: this.paths?.eventsFile ?? null,
    });
  }

  /** GET /api/compression — inspect runtime kill switch. */
  serveCompression(): Response {
    return jsonResponse({ compression_enabled: this.compressionEnabled });
  }

  /** POST /api/compression — flip the runtime kill switch.
   *  Body: { enabled: boolean }. Returns the new state. In-memory only;
   *  restart resets to the default (on). */
  handleCompressionToggle(body: { enabled?: unknown }): Response {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
      return jsonResponse({ error: 'enabled must be a boolean' }, 400);
    }
    this.compressionEnabled = body.enabled;
    return jsonResponse({ compression_enabled: body.enabled });
  }

  /** GET /api/models — current allowed model bases. */
  serveModels(): Response {
    return jsonResponse({ models: getAllowedModelBases() });
  }

  /** POST /api/models — update runtime model scope (`{ model, on }` or `{ models: string[] }`). */
  handleModelsApiPost(body: unknown): Response {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'request body must be a JSON object' }, 400);
    }
    const obj = body as Record<string, unknown>;
    if ('models' in obj) {
      if (!Array.isArray(obj.models) || !obj.models.every((m) => typeof m === 'string')) {
        return jsonResponse({ error: 'models must be an array of strings' }, 400);
      }
      const cleaned = (obj.models as string[]).map((s) => s.trim()).filter(Boolean);
      this.applyModelBases(cleaned);
      return jsonResponse({ models: getAllowedModelBases() });
    }
    if (typeof obj.model === 'string' && obj.model.trim().length > 0 && typeof obj.on === 'boolean') {
      this.handleModelsToggle(obj.model.trim(), obj.on);
      return jsonResponse({ models: getAllowedModelBases() });
    }
    return jsonResponse(
      { error: 'body must specify { model: string, on: boolean } or { models: string[] }' },
      400,
    );
  }

  /** GET /api/plugins — list built-in pipeline stages, custom plugins, and discovered skills. */
  servePlugins(): Response {
    const plugins = this.hooks.listPlugins
      ? this.hooks.listPlugins()
      : mergeStagePlugins([], this.pluginOverrides);
    return jsonResponse({ plugins });
  }

  /** POST /api/plugins — toggle one plugin/skill (`{ id, enabled }`) or all 3rd-party extensions (`{ scope: 'third-party', enabled }`). */
  handlePluginsApiPost(body: unknown): Response {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse({ error: 'request body must be a JSON object' }, 400);
    }
    const obj = body as Record<string, unknown>;
    if (obj.scope === 'third-party') {
      if (typeof obj.enabled !== 'boolean') {
        return jsonResponse({ error: 'enabled must be a boolean' }, 400);
      }
      if (this.hooks.setThirdPartyPluginsEnabled) {
        return jsonResponse(this.hooks.setThirdPartyPluginsEnabled(obj.enabled));
      }
      const known = mergeStagePlugins([], this.pluginOverrides);
      let updatedCount = 0;
      for (const p of known) {
        if (!isThirdPartyPlugin(p)) continue;
        this.pluginOverrides[p.id] = obj.enabled;
        updatedCount += 1;
      }
      const plugins = mergeStagePlugins([], this.pluginOverrides);
      return jsonResponse({ updatedCount, enabled: obj.enabled, plugins });
    }
    if (typeof obj.id !== 'string' || !obj.id.trim() || typeof obj.enabled !== 'boolean') {
      return jsonResponse({ error: 'id must be a non-empty string and enabled must be a boolean' }, 400);
    }
    const id = obj.id.trim();
    const enabled = obj.enabled;
    if (this.hooks.setPluginEnabled) {
      const updated = this.hooks.setPluginEnabled(id, enabled);
      if (!updated) return jsonResponse({ error: `unknown plugin: ${id}` }, 404);
      return jsonResponse(updated);
    }
    const known = mergeStagePlugins([], this.pluginOverrides);
    if (!known.some((p) => p.id === id)) {
      return jsonResponse({ error: `unknown plugin: ${id}` }, 404);
    }
    this.pluginOverrides[id] = enabled;
    const plugins = mergeStagePlugins([], this.pluginOverrides);
    const plugin = plugins.find((p) => p.id === id)!;
    return jsonResponse({ plugin, plugins });
  }

  /** POST /api/shutdown — initiate graceful daemon shutdown. */
  handleShutdown(): Response {
    if (this.hooks.onShutdown) {
      setImmediate(() => this.hooks.onShutdown?.());
    }
    return jsonResponse({ shutting_down: true });
  }

  /** POST /fragments/models — add/remove ONE model (Claude or GPT) from the
   *  runtime compress scope. The model checks read this live. Persisted via
   *  the host's `persistModelBases` hook when provided (Node writes the
   *  config file); otherwise in-memory only and restart resets to the
   *  INKLING_MODELS env / built-in default. */
  handleModelsToggle(model: string, on: boolean): void {
    const next = new Set(getAllowedModelBases());
    if (on) next.add(model);
    else next.delete(model);
    this.applyModelBases([...next]);
  }

  /** POST /fragments/models with {list} — replace the WHOLE runtime compress
   *  scope from the INKLING_MODELS textbox. Same CSV shape as the env var;
   *  empty or off/false/0/no/none = compress nothing. Persistence as above. */
  handleModelsSet(csv: string): void {
    const trimmed = csv.trim();
    const bases =
      !trimmed || /^(0|false|no|off|none)$/i.test(trimmed)
        ? []
        : trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    this.applyModelBases(bases);
  }

  private applyModelBases(bases: string[]): void {
    setAllowedModelBases(bases);
    try {
      this.persistModelBases?.(bases);
    } catch {
      // Persistence is best-effort; the live flip already took effect.
    }
  }

  /** GET /favicon.svg, /favicon.ico, /apple-touch-icon*.png */
  serveFavicon(sub: 'svg' | 'empty', headOnly = false): Response {
    return serveFavicon(sub, headOnly);
  }
}

export function serveFavicon(sub: 'svg' | 'empty', headOnly = false): Response {
  if (sub === 'empty') {
    return new Response(null, { status: 204 });
  }
  return new Response(headOnly ? null : FICHE_ICON_SVG, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function notConfigured(what: string): Response {
  // The dashboard was constructed without SessionsPaths (e.g. a legacy host
  // that doesn't track to disk). Return 503 so the client can surface a
  // helpful error rather than failing silently.
  return jsonResponse(
    { error: `${what} unavailable: dashboard not configured with event paths` },
    503,
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Result of route-matching a dashboard URL. The legacy `kind` values
 *  (html/stats/recent/png) stay alongside the `/api/*` JSON endpoints. */
export type DashboardRoute =
  | { kind: 'html' }
  | { kind: 'favicon'; sub: 'svg' | 'empty' } // /favicon.svg, /favicon.ico, /apple-touch-icon*.png
  | { kind: 'stats' } // /proxy-stats — legacy live counter
  | { kind: 'recent' } // /proxy-recent — legacy ring buffer
  | { kind: 'png' } // /proxy-latest-png
  | { kind: 'api-sessions' } // /api/sessions.json
  | { kind: 'api-stats' } // /api/stats.json
  | { kind: 'api-last-turn' } // /api/last-turn.json
  | { kind: 'current-session' } // /api/current-session.json
  | { kind: 'api-health' } // /api/health
  | { kind: 'api-compression' } // /api/compression (GET/POST {enabled}) — runtime kill switch
  | { kind: 'api-models' } // /api/models (GET/POST) — runtime model scope control
  | { kind: 'api-plugins' } // /api/plugins (GET/POST) — pipeline stages & skills registry
  | { kind: 'api-shutdown' } // /api/shutdown (POST) — graceful daemon shutdown
  | { kind: 'api-image-source' } // /api/image-source[?id=N] — source text behind a rendered PNG
  | { kind: 'fragment'; name: string }; // /fragments/<name> — server-rendered htmx panels

/** Match dashboard paths (handle query strings on /proxy-latest-png). */
export function dashboardPath(pathname: string): DashboardRoute | null {
  if (pathname === '/' || pathname === '/dashboard') return { kind: 'html' };
  if (pathname === '/favicon.svg' || pathname === '/favicon.ico') return { kind: 'favicon', sub: 'svg' };
  if (pathname === '/apple-touch-icon.png' || pathname === '/apple-touch-icon-precomposed.png') {
    return { kind: 'favicon', sub: 'empty' };
  }
  if (pathname === '/proxy-stats') return { kind: 'stats' };
  if (pathname === '/proxy-recent') return { kind: 'recent' };
  if (pathname === '/proxy-latest-png') return { kind: 'png' };
  if (pathname === '/api/sessions.json') return { kind: 'api-sessions' };
  if (pathname === '/api/stats.json') return { kind: 'api-stats' };
  if (pathname === '/api/last-turn.json') return { kind: 'api-last-turn' };
  if (pathname === '/api/current-session.json') return { kind: 'current-session' };
  if (pathname === '/api/health') return { kind: 'api-health' };
  if (pathname === '/api/compression') return { kind: 'api-compression' };
  if (pathname === '/api/models') return { kind: 'api-models' };
  if (pathname === '/api/plugins') return { kind: 'api-plugins' };
  if (pathname === '/api/shutdown') return { kind: 'api-shutdown' };
  if (pathname === '/api/image-source') return { kind: 'api-image-source' };
  if (pathname.startsWith('/fragments/')) {
    return { kind: 'fragment', name: pathname.slice('/fragments/'.length) };
  }
  return null;
}

export function isDashboardMutation(route: DashboardRoute, method: string): boolean {
  return method === 'POST' && (
    route.kind === 'api-compression'
    || route.kind === 'api-models'
    || route.kind === 'api-plugins'
    || route.kind === 'api-shutdown'
    || (route.kind === 'fragment' && (route.name === 'toggle' || route.name === 'models' || route.name === 'plugins'))
  );
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: `method not allowed; use ${allow}` }), {
    status: 405,
    headers: { allow, 'content-type': 'application/json' },
  });
}

async function parseJsonRequestBody(
  readBody: () => Promise<string>,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  let raw: string;
  try {
    raw = await readBody();
  } catch {
    return { ok: false, response: jsonResponse({ error: 'bad request body' }, 400) };
  }
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (e) {
    return {
      ok: false,
      response: jsonResponse({ error: 'bad request body', detail: (e as Error).message }, 400),
    };
  }
}

/** Dispatch a matched DashboardRoute to its handler. Returns `405` on `/api/*`
 *  and `/proxy-*` method mismatches so non-GET calls never leak to upstream. */
export async function dispatchDashboard(
  dashboard: DashboardState,
  route: DashboardRoute,
  method: string,
  url: URL,
  port: number,
  readBody: () => Promise<string>,
): Promise<Response | undefined> {
  switch (route.kind) {
    case 'html':
      if (method !== 'GET') return undefined;
      return dashboard.serveHtml(port);
    case 'favicon':
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
      return dashboard.serveFavicon(route.sub, method === 'HEAD');
    case 'stats':
      if (method !== 'GET') return methodNotAllowed('GET');
      return dashboard.serveStats();
    case 'recent':
      if (method !== 'GET') return methodNotAllowed('GET');
      return dashboard.serveRecent();
    case 'png': {
      if (method !== 'GET') return methodNotAllowed('GET');
      const idRaw = url.searchParams.get('id');
      const idNum = idRaw != null ? Number(idRaw) : NaN;
      return dashboard.servePng(Number.isFinite(idNum) ? idNum : undefined);
    }
    case 'api-image-source': {
      if (method !== 'GET') return methodNotAllowed('GET');
      const idRaw = url.searchParams.get('id');
      const idNum = idRaw != null ? Number(idRaw) : NaN;
      return dashboard.serveImageSource(Number.isFinite(idNum) ? idNum : undefined);
    }
    case 'api-sessions':
      if (method !== 'GET') return methodNotAllowed('GET');
      return dashboard.serveSessionsJson({
        project: url.searchParams.get('project') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
      });
    case 'api-stats':
      if (method !== 'GET') return methodNotAllowed('GET');
      return dashboard.serveApiStats();
    case 'api-last-turn':
      if (method !== 'GET') return methodNotAllowed('GET');
      return dashboard.serveApiLastTurn();
    case 'current-session':
      if (method !== 'GET') return methodNotAllowed('GET');
      return dashboard.serveCurrentSessionJson();
    case 'api-health':
      if (method !== 'GET') return methodNotAllowed('GET');
      return dashboard.serveHealth(port);
    case 'api-compression': {
      if (method === 'GET') return dashboard.serveCompression();
      if (method !== 'POST') return methodNotAllowed('GET, POST');
      const parsed = await parseJsonRequestBody(readBody);
      if (!parsed.ok) return parsed.response;
      if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
        return jsonResponse({ error: 'enabled must be a boolean' }, 400);
      }
      return dashboard.handleCompressionToggle(parsed.value as { enabled?: unknown });
    }
    case 'api-models': {
      if (method === 'GET') return dashboard.serveModels();
      if (method !== 'POST') return methodNotAllowed('GET, POST');
      const parsed = await parseJsonRequestBody(readBody);
      if (!parsed.ok) return parsed.response;
      return dashboard.handleModelsApiPost(parsed.value);
    }
    case 'api-plugins': {
      if (method === 'GET') return dashboard.servePlugins();
      if (method !== 'POST') return methodNotAllowed('GET, POST');
      const parsed = await parseJsonRequestBody(readBody);
      if (!parsed.ok) return parsed.response;
      return dashboard.handlePluginsApiPost(parsed.value);
    }
    case 'api-shutdown':
      if (method !== 'POST') return methodNotAllowed('POST');
      return dashboard.handleShutdown();
    case 'fragment': {
      if (route.name === 'toggle' && method === 'POST') {
        let enabled = false;
        try {
          const raw = await readBody();
          try {
            enabled = (JSON.parse(raw) as { enabled?: unknown }).enabled === true;
          } catch {
            enabled = new URLSearchParams(raw).get('enabled') === 'true';
          }
        } catch {
          return new Response('bad request body', { status: 400 });
        }
        dashboard.handleCompressionToggle({ enabled });
        return dashboard.serveFragment('toggle', url, port);
      }
      if (route.name === 'models' && method === 'POST') {
        let model = '';
        let on = false;
        let list: string | null = null;
        try {
          const raw = await readBody();
          try {
            const j = JSON.parse(raw) as { model?: unknown; on?: unknown; list?: unknown };
            model = typeof j.model === 'string' ? j.model : '';
            on = j.on === true;
            if (typeof j.list === 'string') list = j.list;
          } catch {
            const p = new URLSearchParams(raw);
            model = p.get('model') ?? '';
            on = p.get('on') === 'true';
            list = p.get('list');
          }
        } catch {
          return new Response('bad request body', { status: 400 });
        }
        if (list !== null) dashboard.handleModelsSet(list);
        else if (model) dashboard.handleModelsToggle(model, on);
        return dashboard.serveFragment('models', url, port);
      }
      if (route.name === 'plugins' && method === 'POST') {
        let payload: unknown;
        try {
          const raw = await readBody();
          try {
            payload = JSON.parse(raw);
          } catch {
            const p = new URLSearchParams(raw);
            const scope = p.get('scope');
            const id = p.get('id');
            const enabledRaw = p.get('enabled');
            const enabled = enabledRaw === 'true' ? true : enabledRaw === 'false' ? false : undefined;
            payload = scope ? { scope, enabled } : { id, enabled };
          }
        } catch {
          return new Response('bad request body', { status: 400 });
        }
        const mutationRes = dashboard.handlePluginsApiPost(payload);
        if (!mutationRes.ok) return mutationRes;
        return dashboard.serveFragment('plugins', url, port);
      }
      if (method !== 'GET') return methodNotAllowed('GET');
      return dashboard.serveFragment(route.name, url, port);
    }
  }
}

/** Name of the machine serving this dashboard, shown in the title and topbar.
 *  INKLING_DASH_LABEL overrides it for hosts whose system hostname says nothing
 *  useful (containers, "localhost"); an explicitly empty label opts out and
 *  renders the unlabelled page. */
export function dashboardHostLabel(): string {
  const override = readBrandEnv('DASH_LABEL');
  if (override !== undefined) return override.trim();
  try {
    const h = os.hostname().trim();
    // Keep it short: FQDNs push the chip past the wordmark for no added meaning.
    return h.split('.')[0] || '';
  } catch {
    return '';
  }
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    },
  });
}
