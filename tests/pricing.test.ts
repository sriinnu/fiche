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
