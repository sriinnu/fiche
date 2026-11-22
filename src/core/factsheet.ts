/**
 * Verbatim fact-sheet for imaged content.
 *
 * When inkling renders a block (system slab, history, tool_result, reminder) to a PNG,
 * the precision-critical, hard-to-OCR strings inside it — file paths, URLs, SHAs/UUIDs,
 * version numbers, CLI flags, large numbers, CONST_IDS — are exactly what a model is
 * most likely to misread off the image yet most likely to need quoted verbatim. This
 * module extracts those tokens so they ride next to the image as plain text: the model
 * quotes them without re-reading the PNG, and they stay in the cached prefix.
 *
 * Deterministic by construction (fixed pattern order, length-desc/lexical sort, no
 * Date/random) → the emitted text is byte-stable across turns and never busts the
 * Anthropic prompt cache. Empirically ~5% of source chars on production history
 * (median 4.9%, max 12.1%, N=10), which preserves the imaging token win.
 */

/** ReDoS-safe extraction patterns (each global). Ordered most- to least-specific so the
 *  longest, most-identifying tokens are kept first when the substring filter runs. */
const PATTERNS: readonly RegExp[] = [
  /\b[A-Z][A-Z0-9_]{2,}=[^\s)"'<>]+/g, // semantic LABEL=value pair (preserve association)
  // Same association-preservation for lower/mixed-case `field=value`, which is what logs,
  // CLI output and JSONL actually emit (`dur=4439`, `gold=c9c947f680ec`, `trial=0`). The
  // uppercase pattern above skips those entirely, so only the bare value survives the image
  // and the label↔value binding is lost: a reader keeps `4439` but not what `dur` meant, and
  // silently rebinds it to a plausible wrong field (elapsed time, not the search key). That
  // is a binding error, not a legibility one — the glyphs were never in doubt. Value side is
  // restricted to opaque tokens so prose (`x=y`) and code (`const a=b`) cannot flood the sheet.
  /\b[A-Za-z][A-Za-z0-9_]{2,}=[A-Za-z0-9_.:/+-]{1,64}/g,
  /\bhttps?:\/\/[^\s)"'<>]+/g, // URLs
  /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b/g, // email address
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, // UUID
  /\b[A-Z]{2}\d{2}[A-Z0-9]{8,30}\b/g, // IBAN-like account string
  /(?:[$€£¥]|(?:USD|EUR|GBP|CAD|AUD|CHF|JPY))\d(?:[\d,_]*\d)?(?:\.\d{2})?\b/g, // currency amount
  /(?:[\w@~+-]+)?(?:\/[\w.@+-]+)+\.[A-Za-z]\w{0,8}\b/g, // path with a file extension (multi-dot ok: .test.ts)
  /\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?/g, // dir path (>=2 segments)
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, // git sha / long hex (must contain a digit)
  /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/g, // version string
  /(?:^|[^\w-])(--?[A-Za-z][\w-]+)/g, // CLI flag (token in capture group 1)
  /\b\d[\d,_]{3,}\b/g, // large / separated number
  /\b\d+\.\d+\b/g, // decimal
  /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g, // CONST_IDS / env var names
  // camelCase / PascalCase with ≥1 lowercase run and ≥1 internal capital
  // (tokenLedgerShard, getUserById). Rejects ALL-CAPS words so history markers
  // like CURRENT/FRONTIER do not flood the sheet.
  /\b(?:[a-z]+|[A-Z][a-z0-9]+)(?:[A-Z][a-z0-9]*)+\b/g,
  // Ticket/advisory-style codes: uppercase hyphenated with ≥1 digit (PROJ-1482,
  // CVE-2024-30078, AUDIT-ZX9). Digit lookahead is bounded → no backtracking blowup.
  /\b(?=[A-Z0-9-]{0,119}\d)[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+\b/g,
];

const MIN_LEN = 3;
const MAX_LEN = 120;
/** Budget cap: highest-priority tokens kept first. Exported so consumers can report drops. */
export const MAX_TOKENS = 96;
// At most this many URL exemplars: URLs are long, structured, low OCR-risk, and usually
// reconstructable, so they must never crowd out short zero-redundancy tokens.
const MAX_URLS = 8;
const MAX_SEEN = 2048; // defensive bound on distinct tokens entering substring-collapse
const MAX_SCAN = 262_144; // defensive input bound; tool_results are already paged
// Match render DENSE_CONTENT_CHARS_PER_IMAGE without importing render (cycle-free).
const FACTSHEET_PAGE_CHARS = 28_080;
const MAX_CHUNK = 512; // whitespace-free chunks longer than this are blobs (base64, minified) — skip

const M_DIGIT = 1 << 0;
const M_UPPER = 1 << 1;
const M_LOWER = 1 << 2;
const M_EQ    = 1 << 3;
const M_SLASH = 1 << 4;
const M_AT    = 1 << 5;
const M_DASH  = 1 << 6;
const M_DOT   = 1 << 7;
const M_UNDER = 1 << 8;
const M_CURR  = 1 << 9;

// Required character-class mask per pattern in PATTERNS (same index order 0..16).
const SAFE_PATTERN_REQ_MASK: readonly number[] = [
  M_EQ | M_UPPER,
  M_EQ,
  M_SLASH | M_LOWER,
  M_AT | M_DOT,
  M_DASH,
  M_UPPER | M_DIGIT,
  M_DIGIT,
  M_SLASH | M_DOT,
  M_SLASH,
  M_DIGIT,
  M_DIGIT | M_DOT,
  M_DASH,
  M_DIGIT,
  M_DIGIT | M_DOT,
  M_UPPER | M_UNDER,
  M_UPPER | M_LOWER,
  M_UPPER | M_DASH | M_DIGIT,
];

function chunkCharMask(chunk: string): number {
  let m = 0;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk.charCodeAt(i);
    if (c >= 48 && c <= 57) m |= M_DIGIT;
    else if (c >= 65 && c <= 90) m |= M_UPPER;
    else if (c >= 97 && c <= 122) m |= M_LOWER;
    else if (c === 61) m |= M_EQ;
    else if (c === 47) m |= M_SLASH;
    else if (c === 64) m |= M_AT;
    else if (c === 45) m |= M_DASH;
    else if (c === 46) m |= M_DOT;
    else if (c === 95) m |= M_UNDER;
    else if (c === 36 || c === 0x20ac || c === 0xa3 || c === 0xa5) m |= M_CURR;
  }
  return m;
}

const FACTSHEET_CACHE_CAP = 512;
const factsheetDigestCache = new Map<string, readonly FactSheetEntry[]>();

// Key by 128-bit digest + length so the LRU holds zero copies of large slab inputs.
function factSheetDigestKey(scan: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b1 >>> 0;
  let h3 = 0x85ebca6b >>> 0;
  let h4 = 0xc2b2ae35 >>> 0;
  for (let i = 0; i < scan.length; i++) {
    const c = scan.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c + i) & 0xffff), 0x01000193);
    h3 = Math.imul(h3 ^ c, 0x85ebca77);
    h4 = Math.imul(h4 ^ ((c << 3) | (i & 7)), 0xc2b2ae3d);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h3 >>> 0).toString(16).padStart(8, '0') +
    (h4 >>> 0).toString(16).padStart(8, '0') +
    ':' +
    scan.length
  );
}

/** Test helper: reset bounded digest cache for factsheet extraction. */
export function clearFactSheetCache(): void {
  factsheetDigestCache.clear();
}

/** Budget priority by token SHAPE, not length — length is anti-correlated with
 *  OCR-risk×consequence: a 70-char URL is structured and reconstructable, while a 7-char
 *  hex SHA or a port has zero redundancy and fails silently when misread. So short opaque
 *  identifiers outrank long URLs when the budget is tight. Pure + total → deterministic →
 *  cache-stable. Tiers: 0 = protect always, 1 = paths/versions/misc, 2 = URLs (cap + last). */
const SHAPE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHAPE_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const SHAPE_IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/;
const SHAPE_CURRENCY = /^(?:[$€£¥]|(?:USD|EUR|GBP|CAD|AUD|CHF|JPY))\d(?:[\d,_]*\d)?(?:\.\d{2})?$/;
const SHAPE_HEX = /^(?=[0-9a-f]*\d)[0-9a-f]{7,40}$/; // git sha / opaque hex
const SHAPE_CONST = /^[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+$/; // CONST_IDS / env vars
const SHAPE_TICKET = /^(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+$/; // PROJ-1482 / CVE-2024-30078
const SHAPE_FLAG = /^--?[A-Za-z][\w-]+$/; // CLI flag
const SHAPE_NUM = /^\d[\d,_]*$|^\d+\.\d+$/; // port / large or separated number / decimal
const SHAPE_URL = /^https?:\/\//;
const SHAPE_CAMEL = /^(?:[a-z]+|[A-Z][a-z0-9]+)(?:[A-Z][a-z0-9]*)+$/; // tokenLedgerShard / getUserById
// Tier-0 assignment is deliberately UPPERCASE-only. Lowercase `field=value` is still
// captured (see PATTERNS) so the label↔value binding survives, but it stays out of tier 0:
// log lines carry one on every row, so promoting them floods the top tier, and because the
// budget fills longest-first the `req=` prefix also inflates an 8-char hex id past a 9-char
// ticket code — evicting the rare token the sheet exists to preserve. Rarity, not shape, is
// what makes `dur=4439` worth keeping, and tier 1 is where that trade lands correctly.
const SHAPE_ASSIGNMENT = /^[A-Z][A-Z0-9_]{2,}=\S+$/; // ACTIVE_MANIFEST=/path

/** Lower tier = higher keep-priority. Pure function of the token → deterministic. */
function priorityTier(tok: string): 0 | 1 | 2 {
  if (
    SHAPE_ASSIGNMENT.test(tok) ||
    SHAPE_HEX.test(tok) ||
    SHAPE_UUID.test(tok) ||
    SHAPE_EMAIL.test(tok) ||
    SHAPE_IBAN.test(tok) ||
    SHAPE_CURRENCY.test(tok) ||
    SHAPE_CONST.test(tok) ||
    SHAPE_TICKET.test(tok) ||
    SHAPE_FLAG.test(tok) ||
    SHAPE_NUM.test(tok) ||
    (SHAPE_CAMEL.test(tok) && tok.length >= 8)
  ) {
    return 0;
  }
  if (SHAPE_URL.test(tok)) return 2;
  return 1;
}

/**
 * Extract deduped, precision-critical tokens from `text`. Substrings of a longer kept
 * token are dropped (so `/github.com` inside the full URL, `lib/x.ts` inside
 * `src/lib/x.ts`, etc. collapse to the most specific form); the token budget is then
 * filled by priority tier (see `priorityTier`) so short, high-consequence tokens are never
 * evicted by long low-risk URLs.
 *
 * Every token class is whitespace-free, so we split on whitespace first and skip
 * blob-length chunks. That bounds each regex to a short chunk and keeps extraction
 * strictly O(n) — no quadratic backtracking on delimiter-heavy input like base64 or
 * minified bundles (which embed `/` and would otherwise make the path patterns blow up).
 */
export function extractFactSheetTokens(text: string): string[] {
  return extractFactSheetEntries(text).map((e) => e.token);
}

/** A kept fact-sheet token plus how many times it occurs in the scanned text.
 *  Counts are advisory (occurrences, not lines) but deterministic → cache-stable. */
export interface FactSheetEntry {
  readonly token: string;
  readonly count: number;
}

/**
 * Like `extractFactSheetTokens`, but each kept token carries its occurrence count.
 * Counts make the fact sheet a *quantitative* index: tally questions over imaged
 * content ("how many lines mention CODE-X?") become answerable from text instead
 * of from counting rows of 5×8 px glyphs — the one operation page images are worst
 * at. The kept-token SET and its order are byte-identical to the pre-count
 * behaviour; only counts are new. Same-token spans matched by two patterns are
 * deduped by offset so a token is never double-counted.
 */
export function extractFactSheetEntries(text: string): FactSheetEntry[] {
  const scan = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const cacheKey = scan.length >= 64 ? factSheetDigestKey(scan) : '';
  if (cacheKey) {
    const cached = factsheetDigestCache.get(cacheKey);
    if (cached !== undefined) {
      factsheetDigestCache.delete(cacheKey);
      factsheetDigestCache.set(cacheKey, cached);
      // Shallow-clone entries so callers never mutate cached arrays/objects in place.
      return cached.map((e) => ({ token: e.token, count: e.count }));
    }
  }

  const counts = new Map<string, number>();
  const trailingPunct = /[.,;:!?]+$/;
  for (const chunk of scan.split(/\s+/)) {
    if (chunk.length < MIN_LEN || chunk.length > MAX_CHUNK) continue;
    const mask = chunkCharMask(chunk);
    // Offset-level dedup WITHIN this chunk: lazily allocate Set only when >= 2 matches occur.
    let firstKey: string | undefined;
    let spanSeen: Set<string> | null = null;
    for (let pIdx = 0; pIdx < PATTERNS.length; pIdx++) {
      const req = SAFE_PATTERN_REQ_MASK[pIdx]!;
      if ((mask & req) !== req) continue;
      if (pIdx === 6 && !(mask & (M_CURR | M_UPPER))) continue;
      const re = PATTERNS[pIdx]!;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(chunk)) !== null) {
        // Strip trailing sentence punctuation pulled in from prose (`pull/93.` → `pull/93`);
        // no real identifier we extract ends in these.
        const tok = (m[1] ?? m[0]).trim().replace(trailingPunct, '');
        if (tok.length < MIN_LEN || tok.length > MAX_LEN) continue;
        const key = `${m.index}\x00${tok}`;
        if (firstKey === undefined) {
          firstKey = key;
        } else if (spanSeen === null) {
          if (key === firstKey) continue;
          spanSeen = new Set<string>([firstKey, key]);
        } else if (spanSeen.has(key)) {
          continue;
        } else {
          spanSeen.add(key);
        }
        const prev = counts.get(tok);
        if (prev !== undefined) {
          counts.set(tok, prev + 1);
        } else if (counts.size < MAX_SEEN) {
          counts.set(tok, 1);
        }
      }
    }
  }
  // Phase 1 — substring collapse (length-desc): keep the most-specific form, folding e.g.
  // a URL's path-portion into the full URL. Cross-tier on purpose. Total order (length,
  // then lexical) so the result is independent of Set iteration order.
  const ordered = [...counts.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  // `\n`-delimited buffer preserves O(K) substring dedup (tokens are whitespace-split
  // and `ordered` is length-desc, so a shorter token matches iff it is a substring of a
  // kept longer token without ever spanning across `\n` boundaries).
  const specific: string[] = [];
  let joinedSpecific = '';
  for (const t of ordered) {
    if (!joinedSpecific.includes(t)) {
      specific.push(t);
      joinedSpecific += '\n' + t;
    }
  }
  // Phase 2 — allocate the budget by priority tier (shape, not length) so short,
  // zero-redundancy tokens (SHAs, ports, flags) can never be evicted by long low-risk URLs.
  // URLs are kept only as a few exemplars. Comparator is total → byte-stable output.
  const ranked = specific
    .map((t) => ({ t, tier: priorityTier(t) }))
    .sort((a, b) => a.tier - b.tier || b.t.length - a.t.length || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const kept: string[] = [];
  let urls = 0;
  for (const { t, tier } of ranked) {
    if (kept.length >= MAX_TOKENS) break;
    if (tier === 2 && urls++ >= MAX_URLS) continue;
    kept.push(t);
  }
  const result = kept.map((t) => ({ token: t, count: counts.get(t) ?? 1 }));
  if (cacheKey) {
    if (factsheetDigestCache.size >= FACTSHEET_CACHE_CAP) {
      const oldest = factsheetDigestCache.keys().next().value;
      if (oldest !== undefined) factsheetDigestCache.delete(oldest);
    }
    factsheetDigestCache.set(cacheKey, result);
  }
  return result;
}

/**
 * Page-aware variant of `extractFactSheetTokens` for large source texts.
 *
 * Splits `text` into chunks of `charsPerPage` (use `DENSE_CONTENT_CHARS_PER_IMAGE`
 * from render.ts for the export pipeline), calls `extractFactSheetTokens` on each
 * chunk (each chunk is smaller than MAX_SCAN so no truncation occurs), merges the
 * results across all chunks with first-seen deduplication, then applies a single
 * global priority-budget pass to select the best MAX_TOKENS identifiers.
 *
 * Returns `{ kept, dropped }` where `dropped` is the count of identifiers that
 * survived extraction across all pages but did not fit in the MAX_TOKENS budget.
 *
 * Does NOT mutate the behaviour of `extractFactSheetTokens` or `factSheetText`.
 */
export function extractFactSheetTokensAllPages(
  text: string,
  charsPerPage: number,
): { kept: string[]; dropped: number } {
  const { kept, dropped } = extractFactSheetEntriesAllPages(text, charsPerPage);
  return { kept: kept.map((e) => e.token), dropped };
}

/** Entry-carrying variant of `extractFactSheetTokensAllPages`: same kept set and
 *  order, with per-token occurrence counts summed across all pages. */
export function extractFactSheetEntriesAllPages(
  text: string,
  charsPerPage: number,
): { kept: FactSheetEntry[]; dropped: number } {
  const counts = new Map<string, number>();
  const step = Math.max(1, Number.isFinite(charsPerPage) ? Math.floor(charsPerPage) : 1);

  // Walk the text in page-sized chunks snapped to whitespace boundaries so we
  // neither loop endlessly on small inputs nor slice an identifier in half.
  let pos = 0;
  while (pos < text.length || pos === 0) {
    let end = Math.min(text.length, pos + step);
    if (end < text.length && !/\s/.test(text[end] ?? '') && !/\s/.test(text[end - 1] ?? '')) {
      let back = end;
      while (back > pos && !/\s/.test(text[back - 1]!)) back--;
      if (back > pos + Math.floor(step / 2)) {
        end = back;
      } else {
        let fwd = end;
        while (fwd < text.length && fwd - end < 128 && !/\s/.test(text[fwd]!)) fwd++;
        if (fwd < text.length && /\s/.test(text[fwd]!)) end = fwd + 1;
      }
    }
    const chunk = text.slice(pos, end);
    for (const { token, count } of extractFactSheetEntries(chunk)) {
      counts.set(token, (counts.get(token) ?? 0) + count);
    }
    if (end >= text.length) break;
    pos = end;
  }

  // Re-run global substring deduplication across pages so a longer token on page 2
  // folds an extracted path substring from page 1, then apply the global priority budget.
  const ordered = [...counts.keys()].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const specific: string[] = [];
  let joinedSpecific = '';
  for (const t of ordered) {
    if (!joinedSpecific.includes(t)) {
      specific.push(t);
      joinedSpecific += '\n' + t;
    }
  }

  const ranked = specific
    .map((t) => ({ t, tier: priorityTier(t) }))
    .sort((a, b) => a.tier - b.tier || b.t.length - a.t.length || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const kept: FactSheetEntry[] = [];
  let urls = 0;
  for (const { t, tier } of ranked) {
    if (kept.length >= MAX_TOKENS) break;
    if (tier === 2 && urls++ >= MAX_URLS) continue;
    kept.push({ token: t, count: counts.get(t) ?? 1 });
  }

  return { kept, dropped: specific.length - kept.length };
}

const OPEN =
  '[Exact identifiers from the rendered context above (paths, ids, versions, numbers) — quote these verbatim instead of transcribing them from the image: ';
/** Variant used when at least one token repeats — explains the ×N annotation so the
 *  model can answer tally questions from the sheet instead of counting glyph rows. */
const OPEN_COUNTS =
  '[Exact identifiers from the rendered context above (paths, ids, versions, numbers) — quote these verbatim instead of transcribing them from the image; ×N marks a token that occurs N times within the imaged content: ';
const OPEN_COMPACT = '[Exact rendered identifiers—quote verbatim: ';
const OPEN_COMPACT_COUNTS = '[Exact rendered identifiers—quote verbatim; ×N=count: ';

export type FactSheetFormat = 'full' | 'compact';

/** Build the one-line fact-sheet string from a pre-extracted token list. */
export function factSheetTextFromTokens(tokens: string[]): string {
  return tokens.length > 0 ? OPEN + tokens.join(' · ') + ']' : '';
}

/** Build the one-line fact-sheet string from token+count entries. Byte-identical to
 *  `factSheetTextFromTokens` when no token repeats, so existing sheets stay cache-stable. */
export function factSheetTextFromEntries(
  entries: readonly FactSheetEntry[],
  format: FactSheetFormat = 'full',
): string {
  if (entries.length === 0) return '';
  const anyRepeat = entries.some((e) => e.count >= 2);
  const body = entries.map((e) => (e.count >= 2 ? `${e.token} ×${e.count}` : e.token)).join(' · ');
  const opener = format === 'compact'
    ? (anyRepeat ? OPEN_COMPACT_COUNTS : OPEN_COMPACT)
    : (anyRepeat ? OPEN_COUNTS : OPEN);
  return opener + body + ']';
}

/** One-line fact-sheet string for `text`, or `''` when nothing notable was found.
 *  Single path for slab, history, and tool results: page long text so early-turn
 *  ids are not dropped by MAX_SCAN. Short text is one page (same as before). */
export function factSheetText(text: string, format: FactSheetFormat = 'full', coveredText?: string | ReadonlySet<string>): string {
  if (!text) return '';
  return prepareFactSheet(text, format)(coveredText);
}

/** Extract once; coverage remains an emission-time input, never cached state. */
export function prepareFactSheet(text: string, format: FactSheetFormat = 'full'): (coveredText?: string | ReadonlySet<string>) => string {
  if (!text) return () => '';
  const entries = text.length <= FACTSHEET_PAGE_CHARS
    ? extractFactSheetEntries(text)
    : extractFactSheetEntriesAllPages(text, FACTSHEET_PAGE_CHARS).kept;
  const full = factSheetTextFromEntries(entries, format);
  return (coveredText) => {
    if (coveredText === undefined || (typeof coveredText === 'string' ? coveredText.length === 0 : coveredText.size === 0)) return full;
    return factSheetTextFromEntries(entries.filter((entry) => {
      const covered = typeof coveredText === 'string'
        ? coveredText.includes(entry.token)
        : coveredText.has(entry.token);
      if (!covered) return true;
      return entry.count >= 2;
    }), format);
  };
}
