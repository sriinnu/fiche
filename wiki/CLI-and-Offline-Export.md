# CLI & Offline Export Reference

Complete reference for `fiche` CLI subcommands, runtime environment variables, offline microfiche exports, live pins, and build scripts.

---

## Core Commands

| Command | Description |
| :--- | :--- |
| `fiche` | Starts the loopback HTTP proxy (`127.0.0.1:47821`) and live web dashboard (adopts `LISTEN_FDS` socket activation if present and binds before startup restore) |
| `fiche service <install\|uninstall\|start\|stop\|restart\|status>` | Manages the macOS `launchd` LaunchAgent (`com.sriinnu.fiche`) with `<key>Sockets</key>` `<launch.h>` zero-drop socket activation, `ThrottleInterval: 1`, `ExitTimeOut: 65`; use `restart` for atomic `kickstart -k` restarts |
| `fiche providers <list\|detect --apply\|enable\|disable\|add-host>` | Manages enabled third-party COMPAT providers (`deepseek`, `kimi`, `glm`, `openrouter`, `xai`, etc.) and custom HTTPS upstream hosts in `~/.config/fiche/config.json` + running daemon |
| `fiche models <list\|set\|enable\|disable\|sync-kosha>` | Inspects or updates allowed model bases in `config.json` + daemon (`sync-kosha [--apply] [--all-providers] [--providers <csv>] [--file <path>] [--replace]` reads `~/.kosha/registry.json`) |
| `fiche warp [--all-providers] -- <cmd>` | Launches an agent or multi-provider orchestrator behind an ephemeral loopback proxy (`NO_PROXY` merged with `localhost,127.0.0.1,::1` so local LLMs bypass automatically; daemon-down bypass; mid-session `ECONNREFUSED` fail-open) |
| `fiche warp --app <Name\|Path>` | Launches macOS GUI apps (Electron / native bundles) through the local HTTPS `CONNECT` interceptor |
| `fiche shell-init [--wrap]` | Prints zsh/bash helper functions (`fclaude`, `fcodex`, `fagy`, `fiche-app`) or transparent wrappers (`FICHE_BYPASS=1` supported) |
| `fiche calibrate <model>` | Runs 4-axis optical probe (`HEX`/`CODE`/`NUM`/`GUARD`, `--dry-run`, `--list`, `--clear`) and saves to `~/.config/fiche/calibrated-models.json` |
| `fiche mmu [stats\|pages\|page <id>]` | Inspects `Context-MMU` virtual pages, Markovian folds, skill stubs & tail hydrations (reads running daemon or local store) |
| `fiche export [targets...]` | Compiles files, directories, git diffs, or stdin into offline optical microfiche PNG bundles |
| `fiche turn-report` | Ultra-fast (`<5 ms`) reverse tail summary of the last turn + cumulative session savings |
| `fiche stats` | Full-history savings aggregate read from `$FICHE_LOG` (`~/.fiche/events.jsonl`) |
| `fiche mcp` | Starts `fiche-mcp` on stdio (add `--http 47823` for Streamable HTTP) |

---

## Offline Export (`fiche export`)

Turn large repositories, diffs, or logs into compact vision bundles for **Cursor**, web chat, or review workflows without running a proxy:

```bash
fiche export src/                      # Target directory or files
fiche export --git                     # Staged, unstaged diff + untracked files
fiche export --diff HEAD~3             # Commit range diff
cat server.log | fiche export --stdin  # Pipe raw logs or transcripts
```

Every invocation writes an isolated folder (`fiche-export-XXXXXX/`) containing:
- `page-*.png` — reflowed 312-col (`Spleen 5×8` + `Unifont` fallback) optical microfiche PNG pages sized for vision models (`Average`-filtered)
- `factsheet.txt` — deterministic verbatim anchors (file paths, SHAs, URLs, ports, symbols, currencies)
- `prompt.txt` — paste-ready model prompt referencing the images and factsheet
- `manifest.json` — exact char, vision-token, and byte counts

---

## Zero-Token Reporting (`turn-report` & `stats`)

```bash
fiche turn-report --color               # Pretty terminal summary for latest turn + session
fiche turn-report --format=json         # Machine-readable JSON snapshot
fiche turn-report --format=agy          # Antigravity PostInvocation payload
fiche turn-report --format=claude-statusline  # Single-line Claude Code status bar
fiche stats                             # Historical rollup across all sessions
```

---

## Live Conversation Pins (`@fiche pin`)

Pin critical rules inside chat or `CLAUDE.md` / `AGENTS.md`:

- `@fiche pin <rule>` — removes pinned rules from early turns and re-emits them at the live tail so prefix KV caches stay untouched while instructions stay in the model's immediate recency window.
- `@fiche unpin <n>` / `@fiche unpin all` — removes one or all pinned rules.
- Legacy `@inkling pin` / `@inkling unpin` commands remain accepted automatically.

---

## Environment Variables

Every `FICHE_*` variable falls back cleanly to legacy `INKLING_*` equivalents:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `FICHE_MODELS` | `claude-fable-5,gemini` | Comma-separated active model families or `off` |
| `FICHE_PRICES` | `legacy` | Set `kosha` for accurate multi-tier cache + long-context cliff math |
| `FICHE_TEXT_HYGIENE` | `auto` | `auto` / `on` / `off` for the 4-layer deterministic text engine |
| `FICHE_FORCE_IMAGES` | unset | Set `1` to enable optical PNG rendering on unmeasured/text-tier models |
| `FICHE_LOG` | `~/.fiche/events.jsonl` | Path to JSONL event log (falls back to `~/.inkling/events.jsonl`) |
| `FICHE_CONFIG` | `~/.config/fiche/config.json` | Optional JSON defaults (`providers`, `models`, `custom_hosts`, `mmu_max_pages`, `mmu_max_mb`, `max_sessions`) |
| `FICHE_MAX_SESSIONS` | `512` | Max tracked sessions kept in RAM (`[64, 8192]`; overrides `config.json` `max_sessions`) |
| `FICHE_MMU_MAX_PAGES` | `512` | Max `Context-MMU` virtual pages in RAM (`[64, 16384]`; overrides `config.json` `mmu_max_pages`) |
| `FICHE_MMU_MAX_MB` | `16` | Max `Context-MMU` RAM budget in MiB (`[4, 256]`; overrides `config.json` `mmu_max_mb`) |
| `FICHE_SESSION_STATE` | `~/.fiche/session-state.json` | Persistent append-only freeze floors & Turn-1 skill pins (`0` / `off` disables) |
| `FICHE_MMU_PERSIST` | unset (`off`, RAM-only) | Set `1` (with `FICHE_SESSION_STATE` enabled) to persist non-secret MMU pages (`0600`, `24h` TTL) |
| `FICHE_SHUTDOWN_DRAIN_MS` | `60000` | Max active request drain window on shutdown in ms (`ExitTimeOut: 65` in `launchd` plist) |
| `FICHE_TRUST_ADJACENT_TOOL_ROUNDS` | unset | Collapses adjacent pure tool-call rounds cleanly in append-only harnesses |
| `FICHE_SERVICE_LABEL` | `com.sriinnu.fiche` | Optional override for macOS `launchd` LaunchAgent label (`FICHE_PLIST_PATH` overrides plist path) |
| `FICHE_ALLOWED_HOSTS` | loopback + registered hosts | Comma-separated extra Host/Origin allowlist (`*` disables checks) |
| `FICHE_FOLLOW_HOSTS` | `1` | Set `0` to disable `/to/<host>/` third-party host forwarding |
| `FICHE_RENDER_CACHE_BYTES` | `64 MiB` (`8 MiB` Worker) | LRU cache byte budget for rendered pages (`0` disables) |

---

## Swarm Config File (`~/.config/fiche/config.json`) & Kosha Sync

Explicit environment variables (`FICHE_*`) always win over `~/.config/fiche/config.json`. Run `kosha update && fiche models sync-kosha` to preview active chat models from `~/.kosha/registry.json` (`$KOSHA_REGISTRY` or `kosha registry export` fallback), then add `--apply` (and optional `--all-providers`, `--providers <csv>`, `--file <path>`, `--replace`, `--json`):

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

---

## Maintainer Scripts

```bash
pnpm run typecheck     # Strict TypeScript check
pnpm run build         # Compile dist/ library, node proxy, and CLI
pnpm run charts:gen    # Regenerate example render, 16-model benchmark, latency & context charts
pnpm test              # Full Vitest suite
```
