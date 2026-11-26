# `fiche` P0–P3 & Context-MMU Technical Architecture

This specification documents the algorithms, prefix-cache cost math, data structures, security boundaries, and empirical verification behind the `v0.19` P0–P3 and Context-MMU compiler inside `src/core/`.

---

## 1. Local Log Forensics & The KV-Cache Paradox

Local proxy receipts (`332` requests / `211` compressed in `/proxy-stats`; `819` rows in `~/.fiche/events.jsonl`) revealed why counting raw stripped tokens overstates real spend savings:

- **Observed Baseline Trap**: Trimming `1,683,272` raw tokens yielded `472,859` weighted tokens saved (`4.2%` of eligible spend, `$0.1211` net saved). Spend was dominated by heavily cached long sessions (`gemini-4-hydrogen-xhigh`: `40,687,660` input tokens with `38,092,263` cached), uncalibrated text-tier models (`gemini-4-neon-xhigh`), and single-turn utility traffic (`gemini-3.5-flash-lite`: `432` requests, `4,032,126` tokens skipped).
- **The Prefix-Breakage Multiplier**: Assume a `90%` cached-input discount (`0.10×` weighted cost per cached token). Suppose a prefix of `10,000` cached tokens sits ahead of a `50`-token tail (`10,000 × 0.1 + 50 = 1,050` weighted tokens). If an eager compressor saves `50` tokens inside that prefix and invalidates KV cache across all `10,000` tokens (`0.1 -> 1.0`), billed weight jumps from `1,050` to `10,000` weighted tokens—a **`9.5×` segment cost multiplier** and a **`179×` net penalty** (`+8,950` extra weighted tokens vs. `50` saved).
- **The Google Optical `contents[0]` Paradox**: Before hardening, `planGoogleHistory` appended mutable `pinnedUserText` into `contents[0]` alongside sealed optical PNG strips. On a 30-turn replay, raw tokens dropped dramatically, yet mutating `contents[0]` every turn collapsed prefix cache hit from `91.8%` to `11.9%`, yielding only `27.8%` weighted savings. Detaching `pinnedUserText` onto the trailing live turn, disabling `CASI` pointers when Optical is active (`!opticalEnabled`), and keeping live-tail `read_file`/`view_file` results verbatim until sealed restored Google Optical cache hit to `79.7%` (`49.0%` raw / `34.1%` weighted saved with `editSafe = true` and `tailRecallVerified = true`), while 0-image Text + Context-MMU leads weighted savings at `37.0%`.

---

## 2. Prefix-Cache Economics & Cold-Cache Trigger

### 2.1 Weighted Token Billing Formula

For each provider/model entry in `kosha`, `WeightedPromptTokens` models real prompt-side dollar sensitivity:

- **Google / OpenAI Read-Discount Wires**: `WeightedPromptTokens = uncached_input + α · cached_read_tokens`
- **Anthropic Cache-Write Premium**: `WeightedPromptTokens` models both cache-read discount `α` AND `1.25×` cache-creation write surcharge (`cache_creation_input_tokens`) whenever prefix bytes change or extend. *(On `/v1/messages` routes bridged to OpenAI Responses/Chat, synthesized `cache_creation_input_tokens: 0` is omitted from `noteCacheOutcome` so `justRepacked` implicit-cache hysteresis stays intact.)*

### 2.2 `L2` Cold-Cache Trigger (`text-history.ts`)

`LSM-Context` inspects all `5` upstream cache-read JSON `usage` fields across turns:
`cache_read_input_tokens`, `input_tokens_details.cached_tokens`, `prompt_tokens_details.cached_tokens`, `cachedContentTokenCount`, and `prompt_cache_hit_tokens`.

- **`everCacheAlive && !lastCacheAlive`**: Full `L2` cold repack runs only after an active session's upstream cache actually expires (or hits the `1h + 30s` idle backstop or HTTP `413` payload-limit trigger).
- **`justRepacked` Anti-Thrash Guard**: Prevents consecutive turns from oscillating into repeated repacks before an implicit prefix cache re-warms.

---

## 3. Pipeline Stages & Algorithms (`P0` → `P3`)

All core stages live inside `src/core/` with **zero `node:` imports and zero runtime `Buffer` references**, keeping Node daemon, Workers, MCP, and browser bundles identical.

### 3.1 Turn-1 Skill Catalog Linker (`linkSessionSkills`, `context-mmu.ts`)

Coding-agent prompts routinely inject dozens of `SKILL.md` descriptions on Turn 1. `linkSessionSkills`:
1. Triggers only when an active `ContextPageStore` is present, `<skills>` / `Available skills:` / `SKILL.md` entries number `>= 10`, and net compaction exceeds `>= 400` chars & `>= 100` tokens.
2. Scores each skill once against `firstUserText` + workspace hints on **Turn 1**, keeping `DEFAULT_CORE_SKILLS` plus the top `maxVerbatim = 6` relevant skills verbatim.
3. Pages low-relevance descriptions into the MMU store and replaces them inline with `- <name> [<pgId>] (stubbed; mention name to auto-hydrate)`.
4. Pins `(pinnedSkillCatalogHash, keptSkills)` per session (up to `PINNED_SKILLS_MAX = 32` skill names across `SESSIONS_MAX = 512` LRU sessions) in `session-state.ts` so Turns `1..N` keep byte-identical system prefixes.
5. Automatically detects later references to both multi-word (`gcp-spark-troubleshooting`) and single-word (`kubernetes`) stubbed skills and hydrates the full skill block into the trailing uncached user turn.

### 3.2 `P0`: Structural Compiler & Opt-In User Hygiene (`schema-compiler.ts`, `text-hygiene.ts`)

- **XML-Island TSCG (`compileStaticText`, `compileSegmentedStaticText`)**: Isolates volatile islands tagged with `VOLATILE_XML_TAGS` (`env`, `context`, `system-reminder`, `fast_mode_info`, `git_status`, `additional_metadata`) so rotating metadata never invalidates static system paragraphs deduplicated at `minParaChars = 140` (`96` inside `compileToolSchemas`).
- **Merkle Schema DAG (`factorSharedSchemaSubtrees`)**: Factors repeated JSON Schema objects across tool declarations into `$defs._fN` on Anthropic & OpenAI wires; bypassed cleanly on Google function-declaration schemas (`wire !== 'google'`).
- **Single-Level JSON-in-JSON Unwrapping (`unwrapNestedJsonStrings`)**: Unescapes JSON strings inside `8` standard envelope fields (`output`, `stdout`, `stderr`, `content`, `result`, `body`, `text`, `data`), falling back to `@fiche-kv` key-value projection on heavily escaped envelopes saving `>= 40` tokens and `>= 15%`.
- **Opt-In User Prompt Hygiene (`cleanUserPayloads`)**: Defaults to `false` across all `4` wire entry points (leaving Turn-1 prompts untouched by default). When opted in, `cleanUserBlockPreservingXml` applies lossless ANSI/whitespace/`@toon` hygiene (`foldLogs: false`, `enableJsonUnwrap: false`, `enableDensityPrune: false`) to non-code/non-diff user payloads `>= 1,500` non-volatile chars (`MIN_USER_CLEAN_CHARS`). All wires preserve the canonical pre-hygiene `firstUserSha8` so session keys never split across cache/MMU tracking.

### 3.3 `P1`: `CASI v2` & 4-Axis Vision Calibration (`casi-delta.ts`, `calibration.ts`, `calibrate.ts`)

- **`CASI v2` Cross-Turn Deduplication**:
  - Strips line-number gutters before fingerprinting.
  - Seeds base snapshots directly from assistant `Write` / `Edit` payloads (`seedBase`) and preserves `|pg_<id>` attribution on compacted MMU blocks.
  - Emits exact duplicate pointers (`[fiche cas: exact duplicate of earlier tool output <ref> ...]`), shifts aligned via LIS (`[fiche cas: lines shifted ...]`), line-level contextual deltas (`[fiche cas-delta vs ...]`, restricting timestamp/duration canonicalization strictly to verified log streams where both `base` and `cur` are `isLogLike`, so YAML/JSON/config duration edits stay exact), and `GEAR_TABLE` FastCDC sub-block slices (`8–48` lines: `[fiche cas-slice: lines a..b identical to <ref>:c..d ...]`).
  - **Optical Mutual Exclusion**: Disabled whenever `opticalEnabled` / `effectiveImageCompress` is true across `google.ts`, `transform.ts`, and `openai.ts` so live tail diffs never become orphan pointers into PNG strips.
- **Auto-Calibration Vision Probe (`CalibrationProbe`, `fiche calibrate`)**:
  - Tests candidate bands (`spleen-5x8` -> `spleen-5x10` -> `jetbrains-mono-12` -> `jetbrains-mono-14`) across four synthetic axes: `HEX >= 0.85` (6 × 12-char hex tokens), `CODE >= 0.90` (syntax fidelity), `NUM >= 0.95` (4 floating-point values), and `GUARD = 1.0` (4 negative-constraint guards).
  - Applies `clampedMaxHeightPx` on `<= 512px` latency-cliff models and clamps strip pixel width via `renderCellWidth` on `tile` models (never exceeding the `768px` short edge: `152` cols at `5px`, `95` cols at `8px`, `84` cols at `9px`), storing up to `256` entries in memory.
  - Delimiter-boundary prefix lookup avoids substring mismatches across similarly named models; persisted to `0600` `~/.config/fiche/calibrated-models.json` via `O_EXCL | O_NOFOLLOW`.

### 3.4 `P2`: `LSM-Context` Append-Only Prefix Compaction (`text-history.ts`)

- **Sticky Single-Block Epochs**: Aged blocks (`>= 1,500` tokens) passing the live `L1` horizon (`tail = 2`) or `L0` Kosha-gated horizon (`tail = 6`) are sealed strictly as single-block `[item]` epochs keyed by `buildStickyKey(sessionKey, fnv64Hex(e.raw))`—guaranteeing earlier turns never shift or coalesce into multi-block chunks (`stickySealedEpochs` / `stickyCliffEpochs` use FIFO single-entry eviction).
- **L2 Cold Repack**: On verified upstream cache expiry, performs full cold compaction (also pinning per-block single sticky keys) with `justRepacked` cooldown.
- **Exact BPE Memoization**: `countTokensExactCached` maintains a bounded `2,048`-entry LRU cache cleared by `resetTextEpochStickyState()`.

### 3.5 `P3`: `Context-MMU` Virtual Memory, Birth IDF Pruning & Tail Hydration (`context-mmu.ts`)

- **Session-Isolated Virtual Page Store (`ContextPageStore`)**:
  - Hashes canonical UTF-8 bytes via `fnv64Hex` (zero `node:crypto`, zero `BigInt` heap churn) into deterministic `pg_<12hex>` IDs.
  - Bounded `512`-page / `16 MiB` LRU protecting `skill-catalog` pages inside `evictOldest()`.
  - Uses a bounded `2,048`-entry `countTokensFast` BPE cache.
  - **`sessionKey` Scoping**: `computeTailHydration` fails closed on missing or empty `sessionKey`; `resolveEntryByPageId`, `derefPage`, `listPages`, and `searchPages` strictly isolate (and fail closed on explicit empty/whitespace `""`) when `sessionKey` is passed, falling back across sessions only when `sessionKey` is `undefined` for unscoped MCP/HTTP inspection. Dereferences are capped at `MAX_DEREF_CHARS = 65_536`.
  - Emits compact inline cards: `[fiche vm-page pg_<12hex> (<path>, <N>L) | top symbols: ... | page_in("pg_<12hex>")]`.
  - `searchPages` caps queries at `512` chars / `16` terms with hoisted lowercase matching.
- **Birth-Time Structural Density Pruning (`pruneLowDensityBlob`)**:
  - Immediately skips `FILE_READ_TOOL_RE`, `isCodeOrDiffProtected`, HTTP JSON responses, and YAML documents.
  - Scores verbose unstructured dumps with IDF line rarity `Math.log(1 + n / (1 + freq(l)))` plus structural signal weights—preserving error lines, `STACK_PREFIX_RE` frames, bare `filename:line` code locations, and high-score lines while coalescing only short (`<=64c`) low-score (`lineScores[i] < 4`) 1-line islands. If `opts.store` declines to store an oversized blob (`> maxBytes`), `pruneLowDensityBlob` aborts mutation cleanly instead of emitting a dangling `pg_*` marker.
- **Causal Markovian Episode Folding (`foldMarkovianEpisodes`)**:
  - Detects failing-to-passing test/build chains anchored at the first `FAIL`, preserves pre-failure file reads outside the fold, checks `resolvePriceRates` + non-tool/checkpoint `downstreamCachedTokens` payback (incorporating Stage 3a `stage2SavedChars` savings) before committing pages (`storePage` runs after payback passes), skips tiny blocks (`<= continuationMarker.length + 8`), writes `[fiche causal-episode ep_<10hex>: ...]` with the verified checkpoint certificate inside the longest predecessor (`[folded into ep_<10hex>]`), and persists folded episode IDs in `session-state.ts` (`recordFoldedEpisodeId`/`hasFoldedEpisodeId`).
- **Late-Turn Tail Hydration (`computeTailHydration`)**:
  - Scans only the active live tail for symbol or page references pointing to paged blocks and injects `±15`-line slices solely inside the trailing uncached user turn:
    ```text
    [fiche vm-hydrate]
    --- page pg_<12hex> (<label> L<s>-<e>, matched "<sym>") ---
    ...
    [/fiche vm-hydrate]
    ```
  - Historical prefix messages stay bit-for-bit untouched.

---

## 4. Security, Persistence & HTTP/MCP Surfaces

- **Persistence (`src/mmu-store.ts`, `src/calibrate.ts`, `src/node.ts`)**: MMU stays strictly in daemon memory by default. Setting `FICHE_MMU_PERSIST=1` (with `FICHE_SESSION_STATE` not off) writes `~/.fiche/mmu-pages.json` (next to `$FICHE_LOG` when overridden) via random temp file + `O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW ?? 0)` + `fchmodSync(fd, 0o600)`. Both `mmu-store.ts` (`32 MiB` cap) and `calibrate.ts` (`1 MiB` cap) read via `lstatSync` + `O_NOFOLLOW` to reject symlinks and warn on permissive directories. MMU `serialize()`/`restore()` enforce `PERSIST_MAX_IDLE_MS = 24h` (dropping missing/`<= 0` timestamps), finite `lineCount` validation, and `containsHighConfidenceSecret` filtering (PEM keys, `Bearer`, `sk-`, `gh[pousr]_`, `AKIA`, env secrets).
- **Origin & HTTP Dashboard (`src/node.ts`, `src/dashboard.ts`)**: `src/node.ts` enforces loopback Host checks, `sec-fetch-site: cross-site` blocking, and same-origin `Origin` validation on all routes (`GET` + mutations). `src/dashboard.ts` serves `/api/mmu/*` and `/api/calibration` with `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` (`mmuJsonResponse`), omits `factTokens` on unscoped `/api/mmu/stats`, rejects explicit empty `?sessionKey=` with HTTP `400`, caps `/api/mmu/page` queries at `512` chars (`400`), and passes `sessionKey` on both `pageId` and `query` branches.
- **MCP (`src/mcp/server.ts`) & CLI (`fiche mmu`)**: `page_in` and `mmu_stats` reject empty/whitespace `sessionKey`, validate positive safe integer ranges, fall back to the running `:47821` daemon HTTP API with `sessionKey` whenever in-process lookup misses, surface HTTP errors honestly instead of coercing to empty stats, and expose structured JSON via `fiche mmu [stats | pages | page <id>] [--query <text>] [--session <key>] [--port <P>] [--json]`.

---

## 5. Verification & Benchmark Results (`bench/mmu-results.generated.json`)

Executed against the hardened `0.19.0` build (`2026-11-24T11:16:06.077Z`, 30-turn replay on `gemini-4-neon`, `904,363` baseline raw tokens / `281,715` weighted tokens):

| Arm | Raw Tokens | Raw Save | Weighted Tokens | Weighted Save | Cache Hit (Part / Unit) | p50 / p95 ms | EditSafe | Tail Recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | :---: |
| Baseline (uncompressed) | 904,363 | 0.0% | 281,715 | 0.0% | 91.8% / 91.8% | 0.00 / 0.00 | `true` | `true` |
| v0.18 Text (`lsm/mmu/skillLinker` off) | 520,159 | 42.5% | 180,943 | 35.8% | 87.0% / 86.9% | 8.65 / 13.60 | `true` | `false` |
| P0–P3 Text + Context-MMU | 514,602 | 43.1% | 177,418 | 37.0% | 87.4% / 87.3% | 15.83 / 21.06 | `true` | `true` |
| P0–P3 + Calibrated Optical (`spleen-5x8`, 153 imgs) | 460,997 | 49.0% | 185,602 | 34.1% | 79.7% / 76.3% | 3.11 / 46.91 | `true` | `true` |

**MMU Activity (P0–P3 Text + Context-MMU Arm, Unique vs. Cumulative):**
- Unique pages stored: `33` (`tailHydrations = 1`, `tailHydrationTokens = 1,212`)
- Unique Markovian folds: `1` (`cumulativeMarkovFolds = 1`)
- Unique stubbed skill entries: `12` (`cumulativeSkillStubs = 360` across 30 replayed turns)
- Unique density-pruned blocks: `1` (`cumulativeDensityPrunedBlocks = 25` across 30 replayed turns)

**Cross-Wire 30-Turn Verification:**
- **Anthropic (`claude-opus-5-5`, 1.25× write premium)**: `915,095 -> 502,827` raw (`45.1%` raw saved), `33.9%` weighted saved, `88.3%` cache hit, `15.05 ms` avg / `20.38 ms` p95, `editSafe = true`, `tailRecallVerified = true`.
- **OpenAI Responses (`gpt-6-astra`)**: `917,335 -> 500,724` raw (`45.4%` raw saved), `39.5%` weighted saved, `89.7%` cache hit, `14.61 ms` avg / `20.22 ms` p95, `editSafe = true`, `tailRecallVerified = true`.
- Active stages observed on both cross-wire runs (`14` total): `skill_linker`, `tscg`, `schema_dag`, `acdc_epoch`, `lsm_l1`, `mmu_page`, `toon`, `casi_slice`, `casi_delta`, `casi_dup`, `density_prune`, `markov_fold`, `lsm_l2_cold`, `mmu_hydrate`.

Hardening regression coverage lives in `tests/context-mmu-hardening.test.ts` (19 targeted tests spanning P0–P3, bridged proxy cache hysteresis, canonical pre-hygiene session keys, MCP, persistence, and CLI) alongside `tests/context-mmu.test.ts`, `tests/lsm-context.test.ts`, `tests/calibration-probe.test.ts`, `tests/casi-v2-fastcdc.test.ts`, and `tests/mcp-server.test.ts`.
