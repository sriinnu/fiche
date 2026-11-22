# How `fiche` sizes rendered images

Image geometry is selected by the exact model id. `/v1/responses` is only a
wire protocol: Claude, GPT, and Grok on that path do not share a renderer.

## Current behavior

A page is profile-width and variable-height. It is never padded to a square.

```text
cellWidth  = atlasWidth  + cellWBonus
cellHeight = atlasHeight + cellHBonus
width      = 2 * PAD_X + columns * cellWidth
height     = 2 * PAD_Y + usedRows * cellHeight
```

Width may shrink to the widest rendered line, capped by the profile. Height
grows with content until the profile cap, then overflow becomes another page.

| model rule | atlas / effective cell | columns | full width | max height |
|---|---|---:|---:|---:|
| `claude-fable-5` / Gemini vision tiers | Spleen 5×8 + Unifont 8px fallback, 5×8 | 312 | 1568 px | 728 px |
| other `claude-*` / `anthropic-*` (`fable-5-1`, `5-2`, etc.) | Spleen 5×8 +2px rows (`cellHBonus: 2`), 5×10 | 312 | 1568 px | 728 px |
| opt-in `gpt-5.6-sol` / `gpt-6.1-sol` / `gpt-6.2-sol` | JetBrains Mono 14px (+ Unifont 14px), 9×16 | 84 | 764 px | 1954 px |
| opt-in `grok-*` / `qwen3.8-27b` | JetBrains Mono 14px (+ Unifont 14px), 9×16 | 84 | 764 px | 512 px |
| `gpt-6*` (non-Sol) & other OpenAI fallback | Spleen 5×8 + Unifont 8px fallback, 5×8 | 152 | 768 px | 1932 px |

Complete profile values and evidence are in
[`MODEL_RENDER_PROFILES.md`](MODEL_RENDER_PROFILES.md).

The Sol row is the **currently configured** geometry. Its paid raw-image pilot
scored 7/8 exact with one truncated identifier, no unsupported inventions, and
passing gist and guard checks on both fixtures. Sol remains opt-in. See
[`eval/sol-profile/RESULTS.md`](../eval/sol-profile/RESULTS.md).

## Provider boundaries

Anthropic resizes images to fit both a 1568px long edge and roughly 1.15MP.
The 1568×728 Claude page stays inside both bounds, so rasterized glyphs reach
the vision encoder without the old 0.555× resample.

OpenAI-shaped profiles use portrait strips. GPT 5.6 Sol uses 84×9+8, a 764px
strip up to 1954px; Grok uses 84×9+8, a 764px strip up to 512px.

There are two ceilings, not one. The documented provider limit is a count: 100
images per request, enforced through `imageHeadroom`. The second is weight, and
it is empirical: past roughly 20MiB of decoded image bytes, production requests
start failing as 500s, 502s, empty 200s and stalls (#157), and `/compact`
traverses the same oversized path, so a session cannot compact its way out.

`maxImageBytes` bounds that second budget, defaulting to 18MiB, deliberately
under the observed cliff rather than at it. The caller's own images are counted
first and are never removed to make room. Admission is atomic per semantic
group: the slab, one tool result, and the history collapse are each imaged whole
or kept as text whole, because a half-imaged group ships pages without the text
they replaced, and a partially imaged slab re-keys the cache prefix whenever the
budget arithmetic moves. `imageByteSkips` counts groups refused by weight, kept
separate from `imageBudgetSkips` because fewer pages and smaller pages are
different fixes; `imageBytesNearLimit` flags a request that finished inside the
top 10% of the budget.

## Font and Unicode

Atlases are generated at build time (`src/core/atlas*.ts`); runtime never loads
font files. Four font profiles are compiled in (`spleen-5x8`,
`jetbrains-mono-10`, `jetbrains-mono-12`, `jetbrains-mono-14`). The compact
JetBrains Mono atlases contain common code/Latin/symbol ranges, and missing
codepoints fall back to GNU Unifont (`Unifont-16.0.04.otf`), preserving
multilingual rendering. Font licenses are bundled in `assets/*_LICENSE.txt` (and
`/app/licenses/` in Docker):
- JetBrains Mono — SIL OFL 1.1 (`assets/JETBRAINS_MONO_LICENSE.txt`)
- GNU Unifont — SIL Open Font License 1.1 / GPLv2+ with GNU font embedding exception (`assets/UNIFONT_LICENSE.txt`)
- Spleen — BSD 2-Clause (`assets/SPLEEN_LICENSE.txt`)

Spacing, anti-aliasing, grid, color cycle, and newline-marker style are all part
of the model profile. The same style object is used for static slabs and history.

## Gate parity

The profitability gate resolves the same profile as the renderer and derives:

- cell width and height
- content-width shrink
- rows per page
- page count
- per-image token cost

Changing cell spacing or font therefore cannot leave cost prediction on a
hardcoded 5×8 canvas. Claude uses the Anthropic 28-px patch formula (with a
conservative margin at the gate), GPT uses model-specific tile/patch pricing, and
Grok uses the measured tokens-per-megapixel rate.

## Why not square pages

Billing follows pixel area or patches/tiles, not visual symmetry. Padding a
portrait or short final page to a square adds cost without adding information.
The target is readable characters per billed pixel under each provider's resize
contract, not a preferred aspect ratio.

## Measurement history

| date | change | finding |
|---|---|---|
| 2026-05-21 | R3 reflow | recovered line-end dead space by marking hard newlines with `↵` |
| 2026-05-22 | grayscale atlas + L1/L2 harness | measured style and instruction-band effects |
| 2026-06-09 | Fable-only 5×8 scope | Fable read dense cells better than Opus |
| 2026-06-17 | ~1932px experiment | fewer pages, later shown to be server-resampled on Anthropic |
| 2026-07-01 | Claude 1568×728 clamp | made billed pixels survive Anthropic preprocessing |
| 2026-07-09 | exact-model profiles | separated Claude, GPT 5.6 Sol, and Grok geometry/style |
| 2026-07-23 | Grok native 14px | JB Mono 8–16px sweep: 14px best (4/8); 84 cols / maxH 512; still opt-in |
| 2026-07-11 | default scope | Fable only; Sol and Grok remain opt-in after broader quality tests |

Older benchmark receipts retain their historical geometry; do not rewrite those
numbers as if they were generated by the current profile.

## Changing a profile

1. Add or re-run a reader-specific recall/style harness.
2. Measure the provider's real image-token accounting.
3. Keep the strip inside its no-resize boundary.
4. Test slab, history, gate, and cache determinism together.
5. Do not generalize one variant's result to sibling model ids.
