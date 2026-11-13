/**
 * Gateway-qualified model ids (`moonshotai/kimi-k3`, `openrouter/…`) name the same
 * reader as the bare id — the vendor segment picks an upstream, not a geometry.
 *
 * Scope matching, profile resolution, and the misresolution guard must agree on
 * that, or a gateway id either (a) silently never matches its INKLING_MODELS
 * entry, or worse (b) matches scope but resolves to DEFAULT_GPT_PROFILE and is
 * gated with OpenAI's tile math — the wrong provider's pricing formula.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  isInklingSupportedGptModel,
  isInklingSupportedModel,
  setAllowedModelBases,
} from '../src/core/applicability.js';
import {
  DEFAULT_GPT_PROFILE,
  isMisresolvedModelId,
  resolveGptProfile,
} from '../src/core/gpt-model-profiles.js';
import { GEMINI_3_6_FLASH_PROFILE } from '../src/core/gemini-model-profiles.js';

afterEach(() => {
  setAllowedModelBases(null);
  delete process.env.INKLING_GPT_PROFILES;
});

describe('scope matching for gateway-qualified ids', () => {
  it('admits both spellings for one INKLING_MODELS entry', () => {
    setAllowedModelBases(['gpt-5.6-sol']);
    expect(isInklingSupportedGptModel('gpt-5.6-sol')).toBe(true);
    expect(isInklingSupportedGptModel('vendor/gpt-5.6-sol')).toBe(true);
  });

  it('strips a multi-segment gateway prefix to the last segment', () => {
    setAllowedModelBases(['kimi-k3']);
    // workers-ai/@cf/moonshotai/kimi-k3 — the real Cloudflare Workers AI id.
    expect(isInklingSupportedGptModel('workers-ai/@cf/moonshotai/kimi-k3')).toBe(true);
  });

  it('still requires the last segment to match exactly', () => {
    setAllowedModelBases(['gpt-5.6-sol']);
    expect(isInklingSupportedGptModel('vendor/gpt-5.6-terra')).toBe(false);
    expect(isInklingSupportedGptModel('vendor/gpt')).toBe(false);
    expect(isInklingSupportedGptModel('a/b/gpt-5.6-terra')).toBe(false);
  });

  it('does not let a vendor segment smuggle in an unscoped model', () => {
    setAllowedModelBases(['gpt-5.6-sol']);
    expect(isInklingSupportedGptModel('gpt-5.6-sol/gpt-5.5')).toBe(false);
  });

  it('keeps the pre-existing google/ behaviour', () => {
    setAllowedModelBases(['gemini-3.6-flash']);
    expect(isInklingSupportedGptModel('google/gemini-3.6-flash')).toBe(true);
    expect(isInklingSupportedGptModel('google/gemini-3.6-pro')).toBe(false);
  });
});

describe('Gemini family default and opt-out', () => {
  const prevEnv = process.env.INKLING_MODELS;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.INKLING_MODELS;
    else process.env.INKLING_MODELS = prevEnv;
  });

  it('the `gemini` family base admits every Gemini id with no configuration', () => {
    delete process.env.INKLING_MODELS;
    setAllowedModelBases(null);
    for (const id of ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-pro', 'gemini-4', 'gemini-5-pro', 'google/gemini-4-flash']) {
      expect(isInklingSupportedModel(id), id).toBe(true);
    }
  });

  it('dropping `gemini` from INKLING_MODELS opts the whole family out', () => {
    process.env.INKLING_MODELS = 'claude-fable-5';
    setAllowedModelBases(null);
    expect(isInklingSupportedModel('claude-fable-5')).toBe(true);
    for (const id of ['gemini-3.6-flash', 'gemini-4', 'gemini-pro']) {
      expect(isInklingSupportedModel(id), id).toBe(false);
    }
  });

  it('a per-version base narrows instead of widening', () => {
    setAllowedModelBases(['gemini-3.6-flash']);
    expect(isInklingSupportedModel('gemini-3.6-flash')).toBe(true);
    expect(isInklingSupportedModel('gemini-4')).toBe(false);
  });
});

describe('unknown OpenAI-compatible ids fall back to DEFAULT_GPT_PROFILE', () => {
  // Kimi K3 through Cloudflare's OpenAI-compatible route is the worked example
  // (see messages-chat-bridge.ts). inkling has measured no geometry for it, but
  // an unmeasured OpenAI-compatible id is not refused: it is gated with
  // DEFAULT_GPT_PROFILE's tile math, which is an approximation, not a
  // measurement. Scope is the only gate, and no env var is required.
  it('admits every spelling on scope alone, with no env var set', () => {
    delete process.env.INKLING_GPT_PROFILES;
    setAllowedModelBases(['kimi-k3']);
    expect(isMisresolvedModelId('kimi-k3')).toBe(false);
    expect(isInklingSupportedGptModel('kimi-k3')).toBe(true);
    expect(isInklingSupportedGptModel('moonshotai/kimi-k3')).toBe(true);
    expect(isInklingSupportedGptModel('workers-ai/@cf/moonshotai/kimi-k3')).toBe(true);
  });

  it('gives an undeclared id the default tile vision cost', () => {
    delete process.env.INKLING_GPT_PROFILES;
    expect(resolveGptProfile('kimi-k3').vision).toEqual(DEFAULT_GPT_PROFILE.vision);
  });

  it('lets an explicit declaration override the fallback', () => {
    process.env.INKLING_GPT_PROFILES = JSON.stringify({
      'kimi-k3': { vision: { regime: 'mpix', tokensPerMegapixel: 1000 } },
    });
    setAllowedModelBases(['kimi-k3', 'example-model-1']);
    expect(resolveGptProfile('kimi-k3').vision).toEqual({
      regime: 'mpix',
      tokensPerMegapixel: 1000,
    });
    // A sibling with no declaration of its own is still admitted — it falls
    // back to the default profile rather than being refused.
    expect(isInklingSupportedGptModel('example-model-1')).toBe(true);
    expect(resolveGptProfile('example-model-1').vision).toEqual(DEFAULT_GPT_PROFILE.vision);
  });
});

describe('profile resolution for gateway-qualified ids', () => {
  it('resolves a qualified id to the same measured profile as the bare id', () => {
    expect(resolveGptProfile('openrouter/gemini-3.6-flash')).toBe(GEMINI_3_6_FLASH_PROFILE);
    expect(resolveGptProfile('vendor/gpt-5.6-sol')).toBe(resolveGptProfile('gpt-5.6-sol'));
  });

  it('lets a INKLING_GPT_PROFILES key written bare match a qualified id', () => {
    process.env.INKLING_GPT_PROFILES = JSON.stringify({
      'kimi-k3': { vision: { regime: 'mpix', tokensPerMegapixel: 1000 }, stripCols: 100 },
    });
    const bare = resolveGptProfile('kimi-k3');
    expect(bare.stripCols).toBe(100);
    expect(resolveGptProfile('moonshotai/kimi-k3').stripCols).toBe(100);
  });

  it('leaves a genuinely unknown id on the OpenAI default', () => {
    // Resolution falls back to the OpenAI default, and isMisresolvedModelId
    // does not refuse it: an id naming no measured family is in scope if the
    // operator listed it, priced with tile math as an approximation.
    expect(resolveGptProfile('moonshotai/kimi-k3')).toBe(DEFAULT_GPT_PROFILE);
  });
});

describe('misresolution guard agrees with the resolver', () => {
  it('does not refuse a qualified id that resolves to its measured profile', () => {
    expect(isMisresolvedModelId('openrouter/gemini-3.6-flash')).toBe(false);
    expect(resolveGptProfile('openrouter/gemini-3.6-flash')).not.toBe(DEFAULT_GPT_PROFILE);
  });

  it('still refuses an unmeasured sibling under any spelling', () => {
    expect(isMisresolvedModelId('gemini-3.6-pro')).toBe(true);
    expect(isMisresolvedModelId('openrouter/gemini-3.6-pro')).toBe(true);
  });
});
