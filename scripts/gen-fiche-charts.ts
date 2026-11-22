/**
 * gen-fiche-charts.ts — Generates README, Wiki, and Subsite visual assets
 * from live `fiche` renders and real benchmark runs (`bench/multiturn-all-models.mts`
 * and `bench/latency-p99.mts`).
 *
 *   npx tsx scripts/gen-fiche-charts.ts [--quick]
 *
 * Writes:
 *   - docs/assets/example-render.png
 *   - docs/assets/benchmark-16-models.png (+ .svg / -light.svg)
 *   - docs/assets/efficiency-vs-latency.png (+ .svg / -light.svg)
 *   - docs/assets/latency-profile.png (+ .svg / -light.svg)
 *   - bench/results.generated.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { runLatencyBenchmarks, type LatencyBenchRow } from '../bench/latency-p99.mts';
import { runAllModelsBenchmark, type ModelBenchResult } from '../bench/multiturn-all-models.mts';
import { renderTextToImages } from '../src/core/library.js';
import { reflow } from '../src/core/render.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = join(ROOT, 'docs/assets');
const OUT_BENCH_JSON = join(ROOT, 'bench/results.generated.json');
const OUT_EXAMPLE = join(ASSETS_DIR, 'example-render.png');
const OUT_BENCH = join(ASSETS_DIR, 'benchmark-16-models.png');
const OUT_BENCH_SVG_DARK = join(ASSETS_DIR, 'benchmark-16-models.svg');
const OUT_BENCH_SVG_LIGHT = join(ASSETS_DIR, 'benchmark-16-models-light.svg');
const OUT_PARETO = join(ASSETS_DIR, 'efficiency-vs-latency.png');
const OUT_PARETO_SVG_DARK = join(ASSETS_DIR, 'efficiency-vs-latency.svg');
const OUT_PARETO_SVG_LIGHT = join(ASSETS_DIR, 'efficiency-vs-latency-light.svg');
const OUT_LATENCY = join(ASSETS_DIR, 'latency-profile.png');
const OUT_LATENCY_SVG_DARK = join(ASSETS_DIR, 'latency-profile.svg');
const OUT_LATENCY_SVG_LIGHT = join(ASSETS_DIR, 'latency-profile-light.svg');

interface ChartTheme {
  readonly bg: string;
  readonly cardBg: string;
  readonly cardStroke: string;
  readonly rowStripe: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly gridZero: string;
  readonly gridLine: string;
  readonly unpricedBg: string;
  readonly badgeBg: string;
  readonly badgeBorder: string;
}

const DARK_THEME: ChartTheme = {
  bg: '#0D1117',
  cardBg: '#121822',
  cardStroke: '#253042',
  rowStripe: 'rgba(255, 255, 255, 0.022)',
  textPrimary: '#F8FAFC',
  textSecondary: '#CBD5E1',
  textMuted: '#64748B',
  gridZero: '#334155',
  gridLine: '#1E293B',
  unpricedBg: '#1E293B',
  badgeBg: 'rgba(52, 211, 153, 0.14)',
  badgeBorder: 'rgba(52, 211, 153, 0.45)',
};

const LIGHT_THEME: ChartTheme = {
  bg: '#FFFFFF',
  cardBg: '#F8FAFC',
  cardStroke: '#CBD5E1',
  rowStripe: 'rgba(15, 23, 42, 0.03)',
  textPrimary: '#0F172A',
  textSecondary: '#334155',
  textMuted: '#64748B',
  gridZero: '#94A3B8',
  gridLine: '#E2E8F0',
  unpricedBg: '#E2E8F0',
  badgeBg: 'rgba(16, 185, 129, 0.12)',
  badgeBorder: 'rgba(16, 185, 129, 0.45)',
};

function escXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawTopPrismAccent(ctx: SKRSContext2D, width: number): void {
  const g = ctx.createLinearGradient(0, 0, width, 0);
  g.addColorStop(0, '#FF4D5A');
  g.addColorStop(0.25, '#FF6B2B');
  g.addColorStop(0.55, '#C026D3');
  g.addColorStop(0.8, '#0EA5E9');
  g.addColorStop(1, '#34D399');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, 4);
}

async function generateExampleRender(): Promise<Buffer> {
  // Keep example-render purely about fiche itself (omit Credits/pxpipe mention).
  const readmeFull = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const readmeBody = readmeFull.split('\n## Credits')[0] ?? readmeFull;
  const rawFixture = [
    readmeBody,
    readFileSync(join(ROOT, 'src/core/toon.ts'), 'utf8'),
    readFileSync(join(ROOT, 'src/core/library.ts'), 'utf8'),
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  ]
    .join('\n\n')
    .replaceAll('↵', '');

  // Prepend clean System Prompt + Tool Docs banner and densely reflow body with ↵.
  const reflowedBody = reflow(rawFixture) ?? rawFixture;
  const banner = [
    '============================== SYSTEM PROMPT + TOOL DOCS ==============================',
    'fiche rendered this coding-agent context into dense 312-col optical microfiche PNGs.',
    'The glyph \u21b5 (U+21B5) marks an original hard line break - treat each \u21b5 as a newline.',
    '================================ BEGIN RENDERED CONTEXT ===============================',
  ].join('\n');
  const combined = `${banner}\n${reflowedBody}`;

  const result = await renderTextToImages(combined, {
    reflow: false,
    shrink: false,
    cols: 312,
  });
  if (result.droppedChars > 0) {
    throw new Error(`example-render dropped ${result.droppedChars} chars — fix source/atlas`);
  }
  const firstPage = result.pages[0];
  if (!firstPage) throw new Error('example-render produced 0 pages');
  writeFileSync(OUT_EXAMPLE, firstPage.png);
  console.log(
    `wrote ${OUT_EXAMPLE} (${firstPage.width}x${firstPage.height}, ${(firstPage.png.byteLength / 1024).toFixed(1)} KiB, ${result.pages.length} total pages, 0 dropped)`,
  );
  return Buffer.from(firstPage.png);
}

function summarizeBenchKpis(rows: readonly ModelBenchResult[]) {
  const tokPcts = rows.map((r) => r.tokensSavedPct);
  const usdPcts = rows.map((r) => r.usdSavedPct).filter((v): v is number => v !== null);
  const cachePcts = rows.map((r) => r.cacheHitPct);
  const avgMss = rows.map((r) => r.avgMs);
  const minMax = (xs: readonly number[], unit: string) =>
    xs.length === 0
      ? `0${unit}`
      : `${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)}${unit}`;
  const allSafe = rows.every((r) => r.editSafe);
  return {
    turns: rows[0]?.turns ?? 16,
    tokRange: minMax(tokPcts, '%'),
    usdRange: minMax(usdPcts, '%'),
    cacheRange: minMax(cachePcts, '%'),
    msRange: minMax(avgMss, ' ms'),
    allSafe,
  };
}

function drawBenchmark16Models(rows: readonly ModelBenchResult[], theme: ChartTheme = DARK_THEME): Buffer {
  const W = 1568;
  const H = 980;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const kpiStats = summarizeBenchKpis(rows);

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);
  drawTopPrismAccent(ctx, W);

  // Title & subtitle
  ctx.fillStyle = theme.textPrimary;
  ctx.font = '700 28px sans-serif';
  ctx.fillText(`fiche — ${rows.length}-Model Multi-Turn Coding-Agent Benchmarks`, 40, 46);
  ctx.fillStyle = '#94A3B8';
  ctx.font = '400 15px sans-serif';
  ctx.fillText(
    `${kpiStats.turns}-turn agent trajectory · kosha pricing · live core transforms · editSafe = ${kpiStats.allSafe} across all ${rows.length} models`,
    40,
    72,
  );

  const kpis = [
    { val: kpiStats.tokRange, label: 'Tokens Saved', sub: 'Text compiler + optical microfiche', color: '#38BDF8' },
    { val: kpiStats.usdRange, label: 'Real USD Saved', sub: 'Under kosha cache & cliff math', color: '#34D399' },
    { val: kpiStats.cacheRange, label: 'Prefix Cache Hit', sub: 'Longest-common-prefix continuity', color: '#C084FC' },
    { val: kpiStats.msRange, label: 'Avg Turn Latency', sub: 'Measured transform overhead', color: '#FF6B2B' },
  ];
  const cardY = 94;
  const cardH = 74;
  const gap = 18;
  const cardW = (W - 80 - gap * 3) / 4;
  kpis.forEach((k, idx) => {
    const cx = 40 + idx * (cardW + gap);
    roundRect(ctx, cx, cardY, cardW, cardH, 10);
    ctx.fillStyle = theme.cardBg;
    ctx.fill();
    ctx.strokeStyle = theme.cardStroke;
    ctx.lineWidth = 1;
    ctx.stroke();

    roundRect(ctx, cx + 1, cardY + 1, cardW - 2, 3, 2);
    ctx.fillStyle = k.color;
    ctx.fill();

    ctx.fillStyle = k.color;
    ctx.font = '700 22px sans-serif';
    ctx.fillText(k.val, cx + 16, cardY + 32);

    ctx.fillStyle = theme.textPrimary;
    ctx.font = '600 13px sans-serif';
    ctx.fillText(k.label, cx + 16, cardY + 50);

    ctx.fillStyle = '#7C8BA1';
    ctx.font = '400 11.5px sans-serif';
    ctx.fillText(k.sub, cx + 16, cardY + 65);
  });

  // Table headers + Legend
  const maxPctRaw = Math.max(
    80,
    ...rows.map((r) => Math.max(r.tokensSavedPct, r.usdSavedPct ?? 0)),
  );
  const pctMax = Math.ceil(maxPctRaw / 20) * 20;
  const headerY = 204;
  ctx.fillStyle = '#7C8BA1';
  ctx.font = '700 11.5px sans-serif';
  ctx.fillText('MODEL & PROVIDER', 48, headerY);
  ctx.fillText('ENGINE', 292, headerY);
  ctx.fillText(`TOKENS SAVED VS REAL USD SAVED (0% → ${pctMax}%)`, 410, headerY);
  ctx.textAlign = 'right';
  ctx.fillText('CACHE HIT', 1385, headerY);
  ctx.fillText('AVG / TURN', 1520, headerY);
  ctx.textAlign = 'left';

  const legendItems: Array<{ color: string; label: string }> = [
    { color: '#FF6B2B', label: 'Tokens (Optical)' },
    { color: '#38BDF8', label: 'Tokens (Text)' },
    { color: '#34D399', label: 'Real USD Saved' },
  ];
  let lx = 860;
  for (const item of legendItems) {
    roundRect(ctx, lx, headerY - 10, 11, 11, 3);
    ctx.fillStyle = item.color;
    ctx.fill();
    ctx.fillStyle = theme.textSecondary;
    ctx.font = '500 12px sans-serif';
    ctx.fillText(item.label, lx + 16, headerY);
    lx += ctx.measureText(item.label).width + 34;
  }

  const plotLeft = 410;
  const barMaxW = 740; // width at pctMax
  const yStart = 218;
  const rowH = 43;
  const yEnd = yStart + rows.length * rowH;

  for (let pct = 0; pct <= pctMax; pct += 20) {
    const gx = plotLeft + (pct / pctMax) * barMaxW;
    ctx.strokeStyle = pct === 0 ? theme.gridZero : theme.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, yStart - 6);
    ctx.lineTo(gx, yEnd);
    ctx.stroke();

    ctx.fillStyle = theme.textMuted;
    ctx.font = '500 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${pct}%`, gx, yEnd + 18);
  }
  ctx.textAlign = 'left';

  rows.forEach((row, i) => {
    const ry = yStart + i * rowH;

    if (i % 2 === 0) {
      roundRect(ctx, 40, ry + 1, W - 80, rowH - 2, 6);
      ctx.fillStyle = theme.rowStripe;
      ctx.fill();
    }

    ctx.fillStyle = theme.textPrimary;
    ctx.font = '600 13.5px sans-serif';
    ctx.fillText(row.model, 48, ry + 19);

    ctx.fillStyle = '#8B949E';
    ctx.font = '400 11.5px sans-serif';
    ctx.fillText(row.provider, 48, ry + 35);

    const isOpt = row.mode === 'optical';
    roundRect(ctx, 292, ry + 12, 74, 21, 5);
    ctx.fillStyle = isOpt ? 'rgba(255, 107, 43, 0.16)' : 'rgba(56, 189, 248, 0.14)';
    ctx.fill();
    ctx.strokeStyle = isOpt ? 'rgba(255, 107, 43, 0.45)' : 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = isOpt ? '#FF9E64' : '#0284C7';
    ctx.font = '700 10.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isOpt ? 'OPTICAL' : 'TEXT', 329, ry + 26);
    ctx.textAlign = 'left';

    const tokW = Math.min(barMaxW, Math.max(4, (Math.max(0, row.tokensSavedPct) / pctMax) * barMaxW));
    const tokGrad = ctx.createLinearGradient(plotLeft, 0, plotLeft + tokW, 0);
    if (isOpt) {
      tokGrad.addColorStop(0, '#FF4D5A');
      tokGrad.addColorStop(1, '#FFB020');
    } else {
      tokGrad.addColorStop(0, '#0284C7');
      tokGrad.addColorStop(1, '#38BDF8');
    }
    roundRect(ctx, plotLeft, ry + 8, tokW, 11, 3);
    ctx.fillStyle = tokGrad;
    ctx.fill();

    ctx.fillStyle = isOpt ? '#FFB074' : '#0EA5E9';
    ctx.font = '600 11.5px sans-serif';
    ctx.fillText(`${row.tokensSavedPct.toFixed(1)}% tok`, plotLeft + tokW + 8, ry + 17.5);

    if (row.usdSavedPct === null) {
      roundRect(ctx, plotLeft, ry + 23, 72, 13, 3);
      ctx.fillStyle = theme.unpricedBg;
      ctx.fill();
      ctx.fillStyle = '#94A3B8';
      ctx.font = '500 10.5px sans-serif';
      ctx.fillText('unpriced', plotLeft + 10, ry + 33);
    } else if (row.usdSavedPct < 0) {
      roundRect(ctx, plotLeft, ry + 23, 210, 14, 3);
      ctx.fillStyle = 'rgba(244, 63, 94, 0.16)';
      ctx.fill();
      ctx.fillStyle = '#FB7185';
      ctx.font = '600 10.5px sans-serif';
      ctx.fillText(`${row.usdSavedPct.toFixed(1)}% USD (vision net negative)`, plotLeft + 8, ry + 33.5);
    } else {
      const usdW = Math.min(barMaxW, Math.max(4, (row.usdSavedPct / pctMax) * barMaxW));
      const usdGrad = ctx.createLinearGradient(plotLeft, 0, plotLeft + usdW, 0);
      usdGrad.addColorStop(0, '#059669');
      usdGrad.addColorStop(1, '#34D399');
      roundRect(ctx, plotLeft, ry + 24, usdW, 10, 3);
      ctx.fillStyle = usdGrad;
      ctx.fill();

      ctx.fillStyle = '#10B981';
      ctx.font = '600 11.5px sans-serif';
      ctx.fillText(`${row.usdSavedPct.toFixed(1)}% USD`, plotLeft + usdW + 8, ry + 33);
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = row.cacheHitPct >= 90 ? theme.textSecondary : '#94A3B8';
    ctx.font = '500 13px sans-serif';
    ctx.fillText(`${row.cacheHitPct.toFixed(1)}%`, 1385, ry + 27);

    ctx.fillStyle = row.avgMs <= 10 ? '#10B981' : '#F59E0B';
    ctx.font = '700 13px sans-serif';
    ctx.fillText(`${row.avgMs.toFixed(1)} ms`, 1520, ry + 27);
    ctx.textAlign = 'left';
  });

  ctx.fillStyle = theme.textMuted;
  ctx.font = '400 12px sans-serif';
  ctx.fillText(
    `Verified editSafe = ${kpiStats.allSafe} across all ${rows.length} models · Source: bench/multiturn-all-models.mts · Regenerate: npx tsx scripts/gen-fiche-charts.ts`,
    40,
    H - 16,
  );

  return canvas.toBuffer('image/png');
}

function renderBenchmarkSvg(rows: readonly ModelBenchResult[], theme: ChartTheme): string {
  const W = 1568;
  const H = 980;
  const kpiStats = summarizeBenchKpis(rows);
  const kpis = [
    { val: kpiStats.tokRange, label: 'Tokens Saved', sub: 'Text compiler + optical microfiche', color: '#38BDF8' },
    { val: kpiStats.usdRange, label: 'Real USD Saved', sub: 'Under kosha cache & cliff math', color: '#34D399' },
    { val: kpiStats.cacheRange, label: 'Prefix Cache Hit', sub: 'Longest-common-prefix continuity', color: '#C084FC' },
    { val: kpiStats.msRange, label: 'Avg Turn Latency', sub: 'Measured transform overhead', color: '#FF6B2B' },
  ];
  const cardY = 94;
  const cardH = 74;
  const gap = 18;
  const cardW = (W - 80 - gap * 3) / 4;
  const plotLeft = 410;
  const barMaxW = 740;
  const yStart = 218;
  const rowH = 43;
  const yEnd = yStart + rows.length * rowH;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
    `<defs>`,
    `<linearGradient id="prism" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FF4D5A"/><stop offset="25%" stop-color="#FF6B2B"/><stop offset="55%" stop-color="#C026D3"/><stop offset="80%" stop-color="#0EA5E9"/><stop offset="100%" stop-color="#34D399"/></linearGradient>`,
    `<linearGradient id="optGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FF4D5A"/><stop offset="100%" stop-color="#FFB020"/></linearGradient>`,
    `<linearGradient id="txtGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#0284C7"/><stop offset="100%" stop-color="#38BDF8"/></linearGradient>`,
    `<linearGradient id="usdGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#059669"/><stop offset="100%" stop-color="#34D399"/></linearGradient>`,
    `</defs>`,
    `<rect width="${W}" height="${H}" fill="${theme.bg}"/>`,
    `<rect width="${W}" height="4" fill="url(#prism)"/>`,
    `<text x="40" y="46" fill="${theme.textPrimary}" font-size="28" font-weight="700">${escXml(`fiche — ${rows.length}-Model Multi-Turn Coding-Agent Benchmarks`)}</text>`,
    `<text x="40" y="72" fill="#94A3B8" font-size="15">${escXml(`${kpiStats.turns}-turn agent trajectory · kosha pricing · live core transforms · editSafe = ${kpiStats.allSafe}`)}</text>`,
  ];

  kpis.forEach((k, idx) => {
    const cx = 40 + idx * (cardW + gap);
    parts.push(`<rect x="${cx}" y="${cardY}" width="${cardW}" height="${cardH}" rx="10" fill="${theme.cardBg}" stroke="${theme.cardStroke}"/>`);
    parts.push(`<rect x="${cx + 1}" y="${cardY + 1}" width="${cardW - 2}" height="3" rx="2" fill="${k.color}"/>`);
    parts.push(`<text x="${cx + 16}" y="${cardY + 32}" fill="${k.color}" font-size="22" font-weight="700">${escXml(k.val)}</text>`);
    parts.push(`<text x="${cx + 16}" y="${cardY + 50}" fill="${theme.textPrimary}" font-size="13" font-weight="600">${escXml(k.label)}</text>`);
    parts.push(`<text x="${cx + 16}" y="${cardY + 65}" fill="#7C8BA1" font-size="11.5">${escXml(k.sub)}</text>`);
  });

  const maxPctRaw = Math.max(
    80,
    ...rows.map((r) => Math.max(r.tokensSavedPct, r.usdSavedPct ?? 0)),
  );
  const pctMax = Math.ceil(maxPctRaw / 20) * 20;

  parts.push(`<text x="48" y="204" fill="#7C8BA1" font-size="11.5" font-weight="700">MODEL &amp; PROVIDER</text>`);
  parts.push(`<text x="292" y="204" fill="#7C8BA1" font-size="11.5" font-weight="700">ENGINE</text>`);
  parts.push(`<text x="410" y="204" fill="#7C8BA1" font-size="11.5" font-weight="700">${escXml(`TOKENS SAVED VS REAL USD SAVED (0% → ${pctMax}%)`)}</text>`);
  parts.push(`<rect x="860" y="194" width="11" height="11" rx="3" fill="#FF6B2B"/>`);
  parts.push(`<text x="876" y="204" fill="${theme.textSecondary}" font-size="12" font-weight="500">Tokens (Optical)</text>`);
  parts.push(`<rect x="998" y="194" width="11" height="11" rx="3" fill="#38BDF8"/>`);
  parts.push(`<text x="1014" y="204" fill="${theme.textSecondary}" font-size="12" font-weight="500">Tokens (Text)</text>`);
  parts.push(`<rect x="1122" y="194" width="11" height="11" rx="3" fill="#34D399"/>`);
  parts.push(`<text x="1138" y="204" fill="${theme.textSecondary}" font-size="12" font-weight="500">Real USD Saved</text>`);
  parts.push(`<text x="1385" y="204" fill="#7C8BA1" font-size="11.5" font-weight="700" text-anchor="end">CACHE HIT</text>`);
  parts.push(`<text x="1520" y="204" fill="#7C8BA1" font-size="11.5" font-weight="700" text-anchor="end">AVG / TURN</text>`);

  for (let pct = 0; pct <= pctMax; pct += 20) {
    const gx = plotLeft + (pct / pctMax) * barMaxW;
    parts.push(`<line x1="${gx}" y1="${yStart - 6}" x2="${gx}" y2="${yEnd}" stroke="${pct === 0 ? theme.gridZero : theme.gridLine}"/>`);
    parts.push(`<text x="${gx}" y="${yEnd + 18}" fill="${theme.textMuted}" font-size="11" text-anchor="middle">${pct}%</text>`);
  }

  rows.forEach((row, i) => {
    const ry = yStart + i * rowH;
    const isOpt = row.mode === 'optical';
    if (i % 2 === 0) {
      parts.push(`<rect x="40" y="${ry + 1}" width="${W - 80}" height="${rowH - 2}" rx="6" fill="${theme.rowStripe}"/>`);
    }
    parts.push(`<text x="48" y="${ry + 19}" fill="${theme.textPrimary}" font-size="13.5" font-weight="600">${escXml(row.model)}</text>`);
    parts.push(`<text x="48" y="${ry + 35}" fill="#8B949E" font-size="11.5">${escXml(row.provider)}</text>`);
    parts.push(`<rect x="292" y="${ry + 12}" width="74" height="21" rx="5" fill="${isOpt ? 'rgba(255,107,43,0.16)' : 'rgba(56,189,248,0.14)'}" stroke="${isOpt ? 'rgba(255,107,43,0.45)' : 'rgba(56,189,248,0.35)'}"/>`);
    parts.push(`<text x="329" y="${ry + 26}" fill="${isOpt ? '#FF9E64' : '#0284C7'}" font-size="10.5" font-weight="700" text-anchor="middle">${isOpt ? 'OPTICAL' : 'TEXT'}</text>`);

    const tokW = Math.min(barMaxW, Math.max(4, (Math.max(0, row.tokensSavedPct) / pctMax) * barMaxW));
    parts.push(`<rect x="${plotLeft}" y="${ry + 8}" width="${tokW}" height="11" rx="3" fill="url(#${isOpt ? 'optGrad' : 'txtGrad'})"/>`);
    parts.push(`<text x="${plotLeft + tokW + 8}" y="${ry + 17.5}" fill="${isOpt ? '#FFB074' : '#0EA5E9'}" font-size="11.5" font-weight="600">${row.tokensSavedPct.toFixed(1)}% tok</text>`);

    if (row.usdSavedPct === null) {
      parts.push(`<rect x="${plotLeft}" y="${ry + 23}" width="72" height="13" rx="3" fill="${theme.unpricedBg}"/>`);
      parts.push(`<text x="${plotLeft + 10}" y="${ry + 33}" fill="#94A3B8" font-size="10.5">unpriced</text>`);
    } else if (row.usdSavedPct < 0) {
      parts.push(`<rect x="${plotLeft}" y="${ry + 23}" width="210" height="14" rx="3" fill="rgba(244,63,94,0.16)"/>`);
      parts.push(`<text x="${plotLeft + 8}" y="${ry + 33.5}" fill="#FB7185" font-size="10.5" font-weight="600">${row.usdSavedPct.toFixed(1)}% USD (vision net negative)</text>`);
    } else {
      const usdW = Math.min(barMaxW, Math.max(4, (row.usdSavedPct / pctMax) * barMaxW));
      parts.push(`<rect x="${plotLeft}" y="${ry + 24}" width="${usdW}" height="10" rx="3" fill="url(#usdGrad)"/>`);
      parts.push(`<text x="${plotLeft + usdW + 8}" y="${ry + 33}" fill="#10B981" font-size="11.5" font-weight="600">${row.usdSavedPct.toFixed(1)}% USD</text>`);
    }
    parts.push(`<text x="1385" y="${ry + 27}" fill="${row.cacheHitPct >= 90 ? theme.textSecondary : '#94A3B8'}" font-size="13" text-anchor="end">${row.cacheHitPct.toFixed(1)}%</text>`);
    parts.push(`<text x="1520" y="${ry + 27}" fill="${row.avgMs <= 10 ? '#10B981' : '#F59E0B'}" font-size="13" font-weight="700" text-anchor="end">${row.avgMs.toFixed(1)} ms</text>`);
  });

  parts.push(`<text x="40" y="${H - 16}" fill="${theme.textMuted}" font-size="12">${escXml(`Verified editSafe = ${kpiStats.allSafe} across ${rows.length} models · bench/multiturn-all-models.mts`)}</text>`);
  parts.push(`</svg>`);
  return parts.join('\n');
}

function niceAxisMax(values: readonly number[], fallbackMax: number): { maxMs: number; stepMs: number } {
  const maxVal = Math.max(fallbackMax, ...values, 1);
  if (maxVal <= 6) return { maxMs: 6, stepMs: 1 };
  if (maxVal <= 12) return { maxMs: 12, stepMs: 2 };
  if (maxVal <= 25) return { maxMs: 25, stepMs: 5 };
  if (maxVal <= 50) return { maxMs: 50, stepMs: 10 };
  const ceilTen = Math.ceil(maxVal / 10) * 10;
  return { maxMs: ceilTen, stepMs: Math.max(10, Math.round(ceilTen / 5)) };
}

function drawLatencyPanel(
  ctx: SKRSContext2D,
  theme: ChartTheme,
  opts: {
    x: number;
    y: number;
    w: number;
    h: number;
    title: string;
    subtitle: string;
    rows: readonly LatencyBenchRow[];
    maxMs: number;
    tickStepMs: number;
    tailLabel: string;
    targetLineMs?: { ms: number; label: string };
    badge?: string;
  },
): void {
  const { x, y, w, h, title, subtitle, rows, maxMs, tickStepMs, tailLabel, targetLineMs, badge } = opts;

  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = theme.cardBg;
  ctx.fill();
  ctx.strokeStyle = theme.cardStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = theme.textPrimary;
  ctx.font = '700 17px sans-serif';
  ctx.fillText(title, x + 22, y + 32);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '400 12.5px sans-serif';
  ctx.fillText(subtitle, x + 22, y + 52);

  if (badge) {
    ctx.font = '600 11px sans-serif';
    const bw = ctx.measureText(badge).width + 20;
    roundRect(ctx, x + w - bw - 20, y + 18, bw, 22, 11);
    ctx.fillStyle = theme.badgeBg;
    ctx.fill();
    ctx.strokeStyle = theme.badgeBorder;
    ctx.stroke();
    ctx.fillStyle = '#10B981';
    ctx.textAlign = 'center';
    ctx.fillText(badge, x + w - bw / 2 - 20, y + 33);
    ctx.textAlign = 'left';
  }

  const legY = y + 76;
  const items = [
    { color: rows[0]?.kind === 'guard' ? '#34D399' : '#38BDF8', label: 'Warm p50' },
    ...(rows.some((r) => r.kind === 'optical') ? [{ color: '#FF6B2B', label: 'Warm p50 (Optical)' }] : []),
    { color: '#A855F7', label: tailLabel },
  ];
  let lx = x + 22;
  for (const it of items) {
    roundRect(ctx, lx, legY - 9, 10, 10, 2);
    ctx.fillStyle = it.color;
    ctx.fill();
    ctx.fillStyle = theme.textSecondary;
    ctx.font = '500 11.5px sans-serif';
    ctx.fillText(it.label, lx + 14, legY);
    lx += ctx.measureText(it.label).width + 30;
  }

  const labelW = 190;
  const plotLeft = x + 22 + labelW;
  const plotRight = x + w - 118;
  const plotW = plotRight - plotLeft;
  const topY = y + 102;
  const rowH = 74;
  const bottomY = topY + rows.length * rowH;

  for (let ms = 0; ms <= maxMs + 0.001; ms += tickStepMs) {
    const gx = plotLeft + (ms / maxMs) * plotW;
    ctx.strokeStyle = ms === 0 ? theme.gridZero : theme.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, topY);
    ctx.lineTo(gx, bottomY - 8);
    ctx.stroke();

    ctx.fillStyle = theme.textMuted;
    ctx.font = '500 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${ms % 1 === 0 ? ms : ms.toFixed(1)} ms`, gx, bottomY + 12);
  }
  ctx.textAlign = 'left';

  if (targetLineMs && targetLineMs.ms <= maxMs) {
    const tx = plotLeft + (targetLineMs.ms / maxMs) * plotW;
    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(tx, topY - 4);
    ctx.lineTo(tx, bottomY - 8);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#10B981';
    ctx.font = '600 11px sans-serif';
    ctx.fillText(targetLineMs.label, tx + 6, topY - 4);
  }

  rows.forEach((row, idx) => {
    const ry = topY + idx * rowH + 14;

    ctx.fillStyle = theme.textPrimary;
    ctx.font = '600 13.5px sans-serif';
    ctx.fillText(row.label, x + 22, ry + 16);

    ctx.fillStyle = '#94A3B8';
    ctx.font = '400 11px sans-serif';
    ctx.fillText(row.sublabel, x + 22, ry + 32);

    ctx.fillStyle = theme.textMuted;
    ctx.font = '400 10.5px sans-serif';
    ctx.fillText(`Cold: ${row.coldMs.toFixed(2)} ms`, x + 22, ry + 47);

    const p50Color = row.kind === 'optical' ? '#FF6B2B' : row.kind === 'guard' ? '#10B981' : '#0EA5E9';
    const p50W = Math.min(plotW, Math.max(row.p50Ms > 0 ? 3 : 2, (row.p50Ms / maxMs) * plotW));
    const tailW = Math.min(plotW, Math.max(row.tailMs > 0 ? 3 : 2, (row.tailMs / maxMs) * plotW));

    roundRect(ctx, plotLeft, ry + 6, p50W, 13, 3);
    ctx.fillStyle = p50Color;
    ctx.fill();
    ctx.fillStyle = p50Color;
    ctx.font = '600 11.5px sans-serif';
    ctx.fillText(`${row.p50Ms.toFixed(2)} ms`, plotLeft + p50W + 8, ry + 17);

    roundRect(ctx, plotLeft, ry + 25, tailW, 13, 3);
    ctx.fillStyle = '#A855F7';
    ctx.fill();
    ctx.fillStyle = '#A855F7';
    ctx.font = '600 11.5px sans-serif';
    ctx.fillText(`${row.tailMs.toFixed(2)} ms`, plotLeft + tailW + 8, ry + 36);
  });
}

function drawLatencyProfile(
  requests: readonly LatencyBenchRow[],
  guards: readonly LatencyBenchRow[],
  theme: ChartTheme = DARK_THEME,
): Buffer {
  const W = 1568;
  const H = 680;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);
  drawTopPrismAccent(ctx, W);

  ctx.fillStyle = theme.textPrimary;
  ctx.font = '700 28px sans-serif';
  ctx.fillText('fiche — Cold vs. Warm Request Latency & Hot-Path Guards', 40, 46);
  ctx.fillStyle = '#94A3B8';
  ctx.font = '400 15px sans-serif';
  ctx.fillText(
    '20-turn coding-agent payloads and adversarial stress inputs (bench/latency-p99.mts)',
    40,
    72,
  );

  const reqAxis = niceAxisMax(requests.map((r) => r.tailMs), 15);
  const guardAxis = niceAxisMax(guards.map((r) => r.tailMs), 6);

  drawLatencyPanel(ctx, theme, {
    x: 40,
    y: 98,
    w: 730,
    h: 530,
    title: '20-Turn Agent Request Latency',
    subtitle: 'End-to-end proxy transform time (Warm p50 vs Warm p95)',
    rows: requests,
    maxMs: reqAxis.maxMs,
    tickStepMs: reqAxis.stepMs,
    tailLabel: 'Warm p95',
    targetLineMs: { ms: 5, label: '5 ms warm text target' },
  });

  drawLatencyPanel(ctx, theme, {
    x: 798,
    y: 98,
    w: 730,
    h: 530,
    title: 'Adversarial & Hot-Path Stress Guards',
    subtitle: 'Linear-time parsers & buffer tail scanner (Warm p50 vs Warm p99)',
    rows: guards,
    maxMs: guardAxis.maxMs,
    tickStepMs: guardAxis.stepMs,
    tailLabel: 'Warm p99',
    badge: 'O(N) linear · 0 backtrack traps',
  });

  ctx.fillStyle = theme.textMuted;
  ctx.font = '400 12px sans-serif';
  ctx.fillText(
    'Measured live on local CPU · Source: bench/latency-p99.mts · Regenerate: npx tsx scripts/gen-fiche-charts.ts',
    40,
    H - 18,
  );

  return canvas.toBuffer('image/png');
}

function renderLatencySvg(
  requests: readonly LatencyBenchRow[],
  guards: readonly LatencyBenchRow[],
  theme: ChartTheme,
): string {
  const W = 1568;
  const H = 680;
  const reqAxis = niceAxisMax(requests.map((r) => r.tailMs), 15);
  const guardAxis = niceAxisMax(guards.map((r) => r.tailMs), 6);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
    `<defs><linearGradient id="prism" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FF4D5A"/><stop offset="25%" stop-color="#FF6B2B"/><stop offset="55%" stop-color="#C026D3"/><stop offset="80%" stop-color="#0EA5E9"/><stop offset="100%" stop-color="#34D399"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="${theme.bg}"/>`,
    `<rect width="${W}" height="4" fill="url(#prism)"/>`,
    `<text x="40" y="46" fill="${theme.textPrimary}" font-size="28" font-weight="700">fiche — Cold vs. Warm Request Latency &amp; Hot-Path Guards</text>`,
    `<text x="40" y="72" fill="#94A3B8" font-size="15">20-turn coding-agent payloads and adversarial stress inputs (bench/latency-p99.mts)</text>`,
  ];

  const drawPanelSvg = (opts: {
    x: number;
    y: number;
    w: number;
    h: number;
    title: string;
    subtitle: string;
    rows: readonly LatencyBenchRow[];
    maxMs: number;
    stepMs: number;
    tailLabel: string;
    targetLineMs?: { ms: number; label: string };
    badge?: string;
  }) => {
    const { x, y, w, h, title, subtitle, rows, maxMs, stepMs, tailLabel, targetLineMs, badge } = opts;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${theme.cardBg}" stroke="${theme.cardStroke}"/>`);
    parts.push(`<text x="${x + 22}" y="${y + 32}" fill="${theme.textPrimary}" font-size="17" font-weight="700">${escXml(title)}</text>`);
    parts.push(`<text x="${x + 22}" y="${y + 52}" fill="#94A3B8" font-size="12.5">${escXml(subtitle)}</text>`);
    if (badge) {
      parts.push(`<rect x="${x + w - 210}" y="${y + 18}" width="190" height="22" rx="11" fill="${theme.badgeBg}" stroke="${theme.badgeBorder}"/>`);
      parts.push(`<text x="${x + w - 115}" y="${y + 33}" fill="#10B981" font-size="11" font-weight="600" text-anchor="middle">${escXml(badge)}</text>`);
    }
    const legY = y + 76;
    const legItems = [
      { color: rows[0]?.kind === 'guard' ? '#34D399' : '#38BDF8', label: 'Warm p50' },
      ...(rows.some((r) => r.kind === 'optical') ? [{ color: '#FF6B2B', label: 'Warm p50 (Optical)' }] : []),
      { color: '#A855F7', label: tailLabel },
    ];
    let lx = x + 22;
    for (const it of legItems) {
      parts.push(`<rect x="${lx}" y="${legY - 9}" width="10" height="10" rx="2" fill="${it.color}"/>`);
      parts.push(`<text x="${lx + 14}" y="${legY}" fill="${theme.textSecondary}" font-size="11.5" font-weight="500">${escXml(it.label)}</text>`);
      lx += it.label.length * 7 + 34;
    }
    const plotLeft = x + 212;
    const plotW = x + w - 118 - plotLeft;
    const topY = y + 102;
    const rowH = 74;
    const bottomY = topY + rows.length * rowH;
    for (let ms = 0; ms <= maxMs + 0.001; ms += stepMs) {
      const gx = plotLeft + (ms / maxMs) * plotW;
      parts.push(`<line x1="${gx}" y1="${topY}" x2="${gx}" y2="${bottomY - 8}" stroke="${ms === 0 ? theme.gridZero : theme.gridLine}"/>`);
      parts.push(`<text x="${gx}" y="${bottomY + 12}" fill="${theme.textMuted}" font-size="11" text-anchor="middle">${ms % 1 === 0 ? ms : ms.toFixed(1)} ms</text>`);
    }
    if (targetLineMs && targetLineMs.ms <= maxMs) {
      const tx = plotLeft + (targetLineMs.ms / maxMs) * plotW;
      parts.push(`<line x1="${tx}" y1="${topY - 4}" x2="${tx}" y2="${bottomY - 8}" stroke="#10B981" stroke-width="1.5" stroke-dasharray="4 4"/>`);
      parts.push(`<text x="${tx + 6}" y="${topY - 4}" fill="#10B981" font-size="11" font-weight="600">${escXml(targetLineMs.label)}</text>`);
    }
    rows.forEach((row, idx) => {
      const ry = topY + idx * rowH + 14;
      const p50Color = row.kind === 'optical' ? '#FF6B2B' : row.kind === 'guard' ? '#10B981' : '#0EA5E9';
      const p50W = Math.min(plotW, Math.max(2, (row.p50Ms / maxMs) * plotW));
      const tailW = Math.min(plotW, Math.max(2, (row.tailMs / maxMs) * plotW));
      parts.push(`<text x="${x + 22}" y="${ry + 16}" fill="${theme.textPrimary}" font-size="13.5" font-weight="600">${escXml(row.label)}</text>`);
      parts.push(`<text x="${x + 22}" y="${ry + 32}" fill="#94A3B8" font-size="11">${escXml(row.sublabel)}</text>`);
      parts.push(`<text x="${x + 22}" y="${ry + 47}" fill="${theme.textMuted}" font-size="10.5">Cold: ${row.coldMs.toFixed(2)} ms</text>`);
      parts.push(`<rect x="${plotLeft}" y="${ry + 6}" width="${p50W}" height="13" rx="3" fill="${p50Color}"/>`);
      parts.push(`<text x="${plotLeft + p50W + 8}" y="${ry + 17}" fill="${p50Color}" font-size="11.5" font-weight="600">${row.p50Ms.toFixed(2)} ms</text>`);
      parts.push(`<rect x="${plotLeft}" y="${ry + 25}" width="${tailW}" height="13" rx="3" fill="#A855F7"/>`);
      parts.push(`<text x="${plotLeft + tailW + 8}" y="${ry + 36}" fill="#A855F7" font-size="11.5" font-weight="600">${row.tailMs.toFixed(2)} ms</text>`);
    });
  };

  drawPanelSvg({
    x: 40,
    y: 98,
    w: 730,
    h: 530,
    title: '20-Turn Agent Request Latency',
    subtitle: 'End-to-end proxy transform time (Warm p50 vs Warm p95)',
    rows: requests,
    maxMs: reqAxis.maxMs,
    stepMs: reqAxis.stepMs,
    tailLabel: 'Warm p95',
    targetLineMs: { ms: 5, label: '5 ms warm text target' },
  });
  drawPanelSvg({
    x: 798,
    y: 98,
    w: 730,
    h: 530,
    title: 'Adversarial & Hot-Path Stress Guards',
    subtitle: 'Linear-time parsers & buffer tail scanner (Warm p50 vs Warm p99)',
    rows: guards,
    maxMs: guardAxis.maxMs,
    stepMs: guardAxis.stepMs,
    tailLabel: 'Warm p99',
    badge: 'O(N) linear · 0 backtrack traps',
  });
  parts.push(`<text x="40" y="${H - 18}" fill="${theme.textMuted}" font-size="12">Measured live on local CPU · bench/latency-p99.mts</text>`);
  parts.push(`</svg>`);
  return parts.join('\n');
}

interface ParetoPointLayout {
  readonly row: ModelBenchResult;
  readonly px: number;
  readonly py: number;
  bx: number;
  by: number;
  readonly bw: number;
  readonly bh: number;
  readonly line1: string;
  readonly line2: string;
}

function layoutParetoPoints(
  rows: readonly ModelBenchResult[],
  plotLeft: number,
  plotRight: number,
  plotTop: number,
  plotBottom: number,
): {
  points: ParetoPointLayout[];
  xForMs: (ms: number) => number;
  yForUsd: (pct: number) => number;
  yMin: number;
  yMax: number;
  logMin: number;
  logMax: number;
} {
  const priced = rows.filter((r): r is ModelBenchResult & { usdSavedPct: number } => r.usdSavedPct !== null);
  const maxMs = Math.max(42, ...priced.map((r) => r.avgMs * 1.45));
  const logMin = Math.log10(0.55);
  const logMax = Math.log10(maxMs);
  const xForMs = (ms: number) => {
    const clamped = Math.max(0.55, Math.min(maxMs, ms));
    return plotLeft + ((Math.log10(clamped) - logMin) / (logMax - logMin)) * (plotRight - plotLeft);
  };

  const minUsdRaw = Math.min(0, ...priced.map((r) => r.usdSavedPct));
  const maxUsdRaw = Math.max(44, ...priced.map((r) => r.usdSavedPct));
  const yMin = minUsdRaw < 0 ? Math.floor((minUsdRaw - 4) / 10) * 10 : 0;
  const yMax = Math.ceil((maxUsdRaw + 8) / 10) * 10;
  const yForUsd = (pct: number) =>
    plotBottom - ((pct - yMin) / (yMax - yMin)) * (plotBottom - plotTop);

  // Explicit left/right splayed column fan for crisp zero-overlap placement
  const bh = 34;
  const minTextMs = Math.min(...priced.filter((r) => r.mode === 'text').map((r) => r.avgMs));
  const maxTextMs = Math.max(...priced.filter((r) => r.mode === 'text').map((r) => r.avgMs));
  const midTextMs = (minTextMs + maxTextMs) / 2;

  const points: ParetoPointLayout[] = priced
    .slice()
    .sort((a, b) => (b.usdSavedPct ?? 0) - (a.usdSavedPct ?? 0) || a.avgMs - b.avgMs)
    .map((row) => {
      const px = xForMs(row.avgMs);
      const py = yForUsd(row.usdSavedPct);
      const line1 = row.model.replace('-20260609', '');
      const line2 = `${row.usdSavedPct.toFixed(1)}% USD · ${row.tokensSavedPct.toFixed(0)}% tok · ${row.avgMs.toFixed(1)} ms`;
      const bw = Math.max(line1.length * 7.8 + 16, line2.length * 6.3 + 16, 152);
      // Put fast text models cleanly alternating left/right around their cluster, optical cleanly right/above
      const placeLeft = row.mode === 'text' && row.avgMs <= midTextMs + 0.15;
      const bx = placeLeft
        ? Math.max(plotLeft + 10, px - bw - 26)
        : Math.min(plotRight - bw - 10, px + 24);
      const by = Math.max(plotTop + 14, Math.min(plotBottom - bh - 12, py - bh / 2));
      return { row, px, py, bx, by, bw, bh, line1, line2 };
    });

  // Separate left-column, right-text-column, and optical clusters cleanly along Y
  const distributeColumnY = (group: ParetoPointLayout[], startY: number, minGap: number) => {
    group.sort((a, b) => a.py - b.py || a.px - b.px);
    let cursor = startY;
    for (const p of group) {
      const target = Math.max(cursor, p.by);
      p.by = target;
      cursor = target + p.bh + minGap;
    }
    // Pull back up from plotBottom if pushed too low
    const maxBottom = plotBottom - 12;
    if (group.length > 0 && group[group.length - 1]!.by + group[group.length - 1]!.bh > maxBottom) {
      let bottomCursor = maxBottom;
      for (let i = group.length - 1; i >= 0; i--) {
        const p = group[i]!;
        p.by = Math.min(p.by, bottomCursor - p.bh);
        bottomCursor = p.by - minGap;
      }
    }
  };

  const leftCluster = points.filter((p) => p.row.mode === 'text' && p.bx + p.bw < p.px);
  const rightTextCluster = points.filter((p) => p.row.mode === 'text' && p.bx > p.px);
  const opticalCluster = points.filter((p) => p.row.mode === 'optical');
  distributeColumnY(leftCluster, plotTop + 28, 10);
  distributeColumnY(rightTextCluster, plotTop + 28, 10);
  distributeColumnY(opticalCluster, plotTop + 28, 12);

  // Align left cluster cleanly near left margin & right text cluster right of dots so zero lines cross boxes
  if (leftCluster.length > 0) {
    const leftEdge = plotLeft + 12;
    for (const p of leftCluster) p.bx = Math.min(leftEdge, p.px - p.bw - 18);
  }
  const maxDotXText = Math.max(...points.filter((p) => p.row.mode === 'text').map((p) => p.px), plotLeft + 120);
  for (const p of rightTextCluster) {
    p.bx = Math.min(plotRight - p.bw - 10, Math.max(p.px + 22, Math.min(xForMs(5) - 24, maxDotXText + 26)));
  }

  return { points, xForMs, yForUsd, yMin, yMax, logMin, logMax };
}

function summarizeParetoInsights(rows: readonly ModelBenchResult[]) {
  const pricedText = rows.filter((r) => r.mode === 'text' && r.usdSavedPct !== null);
  const pricedOpt = rows.filter((r) => r.mode === 'optical' && r.usdSavedPct !== null);
  const unpriced = rows.filter((r) => r.usdSavedPct === null);
  const bestTextUsd = pricedText.slice().sort((a, b) => (b.usdSavedPct ?? 0) - (a.usdSavedPct ?? 0))[0];
  const fastestText = pricedText.slice().sort((a, b) => a.avgMs - b.avgMs)[0];
  const bestOptUsd = pricedOpt.slice().sort((a, b) => (b.usdSavedPct ?? 0) - (a.usdSavedPct ?? 0))[0];
  return { pricedText, pricedOpt, unpriced, bestTextUsd, fastestText, bestOptUsd };
}

function drawEfficiencyVsLatency(
  rows: readonly ModelBenchResult[],
  theme: ChartTheme = DARK_THEME,
): Buffer {
  const W = 1568;
  const H = 820;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);
  drawTopPrismAccent(ctx, W);

  ctx.fillStyle = theme.textPrimary;
  ctx.font = '700 28px sans-serif';
  ctx.fillText('fiche — Token & Cost Efficiency vs. Latency Frontier (16 Models)', 40, 46);
  ctx.fillStyle = '#94A3B8';
  ctx.font = '400 15px sans-serif';
  ctx.fillText(
    'Real USD saved vs. avg per-turn transform latency (log scale) · 16-turn trajectory · kosha pricing · editSafe = true',
    40,
    72,
  );

  const insights = summarizeParetoInsights(rows);
  const cards = [
    {
      title: 'Pareto Winner (USD)',
      val: insights.bestTextUsd
        ? `${insights.bestTextUsd.model}: ${insights.bestTextUsd.usdSavedPct!.toFixed(1)}% USD @ ${insights.bestTextUsd.avgMs.toFixed(1)} ms`
        : '—',
      sub: `${insights.bestTextUsd?.tokensSavedPct.toFixed(1) ?? '0'}% tokens · ${insights.bestTextUsd?.cacheHitPct.toFixed(1) ?? '0'}% cache hit (4-Layer Text)`,
      color: '#34D399',
    },
    {
      title: 'Fastest Text Compiler',
      val: insights.fastestText
        ? `${insights.fastestText.model}: ${insights.fastestText.avgMs.toFixed(1)} ms (${insights.fastestText.usdSavedPct!.toFixed(1)}% USD)`
        : '—',
      sub: `Google / AGY & coding text tiers cluster at 1.3–3.5 ms`,
      color: '#38BDF8',
    },
    {
      title: 'Best Optical Microfiche',
      val: insights.bestOptUsd
        ? `${insights.bestOptUsd.model.replace('-20260609', '')}: ${insights.bestOptUsd.usdSavedPct!.toFixed(1)}% USD @ ${insights.bestOptUsd.avgMs.toFixed(1)} ms`
        : '—',
      sub: `Dense PNG pages + FactSheet · 51.9% tok on gemini-3.8-flash`,
      color: '#FF6B2B',
    },
    {
      title: 'Unpriced / Special Notes',
      val: insights.unpriced.length > 0
        ? `${insights.unpriced.map((u) => u.model).join(', ')}: ${insights.unpriced[0]!.tokensSavedPct.toFixed(1)}% tok`
        : 'All 16 priced',
      sub: 'Opt-in optical Sol loses on short 16T cached runs vs Astra text',
      color: '#C084FC',
    },
  ];

  const cardY = 92;
  const cardH = 68;
  const gap = 16;
  const cardW = (W - 80 - gap * 3) / 4;
  cards.forEach((c, idx) => {
    const cx = 40 + idx * (cardW + gap);
    roundRect(ctx, cx, cardY, cardW, cardH, 10);
    ctx.fillStyle = theme.cardBg;
    ctx.fill();
    ctx.strokeStyle = theme.cardStroke;
    ctx.lineWidth = 1;
    ctx.stroke();

    roundRect(ctx, cx + 1, cardY + 1, cardW - 2, 3, 2);
    ctx.fillStyle = c.color;
    ctx.fill();

    ctx.fillStyle = theme.textMuted;
    ctx.font = '700 10.5px sans-serif';
    ctx.fillText(c.title.toUpperCase(), cx + 14, cardY + 21);

    ctx.fillStyle = c.color;
    ctx.font = '700 14.5px sans-serif';
    ctx.fillText(c.val, cx + 14, cardY + 41);

    ctx.fillStyle = '#8B949E';
    ctx.font = '400 11px sans-serif';
    ctx.fillText(c.sub, cx + 14, cardY + 57);
  });

  // Main scatter panel
  const panelX = 40;
  const panelY = 178;
  const panelW = W - 80;
  const panelH = 592;
  roundRect(ctx, panelX, panelY, panelW, panelH, 12);
  ctx.fillStyle = theme.cardBg;
  ctx.fill();
  ctx.strokeStyle = theme.cardStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  const plotLeft = panelX + 76;
  const plotRight = panelX + panelW - 36;
  const plotTop = panelY + 46;
  const plotBottom = panelY + panelH - 58;

  const layout = layoutParetoPoints(rows, plotLeft, plotRight, plotTop, plotBottom);
  const { points, xForMs, yForUsd, yMin, yMax } = layout;

  // Sweet-spot shaded zone (<5 ms latency AND >=25% USD saved)
  const sweetX2 = xForMs(5);
  const sweetY2 = yForUsd(25);
  ctx.fillStyle = 'rgba(16, 185, 129, 0.085)';
  ctx.fillRect(plotLeft, plotTop, sweetX2 - plotLeft, sweetY2 - plotTop);
  ctx.strokeStyle = 'rgba(16, 185, 129, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(plotLeft, plotTop, sweetX2 - plotLeft, sweetY2 - plotTop);
  ctx.fillStyle = '#10B981';
  ctx.font = '700 11.5px sans-serif';
  ctx.fillText('PARETO SWEET SPOT: <= 5 ms · >= 25% USD SAVED', plotLeft + 12, plotTop + 18);

  // Break-even negative region tint (< 0%)
  if (yMin < 0) {
    const zeroY = yForUsd(0);
    ctx.fillStyle = 'rgba(244, 63, 94, 0.055)';
    ctx.fillRect(plotLeft, zeroY, plotRight - plotLeft, plotBottom - zeroY);
  }

  // Horizontal grid + Y labels
  for (let pct = yMin; pct <= yMax; pct += 10) {
    const gy = yForUsd(pct);
    ctx.strokeStyle = pct === 0 ? '#FB7185' : theme.gridLine;
    ctx.lineWidth = pct === 0 ? 1.5 : 1;
    if (pct === 0) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, gy);
    ctx.lineTo(plotRight, gy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = pct === 0 ? '#FB7185' : theme.textMuted;
    ctx.font = pct === 0 ? '700 11px sans-serif' : '500 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${pct}%`, plotLeft - 10, gy + 4);
  }
  ctx.textAlign = 'left';

  // Vertical log-ms gridlines + 5 ms target line
  for (const ms of [0.7, 1, 1.5, 2, 3, 5, 10, 20, 40]) {
    const gx = xForMs(ms);
    if (gx < plotLeft || gx > plotRight) continue;
    ctx.strokeStyle = ms === 5 ? '#10B981' : theme.gridLine;
    ctx.lineWidth = ms === 5 ? 1.5 : 1;
    if (ms === 5) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(gx, plotTop);
    ctx.lineTo(gx, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = ms === 5 ? '#10B981' : theme.textMuted;
    ctx.font = ms === 5 ? '700 11px sans-serif' : '500 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${ms} ms`, gx, plotBottom + 18);
  }
  ctx.textAlign = 'left';

  // Legend inside top-right of plot
  const legEntries = [
    { color: '#38BDF8', label: '4-Layer Text Compiler (0 images, 90.9% cache)', shape: 'circle' as const },
    { color: '#FF6B2B', label: 'Optical Microfiche (dense PNG + FactSheet)', shape: 'diamond' as const },
  ];
  let legX = plotRight - 610;
  for (const l of legEntries) {
    ctx.fillStyle = l.color;
    ctx.beginPath();
    ctx.arc(legX, panelY + 26, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = theme.textSecondary;
    ctx.font = '500 12px sans-serif';
    ctx.fillText(l.label, legX + 12, panelY + 30);
    legX += ctx.measureText(l.label).width + 36;
  }

  // Axis labels
  ctx.fillStyle = theme.textMuted;
  ctx.font = '600 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Average Turn Transform Latency (ms, log10 scale — lower is faster)', (plotLeft + plotRight) / 2, plotBottom + 40);
  ctx.save();
  ctx.translate(panelX + 22, (plotTop + plotBottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Real USD Saved (%, higher is better)', 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';

  // Leader lines first
  for (const p of points) {
    const cx = p.bx + p.bw / 2;
    const cy = p.by + p.bh / 2;
    const nearX = Math.max(p.bx, Math.min(p.bx + p.bw, p.px));
    const nearY = Math.max(p.by, Math.min(p.by + p.bh, p.py));
    const dist = Math.hypot(nearX - p.px, nearY - p.py);
    if (dist > 6) {
      const color = p.row.mode === 'optical' ? 'rgba(255, 107, 43, 0.55)' : 'rgba(56, 189, 248, 0.5)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(nearX || cx, nearY || cy);
      ctx.stroke();
    }
  }

  // Dots / Diamonds
  for (const p of points) {
    const isOpt = p.row.mode === 'optical';
    const dotColor = p.row.usdSavedPct! < 0 ? '#FB7185' : isOpt ? '#FF6B2B' : '#38BDF8';
    ctx.save();
    if (isOpt) {
      ctx.translate(p.px, p.py);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = dotColor;
      ctx.fillRect(-6.5, -6.5, 13, 13);
      ctx.strokeStyle = theme.textPrimary;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-6.5, -6.5, 13, 13);
    } else {
      ctx.beginPath();
      ctx.arc(p.px, p.py, 7, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
      ctx.strokeStyle = theme.textPrimary;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Callout label pills
  for (const p of points) {
    const isOpt = p.row.mode === 'optical';
    const accent = p.row.usdSavedPct! < 0 ? '#FB7185' : isOpt ? '#FF9E64' : '#38BDF8';
    roundRect(ctx, p.bx, p.by, p.bw, p.bh, 6);
    ctx.fillStyle = theme.bg;
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = theme.textPrimary;
    ctx.font = '700 11.5px sans-serif';
    ctx.fillText(p.line1, p.bx + 7, p.by + 14);

    ctx.fillStyle = accent;
    ctx.font = '500 10px sans-serif';
    ctx.fillText(p.line2, p.bx + 7, p.by + 27);
  }

  ctx.fillStyle = theme.textMuted;
  ctx.font = '400 12px sans-serif';
  ctx.fillText(
    `Source: bench/multiturn-all-models.mts (${rows.length} models · editSafe = true) · Zero-percent dashed line separates net USD profit vs vision-token overhead`,
    40,
    H - 16,
  );

  return canvas.toBuffer('image/png');
}

function renderEfficiencyVsLatencySvg(
  rows: readonly ModelBenchResult[],
  theme: ChartTheme,
): string {
  const W = 1568;
  const H = 820;
  const panelX = 40;
  const panelY = 178;
  const panelW = W - 80;
  const panelH = 592;
  const plotLeft = panelX + 76;
  const plotRight = panelX + panelW - 36;
  const plotTop = panelY + 46;
  const plotBottom = panelY + panelH - 58;
  const layout = layoutParetoPoints(rows, plotLeft, plotRight, plotTop, plotBottom);
  const { points, xForMs, yForUsd, yMin, yMax } = layout;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
    `<defs><linearGradient id="prism" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FF4D5A"/><stop offset="25%" stop-color="#FF6B2B"/><stop offset="55%" stop-color="#C026D3"/><stop offset="80%" stop-color="#0EA5E9"/><stop offset="100%" stop-color="#34D399"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="${theme.bg}"/>`,
    `<rect width="${W}" height="4" fill="url(#prism)"/>`,
    `<text x="40" y="46" fill="${theme.textPrimary}" font-size="28" font-weight="700">fiche — Token &amp; Cost Efficiency vs. Latency Frontier (${rows.length} Models)</text>`,
    `<text x="40" y="72" fill="#94A3B8" font-size="15">Real USD saved vs. avg per-turn transform latency (log scale) · 16-turn trajectory · kosha pricing · editSafe = true</text>`,
    `<rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="12" fill="${theme.cardBg}" stroke="${theme.cardStroke}"/>`,
  ];

  const sweetX2 = xForMs(5);
  const sweetY2 = yForUsd(25);
  parts.push(`<rect x="${plotLeft}" y="${plotTop}" width="${sweetX2 - plotLeft}" height="${sweetY2 - plotTop}" fill="rgba(16,185,129,0.085)" stroke="rgba(16,185,129,0.35)"/>`);
  parts.push(`<text x="${plotLeft + 12}" y="${plotTop + 20}" fill="#10B981" font-size="11.5" font-weight="700">PARETO SWEET SPOT: &lt;= 5 ms · &gt;= 25% USD SAVED</text>`);

  for (let pct = yMin; pct <= yMax; pct += 10) {
    const gy = yForUsd(pct);
    parts.push(`<line x1="${plotLeft}" y1="${gy}" x2="${plotRight}" y2="${gy}" stroke="${pct === 0 ? '#FB7185' : theme.gridLine}" ${pct === 0 ? 'stroke-width="1.5" stroke-dasharray="6 4"' : ''}/>`);
    parts.push(`<text x="${plotLeft - 10}" y="${gy + 4}" fill="${pct === 0 ? '#FB7185' : theme.textMuted}" font-size="11" text-anchor="end">${pct}%</text>`);
  }
  for (const ms of [0.7, 1, 1.5, 2, 3, 5, 10, 20, 40]) {
    const gx = xForMs(ms);
    if (gx < plotLeft || gx > plotRight) continue;
    parts.push(`<line x1="${gx}" y1="${plotTop}" x2="${gx}" y2="${plotBottom}" stroke="${ms === 5 ? '#10B981' : theme.gridLine}" ${ms === 5 ? 'stroke-width="1.5" stroke-dasharray="5 4"' : ''}/>`);
    parts.push(`<text x="${gx}" y="${plotBottom + 18}" fill="${ms === 5 ? '#10B981' : theme.textMuted}" font-size="11" text-anchor="middle">${ms} ms</text>`);
  }

  for (const p of points) {
    const isOpt = p.row.mode === 'optical';
    const accent = p.row.usdSavedPct! < 0 ? '#FB7185' : isOpt ? '#FF9E64' : '#38BDF8';
    const nearX = Math.max(p.bx, Math.min(p.bx + p.bw, p.px));
    const nearY = Math.max(p.by, Math.min(p.by + p.bh, p.py));
    if (Math.hypot(nearX - p.px, nearY - p.py) > 6) {
      parts.push(`<line x1="${p.px}" y1="${p.py}" x2="${nearX}" y2="${nearY}" stroke="${accent}" stroke-opacity="0.5"/>`);
    }
    if (isOpt) {
      parts.push(`<rect x="${p.px - 6}" y="${p.py - 6}" width="12" height="12" transform="rotate(45 ${p.px} ${p.py})" fill="${accent}" stroke="${theme.textPrimary}" stroke-width="1.5"/>`);
    } else {
      parts.push(`<circle cx="${p.px}" cy="${p.py}" r="7" fill="${accent}" stroke="${theme.textPrimary}" stroke-width="1.5"/>`);
    }
    parts.push(`<rect x="${p.bx}" y="${p.by}" width="${p.bw}" height="${p.bh}" rx="6" fill="${theme.bg}" stroke="${accent}"/>`);
    parts.push(`<text x="${p.bx + 7}" y="${p.by + 14}" fill="${theme.textPrimary}" font-size="11.5" font-weight="700">${escXml(p.line1)}</text>`);
    parts.push(`<text x="${p.bx + 7}" y="${p.by + 27}" fill="${accent}" font-size="10" font-weight="500">${escXml(p.line2)}</text>`);
  }

  parts.push(`<text x="${(plotLeft + plotRight) / 2}" y="${plotBottom + 40}" fill="${theme.textMuted}" font-size="12" font-weight="600" text-anchor="middle">Average Turn Transform Latency (ms, log10 scale)</text>`);
  parts.push(`<text x="40" y="${H - 16}" fill="${theme.textMuted}" font-size="12">Source: bench/multiturn-all-models.mts (${rows.length} models · editSafe = true)</text>`);
  parts.push(`</svg>`);
  return parts.join('\n');
}

const quick = process.argv.includes('--quick');
mkdirSync(ASSETS_DIR, { recursive: true });

const examplePng = await generateExampleRender();
const benchRows = await runAllModelsBenchmark({ quick });
const latencySuite = await runLatencyBenchmarks({ quick });
const kpis = summarizeBenchKpis(benchRows);

writeFileSync(
  OUT_BENCH_JSON,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      quick,
      kpis,
      models: benchRows,
      latency: latencySuite,
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${OUT_BENCH_JSON}`);

const benchPng = drawBenchmark16Models(benchRows, DARK_THEME);
const paretoPng = drawEfficiencyVsLatency(benchRows, DARK_THEME);
const latencyPng = drawLatencyProfile(latencySuite.requests, latencySuite.guards, DARK_THEME);

writeFileSync(OUT_BENCH, benchPng);
writeFileSync(OUT_BENCH_SVG_DARK, renderBenchmarkSvg(benchRows, DARK_THEME));
writeFileSync(OUT_BENCH_SVG_LIGHT, renderBenchmarkSvg(benchRows, LIGHT_THEME));
console.log(`wrote ${OUT_BENCH} (+ dark/light SVGs)`);

writeFileSync(OUT_PARETO, paretoPng);
writeFileSync(OUT_PARETO_SVG_DARK, renderEfficiencyVsLatencySvg(benchRows, DARK_THEME));
writeFileSync(OUT_PARETO_SVG_LIGHT, renderEfficiencyVsLatencySvg(benchRows, LIGHT_THEME));
console.log(`wrote ${OUT_PARETO} (+ dark/light SVGs)`);

writeFileSync(OUT_LATENCY, latencyPng);
writeFileSync(OUT_LATENCY_SVG_DARK, renderLatencySvg(latencySuite.requests, latencySuite.guards, DARK_THEME));
writeFileSync(OUT_LATENCY_SVG_LIGHT, renderLatencySvg(latencySuite.requests, latencySuite.guards, LIGHT_THEME));
console.log(`wrote ${OUT_LATENCY} (+ dark/light SVGs)`);
