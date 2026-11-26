# Getting Started with `fiche`

`fiche` (*microfiche for coding agents*) is a cache-safe, edit-preserving local/edge context compiler and HTTP proxy (`127.0.0.1:47821`) plus an optional MCP inspection server (`fiche-mcp`) and proxy-free export CLI (`fiche export`).

---

## 1. Prerequisites & Installation

`fiche` is **OS-independent (cross-platform)** — it runs on **macOS, Linux, Windows (native & WSL), Docker, and Cloudflare Workers**, requiring only **Node.js `>= 20.19`** (zero external `node:` dependencies inside `src/core/`).

- **Optional macOS-only extras:** `FicheBar.app` (native SwiftUI menubar UI — on Linux/Windows open the full web dashboard at `http://127.0.0.1:47821`), `fiche service` (`launchd` helper — use `systemd --user` or Docker on Linux, Task Scheduler/WSL on Windows), and `fiche warp --app <Name>` (`.app` bundle resolver — on Linux/Windows pass your binary directly via `fiche warp -- <cli>`).

### Option A — Global npm install (recommended for daily use)

```bash
npm install -g @sriinnu/fiche
fiche --version
```

### Option B — Ephemeral `npx`

```bash
npx @sriinnu/fiche
```

### Option C — From source

```bash
git clone https://github.com/sriinnu/fiche.git
cd fiche
pnpm install
pnpm run build

# Optional: link binaries onto PATH
mkdir -p ~/.local/bin
ln -sfn "$(pwd)/bin/cli.js" ~/.local/bin/fiche
ln -sfn "$(pwd)/bin/mcp.js" ~/.local/bin/fiche-mcp
```

### Option D — Docker Compose or Cloudflare Workers

```bash
# Hardened read-only container on 127.0.0.1:47821
docker compose up -d
```

For edge deployments, configure [wrangler.toml](../wrangler.toml) and set `FICHE_WORKER_SECRET` (see [Security Model](./SECURITY_MODEL.md)):

```bash
npx wrangler secret put FICHE_WORKER_SECRET
npx wrangler deploy
```

---

## 2. Proxy Daemon vs. `fiche warp` vs. `fiche-mcp` vs. `fiche export`

Understanding which binary handles which job prevents the most common setup mistake: **starting only `fiche-mcp` does not compress live agent turns.**

| Component | Command | What It Does | Compresses Live Turns? |
| :--- | :--- | :--- | :--- |
| **Proxy Daemon** | `fiche` (or `fiche service install`) | Loopback HTTP proxy on `127.0.0.1:47821`; applies optical microfiche + 4-layer text compiler, logs `~/.fiche/events.jsonl`, emits `x-fiche-*` headers | **Yes** |
| **Warp Launcher** | `fiche warp -- <agent>` | Runs an agent behind a narrow local CONNECT proxy that diverts *only* inference endpoints to `127.0.0.1:47821`, preserving native TLS & first-party checks | **Yes** (requires running Proxy Daemon) |
| **MCP Server** | `fiche mcp` / `fiche-mcp` | Stdio tool server spawned on demand by IDE/CLI clients (`check_model`, `transform_request`, `health`, `stats`); `--http 47823` optional | **No** (inspect/dry-run & stats only) |
| **Offline Export** | `fiche export ...` | Proxy-free CLI generating `page-*.png`, `factsheet.txt`, `prompt.txt`, and `manifest.json` | Offline bundle |

---

## 3. Starting the Daemon & Choosing Model Scope

Zero-config starts with `FICHE_MODELS=claude-fable-5,gemini` so only empirically verified dense pixel readers enter optical scope by default. To enable the **4-layer deterministic text compiler** across Astra, Opus 5.5, DeepSeek, Kimi, GLM, and Grok with calibrated billing math:

```bash
FICHE_PRICES=kosha \
FICHE_TEXT_HYGIENE=on \
FICHE_MODELS="claude-fable-5,gemini,gpt-6-astra,gpt-6.2-astra,claude-opus-5-5,deepseek,kimi,glm,grok" \
fiche
```

Or persist your model list in `~/.config/fiche/config.json`:

```json
{
  "models": [
    "claude-fable-5",
    "gemini",
    "gpt-6-astra",
    "gpt-6.2-astra",
    "claude-opus-5-5",
    "deepseek",
    "kimi",
    "glm",
    "grok"
  ]
}
```

> **Note:** Open `http://127.0.0.1:47821/` in your browser to inspect live renders, toggle models, or flip the kill switch. The proxy binds loopback-only by default and does not auto-launch a browser window.

---

## 4. macOS Auto-Start (`fiche service`) & `FicheBar.app`

On macOS, install the persistent `launchd` service (`com.sriinnu.fiche`) so the proxy daemon starts on login with `FICHE_PRICES=kosha` and `FICHE_TEXT_HYGIENE=on`:

```bash
fiche service install     # installs & loads ~/Library/LaunchAgents/com.sriinnu.fiche.plist
fiche service status      # verifies PID, port 47821, compression state, and price mode
```

Full lifecycle commands:

```bash
fiche service start | stop | restart | status | uninstall [--json]
```

Logs go to `~/.fiche/daemon.out.log` and `~/.fiche/daemon.err.log`.

### Native Menubar App (`FicheBar.app`)

Build and install the native macOS 14+ SwiftUI menubar companion ([apps/macos-bar/README.md](../apps/macos-bar/README.md)):

```bash
./apps/macos-bar/bundle.sh --install
```

`FicheBar` displays live menu bar savings (`-48% · $1.24`), automatically kickstarts the LaunchAgent (or spawns a detached daemon) if offline, and provides one-click **Pause / Resume** (`POST /api/compression`), **Restart / Stop** (`POST /api/shutdown`), live **Models** toggles (`/api/models`), and **Stages & Skills** toggles (`/api/plugins`).

---

## 5. Connecting Every Coding Agent

### Claude Code

1. **Live Proxy Routing (`fiche warp` preserves `/remote-control` and `claude.ai` connectors):**
   ```bash
   fiche warp -- claude
   ```
   *(Or set `ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude` if you do not need first-party TLS identity.)*
2. **MCP Inspection Tools (`~/.claude.json`):**
   ```json
   {
     "mcpServers": {
       "fiche": {
         "type": "stdio",
         "command": "fiche-mcp",
         "args": []
       }
     }
   }
   ```
   *(You can also install the bundled marketplace plugin from `.claude-plugin/`.)*
3. **Zero-Token `statusLine` (`~/.claude/settings.json`):**
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node /path/to/fiche/plugins/fiche-companion/scripts/claude-statusline.mjs"
     }
   }
   ```
   *(Already using `tokmeter`'s `statusLine`? See [Sharing Claude Code's Single statusLine](./ECOSYSTEM_INTEGRATION.md#sharing-claude-codes-single-statusline).)*

### OpenAI Codex

1. **Recommended — `fiche warp` (zero Codex config changes):**
   ```bash
   fiche warp -- codex
   ```
   `fiche` automatically routes `api.openai.com` and `chatgpt.com/backend-api/codex/responses`, strips unsupported `prompt_cache_breakpoint` fields, and routes `gpt-6-astra` / `gpt-6.2-astra` through the 4-layer text engine (`0` images).
2. **Or explicit base URL / Codex profile (`~/.codex/config.toml`):**
   ```bash
   OPENAI_BASE_URL=http://127.0.0.1:47821/v1 codex
   ```
   Or define a custom `model_provider` + `[profiles.fiche]` in `~/.codex/config.toml` and launch `codex -p fiche`.
3. **MCP Tools (`~/.codex/config.toml`):**
   ```toml
   [mcp_servers.fiche]
   command = "fiche-mcp"
   args = []
   enabled = true
   ```

### Antigravity (AGY)

Copy the bundled companion + MCP + skill plugin into Antigravity's global plugin directory:

```bash
mkdir -p ~/.gemini/config/plugins
cp -R plugins/fiche-companion ~/.gemini/config/plugins/fiche-companion
```

This wires:
- `PostInvocation` hook (`scripts/post-invocation.mjs`) — displays per-turn/session savings inline in `<5 ms` with **0 extra LLM tokens**.
- `fiche-mcp` server (`mcp_config.json`).
- `fiche` skill (`skills/fiche/SKILL.md`).

### Gemini CLI

1. **MCP (`~/.gemini/settings.json`):**
   ```json
   {
     "mcpServers": {
       "fiche": {
         "command": "fiche-mcp",
         "args": []
       }
     }
   }
   ```
2. **Proxy Routing:** launch `fiche warp -- gemini` (or set `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:47821`). Measured vision tiers (`gemini-3.8-flash`, `gemini-4-argon`) use optical microfiche; `gemini-4-neon`, `gemini-4-carbon`, `gemini-4-hydrogen`, and `gemini-3.1-pro-preview` automatically stay on the 4-layer text compiler.

### Cursor

1. **Proxy-Free Optical Bundles:** run `fiche export --git` or `fiche export src/`, then attach `page-*.png` and paste `factsheet.txt` + `prompt.txt`.
2. **MCP (`~/.cursor/mcp.json`):**
   ```json
   {
     "mcpServers": {
       "fiche": {
         "command": "fiche-mcp",
         "args": []
       }
     }
   }
   ```

### OpenCode, Pi & Other OpenAI-Compatible Clients

Add `mcpServers.fiche` in `~/.config/opencode/settings.json` and launch via `fiche warp -- opencode` or `OPENAI_BASE_URL=http://127.0.0.1:47821/v1`. Third-party providers (DeepSeek, Kimi, z.ai GLM, MiniMax, xAI Grok) also work via `/to/<registered-host>/...` (for example `http://127.0.0.1:47821/to/api.deepseek.com/v1`).

---

## 6. Verification & Troubleshooting

Check live daemon health and latest turn savings:

```bash
curl -s http://127.0.0.1:47821/api/health
fiche turn-report --color
fiche stats
```

Common issues:

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| **`unsupported_model` / 0% savings** | Model is not in `FICHE_MODELS` (default `claude-fable-5,gemini`) and `FICHE_TEXT_HYGIENE` is not `on` | Add the model base to `FICHE_MODELS` / `~/.config/fiche/config.json`, or set `FICHE_TEXT_HYGIENE=on` |
| **Text compressed instead of PNG images** | Model is classified `readerTier === 'text'` (Astra, Opus 5.5, Grok, DeepSeek, Kimi, GLM, Carbon/Hydrogen/Neon) | Intentional — these models save more USD and avoid OCR regressions in text mode (`FICHE_FORCE_IMAGES=1` overrides if testing) |
| **HTTP `403` or `421` from proxy** | Non-loopback Origin or unknown `Host` header blocked by `request-guard.ts` | Keep traffic on `127.0.0.1`, or add trusted hosts via `FICHE_ALLOWED_HOSTS` |
| **Need byte-identical passthrough for one call** | Debugging a prompt or upstream issue | Send header `x-fiche-bypass: 1` or toggle Pause in `FicheBar` / `:47821` dashboard |
| **Verify edits aren't altered** | Checking `Edit` / `apply_patch` safety | Active source reads and unified diffs are frozen verbatim by `isCodeOrDiffProtected()` |

For deeper technical details, continue to [Ecosystem Integration](./ECOSYSTEM_INTEGRATION.md), [Plugins & Skills](./PLUGINS_AND_SKILLS.md), [Architecture](./ARCHITECTURE.md), or the [Wiki](../wiki/Home.md).
