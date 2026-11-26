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
const MEMO_MIN_CHARS = 128;
/** Maximum string length tokenized via synchronous pure-JS BPE; longer payloads use fast estimate. */
export const EXACT_BPE_MAX_CHARS = 256_000;
/** Total characters of memoised strings kept alive via LRU eviction. */
const MEMO_MAX_CHARS = 8 * 1024 * 1024;

setMergeCacheSize(MERGE_CACHE_ENTRIES);

interface MemoEntry {
  readonly tokens: number;
  readonly chars: number;
}

const memo = new Map<string, MemoEntry>();
let memoChars = 0;

function memoHash64Hex(s: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b1 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul((h1 ^ c) >>> 0, 0x01000193) >>> 0;
    h2 = Math.imul((h2 ^ ((c + (i & 0xff)) >>> 0)) >>> 0, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Strictly linear O(N) check for an unbroken non-whitespace run >= `limit`.
 */
export function hasLongNonWhitespaceRun(s: string, limit = 2048): boolean {
  if (s.length < limit) return false;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || c === 160) {
      run = 0;
    } else if (++run >= limit) {
      return true;
    }
  }
  return false;
}

/**
 * Strictly linear O(N) check for an unbroken BPE pre-tokenizer chunk >= `limit`.
 *
 * Minified JSON/code breaks o200k pre-tokenizer chunks at punctuation delimiters
 * (`":,{}[]();<>/.\\'`), staying linear (<2 ms at 25 KB), whereas contiguous
 * runs of letters or repeated symbols trigger O(M^2) BPE merge backtracking in
 * pure-JS `gpt-tokenizer` (387 ms on 30 KB `'a'.repeat(...)`).
 */
const UNBROKEN_BPE_FALLBACK_RUN = 6000;

export function hasLongUnbrokenBpeChunk(s: string, limit = 2048): boolean {
  if (s.length < limit) return false;
  let letterRun = 0;
  let punctRun = 0;
  let wsRun = 0;
  let prevWasLower = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || c === 160) {
      letterRun = 0;
      punctRun = 0;
      prevWasLower = false;
      if (++wsRun >= limit) return true;
    } else if (c >= 48 && c <= 57) {
      // o200k pre-tokenizes digits in 1..3 char groups (\p{N}{1,3}), so digits stay O(N).
      wsRun = 0;
      letterRun = 0;
      punctRun = 0;
      prevWasLower = false;
    } else if (c >= 65 && c <= 90) {
      wsRun = 0;
      punctRun = 0;
      // Lowercase -> uppercase starts a new o200k word token (so mixed-case base64 stays O(N)).
      letterRun = prevWasLower ? 1 : letterRun + 1;
      prevWasLower = false;
      if (letterRun >= limit) return true;
    } else if ((c >= 97 && c <= 122) || c >= 128) {
      wsRun = 0;
      punctRun = 0;
      prevWasLower = c >= 97 && c <= 122;
      if (++letterRun >= limit) return true;
    } else {
      wsRun = 0;
      letterRun = 0;
      prevWasLower = false;
      if (++punctRun >= limit) return true;
    }
  }
  return false;
}

/** o200k token count of `text`; 0 for empty text or a tokenizer error. */
export function gptTokenCount(text: string): number {
  if (!text) return 0;
  if (text.length > EXACT_BPE_MAX_CHARS) {
    return Math.ceil(text.length / 3.5);
  }
  let key: string | undefined;
  if (text.length >= MEMO_MIN_CHARS) {
    key = `${text.length}:${memoHash64Hex(text)}`;
    const hit = memo.get(key);
    if (hit !== undefined) {
      memo.delete(key);
      memo.set(key, hit);
      return hit.tokens;
    }
  }
  if (hasLongUnbrokenBpeChunk(text, UNBROKEN_BPE_FALLBACK_RUN)) {
    return Math.ceil(text.length / 3.5);
  }
  let n: number;
  try {
    n = countTokens(text);
  } catch {
    return 0;
  }
  if (key !== undefined && text.length <= MEMO_MAX_CHARS) {
    while (memoChars + text.length > MEMO_MAX_CHARS && memo.size > 0) {
      const oldestKey = memo.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestEntry = memo.get(oldestKey);
      memo.delete(oldestKey);
      if (oldestEntry) memoChars -= oldestEntry.chars;
    }
    memo.set(key, { tokens: n, chars: text.length });
    memoChars += text.length;
  }
  return n;
}

/** Test hook: characters represented by the memo, never above 8 Mi. */
export function gptTokenMemoChars(): number {
  return memoChars;
}

/** Test hook: forget memoised counts. */
export function clearGptTokenMemo(): void {
  memo.clear();
  memoChars = 0;
}
