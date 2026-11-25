# Fiche Companion Plugin

Zero-token-overhead per-turn & session local token/dollar savings reporting for coding agents running through the `fiche` proxy (`node dist/node.js`).

## 1. Antigravity (Inline Per-Turn UI Banner, 0 LLM Tokens)
Register or copy `plugins/fiche-companion/` into your Antigravity customizations directory (`.agents/plugins/fiche-companion/` or `~/.gemini/config/plugins/fiche-companion/`).
Every `PostInvocation` reads `~/.fiche/events.jsonl` (`$FICHE_LOG`, with legacy `$INKLING_LOG` / `~/.inkling/events.jsonl` fallback) in `<5ms` and injects `metadata.user_markdown` with `systemMessage: ""`, showing per-turn and session savings inline without billing any LLM tokens.

## 2. Claude Code `statusLine`
In `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/fiche/plugins/fiche-companion/scripts/claude-statusline.mjs"
  }
}
```

## 3. Any CLI (Codex / Gemini CLI / shell prompt)
```bash
fiche turn-report --color
fiche turn-report --format=json
curl -s http://127.0.0.1:47821/api/last-turn.json
```

## 4. MCP Tools (`fiche-mcp`) & Skill

Configured via `mcp_config.json` (`npx --yes --package @sriinnu/fiche fiche-mcp`) and documented in `skills/fiche/SKILL.md`:

- `page_in` — retrieve verbatim lines from `Context-MMU` virtual memory by `pg_<12hex>` ID or symbol/text query (scoped by optional `sessionKey`), falling back to the running loopback daemon.
- `mmu_stats` — inspect `Context-MMU` virtual memory counters and resident page summaries (no raw page bodies).
- `check_model` — check `FICHE_MODELS` scope, `readerTier` (`image` vs `text`), and active engine pipeline.
- `transform_request` — preview how `fiche` compiles an `anthropic`, `responses`, `chat`, or `google` request payload.
- `stats` — live `lastTurn` and cumulative `session` token/USD savings from `$FICHE_LOG`, plus MCP call counters.
- `health` — server version and Codex `prompt_cache_breakpoint` stripping status.

## 5. Downstream Proxy Response Headers
Every proxied inference response carries:
- `x-fiche-saved-tokens`
- `x-fiche-stages` (e.g. `tscg,toon,casi_delta,acdc_epoch` or `image,casi_dup`)
- `x-fiche-cliff-saved-usd` (when a long-context cliff was avoided)
