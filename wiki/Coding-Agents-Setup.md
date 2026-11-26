# Coding Agents Setup

`fiche` runs as a local loopback HTTP proxy (`127.0.0.1:47821`) and/or a local MCP server (`fiche-mcp`). You can wire both in under a minute without losing native auth, plugins, or existing status-line tools.

---

## 0. Global CLI & MCP Binary

Install or link the CLI so `fiche` and `fiche-mcp` are available on your `PATH`:

```bash
# Run directly via npx (Node >= 20.19)
npx @sriinnu/fiche

# Or link a local checkout into ~/.local/bin
chmod +x bin/cli.js bin/mcp.js
ln -sfn "$(pwd)/bin/cli.js" ~/.local/bin/fiche
ln -sfn "$(pwd)/bin/mcp.js" ~/.local/bin/fiche-mcp
```

Recommended local proxy startup with multi-provider scope and `kosha` cliff/cache pricing:

```bash
FICHE_PRICES=kosha \
FICHE_MODELS="claude-fable-5,gemini,gpt-6-astra,gpt-6.2-astra,gpt-6.1-sol,gpt-5.6-sol,deepseek,kimi,glm,grok" \
fiche
```

---

## 1. Antigravity (AGY)

`plugins/fiche-companion/` ships a self-contained Antigravity plugin containing:
- `PostInvocation` hook (`scripts/post-invocation.mjs`) — reads `~/.fiche/events.jsonl` in `<5 ms` and shows inline turn/session savings via `metadata.user_markdown` (`systemMessage: ""`, **0 LLM tokens spent**).
- `fiche-mcp` server (`mcp_config.json`) — exposes `page_in`, `mmu_stats`, `check_model`, `transform_request`, `health`, and `stats`.
- `fiche` agent skill (`skills/fiche/SKILL.md`).

> **Provider Terms Note:** `fiche warp` runs locally on your own loopback interface using your own session credentials without sharing accounts or bypassing rate limits. Before wrapping a proprietary client such as Google Antigravity (`agy`), review that provider's current Terms of Service on local proxies/wrappers or configure direct base-URL routing (`GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:47821`) where supported.

Copy into Antigravity's global plugin directory:

```bash
mkdir -p ~/.gemini/config/plugins
cp -R plugins/fiche-companion ~/.gemini/config/plugins/fiche-companion
```

Restart or toggle `[fiche-companion](customization://fiche-companion)` in Antigravity Customizations.

---

## 2. Claude Code

### HTTP Proxy Routing (Preserving `/remote-control` & First-Party Connectors)

`fiche warp` preserves Claude Code's native TLS fingerprint and first-party checks:

```bash
fiche warp -- claude
```

Or connect directly via environment variable:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude
```

### MCP Registration (`~/.claude.json`) & Optional Marketplace (`.claude-plugin/`)

Add `mcpServers.fiche` alongside existing servers (`kosha`, `rea`, `pakt`, `drishti`):

```json
{
  "mcpServers": {
    "fiche": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/fiche/bin/mcp.js"],
      "env": {}
    }
  }
}
```

For `statusLine`, you can either keep your existing `tokmeter` status line or switch/combine with `plugins/fiche-companion/scripts/claude-statusline.mjs`. Both coexist cleanly with `fiche` logging to `~/.fiche/events.jsonl`.

---

## 3. OpenAI Codex

### Proxy Routing

```bash
# Preserves TLS + automatically strips unsupported prompt_cache_breakpoint on /backend-api/codex/
fiche warp -- codex

# Or explicit base URL
OPENAI_BASE_URL=http://127.0.0.1:47821/v1 codex
```

- `gpt-6-astra` / `gpt-6.2-astra` route automatically through the 4-layer deterministic text engine (`TSCG + TOON + CASI + ACDC`).
- `gpt-6.1-sol` / `gpt-6.2-sol` / `gpt-5.6-sol` support optical microfiche rendering when opted in via `FICHE_MODELS`.

### MCP Server (`~/.codex/config.toml`)

Append alongside `[mcp_servers.pakt]` / `[mcp_servers.drishti]`:

```toml
[mcp_servers.fiche]
command = "node"
args = ["/path/to/fiche/bin/mcp.js"]
enabled = true
```

---

## 4. Cursor

Add `fiche` to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "fiche": {
      "command": "node",
      "args": ["/path/to/fiche/bin/mcp.js"]
    }
  }
}
```

For proxy-free chat sessions inside Cursor UI, use **Offline Export**:

```bash
fiche export --git         # Uncommitted diff + untracked files
fiche export src/          # Target files/directories
```

Attach the generated `page-*.png` images and paste `factsheet.txt` + `prompt.txt`.

---

## 5. OpenCode

Add `mcpServers.fiche` in `~/.config/opencode/settings.json`:

```json
{
  "mcpServers": {
    "fiche": {
      "command": "node",
      "args": ["/path/to/fiche/bin/mcp.js"]
    }
  }
}
```

Route OpenCode HTTP traffic through `http://127.0.0.1:47821/v1` (or `fiche warp -- opencode`).

---

## 6. Gemini CLI

Add `mcpServers.fiche` in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "fiche": {
      "command": "node",
      "args": ["/path/to/fiche/bin/mcp.js"]
    }
  }
}
```

Route Google Gemini wire traffic through `http://127.0.0.1:47821/v1beta`. Validated optical tiers (`gemini-3.6-flash`, `gemini-3.8-flash`, `gemini-4-argon`) use dense bitmap microfiche; `gemini-4-neon`, `gemini-4-carbon`, and `gemini-4-hydrogen` use the pure deterministic text compiler.

---

## 7. DeepSeek / Kimi / GLM / Grok (29 Built-In Hosts across 21 Providers)

Route OpenAI-compatible or Anthropic-compatible third-party endpoints via `fiche warp`, `/to/<registered-host>/...`, or `FICHE_UPSTREAM_HOSTS`:

```bash
FICHE_MODELS="claude-fable-5,gemini,deepseek,kimi,glm,grok" FICHE_PRICES=kosha fiche
```

`src/core/upstream-hosts.ts` includes **29 built-in upstream hosts** (6 first-party + 23 third-party `COMPAT` hosts: `api.deepseek.com`, `api.moonshot.ai/.cn`, `api.kimi.com`, `api.z.ai`, `open.bigmodel.cn`, `api.minimax.io/.com`, `dashscope*.aliyuncs.com`, `openrouter.ai`, `api.x.ai`, `api.groq.com`, `api.together.xyz`, `api.fireworks.ai`, `api.cerebras.ai`, `api.mistral.ai`, `api.perplexity.ai`, `api.cohere.com`, `api.sambanova.ai`, `models.github.ai`, `models.inference.ai.azure.com`, `ai-gateway.vercel.sh`), forwarding strictly over HTTPS on port 443 with only the agent's own credential.

---

## 8. Desktop Apps (`fiche warp --app`), Shell Wrappers & Fail-Open Lifecycle

Launch macOS GUI coding apps through Fiche's local HTTPS CONNECT interceptor (or directly from **FicheBar.app → Control → Desktop App Proxy**):

```bash
fiche warp --app Cursor
fiche warp --app Antigravity
```

Generate shell helpers (`fclaude`, `fcodex`, `fagy`, `fgemini`, `fopencode`, `fcursor`, `famp`, `fpi`, `fiche-app`) or transparent wrappers in your `~/.zshrc`:

```bash
eval "$(fiche shell-init)"         # explicit f* helper commands
eval "$(fiche shell-init --wrap)"  # transparent wrappers (FICHE_BYPASS=1 skips once)
```

- **Zero-drop daemon restarts (`#34`)**: On macOS, run `fiche service install` once to enable `<key>Sockets</key>` (`~/.fiche/bin/fiche-launchd-exec`) + `ExitTimeOut: 65`, then use `fiche service restart` (or `FicheBar -> Restart`) for atomic `kickstart -k` restarts with `0` `ECONNREFUSED`. Linux `systemd` `LISTEN_FDS`/`LISTEN_PID` socket activation works automatically too.
- **Resilient daemon stop (`#33` / `fiche warp` fail-open)**: When `:47821` is stopped, newly launched `fiche warp` commands bypass proxying cleanly (`FICHE_BYPASS=1`), already-running wrapped sessions automatically fail open directly to upstream on `ECONNREFUSED` (and reattach automatically when the daemon restarts), and `NO_PROXY` / `no_proxy` preserve existing rules alongside `localhost,127.0.0.1,::1`.

---

## 9. Multi-Provider Orchestrators & Swarms (`ribhu`, `opencode`, `t3code`)

When an orchestrator spawns parallel workers that freely pick models across any provider regardless of the orchestrator's own base model, `fiche` routes and compiles **per request** by `(Host, path, model)`:

```bash
# 1. Keep model registry fresh via Kosha, then sync active chat model bases into ~/.config/fiche/config.json:
kosha update
fiche providers enable deepseek kimi glm openrouter xai groq mistral
fiche models sync-kosha --apply   # preview first without --apply, or add --all-providers

# 2. Or intercept every built-in provider for one orchestrator run:
fiche warp --all-providers -- ribhu
```

- **Why `--all-providers` / `fiche providers enable` matters**: By default `fiche` intercepts the 3 first-party providers (`anthropic`, `openai`, `google`); third-party COMPAT hosts pass through cleanly untouched unless enabled. Include the worker model families you want compiled in `FICHE_MODELS` or `~/.config/fiche/config.json` (`fiche models sync-kosha --apply` preserves existing pinned families and keeps third-party/open-weight models on the 4-layer text compiler unless calibrated); unconfigured models pass through byte-for-byte.
- **Provider-neutral worker isolation (`x-fiche-session-id`)**: Orchestrators running concurrent workers on OpenAI Chat, OpenAI Responses, Gemini, or Anthropic should send a per-worker `x-fiche-session-id: <worker-id>` header (legacy `x-inkling-session-id` also accepted; `x-claude-code-session-id` remains supported on Anthropic). `fiche` uses it across all 4 wires for isolated `Context-MMU` / `LSM-Context` session keys AND in-flight `409` dedupe (so two concurrent workers sending identical Turn-1 prompts both succeed cleanly), then strips `x-fiche-session-id` before forwarding upstream.
- **Swarm memory sizing (`~/.config/fiche/config.json`)**: For heavy multi-worker sessions (`50+` concurrent sessions), tune `"mmu_max_pages": 4096` (`[64, 16384]`), `"mmu_max_mb": 64` (`[4, 256]`), and `"max_sessions": 2048` (`[64, 8192]`) alongside `"providers"` and `"models"`.
- **Gateway model matching & isolation**: Slash-qualified gateway model IDs (`anthropic/claude-opus-5-5`, `google/gemini-3.8-flash`) match on the segment after the last `/`. Every request keeps its own provider credential isolated, removes `sk-ant-*` tokens before non-Anthropic/COMPAT hosts, and isolates `LSM-Context` epochs and `Context-MMU` pages per `(sessionKey, model)`.
- **Explicit per-provider base URLs & custom gateways**: Without `fiche warp`, point third-party endpoints at `http://127.0.0.1:47821/to/<host>/...` (e.g. `/to/openrouter.ai/api/v1`) and register custom enterprise HTTPS:443 hosts with `fiche providers add-host <host/prefix>` or `FICHE_UPSTREAM_HOSTS`.
- **Automatic local-LLM bypass**: Local models on `localhost`, `127.0.0.1`, or `::1` (Ollama, vLLM, LM Studio) automatically bypass `fiche warp` via `NO_PROXY` (`localhost,127.0.0.1,::1`) and `/to/` loopback guards — leaving local models untouched by design.
- **Not covered in `v0.19.0`**: Enterprise endpoints outside the 29 built-in HTTPS:443 hosts — AWS Bedrock (SigV4 signing + regional hosts), GCP Vertex AI (regional IAM/ADC endpoints), and internal plain-HTTP or self-signed corporate LiteLLM gateways — are not natively covered yet and should bypass `fiche` directly.
