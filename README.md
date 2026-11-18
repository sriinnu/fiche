<p align="center">
  <img src="assets/inkling-logo.svg" alt="inkling" width="420">
</p>

<h1 align="center">inkling</h1>

<p align="center"><strong>Images for the context a model can read. Everything else untouched.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-6D5BFF.svg"></a>
  <img alt="Node >= 20.19" src="https://img.shields.io/badge/node-%3E%3D20.19-339933.svg?logo=node.js&logoColor=white">
  <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10.21.0-F69220.svg?logo=pnpm&logoColor=white">
  <img alt="MCP server" src="https://img.shields.io/badge/MCP-server-1E1B4B.svg">
</p>

inkling is a local proxy for coding agents: Claude Code, Codex, OpenCode, pi, Cursor, and anything else that speaks the Anthropic, OpenAI or Gemini wire format. Providers bill an image by its pixel area, not by the characters drawn on it. For models that can read dense text in an image, inkling renders the stale, bulky parts of a request as PNG pages:

- the system prompt and tool docs
- old, closed tool rounds
- large tool results

It forwards everything else byte for byte.

- One 1568×728 page bills about 1,456 tokens on Anthropic and holds about 28k characters.
- The live tail, any open tool call and your current message stay text. Next to each image goes a short text factsheet that repeats its paths, hashes and numbers verbatim.
- Old pages stay byte-identical from turn to turn, so the provider reads them from the prompt cache instead of billing them again.
- A profitability gate images a block only when the image costs fewer tokens than the text it replaces. Sparse prose stays text.
- If a transform throws, inkling fails open and forwards the request as it arrived.

![a real transformRequest output: system prompt and tool docs reflowed into one dense page, an instruction banner on top, ↵ marking the original newlines](docs/assets/example-render.png)

*About 48k characters of system prompt and tool docs: about 25k tokens as text, about 2.7k image tokens as this page.*

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

inkling isn't on npm yet; the v0.17.0 publish is pending. Until then, install from git:

```bash
npx --yes --package github:sriinnu/inkling inkling        # proxy on 127.0.0.1:47821
```

Or run it from a checkout:

```bash
pnpm install && pnpm build
node dist/node.js
```

Once published, run it with `npx @sriinnu/inkling`. Use the scoped name: the unscoped `inkling` on npm is an unrelated package.

## Point your agent at it

**Claude Code:**

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude
```

**ChatGPT Codex.** Add this provider to `~/.codex/config.toml`:

```toml
model = "gpt-5.6-sol"
model_provider = "inkling"

[model_providers.inkling]
name = "inkling"
base_url = "http://127.0.0.1:47821/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

Then start the proxy with Sol in scope and the ChatGPT upstream:

```bash
OPENAI_UPSTREAM=https://chatgpt.com INKLING_MODELS=gpt-5.6-sol node dist/node.js
```

- **`[profiles.*]` tables:** Codex 0.167+ rejects them in `config.toml`. For an opt-in profile, put the provider in `~/.codex/inkling.config.toml` and run `codex -p inkling`.
- **WebSocket:** Codex tries one first. inkling answers 426, so Codex falls back to HTTP; inkling decodes its zstd body before compressing.

**OpenAI-compatible clients:**

```bash
OPENAI_BASE_URL=http://127.0.0.1:47821/v1
```

**No base URL at all (`inkling warp`).** `warp` runs the agent and diverts its provider's inference paths into inkling. The agent keeps talking to its real host, so OAuth, Claude Code `/remote-control`, claude.ai connectors and other first-party gates keep working.

```bash
inkling warp -- claude
inkling warp -- agy             # Antigravity CLI (Gemini)
inkling warp -- opencode        # or codex, cursor-agent, omp, any shell alias
inkling warp --route '127.0.0.1:9090/v1/*=http://127.0.0.1:47821' -- codex
```

By default it routes:

- Anthropic `/v1/messages`
- Google CloudCode `streamGenerateContent`/`generateContent`
- Google AI Studio `streamGenerateContent`/`generateContent`

`--route` adds a rule for any other base URL. A rule that names a port matches only that port.

**Dashboard:** <http://127.0.0.1:47821/>. It shows:

- tokens and dollars saved, with a kill switch
- model chips that turn models on and off live
- every text-to-image conversion, side by side

inkling compresses the request only. Responses stream back untouched.

## Which models get images

Imaging needs two things: the model is in scope (default `INKLING_MODELS=claude-fable-5,gemini`), and it reads dense pages well enough for an image to beat text.

| Model | What inkling does |
| --- | --- |
| Gemini (3.6–3.8 Flash, Gemini 4 Argon, Pro) | Images by default |
| Claude Fable 5, 5.1, 5.2 (5.1 and later with 2px of extra row spacing) | Images by default |
| `gpt-5.6-sol`, `gpt-6.1-sol` (native 14px profile), Claude Opus 5 | Images once named in `INKLING_MODELS` |
| Claude Opus, Sonnet and Haiku 5.5, every Haiku, Grok, Gemini 4 hydrogen and carbon | Text, even when named. They understand rendered pages but misread single characters. `INKLING_FORCE_IMAGES=1` overrides this for a model that is also named |
| Anything not in scope | Forwarded byte for byte |

`INKLING_MODELS=off` or `compress: false` turns imaging off. The measurements behind this table predate inkling (see [Credits](#credits)); they are in [docs/BENCHMARKS.md](docs/BENCHMARKS.md), with per-model render geometry in [docs/MODEL_RENDER_PROFILES.md](docs/MODEL_RENDER_PROFILES.md).

## Savings, measured per request

inkling doesn't quote a headline saving. Whether images save money depends on your model, your traffic and how much of it the client re-sends, so measure your own.

- **Measured savings.** For every Anthropic `/v1/messages` request, inkling sends the original, uncompressed body to the free `count_tokens` endpoint, in parallel with the real request. It reads the billed usage off the response. Both land in one row of `~/.inkling/events.jsonl`, so the comparison has no turn-count or run-to-run confound. A row without a probe counts as unmeasured, never as zero saving.
- **Cache-weighted dollars.** Cache reads, writes and output are weighted by their price ratios on both sides, so the caching discount cancels and isn't counted as a saving. The warm-cache window follows the TTL the session writes: 1 hour after a 1-hour write, otherwise 5 minutes.
- **Prices (`INKLING_PRICES`).**
  - `legacy`, the default, uses inkling's historical ratios: 1.25x for a cache write and 0.1x for a read.
  - `INKLING_PRICES=kosha` prices each model from a build-time table of first-party rows in a kosha registry export (`pnpm prices:gen`, checked by `pnpm prices:check`). Every row cites its source.
  - In kosha mode an unpriced model is never imaged, and the dashboard counts its rows apart.
  - The gate and the savings math price from one resolver, so the decision to image and the reported saving can't disagree.

Formula and field names: [docs/CACHING_AND_SAVINGS.md](docs/CACHING_AND_SAVINGS.md) and `src/core/baseline.ts`.

Read the log after the fact, with no server running:

```bash
inkling stats                  # human report from ~/.inkling/events.jsonl
inkling stats --json
inkling stats --file /path/to/events.jsonl
```

`inkling stats` exits 0 when it prints a report, 1 when the file is missing, and 2 when the file has no valid events.

## Safety

inkling holds your provider credentials, so the proxy is locked down by default. [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) has the details.

- **Loopback only.** It binds `127.0.0.1`. Dashboard routes stay loopback-only even when `HOST` binds wider.
- **No cross-site spending.** A browser request from a non-loopback page gets 403. A public DNS name in `Host` that isn't a known provider host gets 421, which blocks DNS rebinding. `INKLING_ALLOWED_HOSTS` adds names.
- **Default-deny routing.**
  - Every `/backend-api/` path goes to the ChatGPT upstream.
  - Google countTokens and listing paths go to Google.
  - On the stock Anthropic upstream, paths outside `/v1/*` and `/api/*` get 404.
- **No `prompt_cache_breakpoint` on ChatGPT Codex.** chatgpt.com rejects it with HTTP 400, so inkling never sends it on a `/backend-api/codex/` path or to `chatgpt.com`. When a profile injects the field, it's removed as a text edit, so nothing else in the body is re-serialized. `api.openai.com` still gets the field when the profile asks for it.
- **Bounded decoding.** gzip, deflate, br and zstd bodies are decoded up to a size limit. A body inkling can't decode is forwarded as is, never rewritten.

## Follow the agent to third-party providers

One inkling serves every provider an agent talks to. A request for a registered third-party host goes back to that host over https, carrying only the agent's own credential. inkling's configured keys, gateway headers and `count_tokens` probes never apply to it.

- Under `inkling warp`, the agent keeps addressing its provider, and inkling follows the `Host` header.
- With a base URL, put the host in the path: `ANTHROPIC_BASE_URL=http://127.0.0.1:47821/to/api.deepseek.com/anthropic`.

Built-in hosts are DeepSeek, Moonshot/Kimi, z.ai/BigModel, MiniMax, Qwen DashScope, OpenRouter and xAI. `INKLING_UPSTREAM_HOSTS=host[/api-prefix],...` adds more, and `INKLING_FOLLOW_HOSTS=0` turns following off.

The proxy refuses some requests before any upstream call:

- unknown hosts
- IP literals and local names
- ports other than 443
- `user@host` tricks
- first-party hosts named through `/to/`

It also returns redirects to the agent instead of following them, and strips an Anthropic credential (`sk-ant-…`) before it can reach a third party. With following off, a third-party `Host` is refused, never re-routed to Anthropic.

## MCP server

`inkling mcp` (also `inkling-mcp`) runs over stdio, or over stateless Streamable HTTP with `--http PORT` (`POST /mcp` on loopback; `GET` answers 405).

```bash
node dist/node.js mcp                 # stdio
node dist/node.js mcp --http 47823    # http://127.0.0.1:47823/mcp
```

The MCP tools don't lower your bill; the HTTP proxy does. A tool call adds its argument and result to the turn, and the tool list itself is extra cached prefix. Use the tools to inspect what inkling would do.

| Tool | What it does |
| --- | --- |
| `check_model` | Whether a model is in scope, and whether it gets images or text. |
| `transform_request` | Runs inkling on a request object and reports estimated tokens before and after. Pass `upstream: "https://chatgpt.com"` or a `/backend-api/codex/` path to strip `prompt_cache_breakpoint`. |
| `health` | Version and the Codex breakpoint policy. No payloads. |
| `stats` | Process counters only. |

All four are read-only and closed-world. `stats` isn't idempotent.

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_model","arguments":{"model":"claude-opus-5-5"}}}
```

In the client configs below, replace `<checkout>` with the absolute path of this repo.

**Claude Code** loads this repo as a plugin (`.claude-plugin/plugin.json` with `.mcp.json`; marketplace: `claude plugin marketplace add sriinnu/inkling`). Or use `.mcp.json` or `claude_desktop_config.json` directly. **Cursor** reads the same block from `.cursor/mcp.json`, and **pi** from `~/.pi/agent/mcp.json`:

```json
{ "mcpServers": { "inkling": { "command": "node", "args": ["<checkout>/dist/node.js", "mcp"] } } }
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.inkling]
command = "node"
args = ["<checkout>/dist/node.js", "mcp"]
# or, after `mcp --http 47823`:
# url = "http://127.0.0.1:47823/mcp"
```

**pi** from a shell:

```bash
pi mcp add inkling -- node <checkout>/dist/node.js mcp
```

**OpenCode:**

```json
{ "mcp": { "inkling": { "type": "local", "command": ["node", "<checkout>/dist/node.js", "mcp"], "enabled": true } } }
```

For the remote form, use `"type": "remote"` with the `url` above.

**[Ribhu](https://github.com/sriinnu/ribhu)** takes an extension file, `~/.ribhu/agent/extensions/inkling.json`. Tools show up as `mcp__inkling__<tool>`.

```json
{
  "slash": "/inkling",
  "description": "inkling context tools",
  "prompt": "Use the inkling MCP tools to check which models inkling images and to inspect a request. {args}",
  "mcp": { "command": "node", "args": ["<checkout>/dist/node.js", "mcp"] }
}
```

Any other stdio client takes the same `command` and `args` pair. Over HTTP, point it at `http://127.0.0.1:47823/mcp`.

## Offline export (no proxy)

`inkling export` renders text, files or a diff to PNG pages without running the proxy. Use it for image-upload clients such as Cursor.

```bash
inkling export src/
cat prompt.txt | inkling export --stdin
inkling export --git
```

Each run writes a new `inkling-export-XXXXXX/` folder containing `page-*.png`, `factsheet.txt`, `manifest.json` and `prompt.txt`. The command prints the folder's path when it finishes.

## Library use

```ts
import { renderTextToImages, transformAnthropicMessages } from "@sriinnu/inkling";

const { pages } = await renderTextToImages(toolResultText);     // pages[i].png: Uint8Array
const { body, applied, info } = await transformAnthropicMessages({
  body: requestBytes,
  model: "claude-fable-5",
});
```

- `options.keepSharp(block)` pins blocks as text.
- `options.emitRecoverable` returns the originals of imaged blocks.

The runtime is pure JS, for Node and edge runtimes such as Workers; `@napi-rs/canvas` is needed only at build time. Full API: `src/core/index.ts`.

## Configuration

`node dist/node.js --help` lists every variable. The ones you'll reach for:

| Variable | What it does |
| --- | --- |
| `INKLING_MODELS` | Model bases allowed to compress (default `claude-fable-5,gemini`; `off` disables). |
| `INKLING_FORCE_IMAGES` | `1` images weak readers that are also named in scope. Doesn't re-enable `prompt_cache_breakpoint` on Codex. |
| `INKLING_PRICES` | `kosha` prices from the kosha table; anything else is `legacy`. |
| `INKLING_GPT_PROFILES` | JSON per-model overrides for GPT-family profiles (for example `{"gpt-5.6-sol":{"cacheBreakpoints":false}}`). |
| `INKLING_GPT_HISTORY_MAX_IMAGES` | History image cap on the GPT path (defensive cap 100). |
| `ANTHROPIC_UPSTREAM`, `OPENAI_UPSTREAM`, `INKLING_UPSTREAM` | Upstream bases. |
| `INKLING_UPSTREAM_HOSTS`, `INKLING_FOLLOW_HOSTS` | Third-party hosts to follow, and the off switch. |
| `INKLING_ALLOWED_HOSTS` | Extra `Host`/`Origin` names the proxy API accepts. |
| `INKLING_DISABLE` | Pass-through mode: no compression, still logs usage and baselines. |
| `INKLING_LOG`, `INKLING_CONFIG`, `INKLING_SESSION_STATE` | Events log, JSON config and session-state paths (under `~/.inkling` and `~/.config/inkling`). |
| `PORT`, `HOST` | Listen port (default 47821) and interface (default loopback). |

Docker: `compose.yml` runs the proxy read-only, with every capability dropped, bound to `127.0.0.1`. Cloudflare Workers: `wrangler.toml` and `src/worker.ts`.

## Limits

- **Exact strings in an image aren't byte-safe.** A model's vision encoder reads patch embeddings, not characters, so it has no per-glyph confidence to fail loudly on. When the pixels underdetermine a glyph, the model fills it in with something plausible, so a miss reads as confident and wrong.
  - Coding agents tolerate this, because they re-read a file before editing it.
  - Pure chat recall has no such check.
  - The factsheet carries the identifiers most likely to matter, as text.
  - Background: [docs/NOT-OCR.md](docs/NOT-OCR.md) and [docs/LEGIBILITY-AUDIT-2026-07-01.md](docs/LEGIBILITY-AUDIT-2026-07-01.md).
- **Workload-dependent.** Token-dense content (code, JSON, logs, about 1 character per token) wins. Sparse prose (about 3.5 characters per token) loses, and the gate leaves it as text.
- **Latency.** PNG encoding adds time before a large request leaves. Speeding up the transform on very large bodies is being worked on.
- **Script coverage.** ASCII and Latin-1 are well tested; CJK works, but conservatively.
- **Platforms.** Developed on macOS and Linux.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build          # regenerates dist/
pnpm prices:check   # the kosha price table matches the snapshot
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the workflow, [SECURITY.md](SECURITY.md) how to report a vulnerability, and [CHANGELOG.md](CHANGELOG.md) what changed.

## Credits

inkling's image pipeline, renderer, evals and most of the research in [FINDINGS.md](FINDINGS.md) and [docs/BENCHMARKS.md](docs/BENCHMARKS.md) come from **[pxpipe](https://github.com/teamchong/pxpipe)** by Steven ([teamchong](https://github.com/teamchong)), MIT. inkling started from pxpipe v0.16.0 (`9e0e0e99b4483f40e8a58036bb1f6a1a81c331e3`). Steven's work includes:

- the "context as images" idea
- the fonts and atlases
- the `count_tokens` counterfactual
- the model-tier measurements

Thank you, Steven.

Other projects built on pxpipe, not maintained by inkling:

- [pxpipe-windows](https://github.com/DivyeshPatro/pxpipe-windows) — Windows support for `pxpipe mitm` (node-forge CA in place of openssl, Task Scheduler autostart).
- [OmniGlyph](https://github.com/diegosouzapw/OmniGlyph) — a community-maintained project derived from pxpipe and used by [OmniRoute](https://github.com/diegosouzapw/OmniRoute).
- [pxpipe-go](https://github.com/evan-choi/pxpipe-go) — a Go port of pxpipe's core with a CLI wrapper, standalone proxy and embeddable library for Anthropic Messages and OpenAI Chat/Responses.

## License

MIT. See [LICENSE](LICENSE), which keeps pxpipe's original copyright notice as the license requires.
