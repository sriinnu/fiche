# Zero-Token Local Stats, Plugins & MCP

Every proxied request appends a JSONL `TrackEvent` row to `~/.fiche/events.jsonl` (`$FICHE_LOG`, falling back cleanly to `~/.inkling/events.jsonl` if present) and emits live HTTP headers.

## 1. Per-Turn Savings Without Extra LLM Calls

Never waste an LLM tool call just to ask how much you saved:
- **CLI**: `fiche turn-report --color` (formats: `cli`, `agy`, `claude-statusline`, `json`)
- **HTTP JSON**: `GET http://127.0.0.1:47821/api/last-turn.json`
- **Antigravity Plugin** ([plugins/fiche-companion/](../plugins/fiche-companion/README.md)): Runs `PostInvocation` via `post-invocation.mjs`, reading `~/.fiche/events.jsonl` in `<5 ms` and emitting `metadata.user_markdown` with `systemMessage: ""` (zero model tokens billed). Uses cursor deduplication (`PLUGIN_DATA/cursor-<conversationId>.json`) so repeat hooks never spam.
- **Claude Code Status Bar**: Configure `statusLine` in `~/.claude/settings.json` to run `plugins/fiche-companion/scripts/claude-statusline.mjs`.

## 2. Downstream Response Headers & Daemon Health

Proxied responses carry direct compression metadata:
- `x-fiche-saved-tokens`: Combined optical + text-hygiene token savings on the turn.
- `x-fiche-stages`: Applied compression stages (e.g., `skill_linker,tscg,acdc_epoch,lsm_l1,mmu_page,toon,casi_delta,mmu_hydrate`).
- `x-fiche-cliff-saved-usd`: Dollars saved by avoiding a long-context price cliff.

Daemon & dashboard JSON endpoints (`127.0.0.1:47821`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`):
- `GET /api/health` (plus `fiche service status`): reports `version`, `pid`, `active_requests`, `compression_enabled`, and `price_mode`.
- `GET /api/mmu/stats`, `GET /api/mmu/page?id=...&session=...`, and `GET /api/calibration`: inspect RAM-only (or opt-in `FICHE_MMU_PERSIST=1`) `Context-MMU` pages and 4-axis vision calibration profiles with `0` LLM tokens.

## 3. MCP Server (`fiche-mcp`)

Run `fiche mcp` (stdio) or `fiche mcp --http 47823` (Streamable HTTP) to expose `6` read-only / inspection tools:
- `page_in`: Fetches a raw `pg_<12hex>` slice (or ranges) from the in-memory/persisted store, falling back automatically over loopback HTTP to the running `:47821` daemon when called from a separate MCP process (`sessionKey` propagated).
- `mmu_stats`: Returns `{ source, stats, pageCount, pages }` for virtual memory activity (`pagesStored`, `tailHydrations`, `markovFolds`, `skillsStubbed`, `densityPrunedBlocks`).
- `check_model`: Reports `inScope`, `readerTier` (`image` vs `text`), and active `textEngine` (e.g., `image+TOON+hygiene` vs `P0-P3 Text + Context-MMU`).
- `transform_request`: Inspects how `fiche` transforms a passed request JSON across `anthropic`, `responses`, `chat`, or `google` wires.
- `health`: Returns `fiche-mcp` version and Codex breakpoint stripping policy.
- `stats`: Returns in-memory call counters plus live `proxy.lastTurn` and `proxy.session` rollups read from `$FICHE_LOG`.
