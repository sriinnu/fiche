/**
 * Who may receive pxpipe images.
 *
 * Strong readers (measured by upstream on dense or 14px pages): Gemini, Fable 5
 * including 5.1/5.2 at the spaced profile, and Sol 5.6 / 6.1 on the native 14px
 * profile. Everyone else — Claude 5.5, Opus 5, Grok, unmeasured ids — defaults
 * to PAKT text. Images of glyphs those models cannot read are not a saving.
 *
 * `PXPIPE_FORCE_IMAGES=1` overrides the tier. It does not override the Codex
 * breakpoint ban.
 */

export type ReaderTier = 'image' | 'pakt-text';

const IMAGE_READER = [
  /(?:^|\/)gemini(?:-|$|\[)/,
  /claude-fable-5/,
  /gpt-(?:5\.6|6\.1)-sol(?:-|$|\[)/,
];

export function forceImagesEnabled(): boolean {
  const v = (typeof process !== 'undefined' ? process.env?.PXPIPE_FORCE_IMAGES : '') ?? '';
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function modelIds(model: string | null | undefined): string[] {
  const raw = (model ?? '').toLowerCase().replace(/\[[^\]]*\]/g, '');
  if (!raw) return [];
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? [raw, raw.slice(slash + 1)] : [raw];
}

/** Labels only. The cost check decides whether an allowlisted model is
 *  actually sent images. Claude 5.5 and Grok are not strong page readers;
 *  Haiku 4.x is not in this list (the 5.5 pattern already covers Haiku 5.5). */
const PAKT_ONLY = [
  /claude-(?:opus|sonnet|haiku)-5-5(?:-|$)/,
  /(?:^|\/)grok(?:-|$)/,
];

export function prefersPaktText(model: string | null | undefined, forceImages?: boolean): boolean {
  if (forceImages === true || (forceImages === undefined && forceImagesEnabled())) return false;
  const ids = modelIds(model);
  return ids.some((id) => PAKT_ONLY.some((re) => re.test(id)));
}

export function readerTier(model: string | null | undefined, forceImages?: boolean): ReaderTier {
  if (forceImages === true || (forceImages === undefined && forceImagesEnabled())) return 'image';
  const ids = modelIds(model);
  if (ids.length === 0) return 'pakt-text';
  if (ids.some((id) => PAKT_ONLY.some((re) => re.test(id)))) return 'pakt-text';
  return ids.some((id) => IMAGE_READER.some((re) => re.test(id))) ? 'image' : 'pakt-text';
}

/**
 * An allowlisted model is an image candidate. The caller prices that candidate
 * against raw text and cache-safe PAKT and sends the cheapest. `forceImages`
 * does not add a model that failed the allowlist: Grok and Sonnet stay out
 * until `PXPIPE_MODELS` names them.
 */
export function shouldImageModel(model: string | null | undefined, allowed: boolean, _forceImages?: boolean): boolean {
  void model;
  return allowed;
}
