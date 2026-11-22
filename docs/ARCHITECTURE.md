# Architecture

`fiche` is a local/edge proxy and hybrid context compiler between a coding agent and its model API. For strong vision readers, it renders bulky, stable context as dense PNG microfiche pages (billed by pixel area rather than text token count); for text-tier models and textual blocks, it runs a 4-layer deterministic text compiler (`TSCG` → `Terminal / JSON / TOON / Drain` → `ACDC` → `CASI-Delta`) with zero images.

A 1568×728 page bills at about 1,456 tokens on Anthropic (1,078 on Gemini) and holds about 28k characters of 5×8 glyphs. As text, those characters cost roughly 7k–19k tokens. That gap — paired with append-only prefix-cache alignment and edit-safe source guards — is the whole product.

## System map

![fiche architecture](architecture/fiche-architecture.svg)

| Layer | Files | Job |
|---|---|---|
| Entry points | `src/node.ts`, `src/worker.ts`, `src/warp/`, `src/mcp/server.ts`, `src/turn-report.ts` | CLI and local server (port 47821), Cloudflare Worker build, the `warp` CONNECT proxy, MCP server (`fiche-mcp`), `<5 ms` tail turn-report |
| Proxy core | `src/core/proxy.ts`, `src/core/provider-router.ts`, `src/core/request-guard.ts`, `src/core/upstream-hosts.ts` | Routing, credential classification, model-scope & reader-tier gates, loopback Host/Origin guards, forwarding, streaming, events |
| Text compiler | `src/core/schema-compiler.ts`, `text-hygiene.ts`, `toon.ts`, `text-history.ts`, `casi-delta.ts` | `TSCG` schema/static compiler, terminal ANSI/CR hygiene + `Drain` log folding + bijective `@toon`, `ACDC` frozen-epoch digestion, `CASI-Delta` line hashing, `isCodeOrDiffProtected` |
| Wire transforms | `src/core/transform.ts` (Anthropic), `openai.ts` + `openai-history.ts` (Responses, Chat), `google.ts`, `history.ts`, `schema-strip.ts` | Find the static slab, the closed-tool history prefix, large tool results and reminders, and apply text hygiene / optical rendering |
| Renderer | `src/core/render.ts`, `atlas*.ts`, `png.ts`, `factsheet.ts`, `vision-cost.ts`, `*-model-profiles.ts` | Text to grayscale/RGB PNG (`Spleen 5×8`, `Unifont`, `JetBrains Mono 10/12/14px`), one font and geometry profile per model band, plus verbatim `FactSheet` |
| Cache state | `src/core/session-state.ts`, `codex-cache.ts` | Keep old pages/epochs byte-identical in `~/.fiche/session-state.json` so they stay in the prompt cache; repack only when no cache is live |
| Accounting | `src/core/baseline.ts`, `measurement.ts`, `tracker.ts`, `cpt-fit.ts`, `pricing.ts`, `src/stats.ts`, `src/dashboard*.ts` | Cache-aware "without `fiche`" baseline, `~/.fiche/events.jsonl` log, `kosha` pricing & cliff avoidance, fitted CPT, dashboard |
| Extras | `src/core/pin.ts`, `export.ts`, `messages-chat-bridge.ts`, `messages-responses-bridge.ts` | `@fiche pin` (legacy `@inkling pin` accepted), `fiche export`, and Anthropic-wire clients driving GPT or Chat Completions upstreams |

## One request

![One request through fiche](architecture/request-flow.svg)

- **Stage 1 (`TSCG`):** strips redundant JSON Schema metadata (`$schema`, `$comment`, redundant titles, divider lines, HTML comments) while preserving parameter names, types, required fields, enums, and constraints verbatim.
- **Stage 2 (`Terminal / @toon / Drain`):** resolves `\r`/ANSI/backspace sequences, converts uniform JSON arrays to lossless bijective `@toon` tables, and folds repetitive boilerplate logs (`Drain`) while `isCodeOrDiffProtected` keeps numbered source reads and unified diffs byte-exact.
- **Stage 3 (`ACDC`):** digests aged completed blocks behind `keepTailMessages` into append-only frozen epochs when payback/cliff math clears `kosha` economics.
- **Stage 4 (`CASI-Delta`):** indexes remaining verbatim tool outputs by 64-bit hash and line postings to replace exact re-reads and near-duplicate diffs with compact cross-turn deltas.
- **Stage 5 (Optical Microfiche, optical-tier models only):** renders the static slab, closed-tool history prefix, and large tool/reminder blocks into `Spleen` / `Unifont` / `JetBrains Mono` PNG pages paired with a deterministic ~96-token `FactSheet` (paths, SHAs, UUIDs, versions, flags, numbers).
- **Always text:** the live tail (`keepTail` turns), any open tool sequence, the latest assistant `tool_use` turn, and the current user turn.

## Cache stability

Most spend on long agent sessions is cache reads at 0.05×–0.1× the input price, so `fiche` never changes bytes it already sent:

- Sealed ACDC epochs and optical history grids are append-only. A chunk's bytes/pixels depend only on its message range, so old pages are read from cache on every later turn.
- With no live cache, `packFill` repacks pages for density instead.
- The factsheet uses a fixed order and contains no timestamps or randomness.
- `prompt_cache_breakpoint` is removed for ChatGPT Codex (`/backend-api/codex/`), which rejects it.

## Model routing & font bands

`readerTier` (`src/core/reader-tier.ts`) and profile tables (`claude-model-profiles.ts`, `gemini-model-profiles.ts`, `gpt-model-profiles.ts`) route models across four bands:

1. **Dense 5×8 bitmap (`spleen-5x8`, 5×8 cell + `Unifont` 8px fallback):** `claude-fable-5`, measured `gemini` vision tiers (`gemini-3.6-flash`, `3.7-flash`, `3.8-flash`, `gemini-4-argon`), `gpt-6` (non-Sol), and default GPT fallback (`312` cols on Claude/Gemini, `152` cols on GPT).
2. **Spaced 5×8 bitmap (`spleen-5x8` + `2px` row spacing → 5×10 cell):** `claude-fable-5-1`, `claude-fable-5-2`, and other opt-in Claude models (`312` cols, `1568×728` max). Intermediate `jetbrains-mono-10` (`6×11`) and `jetbrains-mono-12` (`8×13`) atlases are also compiled in for `FICHE_GPT_PROFILES`.
3. **Native 14px (`jetbrains-mono-14`, 9×16 cell + `Unifont` 14px fallback):** opt-in `gpt-5.6-sol` / `gpt-6.1-sol` / `gpt-6.2-sol` (`84` cols, `764×1954`), opt-in `grok-*` (`84` cols, `764×512`), and opt-in `qwen3.8-27b` (`84` cols, `764×512`, `providerImageCap: 32`).
4. **Text-only deterministic hygiene (zero images):** `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-*`, `gpt-6*-astra`, `gemini-4-neon/carbon/hydrogen`, `deepseek`, `kimi`, `glm`, `minimax`, and `grok` (unless `FICHE_FORCE_IMAGES=1`).

## Further reading

- [CACHING_AND_SAVINGS.md](CACHING_AND_SAVINGS.md): how the baseline is computed
- [HISTORY_CACHE_MODEL.md](HISTORY_CACHE_MODEL.md): the history grid and freeze rules
- [MODEL_RENDER_PROFILES.md](MODEL_RENDER_PROFILES.md): per-model fonts and geometry
- [SECURITY_MODEL.md](SECURITY_MODEL.md): credentials and routing
