/** Applicability helpers for fiche's production-safe model scope. */

import { readBrandEnv } from './env.js';
import { isMisresolvedModelId } from './gpt-model-profiles.js';

export type FicheApplicabilityReason =
  | 'eligible'
  | 'unsupported_model'
  | 'unsupported_method'
  | 'unsupported_path'
  | 'empty_body';

export interface FicheApplicabilityInput {
  readonly model?: string | null;
  readonly method?: string | null;
  readonly path?: string | null;
  readonly bodyBytes?: number | null;
}

/** @deprecated Use {@link FicheApplicabilityReason}. */
export type InklingApplicabilityReason = FicheApplicabilityReason;
/** @deprecated Use {@link FicheApplicabilityInput}. */
export type InklingApplicabilityInput = FicheApplicabilityInput;

/** Bracketed variant tags (e.g. `[1m]`) stripped before model matching so base and variant gate identically. */
const VARIANT_TAG = /\[[^\]]*\]/g;

function baseModelId(model: string): string {
  return model.replace(VARIANT_TAG, '');
}

/** Dashboard runtime override; null = fall back to INKLING_MODELS env / built-in default. In-memory only. */
let runtimeModelBases: readonly string[] | null = null;

/** Built-in default scope when INKLING_MODELS is unset: Fable 5 and Gemini.
 *  Opus 5.5 is not listed: it misreads dense glyphs (3/15 hex), so imaging it
 *  is not a saving. Gemini 4 hydrogen/carbon are in scope but stay text until
 *  measured (reader-tier.ts).
 *  Everything else is opt-in via dashboard chips or INKLING_MODELS:
 *  - Opus 4.7/4.8 — worse at reading imaged content (FINDINGS.md 2026-06-16:
 *    Opus 4.8 ~2pp arithmetic, 6/15 dense-hex vs Fable 100/100).
 *  - GPT 5.5 — degrades on imaged history/context.
 *  - GPT 5.6 Sol — 98/100 production arithmetic, but 79/93 completed gist,
 *    4/15 completed guard confabulations, and 0/15 dense hex.
 *  - Grok 4.5/4.6 — native 14px: 100/100 arithmetic, 97/98 gist, 17/18 state; hex 0/15.
 *  - Opus 5 — 2/15 exact recall on imaged context (DeepSWE v1.1 eval);
 *    task pass rate holds but dense recall does not.
 *  All remain available for explicit opt-in.
 *  Silently imaging weak or unvalidated readers is the wrong default. */
/** Model bases imaged with no configuration at all.
 *
 *  Exported so documentation can be checked against it instead of restating it.
 *  The README and this list disagreed once already: Opus 5 was dropped here after
 *  a measured recall regression and stayed in the README's stated default, so a
 *  reader following the docs believed a model was being imaged that was not. */
/*  `gemini` is a family base: the prefix match below covers `gemini-3.6-flash`,
 *  `gemini-4`, `gemini-pro`, ... so every Gemini id is on by default. Opting out
 *  is the ordinary path — drop `gemini` from INKLING_MODELS or click the chip off —
 *  which only works because the Google gate in proxy.ts/dashboard.ts consults
 *  this list and nothing else. */
export const DEFAULT_MODEL_BASES = ['claude-fable-5', 'gemini'];

function falsey(v: string): boolean {
  return /^(0|false|no|off|none)$/i.test(v.trim());
}

/** INKLING_MODELS env / built-in default, ignoring the runtime override. One CSV
 *  controls every family (Claude + GPT). Resolution (read per-call so scope flips LIVE):
 *  - unset or empty        → built-in default (Fable 5, Opus 5.5, every Gemini)
 *  - `off`/`0`/`false`/... → compress nothing
 *  - CSV of model bases    → exactly those families (e.g. `claude-fable-5,gpt-5.6-sol`) */
function envOrDefaultBases(): string[] {
  // Edge-safe: `process` is undefined off-Node; `readBrandEnv` handles FICHE_* / INKLING_*.
  const raw = readBrandEnv('MODELS');
  if (raw === undefined) return [...DEFAULT_MODEL_BASES];
  const trimmed = raw.trim();
  if (!trimmed) return [...DEFAULT_MODEL_BASES];
  if (falsey(trimmed)) return [];
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

function allowedModelBases(): string[] {
  if (runtimeModelBases !== null) return [...runtimeModelBases];
  return envOrDefaultBases();
}

/** Current effective allowed-model scope (Claude + GPT). */
export function getAllowedModelBases(): string[] {
  return allowedModelBases();
}

/** INKLING_MODELS env / default scope, independent of runtime override.
 *  Dashboard unions this into its chip set so env-enabled models are always shown as toggles. */
export function getConfiguredModelBases(): string[] {
  return envOrDefaultBases();
}

/** Set the dashboard runtime override. Empty array = compress nothing; null = clear override. Not persisted. */
export function setAllowedModelBases(list: readonly string[] | null): void {
  runtimeModelBases = list === null ? null : list.map((s) => s.trim()).filter(Boolean);
}

/** Gateways qualify ids with routing segments:
 *
 *    google/gemini-3.6-flash
 *    workers-ai/@cf/moonshotai/kimi-k3
 *
 *  The vendor picks the upstream, not the reader, so scope matching also
 *  compares the segment after the last slash. Otherwise INKLING_MODELS entries
 *  never match behind a gateway. */
function unqualifiedModelId(base: string): string | null {
  const slash = base.lastIndexOf('/');
  return slash >= 0 ? base.slice(slash + 1) : null;
}

/** True when `model` matches an entry in FICHE_MODELS / dashboard chips, ignoring visual profile guards. */
export function isInConfiguredModelBases(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const base = baseModelId(model).toLowerCase();
  const unqualified = unqualifiedModelId(base);
  return allowedModelBases().some((b) => {
    const target = b.toLowerCase();
    const hit = (id: string): boolean => id === target || id.startsWith(`${target}-`);
    return hit(base) || (unqualified !== null && hit(unqualified));
  });
}

/** Membership test against the single allowed scope. Matches exact base or `-suffix`
 *  alias; [variant] tags stripped first. */
function isAllowed(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const base = baseModelId(model).toLowerCase();
  // Never compress an id that would be priced with another provider's formula
  // (e.g. an unmeasured Gemini sibling falling through to the OpenAI fallback).
  // Which ids those are is profile-table knowledge, not a rule maintained here.
  if (isMisresolvedModelId(base)) return false;
  return isInConfiguredModelBases(base);
}

/** True when fiche may transform this Anthropic model. */
export function isFicheSupportedModel(model: string | null | undefined): boolean {
  return isAllowed(model);
}

/** True when fiche may transform this GPT model. Shares the single FICHE_MODELS scope. */
export function isFicheSupportedGptModel(model: string | null | undefined): boolean {
  return isAllowed(model);
}

/** @deprecated Use {@link isFicheSupportedModel}. */
export const isInklingSupportedModel = isFicheSupportedModel;

/** @deprecated Use {@link isFicheSupportedGptModel}. */
export const isInklingSupportedGptModel = isFicheSupportedGptModel;

/** Canonical set of Anthropic Messages routes inkling transforms. Shared with
 *  createProxy (src/core/proxy.ts) so the public applicability helper and the
 *  proxy router can never disagree on which paths are eligible — they did: the
 *  proxy accepts /anthropic/messages, but the helper's old `endsWith` check
 *  rejected it (and would have wrongly accepted /foo/v1/messages). Exact matches
 *  only, so /v1/messages/count_tokens stays unsupported. */
export function isAnthropicMessagesPath(pathname: string): boolean {
  return pathname === '/v1/messages'
    || pathname === '/anthropic/v1/messages'
    || pathname === '/anthropic/messages';
}

export function shouldTransformAnthropicMessages(
  input: FicheApplicabilityInput,
): { eligible: boolean; reason: FicheApplicabilityReason } {
  if (input.method !== undefined && input.method !== null && input.method.toUpperCase() !== 'POST') {
    return { eligible: false, reason: 'unsupported_method' };
  }
  if (input.path !== undefined && input.path !== null && !isAnthropicMessagesPath(input.path)) {
    return { eligible: false, reason: 'unsupported_path' };
  }
  if (input.bodyBytes !== undefined && input.bodyBytes !== null && input.bodyBytes <= 0) {
    return { eligible: false, reason: 'empty_body' };
  }
  if (!isInklingSupportedModel(input.model)) {
    return { eligible: false, reason: 'unsupported_model' };
  }
  return { eligible: true, reason: 'eligible' };
}
