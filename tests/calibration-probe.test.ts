import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CALIBRATION_BAND_ORDER,
  buildCalibrationProbe,
  clearCalibratedProfiles,
  getCalibratedProfile,
  listCalibratedProfiles,
  normalizeCalibratedModelId,
  removeCalibratedProfile,
  restoreCalibratedProfiles,
  scoreCalibrationResponse,
  serializeCalibratedProfiles,
  setCalibratedProfile,
  type CalibratedModelProfile,
} from '../src/core/calibration.js';
import {
  calibratedBandToProfile,
  hasGeminiMeasuredProfile,
  resolveGeminiProfile,
} from '../src/core/gemini-model-profiles.js';
import {
  DEFAULT_GPT_PROFILE,
  calibratedBandToProfile as gptCalibratedBandToProfile,
  resolveGptProfile,
} from '../src/core/gpt-model-profiles.js';
import { prefersText, readerTier, shouldImageModel } from '../src/core/reader-tier.js';
import {
  loadCalibratedProfilesFile,
  runCalibrationCli,
  saveCalibratedProfilesFile,
} from '../src/calibrate.js';

const FIXED_ISO = '2026-11-23T20:00:00.000Z';

function makeTmpFile(name = 'calibrated-models.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-cal-test-'));
  return path.join(dir, name);
}

const tmpPathsToClean: string[] = [];

beforeEach(() => {
  clearCalibratedProfiles();
  delete process.env.FICHE_GPT_PROFILES;
  delete process.env.INKLING_GPT_PROFILES;
});

afterEach(() => {
  clearCalibratedProfiles();
  delete process.env.FICHE_GPT_PROFILES;
  delete process.env.INKLING_GPT_PROFILES;
  while (tmpPathsToClean.length > 0) {
    const p = tmpPathsToClean.pop()!;
    try {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
});

describe('calibration probes and deterministic scoring', () => {
  it('builds deterministic single-page PNG probes across all 4 image bands with zero dropped glyphs', async () => {
    const expectedSpecs = [
      { band: 'spleen-5x8' as const, cols: 312, width: 312 * 5 + 8, maxHeightPx: 728 },
      { band: 'spleen-5x10' as const, cols: 312, width: 312 * 5 + 8, maxHeightPx: 728 },
      { band: 'jetbrains-mono-12' as const, cols: 112, width: 112 * 8 + 8, maxHeightPx: 1232 },
      { band: 'jetbrains-mono-14' as const, cols: 84, width: 84 * 9 + 8, maxHeightPx: 1568 },
    ];

    let height5x8 = 0;
    let height5x10 = 0;

    for (const spec of expectedSpecs) {
      const probe = await buildCalibrationProbe(spec.band);
      expect(probe.band).toBe(spec.band);
      expect(probe.cols).toBe(spec.cols);
      expect(probe.maxHeightPx).toBe(spec.maxHeightPx);
      expect(probe.expectedHex).toHaveLength(6);
      expect(probe.expectedCode).toHaveLength(6);
      expect(probe.expectedNums).toHaveLength(4);
      expect(probe.forbiddenGuards).toHaveLength(4);
      expect(probe.pngs).toHaveLength(1);
      expect(probe.pngs[0]!.width).toBe(spec.width);
      expect(probe.pngs[0]!.height).toBeLessThanOrEqual(spec.maxHeightPx);
      expect(probe.pngs[0]!.droppedChars).toBe(0);

      for (const g of probe.forbiddenGuards) {
        expect(probe.prompt).not.toContain(g);
        expect(probe.renderedText).toContain(`NEVER emit ${g}`);
      }

      if (spec.band === 'spleen-5x8') height5x8 = probe.pngs[0]!.height;
      if (spec.band === 'spleen-5x10') height5x10 = probe.pngs[0]!.height;

      const probe2 = await buildCalibrationProbe(spec.band);
      expect(probe2.renderedText).toBe(probe.renderedText);
      expect(Buffer.from(probe2.pngs[0]!.png)).toEqual(Buffer.from(probe.pngs[0]!.png));
    }

    expect(height5x10).toBeGreaterThan(height5x8);
  });

  it('scores JSON, fenced JSON, numeric JSON values, and plain-text responses accurately', async () => {
    const probe = await buildCalibrationProbe('spleen-5x8');

    const perfectObj: Record<string, string | number | boolean> = { GUARDS_OK: true };
    probe.expectedHex.forEach((v, i) => { perfectObj[`HEX_${i}`] = v; });
    probe.expectedCode.forEach((v, i) => { perfectObj[`CODE_${i}`] = v; });
    probe.expectedNums.forEach((v, i) => { perfectObj[`NUM_${i}`] = Number(v); });

    const perfectScores = scoreCalibrationResponse(JSON.stringify(perfectObj), probe);
    expect(perfectScores).toEqual({
      hexScore: 1,
      codeScore: 1,
      numScore: 1,
      guardScore: 1,
      overallScore: 1,
      passed: true,
    });

    const fenced = `Here is the transcription:\n\`\`\`json\n${JSON.stringify(perfectObj, null, 2)}\n\`\`\`\nDone.`;
    expect(scoreCalibrationResponse(fenced, probe).passed).toBe(true);

    const plainText = [
      ...probe.expectedHex.map((v, i) => `HEX_${i}: ${v.toUpperCase()}`),
      ...probe.expectedCode.map((v, i) => `CODE_${i} = \`${v}\``),
      ...probe.expectedNums.map((v, i) => `- NUM_${i}: ${v}`),
    ].join('\n');
    expect(scoreCalibrationResponse(plainText, probe).passed).toBe(true);
  });

  it('fails closed on single-axis misses or forbidden guard emissions', async () => {
    const probe = await buildCalibrationProbe('jetbrains-mono-12');
    const baseObj: Record<string, string | boolean> = { GUARDS_OK: true };
    probe.expectedHex.forEach((v, i) => { baseObj[`HEX_${i}`] = v; });
    probe.expectedCode.forEach((v, i) => { baseObj[`CODE_${i}`] = v; });
    probe.expectedNums.forEach((v, i) => { baseObj[`NUM_${i}`] = v; });

    // 1 wrong hex char -> 5/6 = 0.8333 < 0.85
    const badHex = { ...baseObj, HEX_2: '39a4b7c2d1e9' };
    const hexRes = scoreCalibrationResponse(JSON.stringify(badHex), probe);
    expect(hexRes.hexScore).toBeCloseTo(5 / 6, 6);
    expect(hexRes.passed).toBe(false);

    // 1 wrong code punctuation -> 5/6 = 0.8333 < 0.90
    const badCode = { ...baseObj, CODE_0: 'const mask = (v >> 4) & 0x0f;' };
    const codeRes = scoreCalibrationResponse(JSON.stringify(badCode), probe);
    expect(codeRes.codeScore).toBeCloseTo(5 / 6, 6);
    expect(codeRes.passed).toBe(false);

    // 1 wrong decimal precision -> 3/4 = 0.75 < 0.95
    const badNum = { ...baseObj, NUM_1: '0.0042' };
    const numRes = scoreCalibrationResponse(JSON.stringify(badNum), probe);
    expect(numRes.numScore).toBe(0.75);
    expect(numRes.passed).toBe(false);

    // Forbidden guard emitted -> guardScore = 0.75 < 1.0
    const guardLeak = `${JSON.stringify(baseObj)}\nNote: ${probe.forbiddenGuards[0]!.toLowerCase()}`;
    const guardRes = scoreCalibrationResponse(guardLeak, probe);
    expect(guardRes.guardScore).toBe(0.75);
    expect(guardRes.passed).toBe(false);

    // Unparseable empty/garbage response
    const emptyRes = scoreCalibrationResponse('Sorry, I cannot read this image.', probe);
    expect(emptyRes.hexScore).toBe(0);
    expect(emptyRes.codeScore).toBe(0);
    expect(emptyRes.numScore).toBe(0);
    expect(emptyRes.guardScore).toBe(1);
    expect(emptyRes.passed).toBe(false);
  });
});

describe('calibrated registry, fail-closed restore, and profile/tier routing', () => {
  const passScores = {
    hexScore: 1,
    codeScore: 1,
    numScore: 1,
    guardScore: 1,
    overallScore: 1,
    passed: true,
  };

  it('normalizes model ids across case, [1m] tags, and multi-hop vendor prefixes', () => {
    expect(normalizeCalibratedModelId('Google/Gemini-4-Hydrogen[1m]')).toBe('gemini-4-hydrogen');
    expect(normalizeCalibratedModelId('openrouter/anthropic/Claude-Opus-5[1m]')).toBe('claude-opus-5');

    const profile: CalibratedModelProfile = {
      model: 'openrouter/google/Gemini-4-Hydrogen[1m]',
      band: 'jetbrains-mono-12',
      cols: 112,
      maxHeightPx: 1232,
      calibratedAtIso: FIXED_ISO,
      scores: passScores,
      source: 'probe',
    };
    setCalibratedProfile(profile);

    const fetched = getCalibratedProfile('GEMINI-4-HYDROGEN');
    expect(fetched).toMatchObject({
      model: 'gemini-4-hydrogen',
      band: 'jetbrains-mono-12',
      cols: 112,
      maxHeightPx: 1232,
    });
    // Returned value is a defensive clone.
    fetched!.scores.hexScore = 0;
    expect(getCalibratedProfile('google/gemini-4-hydrogen[1m]')?.scores.hexScore).toBe(1);

    expect(listCalibratedProfiles()).toHaveLength(1);
    expect(removeCalibratedProfile('google/gemini-4-hydrogen[1m]')).toBe(true);
    expect(removeCalibratedProfile('gemini-4-hydrogen')).toBe(false);
    expect(listCalibratedProfiles()).toHaveLength(0);
  });

  it('rejects corrupt or malformed entries fail-closed in restoreCalibratedProfiles', () => {
    expect(restoreCalibratedProfiles('not json')).toBe(0);
    expect(restoreCalibratedProfiles(JSON.stringify({ format: 2, profiles: [] }))).toBe(0);
    expect(restoreCalibratedProfiles(JSON.stringify({ format: 1, profiles: 'bad' }))).toBe(0);

    const mixed = JSON.stringify({
      format: 1,
      profiles: [
        null,
        { model: '', band: 'spleen-5x8', cols: 312, maxHeightPx: 728, calibratedAtIso: FIXED_ISO, scores: passScores, source: 'probe' },
        { model: 'bad-band', band: 'comic-sans', cols: 100, maxHeightPx: 728, calibratedAtIso: FIXED_ISO, scores: passScores, source: 'probe' },
        { model: 'bad-cols', band: 'spleen-5x8', cols: 0, maxHeightPx: 728, calibratedAtIso: FIXED_ISO, scores: passScores, source: 'probe' },
        { model: 'bad-date', band: 'spleen-5x8', cols: 312, maxHeightPx: 728, calibratedAtIso: 'not-a-date', scores: passScores, source: 'probe' },
        { model: 'bad-score', band: 'spleen-5x8', cols: 312, maxHeightPx: 728, calibratedAtIso: FIXED_ISO, scores: { ...passScores, hexScore: 1.5 }, source: 'probe' },
        { model: 'valid-model', band: 'spleen-5x10', cols: 312, maxHeightPx: 728, calibratedAtIso: FIXED_ISO, scores: passScores, source: 'manual' },
      ],
    });
    expect(restoreCalibratedProfiles(mixed)).toBe(1);
    expect(getCalibratedProfile('valid-model')?.band).toBe('spleen-5x10');

    const snapshot = serializeCalibratedProfiles();
    clearCalibratedProfiles();
    expect(listCalibratedProfiles()).toHaveLength(0);
    expect(restoreCalibratedProfiles(snapshot)).toBe(1);
    expect(getCalibratedProfile('valid-model')?.source).toBe('manual');
  });

  it('wires passing and text-only calibrations into reader-tier, gemini, and gpt profiles', () => {
    expect(prefersText('gemini-4-hydrogen', false)).toBe(true);
    expect(readerTier('gemini-4-hydrogen', false)).toBe('text');
    expect(hasGeminiMeasuredProfile('gemini-3.6-pro')).toBe(false);

    setCalibratedProfile({
      model: 'gemini-4-hydrogen',
      band: 'spleen-5x10',
      cols: 312,
      maxHeightPx: 728,
      calibratedAtIso: FIXED_ISO,
      scores: passScores,
      source: 'probe',
    });
    expect(prefersText('google/gemini-4-hydrogen[1m]', false)).toBe(false);
    expect(readerTier('google/gemini-4-hydrogen[1m]', false)).toBe('image');
    expect(shouldImageModel('gemini-4-hydrogen', true, false)).toBe(true);
    expect(resolveGeminiProfile('gemini-4-hydrogen').style.cellHBonus).toBe(2);

    setCalibratedProfile({
      model: 'gemini-3.6-pro',
      band: 'jetbrains-mono-12',
      cols: 112,
      maxHeightPx: 1232,
      calibratedAtIso: FIXED_ISO,
      scores: passScores,
      source: 'probe',
    });
    expect(hasGeminiMeasuredProfile('google/gemini-3.6-pro')).toBe(true);
    expect(readerTier('gemini-3.6-pro', false)).toBe('image');
    const gemPro = resolveGptProfile('google/gemini-3.6-pro');
    expect(gemPro.stripCols).toBe(112);
    expect(gemPro.maxHeightPx).toBe(1232);
    expect(gemPro.style.font).toBe('jetbrains-mono-12');
    expect(gemPro.vision.regime).toBe('flat');

    // Text-only calibration overrides normally image-enabled models (unless forceImages === true).
    setCalibratedProfile({
      model: 'claude-fable-5',
      band: 'text-only',
      cols: 0,
      maxHeightPx: 0,
      calibratedAtIso: FIXED_ISO,
      scores: { hexScore: 0.5, codeScore: 0.5, numScore: 0.5, guardScore: 1, overallScore: 0.625, passed: false },
      source: 'probe',
    });
    expect(prefersText('claude-fable-5', false)).toBe(true);
    expect(readerTier('claude-fable-5', false)).toBe('text');
    expect(prefersText('claude-fable-5', true)).toBe(false);
    expect(readerTier('claude-fable-5', true)).toBe('image');

    // Non-Gemini calibrated models keep family pricing/vision and apply band geometry cleanly.
    setCalibratedProfile({
      model: 'claude-opus-5',
      band: 'jetbrains-mono-14',
      cols: 84,
      maxHeightPx: 1568,
      calibratedAtIso: FIXED_ISO,
      scores: passScores,
      source: 'probe',
    });
    const opusProf = resolveGptProfile('anthropic/claude-opus-5');
    expect(opusProf.vision).toEqual({ regime: 'patch28' });
    expect(opusProf.stripCols).toBe(84);
    expect(opusProf.maxHeightPx).toBe(1568);
    expect(opusProf.style.font).toBe('jetbrains-mono-14');
    expect(opusProf.historyStyle).toBeUndefined();
    expect(opusProf.historyStripCols).toBeUndefined();

    // Generic fallback model (kimi-k3 -> DEFAULT_GPT_PROFILE tile regime) clamps jetbrains-mono-12
    // to 95 cols (8 + 95*8 = 768px tile short edge), while patch28/flat models keep 112 cols.
    setCalibratedProfile({
      model: 'kimi-k3',
      band: 'jetbrains-mono-12',
      cols: 112,
      maxHeightPx: 1232,
      calibratedAtIso: FIXED_ISO,
      scores: passScores,
      source: 'probe',
    });
    expect(resolveGptProfile('kimi-k3').stripCols).toBe(95);
    expect(resolveGptProfile('kimi-k3').style.font).toBe('jetbrains-mono-12');
    process.env.FICHE_GPT_PROFILES = JSON.stringify({ 'kimi-k3': { stripCols: 99 } });
    expect(resolveGptProfile('kimi-k3').stripCols).toBe(99);

    setCalibratedProfile({
      model: 'claude-opus-5',
      band: 'jetbrains-mono-12',
      cols: 112,
      maxHeightPx: 1232,
      calibratedAtIso: FIXED_ISO,
      scores: passScores,
      source: 'probe',
    });
    expect(resolveGptProfile('anthropic/claude-opus-5').stripCols).toBe(112);

    expect(calibratedBandToProfile('text-only', DEFAULT_GPT_PROFILE)).toBe(DEFAULT_GPT_PROFILE);
    expect(gptCalibratedBandToProfile('spleen-5x8', DEFAULT_GPT_PROFILE).stripCols).toBe(152);
    expect(
      gptCalibratedBandToProfile('spleen-5x8', {
        ...DEFAULT_GPT_PROFILE,
        vision: { regime: 'patch28' },
      }).stripCols,
    ).toBe(312);
  });
});

describe('calibrate CLI and atomic 0600 file persistence', () => {
  it('supports --dry-run offline without network calls or disk writes', async () => {
    const filePath = makeTmpFile();
    tmpPathsToClean.push(filePath);
    const lines: string[] = [];
    let fetchCalls = 0;

    const code = await runCalibrationCli(
      ['calibrate', 'gpt-6-astra', '--dry-run', '--json'],
      {
        filePath,
        stdout: (l) => lines.push(l),
        stderr: (l) => lines.push(l),
        fetchImpl: (async () => {
          fetchCalls++;
          throw new Error('unexpected network call');
        }) as typeof fetch,
      },
    );

    expect(code).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(fs.existsSync(filePath)).toBe(false);
    const out = JSON.parse(lines.join('\n')) as {
      dryRun: boolean;
      bands: Array<{ band: string; estimatedImageTokens: number; selfVerified: boolean; dimensions: Array<{ droppedChars: number }> }>;
    };
    expect(out.dryRun).toBe(true);
    expect(out.bands.map((b) => b.band)).toEqual([...CALIBRATION_BAND_ORDER]);
    for (const b of out.bands) {
      expect(b.selfVerified).toBe(true);
      expect(b.estimatedImageTokens).toBeGreaterThan(0);
      expect(b.dimensions[0]!.droppedChars).toBe(0);
    }
  });

  it('probes densest-first in --band auto, stops on first pass, persists atomically with 0600, and supports --list / --clear', async () => {
    const filePath = makeTmpFile();
    tmpPathsToClean.push(filePath);
    const probe = await buildCalibrationProbe('jetbrains-mono-12');
    const perfectPayload: Record<string, string | boolean> = { GUARDS_OK: true };
    probe.expectedHex.forEach((v, i) => { perfectPayload[`HEX_${i}`] = v; });
    probe.expectedCode.forEach((v, i) => { perfectPayload[`CODE_${i}`] = v; });
    probe.expectedNums.forEach((v, i) => { perfectPayload[`NUM_${i}`] = v; });

    let callCount = 0;
    const calledUrls: string[] = [];
    const stdoutLines: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      callCount++;
      calledUrls.push(String(input));
      // Fail spleen-5x8 (call 1) and spleen-5x10 (call 2); pass jetbrains-mono-12 (call 3).
      const replyText = callCount < 3 ? '{"HEX_0":"wrong"}' : JSON.stringify(perfectPayload);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: replyText }] } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const code = await runCalibrationCli(
      ['google/gemini-4-hydrogen', '--band', 'auto', '--json'],
      {
        filePath,
        env: { GEMINI_API_KEY: 'test-key' },
        fetchImpl: mockFetch,
        stdout: (l) => stdoutLines.push(l),
        now: () => new Date(FIXED_ISO),
      },
    );

    expect(code).toBe(0);
    expect(callCount).toBe(3);
    expect(calledUrls[0]).toContain('gemini-4-hydrogen:generateContent');
    const report = JSON.parse(stdoutLines.join('\n')) as {
      ok: boolean;
      profile: CalibratedModelProfile;
      attempts: Array<{ band: string; scores: { passed: boolean } }>;
    };
    expect(report.ok).toBe(true);
    expect(report.profile.band).toBe('jetbrains-mono-12');
    expect(report.profile.cols).toBe(112);
    expect(report.profile.scores.passed).toBe(true);
    expect(report.attempts.map((a) => a.band)).toEqual([
      'spleen-5x8',
      'spleen-5x10',
      'jetbrains-mono-12',
    ]);

    // Verify 0600 file permissions and clean reload after clearing memory.
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    clearCalibratedProfiles();
    expect(loadCalibratedProfilesFile(filePath)).toBe(1);
    expect(getCalibratedProfile('gemini-4-hydrogen')?.band).toBe('jetbrains-mono-12');

    // --list
    const listOut: string[] = [];
    expect(await runCalibrationCli(['--list', '--json'], { filePath, stdout: (l) => listOut.push(l) })).toBe(0);
    expect(JSON.parse(listOut.join('\n')).profiles).toHaveLength(1);

    // --clear
    const clearOut: string[] = [];
    expect(
      await runCalibrationCli(['--clear', 'gemini-4-hydrogen', '--json'], {
        filePath,
        stdout: (l) => clearOut.push(l),
      }),
    ).toBe(0);
    expect(JSON.parse(clearOut.join('\n')).removed).toBe(true);
    clearCalibratedProfiles();
    expect(loadCalibratedProfilesFile(filePath)).toBe(0);
  });

  it('falls back to text-only when all bands fail reading checks, and aborts cleanly on missing API key or HTTP error', async () => {
    const filePath = makeTmpFile();
    tmpPathsToClean.push(filePath);

    // Missing API key -> exit 1, no file written.
    const errLines: string[] = [];
    const missingKeyCode = await runCalibrationCli(['gpt-6-astra'], {
      filePath,
      env: {},
      stderr: (l) => errLines.push(l),
    });
    expect(missingKeyCode).toBe(1);
    expect(fs.existsSync(filePath)).toBe(false);

    // Upstream HTTP 401 -> exit 1, must NOT write bogus text-only calibration.
    const httpErrCode = await runCalibrationCli(['claude-opus-5'], {
      filePath,
      env: { ANTHROPIC_API_KEY: 'bad-key' },
      stderr: (l) => errLines.push(l),
      fetchImpl: (async () => new Response('unauthorized', { status: 401 })) as typeof fetch,
    });
    expect(httpErrCode).toBe(1);
    expect(fs.existsSync(filePath)).toBe(false);

    // All 4 bands fail reading checks -> persists text-only honestly.
    const failLines: string[] = [];
    const failAllCode = await runCalibrationCli(['gpt-6-astra', '--json'], {
      filePath,
      env: { OPENAI_API_KEY: 'sk-test' },
      stdout: (l) => failLines.push(l),
      now: () => new Date(FIXED_ISO),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"HEX_0":"bad"}' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    expect(failAllCode).toBe(0);
    const parsed = JSON.parse(failLines.join('\n')) as { profile: CalibratedModelProfile; attempts: unknown[] };
    expect(parsed.attempts).toHaveLength(4);
    expect(parsed.profile.band).toBe('text-only');
    expect(parsed.profile.scores.passed).toBe(false);
    expect(readerTier('gpt-6-astra', false)).toBe('text');

    // Also verify direct save helper permissions.
    saveCalibratedProfilesFile(filePath);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});
