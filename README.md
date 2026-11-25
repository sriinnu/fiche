<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/fiche-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/fiche-logo-light.svg">
  <img alt="fiche — Microfiche for coding agents" src="./assets/fiche-logo-light.svg" width="360">
</picture>

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-FF6B2B.svg"></a>
  <img alt="Platform: macOS | Linux | Windows | Docker | Workers" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20%7C%20Docker%20%7C%20Workers-1E293B.svg">
  <img alt="Node 20.19+" src="https://img.shields.io/badge/node-%3E%3D20.19-339933.svg?logo=node.js&logoColor=white">
  <img alt="Core: 0 deps" src="https://img.shields.io/badge/core-0%20node%3A%20deps-0EA5E9.svg">
  <img alt="Warm p50: 1.9-6.7 ms" src="https://img.shields.io/badge/warm%20p50-1.9%E2%80%936.7%20ms-34D399.svg">
  <img alt="MCP: fiche-mcp" src="https://img.shields.io/badge/MCP-fiche--mcp-A855F7.svg">
  <a href="./apps/macos-bar/README.md"><img alt="macOS: FicheBar" src="https://img.shields.io/badge/macOS-FicheBar-111827.svg?logo=apple"></a>
  <a href="https://github.com/sponsors/sriinnu"><img alt="Sponsor on GitHub" src="https://img.shields.io/badge/sponsor-sriinnu-EA4AAA.svg?logo=githubsponsors&logoColor=white"></a>
  <a href="https://fiche.srinivas.dev"><img alt="Website: fiche.srinivas.dev" src="https://img.shields.io/badge/web-fiche.srinivas.dev-0F172A.svg"></a>
</p>

**Microfiche for coding agents — cache-safe hybrid optical & deterministic text context compiler + local proxy.**

Cuts **31.4–50.8%** of multi-turn tokens and up to **41.7%** real USD (`34.1–41.7%` across text models; `11.1–27.0%` on Fable/Gemini optical) with **73.8–91.1%** KV prefix-cache hits, **1.85–6.69 ms** warm p50 request latency, and **100% `editSafe`** verbatim source preservation.

[30s Quickstart](#30-second-quickstart) · [Website](https://fiche.srinivas.dev) · [Efficiency vs Latency](#token-efficiency-vs-latency) · [FicheBar](#macos-menubar-app-fichebar--ecosystem) · [Architecture](./wiki/Architecture.md) · [Getting Started](./docs/GETTING_STARTED.md) · [Wiki](./wiki/Home.md) · [Support](#support)

</div>

---

## Proxy Daemon vs. MCP Server vs. Offline Export

| Component | How You Run It | What It Does | Shrinks Live Turns? |
| :--- | :--- | :--- | :--- |
| **`fiche` Proxy Daemon** | `fiche` / `fiche service install` / `fiche warp` | Loopback HTTP proxy (`127.0.0.1:47821`) with zero-drop `launchd`/`systemd` socket activation, HTTP/1.1 keep-alive upstream fetch, and `fiche warp` fail-open; compiles live agent context (`P0–P3` + `Context-MMU` & calibrated optical), emits `x-fiche-*` headers, logs `~/.fiche/events.jsonl` | **Yes** |
| **`fiche-mcp` MCP Server** | `fiche mcp` (stdio on demand) or `--http 47823` | Inspection, virtual-page recall & local stats (`check_model`, `transform_request`, `page_in`, `mmu_stats`, `health`, `stats`) | **No** (dry-run, recall & stats) |
| **`fiche export`** | `fiche export src/` / `--git` / `--stdin` | Proxy-free generator for `page-*.png` + `factsheet.txt` + `prompt.txt` bundles | Offline bundle |

> **Cross-Platform (Not OS-Dependent):**
> - **Runs everywhere**: `src/core/` (zero `node:` deps), the `fiche` loopback proxy daemon (`LISTEN_FDS`/`LISTEN_PID` `systemd` socket activation supported on Linux), `fiche warp -- <cli>`, `fiche-mcp`, `fiche export`, `fiche calibrate`, `fiche mmu`, `fiche turn-report`, `fiche stats`, and the Web Dashboard (`http://127.0.0.1:47821`) run identically on **macOS, Linux, Windows (native & WSL), Docker (`docker compose up -d`), and Cloudflare Workers**.
> - **Optional macOS extras only**: [`FicheBar.app`](./apps/macos-bar/README.md) (SwiftUI menubar companion — Linux/Windows use the web dashboard at `:47821`), `fiche service` (`launchd` wrapper with `<key>Sockets</key>` `<launch.h>` socket activation & `65s` graceful SSE drain — use `systemd --user` / Docker on Linux or Task Scheduler / WSL on Windows), and `fiche warp --app <Name>` (macOS `.app` bundle resolver — on Linux/Windows run `fiche warp -- <binary>` directly).

---

## 30-Second Quickstart

```bash
# 1. Install once (Node >= 20.19) directly from GitHub (builds automatically via prepare)
npm install -g github:sriinnu/fiche

# 2. Start daemon (or `fiche service install` on macOS for zero-drop launchd socket activation).
#    Zero-config applies default `FICHE_MODELS=claude-fable-5,gemini`;
#    recommended: enable kosha pricing + all coding models (or save in ~/.config/fiche/config.json):
FICHE_PRICES=kosha FICHE_TEXT_HYGIENE=on \
FICHE_MODELS="claude-fable-5,gemini,gpt-6-astra,gpt-6.2-astra,claude-opus-5-5,deepseek,kimi,glm,grok" \
fiche

# 3. Connect your coding agent CLI, desktop app, or multi-provider swarm via warp (preserves native auth & fails open if daemon stops)
fiche warp -- claude         # Claude Code (/remote-control & connectors stay intact)
fiche warp -- codex          # OpenAI Codex (or `codex -p fiche` via ~/.codex/config.toml)
fiche warp --app Cursor      # Route macOS desktop GUI apps through local HTTPS CONNECT MITM
eval "$(fiche shell-init)"   # Add fclaude / fcodex / fgemini / fiche-app helpers (or `--wrap`)

# Multi-provider orchestrators & swarms (ribhu / opencode / t3code):
# 1. Opt in on BOTH daemon & client (`fiche warp --all-providers` only injects wrapper env vars;
#    without daemon opt-in, third-party upstream hosts return HTTP 421 `follow_refused`):
fiche providers enable deepseek kimi glm openrouter xai groq mistral
# 2. Sync active models from local ~/.kosha/registry.json (after `kosha update`) into ~/.config/fiche/config.json
fiche models sync-kosha --apply
fiche warp --all-providers -- ribhu

# 4. Calibrate new vision models, inspect Context-MMU pages, or restart with zero drops
fiche calibrate <model>      # 4-axis optical probe saved to ~/.config/fiche/calibrated-models.json
fiche mmu stats              # inspect virtual pages, Markovian folds & tail hydrations (0 LLM tokens)
fiche service restart        # atomic kickstart -k restart with 0 ECONNREFUSED via socket activation

# 5. Verify savings (<1 ms CLI rollup from ~/.fiche/events.jsonl, 0 LLM tokens)
fiche turn-report --color
```

> **Provider Terms Note:** `fiche warp` runs locally on your own loopback interface using your own session credentials without sharing accounts or bypassing rate limits. Before wrapping a proprietary client such as Google Antigravity (`agy`), review that provider's current Terms of Service on local proxies/wrappers or configure direct base-URL routing (`GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:47821`) where supported.

Open `http://127.0.0.1:47821/` in your browser for the live dashboard & PNG crop inspector. Full multi-agent setup lives in the **[Getting Started Guide](./docs/GETTING_STARTED.md)**.

---

## macOS Menubar App (`FicheBar`) & Ecosystem

- **[`FicheBar.app`](./apps/macos-bar/README.md)** (`./apps/macos-bar/bundle.sh --install`): native SwiftUI macOS 14+ menubar companion with **5 Apple HIG themes** (`Editorial`, `Native`, `Slate`, `Terminal`, `Midnight`), weighted-vs-raw savings clarity, 1-click **Pause / Resume**, 1-click **Disable all 3rd-party models/plugins**, **Desktop App Proxy (`fiche warp --app`)** launcher, and About / GitHub Sponsor panel.
- **29 Built-In Upstream Hosts across 21 Providers (`src/core/upstream-hosts.ts`)**: "Follow-the-agent" TLS/base-URL routing across 6 first-party + 23 third-party COMPAT hosts (Anthropic, OpenAI / ChatGPT Codex, Google Gemini & `/v1internal:*` (`Antigravity`), DeepSeek, Moonshot/Kimi, Z.AI/BigModel, MiniMax, DashScope, OpenRouter, xAI, Groq, Together, Fireworks, Cerebras, Mistral, Perplexity, Cohere, SambaNova, GitHub Models, Azure AI, and Vercel AI Gateway). Multi-provider swarms (`fiche warp --all-providers -- ribhu`) route **per request** by `(Host, path, model)` with strict per-provider credential and `sessionKey` isolation, while local LLMs on `localhost` / `127.0.0.1` / `::1` (Ollama, vLLM, LM Studio) bypass proxying automatically via `NO_PROXY` so local models stay untouched.
- **[Ecosystem Integration](./docs/ECOSYSTEM_INTEGRATION.md)**: works cleanly alongside [kosha-discovery](https://github.com/sriinnu/kosha-discovery) (pricing & cliffs), [tokmeter](https://github.com/sriinnu/tokmeter) (gross ledger + net savings, sharing Claude's `statusLine`), [Runic](https://github.com/sriinnu/Runic) (`runic-mcp-plugin.json`), [llm-bar](https://github.com/sriinnu/llm-bar), [baton](https://github.com/sriinnu/baton) (cross-session briefs), and [omit](https://github.com/sriinnu/omit) (output minimalism).
- **[Stage Plugins & Skills](./docs/PLUGINS_AND_SKILLS.md)**: extend or toggle pipeline stages via `~/.fiche/plugins/<id>/plugin.json`, `~/.agents/skills/`, and `/api/plugins`.

---

## How It Works

1. **Edit-safety guard (`isCodeOrDiffProtected` & live-tail preservation)**: freezes numbered code reads (`read_file`/`view_file` verbatim in the live tail) and unified diffs verbatim so `Edit` and `apply_patch` anchors stay byte-exact.
2. **Tiered reader router (`readerTier`), `OpticalMode` (`hybrid` vs `full`), & 4-axis `fiche calibrate`**: verified dense page readers (`claude-fable-5`, measured `gemini`, opt-in `sol`, plus empirically calibrated models) route between **Hybrid Slab-Optical + Text-MMU** (`opticalMode: 'hybrid'` — auto-selected under low read-discount `kosha` pricing like `0.05×` Gemini 4 Argon: Turn-1 static optical slab + dynamic Text-MMU history, lifting 30-turn weighted savings to **`39.5%`** at **`89.9%`** cache hit across `60` images) and **Full Optical** (`pinnedUserText` moved to trailing live turn on Google wires so `contents[0]` stays immutable, `79.7%` cache hit); text-tier coding models receive **0 images**.
3. **P0–P3 context compiler + `Context-MMU` + `PrefixMemoTape`**:
   - **P0**: XML-island `TSCG` + Merkle Schema DAG (`$defs._fN` on Anthropic/OpenAI wires) + single-level JSON-in-JSON unwrapping + bounded **`PrefixMemoTape`** (`src/core/prefix-tape.ts`: Stage-2 LRU, session-scoped Unified Prefix Seal Table, and Merkle prefix-state CASI memo).
   - **P1**: `CASI v2` (`Write`/`Edit` `seedBase`, bounded `PREPARED_LINES_CACHE`, recursive Histogram Diff, LIS alignment, `GEAR_TABLE` FastCDC, disabled automatically when Full Optical is active).
   - **P2**: `LSM-Context` single-block sticky epochs (`L1`/`L0`) with Horizon-Aware Online Compaction Gate (`computeHorizonPaybackLimit`) + cold-cache `L2` repack across all `5` provider cache-read headers.
   - **P3**: `Context-MMU` virtual memory (`pg_<12hex>` RAM-only default LRU, Turn-1 skill linking, `FAIL→PASS` Markovian folding, Minoux Lazy Greedy Submodular IDF pruning, and per-session Context-TLB `±15`-line live-tail hydration).
4. **Zero-drop runtime & zero-token local receipts**: `src/node-fetch.ts` HTTP/1.1 keep-alive agents avoid Node 26 / `undici` HTTP/2 idle-reaper crashes (`#33`); `launchd`/`systemd` socket activation + bind-before-restore + `connTrack` `60s` SSE drain prevent restart `ECONNREFUSED`/`ECONNRESET` (`#34`); `fiche warp` bypasses when stopped, fails open mid-session on `ECONNREFUSED`, and sets loopback `NO_PROXY`; and `~/.fiche/events.jsonl`, `fiche turn-report`, `fiche mmu`, `x-fiche-*` headers, and `fiche-mcp` cost **0 LLM tokens**.

<details>
<summary><strong>Preview: 312-column optical microfiche PNG + architecture diagram</strong> (click to expand)</summary>

![Real fiche optical microfiche output packed into a 312-column monochrome PNG page with instruction banner and newline sentinels](docs/assets/example-render.png)

![fiche hybrid optical and deterministic text architecture](docs/architecture/fiche-architecture.svg)

</details>

---

## Token Efficiency vs. Latency

Measured across 16 models on the 16-turn coding-agent benchmark (`bench/multiturn-all-models.mts` + `bench/latency-p99.mts` → [`bench/results.generated.json`](./bench/results.generated.json); **`editSafe = true` on all 16 models**), alongside the hardened 30-turn `Context-MMU` replay ([`bench/context-mmu-eval.mts`](./bench/context-mmu-eval.mts) → [`bench/mmu-results.generated.json`](./bench/mmu-results.generated.json)):

| `v0.19` 30-Turn Replay Arm | Model / Wire | Raw Saved | Weighted Saved (`kosha`) | KV Cache Hit | p50 / Avg ms | EditSafe & Tail Recall |
| :--- | :--- | ---: | ---: | ---: | ---: | :---: |
| **`v0.18` Text Compiler** (`lsm/mmu/skillLinker` off) | `gemini-4-argon` (Google) | **32.5%** | **34.0%** | **92.1%** | **11.94 / 11.66 ms** | `true` / `true` |
| **`P0–P3` Text + `Context-MMU`** (`0` images) | `gemini-4-argon` (Google) | **44.0%** | **36.8%** | **90.1%** | **10.24 / 16.66 ms** | **`true` / `true`** |
| **`P0–P3` + Optical** (`spleen-5x8`, `153` PNGs) | `gemini-4-argon` (Google) | **49.0%** | **3.0%** | **79.7%** | **4.71 / 11.39 ms** | **`true` / `true`** |
| **`P0–P3` Hybrid Slab-Optical + Text-MMU** (`60` PNGs) | `gemini-4-argon` (Google) | **46.9%** | **39.5%** | **89.9%** | **9.62 / 15.53 ms** | **`true` / `true`** |
| **`P0–P3` Text + `Context-MMU`** (`13` stages) | `claude-opus-5-5` (Anthropic) | **48.8%** | **39.8%** | **89.6%** | **18.50 ms avg** | **`true` / `true`** |
| **`P0–P3` Text + `Context-MMU`** (`13` stages) | `gpt-6-astra` (Responses) | **44.6%** | **33.2%** | **88.3%** | **11.66 ms avg** | **`true` / `true`** |

| Engine Mode | Tokens Saved | Real USD Saved (`kosha`) | Prefix Cache Hit | Warm p50 Latency | Best For |
| :--- | ---: | ---: | ---: | ---: | :--- |
| **4-Layer Text Compiler** (`TSCG→Drain→TOON→ACDC→CASI`) | **45.3–45.7%** | **34.1–41.7%** (`grok-4.7` top) | **91.1%** | **6.29–6.66 ms** | Daily coding on Astra, Opus 5.5, Grok, DeepSeek, Kimi, GLM, Gemini text |
| **Optical Microfiche** (PNG + `FactSheet`) | **31.4–50.8%** (`gemini-3.8-flash` top) | **11.1–27.0%** (Fable/Gemini) · `-11.2–-3.5%` (opt-in Sol 16T) | **73.8–89.0%** | **1.99–3.53 ms** | Massive docs/logs & `3.6×–5.1×` context packing on Fable 5 / Gemini |

![Token and cost efficiency vs latency frontier across 16 models](docs/assets/efficiency-vs-latency.png)

![fiche 16-model token and USD savings benchmark](docs/assets/benchmark-16-models.png)

![fiche cold vs warm latency and adversarial guards](docs/assets/latency-profile.png)

<details>
<summary><strong>Full 16-model benchmark table, latency breakdown &amp; context capacity chart</strong> (click to expand)</summary>

| Provider | Model | Mode | Tokens Saved | Real USD Saved | Prefix Hit | Avg / Turn |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: |
| **xAI** | `grok-4.7` | `TSCG+TOON+ACDC+CASI` | **45.3%** | **41.7%** | 91.1% | 4.1 ms |
| **z.ai** | `glm-5.3` | `TSCG+TOON+ACDC+CASI` | **45.4%** | **41.1%** | 91.1% | 4.2 ms |
| **DeepSeek** | `deepseek-v4-pro` | `TSCG+TOON+ACDC+CASI` | **45.4%** | **39.1%** | 91.1% | 5.1 ms |
| **OpenAI / Codex** | `gpt-6-astra` | `TSCG+TOON+ACDC+CASI` | **45.3%** | **37.8%** | 91.1% | 7.4 ms |
| **OpenAI / Codex** | `gpt-6.2-astra` | `TSCG+TOON+ACDC+CASI` | **45.3%** | **36.6%** | 91.1% | 3.9 ms |
| **Anthropic** | `claude-opus-5-5` | `TSCG+TOON+ACDC+CASI` | **45.3%** | **36.6%** | 91.1% | 5.0 ms |
| **Moonshot** | `kimi-k3` | `TSCG+TOON+ACDC+CASI` | **45.4%** | **35.9%** | 91.1% | 5.0 ms |
| **Google / AGY** | `gemini-4-carbon` | `TSCG+TOON+ACDC+CASI` | **45.7%** | **34.4%** | 91.1% | 6.5 ms |
| **Google / AGY** | `gemini-4-hydrogen` | `TSCG+TOON+ACDC+CASI` | **45.7%** | **34.4%** | 91.1% | 5.3 ms |
| **Google / AGY** | `gemini-3.1-pro-preview` | `TSCG+TOON+ACDC+CASI` | **45.6%** | **34.1%** | 91.1% | 4.3 ms |
| **Anthropic** | `claude-fable-5-20260609` | `Fable-image+hygiene` | **37.2%** | **27.0%** | 88.8% | 8.9 ms |
| **Google / AGY** | `gemini-4-argon` | `image+hygiene` | **34.9%** | **22.2%** | 89.0% | 21.8 ms |
| **Google / AGY** | `gemini-3.8-flash` | `image+hygiene` | **50.8%** | **11.1%** | 73.8% | 14.9 ms |
| **OpenAI / Codex** | `gpt-5.6-sol` | `14px-Sol-image+hygiene` | **31.4%** | **-3.5%** | 79.2% | 13.6 ms |
| **OpenAI / Codex** | `gpt-6.2-sol` | `14px-Sol-image+hygiene` | **31.4%** | **-11.2%** | 79.2% | 14.6 ms |
| **Google / AGY** | `gemini-4-neon` | `TSCG+TOON+ACDC+CASI` | **45.7%** | unpriced | 91.1% | 5.5 ms |

| Latency / Guard Workload | Cold | Warm p50 | Warm p95 | Warm p99 |
| :--- | ---: | ---: | ---: | ---: |
| 20T Text: `gpt-6-astra` (Responses) | 13.77 ms | **6.29 ms** | 7.81 ms | 9.40 ms |
| 20T Text: `gemini-4-neon` (Google) | 11.16 ms | **6.66 ms** | 9.43 ms | 28.30 ms |
| 20T Imaged: `gemini-4-argon` (Google) | 48.02 ms | **1.99 ms** | 2.80 ms | 3.02 ms |
| 20T Imaged: `claude-fable-5` (Anthropic) | 53.68 ms | **3.13 ms** | 3.75 ms | 4.19 ms |
| 20T Imaged: `gpt-6.2-sol` (Responses) | 79.37 ms | **3.53 ms** | 5.52 ms | 6.49 ms |
| 600 KB ACDC epochs (`15×40 KB`) | 59.06 ms | **15.93 ms** | 19.19 ms | 20.97 ms |
| 50 KB dotted line (`cleanToolOutput`) | 1.52 ms | **1.26 ms** | 1.82 ms | 2.57 ms |
| 35 KB unclosed `<!--` (`compileStaticText`) | 0.25 ms | **0.27 ms** | 0.50 ms | 0.67 ms |
| 30 KB unbroken blob (clean + digest + static + toon) | 1.03 ms | **0.90 ms** | 1.55 ms | 2.45 ms |
| 1.90 MiB `events.jsonl` tail (`readTurnReport`) | 0.79 ms | **0.43 ms** | 1.16 ms | 1.77 ms |

![Characters a frontier context window holds with fiche: Gemini 3.8 Flash 21M (5.1x), Fable 5 18M (4.5x), Opus 5 spaced 14M (3.6x)](docs/assets/context-window-chars.png)

Reproduce via [`scripts/gen-fiche-charts.ts`](./scripts/gen-fiche-charts.ts) and [`scripts/gen-context-chart.ts`](./scripts/gen-context-chart.ts) (`pnpm run charts:gen`).

</details>

---

## Offline export (no proxy)

Need to feed a directory, git branch, or huge log directly into **Cursor**, web chat, or another client **without running the proxy**? Run `fiche export`:

```bash
fiche export src/                      # directory / file targets
fiche export --git                     # uncommitted git diff + untracked files
fiche export --diff HEAD~3             # commit range diff
cat server.log | fiche export --stdin  # pipe logs or transcripts via --stdin
```

Each invocation writes an isolated folder containing `page-*.png` (reflowed microfiche PNGs), `factsheet.txt` (verbatim paths, SHAs, ports, IDs), `prompt.txt` (paste-ready prompt referencing the pages and factsheet), and `manifest.json`.

---

## Zero-Token Local Stats, Live Pins & Config

- **Local Stats & Turn Receipts (`0` LLM tokens)**: `fiche turn-report --color`, `fiche stats`, `GET /api/last-turn.json`, `x-fiche-saved-tokens` / `x-fiche-stages` / `x-fiche-cliff-saved-usd` headers, `plugins/fiche-companion/` (Antigravity `PostInvocation` + Claude `statusLine`), and `fiche-mcp`.
- **Live Pins (`@fiche pin <rule>`)**: pinned rules stay authoritative at the live turn tail without invalidating prefix caches (`@fiche unpin <n|all>`).
- **Interactive Browser Playground & Subsite**: zero-backend optical plate viewer & benchmark explorer at **[fiche.srinivas.dev](https://fiche.srinivas.dev)**.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `FICHE_MODELS` | `claude-fable-5,gemini` | Comma-separated active model bases or `off` |
| `FICHE_PRICES` | `legacy` | Set `kosha` for calibrated cache & long-context cliff math |
| `FICHE_TEXT_HYGIENE` | `auto` | `on` / `auto` / `off` for the 4-layer deterministic text engine |
| `FICHE_CONFIG` | `~/.config/fiche/config.json` | Optional JSON defaults (`providers`, `models`, `custom_hosts`, `mmu_max_pages`, `mmu_max_mb`, `max_sessions`) |
| `FICHE_MMU_MAX_PAGES` | `512` | Max `Context-MMU` virtual pages in daemon RAM (`[64, 16384]`, or `mmu_max_pages` in `config.json`) |
| `FICHE_MMU_MAX_MB` | `16` | Max `Context-MMU` RAM budget in MiB (`[4, 256]`, or `mmu_max_mb` in `config.json`) |
| `FICHE_MAX_SESSIONS` | `512` | Max tracked sessions in RAM (`[64, 8192]`, or `max_sessions` in `config.json`) |
| `FICHE_MMU_PERSIST` | unset (`off`, RAM-only) | Set `1` (with `FICHE_SESSION_STATE` enabled) to persist non-secret MMU pages (`0600`, `24h` TTL) |
| `FICHE_SHUTDOWN_DRAIN_MS` | `60000` | Active request shutdown drain window in ms (`ExitTimeOut: 65` in `launchd` plist) |
| `FICHE_TRUST_ADJACENT_TOOL_ROUNDS` | unset | Collapses pure tool-call turns cleanly behind `CASI`/`Context-MMU` gates when client prompts are strictly append-only |
| `FICHE_SERVICE_LABEL` | `com.sriinnu.fiche` | Optional override for `launchd` LaunchAgent label |
| `FICHE_LOG` | `~/.fiche/events.jsonl` | Local JSONL event log path (falls back to `~/.inkling/events.jsonl`) |
| `FICHE_ALLOWED_HOSTS` | loopback + registered hosts | Extra trusted `Host`/`Origin` names (`*` disables checks) |

Example `~/.config/fiche/config.json` for a multi-provider swarm (or run `kosha update && fiche models sync-kosha --apply` to populate `models` automatically):

```json
{
  "providers": [
    "anthropic",
    "openai",
    "google",
    "deepseek",
    "kimi",
    "glm",
    "openrouter",
    "xai",
    "groq",
    "mistral"
  ],
  "models": [
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-5-5",
    "gemini",
    "gpt-6-astra",
    "gpt-6.2-astra",
    "gpt-6.1-sol",
    "gpt-6.2-sol",
    "gpt-5.6-sol",
    "deepseek",
    "kimi",
    "glm",
    "grok",
    "qwen",
    "mistral-large",
    "codestral"
  ],
  "custom_hosts": [],
  "mmu_max_pages": 4096,
  "mmu_max_mb": 64,
  "max_sessions": 2048
}
```

- **Swarm worker isolation**: Orchestrators (`ribhu`, `opencode`, `t3code`) spawning concurrent workers on identical Turn-1 prompts across Anthropic, OpenAI, or Google should send `x-fiche-session-id: <worker-id>` (stripped before forwarding upstream) so `Context-MMU`, `LSM-Context`, and in-flight `409` dedupe stay isolated per worker.
- **Scope note (`v0.19.0`)**: Enterprise endpoints outside the 29 built-in HTTPS:443 hosts — AWS Bedrock (SigV4 signing + regional hosts), GCP Vertex AI (regional IAM/ADC endpoints), and internal plain-HTTP / self-signed corporate LiteLLM gateways — are not natively covered yet.

**Deep dives:** [Getting Started](./docs/GETTING_STARTED.md) · [Context-MMU Architecture](./docs/CONTEXT_MMU_ARCHITECTURE.md) · [Architecture (Wiki)](./wiki/Architecture.md) · [Architecture (Detailed)](./docs/ARCHITECTURE.md) · [Benchmarks](./docs/BENCHMARKS.md) · [Ecosystem Integration](./docs/ECOSYSTEM_INTEGRATION.md) · [Plugins & Skills](./docs/PLUGINS_AND_SKILLS.md) · [Privacy Policy](./PRIVACY.md) · [Security Model](./docs/SECURITY_MODEL.md) · [Changelog](./CHANGELOG.md) · [Wiki](./wiki/Home.md)

---

## Credits

Evolved from `pxpipe` by [Steven / teamchong](https://github.com/teamchong/pxpipe) (MIT; see [NOTICE](./NOTICE)). Bundled font licenses live in `assets/*_LICENSE.txt` and Docker `/app/licenses/`:
- **JetBrains Mono** — SIL Open Font License 1.1 (`assets/JETBRAINS_MONO_LICENSE.txt`)
- **GNU Unifont** — SIL Open Font License 1.1 / GPLv2+ with GNU font embedding exception (`assets/UNIFONT_LICENSE.txt`)
- **Spleen** — BSD 2-Clause License (`assets/SPLEEN_LICENSE.txt`)

## Support

`fiche` is free and open source. If it cuts your token bills, consider supporting maintenance:

- [GitHub Sponsors](https://github.com/sponsors/sriinnu)
- [Buy Me a Coffee](https://buymeacoffee.com/sriinnu)

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for third-party attributions and [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.
