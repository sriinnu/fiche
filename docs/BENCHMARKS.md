# Benchmarks and model measurements

**Where these numbers come from.** Every score on this page was measured
before inkling's starting point (see the README's [Credits](../README.md#credits)).
inkling has not re-run them. It uses them to decide which models get images
(`src/core/reader-tier.ts`) and which render profile each model gets. The
harnesses and receipts are in [`eval/`](../eval/) and
[FINDINGS.md](../FINDINGS.md); re-run them before trusting a number for your
own workload. "We" in the text below means that earlier research.

## Model tiers

Not every vision encoder can read dense 5×8 bitmap glyphs. **Gemini 4 (`gemini-4-argon`) is the first model to score 15/15 on pure-image dense hex alongside 100/100 pure-image arithmetic, 98/98 gist recall, 18/18 state tracking, and 0/16 confabulations.** By contrast, every post-Fable-5 Claude release (`claude-opus-5`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`) regressed sharply on dense pixel reading (0/15 to 3/15 on exact hex). `claude-fable-5-1` and `claude-fable-5-2` read 6/15 and 7/15 on the unspaced cell and 14/15 and 13/15 with +2px row spacing, which is now their default.

| tier | models | dense hex (pure image, N=15) | gist (N=98) | arithmetic (N=100) | runtime status & guidance |
| --- | --- | ---: | ---: | ---: | --- |
| **Tier 1 — Full-fidelity readers** | `gemini-4-argon` (`gemini-4*`) | **15/15** | **98/98** | **100/100** | **On by default.** First model to hit 15/15 hex and 100/100 arithmetic on pure images; 96-page history cap + compact factsheet. |
| **Tier 1 — Full-fidelity readers** | `google/gemini-3.6-flash`, `3.7-flash`, `3.8-flash` | **14/15** | **98/98** | **100/100** | **On by default** (compact factsheet). ~5.0–5.3× text capacity. |
| **Tier 1 — Full-fidelity readers** | `claude-fable-5` (original June 2026) | **13/15** | **98/98** | **100/100** | **On by default.** SWE-bench Lite 10/10, SWE-bench Pro 14/19. |
| **Tier 2 — Gist & agentic history only** (not byte-exact on dense logs/JSON) | `claude-opus-5-5` (opt-in, text by default), `claude-fable-5-1` / `claude-fable-5-2` (default, spaced profile), `claude-opus-5` (opt-in), `grok-4.5` / `grok-4.6` (opt-in), `gpt-5.6-sol` (opt-in) | 0/15–14/15 | 83/98–**98/98** | 98/100–**100/100** | **Do not use for tool-less document/log extraction.** Safe only in live agent sessions where recent turns stay text and the agent has tools (`Read`/`Grep`) to re-fetch exact IDs/numbers. |
| **Unsupported — Do not image** | `claude-haiku-5-5` (`claude-haiku-*`), `claude-sonnet-5-5`, `claude-opus-4-8`, `gpt-6.1-sol` at 5×8 (its shipped 14px profile is a strong reader), `grok-4.7`, `gpt-6-astra`, `kimi-k3`, `glm-5.3-flash`, `deepseek-v4.1-flash-1017` | 0/15–2/15 | 14/98–98/98 | 36/100–100/100 | **Not in default scope** (or loses money after cache discount). Weak readers guess plausible wrong numbers/IDs or misbind factsheet tokens when tools are disabled. |

- **Independent 6-document benchmark (`TokenSave` / `johnisking` corpus — English/Korean/Japanese prose, JS code, 60-record JSON, 230-line log):** That benchmark tested only `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-fable-5-1` with `--tools ""`, where `images only` scored **3/60 to 14/60** on planted hex IDs, **6/60 to 29/60** on planted numbers, **0/80** on unplanted log/JSON IDs, and **3/10** on Korean prose numbers (`94392` misread as `9392`). Running the exact same 6-document, 80-item benchmark on **`gemini-4-argon` pure images (no factsheet)** scores **28/30 (93.3%)** on planted hex IDs (**10/10** on English + Code, **10/10** on Korean `prose_ko` including `94392` exact, **5/5** on Japanese hex), **27/30 (90.0%)** on planted numbers, and **13/20** on unplanted JSON/log items (including **4/5** on unplanted 230-line log `req=` IDs where all four Claude models scored 0/20).
- **We tested removing the factsheet on Gemini 4 (`68/80` pure-image) — and put it back:** Because `gemini-4-argon` scored **15/15** on our 12-char `verbatim-hex` benchmark and **100/100** on pure-image arithmetic, we tested removing the text factsheet completely (`factSheetFormat: 'none'`) on the 6-document TokenSave corpus. Even at 85% overall (`28/30` planted hex, `27/30` planted numbers), 5 of the 12 pure-image misses were single-pixel `0`↔`8` / `6`↔`8` substitutions inside 22-char `req_<18-hex>` strings (`req_709b2b8ff97e92994a` → `req_709b2b0ff97e92994a`) or `30141` → `38141`. In Spleen 5×8, `0` and `8` differ by one interior pixel. When a strong reader (`gemini-4-argon` or `claude-fable-5`) reads the image, it already sees which ticket/row goes with which value and uses the bounded 96-token factsheet to disambiguate `0` vs `8` (recovering the planted misses to **30/30** hex and **29/30** numbers), so we kept the factsheet in production. On weak readers (`opus-5-5`, `sonnet-5-5`, `fable-5-1`), the model cannot read the image rows at all, so it guesses pairings from the factsheet and fails 0/80 on any ID past the 96-token cap ([FINDINGS.md](../FINDINGS.md), 2026-10-25 entry).
- **Escape hatch:** subagents on non-allowlisted models pass through as text — route byte-exact work there (`CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-6`, or `model: sonnet` in agent frontmatter), or restrict `INKLING_MODELS=gemini,claude-fable-5` if you do not want `claude-opus-5-5` imaged.
- **Real work (measured on `claude-fable-5`):** SWE-bench Lite pilot **10/10 both arms** at −65% request size; SWE-bench Pro **14/19 ON vs 15/19 OFF** at −60%, verdicts agree 18/19, and the single split re-resolved 3/3 on replication — run-to-run variance, not compression. Small n; receipts in `eval/`. Later Claude releases (`fable-5-1`, `opus-5-5`, `sonnet-5-5`) have weaker pixel recall than `claude-fable-5`.
- **Workload-dependent.** Wins on token-dense content (~1 char/token), loses money on sparse prose (~3.5 chars/token); a profitability gate (calibrated on N=391 production rows) images only where the math wins.
- **Client-dependent.** Savings track uncached bulk the client still re-sends as text. Claude Code re-sends system + tools + history on `/anthropic/messages` and typically lands ~60–70%. Details and measured splits: [docs/CACHING_AND_SAVINGS.md](CACHING_AND_SAVINGS.md).

## Benchmark results

### Model quality

This matrix shows coverage as well as scores. `—` means the model was not run
on that test; it does not mean zero. **Every `dense hex (N=15)` score is a pure-image read with NO factsheet** (12-char hex IDs looked up by `dur_ms` across 80-line JSON event-log PNGs). Arithmetic uses novel random-number
problems. Gist, state, and never-stated probes share one corpus. Never-stated
is confabulations, so lower is better. The **numbers at** column is the render
geometry the row's scores were measured at; a model's shipped profile can
differ (Sol and Qwen ship the measured 14px/84 geometry, but their broad-suite
numbers predate it).

| model | numbers at | arithmetic (N=100) | gist (N=98) | state (N=18) | never-stated (N=16) | dense hex, pure image (N=15) | profile provenance and receipts |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `gemini-4-argon` (default) | Spleen 5×8, 312 cols (shipped) | **100/100** | **98/98** | **18/18** | **0/16** | **15/15** | shipped Gemini 4 profile; 100/100 pure-image arithmetic & 15/15 pure-image hex: [quality results](../eval/gemini-profile/QUALITY_RESULTS.md) |
| `google/gemini-3.6-flash`, `3.7-flash`, `3.8-flash` (default) | Spleen 5×8, 312 cols (shipped) | **100/100** | **98/98** | **18/18** | **0/16** | **14/15** | current shipped Gemini 3.x profile: [quality results](../eval/gemini-profile/QUALITY_RESULTS.md) |
| `claude-fable-5` (default) | Spleen 5×8, 312 cols (shipped) | **100/100** | **98/98** | **18/18** | **0/16** | 13/15 | June 2026 production profiles: [arithmetic + hex](../FINDINGS.md), [gist/state/guards](../eval/gist-recall/) |
| `claude-fable-5-1` (default) | Spleen 5×8, 312 cols, +2px rows | **100/100** | **98/98** | **18/18** | **0/16** | **14/15** | spaced profile; was 6/15 hex and 95/98 gist on the unspaced Fable 5 cell. Arithmetic measured unspaced, not rerun: [arithmetic](../eval/sol-profile/), [dense hex](../eval/verbatim-15/), [gist/state/guards](../eval/gist-recall/) |
| `claude-fable-5-2` (default) | Spleen 5×8, 312 cols, +2px rows | **100/100** | **98/98** | **18/18** | **0/16** | 13/15 | spaced profile; 13/15 and 11/15 over two hex runs, was 7/15 and 5/15 on the unspaced Fable 5 cell. Arithmetic measured unspaced, not rerun: [arithmetic](../eval/model-quality/), [dense hex](../eval/verbatim-15/), [gist/state/guards](../eval/gist-recall/) |
| `claude-opus-5-5` (opt-in, text by default) | Spleen 5×8, 312 cols, +2px rows | **100/100** | 94/98 | 17/18 | **0/16** | 3/15 | spaced profile (Opus 5.5+); hex measured at dense geometry: [arithmetic](../eval/sol-profile/), [gist/state/guards](../eval/gist-recall/), [dense hex](../eval/verbatim-15/) |
| `claude-opus-5` (opt-in) | Spleen 5×8, 312 cols (shipped) | **100/100** | 94/98 | 17/18 | **0/16** | 2/15 | current profile: [arithmetic](../eval/gsm8k/), [gist/state/guards](../eval/gist-recall/), [dense hex](../eval/verbatim-15/) |
| `claude-sonnet-5-5` (opt-in, not recommended) | Spleen 5×8, 312 cols, +2px rows | **100/100** | 85/98 | 12/18 | **0/16** | 2/15 | spaced profile, opt-in via `INKLING_MODELS`; 6 state misses are wrong final values/counts, 7 gist misses answered UNKNOWN: [arithmetic](../eval/sol-profile/), [gist/state/guards](../eval/gist-recall/), [dense hex](../eval/verbatim-15/) |
| `grok-4.5` (opt-in) | JetBrains Mono 14px, 84 cols (shipped) | **100/100** | **97/98** | 17/18 | **0/16** | 0/15 | native 14px/84 quality suite (live profile); [quality](../eval/grok-density/QUALITY_RESULTS.md), [native-sweep](../eval/grok-density/native-sweep/RESULTS.md) |
| `grok-4.6` high (opt-in) | JetBrains Mono 14px, 84 cols (shipped) | **100/100** | **97/98** | 17/18 | **0/16** | 0/15 | native 14px/84, reasoning high; [quality](../eval/grok-profile/QUALITY_RESULTS.md) |
| `gpt-5.6-sol` (opt-in) | Spleen 5×8, 152 cols; **ships 14px/84** | 98/100 | 83/98 | 17/18 | 4/16 | 0/15 | broad suite predates the shipped 14px profile; 14px pilot: 7/8 exact, 0 inventions, gist/guard pass: [pilot](../eval/sol-profile/README.md) |
| `claude-opus-4-8` (historical) | Spleen 5×8, 312 cols (historical) | 93/100 | 77/98 | **18/18** | **0/16** | 0/15 | historical profile: [arithmetic](../eval/gsm8k/), [gist/state/guards](../eval/gist-recall/), [dense hex](../eval/needle-haystack/) |
| `moonshotai/kimi-k3` (unsupported) | Spleen 5×8, 152 cols (generic default) | 79/100 | 84/98 | 15/18 | 1/16 | 0/15 | generic GPT profile, no measured geometry of its own: [quality results](../eval/sol-profile/KIMI_K3_QUALITY_RESULTS.md) |
| `qwen-3.8` (`@cf/qwen/qwen3.8-27b`, opt-in) | Spleen 5×8, 152 cols; **ships 14px/84** | 98/100 | 72/98 | 11/18 | **0/16** | 0/15 | broad suite predates the shipped 14px profile; 14px pilot: 8/8 exact, 0 inventions, 11/15 hex: [pilot & quality](../eval/qwen-profile/QUALITY_RESULTS.md) |
| `glm-5.3-flash` (`@cf/zai-org/glm-5.3-flash`, unsupported) | Spleen 5×8, 152 cols (default fallback, nothing shipped) | 36/100 | 57/98 | 6/18 | **0/16** | 0/15 | 5×8 is illegible to GLM (0/15 hex); 14px pilot: 10/15 hex, all misses single-glyph confabs, guards 0/16: [pilot & quality](../eval/glm-profile/QUALITY_RESULTS.md) |
| `deepseek-v4.1-flash-1017` (`@cf/deepseek-ai/deepseek-v4.1-flash-1017`, unsupported) | JetBrains Mono 14px, 84 cols (pilot, nothing shipped) | **100/100** | **98/98** | **18/18** | **0/16** | 0/15 | 5×8 is illegible to DeepSeek V4.1 (0/15 hex); 14px pilot: 100/100 arith, 98/98 gist, 18/18 state, 0/16 guards, 8/15 hex: [pilot & quality](../eval/deepseek-profile/QUALITY_RESULTS.md) |
| `gpt-6.1-sol` (opt-in) | Spleen 5×8, 152 cols; **ships 14px/84** | **100/100** | 20/98 | 9/18 | **0/16** | 0/15 | 5×8 collapses on dense history (20/98 gist); 14px/84 suite: 100/100 arith, 96/98 gist, 18/18 state, 15/15 hex with factsheet: [5×8](../eval/model-quality/results/gpt-6.1-sol-5x8/QUALITY_RESULTS.md), [14px](../eval/model-quality/results/gpt-6.1-sol/QUALITY_RESULTS.md) |
| `grok-4.7` high (opt-in) | Spleen 5×8, 152 cols; **ships 14px/84** | 85/100 | 14/98 | 5/18 | **0/16** | 0/15 | 5×8 collapses on dense history (14/98 gist); 14px/84 suite: 100/100 arith, 98/98 gist, 18/18 state, 14/15 hex with factsheet: [5×8](../eval/model-quality/results/grok-4.7-5x8/QUALITY_RESULTS.md), [14px](../eval/model-quality/results/grok-4.7/QUALITY_RESULTS.md) |
| `gpt-6-astra` low (unsupported) | Spleen 5×8, 152 cols (`original` detail) | 97/100 | 26/98 | 7/18 | **0/16** | 2/15 | v2 aligned suite (`high` detail: 98/100 arith, 25/98 gist, 6/18 state, 5/15 hex): [quality results](../eval/model-quality/results/gpt-6-astra/QUALITY_RESULTS.md) |

### Native-profile cost check

Offline export of the same deterministic 454,045-character dense record corpus
through each complete profile produced:

| model profile | pages | text estimate | image tokens | savings |
|---|---:|---:|---:|---:|
| Claude, Spleen 5×8 | 17 | 122,715 | 23,856 | 80.6% |
| Sol, JetBrains Mono 14px | 45 | 122,715 | 65,424 | 46.7% |

The text estimate uses 3.7 characters/token; image tokens use each model's
provider formula and actual rendered page dimensions. These figures establish
profile cost on this corpus, not a universal workload savings rate. Sol's paid
fixtures estimated 42% while reading 7/8 exact with no unsupported inventions.

The runs use different transports and profile generations, not one identical
image geometry. Fable and Opus use Claude; Gemini uses Google AI Studio; Sol
and Grok use Codex Responses; Kimi K3 uses Cloudflare's OpenAI-compatible
transport. All `dense hex (N=15)` scores are pure-image reads with no factsheet.
Current production profiles include the adjacent bounded factsheet on runtime requests;
historical or pure-image exceptions are identified in the linked evaluation.

### Model-specific evaluations

These are not cross-model comparisons. Every unlisted model is **not run**.

| test | model | result | evaluation and receipts |
| --- | --- | --- | --- |
| SWE-bench Lite | `claude-fable-5` | inkling 10/10; text 10/10; −65% request size | [paired pilot](../eval/swe-bench/) |
| SWE-bench Pro | `claude-fable-5` | inkling 14/19; text 15/19; −60% request size | [paired pilot](../eval/swe-bench-pro/) |
| production-history row localization | `google/gemini-3.6-flash` | text 17/30; inkling 18/30 | [positional retrieval](../eval/gemini-profile/QUALITY_RESULTS.md#production-history-positional-retrieval) |
| production-history exact row | `google/gemini-3.6-flash` | text 3/30; inkling 3/30 | [positional retrieval](../eval/gemini-profile/QUALITY_RESULTS.md#production-history-positional-retrieval) |

The SWE-bench runner is Claude Code/Fable-specific; no other model has an ON/OFF
run. Gemini's positional-retrieval sweep is directional evidence, not a general
Lost-in-the-Middle result.

### Capacity / density (how many chars per vision-token?)

Measured by rendering this repo’s dense fixture through the real pipeline and
pricing pixels at each family’s vision rate. Multiplier = measured
chars/vision-token ÷ 4 (prose text baseline). Not a model-quality score.

| family | window | as text (@4 c/tok) | as inkling images | density | multiplier |
|---|---:|---:|---:|---:|---:|
| **`claude-fable-5[1m]`** (default) | 1M | ~4.0M | **~18.9M** | ~18.9 c/vt (exact 28px patches) | **~4.7×** |
| **`google/gemini-3.6-flash`** | 1M | ~4.0M | **~20.1M** | ~20.1 c/vt (1,078 tok/page) | **~5.0×** |
| **`claude-opus-5`** | 1M | ~4.0M | **~18.9M** | ~18.9 c/vt (resolves to Fable 5’s geometry) | **~4.7×** |

Regenerate: `npx tsx scripts/gen-context-chart.ts` · chart PNG
[`docs/assets/context-window-chars.png`](assets/context-window-chars.png).

The older GSM8K result is omitted because its training-data contamination can
hide image misreads; the linked arithmetic evaluations use novel numbers.

## Context capacity chart

![chart: characters a frontier context window holds, 2018–2026 — vendor text series including Grok 4.5; orange measured overlays are Fable 5 [1m] + inkling ~19.0M (4.8×) and Gemini 3.6 Flash + inkling ~21.3M (5.3×)](assets/context-window-chars.png)

*Eight years of context growth, in characters. Every text line tops out near
~4M chars (a 1M-token window at ~4 chars/token); **Grok 4.5** is shown as a
text-window point only (500K). The orange overlays are the **same 1M
windows** read through inkling images — ~19.0M chars for Fable 5 (**4.8×**) and ~21.3M chars for Gemini 3.6 Flash (**5.3×** text capacity). Density is measured from a live render at
generation time, not hand-typed: regenerate with
`npx tsx scripts/gen-context-chart.ts`
([source](../scripts/gen-context-chart.ts)).*

## Research status

Current as of October 2026. Exact recall at 5×8 density is bottlenecked by the
model's vision encoder, not just font tweaks: repainting `K` reduced Fable 5's
H/K confusion from 47.2% to 18.7% ([FINDINGS.md](../FINDINGS.md), 2026-07-19),
while later Claude releases (`claude-fable-5-1` at 6/15, `claude-fable-5-2` at 7/15 on the same cell,
14/15 and 13/15 with +2px rows; `claude-opus-5-5` at
3/15, `claude-sonnet-5-5` at 2/15) regressed relative to June 2026
`claude-fable-5` (13/15). Conversely, **Gemini 4 (`gemini-4-argon`)** cleared the
5×8 resolution tripwire at **15/15** pure-image dense hex, **100/100**
pure-image arithmetic, and **93% / 90%** pure-image hex/number recall on the 6-document TokenSave corpus; we tested removing the factsheet on Gemini 4 and kept it after observing single-pixel `0`↔`8` substitutions in 22-char `req_` IDs ([FINDINGS.md](../FINDINGS.md), 2026-10-25 entry).

Effective-context benefits remain unproven. The production-history results
above are directional evidence, not a general context-window or long-task
accuracy claim.
