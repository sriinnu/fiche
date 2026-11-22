import { afterEach, describe, expect, it } from 'vitest';
import { createCasiIndex } from '../src/core/casi-delta.js';
import { clearFactSheetCache, extractFactSheetEntries, factSheetText } from '../src/core/factsheet.js';
import { hasLongNonWhitespaceRun, hasLongUnbrokenBpeChunk } from '../src/core/gpt-tokens.js';
import { bytesToBase64, encodeGrayPng, encodeRgbPng } from '../src/core/png.js';
import { DENSE_RENDER_STYLE, measureContentCols, NL_SENTINEL, renderChunkToPng } from '../src/core/render.js';
import { compileStaticText } from '../src/core/schema-compiler.js';
import { extractStructuralDigest } from '../src/core/text-history.js';
import { cleanToolOutput } from '../src/core/text-hygiene.js';
import { encodeToon } from '../src/core/toon.js';

describe('latency guards & byte-exact hot-path optimizations', () => {
  afterEach(() => {
    clearFactSheetCache();
  });

  it('guards against O(L^2) dotted-line regex backtracking in cleanToolOutput while keeping real file:line anchors', () => {
    const dottedLine = 'sub.domain.segment.'.repeat(2600); // ~50 KB, no :digits
    const log = [
      '2026-11-20T10:00:00Z INFO start run',
      ...Array.from({ length: 1800 }, (_, i) => `2026-11-20T10:00:${String(i % 60).padStart(2, '0')}Z INFO worker step ${i} in 11ms`),
      `2026-11-20T10:01:00Z INFO ${dottedLine}`,
      '2026-11-20T10:02:00Z INFO note see pkg.sub-module.handler.ts:42 details',
      '2026-11-20T10:03:00Z INFO end run',
    ].join('\n');

    const t0 = performance.now();
    const res = cleanToolOutput(log);
    const dt = performance.now() - t0;

    expect(dt).toBeLessThan(150);
    expect(res.text).toContain('pkg.sub-module.handler.ts:42');
    expect(res.text).toContain('[... ');
  });

  it('guards against O(N^2) unclosed HTML comment backtracking in compileStaticText', () => {
    const body = Array.from({ length: 8 }, (_, i) => `Rule paragraph ${i}: keep strict API boundaries cleanly.`.repeat(4)).join('\n\n');
    const unclosed = '<!--unclosed '.repeat(2700) + '\n\n' + body;

    const t0 = performance.now();
    const res = compileStaticText(unclosed);
    const dt = performance.now() - t0;

    expect(dt).toBeLessThan(100);
    expect(res.text).toContain('<!--unclosed ');
  });

  it('bypasses quadratic JS BPE on unbroken non-whitespace blobs across all modules', () => {
    const blob = 'x'.repeat(30_000);
    const denseJson = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, svc: `svc-${i}`, healthy: true })));
    expect(hasLongNonWhitespaceRun(blob)).toBe(true);
    expect(hasLongUnbrokenBpeChunk(blob)).toBe(true);
    expect(hasLongNonWhitespaceRun('short spaced words '.repeat(500))).toBe(false);
    expect(hasLongUnbrokenBpeChunk(denseJson)).toBe(false);

    const t0 = performance.now();
    const cleaned = cleanToolOutput(blob + '\n\n\n\n\n' + 'tail');
    const digest = extractStructuralDigest(blob + '\n' + 'error line', 'r_blob');
    const staticOut = compileStaticText(blob + '\n' + 'line two\n'.repeat(10));
    const toonRows = encodeToon(Array.from({ length: 10 }, (_, i) => ({ id: i, payload: blob.slice(0, 3000) })));
    const dt = performance.now() - t0;

    expect(dt).toBeLessThan(100);
    expect(cleaned.text.length).toBeGreaterThan(0);
    expect(digest).toContain('[fiche epoch-digest r_blob');
    expect(typeof staticOut.changed).toBe('boolean');
    expect(toonRows === null || toonRows.startsWith('@toon ')).toBe(true);
  });

  it('handles multi-hunk CASI deltas in linear O(G) time without gaps.indexOf', () => {
    const baseLines = Array.from({ length: 4000 }, (_, i) => `const entry_${i} = ${i};`);
    const editedLines = [...baseLines];
    for (let i = 10; i < 3900; i += 6) {
      editedLines[i] = `const entry_${i} = ${i + 999};`;
    }
    const baseText = baseLines.join('\n');
    const editedText = editedLines.join('\n');

    const casi = createCasiIndex();
    casi.ingest(baseText, 'r0', 0);
    const t0 = performance.now();
    const dRes = casi.ingest(editedText, 'r1', 1);
    const dt = performance.now() - t0;

    expect(dt).toBeLessThan(150);
    expect(dRes.text.length).toBeGreaterThan(0);
  });

  it('matches Buffer base64 bit-for-bit and renders valid gray/RGB PNGs + exact factsheets', async () => {
    for (const size of [0, 1, 2, 3, 17, 1024, 65537]) {
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) buf[i] = (i * 131 + 7) & 0xff;
      expect(bytesToBase64(buf)).toBe(Buffer.from(buf).toString('base64'));
    }

    const grayPng = await encodeGrayPng(new Uint8Array(16 * 16).fill(240), 16, 16);
    const rgbPng = await encodeRgbPng(new Uint8Array(16 * 16 * 3).fill(200), 16, 16);
    expect(Array.from(grayPng.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(Array.from(rgbPng.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const colorPng = await renderChunkToPng('line 1\n<user>hi</user>', 64, { ...DENSE_RENDER_STYLE, colorByRole: true }, 728, 'line 1\n\u0001\u0001\u0001\u0001\u0001\u0001hi\u0001\u0001\u0001\u0001\u0001\u0001\u0001');
    expect(Array.from(colorPng.png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    // Streaming measureContentCols handles tabs, markers, emojis, and cap exit accurately
    expect(measureContentCols('abc', 100)).toBe(3);
    expect(measureContentCols('\tabc', 100)).toBe(7);
    expect(measureContentCols(`a${NL_SENTINEL}b`, 100, 1)).toBe(5);
    expect(measureContentCols('x'.repeat(50_000), 312)).toBe(312);

    const fsInput = [
      'Deployed service=checkout-api version v2.4.1 at https://api.example.com/v2/orders/status',
      'Commit a1b2c3d4e5f6 issue PROJ-1482 user admin@example.com amount $1,250.00 cost EUR42.50',
      'File /workspace/src/core/text-hygiene.ts ACTIVE_MANIFEST=/etc/inkling/config.json --strict-mode',
      'Camel tokenLedgerShard UUID 550e8400-e29b-41d4-a716-446655440000 all-alpha aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ].join('\n');
    const coldEntries = extractFactSheetEntries(fsInput);
    const warmEntries = extractFactSheetEntries(fsInput);
    expect(warmEntries).toEqual(coldEntries);
    expect(factSheetText(fsInput)).toContain('PROJ-1482');
    expect(factSheetText(fsInput)).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});
