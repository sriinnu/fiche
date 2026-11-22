# Changelog

`@sriinnu/fiche` (`fiche`) follows [Semantic Versioning](https://semver.org/) (pre-1.0: minor =
features or behaviour changes, patch = fixes). Where the code comes from is in
the README's Credits section.

## 0.18.0

- **Restart-proof analytics & Tokmeter-style telemetry**: `DashboardState.replay()` restores lifetime, 90-day local-date (`YYYY-MM-DD`), per-model, and active-session accumulators across daemon restarts from `~/.fiche/events.jsonl` and `.1` using a bounded 50-row tail ring buffer, finite numeric validation, and `/fragments/analytics` with interactive 14-day `Tokens`/`USD` bar charts and proportional per-model breakdowns.
- **Native `FicheBar.app` v0.18.0 (`Agents` tab + live attachment status)**:
  - `Lifetime` / `Today` hero switcher with weighted + raw subtitles, 14-day `DailySavingsChartView` (`Tokens`/`USD` toggle + hover readout), and proportional `By Model` bars.
  - Universal `Agents` tab discovering installed Desktop Apps (`Antigravity`, `Antigravity IDE`, `Cursor`, `Claude`, `Windsurf`, `Zed`, `OpenCode`, `ChatGPT (Codex)`, `Codex`, `Runic`) and Coding CLIs (`claude`, `codex`, `agy`, `gemini`, `opencode`, `cursor-agent`, `amp`, `pi`, `aider`) with live process-tree attachment indicators (`Attached`, `Running direct`, `Stopped`, `N attached` / `N direct`), safe shell RC auto-wrap installer (`~/.zshrc`, `$ZDOTDIR`, `~/.bashrc`), and built-in FAQ.
- **Core, Warp, Bridge & FileTracker hardening (Carbon Audit Wave 2)**:
  - Fixed `collapseHistory` adaptive post-render image budget enforcement + bounded density re-budget, `userTurnBlocks` profile render options, `FACTSHEET_PAGE_CHARS` export & repeat tally, OpenAI/Google pin relocation guards, `isFileReadToolName` compound namespaces, `CODE_DECL_LINE_RE` ReDoS guard, and `FileTracker` active-rewrite buffering with atomic cleanup.
  - Hardened `fiche warp` CA/TLS (RFC 5280 SKI/AKI/SPKI, SNI validation, per-CONNECT 30s handshake timeout, strict route path normalization, ChatGPT/Codex `app.asar` + Electron proxy flags, and `FICHE_BYPASS=1` shell-wrapper flow) and Responses/Chat bridge `reasoning`/`stop_reason`/fragmented SSE sniffing.

## 0.17.0

- Rebranded from `@sriinnu/inkling` to **`@sriinnu/fiche`** (`fiche` and
  `fiche-mcp` commands, `FICHE_*` environment variables, `x-fiche-*` headers,
  `~/.fiche` and `~/.config/fiche/config.json` state paths, `@fiche pin`), with
  full backwards-compatible runtime fallbacks for legacy `INKLING_*`,
  `x-inkling-*`, `~/.inkling`, `~/.config/inkling/config.json`, `@inkling pin`,
  and `@deprecated` `Inkling*` TypeScript SDK aliases.
- 4-layer deterministic text compiler (`src/core/text-hygiene.ts`,
  `schema-compiler.ts`, `toon.ts`, `text-history.ts`, `casi-delta.ts`) for
  text-tier models and textual blocks:
  `TSCG` schema/static compiler → terminal ANSI/CR/backspace hygiene + bijective
  `@toon` columnar encoding + `Drain` log folding (guarded by
  `isCodeOrDiffProtected` so source reads & diffs stay byte-exact) → `ACDC`
  frozen-epoch digestion → `CASI-Delta` cross-turn line hashing.
- Optical microfiche rendering (`Spleen 5×8` + `GNU Unifont` fallback, plus
  `JetBrains Mono` 10/12/14px profiles) only for strong/verified vision readers
  (`claude-fable-5`, measured `gemini` vision tiers, opt-in `gpt-5.6-sol` /
  `gpt-6.x-sol` / `grok-*` / `qwen3.8-27b`). Text-only readers (`claude-opus-5-5`,
  `claude-sonnet-5-5`, `claude-haiku-*`, `gpt-6*-astra`,
  `gemini-4-neon/carbon/hydrogen`, `deepseek`, `kimi`, `glm`, `minimax`, `grok`)
  pass through with zero images unless `FICHE_FORCE_IMAGES=1`. Default scope is
  `claude-fable-5,gemini`.
- Zero-token telemetry & plugins: `fiche turn-report`, `fiche stats`,
  downstream `x-fiche-saved-tokens` / `x-fiche-stages` /
  `x-fiche-cliff-saved-usd` headers, `plugins/fiche-telemetry/` (Antigravity
  `PostInvocation` hook + Claude Code `statusLine`), and interactive browser
  playground & subsite ([fiche.srinivas.dev](https://fiche.srinivas.dev)).
- Offline proxy-free export (`fiche export` for files/dirs, `--git`, `--diff`,
  `--stdin`) emitting `page-*.png`, `factsheet.txt`, `prompt.txt`, and
  `manifest.json`.
- PAKT is gone. On real agent traffic it saved about 0.015% of tokens and
  cost CPU time on every request. The old PAKT toggle, the `compress_text` and
  `inspect_savings` MCP tools, and the `@sriinnu/pakt` dependency are removed.
- ChatGPT Codex (`chatgpt.com`, `/backend-api/codex/responses` and
  `/responses/compact`) no longer receives `prompt_cache_breakpoint`.
  `api.openai.com` still does when the profile asks. `FICHE_GPT_PROFILES`
  `cacheBreakpoints: false` is honoured. The scrub is a text edit of the
  injected object only, so large integers and a tool-schema property named
  `prompt_cache_breakpoint` survive.
- Fail open: when a transform throws, the request is forwarded as it
  arrived instead of failing with 502. The event row's reason reads
  `transform_error_fail_open: …`. Wire-bridge errors still answer 400/502,
  because the upstream cannot read an unbridged body.
- The proxy API refuses browser requests from non-loopback pages (403) and
  public-DNS `Host` names other than known provider hosts (421), so a web
  page cannot spend configured keys through cross-site requests or DNS
  rebinding. `FICHE_ALLOWED_HOSTS` adds names; `*` turns the check off.
- Routing is default-deny. Every `/backend-api/` path goes to the ChatGPT
  upstream. Google `countTokens` and listing paths go to Google. On the stock
  Anthropic upstream, paths outside `/v1/*` and `/api/*` answer 404.
- Architecture write-up, diagrams, and technical handbook in
  `docs/ARCHITECTURE.md` and `wiki/`.
- MCP server (`fiche mcp`, also `fiche-mcp`) over stdio and stateless
  Streamable HTTP. Tools: `check_model`, `transform_request`, `health`,
  `stats`. Stdio `Content-Length` frames are counted in UTF-8 bytes, buffers are
  capped at 8 MiB, and HTTP also listens on `::1`. Installs from git with
  `npx --yes --package github:sriinnu/fiche fiche-mcp`; `prepare` builds
  `dist/`. Claude Code plugin and marketplace manifests in `.claude-plugin/`.
- Text-only reader matching covers `claude-opus-5.5`, Vertex
  `claude-opus-5-5@…`, `x-ai.grok-…`, `gpt-6*-astra`, `deepseek`, `kimi`,
  `glm`, and `minimax` spellings.
- Follow the agent: a request for a registered compat host (DeepSeek, Kimi,
  z.ai, MiniMax, DashScope, OpenRouter, xAI, plus `FICHE_UPSTREAM_HOSTS`)
  goes to that host with only the agent's own credential. `https` on 443 only,
  no IPs or local names, redirects handled manually. An unfollowed compat
  `Host` gets 421 and is never re-routed to Anthropic. `FICHE_FOLLOW_HOSTS=0`
  turns it off.
- Codex: only leading system/developer items enter the GPT static slab, user
  messages stay native, and history runs seal at a user message, so late
  images never land high in the cached prefix. WebSocket upgrades get 426 so
  Codex falls back to HTTP. gzip/deflate/br/zstd request bodies are decoded
  with a size limit; a body `fiche` can't decode is never rewritten.
- Savings accounting: the text baseline's warmth window follows the cache
  tier the session writes (3600 s after a 1h-tier write, else 300 s). The gate
  and the savings math price from one resolver.
- `FICHE_PRICES=kosha` (opt-in) prices from a build-time table of
  first-party rows in a kosha registry snapshot (`pnpm prices:gen`,
  `pnpm prices:check`). Unpriced models pass through, and dashboard dollars
  use each model's own input price, with unpriced rows counted apart.
- Logo, README header, and bundled font license notices (`assets/*_LICENSE.txt`
  and Docker `/app/licenses/`).
- Native macOS **`FicheBar.app`** (`apps/macos-bar/`): Apple HIG redesign with 5
  themes (`Editorial`, `Native`, `Slate`, `Terminal`, `Midnight`),
  `HeroCompressionRatioBar`, weighted-vs-raw savings clarity, 1-click
  third-party model & plugin toggles, Desktop App Proxy launcher, taller
  popover (`540px` scroll budget), and About & Sponsor window.
- Redesigned loopback web dashboard (`http://127.0.0.1:47821`) with Editorial
  Warm Paper typography, `/fragments/plugins` live panel, and
  `POST /api/plugins { scope: "third-party" }` one-click disable.
- Universal provider & client coverage: 23-host `COMPAT` upstream registry
  (`src/core/upstream-hosts.ts`), Google `/v1internal:*` text hygiene on
  non-Gemini models, `functionResponse.parts[].text` hygiene, macOS GUI desktop
  app interception (`fiche warp --app <Name|Path>`), and shell integration
  (`fiche shell-init [--wrap]`).
- Added [PRIVACY.md](./PRIVACY.md), GitHub Sponsor links, and Mermaid
  architecture/sequence diagrams in [wiki/Architecture.md](./wiki/Architecture.md).
