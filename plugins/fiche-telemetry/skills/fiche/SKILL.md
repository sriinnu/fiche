---
name: fiche
description: Inspect live token & dollar savings from the fiche context compiler, check model routing tiers (optical microfiche vs 4-layer deterministic text), simulate payload compression, wrap coding agents via fiche warp, or create proxy-free optical exports.
---

# Fiche Context Compiler Skill

Use this skill when the user wants to inspect **live token/dollar savings**, check **model routing tiers**, test **`fiche` transforms**, wrap coding agents through **`fiche warp`**, or export repositories/diffs via **`fiche export`**.

## Zero-Token Live Telemetry & Stats

The plugin's `PostInvocation` hook (`hooks.json` -> `scripts/post-invocation.mjs`) and `scripts/claude-statusline.mjs` read `$FICHE_LOG` (`~/.fiche/events.jsonl`) in `<5 ms` and report per-turn/session savings with `systemMessage: ""` (zero extra LLM tokens). Prefer `fiche-mcp` tools or fast CLI commands before reading raw logs:

- **MCP tools** (server `fiche-mcp`):
  - `stats` — live `lastTurn`, cumulative `session` token/USD savings from `$FICHE_LOG`, plus MCP call counts.
  - `check_model` — checks whether a model id is in `FICHE_MODELS` scope, its `readerTier` (`image` vs `text`), and active engine pipeline.
  - `transform_request` — previews how `fiche` compiles a payload on `anthropic`, `responses`, `chat`, or `google` wire formats.
  - `health` — server version and Codex `prompt_cache_breakpoint` stripping status.
- **Fast CLI telemetry (`<5 ms`)**:
  ```bash
  fiche turn-report --color
  fiche stats
  curl -s http://127.0.0.1:47821/api/last-turn.json
  ```

## Wrapping Agents & Proxy Routing

Start the local proxy with multi-provider scope + `kosha` cliff/cache pricing:

```bash
FICHE_PRICES=kosha \
FICHE_MODELS="claude-fable-5,gemini,gpt-6-astra,gpt-6.2-astra,gpt-6.1-sol,gpt-5.6-sol,deepseek,kimi,glm,grok" \
fiche
```

Launch coding agents seamlessly through `fiche warp` (preserving native TLS checks):

```bash
fiche warp -- claude
fiche warp -- codex
```

Dashboard runs at `http://127.0.0.1:47821/` (loopback-only).

## Proxy-Free Optical Export

For Cursor, web chats, or offline sharing without running the proxy:

```bash
fiche export --git              # uncommitted git diff + untracked files
fiche export src/               # files or directories
cat build.log | fiche export --stdin
```

Each export writes `page-*.png`, `factsheet.txt`, `prompt.txt`, and `manifest.json`.

## Live Instruction Pins

Place `@fiche pin <rule>` inside chat or instruction files (`AGENTS.md`, `CLAUDE.md`) to relocate volatile rules to the live turn tail without mutating the cached KV prefix (`@fiche unpin <n>` / `@fiche unpin all` to remove).
