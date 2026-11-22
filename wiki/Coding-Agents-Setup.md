# Coding Agents Setup

`fiche` runs as a local loopback HTTP proxy (`127.0.0.1:47821`) and/or a local MCP server (`fiche-mcp`). You can wire both in under a minute without losing native auth, plugins, or existing telemetry tools.

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

`plugins/fiche-telemetry/` ships a self-contained Antigravity plugin containing:
- `PostInvocation` hook (`scripts/post-invocation.mjs`) — reads `~/.fiche/events.jsonl` in `<5 ms` and shows inline turn/session savings via `metadata.user_markdown` (`systemMessage: ""`, **0 LLM tokens spent**).
- `fiche-mcp` server (`mcp_config.json`) — exposes `check_model`, `transform_request`, `health`, and `stats`.
- `fiche` agent skill (`skills/fiche/SKILL.md`).

Copy into Antigravity's global plugin directory:

```bash
mkdir -p ~/.gemini/config/plugins
cp -R plugins/fiche-telemetry ~/.gemini/config/plugins/fiche-telemetry
```

Restart or toggle `[fiche-telemetry](customization://fiche-telemetry)` in Antigravity Customizations.

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

For `statusLine`, you can either keep your existing `tokmeter` status line or switch/combine with `plugins/fiche-telemetry/scripts/claude-statusline.mjs`. Both coexist cleanly with `fiche` logging to `~/.fiche/events.jsonl`.

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

## 7. DeepSeek / Kimi / GLM / Grok (23-Host Registry)

Route OpenAI-compatible or Anthropic-compatible third-party endpoints via `fiche warp`, `/to/<registered-host>/...`, or `FICHE_UPSTREAM_HOSTS`:

```bash
FICHE_MODELS="claude-fable-5,gemini,deepseek,kimi,glm,grok" FICHE_PRICES=kosha fiche
```

`src/core/upstream-hosts.ts` includes a built-in **23-host `COMPAT` registry** (`api.deepseek.com`, `api.moonshot.ai/.cn`, `api.kimi.com`, `api.z.ai`, `open.bigmodel.cn`, `api.minimax.io/.com`, `dashscope*.aliyuncs.com`, `openrouter.ai`, `api.x.ai`, `api.groq.com`, `api.together.xyz`, `api.fireworks.ai`, `api.cerebras.ai`, `api.mistral.ai`, `api.perplexity.ai`, `api.cohere.com`, `api.sambanova.ai`, `models.github.ai`, `models.inference.ai.azure.com`, `ai-gateway.vercel.sh`), forwarding strictly over HTTPS on port 443 with only the agent's own credential.

---

## 8. Desktop Apps (`fiche warp --app`) & Shell Wrappers (`fiche shell-init`)

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
