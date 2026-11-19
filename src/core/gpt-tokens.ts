/**
 * o200k_base token counts (GPT-5.x, GPT-6.x, GPT-4o and the o-series share the
 * encoding), shared by every GPT-path caller. Workers-safe.
 *
 * gpt-tokenizer keeps one 100k-entry merge cache for the life of the process
 * and evicts it from the front of a Map. Once that cache is full, every new
 * piece pays to skip the slots earlier evictions left behind, so a
 * long-running proxy got slower with each request: a 2.6 MB Codex body went
 * from 5 s to 8 s over three transforms and reached 12 s in a replay. Codex
 * text (tool output, encrypted reasoning) is mostly unique, so a large cache
 * buys little; a small one stays fast.
 *
 * Counts of large strings are memoised by the exact string. Codex and other
 * agents resend their whole history each turn, so turn N+1 tokenizes only
 * what turn N did not have.
 */
import { countTokens, setMergeCacheSize } from 'gpt-tokenizer/encoding/o200k_base';

const MERGE_CACHE_ENTRIES = 4096;
/** Strings shorter than this tokenize faster than a memo lookup is worth. */
const MEMO_MIN_CHARS = 1024;
/** Total characters of memoised strings kept alive before the memo clears. */
const MEMO_MAX_CHARS = 8 * 1024 * 1024;

setMergeCacheSize(MERGE_CACHE_ENTRIES);

const memo = new Map<string, number>();
let memoChars = 0;

/** o200k token count of `text`; 0 for empty text or a tokenizer error. */
export function gptTokenCount(text: string): number {
  if (!text) return 0;
  if (text.length >= MEMO_MIN_CHARS) {
    const hit = memo.get(text);
    if (hit !== undefined) return hit;
  }
  let n: number;
  try {
    n = countTokens(text);
  } catch {
    return 0;
  }
  if (text.length >= MEMO_MIN_CHARS && text.length <= MEMO_MAX_CHARS) {
    // Clear rather than evict one by one: front eviction from a Map is the
    // slowdown this module exists to avoid.
    if (memoChars + text.length > MEMO_MAX_CHARS) { memo.clear(); memoChars = 0; }
    memo.set(text, n);
    memoChars += text.length;
  }
  return n;
}

/** Test hook: characters held by the memo, never above 8 Mi. */
export function gptTokenMemoChars(): number {
  let n = 0;
  for (const k of memo.keys()) n += k.length;
  return n;
}

/** Test hook: forget memoised counts. */
export function clearGptTokenMemo(): void {
  memo.clear();
  memoChars = 0;
}
