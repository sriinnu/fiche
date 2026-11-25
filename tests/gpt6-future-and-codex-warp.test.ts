/**
 * Regression tests for GPT-6, 6.1, 6.2, and future GPT-6.x/7+ Sol & Astra support
 * plus Codex >= 0.172 managed-daemon bypass prevention in `fiche warp`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isFicheSupportedGptModel, setAllowedModelBases } from '../src/core/applicability.js';
import { isGptSolModel, resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { prefersText, readerTier, shouldImageModel } from '../src/core/reader-tier.js';
import { augmentWrappedCommand } from '../src/warp/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const prevFicheModels = process.env.FICHE_MODELS;
const prevInklingModels = process.env.INKLING_MODELS;

afterEach(() => {
  setAllowedModelBases(null);
  if (prevFicheModels === undefined) delete process.env.FICHE_MODELS;
  else process.env.FICHE_MODELS = prevFicheModels;
  if (prevInklingModels === undefined) delete process.env.INKLING_MODELS;
  else process.env.INKLING_MODELS = prevInklingModels;
});

function buildLargeInstructions(lines = 80): string {
  return Array.from({ length: lines }, (_, i) =>
    `- Rule ${i + 1}: Keep every API contract deterministic, zero-drop on cache prefixes, and verify output schemas.`,
  ).join('\n');
}

describe('GPT-6, 6.1, 6.2, and future GPT-7+ Sol & Astra profiles and tiers', () => {
  it('routes every Sol release (5.6, 6, 6.1, 6.2, 6.3, 7.x) to GPT56_SOL_PROFILE 14px optical tier', () => {
    const solModels = [
      'gpt-5.6-sol',
      'gpt-6-sol',
      'gpt-6-sol-codex',
      'gpt-6.1-sol',
      'gpt-6.2-sol',
      'gpt-6.2-sol[1m]',
      'gpt-6.3-sol',
      'gpt-7-sol',
      'gpt-7.1-sol-codex[1m]',
      'openai/gpt-6.2-sol',
    ];
    for (const model of solModels) {
      expect(isGptSolModel(model.replace(/^openai\//, '').replace(/\[[^\]]*\]$/, '')), model).toBe(true);
      const profile = resolveGptProfile(model);
      expect(profile.style.font, model).toBe('jetbrains-mono-14');
      expect(profile.maxHeightPx, model).toBe(1954);
      expect(profile.stripCols, model).toBe(84);
      expect(profile.vision, model).toEqual({ regime: 'patch', multiplier: 1 });
      expect(readerTier(model, false), model).toBe('image');
      expect(prefersText(model, false), model).toBe(false);
    }
  });

  it('routes every Astra release (6, 6.1, 6.2, 6.3, 7.x) to GPT6_PROFILE on the deterministic text tier', () => {
    const astraModels = [
      'gpt-6-astra',
      'gpt-6.1-astra',
      'gpt-6.2-astra',
      'gpt-6.2-astra[1m]',
      'gpt-6.3-astra',
      'gpt-7-astra',
      'gpt-7.2-astra',
      'openai/gpt-6.2-astra',
    ];
    for (const model of astraModels) {
      const profile = resolveGptProfile(model);
      expect(profile.style.font, model).toBe('spleen-5x8');
      expect(profile.stripCols, model).toBe(152);
      expect(profile.imageDetail, model).toBe('original');
      expect(readerTier(model, false), model).toBe('text');
      expect(prefersText(model, false), model).toBe(true);
      expect(shouldImageModel(model, true, false), model).toBe(false);
      expect(shouldImageModel(model, true, true), model).toBe(true);
    }
  });

  it('routes generic & future GPT-6+ / GPT-7+ models to GPT6_PROFILE rather than GPT-4o fallback', () => {
    for (const model of ['gpt-6', 'gpt-6.1', 'gpt-6.2', 'gpt-6.3', 'gpt-7', 'gpt-7.2', 'gpt-10.1', 'gpt-6.1-terra', 'gpt-6-luna']) {
      const profile = resolveGptProfile(model);
      expect(profile.style.font, model).toBe('spleen-5x8');
      expect(profile.stripCols, model).toBe(152);
      expect(profile.vision, model).toEqual({ regime: 'patch', multiplier: 1.2 });
    }
  });

  it('supports family base matching with dots (e.g. gpt-6 covers 6, 6.1, 6.2, Sol, and Astra) without loosening exact Sol opt-in', () => {
    delete process.env.INKLING_MODELS;
    process.env.FICHE_MODELS = 'gpt-6,gpt-7';
    for (const allowed of [
      'gpt-6',
      'gpt-6-sol',
      'gpt-6-astra',
      'gpt-6.1',
      'gpt-6.1-sol',
      'gpt-6.1-astra',
      'gpt-6.2',
      'gpt-6.2-sol',
      'gpt-6.2-astra',
      'gpt-6.3-sol',
      'gpt-7',
      'gpt-7.1-sol',
      'gpt-7.2-astra',
      'openai/gpt-6.2-sol[1m]',
    ]) {
      expect(isFicheSupportedGptModel(allowed), allowed).toBe(true);
    }
    expect(isFicheSupportedGptModel('gpt-5.6')).toBe(false);
    expect(isFicheSupportedGptModel('gpt-5.5')).toBe(false);

    process.env.FICHE_MODELS = 'gpt-6.1-sol';
    expect(isFicheSupportedGptModel('gpt-6.1-sol')).toBe(true);
    expect(isFicheSupportedGptModel('gpt-6.1')).toBe(false);
    expect(isFicheSupportedGptModel('gpt-6.1-terra')).toBe(false);
  });

  it('compresses gpt-6-sol / gpt-6.2-sol / gpt-7.1-sol optically and gpt-6/6.2/7.1-astra via deterministic text hygiene', async () => {
    const bigInstructions = buildLargeInstructions(90);
    for (const sol of ['gpt-6-sol', 'gpt-6.2-sol', 'gpt-7.1-sol']) {
      const body = enc.encode(JSON.stringify({
        model: sol,
        instructions: bigInstructions,
        input: [{ role: 'user', content: 'Inspect the architecture rules and reply ok.' }],
      }));
      const res = await transformOpenAIResponses(body, { imageCompress: true, charsPerToken: 1, minCompressChars: 1 });
      expect(res.info.compressed, sol).toBe(true);
      expect(res.info.imageCount ?? 0, sol).toBeGreaterThan(0);
      const parsed = JSON.parse(dec.decode(res.body)) as { input?: Array<{ content?: Array<{ type?: string; detail?: string }> }> };
      const imgs = (parsed.input ?? []).flatMap((it) => (Array.isArray(it.content) ? it.content : [])).filter((c) => c.type === 'input_image');
      expect(imgs.length, sol).toBeGreaterThan(0);
      expect(imgs[0]?.detail, sol).toBe('high');
    }

    const noisyOutput = Array.from({ length: 40 }, (_, i) =>
      `\x1b[32mPASS\x1b[0m src/module-${i % 4}.test.ts > verifies step ${i} in 12ms ok`,
    ).join('\n') + '\n' + 'M  src/core/file.ts\n'.repeat(25);
    for (const astra of ['gpt-6-astra', 'gpt-6.2-astra', 'gpt-7.1-astra']) {
      const body = enc.encode(JSON.stringify({
        model: astra,
        input: [
          { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{"cmd":"vitest"}' },
          { type: 'function_call_output', call_id: 'c1', output: noisyOutput },
          { role: 'user', content: 'Summarize the test status.' },
        ],
      }));
      const res = await transformOpenAIResponses(body, {
        imageCompress: false,
        deepTextCompact: true,
        charsPerToken: 1,
        minCompressChars: 1,
      });
      expect(res.info.compressed, astra).toBe(true);
      expect(res.info.imageCount, astra).toBe(0);
      expect(res.info.reason, astra).toBe('text_hygiene');
      expect(res.info.textHygieneSavedTokens ?? 0, astra).toBeGreaterThan(0);
    }
  });
});

describe('augmentWrappedCommand (Codex managed-daemon prevention)', () => {
  it('injects -c features.daemon_auto_start=false for interactive and exec codex sessions', () => {
    expect(augmentWrappedCommand(['codex'], {})).toEqual(['codex', '-c', 'features.daemon_auto_start=false']);
    expect(augmentWrappedCommand(['codex', 'exec', 'fix bug'], {})).toEqual([
      'codex',
      '-c',
      'features.daemon_auto_start=false',
      'exec',
      'fix bug',
    ]);
    expect(augmentWrappedCommand(['/opt/homebrew/bin/codex', 'review'], {})).toEqual([
      '/opt/homebrew/bin/codex',
      '-c',
      'features.daemon_auto_start=false',
      'review',
    ]);
  });

  it('skips non-session subcommands, explicit overrides, opt-out env, and non-codex CLIs', () => {
    expect(augmentWrappedCommand(['codex', 'app-server', 'daemon', 'stop'], {})).toEqual([
      'codex',
      'app-server',
      'daemon',
      'stop',
    ]);
    expect(augmentWrappedCommand(['codex', '--version'], {})).toEqual(['codex', '--version']);
    expect(augmentWrappedCommand(['codex', '--help'], {})).toEqual(['codex', '--help']);
    expect(augmentWrappedCommand(['codex', '-c', 'features.daemon_auto_start=true'], {})).toEqual([
      'codex',
      '-c',
      'features.daemon_auto_start=true',
    ]);
    expect(augmentWrappedCommand(['codex'], { FICHE_CODEX_KEEP_DAEMON: '1' })).toEqual(['codex']);
    expect(augmentWrappedCommand(['claude', '--model', 'claude-fable-5'], {})).toEqual([
      'claude',
      '--model',
      'claude-fable-5',
    ]);
  });
});

describe('Homebrew tap automation and release-macos packaging', () => {
  it('validates update-homebrew-tap.sh syntax/help/dry-run and release.yml macos zip job', () => {
    const repoRoot = resolve(import.meta.dirname, '..');
    const script = resolve(repoRoot, 'scripts/update-homebrew-tap.sh');
    const bashCheck = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    expect(bashCheck.status, bashCheck.stderr).toBe(0);

    const helpRun = spawnSync('bash', [script, '--help'], { encoding: 'utf8' });
    expect(helpRun.status, helpRun.stderr).toBe(0);
    expect(helpRun.stdout).toContain('--dry-run');

    const dryRun = spawnSync('bash', [script, '0.19.0', '--dry-run'], { encoding: 'utf8' });
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain('class Fiche < Formula');
    expect(dryRun.stdout).toContain('cask "fichebar"');
    expect(dryRun.stdout).toContain('https://registry.npmjs.org/@sriinnu/fiche/-/fiche-0.19.0.tgz');
    expect(dryRun.stdout).toContain('FicheBar-#{version}.zip');

    const releaseYml = readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8');
    expect(releaseYml).toContain('release-macos:');
    expect(releaseYml).toContain('FicheBar-${VERSION}.zip');
  });
});
