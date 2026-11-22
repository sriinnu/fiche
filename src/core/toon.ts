/**
 * Bijective TOON / ONTO columnar encoder & decoder for uniform JSON payloads.
 *
 * Grounded in:
 *  - TOON (arXiv:2603.03306): tabular schema-once encoding cuts 30-50%+ tokens
 *    over minified JSON while matching/improving retrieval per token.
 *  - ONTO (arXiv:2604.17512): schema-once columnar rows with optional header
 *    metadata preserve structural fidelity across operational logs & arrays.
 *
 * 100% lossless (`decodeToon(encodeToon(x))` reconstructs `x`) and Workers-safe
 * (zero `node:` imports). Only emitted when strictly token-profitable (>=20%
 * fewer o200k tokens than minified JSON).
 */

import { gptTokenCount, hasLongUnbrokenBpeChunk } from './gpt-tokens.js';

const TOKEN_EXACT_CHAR_LIMIT = 32_000;
const NUMERIC_CELL_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const ESCAPE_NEEDED_RE = /[\\|\n\r]/;
const EDGE_WS_RE = /^\s|\s$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function setOwnProp(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function escapeCellText(s: string): string {
  if (!ESCAPE_NEEDED_RE.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    let rep: string | undefined;
    if (ch === 92) rep = '\\\\';
    else if (ch === 124) rep = '\\|';
    else if (ch === 10) rep = '\\n';
    else if (ch === 13) rep = '\\r';
    if (rep !== undefined) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

function unescapeCellText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[++i]!;
      if (next === '\\') out += '\\';
      else if (next === '|') out += '|';
      else if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else out += '\\' + next;
    } else {
      out += ch;
    }
  }
  return out;
}

function splitEscapedPipes(line: string): string[] {
  const cells: string[] = [];
  let start = 0;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '|') {
      cells.push(line.slice(start, i));
      start = i + 1;
    }
  }
  cells.push(line.slice(start));
  return cells;
}

function encodeCell(v: unknown): string | null {
  if (v === undefined) return '';
  if (v === null) return '~N';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return Object.is(v, -0) ? '0' : String(v);
  }
  if (typeof v === 'string') {
    if (
      v === '' ||
      v === 'true' ||
      v === 'false' ||
      v.startsWith('~') ||
      v.startsWith('@meta ') ||
      v.startsWith('[') ||
      v.startsWith('{') ||
      EDGE_WS_RE.test(v) ||
      NUMERIC_CELL_RE.test(v)
    ) {
      return '~S' + escapeCellText(v);
    }
    return escapeCellText(v);
  }
  if (typeof v === 'object') {
    let serialized: string;
    try {
      serialized = JSON.stringify(v);
    } catch {
      return null;
    }
    if (!serialized || (!serialized.startsWith('[') && !serialized.startsWith('{'))) return null;
    return escapeCellText(serialized);
  }
  return null;
}

function decodeCell(raw: string): unknown {
  if (raw === '' || raw === '~U') return undefined;
  if (raw === '~N') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('~S')) return unescapeCellText(raw.slice(2));
  if (raw.startsWith('[') || raw.startsWith('{')) {
    return JSON.parse(unescapeCellText(raw));
  }
  if (NUMERIC_CELL_RE.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return unescapeCellText(raw);
}

interface TableTarget {
  readonly arrayKey?: string;
  readonly rows: Record<string, unknown>[];
  readonly siblings?: Record<string, unknown>;
  readonly precomputedParts?: ReadonlyArray<{ key: string; json: string }>;
}

function selectTableTarget(parsed: unknown): TableTarget | null {
  if (Array.isArray(parsed)) {
    if (parsed.length < 5 || !parsed.every(isPlainObject)) return null;
    return { rows: parsed };
  }
  if (!isPlainObject(parsed)) return null;
  const entries = Object.entries(parsed);
  let hasCandidate = false;
  for (let i = 0; i < entries.length; i++) {
    const v = entries[i]![1];
    if (Array.isArray(v) && v.length >= 5 && v.every(isPlainObject)) {
      hasCandidate = true;
      break;
    }
  }
  if (!hasCandidate) return null;

  let bestKey: string | undefined;
  let bestRows: Record<string, unknown>[] | undefined;
  let bestLen = 0;
  let totalApproxLen = 2;
  const precomputedParts: Array<{ key: string; json: string }> = [];

  for (const [k, v] of entries) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(v);
    } catch {
      return null;
    }
    if (serialized !== undefined) {
      precomputedParts.push({ key: k, json: serialized });
      totalApproxLen += k.length + 4 + serialized.length;
    }
    const vLen = serialized?.length ?? 0;
    if (Array.isArray(v) && v.length >= 5 && v.every(isPlainObject) && vLen > bestLen) {
      bestKey = k;
      bestRows = v;
      bestLen = vLen;
    }
  }
  if (!bestKey || !bestRows) return null;
  if (bestLen < totalApproxLen * 0.6) return null;

  const siblings: Record<string, unknown> = {};
  let hasSiblings = false;
  for (const [k, v] of entries) {
    if (k !== bestKey && v !== undefined) {
      setOwnProp(siblings, k, v);
      hasSiblings = true;
    }
  }
  return {
    arrayKey: bestKey,
    rows: bestRows,
    siblings: hasSiblings ? siblings : undefined,
    precomputedParts,
  };
}

function estimateTokenPair(minJson: string, toon: string): [number, number] {
  // Always compare both payloads under the same regime (both exact BPE or both
  // char-ratio) so long/unbroken JSON strings never compare heuristic JSON tokens
  // against exact BPE TOON tokens.
  if (
    minJson.length <= TOKEN_EXACT_CHAR_LIMIT &&
    toon.length <= TOKEN_EXACT_CHAR_LIMIT &&
    !hasLongUnbrokenBpeChunk(minJson) &&
    !hasLongUnbrokenBpeChunk(toon)
  ) {
    return [gptTokenCount(minJson), gptTokenCount(toon)];
  }
  return [Math.ceil(minJson.length / 3.5), Math.ceil(toon.length / 3.5)];
}

/**
 * Losslessly encode a uniform array (or object dominated by a uniform array)
 * into `@toon` pipe-delimited columnar format. Returns null if ineligible or
 * if `@toon` does not save at least 20% tokens over minified JSON.
 * Optional `minJsonBox` receives the computed `JSON.stringify(parsed)` string so
 * callers don't serialize `parsed` twice.
 */
export function encodeToon(parsed: unknown, minJsonBox?: { json?: string }): string | null {
  const target = selectTableTarget(parsed);
  if (!target) return null;

  const cols: string[] = [];
  const colSet = new Set<string>();
  let totalFieldCount = 0;
  for (const row of target.rows) {
    for (const k of Object.keys(row)) {
      if (row[k] === undefined) continue;
      totalFieldCount += 1;
      if (!colSet.has(k)) {
        colSet.add(k);
        cols.push(k);
        if (cols.length > 24) return null;
      }
    }
  }
  if (cols.length < 2) return null;
  const density = totalFieldCount / (target.rows.length * cols.length);
  if (density < 0.75) return null;

  let minJson: string;
  const hasCustomToJson =
    !Array.isArray(parsed) &&
    typeof (parsed as { toJSON?: unknown } | null)?.toJSON === 'function';
  if (target.precomputedParts && !hasCustomToJson) {
    try {
      minJson = `{${target.precomputedParts.map((p) => `${JSON.stringify(p.key)}:${p.json}`).join(',')}}`;
    } catch {
      return null;
    }
  } else {
    try {
      minJson = JSON.stringify(parsed);
    } catch {
      return null;
    }
  }
  if (minJsonBox) minJsonBox.json = minJson;
  if (!minJson || minJson.length < 256) return null;

  const encodedCols = cols.map(escapeCellText).join('|');
  const headerParts = ['@toon'];
  if (target.arrayKey !== undefined) {
    try {
      headerParts.push(`key=${encodeURIComponent(target.arrayKey)}`);
    } catch {
      // Lone UTF-16 surrogates throw URIError in encodeURIComponent; bail cleanly to JSON.
      return null;
    }
  }
  headerParts.push(`rows=${target.rows.length}`);
  headerParts.push(`cols=${encodedCols}`);

  const lines: string[] = [headerParts.join(' ')];
  if (target.siblings !== undefined) {
    if (target.precomputedParts && !hasCustomToJson) {
      try {
        const siblingParts = target.precomputedParts
          .filter((p) => p.key !== target.arrayKey)
          .map((p) => `${JSON.stringify(p.key)}:${p.json}`);
        lines.push(`@meta {${siblingParts.join(',')}}`);
      } catch {
        return null;
      }
    } else {
      try {
        lines.push(`@meta ${JSON.stringify(target.siblings)}`);
      } catch {
        return null;
      }
    }
  }

  for (const row of target.rows) {
    const cells: string[] = [];
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c]!;
      const has = Object.prototype.hasOwnProperty.call(row, col);
      const cell = encodeCell(has ? row[col] : undefined);
      if (cell === null) return null;
      cells.push(cell);
    }
    lines.push(cells.join('|'));
  }

  const toon = lines.join('\n');
  if (toon.length >= minJson.length) return null;
  const [jsonTokens, toonTokens] = estimateTokenPair(minJson, toon);
  if (toonTokens > jsonTokens * 0.8) return null;
  return toon;
}

/**
 * Bijectively decode a `@toon` payload back to the exact original JavaScript
 * array or wrapper object. Throws on malformed input.
 */
export function decodeToon(toon: string): unknown {
  const lines = toon.split('\n');
  if (lines.length < 1) throw new Error('Empty @toon payload');
  const header = lines[0]!;
  if (!header.startsWith('@toon ')) throw new Error('Missing @toon header');

  const colsPrefix = ' cols=';
  const rowsColsMatch = / rows=(\d+) cols=/.exec(header);
  const colsIdx = rowsColsMatch
    ? rowsColsMatch.index + rowsColsMatch[0].length - colsPrefix.length
    : header.indexOf(colsPrefix);
  if (colsIdx < 0) throw new Error('Missing cols= in @toon header');
  const metaHeader = header.slice(6, colsIdx).trim();
  const colsRaw = header.slice(colsIdx + colsPrefix.length);
  const cols = splitEscapedPipes(colsRaw).map(unescapeCellText);

  let arrayKey: string | undefined;
  let expectedRows = -1;
  for (const token of metaHeader.split(/\s+/)) {
    if (token.startsWith('key=')) {
      const rawKey = token.slice(4);
      try {
        arrayKey = decodeURIComponent(rawKey);
      } catch {
        arrayKey = unescapeCellText(rawKey);
      }
    } else if (token.startsWith('rows=')) {
      expectedRows = Number.parseInt(token.slice(5), 10);
    }
  }

  let rowStartIdx = 1;
  let siblings: Record<string, unknown> | undefined;
  if (lines[1]?.startsWith('@meta ')) {
    siblings = JSON.parse(lines[1].slice(6)) as Record<string, unknown>;
    rowStartIdx = 2;
  }

  const rows: Record<string, unknown>[] = [];
  for (let i = rowStartIdx; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '' && i === lines.length - 1 && expectedRows === rows.length) break;
    const rawCells = splitEscapedPipes(line);
    if (rawCells.length !== cols.length) {
      throw new Error(`Row ${i} has ${rawCells.length} cells, expected ${cols.length}`);
    }
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < cols.length; c++) {
      const val = decodeCell(rawCells[c]!);
      if (val !== undefined) {
        setOwnProp(obj, cols[c]!, val);
      }
    }
    rows.push(obj);
  }

  if (expectedRows >= 0 && rows.length !== expectedRows) {
    throw new Error(`Expected ${expectedRows} rows, got ${rows.length}`);
  }

  if (arrayKey === undefined) return rows;
  const out: Record<string, unknown> = {};
  if (siblings) {
    for (const [k, v] of Object.entries(siblings)) {
      setOwnProp(out, k, v);
    }
  }
  setOwnProp(out, arrayKey, rows);
  return out;
}
