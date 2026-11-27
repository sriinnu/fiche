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
      v.startsWith('@flat ') ||
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
  readonly arrayPath?: readonly string[];
  readonly rows: Record<string, unknown>[];
  readonly siblings?: Record<string, unknown>;
  readonly baselineJson?: string;
}

function buildAncestorSiblings(
  obj: Record<string, unknown>,
  path: readonly string[],
  idx: number,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let hasAny = false;
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (k === path[idx]) {
      if (idx + 1 < path.length && isPlainObject(v)) {
        const childSib = buildAncestorSiblings(v, path, idx + 1);
        if (childSib !== undefined) {
          setOwnProp(out, k, childSib);
          hasAny = true;
        }
      }
      continue;
    }
    setOwnProp(out, k, v);
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

function selectTableTarget(parsed: unknown): TableTarget | null {
  if (Array.isArray(parsed)) {
    if (parsed.length < 5 || !parsed.every(isPlainObject)) return null;
    return { rows: parsed };
  }
  if (!isPlainObject(parsed)) return null;

  let baselineJson: string;
  try {
    baselineJson = JSON.stringify(parsed);
  } catch {
    return null;
  }
  if (!baselineJson || baselineJson.length < 256) return null;

  let bestPath: string[] | undefined;
  let bestRows: Record<string, unknown>[] | undefined;
  let bestLen = 0;

  const scan = (node: Record<string, unknown>, prefix: string[], depth: number): void => {
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined) continue;
      if (depth > 0 && k.includes('/')) continue;
      if (Array.isArray(v) && v.length >= 5 && v.every(isPlainObject)) {
        // Depth > 1 paths cannot contain '/' in any segment because key= uses '/' as separator.
        if (depth > 0 && prefix.some((seg) => seg.includes('/'))) continue;
        let vLen = 0;
        try {
          vLen = JSON.stringify(v).length;
        } catch {
          continue;
        }
        if (vLen > bestLen) {
          bestPath = [...prefix, k];
          bestRows = v;
          bestLen = vLen;
        }
      } else if (depth < 2 && isPlainObject(v) && !k.includes('/')) {
        scan(v, [...prefix, k], depth + 1);
      }
    }
  };

  scan(parsed, [], 0);
  if (!bestPath || !bestRows) return null;
  if (bestLen < baselineJson.length * 0.6) return null;

  const siblings = buildAncestorSiblings(parsed, bestPath, 0);
  return {
    arrayPath: bestPath,
    rows: bestRows,
    siblings,
    baselineJson,
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

const MAX_TOON_COLS = 48;
const MIN_TOON_DENSITY = 0.55;

interface FlattenedCol {
  readonly colName: string;
  readonly colPath: readonly string[];
}

function getValueAtPath(row: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = row;
  for (let i = 0; i < path.length; i++) {
    if (!cur || typeof cur !== 'object') return undefined;
    const seg = path[i]!;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function collectFlattenedColumns(rows: readonly Record<string, unknown>[]): {
  cols: FlattenedCol[];
  flatPrefixes: string[];
  density: number;
} | null {
  let cols: FlattenedCol[] = [];
  const topSet = new Set<string>();
  let totalFieldCount = 0;

  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (row[k] === undefined) continue;
      totalFieldCount += 1;
      if (!topSet.has(k)) {
        topSet.add(k);
        cols.push({ colName: k, colPath: [k] });
        if (cols.length > MAX_TOON_COLS) return null;
      }
    }
  }
  if (cols.length === 0) return null;

  const flatPrefixes: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    let anyFlattenedThisPass = false;
    const nextCols: FlattenedCol[] = [];
    const existingNames = new Set(cols.map((c) => c.colName));

    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci]!;
      const lastSeg = col.colPath[col.colPath.length - 1]!;
      if (col.colPath.length > 2 || lastSeg.includes('.') || (col.colPath.length === 1 && col.colName.includes('.'))) {
        nextCols.push(col);
        continue;
      }

      const subKeys: string[] = [];
      const subKeySet = new Set<string>();
      let canFlatten = true;
      let presentRows = 0;
      let subFieldCount = 0;

      for (const row of rows) {
        const val = getValueAtPath(row, col.colPath);
        if (val === undefined) continue;
        if (!isPlainObject(val) || typeof (val as { toJSON?: unknown }).toJSON === 'function') {
          canFlatten = false;
          break;
        }
        const ownKeys = Object.keys(val).filter((sk) => val[sk] !== undefined);
        if (ownKeys.length === 0) {
          canFlatten = false;
          break;
        }
        presentRows += 1;
        for (const sk of ownKeys) {
          if (sk.includes('.')) {
            canFlatten = false;
            break;
          }
          subFieldCount += 1;
          if (!subKeySet.has(sk)) {
            subKeySet.add(sk);
            subKeys.push(sk);
          }
        }
        if (!canFlatten) break;
      }

      if (!canFlatten || presentRows === 0 || subKeys.length === 0) {
        nextCols.push(col);
        continue;
      }

      const projectedCount = nextCols.length + (cols.length - ci - 1) + subKeys.length;
      if (projectedCount > MAX_TOON_COLS) {
        nextCols.push(col);
        continue;
      }

      let collision = false;
      for (const sk of subKeys) {
        const flatName = `${col.colName}.${sk}`;
        if (existingNames.has(flatName)) {
          collision = true;
          break;
        }
      }
      if (collision) {
        nextCols.push(col);
        continue;
      }

      const projectedFieldCount = totalFieldCount - presentRows + subFieldCount;
      const projectedDensity = projectedFieldCount / (rows.length * projectedCount);
      if (projectedDensity < MIN_TOON_DENSITY) {
        nextCols.push(col);
        continue;
      }

      existingNames.delete(col.colName);
      for (const sk of subKeys) {
        const flatName = `${col.colName}.${sk}`;
        existingNames.add(flatName);
        nextCols.push({ colName: flatName, colPath: [...col.colPath, sk] });
      }
      flatPrefixes.push(col.colName);
      totalFieldCount = projectedFieldCount;
      anyFlattenedThisPass = true;
    }

    cols = nextCols;
    if (!anyFlattenedThisPass) break;
  }

  if (cols.length < 2 || cols.length > MAX_TOON_COLS) return null;
  const density = totalFieldCount / (rows.length * cols.length);
  if (density < MIN_TOON_DENSITY) return null;
  return { cols, flatPrefixes, density };
}

function encodeToonTarget(
  target: TableTarget,
  baseline: string,
  isJsonl: boolean,
): string | null {
  if (!baseline || baseline.length < 256) return null;
  const flattened = collectFlattenedColumns(target.rows);
  if (!flattened) return null;
  const { cols, flatPrefixes } = flattened;

  const encodedCols = cols.map((c) => escapeCellText(c.colName)).join('|');
  const headerParts = ['@toon'];
  if (isJsonl) headerParts.push('jsonl=1');
  if (target.arrayPath !== undefined && target.arrayPath.length > 0) {
    try {
      const joinedPath = target.arrayPath.join('/');
      headerParts.push(`key=${encodeURIComponent(joinedPath)}`);
      if (target.arrayPath.length === 1 && target.arrayPath[0]!.includes('/')) {
        headerParts.push('depth=1');
      }
    } catch {
      // Lone UTF-16 surrogates throw URIError in encodeURIComponent; bail cleanly to JSON.
      return null;
    }
  }
  headerParts.push(`rows=${target.rows.length}`);
  headerParts.push(`cols=${encodedCols}`);

  const lines: string[] = [headerParts.join(' ')];
  if (target.siblings !== undefined) {
    try {
      lines.push(`@meta ${JSON.stringify(target.siblings)}`);
    } catch {
      return null;
    }
  }
  if (flatPrefixes.length > 0) {
    try {
      lines.push(`@flat ${flatPrefixes.map(encodeURIComponent).join(',')}`);
    } catch {
      return null;
    }
  }

  for (const row of target.rows) {
    const cells: string[] = [];
    for (let c = 0; c < cols.length; c++) {
      const val = getValueAtPath(row, cols[c]!.colPath);
      const cell = encodeCell(val);
      if (cell === null) return null;
      cells.push(cell);
    }
    lines.push(cells.join('|'));
  }

  const toon = lines.join('\n');
  if (toon.length >= baseline.length) return null;
  const [baseTokens, toonTokens] = estimateTokenPair(baseline, toon);
  if (toonTokens > baseTokens * 0.8) return null;
  return toon;
}

/**
 * Losslessly encode a uniform NDJSON / JSONL string (`>= 5` `{...}` lines) into
 * `@toon jsonl=1` format when strictly token-profitable (<= 0.80x BPE tokens).
 */
export function encodeToonJsonl(text: string): string | null {
  if (typeof text !== 'string' || text.length < 256 || !text.includes('\n')) return null;
  const rawLines = text.split('\n');
  if (rawLines.length < 5) return null;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    if (line.length < 2 || line.charCodeAt(0) !== 123 || line.charCodeAt(line.length - 1) !== 125) {
      return null;
    }
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isPlainObject(parsedLine)) return null;
    rows.push(parsedLine);
  }
  return encodeToonTarget({ rows }, text, true);
}

/**
 * Losslessly encode a uniform array (or object dominated by a uniform array, up to depth 3,
 * or an NDJSON/JSONL string) into `@toon` pipe-delimited columnar format. Returns null if
 * ineligible or if `@toon` does not save at least 20% tokens over minified JSON.
 * Optional `minJsonBox` receives the computed `JSON.stringify(parsed)` string so
 * callers don't serialize `parsed` twice.
 */
export function encodeToon(parsed: unknown, minJsonBox?: { json?: string }): string | null {
  if (typeof parsed === 'string') {
    return encodeToonJsonl(parsed);
  }
  const target = selectTableTarget(parsed);
  if (!target) return null;

  let minJson: string;
  if (target.baselineJson !== undefined) {
    minJson = target.baselineJson;
  } else {
    try {
      minJson = JSON.stringify(parsed);
    } catch {
      return null;
    }
  }
  if (minJsonBox) minJsonBox.json = minJson;
  return encodeToonTarget(target, minJson, false);
}

/**
 * Bijectively decode a `@toon` payload back to the exact original JavaScript
 * array, wrapper object, or NDJSON string (`jsonl=1`). Throws on malformed input.
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
  let explicitDepth: number | undefined;
  let isJsonl = false;
  for (const token of metaHeader.split(/\s+/)) {
    if (token === 'jsonl=1') {
      isJsonl = true;
    } else if (token.startsWith('depth=')) {
      explicitDepth = Number.parseInt(token.slice(6), 10);
    } else if (token.startsWith('key=')) {
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
  const flatPrefixes = new Set<string>();
  while (rowStartIdx < lines.length) {
    const dirLine = lines[rowStartIdx]!;
    if (dirLine.startsWith('@meta ')) {
      siblings = JSON.parse(dirLine.slice(6)) as Record<string, unknown>;
      rowStartIdx += 1;
    } else if (dirLine.startsWith('@flat ')) {
      const rawPrefixes = dirLine.slice(6).trim();
      if (rawPrefixes) {
        for (const p of rawPrefixes.split(/[\s,]+/)) {
          if (!p) continue;
          try {
            flatPrefixes.add(decodeURIComponent(p));
          } catch {
            flatPrefixes.add(p);
          }
        }
      }
      rowStartIdx += 1;
    } else {
      break;
    }
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
      if (val === undefined) continue;
      const colName = cols[c]!;
      if (flatPrefixes.size === 0) {
        setOwnProp(obj, colName, val);
        continue;
      }
      let targetObj = obj;
      let rest = colName;
      let prefixAcc = '';
      while (true) {
        const dot = rest.indexOf('.');
        if (dot <= 0) break;
        const seg = rest.slice(0, dot);
        const candidatePrefix = prefixAcc ? `${prefixAcc}.${seg}` : seg;
        if (!flatPrefixes.has(candidatePrefix)) break;
        const existingChild = Object.prototype.hasOwnProperty.call(targetObj, seg)
          ? targetObj[seg]
          : undefined;
        let childObj: Record<string, unknown>;
        if (isPlainObject(existingChild)) {
          childObj = existingChild;
        } else {
          childObj = {};
          setOwnProp(targetObj, seg, childObj);
        }
        targetObj = childObj;
        prefixAcc = candidatePrefix;
        rest = rest.slice(dot + 1);
      }
      setOwnProp(targetObj, rest, val);
    }
    rows.push(obj);
  }

  if (expectedRows >= 0 && rows.length !== expectedRows) {
    throw new Error(`Expected ${expectedRows} rows, got ${rows.length}`);
  }

  if (isJsonl) {
    return rows.map((r) => JSON.stringify(r)).join('\n');
  }
  if (arrayKey === undefined) return rows;
  const out: Record<string, unknown> = {};
  if (siblings) {
    for (const [k, v] of Object.entries(siblings)) {
      setOwnProp(out, k, v);
    }
  }
  const pathSegs =
    explicitDepth === 1 || !arrayKey.includes('/')
      ? [arrayKey]
      : arrayKey.split('/');
  let targetParent: Record<string, unknown> = out;
  for (let i = 0; i < pathSegs.length - 1; i++) {
    const seg = pathSegs[i]!;
    const existingNext = Object.prototype.hasOwnProperty.call(targetParent, seg)
      ? targetParent[seg]
      : undefined;
    let nextObj: Record<string, unknown>;
    if (isPlainObject(existingNext)) {
      nextObj = existingNext;
    } else {
      nextObj = {};
      setOwnProp(targetParent, seg, nextObj);
    }
    targetParent = nextObj;
  }
  setOwnProp(targetParent, pathSegs[pathSegs.length - 1]!, rows);
  return out;
}
