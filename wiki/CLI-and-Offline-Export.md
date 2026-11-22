# CLI & Offline Export Reference

Complete reference for `fiche` CLI subcommands, runtime environment variables, offline microfiche exports, live pins, and build scripts.

---

## Core Commands

| Command | Description |
| :--- | :--- |
| `fiche` | Starts the loopback HTTP proxy (`127.0.0.1:47821`) and live web dashboard |
| `fiche warp -- <cmd>` | Launches an agent subprocess (`claude`, `codex`, etc.) with proxy routing and TLS preservation |
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
| `FICHE_CONFIG` | `~/.config/fiche/config.json` | Optional JSON override (`{"models": [...]}`) |
| `FICHE_SESSION_STATE` | `~/.fiche/session-state.json` | Persistent append-only freeze floors (`0` / `off` disables) |
| `FICHE_ALLOWED_HOSTS` | loopback + registered hosts | Comma-separated extra Host/Origin allowlist (`*` disables checks) |
| `FICHE_FOLLOW_HOSTS` | `1` | Set `0` to disable `/to/<host>/` third-party host forwarding |
| `FICHE_RENDER_CACHE_BYTES` | `64 MiB` (`8 MiB` Worker) | LRU cache byte budget for rendered pages (`0` disables) |

---

## Maintainer Scripts

```bash
pnpm run typecheck     # Strict TypeScript check
pnpm run build         # Compile dist/ library, node proxy, and CLI
pnpm run charts:gen    # Regenerate example render, 16-model benchmark, latency & context charts
pnpm test              # Full Vitest suite
```
