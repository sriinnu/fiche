// Server-rendered HTML dashboard — htmx polls fragments, Alpine drives the toast tray.

import { HTMX_JS, ALPINE_JS } from './vendor.js';
import { CACHE_CREATE_RATE, CACHE_READ_RATE } from '../core/baseline.js';
import type {
  StatsPayload,
  RecentPayload,
  RecentRow,
  SessionsPayload,
  SessionRow,
  FullStatsPayload,
  CurrentSessionPayload,
} from './types.js';

// ---- helpers --------------------------------------------------------

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function numFmt(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

/** "12.3k" / "1.2M" compact formatter for headline numbers. */
function kFmt(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1_000_000) return (v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1) + 'M';
  if (a >= 1000) return (v / 1000).toFixed(a >= 100_000 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function formatDuration(s: number): string {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + 'h ' : '') + (m || h ? m + 'm ' : '') + sec + 's';
}

function shortPath(p: string | null | undefined): string {
  if (!p) return '-';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

// ---- compression toggle (kill switch) ------------------------------------

export function renderToggleFragment(enabled: boolean): string {
  // NOTE: "PASSTHROUGH MODE", "Disable compression", "Enable compression" are asserted by tests.
  const banner = enabled
    ? ''
    : `<div class="banner"><strong>PASSTHROUGH MODE</strong> — compression is off. Every request goes to Claude unchanged: no images, no savings. Use this to A/B test, or if the upstream API is having problems.</div>`;
  // Button POSTs the OPPOSITE of current state; 2s poll keeps it fresh.
  const confirm = enabled
    ? ` hx-confirm="Turn compression off?\n\nRequests will pass straight through to Claude, unchanged. Restarting the proxy turns it back on."`
    : '';
  return (
    `<div class="switch">` +
    `<span class="switch-state ${enabled ? 'on' : 'off'}" title="Kill switch — resets to on when you restart"><span class="switch-dot"></span>${enabled ? 'Compression on' : 'Compression off'}</span>` +
    `<button class="switch-btn" type="button" hx-post="/fragments/toggle" hx-target="#frag-toggle" hx-vals='{"enabled": ${!enabled}}'${confirm}>` +
    (enabled ? 'Disable compression' : 'Enable compression') +
    `</button>` +
    `</div>` +
    banner
  );
}

// ---- compress scope (which models get imaged) ----------------------------

/** Chip catalog — UNION with env scope + active set, so env-var models stay toggleable. Labels are cosmetic. */
const MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Fable 5 (all versions)' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
];

const GPT_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  { id: 'gpt-5.5', label: 'GPT 5.5' },
];

const GROK_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'grok-4.6', label: 'Grok 4.6' },
  { id: 'grok-4.5', label: 'Grok 4.5' },
];

const GEMINI_MODEL_CATALOG: ReadonlyArray<{ id: string; label: string }> = [
  // `gemini` is the family base (default on): covers 3.6/3.7/3.8, Pro, 4, 5 and
  // whatever ships next. The per-version chips are for narrowing scope after
  // opting the family off.
  { id: 'gemini', label: 'Gemini (all versions)' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-4', label: 'Gemini 4' },
];

export function renderModelsFragment(
  active: string[],
  configured: string[],
  enabled: boolean,
): string {
  const on = new Set(active);
  const labelOf = new Map(
    [...MODEL_CATALOG, ...GPT_MODEL_CATALOG, ...GROK_MODEL_CATALOG, ...GEMINI_MODEL_CATALOG].map((m) => [m.id, m.label]),
  );
  // Union the catalog with env-configured + active ids so INKLING_MODELS-enabled
  // families always show as toggles, then split into chip rows (Claude /
  // OpenAI Responses / Gemini) plus the INKLING_MODELS CSV textbox that mirrors the scope.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...MODEL_CATALOG.map((m) => m.id),
    ...GPT_MODEL_CATALOG.map((m) => m.id),
    ...GROK_MODEL_CATALOG.map((m) => m.id),
    ...GEMINI_MODEL_CATALOG.map((m) => m.id),
    ...configured,
    ...active,
  ]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const chipFor = (id: string): string => {
    const lit = on.has(id);
    const label = labelOf.get(id) ?? id;
    return (
      `<button class="chip${lit ? ' on' : ''}" type="button" ` +
      `hx-post="/fragments/models" hx-target="#frag-models" ` +
      `hx-vals='${escapeHtml(`{"model":${JSON.stringify(id)},"on":${!lit}}`)}'>${escapeHtml(label)}${lit ? ' ✓' : ''}</button>`
    );
  };
  const isFirstPartyModel = (id: string): boolean => {
    const base = id.toLowerCase().replace(/\[[^\]]*\]/g, '').split('/').pop() ?? '';
    return (
      base.startsWith('claude') ||
      id.toLowerCase().includes('gemini') ||
      /^(?:gpt|o[134])(?:[-.]|$)/.test(base)
    );
  };
  const claudeChips = ids.filter((id) => id.startsWith('claude')).map(chipFor).join('');
  const geminiChips = ids.filter((id) => id.includes('gemini')).map(chipFor).join('');
  const gptChips = ids.filter((id) => isFirstPartyModel(id) && !id.startsWith('claude') && !id.includes('gemini')).map(chipFor).join('');
  const thirdPartyIds = ids.filter((id) => !isFirstPartyModel(id));
  const thirdPartyChips = thirdPartyIds.map(chipFor).join('');
  const activeThirdParty = thirdPartyIds.filter((id) => on.has(id));
  const firstPartyActive = active.filter((id) => isFirstPartyModel(id));
  const thirdPartyBulkButton =
    activeThirdParty.length > 0
      ? `<button class="mini-btn" type="button" ` +
        `hx-post="/fragments/models" hx-target="#frag-models" ` +
        `hx-vals='${escapeHtml(JSON.stringify({ list: firstPartyActive.join(',') || 'off' }))}'>Disable all third-party (${activeThirdParty.length})</button>`
      : thirdPartyIds.length > 0
        ? `<button class="mini-btn" type="button" ` +
          `hx-post="/fragments/models" hx-target="#frag-models" ` +
          `hx-vals='${escapeHtml(JSON.stringify({ list: [...new Set([...active, ...thirdPartyIds])].join(',') }))}'>Enable third-party</button>`
        : '';
  const moot = enabled
    ? ''
    : `<div class="models"><span class="hint">compression is off — these settings have no effect right now</span></div>`;
  return (
    moot +
    `<div class="models">` +
    `<span class="models-label">Image Claude models</span>` +
    claudeChips +
    `<span class="hint">unlisted models get plain text</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">Image Gemini models</span>` +
    geminiChips +
    `<span class="hint">on by default · toggle off to opt out · 100/100 vision reader</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">Image OpenAI Responses models</span>` +
    gptChips +
    `<span class="hint">opt-in · no Anthropic cache_control</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">Third-party models</span>` +
    thirdPartyChips +
    thirdPartyBulkButton +
    `<span class="hint">4-layer deterministic text hygiene · DeepSeek, Kimi, GLM, Grok</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">FICHE_MODELS</span>` +
    `<input class="models-csv" id="models-csv" type="text" name="list" ` +
    `value="${escapeHtml(active.join(','))}" spellcheck="false" autocomplete="off" ` +
    `hx-post="/fragments/models" hx-target="#frag-models" hx-trigger="change">` +
    `<span class="hint">CSV of bases, or off · applies on enter/blur · export to persist</span>` +
    `</div>`
  );
}

/** Render server-driven 1-click controls for 3rd-party plugins, skills & extensions. */
export function renderPluginsFragment(
  plugins: ReadonlyArray<{ id: string; name: string; kind: string; enabled: boolean }>,
): string {
  const thirdParty = plugins.filter((p) => p.kind !== 'builtin' && p.id !== 'skill:fiche');
  if (thirdParty.length === 0) {
    return `<div class="models"><span class="hint">No 3rd-party plugins or skills discovered in ~/.fiche/plugins or ~/.agents/skills.</span></div>`;
  }
  const activeCount = thirdParty.filter((p) => p.enabled).length;
  const anyOn = activeCount > 0;
  const bulkBtn =
    `<button class="mini-btn" type="button" ` +
    `hx-post="/fragments/plugins" hx-target="#frag-plugins" ` +
    `hx-vals='${escapeHtml(JSON.stringify({ scope: 'third-party', enabled: !anyOn }))}'>` +
    `${anyOn ? `Disable all 3rd-party (${activeCount})` : `Enable all 3rd-party (${thirdParty.length})`}</button>`;
  const chips = thirdParty
    .map((p) => {
      const lit = p.enabled;
      return (
        `<button class="chip${lit ? ' on' : ''}" type="button" ` +
        `hx-post="/fragments/plugins" hx-target="#frag-plugins" ` +
        `hx-vals='${escapeHtml(JSON.stringify({ id: p.id, enabled: !lit }))}'>${escapeHtml(p.name)}${lit ? ' ✓' : ''}</button>`
      );
    })
    .join('');
  return (
    `<div class="models">` +
    `<span class="models-label">3rd-party toggle</span>` +
    bulkBtn +
    `<span class="hint">${activeCount}/${thirdParty.length} active · built-in stages &amp; fiche skill stay on</span>` +
    `</div>` +
    `<div class="models">` +
    `<span class="models-label">Extensions</span>` +
    chips +
    `</div>`
  );
}

// ---- session hero --------------------------------------------------------

// Must stay in lockstep with ASSUMED_INPUT_USD_PER_MTOK in src/dashboard.ts.
const INPUT_USD_PER_MTOK = 10.0;
void INPUT_USD_PER_MTOK; // suppress unused-var; renderHeaderFragment uses the server's pricing block.

// Lifetime hero. Reads the SAME cumulative weighted totals as the header strip
// (serveStats), so the headline and the "$ saved" tiles can never disagree, and
// the number stops swinging on tiny per-session samples. Cache-weighted on
// purpose ("lifeweight"): it answers "did inkling move my real, cache-discounted
// bill since this proxy started", not a raw token count.
export function renderSessionSummaryFragment(s: StatsPayload): string {
  const measured = s.compressed_requests ?? 0;
  if (measured <= 0) {
    return (
      `<div class="hero hero-empty">` +
      `<div class="hero-eyebrow">Since start</div>` +
      `<div class="hero-headline">Warming up…</div>` +
      `<div class="hero-sub">Point Claude Code at this proxy with <code>ANTHROPIC_BASE_URL</code>, or launch it with <code>fiche warp -- claude</code> to keep <code>/remote-control</code> and claude.ai connectors working. Send a message and your running savings show up right here.</div>` +
      `</div>`
    );
  }
  // Cache-aware reduction — same basis as the Details panel + Saved column.
  // Raw count_tokens would over-claim: most of the text baseline would have been
  // cheap cache-reads (~0.1×), not full-price tokens. Weighting both sides at their
  // real cache rate is the only comparison that can't contradict the Saved column.
  // Input-only: inkling never touches output, so lumping it in just dampened the %.
  const baselineW = s.baseline_input_weighted ?? 0; // same context as text, cache-aware
  const actualW = s.actual_input_weighted ?? 0; // what we actually sent, cache-aware
  const outMult = s.pricing_assumptions?.output_multiplier || 5;
  const rawOutput = (s.output_weighted ?? 0) / outMult; // reply — never compressed
  const inputPct = baselineW > 0 ? (1 - actualW / baselineW) * 100 : 0;
  const positive = inputPct >= 0;
  const bigNum = `${Math.abs(inputPct).toFixed(0)}%`;
  const word = positive ? 'fewer tokens' : 'more tokens';

  return (
    `<div class="hero${positive ? '' : ' hero-neg'}">` +
    `<div class="hero-eyebrow">Since start · ${numFmt(measured)} request${measured === 1 ? '' : 's'} imaged</div>` +
    `<div class="hero-headline"><span class="hero-num">${bigNum}</span> ${word}</div>` +
    `<div class="hero-sub">` +
    `<strong>${kFmt(actualW)}</strong> provider-accounted input tokens vs <strong>${kFmt(baselineW)}</strong> if this same context ` +
    `stayed plain text. Your latest messages and model output are never compressed.` +
    `</div>` +
    `<div class="hero-meta">` +
    `Provider-token basis; cache discounts applied where measurable · ` +
    `output untouched (${kFmt(rawOutput)}) · no $ assumptions` +
    `</div>` +
    `</div>`
  );
}

// ---- stat strip + "Show the math" drawer ----------------------------------

function mathRow(key: string, val: number | string | undefined, note = ''): string {
  const v = typeof val === 'number' ? numFmt(val) : String(val ?? '-');
  return `<div><span class="k">${key}:</span> <span class="v">${escapeHtml(v)}</span> <span class="k">${note}</span></div>`;
}

function mathBlock(title: string, body: string): string {
  return `<section class="math-block"><h4>${title}</h4><div class="formula">${body}</div></section>`;
}

/** Stat tile; `tip` adds a hover "?" explainer. */
function statTile(
  label: string,
  value: string,
  sub: string,
  cls = '',
  tip = '',
): string {
  const q = tip
    ? `<span class="q" tabindex="0" aria-label="${escapeHtml(tip)}" data-tip="${escapeHtml(tip)}">?</span>`
    : '';
  return (
    `<div class="tile">` +
    `<div class="tile-label">${label}${q}</div>` +
    `<div class="tile-value ${cls}">${value}</div>` +
    `<div class="tile-sub">${sub}</div>` +
    `</div>`
  );
}

export function renderHeaderFragment(s: StatsPayload, port: number): string {
  const pa = s.pricing_assumptions;
  const unpricedImaged = Math.max(
    0,
    (s.compressed_requests ?? 0) - (s.compressed_paid_requests ?? 0),
  );
  const onlyUnpriced = unpricedImaged > 0 && (s.compressed_paid_requests ?? 0) === 0;

  // Compare the same imaged requests on both sides. Passthrough requests are
  // generally smaller because the profitability gate selected them, so their
  // average is not a valid "without inkling" counterfactual.
  const cAvg = s.compressed_avg_usd_per_request ?? 0;
  const paidImaged = s.compressed_paid_requests ?? 0;
  const withoutAvg = paidImaged > 0 ? cAvg + (s.saved_usd ?? 0) / paidImaged : 0;
  const costTile = paidImaged > 0
    ? statTile(
        'Cost per request',
        `$${cAvg.toFixed(4)}`,
        `vs $${withoutAvg.toFixed(4)} without fiche`,
        cAvg <= withoutAvg ? 'pos' : 'neg',
        'Average cost of paid imaged requests versus the cache-aware text counterfactual for those same requests. Unmeasured requests are assigned zero savings.',
      )
    : onlyUnpriced
      ? statTile(
          'Cost per request',
          '—',
          'provider pricing not configured',
          'muted-val',
          'Token savings are available, but this provider is excluded from Claude-priced dollar estimates.',
        )
      : statTile(
        'Cost per request',
        'collecting…',
        'waiting for a paid imaged request',
        'muted-val',
        'The comparison appears after an imaged request returns provider usage.',
      );

  const savedUsdTile = onlyUnpriced
    ? statTile(
        'Estimated saved',
        '—',
        'provider pricing not configured',
        'muted-val',
        'Token savings are shown separately. Dollar estimates require provider-specific pricing and are not inferred from Claude rates.',
      )
    : statTile(
        'Estimated saved',
        `$${(s.saved_usd ?? 0).toFixed(2)}`,
        unpricedImaged > 0
          ? `${numFmt(unpricedImaged)} provider-priced request${unpricedImaged === 1 ? '' : 's'} excluded`
          : `at $${pa.input_per_mtok}/M base input price`,
        '',
        'Cache-aware estimate for requests covered by the configured pricing assumptions. Other providers remain excluded.',
      );

  const strip =
    `<div class="strip">` +
    statTile('Requests', numFmt(s.requests), `${numFmt(s.compressed_requests)} turned into images`) +
    statTile(
      'Input tokens saved',
      numFmt(s.saved_input_tokens),
      'vs sending the same context as text',
      'pos',
       'Bulky context sent as compact images instead of text. Uses provider-reported input tokens and a measured or model-profile text counterfactual; recent turns and output stay text.',
     ) +
    savedUsdTile +
    costTile +
    `</div>`;

  // math drawer
  const savedMath =
    `<div><span class="k">formula:</span> <span class="v">saved = baseline − actual</span></div>` +
    `<div><span class="k">weights:</span> <span class="v">input×1.0, cache_write_5m×1.25, cache_write_1h×2.0, cache_read×0.10</span></div>` +
    `<div class="sp"></div>` +
    mathRow('baseline', s.baseline_input_weighted, '(cache-aware: cacheable×weight + cold_tail)') +
    mathRow('actual', s.actual_input_weighted, '(input + cc_5m×1.25 + cc_1h×2.0 + cr×0.10)') +
    mathRow('saved', s.saved_input_tokens, `<span class="op">=</span> baseline − actual`) +
    `<span class="src">output excluded — identical with/without compression</span>`;

  const usdMath = onlyUnpriced
    ? `<div><span class="v">Unavailable for this provider.</span></div>` +
      `<span class="src">Token savings are still reported; Claude pricing is not applied across providers.</span>`
    :
    `<div><span class="k">formula:</span> <span class="v">$ saved = saved_tokens × $${pa.input_per_mtok}/Mtok</span></div>` +
    `<div class="sp"></div>` +
    mathRow('saved_tokens', s.saved_input_tokens, '(cache-aware, input-side)') +
    mathRow('saved_usd', `$${(s.saved_usd || 0).toFixed(4)} `, `<span class="op">=</span> saved_tokens × input_rate / 1e6`) +
    `<span class="src">source: ${escapeHtml(pa.source || 'docs.anthropic.com pricing')}</span>`;

  const costPerRequestMath =
    `<div><span class="k">formula:</span> <span class="v">without_fiche = actual_imaged + measured_savings</span></div>` +
    `<div><span class="k">why:</span> <span class="v">both averages cover the same paid imaged requests. Passthrough requests are not used because the profitability gate selects a different, generally smaller population.</span></div>` +
    `<div class="sp"></div>` +
    mathRow(`actual imaged (n=${paidImaged})`, `$${(s.compressed_actual_usd || 0).toFixed(4)}`, `total · avg $${cAvg.toFixed(4)}/req`) +
    mathRow('measured savings', `$${(s.saved_usd || 0).toFixed(4)}`, 'cache-aware input-side total') +
    mathRow('without fiche', `$${withoutAvg.toFixed(4)}/req`, '<span class="op">=</span> (actual imaged + measured savings) / n') +
    `<span class="src">unmeasured imaged rows remain in n and actual cost, with zero assumed savings</span>`;

  const pctMath =
    `<div><span class="k">formula:</span> <span class="v">share_of_spend = saved / (all_baseline_equivalent + all_output × ${pa.output_multiplier})</span></div>` +
    `<div><span class="k">diagnostic, not the headline:</span> <span class="v">this is a counterfactual ("what you WOULD have paid"). It leans on the count_tokens probe, the cache-aware split, and an input-rate assumption. Useful as a sanity check; the real-traffic answer is the compressed-vs-passthrough split above.</span></div>` +
    `<div class="sp"></div>` +
    mathRow('saved', s.saved_input_tokens, '(measured-rows numerator; cache-aware)') +
    mathRow('all_baseline_equivalent', s.all_baseline_equivalent_weighted, '(every paid request; baseline on measured + actual on the rest)') +
    mathRow(`all_output × ${pa.output_multiplier}`, s.all_output_weighted, '(every paid request)') +
    mathRow('share_of_spend', (s.saved_pct_of_all_spend || 0).toFixed(1) + '%', `<span class="op">=</span> saved / counterfactual_total × 100`) +
    mathRow('all_usage_requests', s.all_usage_requests, '(denominator request count — compressed + passthrough + probe-failed)') +
    `<span class="src">measured numerator, all-rows counterfactual denominator — bounded at 100%</span>`;

  const tokeqMath =
    `<div><span class="k">formula:</span> <span class="v">token_equivalent = input + output × ${pa.output_multiplier}</span></div>` +
    `<div><span class="k">why:</span> <span class="v">matches Anthropic's per-Mtok price ratio ($${pa.input_per_mtok} input vs $${pa.input_per_mtok * pa.output_multiplier} output) — this is what the weekly-limit meter counts.</span></div>` +
    `<div class="sp"></div>` +
    mathRow('actual_token_equivalent', s.actual_token_equivalent) +
    mathRow('baseline_token_equivalent', s.baseline_token_equivalent, `(unproxied counterfactual, same ×${pa.output_multiplier} on output)`) +
    `<div class="sp"></div>` +
    mathRow('events_with_measurement', s.events_with_measurement, '(events where the SSE/JSON scanner produced char counts)') +
    mathRow('measured_text_chars', s.measured_text_chars, '') +
    mathRow('measured_thinking_chars', s.measured_thinking_chars, '') +
    mathRow('measured_tool_use_chars', s.measured_tool_use_chars, '') +
    mathRow('measured_redacted_blocks', s.measured_redacted_block_count, '(opaque encrypted blocks — billed but unmeasurable)') +
    `<span class="src">measured — no estimation</span>`;

  const drawer =
    `<details class="drawer" id="math-drawer">` +
    `<summary>Show the math &amp; honesty receipts</summary>` +
    `<div class="drawer-intro">Every number above, derived from the same per-event log. The proxy only moves <em>input</em> tokens; output is shown on both sides so percentages stay honest.</div>` +
    `<div class="math-grid">` +
    mathBlock('Input tokens saved', savedMath) +
    mathBlock('Dollars saved', usdMath) +
    mathBlock('Cost per imaged request', costPerRequestMath) +
    mathBlock('Share of total spend (diagnostic)', pctMath) +
    mathBlock('Token-equivalent (what the weekly cap counts)', tokeqMath) +
    `</div></details>`;

  // NOTE: tests assert the header fragment contains the port number.
  const updated = `<div class="updated"><span class="live-dot"></span>live · port ${port} · uptime ${formatDuration(s.uptime_sec)}</div>`;

  return strip + drawer + updated;
}

// ---- request x-ray (image vs text breakdown) -----------------------------

export interface ContextMapData {
  id: number; // first image id (matches recent-table link)
  baselineTokens: number; // RAW count_tokens as plain text (cache-blind; sub-line only)
  realInput: number; // RAW input + cache_create + cache_read (cache-blind)
  baselineInputEff: number; // cache-WEIGHTED baseline — what text would actually be billed
  actualInputEff: number; // cache-WEIGHTED actual — what the images were actually billed
  haveBaseline: boolean; // weighted pair is trustworthy (baseline probe resolved)
  cacheRead: number; // cache_read tokens this turn. >0 ⇒ the actual request hit cache.
  warm: boolean; // did the TEXT baseline's prefix read warm? Server-observed only:
  // true iff the actual request had cache_read > 0. This keeps the text baseline
  // on the same cache state as the image path; no wall-clock-only inference.
  output: number;
  imageCount: number;
  /** Image blocks the CLIENT sent. They spend from the provider's cap exactly
   *  like ours, so they explain a turn that compressed less than usual. */
  nativeImages?: number;
  /** Image blocks really on the wire. Lower than imageCount when the history
   *  collapse absorbed messages that already carried our images. */
  wireImages?: number;
  /** Imaging steps that degraded to text because the cap was full. */
  imageBudgetSkips?: number;
  baselineImagedTokens?: number;
  buckets: Partial<Record<string, number>>; // bucket → chars rendered to PNG
  imageIds: number[]; // image-ring ids for the gallery
  compressed: boolean;
  model?: string;
  responsesComposition?: {
    instructions: number; systemDeveloper: number; userAssistant: number;
    functionCalls: number; functionOutputs: number; reasoningEncrypted: number;
    compactionOpaque: number; toolsJson: number; other: number;
    totalLocal: number; imageParts: number;
    completedFunctionPairs?: number; recentNativeFunctionPairs?: number;
    oldFunctionPairs?: number; openFunctionCalls?: number;
    orphanFunctionOutputs?: number; malformedFunctionItems?: number;
    imageableFunctionCalls?: number; imageableFunctionOutputs?: number;
    collapsedFunctionPairs?: number; collapsedFunctionCalls?: number;
    collapsedFunctionOutputs?: number;
  };
  /** Difference between the provider text counterfactual and local o200k buckets.
   * Can include envelope, tokenizer, and server-side additions. */
  responsesUnexplainedTokens?: number;
  restored?: boolean; // rebuilt from JSONL after a restart — PNG thumbnails are gone
}

const CTXMAP_BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ['static_slab', 'System prompt + tool docs'],
  ['reminder', 'System-reminder blocks'],
  ['tool_result_prose', 'Tool results — prose'],
  ['tool_result_log', 'Tool results — logs'],
  ['tool_result_json', 'Tool results — JSON'],
  ['history', 'Older conversation turns'],
];

/** Image-vs-text breakdown for one request. */
export function renderContextMapFragment(
  c: ContextMapData | undefined,
  history: ContextMapData[] = [],
  notFound = false,
): string {
  const isLatest = c !== undefined && c.id === (history.at(-1)?.id ?? -1);
  if (notFound) {
    return `<div class="ctxmap"><div class="empty-note">That request's breakdown isn't kept anymore — only the most recent requests are. Pick <strong>Details</strong> on a newer row.</div></div>`;
  }
  if (!c || (c.baselineTokens <= 0 && c.imageCount <= 0)) {
    return `<div class="ctxmap"><div class="empty-note">Pick <strong>Details</strong> on a request to see exactly which parts became images and which stayed as text.</div></div>`;
  }
  // Cache-aware billing-equivalent basis — identical to the recent row's
  // As-text / Sent / Saved/lost columns. These are not raw token counts; they apply
  // Anthropic's cache rates so create/read misses are visible in the comparison.
  // The two panels can never contradict each other. The raw
  // count_tokens ratio is cache-blind: it over-states savings whenever the
  // prefix would have been a cheap cache-read, so it must NOT drive the
  // headline. It survives only as a clarifying sub-line below.
  const showCompare = c.haveBaseline && c.baselineInputEff > 0;
  const base = c.baselineInputEff;
  const real = c.actualInputEff;
  const pct = showCompare ? Math.round((1 - real / base) * 100) : 0;
  const rawShrink = c.baselineTokens > 0 ? Math.round((1 - c.realInput / c.baselineTokens) * 100) : 0;
  const totalImagedChars = CTXMAP_BUCKETS.reduce((a, [key]) => a + (c.buckets[key] ?? 0), 0);

  const imgRows = CTXMAP_BUCKETS.map(([key, label]) => [label, c.buckets[key] ?? 0] as const)
    .filter(([, ch]) => ch > 0)
    .map(
      ([label, ch]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(ch)} chars</span></div>`,
    )
    .join('');

  const rc = c.responsesComposition;
  const responseRows: ReadonlyArray<readonly [string, number]> = rc
    ? [
        ['Instructions', rc.instructions],
        ['System / developer items', rc.systemDeveloper],
        ['User / assistant text kept native', rc.userAssistant],
        ['Native tool JSON', rc.toolsJson],
        ['Tool calls (function + custom)', rc.functionCalls],
        ['Tool outputs (function + custom)', rc.functionOutputs],
        ['Tool outputs eligible in old closed pairs', rc.imageableFunctionOutputs ?? 0],
        ['Tool outputs actually imaged this request', rc.collapsedFunctionOutputs ?? 0],
        ['Reasoning / encrypted items', rc.reasoningEncrypted],
        ['Compaction / opaque items', rc.compactionOpaque],
        ['Other Responses items', rc.other],
      ]
    : [];
  const responseBreakdown = rc
    ? `<div class="split-note" style="margin-top:12px"><strong>Original Responses composition (local o200k estimate)</strong></div>` +
      responseRows.filter(([, n]) => n > 0).map(([label, n]) =>
        `<div class="ctx-row"><span class="ctx-lbl">${label}</span><span class="ctx-val">${kFmt(n)} tok</span></div>`,
      ).join('') +
      `<div class="ctx-row"><span class="ctx-lbl">Imageable text baseline</span><span class="ctx-val">${kFmt(c.baselineImagedTokens ?? 0)} tok</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Completed tool pairs (old / recent native / imaged)</span><span class="ctx-val">${rc.completedFunctionPairs ?? 0} (${rc.oldFunctionPairs ?? 0} / ${rc.recentNativeFunctionPairs ?? 0} / ${rc.collapsedFunctionPairs ?? 0})</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Open calls kept native</span><span class="ctx-val">${rc.openFunctionCalls ?? 0}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Native image parts</span><span class="ctx-val">${rc.imageParts}</span></div>` +
      `<div class="ctx-row"><span class="ctx-lbl">Provider tokens not explained locally</span><span class="ctx-val">${kFmt(c.responsesUnexplainedTokens ?? 0)} tok</span></div>` +
      `<div class="split-note">This diagnostic uses local o200k counts only; it never calls Anthropic /count_tokens.</div>`
    : '';

  const ids = c.imageIds ?? [];
  const modelLabel = c.model ? escapeHtml(c.model) : 'the model';
  const gallery = ids.length
    ? `<div class="pages-title">${ids.length} image page${ids.length === 1 ? '' : 's'} sent to ${modelLabel} — click one to read the exact text behind it:</div>` +
      `<div class="pages">` +
      ids
        .map(
          (id) =>
            `<img class="page" src="/proxy-latest-png?id=${id}" alt="page ${id}" loading="lazy" title="Click to read the source text behind page ${id}" onclick="ppPin(${id});ppSource(true)" onerror="this.classList.add('page-gone'); this.alt='page ${id} expired from buffer';" />`,
        )
        .join('') +
      `</div>`
    : c.restored && c.imageCount > 0
      ? `<div class="pages-title">${c.imageCount} image page${c.imageCount === 1 ? '' : 's'} were sent — thumbnails expired when the proxy restarted. The breakdown above is reconstructed from the saved log.</div>`
      : '';

  // Did the TEXT baseline's prefix read warm this turn? This follows the actual
  // request's observed cache state: cache_read > 0 means warm, cache_read === 0
  // means cold. No wall-clock-only counterfactual is credited.
  const warm = showCompare && c.warm;
  const google = c.model?.startsWith('gemini-') === true;
  const textNoun = warm ? 'cached text' : 'text';
  // Raw count_tokens can grow (imaging bloated a short prompt), so say so rather
  // than rendering a nonsensical "shrank -36%".
  const rawPhrase =
    rawShrink >= 0 ? `Raw content shrank ${rawShrink}%.` : `Raw content grew ${-rawShrink}%.`;
  const headline = !showCompare
    ? `<strong>${kFmt(c.actualInputEff || c.realInput)}</strong> billing-equivalent input tokens sent`
    : pct >= 0
      ? google
        ? `<span class="ctx-big">${pct}%</span> smaller — text would account as <strong>${kFmt(base)}</strong> input tokens; images account as <strong>${kFmt(real)}</strong>`
        : `<span class="ctx-big">${pct}%</span> smaller — ${textNoun} would bill as <strong>${kFmt(base)}</strong> input tokens; images billed as <strong>${kFmt(real)}</strong>`
      : google
        ? `<span class="ctx-big">${-pct}%</span> bigger — images account as <strong>${kFmt(real)}</strong> input tokens vs <strong>${kFmt(base)}</strong> for text`
        : `<span class="ctx-big">${-pct}%</span> bigger — images billed as <strong>${kFmt(real)}</strong> input tokens vs <strong>${kFmt(base)}</strong> for ${textNoun}`;
  // Clarifying sub-line. It must match the actual request's cache state: claiming
  // a 0.1× read discount when cache_read===0 would count hypothetical cache as a
  // inkling effect, so cold rows price both paths cold.
  const subnote = !showCompare
    ? 'Billed tokens count cache discounts (reads at 0.1×) — no trustworthy text baseline for this request yet.'
    : google
      ? `Same provider-token basis as the Saved column. The gap is token count. ${rawPhrase}`
    : !warm
      ? `No warm text cache this turn — the text counterfactual's prefix is priced at the 1.25× create rate (the same event the imaged path pays), identical basis to the Saved column. The gap is purely token count. ${rawPhrase}`
      : pct < 0 && rawShrink > 0
          ? `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. The raw text is ${rawShrink}% smaller, but most of it would have been a cheap cache-read — so imaging it cost more.`
          : `Billed = after cache discounts (reads at 0.1×), same basis as the Saved column. ${rawPhrase}`;
  const title = isLatest ? 'Latest request' : 'Selected request';

  // The provider caps a request at 100 image blocks and counts the CLIENT's
  // images against the same limit. Three facts are worth showing, and only when
  // they are true — a quiet turn should stay quiet:
  //   - the client brought its own images (they shrank our room),
  //   - we rendered more pages than we shipped (the collapse ate some),
  //   - we gave up on imaging something because the cap was full.
  const capBits: string[] = [];
  if ((c.nativeImages ?? 0) > 0) {
    capBits.push(`${c.nativeImages} image${c.nativeImages === 1 ? '' : 's'} came from your side and count against the same 100-image request cap`);
  }
  if (c.wireImages !== undefined && c.wireImages < c.imageCount + (c.nativeImages ?? 0)) {
    const absorbed = c.imageCount + (c.nativeImages ?? 0) - c.wireImages;
    capBits.push(`${absorbed} rendered page${absorbed === 1 ? '' : 's'} never went out — the history collapse absorbed those messages (${c.wireImages} on the wire)`);
  }
  if ((c.imageBudgetSkips ?? 0) > 0) {
    capBits.push(`${c.imageBudgetSkips} block${c.imageBudgetSkips === 1 ? '' : 's'} stayed as text because the image cap was full`);
  }
  const capNote = capBits.length
    ? `<div class="split-note cap-note">${capBits.map(escapeHtml).join(' · ')}</div>`
    : '';


  return (
    `<div class="ctxmap">` +
    `<div class="ctx-headline"><span class="ctx-title">${title}</span> ${headline}</div>` +
    `<div class="split-note ctx-subnote">${subnote}</div>` +
    `<div class="legend"><span class="tag tag-img">Became an image</span><span class="tag tag-txt">Stayed as text</span></div>` +
    `<div class="split">` +
    `<div class="split-col split-img">` +
    `<div class="split-head">Compressed into images <span class="split-sum">${kFmt(totalImagedChars)} chars · ${c.imageCount} page${c.imageCount === 1 ? '' : 's'}</span></div>` +
    (imgRows || `<div class="ctx-row muted-row">nothing imaged this request</div>`) +
    capNote +
    `<div class="split-note">fiche can misread exact values inside images — treat these as gist, not byte-exact.</div>` +
    `</div>` +
    `<div class="split-col split-txt">` +
    `<div class="split-head">Kept as plain text <span class="split-sum">byte-exact</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">Your latest messages</span><span class="ctx-val">verbatim</span></div>` +
    `<div class="ctx-row"><span class="ctx-lbl">Model reply (output)</span><span class="ctx-val">${kFmt(c.output)} tok</span></div>` +
    `<div class="split-note">never imaged — safe for IDs, hashes and exact numbers.</div>` +
    `</div>` +
    `</div>` +
    responseBreakdown +
    gallery +
    `</div>`
  );
}

// ---- recent requests table -----------------------------------------------

function statusCls(status: number): string {
  if (status >= 500) return 'bad';
  if (status >= 400) return 'warn';
  return 'good';
}

export function renderRecentFragment(p: RecentPayload): string {
  const rows = (p.recent ?? []).slice().reverse();
  const body =
    rows.length === 0
      ? `<tr><td colspan="10" class="empty-cell">No requests yet — they stream in here live.</td></tr>`
      : rows
          .map((e: RecentRow, i: number) => {
            const viewId = (e.img_ids ?? (e.img_id != null ? [e.img_id] : []))[0];
            const viewLink =
              viewId != null
                ? `<a class="row-view" href="#" hx-get="/fragments/context-map?req=${viewId}" hx-target="#frag-context-map" hx-swap="innerHTML">Details →</a>`
                : `<span class="muted">—</span>`;
            const saved = e.session_saved_so_far_delta;
            // A loss that disappears when the newly written prefix is repriced at
            // the read rate is just the one-time cache-create premium — the
            // purchase price of the cheap cache reads on the turns that follow.
            // Mark it so create turns don't read as gate failures.
            const cc = e.cache_create ?? 0;
            const createLoss =
              saved != null &&
              saved < 0 &&
              cc > 0 &&
              saved + cc * (CACHE_CREATE_RATE - CACHE_READ_RATE) > 0;
            const createNote = createLoss
              ? ` <span class="mk-create" title="Cache-create turn: this loss is the one-time ${CACHE_CREATE_RATE}× premium for writing ${numFmt(cc)} tokens to cache. Later turns re-read that prefix at ${CACHE_READ_RATE}×, which typically recoups it.">create</span>`
              : '';
            const savedCell = saved == null
              ? `<td class="num muted">—</td>`
              : saved > 0
                ? `<td class="num pos">${numFmt(saved)}</td>`
                : saved < 0
                  ? `<td class="num neg">${numFmt(saved)}${createNote}</td>`
                  : `<td class="num">0</td>`;
            const imaged = e.cc_added
              ? `<span class="badge badge-img">image</span>`
              : `<span class="badge badge-txt">text</span>`;
            return (
              `<tr>` +
              `<td class="muted">${i + 1}</td>` +
              `<td><span class="pill pill-${statusCls(e.status)}">${e.status}</span></td>` +
              `<td class="endp">${escapeHtml(shortPath(e.path))}</td>` +
              `<td>${e.model ? `<code>${escapeHtml(e.model)}</code>` : '<span class="muted">—</span>'}</td>` +
              `<td>${imaged}</td>` +
              `<td class="num">${e.cache_read != null ? numFmt(e.cache_read) : '—'}</td>` +
              `<td class="num">${e.baseline_input != null ? numFmt(e.baseline_input) : '—'}</td>` +
              `<td class="num">${e.actual_input != null ? numFmt(e.actual_input) : '—'}</td>` +
              savedCell +
              `<td class="num">${viewLink}</td>` +
              `</tr>`
            );
          })
          .join('');
  return (
    `<table class="rtable"><thead><tr>` +
    `<th>#</th>` +
    `<th>Result</th>` +
    `<th>Endpoint</th>` +
    `<th>Model</th>` +
    `<th title="Was this request's context compressed into an image?">Sent as</th>` +
    `<th class="num" title="Tokens the provider reported as served from cache">Cache hits</th>` +
    `<th class="num" title="Billing-equivalent input if kept as plain text, after cache create/read rates">As text</th>` +
    `<th class="num" title="Actual billing-equivalent input after imaging, after cache create/read rates">Sent</th>` +
    `<th class="num" title="As-text minus Sent; negative means imaging cost more">Saved/lost</th>` +
    `<th></th>` +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

// ---- image ↔ source inspector --------------------------------------------

export interface LatestFragmentInput {
  payload: RecentPayload;
  pin: number | null; // pinned image id, or null to follow latest
  showSource: boolean;
  sourceText: string | null; // null = not captured
}

export function renderLatestFragment(inp: LatestFragmentInput): string {
  const { payload, pin, showSource, sourceText } = inp;
  const hasPreview = payload.has_preview === true;
  const meta = payload.preview_meta ?? '';
  const imageIds = payload.image_ids ?? [];
  const pinnedEvicted = pin != null && !imageIds.includes(pin);

  // Pinned id, or latest (cache-busted by meta).
  const imgSrc =
    pin != null
      ? `/proxy-latest-png?id=${pin}`
      : `/proxy-latest-png?t=${encodeURIComponent(meta)}`;

  const pinBar =
    pin != null
      ? `<div class="viewer-bar"><button class="mini-btn" type="button" onclick="ppPin(null)">← back to latest</button><span class="mini-label">image #${pin}</span></div>`
      : '';

  let main: string;
  if (pin != null && pinnedEvicted) {
    main = `<div class="evicted">image #${pin} is no longer in the buffer</div>`;
  } else if (pin != null || hasPreview) {
    // When source pane is open the image appears inside the pairing — don't duplicate it.
    main = showSource ? '' : `<div class="frame"><img src="${imgSrc}" alt="rendered page" /></div>`;
  } else {
    main = `<div class="empty-note">No images yet — they appear the instant fiche compresses a request.</div>`;
  }

  const showBtn = pin != null ? !pinnedEvicted : hasPreview;
  const caption =
    pin != null ? `image #${pin}` : meta ? `${escapeHtml(meta)} · top-left at native size` : '';
  const srcBtn = showBtn
    ? `<button class="mini-btn" type="button" onclick="ppSource(${showSource ? 'false' : 'true'})">${showSource ? 'hide source text' : 'show the text behind this image'}</button>`
    : '';

  let pane = '';
  if (showSource) {
    pane =
      sourceText == null
        ? `<div class="evicted">source text wasn't captured for this image</div>`
        : `<div class="pairing">` +
          `<div class="pair-col"><div class="pair-head pair-img">What the model sees · image</div><div class="frame frame-sm"><img src="${imgSrc}" alt="rendered page" /></div></div>` +
          `<div class="pair-mid">made from ↓</div>` +
          `<div class="pair-col"><div class="pair-head pair-txt">The original text · byte-exact</div><pre class="src-pane">${escapeHtml(sourceText)}</pre></div>` +
          `</div>`;
  }

  return pinBar + main + `<div class="viewer-caption">${caption} ${srcBtn}</div>` + pane;
}

// ---- sessions bar chart --------------------------------------------------

const TOP_N = 8;

export function renderSessionsFragment(p: SessionsPayload): string {
  const all = p.sessions ?? [];
  const rows = [...all]
    .sort((a, b) => (b.tokensSavedEst ?? 0) - (a.tokensSavedEst ?? 0))
    .slice(0, TOP_N);
  const max = rows.reduce((m, s) => Math.max(m, s.tokensSavedEst ?? 0), 0);

  const label = (s: SessionRow) => {
    const proj = s.claudeCode?.projectPath || s.project;
    return proj ? shortPath(proj) : s.id.slice(0, 8);
  };
  const barPct = (v: number) => (max <= 0 || v <= 0 ? 0 : (v / max) * 100);

  const status = `<div class="status">${all.length} session${all.length === 1 ? '' : 's'} tracked</div>`;
  if (rows.length === 0) return status + `<div class="empty">No sessions yet.</div>`;

  const chart = rows
    .map((s) => {
      const v = s.tokensSavedEst ?? 0;
      const pct = barPct(v);
      const fill = pct > 0 ? `<div class="bar-fill" style="width:max(3px,${pct}%)"></div>` : '';
      return (
        `<div class="bar-row">` +
        `<div class="bar-label" title="${escapeHtml(s.claudeCode?.projectPath || s.project || s.id)}">${escapeHtml(label(s))}</div>` +
        `<div class="bar-track">${fill}</div>` +
        `<div class="bar-val${v < 0 ? ' neg' : ''}">${numFmt(v)}</div>` +
        `</div>`
      );
    })
    .join('');

  return (
    status +
    `<div class="bars">${chart}</div>` +
    `<div class="axis">tokens saved per session (cache-aware) · top ${rows.length} of ${all.length}</div>`
  );
}

// ---- full-history stats table --------------------------------------------

export function renderStatsTableFragment(p: FullStatsPayload): string {
  if (p.error || !p.summary) {
    return `<div class="status">${escapeHtml(p.error || 'no data')}</div><table class="dtable"><tbody></tbody></table>`;
  }
  const s = p.summary;
  const totalIn = Math.max(
    0,
    (s.inputTokensTotal || 0) +
      (s.cacheCreateTokensTotal || 0) +
      (s.cacheReadTokensTotal || 0) -
      (s.inclusiveCacheReadTotal || 0),
  );
  const hitRateTok = totalIn > 0 ? ((s.cacheReadTokensTotal / totalIn) * 100).toFixed(1) + '%' : '-';
  const hitRateEv =
    s.eventsWithUsage > 0 ? ((s.cacheHitEvents / s.eventsWithUsage) * 100).toFixed(1) + '%' : '-';
  const charRatio =
    s.origCharsTotal > 0 ? ((s.imageBytesTotal / s.origCharsTotal) * 100).toFixed(3) + 'x' : '-';

  // NOTE: the literal word "requests" is asserted by tests.
  const tr = (k: string, v: string) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`;
  return (
    `<div class="status">${numFmt(p.parsed)} events parsed from disk</div>` +
    `<table class="dtable"><tbody>` +
    tr('requests', numFmt(s.total)) +
    tr('2xx / 4xx / 5xx', `${numFmt(s.ok2xx)} / ${numFmt(s.err4xx)} / ${numFmt(s.err5xx)}`) +
    tr('compressed', numFmt(s.compressed)) +
    tr('passthrough', numFmt(s.passthrough)) +
    tr('input tokens', numFmt(s.inputTokensTotal)) +
    tr('cache create', numFmt(s.cacheCreateTokensTotal)) +
    tr('cache read', numFmt(s.cacheReadTokensTotal)) +
    tr('cache hit (by tokens)', hitRateTok) +
    tr('cache hit (by events)', hitRateEv) +
    tr('original chars', numFmt(s.origCharsTotal)) +
    tr('image bytes', numFmt(s.imageBytesTotal)) +
    tr('bytes / char', charRatio) +
    (s.pinEvents
      ? tr(
          'pin footer (uncached)',
          `${numFmt(s.pinCharsTotal ?? 0)} chars / ${numFmt(s.pinEvents)} req`,
        )
      : '') +
    tr('latency p50 / p95', `${numFmt(s.durationP50)} / ${numFmt(s.durationP95)} ms`) +
    tr('first-byte p50 / p95', `${numFmt(s.firstByteP50)} / ${numFmt(s.firstByteP95)} ms`) +
    `</tbody></table>`
  );
}

// ---- page shell -------------------------------------------------------------

// Concept A prismatic optical compression funnel & faceted crystal frame.
// Exported so both the inlined data-URI favicon and /favicon.svg share one source.
export const FICHE_ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="fiche">` +
  `<defs>` +
  `<linearGradient id="fa-top" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FF4D5A"/><stop offset="52%" stop-color="#FF6B2B"/><stop offset="100%" stop-color="#FFB020"/></linearGradient>` +
  `<linearGradient id="fa-mid" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#9333EA"/><stop offset="52%" stop-color="#C026D3"/><stop offset="100%" stop-color="#F43F8E"/></linearGradient>` +
  `<linearGradient id="fa-bot" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#06E3F5"/><stop offset="52%" stop-color="#0EA5E9"/><stop offset="100%" stop-color="#3B82F6"/></linearGradient>` +
  `<linearGradient id="fa-gem-top" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FFD166"/><stop offset="100%" stop-color="#FF70A6"/></linearGradient>` +
  `<linearGradient id="fa-gem-bot" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#C084FC"/><stop offset="100%" stop-color="#9333EA"/></linearGradient>` +
  `</defs>` +
  `<rect x="8" y="8" width="240" height="240" rx="52" fill="#0B0D14" stroke="#1E293B" stroke-width="3"/>` +
  `<g transform="translate(22 22) scale(0.828)">` +
  `<path d="M14 74H62C88 74 96 109 127 109V119C90 119 82 102 62 102H14Z" fill="url(#fa-top)"/>` +
  `<path d="M14 114H62C88 114 96 123 127 123V133C96 133 88 142 62 142H14Z" fill="url(#fa-mid)"/>` +
  `<path d="M14 154H62C82 154 90 137 127 137V147C96 147 88 182 62 182H14Z" fill="url(#fa-bot)"/>` +
  `<path d="M129 104V79H227V177H129V152H114V192H242V64H114V104Z" fill="#FFFFFF"/>` +
  `<polygon points="178,102 165,128 152,128" fill="#FF5447"/>` +
  `<polygon points="178,102 191,128 165,128" fill="url(#fa-gem-top)"/>` +
  `<polygon points="178,102 204,128 191,128" fill="#22D3EE"/>` +
  `<polygon points="152,128 165,128 178,154" fill="#F43F5E"/>` +
  `<polygon points="165,128 191,128 178,154" fill="url(#fa-gem-bot)"/>` +
  `<polygon points="191,128 204,128 178,154" fill="#3B82F6"/>` +
  `</g>` +
  `</svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent(FICHE_ICON_SVG)}`;

const CSS = `
  :root {
    --bg: #f8f9fb; --surface: #ffffff; --surface-2: #f1f3f6;
    --border: #e5e7eb; --border-strong: #d1d5db;
    --ink: #0f172a; --ink-2: #475569; --muted: #64748b;
    --accent: #0f172a; --accent-soft: #f1f5f9;
    --good: #15803d; --good-tint: #ecfdf5;
    --bad: #dc2626; --bad-tint: #fef2f2;
    --warn: #b45309; --warn-tint: #fffbeb;
    --img: #4f46e5; --img-ink: #3730a3; --img-tint: #eef2ff;
    --txt: #0369a1; --txt-ink: #075985; --txt-tint: #f0f9ff;
    --radius: 12px;
    --shadow: 0 1px 2px rgba(15,23,42,0.04);
    --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    --mono: 'JetBrains Mono', 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color-scheme: light;
  }
  /* Dark theme: true graphite obsidian, set before first paint via localStorage 'pp-theme' else system pref. */
  :root[data-theme="dark"] {
    --bg: #0b0d12; --surface: #11141b; --surface-2: #171b24;
    --border: rgba(255,255,255,0.08); --border-strong: rgba(255,255,255,0.14);
    --ink: #f1f5f9; --ink-2: #94a3b8; --muted: #64748b;
    --accent: #e2e8f0; --accent-soft: rgba(255,255,255,0.06);
    --good: #34d399; --good-tint: rgba(52,211,153,0.10);
    --bad: #f87171; --bad-tint: rgba(248,113,113,0.10);
    --warn: #fbbf24; --warn-tint: rgba(251,191,36,0.10);
    --img: #818cf8; --img-ink: #c7d2fe; --img-tint: rgba(129,140,248,0.12);
    --txt: #38bdf8; --txt-ink: #bae6fd; --txt-tint: rgba(56,189,248,0.10);
    --shadow: 0 1px 2px rgba(0,0,0,0.3);
    color-scheme: dark;
  }
  :root[data-theme="dark"] .banner { border-color: rgba(248,113,113,0.28); color: #fecaca; }
  :root[data-theme="dark"] .banner strong { color: #fee2e2; }
  :root[data-theme="dark"] .toast { border-color: rgba(248,113,113,0.28); box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  :root[data-theme="dark"] #routing-help::backdrop { background: rgba(0,0,0,0.65); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 28px 64px; background: var(--bg); color: var(--ink-2);
    font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  .shell { max-width: 1180px; margin: 0 auto; }
  b, strong { color: var(--ink); }
  code { font-family: var(--mono); font-size: 0.9em; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; color: var(--ink); }
  .good { color: var(--good); } .bad { color: var(--bad); }
  .muted { color: var(--muted); }

  /* topbar */
  .topbar { display: flex; align-items: center; justify-content: space-between;
    gap: 16px; flex-wrap: wrap; margin-bottom: 22px; padding-bottom: 16px;
    border-bottom: 1px solid var(--border); }
  .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brand-mark { width: 34px; height: 34px; flex: none; display: block; }
  .wordmark { font-size: 21px; font-weight: 700; color: var(--ink); letter-spacing: -0.03em; line-height: 1.1; }
  .wordmark-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* Which machine is this? Two dashboards from two hosts look identical otherwise. */
  .hostchip { font-size: 11px; font-weight: 600; color: var(--muted); padding: 1px 8px;
    background: var(--surface); border: 1px solid var(--border-strong); border-radius: 999px; white-space: nowrap; }
  .tagline { font-size: 12.5px; color: var(--muted); margin-top: 2px; max-width: 520px; }
  .controls { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
  @media (max-width: 720px) { .controls { justify-content: flex-start; } }
  #frag-toggle { display: contents; }

  /* kill switch */
  .banner { order: 3; flex: 0 0 100%; margin: 4px 0 0; padding: 9px 13px; background: var(--bad-tint);
    border: 1px solid rgba(220,38,38,0.22); border-radius: 8px; color: #991b1b; font-size: 12px; }
  .banner strong { color: #7f1d1d; }
  .switch { order: 2; display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .switch-state { display: inline-flex; align-items: center; gap: 6px; height: 30px; font-size: 12px; font-weight: 600;
    padding: 0 10px; border-radius: 999px; white-space: nowrap; }
  .switch-state.on { color: var(--good); background: var(--good-tint); }
  .switch-state.off { color: var(--bad); background: var(--bad-tint); }
  .switch-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .switch-btn { background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong);
    height: 30px; padding: 0 11px; cursor: pointer; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 500;
    box-shadow: var(--shadow); display: inline-flex; align-items: center; line-height: 1; white-space: nowrap; }
  .switch-btn:hover { border-color: var(--accent); background: var(--accent-soft); }
  .hint { color: var(--muted); font-size: 11px; font-weight: 400; }
  .theme-btn { order: 1; background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong);
    height: 30px; padding: 0 11px; cursor: pointer; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 500;
    box-shadow: var(--shadow); display: inline-flex; align-items: center; gap: 6px; line-height: 1; white-space: nowrap; }
  .theme-btn:hover { border-color: var(--accent); color: var(--ink); background: var(--accent-soft); }

  /* model chips & config dock */
  .config-dock { margin: 16px 0 24px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
  .models { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 18px; }
  .models-label { color: var(--ink-2); font-size: 12px; font-weight: 600; min-width: 170px; }
  .models-csv { flex: 1 1 260px; min-width: 220px; color: var(--ink); background: var(--surface);
    border: 1px solid var(--border-strong); border-radius: 6px; padding: 5px 9px;
    font: 12px/1.4 var(--mono); }
  .models-csv:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .models-routing { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0 0;
    padding-top: 10px; border-top: 1px solid var(--border); }
  #routing-help { border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface);
    color: var(--ink); max-width: 600px; padding: 18px 22px; box-shadow: 0 16px 40px rgba(15,23,42,0.18); }
  #routing-help::backdrop { background: rgba(15, 23, 42, 0.45); }
  #routing-help h3 { margin: 0 0 8px; font-size: 14px; color: var(--ink); }
  #routing-help p, #routing-help li { font-size: 12px; line-height: 1.55; color: var(--ink-2); margin: 6px 0; }
  #routing-help ul { margin: 6px 0; padding-left: 18px; }
  #routing-help code { font: 11px var(--mono); color: var(--ink); }
  #routing-help pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 9px 11px; margin: 8px 0; overflow-x: auto;
    font: 11px/1.5 var(--mono); color: var(--ink); }
  .chip { background: var(--surface); color: var(--ink-2); border: 1px solid var(--border-strong);
    border-radius: 999px; padding: 4px 11px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 500;
    transition: border-color .12s, background .12s, color .12s; }
  .chip:hover { border-color: var(--border-strong); color: var(--ink); background: var(--accent-soft); }
  .chip.on { background: var(--accent); color: var(--surface); border-color: var(--accent);
    font-weight: 600; }
  .chip.on:hover { background: var(--accent); color: var(--surface); border-color: var(--accent); opacity: 0.9; }

  /* collapsed config drawers (#116): <details> lives in the static shell — NOT
     inside #frag-models — so the 2s poll never resets open state. */
  .models-collapse { margin: 0; border-bottom: 1px solid var(--border); }
  .models-collapse:last-child { border-bottom: none; }
  .models-collapse .models { margin: 0 0 10px; }
  .models-collapse .models:last-child { margin-bottom: 0; }
  .models-summary { cursor: pointer; list-style: none; padding: 11px 16px; color: var(--ink);
    font-size: 12.5px; font-weight: 600; margin: 0; user-select: none;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .models-summary::-webkit-details-marker { display: none; }
  .models-summary::before { content: '▸'; color: var(--muted); font-size: 10px; }
  .models-collapse[open] > .models-summary::before { content: '▾'; }
  .models-summary:hover { background: var(--surface-2); color: var(--ink); }
  .dock-body { padding: 12px 16px 16px; border-top: 1px solid var(--border); font-size: 12.5px; color: var(--ink-2); }
  .dock-body p { margin: 0 0 10px; }
  .dock-body p:last-child { margin-bottom: 0; }
  .dock-body pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 9px 12px; margin: 0 0 12px; overflow-x: auto; font: 12px/1.5 var(--mono); color: var(--ink); }
  .models-warning { color: var(--ink-2); background: var(--warn-tint); border: 1px solid var(--border);
    border-left: 2px solid var(--warn); border-radius: 8px; padding: 8px 12px; font-size: 12px;
    margin: 0 0 12px; }

  /* session hero */
  #frag-session { display: block; margin-bottom: 14px; }
  .hero { background: var(--surface); border: 1px solid var(--border);
    border-top: 2px solid var(--good); border-radius: var(--radius); padding: 22px 26px; box-shadow: var(--shadow); }
  .hero-neg { border-top-color: var(--bad); }
  .hero-empty { border-top-color: var(--border-strong); }
  .hero-eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 8px; }
  .hero-headline { font-size: 24px; font-weight: 600; color: var(--ink); letter-spacing: -0.025em; line-height: 1.15; }
  .hero-num { font-size: 46px; font-weight: 700; letter-spacing: -0.04em; line-height: 1; margin-right: 8px;
    color: var(--good); font-variant-numeric: tabular-nums; }
  .hero-neg .hero-num { color: var(--bad); }
  .hero-sub { font-size: 14px; color: var(--ink-2); margin-top: 10px; max-width: 740px; }
  .hero-meta { font-size: 12px; color: var(--muted); margin-top: 12px; padding-top: 10px;
    border-top: 1px solid var(--border); }
  .hero-empty .hero-headline { color: var(--muted); font-size: 22px; }

  /* stat strip */
  .strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
  @media (max-width: 1000px) { .strip { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 560px) { .strip { grid-template-columns: 1fr; } }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 15px 18px; box-shadow: var(--shadow); }
  .tile-label { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 8px; display: flex; align-items: center; gap: 5px; }
  .tile-value { font-size: 24px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em; line-height: 1.15; }
  .tile-value.pos { color: var(--good); } .tile-value.neg { color: var(--bad); }
  .tile-value.muted-val { color: var(--muted); font-size: 18px; font-weight: 600; }
  .tile-sub { font-size: 11.5px; color: var(--muted); margin-top: 6px; }
  .q { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; flex: none;
    border-radius: 50%; background: var(--surface-2); border: 1px solid var(--border-strong);
    color: var(--muted); font-size: 9px; font-weight: 700; cursor: help; position: relative; outline: none;
    text-transform: none; letter-spacing: normal; }
  .q:hover, .q:focus-visible { color: var(--ink); border-color: var(--border-strong); background: var(--accent-soft); }
  .q::after { content: attr(data-tip); position: absolute; z-index: 50; left: 50%; bottom: calc(100% + 8px);
    width: min(280px, 75vw); transform: translate(-50%, 4px); padding: 8px 10px; border-radius: 7px;
    background: var(--ink); color: var(--surface); box-shadow: var(--shadow); font-family: var(--font);
    font-size: 11px; font-weight: 500; text-transform: none; letter-spacing: normal;
    line-height: 1.4; text-align: left; pointer-events: none; opacity: 0; visibility: hidden;
    transition: opacity .12s, transform .12s, visibility .12s; }
  .q::before { content: ''; position: absolute; z-index: 51; left: 50%; bottom: calc(100% + 3px);
    transform: translateX(-50%); border: 5px solid transparent; border-top-color: var(--ink);
    pointer-events: none; opacity: 0; visibility: hidden; transition: opacity .12s, visibility .12s; }
  .q:hover::after, .q:focus-visible::after { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
  .q:hover::before, .q:focus-visible::before { opacity: 1; visibility: visible; }

  /* drawer */
  .drawer { margin: 0 0 12px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
  .drawer > summary { cursor: pointer; user-select: none; list-style: none; padding: 11px 16px;
    font-size: 12.5px; font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 8px; }
  .drawer > summary::-webkit-details-marker { display: none; }
  .drawer > summary::before { content: '▸'; color: var(--muted); font-size: 10px; }
  .drawer[open] > summary::before { content: '▾'; }
  .drawer > summary:hover { background: var(--surface-2); }
  .drawer-intro { padding: 10px 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--ink-2); }
  .drawer-intro em { color: var(--ink); font-style: normal; font-weight: 600; }
  .math-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 0 16px 16px; }
  @media (max-width: 860px) { .math-grid { grid-template-columns: 1fr; } }
  .math-block h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--ink); }
  .formula { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 9px 11px; font: 11px/1.55 var(--mono); color: var(--ink-2); white-space: pre-wrap;
    word-break: break-word; }
  .formula .k { color: var(--muted); } .formula .v { color: var(--ink); } .formula .op { color: var(--good); font-weight: 600; }
  .formula .sp { height: 6px; }
  .formula .src { color: var(--muted); font-size: 10px; display: block; margin-top: 7px;
    border-top: 1px solid var(--border); padding-top: 6px; }
  .updated { font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); animation: pulse 2s infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }

  /* sections */
  .section { margin-top: 28px; }
  .section-head { font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); margin: 0 0 12px;
    display: flex; align-items: baseline; gap: 10px; }
  .section-sub { font-size: 12px; font-weight: 400; color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 18px 20px; box-shadow: var(--shadow); min-width: 0; }
  .card-head { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); margin: 0 0 12px; }
  .card-head.spaced { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border); }

  /* x-ray */
  .xray { display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; align-items: start; }
  @media (max-width: 1000px) { .xray { grid-template-columns: 1fr; } }

  /* context map */
  .ctxmap { font-size: 13px; }
  .empty-note { color: var(--muted); font-size: 12.5px; padding: 14px; background: var(--surface-2);
    border: 1px dashed var(--border-strong); border-radius: 10px; }
  .ctx-headline { font-size: 13px; color: var(--ink-2); margin-bottom: 10px; }
  .ctx-title { display: inline-block; font-weight: 600; color: var(--ink); margin-right: 6px; }
  .ctx-big { font-size: 22px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .legend { display: flex; gap: 8px; margin-bottom: 10px; }
  .tag { font-size: 11px; font-weight: 600; padding: 3px 9px 3px 22px; border-radius: 999px; position: relative; }
  .tag::before { content: ''; position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
    width: 8px; height: 8px; border-radius: 2px; }
  .tag-img { background: var(--img-tint); color: var(--img-ink); }
  .tag-img::before { background: var(--img); }
  .tag-txt { background: var(--txt-tint); color: var(--txt-ink); }
  .tag-txt::before { background: var(--txt); }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 560px) { .split { grid-template-columns: 1fr; } }
  .split-col { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); }
  .split-img { border-top: 2px solid var(--img); }
  .split-txt { border-top: 2px solid var(--txt); }
  .split-head { font-size: 12px; font-weight: 600; color: var(--ink); margin-bottom: 8px; display: flex;
    flex-direction: column; gap: 2px; }
  .split-sum { font-size: 10.5px; font-weight: 500; color: var(--muted); }
  .ctx-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; padding: 4px 0;
    border-bottom: 1px solid var(--border); }
  .ctx-row:last-of-type { border-bottom: none; }
  .ctx-lbl { color: var(--ink-2); } .ctx-val { color: var(--ink); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted-row { color: var(--muted); font-style: italic; }
  .split-note { font-size: 10.5px; color: var(--muted); margin-top: 7px; }
  .cap-note { color: var(--ink); border-left: 2px solid var(--warn); padding-left: 8px; }
  .pages-title { font-size: 11px; color: var(--ink-2); margin: 12px 0 6px; }
  .pages { display: flex; flex-wrap: wrap; gap: 6px; max-height: 320px; overflow: auto;
    background: var(--surface-2); padding: 6px; border: 1px solid var(--border); border-radius: 8px; }
  .page { height: 130px; width: auto; max-width: 230px; object-fit: contain; object-position: top left;
    image-rendering: pixelated; background: #fff; border: 1px solid var(--border-strong); border-radius: 4px;
    cursor: pointer; transition: border-color .12s, transform .12s; }
  .page:hover { border-color: var(--accent); transform: translateY(-1px); }
  .page.page-gone { width: 150px; height: 56px; background: var(--surface-2); border: 1px dashed var(--border-strong);
    color: var(--muted); font-size: 10px; cursor: default; }

  /* recent requests */
  .row-view { color: var(--ink); font-weight: 600; text-decoration: none; cursor: pointer; white-space: nowrap; }
  .row-view:hover { text-decoration: underline; }
  table.rtable, table.dtable { width: 100%; border-collapse: collapse; font-size: 12px; }
  .rtable th, .dtable th { text-align: left; color: var(--muted); font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em; padding: 8px 8px;
    border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
  .rtable td, .dtable td { padding: 8px 8px; border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums; vertical-align: middle; color: var(--ink-2); }
  .rtable td code { background: transparent; border: none; padding: 0; font-size: 11.5px; }
  .rtable tr:last-child td, .dtable tr:last-child td { border-bottom: none; }
  .rtable tbody tr:hover, .dtable tbody tr:hover { background: var(--surface-2); }
  #frag-recent, #frag-stats { overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
  #frag-recent table, #frag-stats table { min-width: max-content; }
  #frag-latest { overflow: auto; scrollbar-width: thin; }
  th.num, td.num { text-align: right; }
  td.pos { color: var(--good); font-weight: 600; }
  td.neg { color: var(--bad); font-weight: 600; }
  .endp { color: var(--ink); font-family: var(--mono); font-size: 11px; }
  .empty-cell { color: var(--muted); text-align: center; padding: 18px; }
  .pill { display: inline-block; min-width: 38px; text-align: center; font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 999px; font-variant-numeric: tabular-nums; }
  .pill-good { background: var(--good-tint); color: var(--good); }
  .pill-warn { background: var(--warn-tint); color: var(--warn); }
  .pill-bad { background: var(--bad-tint); color: var(--bad); }
  .badge { font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
  .mk-create { font-size: 9.5px; font-weight: 600; color: var(--muted); border: 1px solid var(--border-strong);
    border-radius: 999px; padding: 0 5px; margin-left: 4px; vertical-align: 1px; cursor: help; white-space: nowrap; }
  .badge-img { background: var(--img-tint); color: var(--img-ink); }
  .badge-txt { background: var(--txt-tint); color: var(--txt-ink); }

  /* inspector */
  .viewer-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .mini-btn { font-size: 11px; background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong);
    border-radius: 7px; padding: 4px 10px; cursor: pointer; font-weight: 500; }
  .mini-btn:hover { border-color: var(--accent); background: var(--accent-soft); }
  .mini-label { font-size: 11px; color: var(--muted); }
  .frame { background: #fff; border: 1px solid var(--border-strong); border-radius: 8px; padding: 5px;
    overflow: auto; max-height: 360px; scrollbar-width: thin; }
  .frame img { display: block; width: auto; height: auto; max-width: none; image-rendering: pixelated; }
  .frame-sm { max-height: 260px; }
  .viewer-caption { font-size: 11px; color: var(--muted); margin-top: 8px; display: flex; align-items: center;
    gap: 10px; flex-wrap: wrap; }
  .pairing { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 10px; }
  .pair-head { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 6px; display: inline-block;
    margin-bottom: 6px; }
  .pair-img { background: var(--img-tint); color: var(--img-ink); }
  .pair-txt { background: var(--txt-tint); color: var(--txt-ink); }
  .pair-mid { font-size: 11px; font-weight: 600; color: var(--muted); text-align: center; }
  .src-pane { margin: 0; max-height: 280px; overflow: auto; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 8px; padding: 9px; font: 11px/1.45 var(--mono);
    white-space: pre-wrap; word-break: break-word; color: var(--ink-2); }
  .evicted { font-size: 11.5px; color: var(--muted); padding: 12px; background: var(--surface-2);
    border: 1px dashed var(--border-strong); border-radius: 8px; }

  /* sessions bars */
  .status { margin-bottom: 12px; color: var(--muted); font-size: 12px; }
  .bars { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
  .bar-label { width: 150px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--ink); font-family: var(--mono); font-size: 11px; }
  .bar-track { flex: 1; min-width: 0; height: 14px; background: var(--surface-2); border-radius: 4px;
    overflow: hidden; border: 1px solid var(--border); }
  .bar-fill { height: 100%; border-radius: 4px 0 0 4px; background: var(--good); }
  .bar-val { width: 78px; flex: none; text-align: right; font-variant-numeric: tabular-nums;
    color: var(--good); font-weight: 600; }
  .bar-val.neg { color: var(--bad); }
  .axis { margin-top: 12px; color: var(--muted); font-size: 11px; }
  .empty { text-align: center; color: var(--muted); padding: 22px; font-size: 12px; }

  /* toast tray */
  .tray { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px;
    z-index: 1000; pointer-events: none; }
  .toast { background: var(--surface); color: var(--bad); border: 1px solid rgba(220,38,38,0.25); border-radius: 9px;
    padding: 10px 14px; font-size: 12px; box-shadow: 0 8px 24px rgba(15,23,42,0.10); display: flex;
    align-items: center; gap: 12px; pointer-events: auto; max-width: 360px; }
  .toast button { background: transparent; color: inherit; border: 0; cursor: pointer; font-size: 16px;
    line-height: 1; padding: 0; }
`;

// Client glue: window.pp (pin+source state) → hx-vals; preserves <details> open state across swaps; routes htmx errors to toast tray.
const GLUE_JS = `
  window.pp = { pin: null, src: false };
  function ppPin(id) {
    window.pp.pin = id;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  function ppSource(on) {
    window.pp.src = on;
    htmx.trigger('#frag-latest', 'pp-refresh');
  }
  document.body.addEventListener('htmx:beforeSwap', function (ev) {
    const open = [];
    ev.detail.target.querySelectorAll('details[open][id]').forEach(function (d) { open.push(d.id); });
    ev.detail.target.__ppOpen = open;
  });
  document.body.addEventListener('htmx:afterSwap', function (ev) {
    (ev.detail.target.__ppOpen || []).forEach(function (id) {
      const d = document.getElementById(id);
      if (d) d.setAttribute('open', '');
    });
  });
  document.body.addEventListener('htmx:responseError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: ev.detail.xhr.status + ' ' + ev.detail.requestConfig.path }
    }));
  });
  document.body.addEventListener('htmx:sendError', function (ev) {
    window.dispatchEvent(new CustomEvent('pp-toast', {
      detail: { text: 'proxy unreachable: ' + ev.detail.requestConfig.path }
    }));
  });
`;

// Theme: light/dark via data-theme on <html>; saved in localStorage, defaults to system pref.
const THEME_JS = `
  (function () {
    function apply(t) {
      document.documentElement.dataset.theme = t;
      var b = document.getElementById('theme-btn');
      if (b) {
        b.textContent = t === 'dark' ? '☀ Light' : '☾ Dark';
        b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      }
    }
    window.ppTheme = function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('pp-theme', next); } catch (e) {}
      apply(next);
    };
    apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  })();
`;

/** `hostLabel` names the machine this proxy runs on. The dashboard is otherwise
 *  byte-identical across hosts, so a tab opened against a remote host through
 *  the tailnet front is indistinguishable from the local one - which is how a
 *  session gets read on the wrong box. Empty label = render as before. */
export function renderPage(port: number, hostLabel = ''): string {
  const host = escapeHtml(hostLabel.trim());
  // hx-trigger="load, every Ns": paint on load then poll (2s live, 5s aggregates).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${host ? `${host} · fiche dashboard` : 'fiche — live dashboard'}</title>
<link rel="icon" href="${FAVICON}" />
<style>${CSS}</style>
<script>
  // Set theme before first paint (no flash): saved choice wins, else system preference.
  (function () {
    try {
      var s = localStorage.getItem('pp-theme');
      var dark = s ? s === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    } catch (e) { document.documentElement.dataset.theme = 'light'; }
  })();
</script>
</head>
<body>
<main class="shell">

<header class="topbar">
  <div class="brand">
    <svg class="brand-mark" viewBox="0 0 256 256" width="34" height="34" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="dash-fa-top" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#FF4D5A"/>
          <stop offset="52%" stop-color="#FF6B2B"/>
          <stop offset="100%" stop-color="#FFB020"/>
        </linearGradient>
        <linearGradient id="dash-fa-mid" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#9333EA"/>
          <stop offset="52%" stop-color="#C026D3"/>
          <stop offset="100%" stop-color="#F43F8E"/>
        </linearGradient>
        <linearGradient id="dash-fa-bot" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#06E3F5"/>
          <stop offset="52%" stop-color="#0EA5E9"/>
          <stop offset="100%" stop-color="#3B82F6"/>
        </linearGradient>
        <linearGradient id="dash-fa-gt" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#FFD166"/>
          <stop offset="100%" stop-color="#FF70A6"/>
        </linearGradient>
        <linearGradient id="dash-fa-gb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#C084FC"/>
          <stop offset="100%" stop-color="#9333EA"/>
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="240" height="240" rx="52" fill="#0B0D14" stroke="#1E293B" stroke-width="3"/>
      <g transform="translate(22, 22) scale(0.828)">
        <path d="M 14 74 H 62 C 88 74, 96 109, 127 109 V 119 C 90 119, 82 102, 62 102 H 14 Z" fill="url(#dash-fa-top)"/>
        <path d="M 14 114 H 62 C 88 114, 96 123, 127 123 V 133 C 96 133, 88 142, 62 142 H 14 Z" fill="url(#dash-fa-mid)"/>
        <path d="M 14 154 H 62 C 82 154, 90 137, 127 137 V 147 C 96 147, 88 182, 62 182 H 14 Z" fill="url(#dash-fa-bot)"/>
        <path d="M 129 104 V 79 H 227 V 177 H 129 V 152 H 114 V 192 H 242 V 64 H 114 V 104 Z" fill="#FFFFFF"/>
        <polygon points="178,102 165,128 152,128" fill="#FF5447"/>
        <polygon points="178,102 191,128 165,128" fill="url(#dash-fa-gt)"/>
        <polygon points="178,102 204,128 191,128" fill="#22D3EE"/>
        <polygon points="152,128 165,128 178,154" fill="#F43F5E"/>
        <polygon points="165,128 191,128 178,154" fill="url(#dash-fa-gb)"/>
        <polygon points="191,128 204,128 178,154" fill="#3B82F6"/>
      </g>
    </svg>
    <div>
      <div class="wordmark-row">
        <div class="wordmark">fiche</div>
        ${host ? `<span class="hostchip" title="proxy host">${host}</span>` : ''}
      </div>
      <div class="tagline">Microfiche for coding agents — cache-safe optical &amp; text compilation.</div>
    </div>
  </div>
  <div class="controls">
    <button type="button" id="theme-btn" class="theme-btn" onclick="ppTheme()" aria-label="Toggle dark mode" title="Toggle dark / light mode">☾ Dark</button>
    <div id="frag-toggle" hx-get="/fragments/toggle" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
  </div>
</header>

<div id="frag-session" hx-get="/fragments/session-summary" hx-trigger="load, every 2s" hx-swap="innerHTML">
  <div class="hero hero-empty"><div class="hero-headline">Connecting…</div></div>
</div>

<div id="frag-header" hx-get="/fragments/header" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>

<div class="config-dock">
  <details class="models-collapse">
    <summary class="models-summary">Connect an agent <span class="hint">warp launches any CLI through this proxy · pin keeps instructions last in the request</span></summary>
    <div class="dock-body">
      <p>Warp starts the agent with the proxy already wired, no env or config edits:</p>
      <pre>fiche warp -- claude
fiche warp -- codex
fiche warp -- cursor-agent</pre>
      <p>Aliases work too (<code>fiche warp -- pp</code>), and <code>--route PATTERN=http://host:port</code> adds routes beyond <code>api.anthropic.com</code> (a PATTERN that names a port matches only that port, e.g. <code>--route '127.0.0.1:9090/v1/*=http://127.0.0.1:${port}'</code> warps an agent pointed at another local proxy). Without warp, point the agent at <code>ANTHROPIC_BASE_URL=http://127.0.0.1:${port}</code> yourself.</p>
      <p>Pin instructions from inside the session — they get moved to the end of every request, where the model actually reads them:</p>
      <pre>@fiche pin be concise, no walls of text
@fiche unpin 2
@fiche unpin all</pre>
      <p><code>@fiche pin</code> with no text lists what is pinned.</p>
      <p>A <code>@fiche pin …</code> line in your global or project <code>CLAUDE.md</code> (<code>AGENTS.md</code> under Codex / OpenCode) is relocated the same way, on every session, with no typing. Those are file-backed, so <code>unpin</code> and <code>unpin all</code> never touch them — edit the file to remove one.</p>
    </div>
  </details>

  <details class="models-collapse">
    <summary class="models-summary">Image model scope <span class="hint">Fable 5 &amp; Gemini optical by default; 4-layer text compiler runs across text-tier models</span></summary>
    <div class="dock-body">
      <div class="models-warning">Optical image compression is active by default for Fable 5 and Gemini; the 4-layer text compiler runs automatically across text-tier models. Other families can use <strong>more</strong> tokens when imaged — opt in only for deliberate experiments.</div>
      <div id="frag-models" hx-get="/fragments/models" hx-trigger="load, every 2s [!document.activeElement || document.activeElement.id !== 'models-csv']" hx-swap="innerHTML"></div>
      <div class="models-routing"><span class="hint">imaging scope ≠ provider routing — non-Anthropic IDs also need routing env on the proxy</span> <button class="mini-btn" type="button" onclick="document.getElementById('routing-help').showModal()">routing help</button></div>
    </div>
  </details>

  <details class="models-collapse">
    <summary class="models-summary">3rd-party plugins &amp; extensions <span class="hint">one click toggles all external skills and plugins while keeping core compiler stages on</span></summary>
    <div class="dock-body">
      <div id="frag-plugins" hx-get="/fragments/plugins" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
    </div>
  </details>
</div>

<section class="section">
  <h2 class="section-head">What happened to your context <span class="section-sub">click a request to see image vs text</span></h2>
  <div class="xray">
    <div class="card">
      <h3 class="card-head">Recent requests</h3>
      <div id="frag-recent" hx-get="/fragments/recent" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
    </div>
    <div class="card">
      <h3 class="card-head">Image vs text breakdown</h3>
      <div id="frag-context-map" hx-get="/fragments/context-map" hx-trigger="load" hx-swap="innerHTML"></div>
      <h3 class="card-head spaced">Image ↔ source inspector</h3>
      <div id="frag-latest" hx-get="/fragments/latest" hx-trigger="load, every 2s, pp-refresh" hx-swap="innerHTML"
           hx-vals='js:{pin: window.pp.pin == null ? "" : window.pp.pin, source: window.pp.src ? "1" : ""}'></div>
    </div>
  </div>
</section>

<section class="section">
  <h2 class="section-head">Top sessions <span class="section-sub">by tokens saved</span></h2>
  <div class="card">
    <div id="frag-sessions" hx-get="/fragments/sessions" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
  </div>
</section>

<section class="section">
  <h2 class="section-head">Full history <span class="section-sub">every event on disk</span></h2>
  <div class="card">
    <div id="frag-stats" hx-get="/fragments/stats" hx-trigger="load, every 5s" hx-swap="innerHTML"></div>
  </div>
</section>

</main>

<dialog id="routing-help" onclick="if (event.target === this) this.close()">
  <h3>Routing Claude Code to OpenAI / Cloudflare models</h3>
  <p>Claude models use Anthropic by default. Two optional routes can run together — set on the <strong>fiche process</strong> (keep provider credentials out of Claude Code):</p>
  <ul>
    <li><code>OPENAI_MODELS</code> — exact model IDs routed to OpenAI Responses (<code>OPENAI_UPSTREAM</code> + <code>OPENAI_API_KEY</code>)</li>
    <li><code>CLOUDFLARE_MODELS</code> — exact model IDs routed to Cloudflare's OpenAI-compatible endpoint (<code>CLOUDFLARE_ACCOUNT_ID</code> + <code>CLOUDFLARE_API_TOKEN</code>)</li>
  </ul>
  <p>If a model appears in both lists: <code>CLOUDFLARE_MODELS &gt; OPENAI_MODELS &gt; default routing</code>.</p>
  <pre>OPENAI_UPSTREAM=https://api.openai.com \\
OPENAI_API_KEY=your-openai-key \\
OPENAI_MODELS=gpt-5.6-sol \\
CLOUDFLARE_ACCOUNT_ID=your-account-id \\
CLOUDFLARE_API_TOKEN=your-cloudflare-token \\
CLOUDFLARE_MODELS=moonshotai/kimi-k3 \\
npx @sriinnu/fiche</pre>
  <p>Non-Anthropic IDs are advertised with a <code>claude-</code> prefix because Claude Code needs a Claude-shaped ID; fiche strips it before forwarding. Switch to one inside Claude Code with <code>/model claude-&lt;model&gt;</code> — e.g. <code>/model claude-moonshotai/kimi-k3</code> — or launch with <code>claude --model claude-moonshotai/kimi-k3</code>. Verify discovery with <code>curl …/v1/models</code>.</p>
  <p><code>FICHE_MODELS</code> above is separate: it controls image compression, not routing. Kimi K3 on Cloudflare is the only non-Anthropic model tested end to end — see <code>docs/CLAUDE_CODE_PROVIDER_ROUTING.md</code>.</p>
  <button class="mini-btn" type="button" onclick="this.closest('dialog').close()">close</button>
</dialog>

<div class="tray" x-data="{ toasts: [], next: 1 }"
     @pp-toast.window="const id = next++; toasts.push({ id, text: $event.detail.text }); setTimeout(() => toasts = toasts.filter(t => t.id !== id), 5000)">
  <template x-for="t in toasts" :key="t.id">
    <div class="toast"><span x-text="t.text"></span><button type="button" @click="toasts = toasts.filter(x => x.id !== t.id)" aria-label="dismiss">&times;</button></div>
  </template>
</div>

<script>${HTMX_JS}</script>
<script>${GLUE_JS}</script>
<script>${THEME_JS}</script>
<script>${ALPINE_JS}</script>
</body>
</html>`;
}
