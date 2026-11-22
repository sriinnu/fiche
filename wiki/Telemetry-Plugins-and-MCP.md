# Zero-Token Telemetry, Plugins & MCP

Every proxied request appends a JSONL `TrackEvent` row to `~/.fiche/events.jsonl` (`$FICHE_LOG`, falling back cleanly to `~/.inkling/events.jsonl` if present) and emits live HTTP headers.

## 1. Per-Turn Savings Without Extra LLM Calls

Never waste an LLM tool call just to ask how much you saved:
- **CLI**: `fiche turn-report --color` (formats: `cli`, `agy`, `claude-statusline`, `json`)
- **HTTP JSON**: `GET http://127.0.0.1:47821/api/last-turn.json`
- **Antigravity Plugin** ([plugins/fiche-telemetry/](../plugins/fiche-telemetry/README.md)): Runs `PostInvocation` via `post-invocation.mjs`, reading `~/.fiche/events.jsonl` in `<5 ms` and emitting `metadata.user_markdown` with `systemMessage: ""` (zero model tokens billed). Uses cursor deduplication (`PLUGIN_DATA/cursor-<conversationId>.json`) so repeat hooks never spam.
- **Claude Code Status Bar**: Configure `statusLine` in `~/.claude/settings.json` to run `plugins/fiche-telemetry/scripts/claude-statusline.mjs`.

## 2. Downstream Response Headers

Proxied responses carry direct compression metadata:
- `x-fiche-saved-tokens`: Combined optical + text-hygiene token savings on the turn.
- `x-fiche-stages`: Applied compression stages (e.g., `tscg,toon,casi_delta,acdc_epoch` or `image,casi_dup`).
- `x-fiche-cliff-saved-usd`: Dollars saved by avoiding a long-context price cliff.

## 3. MCP Server (`fiche-mcp`)

Run `fiche mcp` (stdio) or `fiche mcp --http 47823` (Streamable HTTP) to expose 4 read-only / inspection tools:
- `check_model`: Reports `inScope`, `readerTier` (`image` vs `text`), and active `textEngine` (`image+CASI+hygiene` vs `TSCG+TOON+CASI+ACDC`).
- `transform_request`: Inspects how `fiche` transforms a passed request JSON across `anthropic`, `responses`, `chat`, or `google` wires.
- `health`: Returns `fiche-mcp` version and Codex breakpoint stripping policy.
- `stats`: Returns in-memory call counters plus live `proxy.lastTurn` and `proxy.session` rollups read from `$FICHE_LOG`.
