# fiche Architecture

`fiche` (`@sriinnu/fiche`) is a local, cache-safe hybrid optical + deterministic text context compiler, loopback proxy, TLS warp interceptor, MCP server, and native macOS status monitor for coding agents.

## 1. Design Boundary: Pure Core vs. Host Adapters

Every transformation algorithm lives under [`src/core/`](../src/core/) with **zero `node:` imports and zero runtime `Buffer` references** (`node:` / `Buffer` appear only in comments and Web-standard types). The exact same compiler runs inside the Node daemon, the Cloudflare Worker bundle, offline export helpers, and the Vitest suite.

```text
+-------------------------------------------------------------------------+
| Host Adapters (Node.js / Cloudflare Workers / TLS Warp / MCP / Swift)   |
|  - src/node.ts        Loopback HTTP proxy (:47821), CLI, daemon boot     |
|  - src/worker.ts      Cloudflare Workers entry (edge/serverless parity)  |
|  - src/warp/          Local HTTPS CONNECT + macOS GUI launcher (--app)   |
|  - src/mmu-store.ts   Optional 0600 atomic mmu-pages.json persistence    |
|  - src/calibrate.ts   Live Vision probe runner & CLI calibration store   |
|  - src/dashboard.ts   Warm Paper UI, PNG strip viewer, /api/mmu/*        |
|  - src/mcp/server.ts  Stdio & HTTP (:47823) MCP server + proxy fallback  |
|  - apps/macos-bar/    Swift 6 / SwiftUI menu bar status monitor          |
+------------------------------------+------------------------------------+
                                     | RequestEnvelope / SessionState
                                     v
+-------------------------------------------------------------------------+
| Pure Core Engine (src/core/ — zero node: imports, zero runtime Buffer)  |
|  - proxy.ts           Inbound/outbound orchestration & fail-open guard   |
|  - schema-compiler.ts P0: XML-Island TSCG, Merkle $defs._fN, JSON unwrap |
|  - text-hygiene.ts    Line compaction, ANSI/CR strips, opt-in user clean |
|  - casi-delta.ts      P1: Gutter strip, seedBase, LIS alignment, FastCDC |
|  - calibration.ts     P1: 4-axis probe & pixel/height clamps (tile<=768) |
|  - reader-tier.ts     Model tier routing & calibrated font-band lookup   |
|  - text-history.ts    P2: LSM-Context L1/L0/L2 single-block sticky epochs|
|  - context-mmu.ts     P3: Virtual pages (pg_<12hex>), tail hydration,    |
|                       Markovian folding, Turn-1 skills, IDF pruning      |
|  - session-state.ts   Sealed epoch keys, pinned skills, folded episodes  |
|  - google.ts / transform.ts / openai.ts  Wire adapters + Optical guard   |
+-------------------------------------------------------------------------+
```

## 2. Client Topology & Opt-In Provider Routing

`fiche` supports **29 built-in upstream hosts across 21 providers (`6` first-party + `23` COMPAT)** through four opt-in surfaces:

1. **Shell Wrappers (`fiche shell-init --wrap`)**: Generates POSIX wrapper functions routing invocations via `fiche warp -- <cli>` (with `FICHE_BYPASS=1` bypass) for **9** CLIs (`claude`, `codex`, `agy`, `gemini`, `opencode`, `cursor-agent`, `amp`, `pi`, `aider`).
2. **Loopback Proxy (`127.0.0.1:47821`)**: Accepts Anthropic Messages, OpenAI Responses & Chat Completions, and Google `generateContent` / `streamGenerateContent` wires.
3. **TLS Warp (`fiche warp --app`)**: Local `CONNECT` MITM proxy using an owner-only local CA to intercept desktop Electron/native apps without rewriting binary configs.
4. **Offline & Programmatic (`fiche export`, MCP)**: Deterministic bundle export (`promptfoo` / CI evals) and MCP tools (`check_model`, `transform_request`, `page_in`, `mmu_stats`, `health`, `stats`).

For request attribution and fail-open control:
- Sending `x-fiche-bypass: 1` forwards requests byte-for-byte untouched.
- Unexpected exceptions inside any transform catch cleanly and fall back to the original body so inference never fails closed on compiler bugs.

## 3. P0–P3 & Context-MMU Transformation Pipeline

Depending on the resolved model tier in [`reader-tier.ts`](../src/core/reader-tier.ts) and [`calibration.ts`](../src/core/calibration.ts), a session takes one of two paths:

### Path A: Text + Context-MMU (0 images, default for uncalibrated text-tier models)

1. **Stage 0 — Turn-1 Skill Linker (`context-mmu.ts`)**: When a prompt carries `<skills>`, `Available skills:`, or `SKILL.md` catalogs (`>= 10` skills) with an active store and net savings `>= 400` chars & `>= 100` tokens, retains `DEFAULT_CORE_SKILLS` plus the top `maxVerbatim = 6` task-relevant skills, stubs low-relevance descriptions as `- <name> [<pgId>] (stubbed; mention name to auto-hydrate)`, and pins kept skills (`pinnedSkillCatalogHash` + up to `32` names per session) in `session-state.ts` so Turns `1..N` stay byte-identical. Mentioning any single- or multi-word stubbed skill later auto-hydrates it in the live tail.
2. **P0 — Structural Normalization (`schema-compiler.ts`, `text-hygiene.ts`)**:
   - **XML-Island TSCG**: Separates volatile tags (`VOLATILE_XML_TAGS`: `env`, `context`, `system-reminder`, `fast_mode_info`, `git_status`, `additional_metadata`) before `minParaChars` (`140` static text, `96` tool schemas) deduplication.
   - **Merkle Schema DAG**: Factors repeated JSON subschemas into `$defs._fN` on Anthropic & OpenAI wires (bypassed on Google wire schemas).
   - **Single-level JSON-in-JSON Unwrap**: Unescapes escaped strings across `8` standard fields (`output`, `stdout`, `stderr`, `content`, `result`, `body`, `text`, `data`), with `@fiche-kv` fallback for heavily escaped envelopes (`>= 40` tokens & `>= 15%` saved).
   - **Opt-In User Hygiene**: `cleanUserPayloads` defaults to `false` on all 4 wires (leaving Turn-1 prompts untouched by default); when opted in, applies lossless ANSI/whitespace/`@toon` hygiene (`foldLogs: false`, `enableJsonUnwrap: false`, `enableDensityPrune: false`) to non-code/non-diff user payloads with `>= 1,500` non-volatile chars.
3. **P1 — Cross-Turn Content-Addressable Dedupe (`casi-delta.ts`)**: Strips line-number gutters, seeds bases from assistant `Write`/`Edit` tool calls (`seedBase`), detects exact duplicates (`[fiche cas: exact duplicate...]`), tracks shifted line spans via Longest Increasing Subsequence (LIS), emits contextual deltas (`[fiche cas-delta vs ...]`, restricting timestamp/duration canonicalization strictly to real log streams so YAML/JSON config edits stay lossless), and falls back to `GEAR_TABLE` FastCDC slices (`8–48` lines).
4. **P2 — LSM-Context Compacting Prefix (`text-history.ts`)**:
   - **L1 (`tail = 2`)**: Compacts aged large blocks (`>= 1,500` tokens) strictly as 1-block `[item]` sticky epochs anchored by `sessionKey` + `fnv64Hex(e.raw)` with FIFO single-entry eviction.
   - **L0 (`tail = 6`)**: Runs Kosha-gated epoch digests on older turns.
   - **L2 Cold Repack**: Triggers only when upstream cache is confirmed cold (`everCacheAlive && !lastCacheAlive`, `1h + 30s` idle, or `413` backstop) with `justRepacked` anti-thrash protection across all `5` provider cache-read JSON `usage` fields (`cache_read_input_tokens`, `input_tokens_details.cached_tokens`, `prompt_tokens_details.cached_tokens`, `cachedContentTokenCount`, `prompt_cache_hit_tokens`).
5. **P3 — Context-MMU Paging, Markovian Folding, IDF Pruning & Tail Hydration (`context-mmu.ts`)**:
   - **Virtual Pages (`pg_<12hex>`)**: Evicted tool blocks become deterministic UTF-8 FNV-1a pages in `ContextPageStore` (`512`-page / `16 MiB` LRU protecting `skill-catalog` pages), rendered inline as `[fiche vm-page pg_<12hex> (<path>, <N>L) | top symbols: ... | page_in("pg_<12hex>")]`.
   - **Birth-Time IDF Density Pruning (`pruneLowDensityBlob`)**: Scores verbose unstructured dumps using IDF line rarity `log(1 + n / (1 + freq))` plus structural weights while unconditionally skipping `FILE_READ_TOOL_RE`, `isCodeOrDiffProtected`, HTTP JSON, YAML, `STACK_PREFIX_RE`, bare `filename:line` entries, and coalescing only short (`<=64c`) low-score (`lineScores[i] < 4`) 1-line islands; refuses mutation if `store.maxBytes` rejects storage.
   - **Markovian Folding**: Folds failed-to-passing test/build churn into the longest predecessor (`[fiche causal-episode ep_<10hex>: ...]` + `[folded into ep_<10hex>]`), anchored at first `FAIL`, preserving pre-failure reads, and gating on downstream payback before storing pages.
   - **Tail Hydration**: `computeTailHydration` (fail-closed when `sessionKey` is missing or empty) injects `±15`-line slices exclusively inside `[fiche vm-hydrate] ... [/fiche vm-hydrate]` at the **live uncached tail** (`MAX_DEREF_CHARS = 65_536`). Explicit `page_in("pg_<12hex>")` via MCP rejects empty `""` `sessionKey` and falls back to daemon HTTP when needed.

### Path B: Hybrid Calibrated Optical (`optical` + TOON + hygiene)

Models with verified vision legibility (either empirically measured or probed via `fiche calibrate <model>` across `spleen-5x8`, `spleen-5x10`, `jetbrains-mono-12`, and `jetbrains-mono-14` with `HEX >= 0.85`, `CODE >= 0.90`, `NUM >= 0.95`, `GUARD = 1.0`) render aged eligible history blocks onto calibrated monospace microfiche PNG strips (`src/core/calibration.ts` enforces height clamping on `<= 512px` latency-cliff models and pixel-width clamping on `tile` models so images never exceed the `768px` short edge — e.g., `152` cols at `5px`, `95` cols at `8px`, `84` cols at `9px`).

Two architectural invariants keep the Optical path cache-safe and edit-safe:
- **Optical + CASI Mutual Exclusion**: When `opticalEnabled` / `effectiveImageCompress` is true across Google, Anthropic/Transform, and OpenAI wires, `CASI` is disabled (`!opticalEnabled`) so live tail diffs never become orphan `[fiche cas: ...]` pointers referencing collapsed PNG strips (`mcp/server.ts` reports `'image+TOON+hygiene'`).
- **Google `pinnedUserText` Split & Live-Tail File Read Safety (`google.ts`)**: Mutable `pinnedUserText` is detached from `contents[0]` onto the trailing live turn so sealed optical strips in `contents[0]` stay prefix-immutable (`79.7%` cache hit vs `11.9%` prior to decoupling), while `read_file`/`view_file` responses stay verbatim in the live tail until sealed (`49.0%` raw / `34.1%` weighted saved, `editSafe = true`).

For algorithm derivations and cost/savings math, see [CONTEXT_MMU_ARCHITECTURE.md](./CONTEXT_MMU_ARCHITECTURE.md).

## 4. State, Security & Persistence Boundaries

| State Artifact | Location | Default Mode | Security Controls |
| --- | --- | --- | --- |
| Session prefix seals & skill pins | `~/.fiche/session-state.json` | Enabled (disable via `FICHE_SESSION_STATE=off`) | `0600` file permissions, bounded LRU (`SESSIONS_MAX = 512`) |
| Calibrated optical registry | `~/.config/fiche/calibrated-models.json` | Enabled for CLI `fiche calibrate` | `lstatSync` + `O_NOFOLLOW`, `1 MiB` load cap, `0600` atomic write |
| Virtual memory pages (MMU) | `~/.fiche/mmu-pages.json` (adjacent to `$FICHE_LOG` when overridden) | **Daemon RAM-only** (opt-in: `FICHE_MMU_PERSIST=1`) | `lstatSync` + `O_NOFOLLOW`, `O_EXCL`, `0600`, `24h` idle TTL (drops missing/`<= 0`), `32 MiB` `load()` cap, high-confidence secret skip (PEM, `Bearer`, `sk-`, `gh[pousr]_`, `AKIA`, env secrets) |
| Local savings events | `~/.fiche/events.jsonl` | Local append-only JSONL | Reverse-tail scanner (`<5 ms`), zero outbound telemetry |

[`src/node.ts`](../src/node.ts) enforces loopback/Host validation, `sec-fetch-site: cross-site` rejection, and same-origin `Origin` checks across all dashboard routes (`GET` + mutations). [`src/dashboard.ts`](../src/dashboard.ts) serves `/api/mmu/*` and `/api/calibration` via `mmuJsonResponse` (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`), omits `factTokens` on unscoped `/api/mmu/stats`, rejects empty `sessionKey` with HTTP `400`, and caps query strings at `512` chars.

## 5. CLI, MCP & Native Monitor Surfaces

- **Calibration CLI**: `fiche calibrate <model> [--provider auto|google|anthropic|openai] [--band auto|spleen-5x8|spleen-5x10|jetbrains-mono-12|jetbrains-mono-14] [--dry-run] [--list] [--clear <model>] [--json]`
- **MMU Inspection CLI**: `fiche mmu [stats | pages | page <id>] [--query <text>] [--session <key>] [--port <P>] [--json]`
- **MCP Server (`:47823` / stdio)**: `page_in`, `mmu_stats` (`{ source, stats, pageCount, pages }`), `check_model`, `transform_request`, `health`, `stats` (with automatic HTTP fallback to the running daemon when local `page_in` misses, propagating `sessionKey`).
- **FicheBar.app (`apps/macos-bar/`)**: Native Swift 6 / SwiftUI menu bar monitor tracking weighted vs. raw savings, cache hit rate, built-in compiler stages, and opt-in provider status.

## 6. Verified Benchmark Summary (`bench/context-mmu-eval.mts`)

Measured on the hardened 30-turn coding replay (`gemini-4-neon`, `google` wire, `904,363` baseline raw tokens / `281,715` weighted tokens):

| Arm | Raw Save | Weighted Save | Cache Hit (Part / Unit) | p50 / p95 ms | EditSafe | Tail Recall |
| --- | ---: | ---: | ---: | ---: | :---: | :---: |
| Baseline (uncompressed) | 0.0% | 0.0% | 91.8% / 91.8% | 0.00 / 0.00 | `true` | `true` |
| v0.18 Text (`lsm/mmu/skillLinker` off) | 42.5% | 35.8% | 87.0% / 86.9% | 8.65 / 13.60 | `true` | `false` |
| P0–P3 Text + Context-MMU (0 images) | 43.1% | 37.0% | 87.4% / 87.3% | 15.83 / 21.06 | `true` | `true` |
| P0–P3 + Calibrated Optical (`spleen-5x8`, 153 imgs) | 49.0% | 34.1% | 79.7% / 76.3% | 3.11 / 46.91 | `true` | `true` |

Cross-wire 30-turn checks (all `14` active stages including `markov_fold`, both `editSafe = true` and `tailRecallVerified = true`):
- **Anthropic (`claude-opus-5-5`, 1.25× write premium modeled)**: `45.1%` raw saved, `33.9%` weighted saved, `88.3%` cache hit (`15.05 ms` avg).
- **OpenAI Responses (`gpt-6-astra`)**: `45.4%` raw saved, `39.5%` weighted saved, `89.7%` cache hit (`14.61 ms` avg).

## 7. Zero-Drop Transport, Socket Activation & Warp Fail-Open (`#33` / `#34`)

- **Upstream HTTP/1.1 Keep-Alive Fetch (`src/node-fetch.ts`, `#33`)**: Node adapter uses dedicated HTTP/1.1 `node:http` / `node:https` keep-alive `Agent`s (`keepAlive: true`) with persistent `'error'` listeners, `AbortSignal` teardown (`req.signal` client-disconnect propagation from `src/node.ts`), pull-based backpressure, and streaming decompression — avoiding Node 26 / `undici` HTTP/2 idle-reaper `ClientHttp2Stream` crashes.
- **`launchd` & `systemd` Socket Activation (`src/launchd-socket.ts`, `src/node.ts`, `#34`)**: `fiche service install` compiles a `<launch.h>` exec trampoline (`~/.fiche/bin/fiche-launchd-exec`) and emits `<key>Sockets</key>` (`Listeners`), `ThrottleInterval: 1`, and `ExitTimeOut: 65`. `fiche` adopts inherited fd `3` via `LISTEN_FDS`/`LISTEN_PID` (also compatible with Linux `systemd`), binds `server.listen({ fd })` ahead of slow store/replay startup behind `readyPromise`, and preserves freshly accepted sockets across `SIGTERM` via `connTrack` (`closeIdleSockets(false)`) during the `60s` active SSE drain (`API_SHUTDOWN` absorbs one subsequent `launchctl bootout` `SIGTERM`).
- **Fail-Open `fiche warp` & Loopback `NO_PROXY` (`src/warp/`)**: Probes `127.0.0.1:port` (`isLocalDaemonReachable`) and launches unwrapped (`FICHE_BYPASS=1`) when stopped; sets `NO_PROXY` / `no_proxy` (`mergeNoProxy` preserving existing entries + `localhost,127.0.0.1,::1`); and retries directly against origin on mid-session diverted `ECONNREFUSED` before piping request bytes (`failOpenOnDivertRefused: true`).
