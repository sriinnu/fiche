# Changelog

`@sriinnu/fiche` (`fiche`) follows [Semantic Versioning](https://semver.org/) (pre-1.0: minor =
features or behaviour changes, patch = fixes). Where the code comes from is in
the README's Credits section.

## 0.19.0

- **P0–P3 Context Compiler & `Context-MMU` Virtual Memory (`src/core/context-mmu.ts`, `prefix-tape.ts`, `text-history.ts`, `schema-compiler.ts`, `casi-delta.ts`)**:
  - **P0 Structural, Hygiene & `PrefixMemoTape`**: XML-Island TSCG separating `6` volatile `VOLATILE_XML_TAGS` before paragraph deduplication (`96` schema / `140` static chars), Merkle Schema DAG (`$defs._fN`) on Anthropic & OpenAI wires (bypassed on Google), single-level JSON-in-JSON unwrapping across `8` wrapper keys with `@fiche-kv` fallback, opt-in `cleanUserPayloads` (`false` default, protecting Turn-1 prompts `>= 4,000` chars), and pure leaf `PrefixMemoTape` (`src/core/prefix-tape.ts`: Stage-2 LRU `1024` / `12 MiB`, session-scoped Unified Prefix Seal Table `512` × `512`, and Merkle prefix-state CASI memo `1024` / `8 MiB` with chronological `deferredBases` flush on misses).
  - **P1 `CASI v2`/`v3` & `calibration.ts`**: Line-number gutter stripping, `Write`/`Edit` `seedBase`, bounded `PREPARED_LINES_CACHE` (`192` LRU entries, `>= 256` chars), recursive Histogram Diff (`histogramAnchors`, `HISTOGRAM_MAX_DEPTH = 16`, `HISTOGRAM_MAX_OCCURRENCES = 64`), LIS shifted-line alignment, `GEAR_TABLE` FastCDC (`8–48` lines), and 4-axis optical auto-calibration CLI (`fiche calibrate <model>`, `HEX >= 0.85`, `CODE >= 0.90`, `NUM >= 0.95`, `GUARD = 1.0`, `<= 512px` cliff height & `tile` width clamps, atomic `0600` `~/.config/fiche/calibrated-models.json`).
  - **P2 `LSM-Context` Prefix-Cache Stability & Horizon Gate**: Strictly 1-block `[item]` sticky epochs (`tail = 2` `L1`, `tail = 6` `L0`) keyed by `(sessionKey, fnv64Hex)`, Horizon-Aware Online Compaction Gate (`computeHorizonPaybackLimit` separating append/rolling `cutoffMsg` frontiers from mid-prefix epochs), FIFO eviction, `2,048`-entry BPE memoization, and cold-cache `L2` repack (`everCacheAlive && !lastCacheAlive`, `justRepacked` cooldown) across all `5` provider cache-read headers.
  - **P3 `Context-MMU`, Context-TLB & Minoux Submodular Pruning**: Deterministic UTF-8 `pg_<12hex>` virtual pages (`512`-page / `16 MiB` session-isolated LRU), Turn-1 `>= 10`-skill catalog linking (`linkSessionSkills`) with `session-state.ts` pin persistence & auto-hydration, `FAIL→PASS` Markovian episode folding anchored at first failure preserving pre-failure reads, Minoux Lazy Greedy Submodular Coverage IDF pruning (`pruneLowDensityBlob` over `POW_HALF`), and per-session Context-TLB (`TLB_DEFAULT_COOLDOWN_TURNS = 3`) + active-turn-only intent window `±15`-line live-tail hydration (`computeTailHydration`, `MAX_DEREF_CHARS = 65_536`).
- **Hybrid Slab-Optical + Text-MMU Mode (`OpticalMode`) & Google Optical KV-Cache Seal (`src/core/{transform,google,openai}.ts`)**:
  - Added `OpticalMode = 'auto' | 'hybrid' | 'full'` and `resolveOpticalHistoryPolicy()`, auto-selecting `'hybrid'` when `priceMode() === 'kosha' && rates.read <= 0.10 && estPromptTokens < 160_000`: renders Turn-1 static system instructions/tools into an optical PNG slab once while compiling multi-turn tool/observation history via Text + `Context-MMU` (`46.9%` raw / **`39.5%` weighted** saved / **`89.9%` cache hit** across `60` PNGs on `gemini-4-argon` `30`-turn replay vs. `44.0%` raw / `36.8%` weighted on 0-image Text+MMU and `49.0%` raw / `3.0%` weighted across `153` PNGs on Full Optical). Detached mutable `pinnedUserText` onto the trailing live turn in `planGoogleHistory`, disabled `CASI` pointers in Full Optical (`!opticalEnabled`), and exempted live-tail file reads (`read_file` / `view_file`) from optical imaging until sealed into history (`editSafe = true`, `tailRecallVerified = true`).
- **Security, RAM-Only MMU Default, Zero-Drop Operations & Staged Release Hardening**:
  - Kept Context-MMU strictly in daemon memory by default with opt-in `FICHE_MMU_PERSIST=1` (`O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, `0600`, `32 MiB` `load()` cap, `24h` idle TTL, and high-confidence secret filtering), added `fiche mmu [stats|pages|page <id>]` CLI and `page_in`/`mmu_stats` MCP tools with loopback daemon HTTP fallback, enforced same-origin `Origin` checks and `no-store` headers across `/api/mmu/*` dashboard routes, and switched `.github/workflows/release.yml` to `npm stage publish --provenance --access public`.
  - **Zero-Drop Atomic Build & Graceful SSE Drain (`scripts/build.mjs`, `src/node.ts`, `src/dashboard.ts`)**: Switched builds to `.dist-staging` + staged version smoke check + atomic `rename()` swap into `dist/`, added `active_requests` on `/api/health`, raised active-stream shutdown drain to `60s` (`FICHE_SHUTDOWN_DRAIN_MS`) while keeping idle shutdowns at `1.5s`, and set `ExitTimeOut: 65` in `fiche service install`.
  - **Upstream Parity & Edge-Case Hardening**: Added rejected `anthropic-beta` retry + failure reason tracking on `countTokensUpstream`, excluded server-side thread continuations (`isThreadContinuation`) from savings rollups, raised loopback buffered cap to `64 MiB` with backpressured streaming passthrough (`oversizedBodyPolicy: 'passthrough'`), enabled Claude Code pure tool-loop history collapse (`separateAdjacentToolPairs` / `FICHE_TRUST_ADJACENT_TOOL_ROUNDS`), isolated sessions via `x-claude-code-session-id` + slash-command boilerplate stripping (`isBoilerplateText`), preserved JSON Schema `dependent*` property containers, rejected flag-shaped `--out`/`--model` args in `fiche export`, exempted live-tail file reads on Google `compressGoogleToolResults` + emitted `systemSha8`, and fixed `src/stats.ts` inclusive `cached_tokens` subtraction.
  - **Node HTTP/1.1 Keep-Alive Fetch, Client-Abort Propagation & Warp Fail-Open (`src/node-fetch.ts`, `src/core/proxy.ts`, `src/node.ts`, `src/warp/`)**: Replaced Node `globalThis.fetch` upstream transport with dedicated HTTP/1.1 `node:http`/`node:https` keep-alive agents in `src/node-fetch.ts` (avoiding Node 26 / undici `8.12.4` HTTP/2 idle-reaper `ClientHttp2Stream` crashes, `sriinnu/fiche#33` / `nodejs/undici#6143`), propagated client disconnect `AbortSignal` into upstream fetches & `count_tokens` probes, cancelled unread/timed-out/tee'd response bodies on every error path, and updated `fiche warp` to bypass wrapping cleanly when the daemon is stopped (`isLocalDaemonReachable`) or fail open directly on mid-session `ECONNREFUSED` (`failOpenOnDivertRefused`).
  - **Zero-Drop Socket Activation & Warp Loopback `NO_PROXY` (`src/launchd-socket.ts`, `src/node.ts`, `src/warp/index.ts`)**: Eliminated daemon restart/respawn `ECONNREFUSED` connection drops (`sriinnu/fiche#34`) via macOS `launchd` `<key>Sockets</key>` (`Listeners`) paired with a lightweight `<launch.h>` exec trampoline (`fiche-launchd-exec`) and standard `LISTEN_FDS`/`LISTEN_PID` fd inheritance (`resolveInheritedListenFd`, also compatible with Linux `systemd`), moved listener binding ahead of session/MMU/replay startup restoration (`readyPromise`-gated handler), separated established idle keep-alive sockets from freshly accepted sockets on shutdown (`closeIdleSockets`), and merged loopback hosts (`localhost,127.0.0.1,::1`) into wrapped `NO_PROXY`/`no_proxy` environments in `fiche warp`.
  - **Multi-Provider Swarm Hardening & Kosha Sync (`src/kosha-sync.ts`, `src/core/{proxy,transform,google,openai,reader-tier,context-mmu,session-state}.ts`, `apps/macos-bar/`)**: Added `fiche models sync-kosha` (dry-run by default; `--apply`, `--all-providers`, `--providers`, `--file`, `--replace`) plus 1-click **Kosha Registry Sync** (`Sync`, `Update & Sync`, and `All 21 providers` toggle) directly in `FicheBar`'s **Models** tab to sync normalized chat model bases from `~/.kosha/registry.json` or `kosha registry export` with `TEXT_ONLY` safety guards for open-weight/third-party families (`qwen`, `llama`, `mistral`, `codestral`, `command-`, `gemma`, `gpt-oss`, etc.); extended provider-neutral session isolation (`x-fiche-session-id` / `x-inkling-session-id` stripped before upstream forwarding) across all 4 wire adapters (`anthropic`, `openai_chat`, `openai_responses`, `google`) and `inFlight` `409` dedupe keys; and added configurable RAM bounds (`mmu_max_pages`, `mmu_max_mb`, `max_sessions` in `~/.config/fiche/config.json` / `FICHE_MMU_MAX_PAGES`, `FICHE_MMU_MAX_MB`, `FICHE_MAX_SESSIONS`). (AWS Bedrock SigV4, GCP Vertex AI regional IAM/ADC, and internal plain-HTTP LiteLLM gateways remain out of scope / not covered in `v0.19.0`.)

## 0.18.0

- **Restart-proof analytics & Tokmeter-style local metrics**: `DashboardState.replay()` restores lifetime, 90-day local-date (`YYYY-MM-DD`), per-model, and active-session accumulators across daemon restarts from `~/.fiche/events.jsonl` and `.1` using a bounded 50-row tail ring buffer, finite numeric validation, and `/fragments/analytics` with interactive 14-day `Tokens`/`USD` bar charts and proportional per-model breakdowns.
- **Native `FicheBar.app` v0.18.0 (`Agents` tab + live attachment status)**:
  - `Lifetime` / `Today` hero switcher with weighted + raw subtitles, 14-day `DailySavingsChartView` (`Tokens`/`USD` toggle + hover readout), and proportional `By Model` bars.
  - Universal `Agents` tab discovering installed Desktop Apps (`Antigravity`, `Antigravity IDE`, `Cursor`, `Claude`, `Windsurf`, `Zed`, `OpenCode`, `ChatGPT (Codex)`, `Codex`, `Runic`) and Coding CLIs (`claude`, `codex`, `agy`, `gemini`, `opencode`, `cursor-agent`, `amp`, `pi`, `aider`) with live process-tree attachment indicators (`Attached`, `Running direct`, `Stopped`, `N attached` / `N direct`), safe shell RC auto-wrap installer (`~/.zshrc`, `$ZDOTDIR`, `~/.bashrc`), and built-in FAQ.
- **Core, Warp, Bridge & FileTracker hardening (Carbon Audit Wave 2)**:
  - Fixed `collapseHistory` adaptive post-render image budget enforcement + bounded density re-budget, `userTurnBlocks` profile render options, `FACTSHEET_PAGE_CHARS` export & repeat tally, OpenAI/Google pin relocation guards, `isFileReadToolName` compound namespaces, `CODE_DECL_LINE_RE` ReDoS guard, and `FileTracker` active-rewrite buffering with atomic cleanup.
  - Hardened `fiche warp` CA/TLS (RFC 5280 SKI/AKI/SPKI, SNI validation, per-CONNECT 30s handshake timeout, strict route path normalization, ChatGPT/Codex `app.asar` + Electron proxy flags, and `FICHE_BYPASS=1` shell-wrapper flow) and Responses/Chat bridge `reasoning`/`stop_reason`/fragmented SSE sniffing.

## 0.17.0

- Rebranded from `@sriinnu/inkling` to **`@sriinnu/fiche`** (`fiche` and
  `fiche-mcp` commands, `FICHE_*` environment variables, `x-fiche-*` headers,
  `~/.fiche` and `~/.config/fiche/config.json` state paths, `@fiche pin`), with
  full backwards-compatible runtime fallbacks for legacy `INKLING_*`,
  `x-inkling-*`, `~/.inkling`, `~/.config/inkling/config.json`, `@inkling pin`,
  and `@deprecated` `Inkling*` TypeScript SDK aliases.
- 4-layer deterministic text compiler (`src/core/text-hygiene.ts`,
  `schema-compiler.ts`, `toon.ts`, `text-history.ts`, `casi-delta.ts`) for
  text-tier models and textual blocks:
  `TSCG` schema/static compiler → terminal ANSI/CR/backspace hygiene + bijective
  `@toon` columnar encoding + `Drain` log folding (guarded by
  `isCodeOrDiffProtected` so source reads & diffs stay byte-exact) → `ACDC`
  frozen-epoch digestion → `CASI-Delta` cross-turn line hashing.
- Optical microfiche rendering (`Spleen 5×8` + `GNU Unifont` fallback, plus
  `JetBrains Mono` 10/12/14px profiles) only for strong/verified vision readers
  (`claude-fable-5`, measured `gemini` vision tiers, opt-in `gpt-5.6-sol` /
  `gpt-6.x-sol` / `grok-*` / `qwen3.8-27b`). Text-only readers (`claude-opus-5-5`,
  `claude-sonnet-5-5`, `claude-haiku-*`, `gpt-6*-astra`,
  `gemini-4-neon/carbon/hydrogen`, `deepseek`, `kimi`, `glm`, `minimax`, `grok`)
  pass through with zero images unless `FICHE_FORCE_IMAGES=1`. Default scope is
  `claude-fable-5,gemini`.
- Zero-token local receipts & companion plugin: `fiche turn-report`, `fiche stats`,
  downstream `x-fiche-saved-tokens` / `x-fiche-stages` /
  `x-fiche-cliff-saved-usd` headers, `plugins/fiche-companion/` (Antigravity
  `PostInvocation` hook + Claude Code `statusLine`), and interactive browser
  playground & subsite ([fiche.srinivas.dev](https://fiche.srinivas.dev)).
- Offline proxy-free export (`fiche export` for files/dirs, `--git`, `--diff`,
  `--stdin`) emitting `page-*.png`, `factsheet.txt`, `prompt.txt`, and
  `manifest.json`.
- PAKT is gone. On real agent traffic it saved about 0.015% of tokens and
  cost CPU time on every request. The old PAKT toggle, the `compress_text` and
  `inspect_savings` MCP tools, and the `@sriinnu/pakt` dependency are removed.
- ChatGPT Codex (`chatgpt.com`, `/backend-api/codex/responses` and
  `/responses/compact`) no longer receives `prompt_cache_breakpoint`.
  `api.openai.com` still does when the profile asks. `FICHE_GPT_PROFILES`
  `cacheBreakpoints: false` is honoured. The scrub is a text edit of the
  injected object only, so large integers and a tool-schema property named
  `prompt_cache_breakpoint` survive.
- Fail open: when a transform throws, the request is forwarded as it
  arrived instead of failing with 502. The event row's reason reads
  `transform_error_fail_open: …`. Wire-bridge errors still answer 400/502,
  because the upstream cannot read an unbridged body.
- The proxy API refuses browser requests from non-loopback pages (403) and
  public-DNS `Host` names other than known provider hosts (421), so a web
  page cannot spend configured keys through cross-site requests or DNS
  rebinding. `FICHE_ALLOWED_HOSTS` adds names; `*` turns the check off.
- Routing is default-deny. Every `/backend-api/` path goes to the ChatGPT
  upstream. Google `countTokens` and listing paths go to Google. On the stock
  Anthropic upstream, paths outside `/v1/*` and `/api/*` answer 404.
- Architecture write-up, diagrams, and technical handbook in
  `docs/ARCHITECTURE.md` and `wiki/`.
- MCP server (`fiche mcp`, also `fiche-mcp`) over stdio and stateless
  Streamable HTTP. Tools: `check_model`, `transform_request`, `health`,
  `stats`. Stdio `Content-Length` frames are counted in UTF-8 bytes, buffers are
  capped at 8 MiB, and HTTP also listens on `::1`. Installs from git with
  `npx --yes --package github:sriinnu/fiche fiche-mcp`; `prepare` builds
  `dist/`. Claude Code plugin and marketplace manifests in `.claude-plugin/`.
- Text-only reader matching covers `claude-opus-5.5`, Vertex
  `claude-opus-5-5@…`, `x-ai.grok-…`, `gpt-6*-astra`, `deepseek`, `kimi`,
  `glm`, and `minimax` spellings.
- Follow the agent: a request for a registered compat host (DeepSeek, Kimi,
  z.ai, MiniMax, DashScope, OpenRouter, xAI, plus `FICHE_UPSTREAM_HOSTS`)
  goes to that host with only the agent's own credential. `https` on 443 only,
  no IPs or local names, redirects handled manually. An unfollowed compat
  `Host` gets 421 and is never re-routed to Anthropic. `FICHE_FOLLOW_HOSTS=0`
  turns it off.
- Codex: only leading system/developer items enter the GPT static slab, user
  messages stay native, and history runs seal at a user message, so late
  images never land high in the cached prefix. WebSocket upgrades get 426 so
  Codex falls back to HTTP. gzip/deflate/br/zstd request bodies are decoded
  with a size limit; a body `fiche` can't decode is never rewritten.
- Savings accounting: the text baseline's warmth window follows the cache
  tier the session writes (3600 s after a 1h-tier write, else 300 s). The gate
  and the savings math price from one resolver.
- `FICHE_PRICES=kosha` (opt-in) prices from a build-time table of
  first-party rows in a kosha registry snapshot (`pnpm prices:gen`,
  `pnpm prices:check`). Unpriced models pass through, and dashboard dollars
  use each model's own input price, with unpriced rows counted apart.
- Logo, README header, and bundled font license notices (`assets/*_LICENSE.txt`
  and Docker `/app/licenses/`).
- Native macOS **`FicheBar.app`** (`apps/macos-bar/`): Apple HIG redesign with 5
  themes (`Editorial`, `Native`, `Slate`, `Terminal`, `Midnight`),
  `HeroCompressionRatioBar`, weighted-vs-raw savings clarity, 1-click
  third-party model & plugin toggles, Desktop App Proxy launcher, taller
  popover (`540px` scroll budget), and About & Sponsor window.
- Redesigned loopback web dashboard (`http://127.0.0.1:47821`) with Editorial
  Warm Paper typography, `/fragments/plugins` live panel, and
  `POST /api/plugins { scope: "third-party" }` one-click disable.
- Universal provider & client coverage: 23-host `COMPAT` upstream registry
  (`src/core/upstream-hosts.ts`), Google `/v1internal:*` text hygiene on
  non-Gemini models, `functionResponse.parts[].text` hygiene, macOS GUI desktop
  app interception (`fiche warp --app <Name|Path>`), and shell integration
  (`fiche shell-init [--wrap]`).
- Added [PRIVACY.md](./PRIVACY.md), GitHub Sponsor links, and Mermaid
  architecture/sequence diagrams in [wiki/Architecture.md](./wiki/Architecture.md).
