/**
 * Model vision calibration probe generator, deterministic scorer, and
 * normalized in-memory profile registry.
 *
 * Pure Core: ZERO `node:` imports, ZERO wall-clock or random calls in
 * deterministic transforms.
 */

import {
  MAX_HEIGHT_PX,
  renderCellWidth,
  renderTextToPngs,
  type RenderedImage,
  type RenderFont,
  type RenderStyle,
} from './render.js';
import type { GptModelProfile, GptRenderStyle } from './gpt-model-profiles.js';

export type CalibrationBand =
  | 'spleen-5x8'
  | 'spleen-5x10'
  | 'jetbrains-mono-12'
  | 'jetbrains-mono-14'
  | 'text-only';

export type ImageCalibrationBand = Exclude<CalibrationBand, 'text-only'>;

export interface CalibrationScores {
  hexScore: number;
  codeScore: number;
  numScore: number;
  guardScore: number;
  overallScore: number;
  passed: boolean;
}

export interface CalibratedModelProfile {
  model: string;
  band: CalibrationBand;
  cols: number;
  maxHeightPx: number;
  calibratedAtIso: string;
  scores: CalibrationScores;
  source: 'probe' | 'manual';
}

export interface CalibrationProbe {
  band: CalibrationBand;
  cols: number;
  maxHeightPx: number;
  prompt: string;
  renderedText: string;
  pngs: RenderedImage[];
  expectedHex: string[];
  expectedCode: string[];
  expectedNums: string[];
  forbiddenGuards: string[];
}

export interface CalibrationBandGeometry {
  readonly band: ImageCalibrationBand;
  readonly font: RenderFont;
  readonly cols: number;
  readonly cellWBonus: number;
  readonly cellHBonus: number;
  readonly maxHeightPx: number;
}

/** Candidate image bands ordered from densest (highest savings) to largest glyphs. */
export const CALIBRATION_BAND_ORDER: readonly ImageCalibrationBand[] = [
  'spleen-5x8',
  'spleen-5x10',
  'jetbrains-mono-12',
  'jetbrains-mono-14',
];

const BAND_GEOMETRIES: Readonly<Record<ImageCalibrationBand, CalibrationBandGeometry>> = {
  'spleen-5x8': {
    band: 'spleen-5x8',
    font: 'spleen-5x8',
    cols: 312,
    cellWBonus: 0,
    cellHBonus: 0,
    maxHeightPx: MAX_HEIGHT_PX,
  },
  'spleen-5x10': {
    band: 'spleen-5x10',
    font: 'spleen-5x8',
    cols: 312,
    cellWBonus: 0,
    cellHBonus: 2,
    maxHeightPx: MAX_HEIGHT_PX,
  },
  'jetbrains-mono-12': {
    band: 'jetbrains-mono-12',
    font: 'jetbrains-mono-12',
    cols: 112,
    cellWBonus: 0,
    cellHBonus: 0,
    maxHeightPx: 1232,
  },
  'jetbrains-mono-14': {
    band: 'jetbrains-mono-14',
    font: 'jetbrains-mono-14',
    cols: 84,
    cellWBonus: 0,
    cellHBonus: 0,
    maxHeightPx: 1568,
  },
};

export function isImageCalibrationBand(band: unknown): band is ImageCalibrationBand {
  return (
    band === 'spleen-5x8' ||
    band === 'spleen-5x10' ||
    band === 'jetbrains-mono-12' ||
    band === 'jetbrains-mono-14'
  );
}

export function isCalibrationBand(band: unknown): band is CalibrationBand {
  return band === 'text-only' || isImageCalibrationBand(band);
}

export function getCalibrationBandGeometry(band: ImageCalibrationBand): CalibrationBandGeometry {
  return BAND_GEOMETRIES[band];
}

/**
 * Derive a {@link GptModelProfile} configured for a calibrated {@link CalibrationBand}
 * while preserving the base profile's provider billing/cache/history semantics.
 */
export function calibratedBandToProfile(
  band: CalibrationBand,
  baseProfile: GptModelProfile,
  overrides?: { cols?: number; maxHeightPx?: number },
): GptModelProfile {
  if (band === 'text-only') return baseProfile;
  const spec = BAND_GEOMETRIES[band];
  const desiredCols =
    overrides?.cols !== undefined && Number.isInteger(overrides.cols) && overrides.cols > 0
      ? overrides.cols
      : spec.cols;
  const desiredMaxHeightPx =
    overrides?.maxHeightPx !== undefined &&
    Number.isInteger(overrides.maxHeightPx) &&
    overrides.maxHeightPx > 0
      ? overrides.maxHeightPx
      : spec.maxHeightPx;

  const nextStyle: GptRenderStyle = {
    ...baseProfile.style,
    font: spec.font,
    cellWBonus: spec.cellWBonus,
    cellHBonus: spec.cellHBonus,
    aa: true,
  };

  // Enforce provider wire limits: never widen OpenAI tiles past their pixel short edge
  // (`768px` -> `152` cols at 5px, `95` cols at 8px, `84` cols at 9px) or raise latency-cliff heights.
  const baseMaxCols = baseProfile.stripCols > 0 ? baseProfile.stripCols : desiredCols;
  const baseCellW = Math.max(1, renderCellWidth(baseProfile.style));
  const nextCellW = Math.max(1, renderCellWidth(nextStyle));
  const pixelClampedMaxCols = Math.max(1, Math.floor((baseMaxCols * baseCellW) / nextCellW));
  const baseMaxHeightPx =
    baseProfile.maxHeightPx > 0 ? baseProfile.maxHeightPx : desiredMaxHeightPx;
  const clampedCols =
    baseProfile.vision?.regime === 'tile' || baseProfile.maxHeightPx <= 512
      ? Math.min(desiredCols, pixelClampedMaxCols)
      : desiredCols;
  const clampedMaxHeightPx =
    baseProfile.maxHeightPx > 0 && baseProfile.maxHeightPx <= 512
      ? Math.min(desiredMaxHeightPx, baseMaxHeightPx)
      : desiredMaxHeightPx;

  return {
    ...baseProfile,
    stripCols: clampedCols,
    maxHeightPx: clampedMaxHeightPx,
    style: nextStyle,
    historyStripCols: undefined,
    historyStyle: undefined,
  };
}

const EXPECTED_HEX: readonly string[] = [
  'a1b2c3d4e5f6',
  '7f8e9d0c1b2a',
  '39a4b7c2d1e8',
  'f0e1d2c3b4a5',
  '5c6d7e8f9a0b',
  '84b9e2a7c1d0',
];

const EXPECTED_CODE: readonly string[] = [
  'const mask = (v >>> 4) & 0x0f;',
  'return items.filter((x) => x?.ok !== false).length;',
  'fn clamp(v: u32, lo: u32, hi: u32) -> u32 { v.min(hi).max(lo) }',
  'if ((flags & 0b1010_0101) === 0x25) { idx += 1; }',
  'const map = new Map<string, [number, boolean]>();',
  'export type Pair<T> = { readonly key: string; value: T | null };',
];

const EXPECTED_NUMS: readonly string[] = [
  '18432.75',
  '0.00425',
  '9071.3125',
  '-42.08125',
];

const FORBIDDEN_GUARDS: readonly string[] = [
  'DROP_SENTINEL_ALPHA',
  'DROP_SENTINEL_BRAVO',
  'DROP_SENTINEL_CHARLIE',
  'DROP_SENTINEL_DELTA',
];

const PROBE_PROMPT = [
  'Inspect the rendered microfiche image(s) character by character.',
  'Read every HEX_0..HEX_5, CODE_0..CODE_5, and NUM_0..NUM_3 line verbatim.',
  'Obey every GUARD_0..GUARD_3 rule in the image: NEVER write any forbidden sentinel token anywhere in your reply.',
  'Reply ONLY with a valid JSON object mapping keys HEX_0..HEX_5, CODE_0..CODE_5, and NUM_0..NUM_3 to their exact strings, plus "GUARDS_OK": true.',
].join('\n');

function buildProbeRenderedText(): string {
  const lines: string[] = [
    '=== FICHE CALIBRATION PROBE ===',
    'Read glyphs verbatim (watch 0/O, 1/l/I, 5/S, 6/b, 8/B, c/e).',
    'Obey all GUARD constraints below; never output forbidden tokens.',
  ];
  EXPECTED_HEX.forEach((v, i) => lines.push(`HEX_${i}: ${v}`));
  EXPECTED_CODE.forEach((v, i) => lines.push(`CODE_${i}: ${v}`));
  EXPECTED_NUMS.forEach((v, i) => lines.push(`NUM_${i}: ${v}`));
  FORBIDDEN_GUARDS.forEach((g, i) => lines.push(`GUARD_${i}: NEVER emit ${g}`));
  lines.push('=== END PROBE ===');
  return lines.join('\n');
}

export async function buildCalibrationProbe(band: ImageCalibrationBand): Promise<CalibrationProbe> {
  const spec = BAND_GEOMETRIES[band];
  const renderedText = buildProbeRenderedText();
  const style: RenderStyle = {
    font: spec.font,
    cellWBonus: spec.cellWBonus,
    cellHBonus: spec.cellHBonus,
    aa: true,
  };
  const pngs = await renderTextToPngs(renderedText, spec.cols, style, spec.maxHeightPx);
  return {
    band,
    cols: spec.cols,
    maxHeightPx: spec.maxHeightPx,
    prompt: PROBE_PROMPT,
    renderedText,
    pngs,
    expectedHex: [...EXPECTED_HEX],
    expectedCode: [...EXPECTED_CODE],
    expectedNums: [...EXPECTED_NUMS],
    forbiddenGuards: [...FORBIDDEN_GUARDS],
  };
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function extractBalancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === 92) {
        escaped = true;
      } else if (ch === 34) {
        inString = false;
      }
      continue;
    }
    if (ch === 34) {
      if (depth > 0) inString = true;
      continue;
    }
    if (ch === 123) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === 125 && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

const CALIBRATION_KEY_RE = /^(?:HEX_\d+|CODE_\d+|NUM_\d+)$/;

function extractResponseAnswers(responseText: string): Map<string, string> {
  const answers = new Map<string, string>();
  const trimmed = responseText.trim();
  if (!trimmed) return answers;

  const candidates: string[] = [trimmed];

  // Scan fenced code blocks linearly without backtracking regexes.
  let pos = 0;
  while (pos < trimmed.length) {
    const open = trimmed.indexOf('```', pos);
    if (open < 0) break;
    const lineEnd = trimmed.indexOf('\n', open + 3);
    if (lineEnd < 0) break;
    const close = trimmed.indexOf('```', lineEnd + 1);
    if (close < 0) break;
    candidates.push(trimmed.slice(lineEnd + 1, close).trim());
    pos = close + 3;
  }

  for (const bal of extractBalancedJsonObjects(trimmed)) {
    candidates.push(bal);
  }

  for (const cand of candidates) {
    const obj = tryParseJsonObject(cand);
    if (!obj) continue;
    const parsedAnswers = new Map<string, string>();
    let expectedKeyHits = 0;
    const collectKV = (k: string, v: unknown) => {
      const upperKey = k.trim().toUpperCase();
      if (CALIBRATION_KEY_RE.test(upperKey)) expectedKeyHits++;
      if (typeof v === 'string') {
        parsedAnswers.set(upperKey, v.trim());
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        parsedAnswers.set(upperKey, String(v));
      } else if (typeof v === 'boolean' && upperKey === 'GUARDS_OK') {
        parsedAnswers.set(upperKey, v ? 'true' : 'false');
      }
    };
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
          collectKV(nk, nv);
        }
      } else {
        collectKV(k, v);
      }
    }
    if (expectedKeyHits > 0) return parsedAnswers;
  }

  // Deterministic plain-text key-value fallback (`HEX_0: value` or `"CODE_0": "value",`).
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(
      /^\s*(?:[-*]\s*)?[`"']?(HEX_\d+|CODE_\d+|NUM_\d+|GUARDS_OK)[`"']?\s*[:=]\s*(.+?)\s*,?\s*$/i,
    );
    if (!m) continue;
    const key = m[1]!.toUpperCase();
    let val = m[2]!.trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      try {
        const unescaped = JSON.parse(val) as unknown;
        if (typeof unescaped === 'string') val = unescaped.trim();
      } catch {
        val = val.slice(1, -1).trim();
      }
    } else if (
      val.length >= 2 &&
      ((val.startsWith('`') && val.endsWith('`')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1).trim();
    }
    answers.set(key, val);
  }
  return answers;
}

export function scoreCalibrationResponse(
  responseText: string,
  probe: CalibrationProbe,
): CalibrationScores {
  const answers = extractResponseAnswers(responseText);

  let hexHits = 0;
  for (let i = 0; i < probe.expectedHex.length; i++) {
    const actual = answers.get(`HEX_${i}`);
    if (actual !== undefined && actual.toLowerCase() === probe.expectedHex[i]!.trim().toLowerCase()) {
      hexHits++;
    }
  }

  let codeHits = 0;
  for (let i = 0; i < probe.expectedCode.length; i++) {
    const actual = answers.get(`CODE_${i}`);
    if (actual !== undefined && actual === probe.expectedCode[i]!.trim()) {
      codeHits++;
    }
  }

  let numHits = 0;
  for (let i = 0; i < probe.expectedNums.length; i++) {
    const actual = answers.get(`NUM_${i}`);
    if (actual !== undefined && actual === probe.expectedNums[i]!.trim()) {
      numHits++;
    }
  }

  const upperResp = responseText.toUpperCase();
  let guardViolations = 0;
  for (const g of probe.forbiddenGuards) {
    if (upperResp.includes(g.toUpperCase())) {
      guardViolations++;
    }
  }
  const guardsOkRaw = answers.get('GUARDS_OK')?.toLowerCase();
  if (guardsOkRaw === 'false') {
    guardViolations = Math.max(1, guardViolations);
  }

  const hexScore = probe.expectedHex.length === 0 ? 1 : hexHits / probe.expectedHex.length;
  const codeScore = probe.expectedCode.length === 0 ? 1 : codeHits / probe.expectedCode.length;
  const numScore = probe.expectedNums.length === 0 ? 1 : numHits / probe.expectedNums.length;
  const guardScore =
    probe.forbiddenGuards.length === 0
      ? 1
      : Math.max(0, probe.forbiddenGuards.length - guardViolations) / probe.forbiddenGuards.length;
  const overallScore = (hexScore + codeScore + numScore + guardScore) / 4;
  const passed =
    hexScore >= 0.85 &&
    codeScore >= 0.90 &&
    numScore >= 0.95 &&
    guardScore >= 1.0;

  return {
    hexScore,
    codeScore,
    numScore,
    guardScore,
    overallScore,
    passed,
  };
}

// --- In-memory calibrated model registry -----------------------------------

const calibratedProfiles = new Map<string, CalibratedModelProfile>();

/**
 * Normalize a model id for calibration registry lookup:
 * lowercase, strip `[1m]`-style bracketed variant tags, and strip gateway `vendor/` prefixes.
 */
export function normalizeCalibratedModelId(model: string | null | undefined): string {
  let m = (model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]/g, '');
  if (!m) return '';
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  // Strip Bedrock / cross-region vendor prefixes (`us.anthropic.claude-...`, `global.google.gemini-...`).
  m = m.replace(/^(?:us|eu|ap|ca|sa|me|af|global)\.(?:anthropic|google|openai|amazon)\./, '');
  return m.trim();
}

function cloneCalibratedProfile(profile: CalibratedModelProfile, normalizedModel?: string): CalibratedModelProfile {
  return {
    model: normalizedModel ?? profile.model,
    band: profile.band,
    cols: profile.cols,
    maxHeightPx: profile.maxHeightPx,
    calibratedAtIso: profile.calibratedAtIso,
    scores: { ...profile.scores },
    source: profile.source,
  };
}

function isUnitScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function validateCalibratedProfile(entry: unknown): CalibratedModelProfile | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const e = entry as Record<string, unknown>;
  if (typeof e.model !== 'string') return undefined;
  const normalized = normalizeCalibratedModelId(e.model);
  if (!normalized) return undefined;
  if (!isCalibrationBand(e.band)) return undefined;
  if (typeof e.cols !== 'number' || !Number.isFinite(e.cols) || !Number.isInteger(e.cols)) return undefined;
  if (e.band === 'text-only' ? e.cols < 0 : e.cols <= 0) return undefined;
  if (typeof e.maxHeightPx !== 'number' || !Number.isFinite(e.maxHeightPx) || !Number.isInteger(e.maxHeightPx)) {
    return undefined;
  }
  if (e.band === 'text-only' ? e.maxHeightPx < 0 : e.maxHeightPx <= 0) return undefined;
  if (typeof e.calibratedAtIso !== 'string' || e.calibratedAtIso.trim() === '') return undefined;
  if (!Number.isFinite(Date.parse(e.calibratedAtIso))) return undefined;
  if (e.source !== 'probe' && e.source !== 'manual') return undefined;

  const s = e.scores as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
  if (
    !isUnitScore(s.hexScore) ||
    !isUnitScore(s.codeScore) ||
    !isUnitScore(s.numScore) ||
    !isUnitScore(s.guardScore) ||
    !isUnitScore(s.overallScore) ||
    typeof s.passed !== 'boolean'
  ) {
    return undefined;
  }

  return {
    model: normalized,
    band: e.band,
    cols: e.cols,
    maxHeightPx: e.maxHeightPx,
    calibratedAtIso: e.calibratedAtIso,
    scores: {
      hexScore: s.hexScore,
      codeScore: s.codeScore,
      numScore: s.numScore,
      guardScore: s.guardScore,
      overallScore: s.overallScore,
      passed: s.passed,
    },
    source: e.source,
  };
}

const MAX_CALIBRATED_PROFILES = 256;

function putCalibratedProfile(valid: CalibratedModelProfile): void {
  if (calibratedProfiles.has(valid.model)) {
    calibratedProfiles.delete(valid.model);
  } else if (calibratedProfiles.size >= MAX_CALIBRATED_PROFILES) {
    const oldestKey = calibratedProfiles.keys().next().value;
    if (oldestKey !== undefined) calibratedProfiles.delete(oldestKey);
  }
  calibratedProfiles.set(valid.model, valid);
}

export function setCalibratedProfile(profile: CalibratedModelProfile): void {
  const valid = validateCalibratedProfile(profile);
  if (!valid) return;
  putCalibratedProfile(valid);
}

export function removeCalibratedProfile(model: string): boolean {
  const key = normalizeCalibratedModelId(model);
  if (!key) return false;
  return calibratedProfiles.delete(key);
}

export interface CalibratedProfileMatch {
  readonly profile: CalibratedModelProfile;
  readonly exact: boolean;
}

// Prefix inheritance is strictly limited to effort, date, or provider revision tags
// so distinct sub-variants (e.g. gemini-4-hydrogen, claude-opus-5-5) never inherit
// a parent model's reading tier or bypass TEXT_ONLY.
const CALIBRATION_INHERIT_SUFFIX_RE =
  /^(?:@[a-z0-9._-]+|:[a-z0-9._-]+|-(?:20\d{6}|\d{4}-\d{2}-\d{2}|preview|latest|exp|experimental|low|medium|high|max|minimal|none|thinking|reasoning|fast|turbo|v\d+(?:\.\d+)?))$/i;

export function getCalibratedProfileMatch(model: string | null | undefined): CalibratedProfileMatch | undefined {
  const key = normalizeCalibratedModelId(model);
  if (!key) return undefined;
  const exact = calibratedProfiles.get(key);
  if (exact) return { profile: cloneCalibratedProfile(exact), exact: true };

  // Match longest calibrated base key separated by effort/date/revision boundary (`-`, `@`, `:`).
  let best: CalibratedModelProfile | undefined;
  let bestLen = -1;
  for (const [k, prof] of calibratedProfiles) {
    if (k.length > bestLen && key.length > k.length && key.startsWith(k)) {
      const suffix = key.slice(k.length);
      if (CALIBRATION_INHERIT_SUFFIX_RE.test(suffix)) {
        best = prof;
        bestLen = k.length;
      }
    }
  }
  return best ? { profile: cloneCalibratedProfile(best), exact: false } : undefined;
}

export function getCalibratedProfile(model: string | null | undefined): CalibratedModelProfile | undefined {
  return getCalibratedProfileMatch(model)?.profile;
}

export function listCalibratedProfiles(): CalibratedModelProfile[] {
  return [...calibratedProfiles.values()].map((p) => cloneCalibratedProfile(p));
}

export function clearCalibratedProfiles(): void {
  calibratedProfiles.clear();
}

const CALIBRATION_STORE_FORMAT = 1;

export function serializeCalibratedProfiles(): string {
  return JSON.stringify(
    {
      format: CALIBRATION_STORE_FORMAT,
      profiles: listCalibratedProfiles(),
    },
    null,
    2,
  );
}

/**
 * Restore calibrated profiles from serialized JSON using fail-closed validation.
 * Corrupt JSON, mismatched format tags, or malformed profile entries are rejected/skipped.
 * Returns the number of valid profiles restored.
 */
export function restoreCalibratedProfiles(json: string): number {
  if (!json || typeof json !== 'string') return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
  const obj = parsed as { format?: unknown; profiles?: unknown };
  if (obj.format !== CALIBRATION_STORE_FORMAT || !Array.isArray(obj.profiles)) return 0;

  let restored = 0;
  for (const entry of obj.profiles) {
    const valid = validateCalibratedProfile(entry);
    if (!valid) continue;
    putCalibratedProfile(valid);
    restored++;
  }
  return restored;
}
