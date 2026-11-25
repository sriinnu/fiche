/**
 * Who may receive fiche images.
 *
 * Strong readers (measured on dense or 14px pages, see FINDINGS.md): Gemini,
 * Fable 5 including 5.1/5.2 at the spaced profile, and Sol 5.6 / 6.1 on the
 * native 14px profile. Everyone else (Claude 5.5, Grok, unmeasured ids) gets
 * its request as plain text. Images of glyphs a model cannot read are not a
 * saving.
 *
 * `FICHE_FORCE_IMAGES=1` (or `INKLING_FORCE_IMAGES=1`) overrides the tier. It does not override the Codex
 * breakpoint ban.
 */

import { readBrandEnv } from './env.js';
import { getCalibratedProfileMatch } from './calibration.js';
import { hasGeminiMeasuredProfile } from './gemini-model-profiles.js';

export type ReaderTier = 'image' | 'text';

const GEMINI_READER_RE = /(?:^|\/)gemini(?:-|$|\[)/;
const IMAGE_READER = [
  GEMINI_READER_RE,
  /claude-fable-5/,
  /gpt-(?:5\.6|6\.[12])-sol(?:-|$|\[)/,
];

export function forceImagesEnabled(): boolean {
  const v = readBrandEnv('FORCE_IMAGES') ?? '';
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function modelIds(model: string | null | undefined): string[] {
  const raw = (model ?? '').toLowerCase().replace(/\[[^\]]*\]/g, '');
  if (!raw) return [];
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? [raw, raw.slice(slash + 1)] : [raw];
}

/** Weak or unmeasured readers stay text even when a chip or INKLING_MODELS
 *  lists them. Other opt-in readers (Opus 5, Sol) still image once named. */
const TEXT_ONLY = [
  // Dash, dot or Vertex `@version` spellings: claude-opus-5-5, claude-opus-5.5,
  // claude-opus-5-5@20261001.
  /claude-(?:opus|sonnet|haiku)-5[-.]5(?:[-@.:]|$)/,
  /claude-haiku(?:[-@.:]|$)/,
  // grok-4.7, x-ai/grok-4.7, x-ai.grok-4.7.
  /(?:^|[/.])grok(?:-|$)/,
  // Gemini 4 hydrogen, carbon, and neon have no reading measurements yet; the
  // `gemini` image rule would otherwise give them argon's profile blind.
  /gemini-4-(?:hydrogen|carbon|neon)/,
  // GPT-6 Astra scored 2/15 hex and 26/98 gist on Spleen 5x8 (docs/BENCHMARKS.md);
  // keep it on 3-stage text hygiene by default unless INKLING_FORCE_IMAGES=1.
  /gpt-6(?:\.\d+)?-astra(?:-|$|\[)/,
  // Third-party text / unmeasured coding families routed directly via warp or /to/.
  // Prefix-safe text hygiene still compresses tool outputs for these without imaging.
  /deepseek/i,
  /kimi/i,
  /moonshot/i,
  /(?:^|[/._-])glm-/i,
  /minimax/i,
  /qwen/i,
  /(?:^|[/._-])(?:meta-)?llama/i,
  /codellama/i,
  /(?:^|[/._-])(?:mistral|mixtral|codestral|devstral|ministral|magistral|pixtral)/i,
  /(?:^|[/._-])command-/i,
  /(?:^|[/._-])c4ai-aya/i,
  /(?:^|[/._-])gemma(?:-|$)/i,
  /(?:^|[/._-])gpt-oss(?:-|$)/i,
  /(?:^|[/._-])sonar(?:-|$)/i,
  /(?:^|[/._-])nova(?:-|$)/i,
  /(?:^|[/._-])jamba(?:-|$)/i,
  /(?:^|[/._-])mercury(?:-|$)/i,
  /(?:^|[/._-])solar(?:-|$)/i,
  /(?:^|[/._-])step-\d/i,
];

export function prefersText(model: string | null | undefined, forceImages?: boolean): boolean {
  if (forceImages === true || (forceImages === undefined && forceImagesEnabled())) return false;
  const calMatch = getCalibratedProfileMatch(model);
  if (calMatch?.exact) {
    return !(calMatch.profile.scores.passed && calMatch.profile.band !== 'text-only');
  }
  const ids = modelIds(model);
  if (ids.some((id) => TEXT_ONLY.some((re) => re.test(id)))) return true;
  if (calMatch) {
    return !(calMatch.profile.scores.passed && calMatch.profile.band !== 'text-only');
  }
  return false;
}

export function readerTier(model: string | null | undefined, forceImages?: boolean): ReaderTier {
  if (forceImages === true || (forceImages === undefined && forceImagesEnabled())) return 'image';
  const calMatch = getCalibratedProfileMatch(model);
  if (calMatch?.exact) {
    return calMatch.profile.scores.passed && calMatch.profile.band !== 'text-only' ? 'image' : 'text';
  }
  const ids = modelIds(model);
  if (ids.length === 0) return 'text';
  if (ids.some((id) => TEXT_ONLY.some((re) => re.test(id)))) return 'text';
  if (calMatch) {
    return calMatch.profile.scores.passed && calMatch.profile.band !== 'text-only' ? 'image' : 'text';
  }
  if (ids.some((id) => GEMINI_READER_RE.test(id))) {
    return hasGeminiMeasuredProfile(model) ? 'image' : 'text';
  }
  return ids.some((id) => IMAGE_READER.some((re) => re.test(id))) ? 'image' : 'text';
}

/**
 * Imaging requires the model allowlist (`INKLING_MODELS` / default scope) AND
 * a reader that is not text-only. `INKLING_FORCE_IMAGES` lifts the text-only
 * veto. It does not add a model to the allowlist: Grok, Sonnet 5.5, and Haiku
 * stay text until they are also named in `INKLING_MODELS`.
 */
export function shouldImageModel(model: string | null | undefined, allowed: boolean, forceImages?: boolean): boolean {
  return allowed && !prefersText(model, forceImages);
}
