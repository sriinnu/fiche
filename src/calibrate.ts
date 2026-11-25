/**
 * CLI + atomic file persistence for `fiche calibrate`.
 *
 * Probes vision models across candidate microfiche rendering bands from densest
 * (`spleen-5x8`) to largest (`jetbrains-mono-14`), records the densest passing
 * band (or `text-only` fallback), and persists `~/.config/fiche/calibrated-models.json`
 * atomically with mode `0600`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CALIBRATION_BAND_ORDER,
  buildCalibrationProbe,
  getCalibratedProfile,
  isImageCalibrationBand,
  listCalibratedProfiles,
  normalizeCalibratedModelId,
  removeCalibratedProfile,
  restoreCalibratedProfiles,
  scoreCalibrationResponse,
  serializeCalibratedProfiles,
  setCalibratedProfile,
  type CalibratedModelProfile,
  type CalibrationBand,
  type CalibrationProbe,
  type CalibrationScores,
  type ImageCalibrationBand,
} from './core/calibration.js';
import { isGeminiModel, resolveGeminiProfile } from './core/gemini-model-profiles.js';
import { resolveGptProfile } from './core/gpt-model-profiles.js';
import { visionTokens } from './core/vision-cost.js';

export type CalibrationProvider = 'auto' | 'google' | 'anthropic' | 'openai';
export type ResolvedCalibrationProvider = Exclude<CalibrationProvider, 'auto'>;

export interface CalibrateCliDeps {
  readonly filePath?: string;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly now?: () => Date;
}

export interface CalibrationAttemptReport {
  readonly band: ImageCalibrationBand;
  readonly cols: number;
  readonly maxHeightPx: number;
  readonly scores: CalibrationScores;
}

export function defaultCalibratedProfilesPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FICHE_CALIBRATED_MODELS?.trim() || env.INKLING_CALIBRATED_MODELS?.trim();
  if (override) return override;
  return path.join(os.homedir(), '.config', 'fiche', 'calibrated-models.json');
}

const MAX_CALIBRATION_FILE_BYTES = 1024 * 1024;
let warnedCalibrationDirMode = false;

export function loadCalibratedProfilesFile(
  filePath: string = defaultCalibratedProfilesPath(),
): number {
  let fd: number | undefined;
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.size > MAX_CALIBRATION_FILE_BYTES) return 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const raw = fs.readFileSync(fd, 'utf8');
    return restoreCalibratedProfiles(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close failure */
      }
    }
  }
}

export function saveCalibratedProfilesFile(
  filePath: string = defaultCalibratedProfilesPath(),
): void {
  const dir = path.dirname(filePath);
  const parentExists = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!parentExists) {
    fs.chmodSync(dir, 0o700);
  } else if (!warnedCalibrationDirMode) {
    const dirMode = fs.statSync(dir).mode;
    if ((dirMode & 0o077) !== 0) {
      warnedCalibrationDirMode = true;
      console.warn(`[fiche] warning: calibration directory ${dir} has permissive mode ${(dirMode & 0o777).toString(8)}; chmod 700 recommended`);
    }
  }
  const nonce = crypto.randomBytes(6).toString('hex');
  const tmp = `${filePath}.${process.pid}.${nonce}.tmp`;
  const payload = `${serializeCalibratedProfiles()}\n`;
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, flags, 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close failure */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function resolveProvider(model: string, explicit: CalibrationProvider): ResolvedCalibrationProvider {
  if (explicit !== 'auto') return explicit;
  const lower = model.toLowerCase();
  if (lower.includes('gemini') || lower.startsWith('google/')) return 'google';
  if (lower.includes('claude') || lower.includes('anthropic')) return 'anthropic';
  return 'openai';
}

function resolveApiKey(
  provider: ResolvedCalibrationProvider,
  env: NodeJS.ProcessEnv,
): { key?: string; authKind?: 'api-key' | 'oauth-bearer'; envNames: readonly string[] } {
  switch (provider) {
    case 'google':
      return {
        key: env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || undefined,
        authKind: 'api-key',
        envNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      };
    case 'anthropic': {
      const apiKey = env.ANTHROPIC_API_KEY?.trim();
      if (apiKey) {
        return { key: apiKey, authKind: 'api-key', envNames: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] };
      }
      const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
      return {
        key: authToken || undefined,
        authKind: 'oauth-bearer',
        envNames: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
      };
    }
    case 'openai':
      return {
        key: env.OPENAI_API_KEY?.trim() || undefined,
        authKind: 'oauth-bearer',
        envNames: ['OPENAI_API_KEY'],
      };
  }
}

function stripProviderPrefix(model: string, _provider: ResolvedCalibrationProvider): string {
  let trimmed = model.trim().replace(/\[[^\]]*\]/g, '');
  const slash = trimmed.lastIndexOf('/');
  if (slash >= 0) trimmed = trimmed.slice(slash + 1);
  return trimmed.trim();
}

const CALIBRATION_FETCH_TIMEOUT_MS = 30_000;

async function sendProbeToProvider(
  provider: ResolvedCalibrationProvider,
  model: string,
  apiKey: string,
  authKind: 'api-key' | 'oauth-bearer',
  probe: CalibrationProbe,
  fetchImpl: typeof fetch,
): Promise<string> {
  const apiModel = stripProviderPrefix(model, provider);

  if (provider === 'google') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(apiModel)}:generateContent`;
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            ...probe.pngs.map((img) => ({
              inlineData: { mimeType: 'image/png', data: uint8ToBase64(img.png) },
            })),
            { text: probe.prompt },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    };
    const res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(CALIBRATION_FETCH_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Google API ${res.status}: ${text.slice(0, 240)}`);
    }
    const json = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('\n');
  }

  if (provider === 'anthropic') {
    const body = {
      model: apiModel,
      max_tokens: 1024,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            ...probe.pngs.map((img) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: uint8ToBase64(img.png),
              },
            })),
            { type: 'text', text: probe.prompt },
          ],
        },
      ],
    };
    const authHeaders: Record<string, string> =
      authKind === 'oauth-bearer'
        ? { authorization: `Bearer ${apiKey}` }
        : { 'x-api-key': apiKey };
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(CALIBRATION_FETCH_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 240)}`);
    }
    const json = JSON.parse(text) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    return (json.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n');
  }

  // OpenAI Chat Completions
  const gptProfile = resolveGptProfile(model);
  const imageDetail = gptProfile.imageDetail ?? 'high';
  const body = {
    model: apiModel,
    max_tokens: 1024,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          ...probe.pngs.map((img) => ({
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${uint8ToBase64(img.png)}`,
              detail: imageDetail,
            },
          })),
          { type: 'text', text: probe.prompt },
        ],
      },
    ],
  };
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(CALIBRATION_FETCH_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 240)}`);
  }
  const json = JSON.parse(text) as {
    choices?: Array<{
      message?: { content?: string | Array<{ type?: string; text?: string }> };
    }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}

function estimateProbeTokens(model: string, probe: CalibrationProbe): number {
  const profile = isGeminiModel(model)
    ? resolveGeminiProfile(model)
    : resolveGptProfile(model);
  let total = 0;
  for (const img of probe.pngs) {
    total += visionTokens(profile, img.width, img.height);
  }
  return total;
}

function buildPerfectFixtureJson(probe: CalibrationProbe): string {
  const payload: Record<string, string | boolean> = {};
  probe.expectedHex.forEach((v, i) => { payload[`HEX_${i}`] = v; });
  probe.expectedCode.forEach((v, i) => { payload[`CODE_${i}`] = v; });
  probe.expectedNums.forEach((v, i) => { payload[`NUM_${i}`] = v; });
  payload.GUARDS_OK = true;
  return JSON.stringify(payload);
}

interface ParsedCliArgs {
  help: boolean;
  list: boolean;
  dryRun: boolean;
  json: boolean;
  clearModel?: string;
  model?: string;
  provider: CalibrationProvider;
  band: 'auto' | ImageCalibrationBand;
  error?: string;
}

function parseCliArgs(rawArgv: readonly string[]): ParsedCliArgs {
  const argv = rawArgv[0] === 'calibrate' ? rawArgv.slice(1) : rawArgv;
  const out: ParsedCliArgs = {
    help: false,
    list: false,
    dryRun: false,
    json: false,
    provider: 'auto',
    band: 'auto',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--list') {
      out.list = true;
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--clear' || a.startsWith('--clear=')) {
      const val = a.startsWith('--clear=') ? a.slice('--clear='.length) : argv[++i];
      if (!val || val.startsWith('-')) {
        out.error = 'Missing model argument for --clear';
        return out;
      }
      out.clearModel = val;
    } else if (a === '--provider' || a.startsWith('--provider=')) {
      const val = (a.startsWith('--provider=') ? a.slice('--provider='.length) : argv[++i])?.toLowerCase();
      if (val !== 'auto' && val !== 'google' && val !== 'anthropic' && val !== 'openai') {
        out.error = `Invalid --provider: ${val ?? '(missing)'} (expected: auto|google|anthropic|openai)`;
        return out;
      }
      out.provider = val;
    } else if (a === '--band' || a.startsWith('--band=')) {
      const val = (a.startsWith('--band=') ? a.slice('--band='.length) : argv[++i])?.toLowerCase();
      if (val !== 'auto' && !isImageCalibrationBand(val)) {
        out.error = `Invalid --band: ${val ?? '(missing)'} (expected: auto|spleen-5x8|spleen-5x10|jetbrains-mono-12|jetbrains-mono-14)`;
        return out;
      }
      out.band = val;
    } else if (a.startsWith('-')) {
      out.error = `Unknown option: ${a}`;
      return out;
    } else if (!out.model) {
      out.model = a;
    } else {
      out.error = `Unexpected extra positional argument: ${a}`;
      return out;
    }
  }
  return out;
}

const USAGE_TEXT = [
  'Usage: fiche calibrate <model> [options]',
  '       fiche calibrate --list [--json]',
  '       fiche calibrate --clear <model> [--json]',
  '',
  'Options:',
  '  --provider <auto|google|anthropic|openai>   Upstream API format (default: auto)',
  '  --band <auto|spleen-5x8|spleen-5x10|jetbrains-mono-12|jetbrains-mono-14>',
  '                                              Band(s) to probe (default: auto)',
  '  --dry-run                                   Build probes & self-verify offline (no API call)',
  '  --list                                      Show calibrated models from disk',
  '  --clear <model>                             Remove a calibrated model entry',
  '  --json                                      Emit machine-readable JSON',
].join('\n');

function formatScorePct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export async function runCalibrationCli(
  argv: string[],
  deps: CalibrateCliDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const filePath = deps.filePath ?? defaultCalibratedProfilesPath(env);
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const parsed = parseCliArgs(argv);
  if (parsed.error) {
    stderr(`[fiche calibrate] ${parsed.error}`);
    return 2;
  }
  if (parsed.help) {
    stdout(USAGE_TEXT);
    return 0;
  }

  if (parsed.list) {
    loadCalibratedProfilesFile(filePath);
    const profiles = listCalibratedProfiles();
    if (parsed.json) {
      stdout(JSON.stringify({ file: filePath, profiles }, null, 2));
      return 0;
    }
    if (profiles.length === 0) {
      stdout(`No calibrated models stored (${filePath}).`);
      return 0;
    }
    stdout(`Calibrated models (${profiles.length}, ${filePath}):`);
    for (const p of profiles) {
      stdout(
        `  - ${p.model}  band=${p.band}  cols=${p.cols}  maxH=${p.maxHeightPx}` +
          `  overall=${formatScorePct(p.scores.overallScore)}  passed=${p.scores.passed}  (${p.source}, ${p.calibratedAtIso})`,
      );
    }
    return 0;
  }

  if (parsed.clearModel !== undefined) {
    loadCalibratedProfilesFile(filePath);
    const normalized = normalizeCalibratedModelId(parsed.clearModel);
    const removed = removeCalibratedProfile(parsed.clearModel);
    if (removed) {
      try {
        saveCalibratedProfilesFile(filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (parsed.json) {
          stdout(JSON.stringify({ ok: false, error: msg, model: normalized, file: filePath }, null, 2));
        } else {
          stderr(`[fiche calibrate] failed to save ${filePath}: ${msg}`);
        }
        return 1;
      }
    }
    if (parsed.json) {
      stdout(JSON.stringify({ ok: true, model: normalized, removed, file: filePath }, null, 2));
      return 0;
    }
    stdout(
      removed
        ? `[fiche calibrate] removed ${normalized} from ${filePath}`
        : `[fiche calibrate] ${normalized || parsed.clearModel} was not calibrated`,
    );
    return 0;
  }

  if (!parsed.model) {
    stderr('[fiche calibrate] missing <model> (or pass --list / --clear <model>)');
    return 2;
  }

  const normalizedModel = normalizeCalibratedModelId(parsed.model);
  if (!normalizedModel) {
    stderr('[fiche calibrate] invalid model identifier');
    return 2;
  }

  const provider = resolveProvider(parsed.model, parsed.provider);
  const bandsToTest: readonly ImageCalibrationBand[] =
    parsed.band === 'auto' ? CALIBRATION_BAND_ORDER : [parsed.band];

  if (parsed.dryRun) {
    loadCalibratedProfilesFile(filePath);
    const bandReports = [];
    for (const band of bandsToTest) {
      const probe = await buildCalibrationProbe(band);
      const perfect = scoreCalibrationResponse(buildPerfectFixtureJson(probe), probe);
      const guardFailText = JSON.stringify({
        ...JSON.parse(buildPerfectFixtureJson(probe)),
        LEAK: probe.forbiddenGuards[0],
      });
      const guardFail = scoreCalibrationResponse(guardFailText, probe);
      const selfVerified = perfect.passed && perfect.overallScore === 1 && !guardFail.passed && guardFail.guardScore < 1;
      bandReports.push({
        band,
        cols: probe.cols,
        maxHeightPx: probe.maxHeightPx,
        pages: probe.pngs.length,
        dimensions: probe.pngs.map((img) => ({
          width: img.width,
          height: img.height,
          bytes: img.png.byteLength,
          droppedChars: img.droppedChars,
        })),
        estimatedImageTokens: estimateProbeTokens(parsed.model, probe),
        selfVerified,
      });
    }

    if (parsed.json) {
      stdout(
        JSON.stringify(
          {
            dryRun: true,
            model: normalizedModel,
            provider,
            bands: bandReports,
            existing: getCalibratedProfile(parsed.model) ?? null,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    stdout(`[fiche calibrate --dry-run] model=${normalizedModel} provider=${provider}`);
    for (const b of bandReports) {
      const dims = b.dimensions.map((d) => `${d.width}x${d.height} (${d.bytes} B, dropped=${d.droppedChars})`).join(', ');
      stdout(
        `  • ${b.band.padEnd(18)} cols=${b.cols} maxH=${b.maxHeightPx} pages=${b.pages} ` +
          `dims=[${dims}] estTokens=${b.estimatedImageTokens} selfCheck=${b.selfVerified ? 'ok' : 'FAIL'}`,
      );
    }
    return 0;
  }

  const { key: apiKey, authKind = 'api-key', envNames } = resolveApiKey(provider, env);
  if (!apiKey) {
    const msg = `Missing API key for provider "${provider}" (checked: ${envNames.join(', ')})`;
    if (parsed.json) {
      stdout(JSON.stringify({ ok: false, error: msg, provider, model: normalizedModel }, null, 2));
    } else {
      stderr(`[fiche calibrate] ${msg}`);
    }
    return 1;
  }

  const attempts: CalibrationAttemptReport[] = [];
  let winner: CalibrationAttemptReport | undefined;

  try {
    for (const band of bandsToTest) {
      const probe = await buildCalibrationProbe(band);
      const reply = await sendProbeToProvider(
        provider,
        parsed.model,
        apiKey,
        authKind,
        probe,
        fetchImpl,
      );
      const scores = scoreCalibrationResponse(reply, probe);
      const attempt: CalibrationAttemptReport = {
        band,
        cols: probe.cols,
        maxHeightPx: probe.maxHeightPx,
        scores,
      };
      attempts.push(attempt);
      if (scores.passed) {
        winner = attempt;
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      stdout(JSON.stringify({ ok: false, error: msg, provider, model: normalizedModel, attempts }, null, 2));
    } else {
      stderr(`[fiche calibrate] probe failed: ${msg}`);
    }
    return 1;
  }

  const bestFail = attempts.reduce<CalibrationAttemptReport | undefined>(
    (best, cur) => (!best || cur.scores.overallScore > best.scores.overallScore ? cur : best),
    undefined,
  );

  const finalBand: CalibrationBand = winner ? winner.band : 'text-only';
  const finalScores: CalibrationScores = winner
    ? winner.scores
    : {
        ...(bestFail?.scores ?? {
          hexScore: 0,
          codeScore: 0,
          numScore: 0,
          guardScore: 0,
          overallScore: 0,
          passed: false,
        }),
        passed: false,
      };

  const profile: CalibratedModelProfile = {
    model: normalizedModel,
    band: finalBand,
    cols: winner ? winner.cols : 0,
    maxHeightPx: winner ? winner.maxHeightPx : 0,
    calibratedAtIso: now().toISOString(),
    scores: finalScores,
    source: 'probe',
  };

  // Reload right before persisting to reduce read-modify-write races across concurrent runs.
  loadCalibratedProfilesFile(filePath);
  setCalibratedProfile(profile);
  try {
    saveCalibratedProfilesFile(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      stdout(JSON.stringify({ ok: false, error: msg, provider, model: normalizedModel, file: filePath }, null, 2));
    } else {
      stderr(`[fiche calibrate] failed to save ${filePath}: ${msg}`);
    }
    return 1;
  }

  if (parsed.json) {
    stdout(JSON.stringify({ ok: true, provider, model: normalizedModel, file: filePath, profile, attempts }, null, 2));
    return 0;
  }

  stdout(`[fiche calibrate] model=${normalizedModel} provider=${provider} -> ${profile.band} (${profile.scores.passed ? 'PASSED' : 'TEXT-ONLY FALLBACK'})`);
  for (const a of attempts) {
    stdout(
      `  • ${a.band.padEnd(18)} hex=${formatScorePct(a.scores.hexScore)} code=${formatScorePct(a.scores.codeScore)} ` +
        `num=${formatScorePct(a.scores.numScore)} guard=${formatScorePct(a.scores.guardScore)} ` +
        `overall=${formatScorePct(a.scores.overallScore)} ${a.scores.passed ? 'PASS' : 'FAIL'}`,
    );
  }
  stdout(`[fiche calibrate] saved to ${filePath}`);
  return 0;
}
