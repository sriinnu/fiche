import { describe, it, expect } from 'vitest';
import { ANTHROPIC_GATE_RATES, gateRatesFor, resolvePriceRates } from '../src/core/pricing.js';
import { CACHE_CREATE_RATE, CACHE_READ_RATE } from '../src/core/baseline.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import {
  evalCompressionProfitability,
  isCompressionProfitable,
  isCompressionProfitableAmortized,
} from '../src/core/transform.js';

/**
 * The resolver is the one source of price ratios. Until the kosha snapshot
 * lands it must return exactly what inkling priced with before, so these pin
 * the historical values. When the data source changes, these are the tests
 * that must be re-approved, on purpose.
 */
describe('pricing resolver (historical values pinned)', () => {
  it('the Anthropic gate prices at the 5-minute tier for every model', () => {
    expect(ANTHROPIC_GATE_RATES).toEqual({ read: CACHE_READ_RATE, write: CACHE_CREATE_RATE, output: 5 });
    for (const m of ['claude-opus-5-5', 'claude-fable-5-2', 'gpt-5.6-sol', undefined]) {
      expect(gateRatesFor(m)).toBe(ANTHROPIC_GATE_RATES);
    }
  });

  it('savings ratios come from the model profile', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-5.5', 'gemini-3.6-flash', 'grok-4.7', 'deepseek-chat', undefined]) {
      const p = resolveGptProfile(m);
      expect(resolvePriceRates(m)).toEqual({ read: p.cacheReadRate, write: p.cacheWriteRate ?? 1, output: p.outputRate });
    }
  });
});

describe('gate functions honour the rates they are given', () => {
  const text = 'x'.repeat(40_000);
  const cheapRead = { read: 0.01, write: 3, output: 5 };

  it('burn scales with write - read', () => {
    const base = evalCompressionProfitability(text, 152, undefined, 4, 10_000, 0)!;
    const other = evalCompressionProfitability(text, 152, undefined, 4, 10_000, 0, true, undefined, cheapRead)!;
    expect(base.burnImageSide).toBeCloseTo(10_000 * (CACHE_CREATE_RATE - CACHE_READ_RATE));
    expect(other.burnImageSide).toBeCloseTo(10_000 * (3 - 0.01));
  });

  it('the amortized gate flips exactly where the given rates put break-even', () => {
    // Gate: I*(w + r*(N-1)) < T*r*N. With r = 1, break-even is I/T = N/(w+N-1),
    // so w picks the threshold. Straddle this text's measured I/T from both sides.
    const N = 10;
    const e = evalCompressionProfitability(text, 152, undefined, 4, 0, 0)!;
    const ratio = e.imageTokens / e.textTokens;
    const wFor = (q: number) => N / q - N + 1;
    const pass = { read: 1, write: wFor(Math.min(0.999, ratio * 1.05)), output: 5 };
    const fail = { read: 1, write: wFor(ratio * 0.95), output: 5 };
    expect(pass.write).toBeGreaterThan(0);
    expect(isCompressionProfitableAmortized(text, 152, undefined, 4, N, 0, 0, true, undefined, undefined, pass)).toBe(true);
    expect(isCompressionProfitableAmortized(text, 152, undefined, 4, N, 0, 0, true, undefined, undefined, fail)).toBe(false);
  });

  it('the per-turn gate charges burn at the given write - read', () => {
    // Profitable iff I + P*(w-r) < T. Pick P so the default rates pass and a
    // wider write - read gap fails.
    const e = evalCompressionProfitability(text, 152, undefined, 4, 0, 0)!;
    const gap = e.textTokens - e.imageTokens;
    const P = gap / 2 / (CACHE_CREATE_RATE - CACHE_READ_RATE); // burn = half the gap
    expect(isCompressionProfitable(text, 152, undefined, 4, P, 0)).toBe(true);
    const wide = { read: 0.1, write: 0.1 + 3 * (CACHE_CREATE_RATE - CACHE_READ_RATE), output: 5 };
    expect(isCompressionProfitable(text, 152, undefined, 4, P, 0, true, undefined, undefined, wide)).toBe(false);
    expect(isCompressionProfitableAmortized(text, 152, undefined, 4, 10, P, 0, true, undefined, undefined, wide)).toBe(false);
    // horizon <= 1 falls back to the per-turn gate and must keep the rates.
    expect(isCompressionProfitableAmortized(text, 152, undefined, 4, 1, P, 0)).toBe(true);
    expect(isCompressionProfitableAmortized(text, 152, undefined, 4, 1, P, 0, true, undefined, undefined, wide)).toBe(false);
  });
});

import { afterEach, beforeEach } from 'vitest';
import { normalizeModelId } from '../src/core/price-id.js';
import { priceMode, priceRowFor, priceSourceFor, ratesFromRow } from '../src/core/pricing.js';
import { PRICES } from '../src/core/prices.generated.js';
import { generate } from '../scripts/gen-prices.js';
import { transformRequest } from '../src/core/transform.js';

describe('normalizeModelId', () => {
  it.each([
    ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['anthropic/claude-opus-5-5', 'claude-opus-5-5'],
    ['Claude-Opus-5-5-20260922', 'claude-opus-5-5'],
    ['claude-opus-4@20250514', 'claude-opus-4'],
    ['qwen3.7-max-2026-06-08', 'qwen3.7-max'],
    ['moonshotai/kimi-k3:free', 'kimi-k3'],
    ['gpt-5.6-sol', 'gpt-5.6-sol'],
  ])('%s -> %s', (raw, want) => {
    expect(normalizeModelId(raw)).toBe(want);
  });
});

describe('gen-prices', () => {
  const fixture = {
    schemaVersion: 1,
    discoveredAt: Date.UTC(2026, 10, 17),
    models: [
      { modelId: 'claude-opus-5-5', providerId: 'anthropic', originProviderId: 'anthropic', aliases: ['opus'],
        pricing: { inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.2, cacheWritePerMillion: 5 } },
      // Reseller rows never count; this real OpenRouter row reads at 0.95x.
      { modelId: 'moonshotai/kimi-k3', providerId: 'openrouter', originProviderId: 'moonshot',
        pricing: { inputPerMillion: 0.192, outputPerMillion: 16, cacheReadPerMillion: 0.182, cacheWritePerMillion: 3 } },
      // A served provider reselling someone else's model is still a reseller.
      { modelId: 'kimi-k3', providerId: 'alibaba', originProviderId: 'moonshot',
        pricing: { inputPerMillion: 0.574, outputPerMillion: 3, cacheReadPerMillion: 0.1148, cacheWritePerMillion: 0.7175 } },
      // Same id from two first-party providers: zai matches z.ai's page, glm doesn't.
      { modelId: 'glm-5.3', providerId: 'glm', originProviderId: 'glm',
        pricing: { inputPerMillion: 1.19516, outputPerMillion: 4.18306, cacheReadPerMillion: 0.29879, cacheWritePerMillion: 0 } },
      { modelId: 'glm-5.3', providerId: 'zai', originProviderId: 'zai',
        pricing: { inputPerMillion: 1.4, outputPerMillion: 4.4, cacheReadPerMillion: 0.26, cacheWritePerMillion: 0 } },
      { modelId: 'free-thing', providerId: 'openai', originProviderId: 'openai',
        pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
      { modelId: 'not-served', providerId: 'fireworks', originProviderId: 'fireworks',
        pricing: { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0.1 } },
    ],
  };
  const out = generate(fixture);

  it('keeps first-party rows of served providers only, zai over glm', () => {
    expect(out).toContain('"claude-opus-5-5": {"p":"anthropic","in":4,"out":20,"cr":0.2,"cw":5}');
    expect(out).toContain('"glm-5.3": {"p":"zai","in":1.4,"out":4.4,"cr":0.26,"cw":0}');
    expect(out).not.toContain('kimi-k3');
    expect(out).not.toContain('free-thing');
    expect(out).not.toContain('not-served');
    expect(out).toContain('"opus": "claude-opus-5-5"');
  });

  it('is deterministic', () => {
    expect(generate({ ...fixture, models: [...fixture.models].reverse() })).toBe(out);
  });
});

describe('ratesFromRow sanity', () => {
  it('rejects the rows that would poison the gate', () => {
    expect(ratesFromRow({ p: 'openrouter', in: 0.192, out: 16, cr: 0.182, cw: 3 })).toBeUndefined(); // write 15.6x
    expect(ratesFromRow({ p: 'x', in: 1, out: 2, cr: 1 })).toBeUndefined(); // read = input
    expect(ratesFromRow({ p: 'x', in: 1, out: 2 })).toBeUndefined(); // no cache read
    expect(ratesFromRow({ p: 'x', in: 0, out: 2, cr: 0 })).toBeUndefined();
    expect(ratesFromRow({ p: 'x', in: 1, cr: 0.1 })).toBeUndefined(); // no output
  });
  it('a 0 or missing write means no premium', () => {
    expect(ratesFromRow({ p: 'deepseek', in: 0.3, out: 1.2, cr: 0.006, cw: 0 })!.write).toBe(1);
    expect(ratesFromRow({ p: 'xai', in: 2, out: 6, cr: 0.5 })!.write).toBe(1);
  });
});

describe('INKLING_PRICES=kosha', () => {
  const saved = { prices: process.env.INKLING_PRICES, profiles: process.env.INKLING_GPT_PROFILES };
  beforeEach(() => {
    process.env.INKLING_PRICES = 'kosha';
    delete process.env.INKLING_GPT_PROFILES;
  });
  afterEach(() => {
    if (saved.prices === undefined) delete process.env.INKLING_PRICES; else process.env.INKLING_PRICES = saved.prices;
    if (saved.profiles === undefined) delete process.env.INKLING_GPT_PROFILES; else process.env.INKLING_GPT_PROFILES = saved.profiles;
  });

  it('defaults to legacy unless asked', () => {
    delete process.env.INKLING_PRICES;
    expect(priceMode()).toBe('legacy');
    process.env.INKLING_PRICES = 'KOSHA ';
    expect(priceMode()).toBe('kosha');
  });

  it('matches the official Anthropic read tiers (platform.claude.com pricing, 2026-11-17)', () => {
    const read = (m: string) => gateRatesFor(m)!.read;
    expect(read('claude-opus-5-5')).toBeCloseTo(0.05);
    expect(read('claude-sonnet-5-5')).toBeCloseTo(0.05);
    expect(read('claude-fable-5-2')).toBeCloseTo(0.025);
    expect(read('claude-opus-5')).toBeCloseTo(0.1);
    expect(read('claude-haiku-5-5')).toBeCloseTo(0.1);
    expect(gateRatesFor('claude-opus-5-5')!.write).toBeCloseTo(1.25);
  });

  it('matches official OpenAI short-context rates (developers.openai.com pricing, 2026-11-17)', () => {
    expect(resolvePriceRates('gpt-6.1-sol')).toEqual({ read: 0.05, write: 1.25, output: 5 });
    expect(resolvePriceRates('gpt-5.6-sol')).toEqual({ read: 0.1, write: 1.25, output: 5 });
  });

  it('every model inkling has a profile for is priced', () => {
    for (const m of ['claude-opus-5-5', 'claude-fable-5-2', 'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra',
      'gemini-3.6-flash', 'grok-4.7', 'kimi-k3', 'glm-5.3', 'deepseek-flash', 'minimax-m3']) {
      expect(priceSourceFor(m), m).toBe('kosha');
    }
  });

  it('every snapshot row is either sane or unpriced, never half-trusted', () => {
    for (const [id, row] of Object.entries(PRICES)) {
      const r = ratesFromRow(row);
      if (!r) continue;
      expect(r.read, id).toBeGreaterThan(0);
      expect(r.read, id).toBeLessThan(1);
      expect(r.write, id).toBeGreaterThanOrEqual(1);
      expect(r.write, id).toBeLessThanOrEqual(3);
    }
  });

  it('finds dated, bracketed, vendor-pathed, aliased and suffixed ids', () => {
    const opus = priceRowFor('claude-opus-5-5');
    for (const m of ['claude-opus-5-5[1m]', 'anthropic/claude-opus-5-5', 'claude-opus-5-5-20260922', 'opus']) {
      expect(priceRowFor(m), m).toBe(opus);
    }
    expect(priceRowFor('gpt-5.6-sol-codex')).toBe(priceRowFor('gpt-5.6-sol'));
    expect(priceRowFor('gpt-5.6-solar')).not.toBe(priceRowFor('gpt-5.6-sol'));
  });

  it('an unknown model is unpriced: the gate refuses, savings fall back to the profile', () => {
    expect(gateRatesFor('mystery-model-9')).toBeNull();
    expect(priceSourceFor('mystery-model-9')).toBe('unpriced');
    const p = resolveGptProfile('mystery-model-9');
    expect(resolvePriceRates('mystery-model-9')).toEqual({ read: p.cacheReadRate, write: p.cacheWriteRate ?? 1, output: p.outputRate });
    const text = 'x'.repeat(40_000);
    expect(isCompressionProfitable(text, 152, undefined, 4, 0, 0, true, undefined, undefined, null)).toBe(false);
    expect(isCompressionProfitableAmortized(text, 152, undefined, 4, 10, 0, 0, true, undefined, undefined, null)).toBe(false);
    expect(evalCompressionProfitability(text, 152, undefined, 4, 0, 0, true, undefined, null)).toBeNull();
  });

  it('an explicit INKLING_GPT_PROFILES pricing field still wins, field by field', () => {
    process.env.INKLING_GPT_PROFILES = JSON.stringify({ 'gpt-5.6-sol': { outputRate: 9 } });
    expect(resolvePriceRates('gpt-5.6-sol')).toEqual({ read: 0.1, write: 1.25, output: 9 });
    expect(priceSourceFor('gpt-5.6-sol')).toBe('env');
  });

  it('the transform gate uses the request model: an unpriced model is never imaged', async () => {
    const enc = new TextEncoder();
    const run = (model: string) => transformRequest(
      enc.encode(JSON.stringify({
        model,
        system: 'You are a coding agent with detailed operating instructions. '.repeat(300),
        messages: [{ role: 'user', content: 'hi' }],
      })),
      { compress: true, minCompressChars: 1, charsPerToken: 1, model },
    );
    expect((await run('claude-opus-5-5')).info.compressed).toBe(true);
    expect((await run('claude-mystery-9')).info.compressed).toBe(false);
    delete process.env.INKLING_PRICES;
    expect((await run('claude-mystery-9')).info.compressed).toBe(true); // legacy prices every model
  });
});
