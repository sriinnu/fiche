import { describe, expect, it } from 'vitest';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { clearGptTokenMemo, gptTokenCount, gptTokenMemoChars } from '../src/core/gpt-tokens.js';

describe('gptTokenCount', () => {
  const texts = [
    '',
    'hello world',
    'x'.repeat(5000),
    Array.from({ length: 400 }, (_, i) => `line ${i}: ${(i * 2654435761 >>> 0).toString(16)}`).join('\n'),
    'gAAAAABo' + 'Zm9vYmFy'.repeat(2000), // encrypted_content-shaped base64
  ];

  it('matches o200k exactly, memoised or not', () => {
    clearGptTokenMemo();
    for (const t of texts) {
      const want = t ? countTokens(t) : 0;
      expect(gptTokenCount(t)).toBe(want);
      expect(gptTokenCount(t)).toBe(want); // second call: memo hit
      expect(gptTokenCount(t.slice(0))).toBe(want); // equal string, different object
    }
  });

  it('a near-identical string is never served the memoised count', () => {
    clearGptTokenMemo();
    const a = 'a b c d '.repeat(400);
    // Same start, more tokens: a key built from any prefix would collide.
    const b = a + 'and then several more words at the end';
    expect(countTokens(b)).toBeGreaterThan(countTokens(a));
    expect(gptTokenCount(a)).toBe(countTokens(a));
    expect(gptTokenCount(b)).toBe(countTokens(b));
  });

  it('stays exact after the memo fills and evicts within the BPE ceiling', () => {
    clearGptTokenMemo();
    // Stay below EXACT_BPE_MAX_CHARS (256_000) so real BPE runs while still churning the 8 MiB LRU memo.
    const big = (k: number) => `${k} `.padEnd(240_000, ' lorem ipsum dolor');
    for (let k = 0; k < 40; k++) {
      expect(gptTokenCount(big(k))).toBe(countTokens(big(k)));
      expect(gptTokenMemoChars()).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
    expect(gptTokenCount(big(0))).toBe(countTokens(big(0)));
  });
});
