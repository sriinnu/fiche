# Changelog

inkling follows [Semantic Versioning](https://semver.org/) (pre-1.0: minor =
features or behaviour changes, patch = fixes). Where the code comes from is in
the README's Credits section.

## 0.17.0

- Renamed to inkling everywhere, with no aliases for the old names. Commands
  are `inkling` and `inkling-mcp`. Environment variables are `INKLING_*`,
  headers are `x-inkling-*`, and state lives in `~/.inkling`. Rename an existing
  config, env file or state directory by hand.
- Images only for readers that can read them (Gemini, Fable 5.x, opt-in
  Sol). Claude 5.5 (Opus, Sonnet, Haiku), Grok and unmeasured Gemini 4
  models (hydrogen, carbon) pass through byte-for-byte unless
  `INKLING_FORCE_IMAGES=1`. Opus 5.5 left the default scope, which is now
  `claude-fable-5,gemini`.
- PAKT is gone. On real agent traffic it saved about 0.015% of tokens and
  cost CPU time on every request. `INKLING_PAKT`, the `compress_text` and
  `inspect_savings` MCP tools and the `@sriinnu/pakt` dependency are removed.
- ChatGPT Codex (`chatgpt.com`, `/backend-api/codex/responses`) no longer
  receives `prompt_cache_breakpoint`. api.openai.com still does when the
  profile asks. `INKLING_GPT_PROFILES` `cacheBreakpoints: false` is honoured.
  The scrub is a text edit of the injected object only, so large integers and
  a tool-schema property named `prompt_cache_breakpoint` survive.
- Fail open: when a transform throws, the request is forwarded as it
  arrived instead of failing with 502. The event row's reason reads
  `transform_error_fail_open: …`. Wire-bridge errors still answer 400/502,
  because the upstream cannot read an unbridged body.
- The proxy API refuses browser requests from non-loopback pages (403) and
  public-DNS `Host` names other than known provider hosts (421), so a web
  page cannot spend configured keys through cross-site requests or DNS
  rebinding. `INKLING_ALLOWED_HOSTS` adds names; `*` turns the check off.
- Routing is default-deny. Every `/backend-api/` path goes to the ChatGPT
  upstream. Before, Codex's `/backend-api/codex/responses/compact` went to
  api.anthropic.com with the Anthropic credential in place of the ChatGPT
  bearer. Google countTokens and listing paths go to Google. On the stock
  Anthropic upstream, paths outside `/v1/*` and `/api/*` answer 404.
- Architecture write-up and diagrams in `docs/ARCHITECTURE.md`.
- MCP server (`inkling mcp`, also `inkling-mcp`) over stdio and stateless
  Streamable HTTP. Tools: `check_model`, `transform_request`, `health`,
  `stats`. Stdio `Content-Length` frames are counted in UTF-8 bytes.
- Text-only reader matching covers `claude-opus-5.5`, Vertex
  `claude-opus-5-5@…` and `x-ai.grok-…` spellings.
- Follow the agent: a request for a registered compat host (DeepSeek, Kimi,
  z.ai, MiniMax, DashScope, OpenRouter, xAI, plus `INKLING_UPSTREAM_HOSTS`)
  goes to that host with only the agent's own credential. https on 443 only,
  no IPs or local names, redirects handled manually. An unfollowed compat
  Host gets 421 and is never re-routed to Anthropic. `INKLING_FOLLOW_HOSTS=0`
  turns it off.
- Codex: only leading system/developer items enter the GPT static slab, user
  messages stay native, and history runs seal at a user message, so late
  images never land high in the cached prefix. WebSocket upgrades get 426 so
  Codex falls back to HTTP. gzip/deflate/br/zstd request bodies are decoded
  with a size limit; a body inkling can't decode is never rewritten.
- No `prompt_cache_breakpoint` on any `/backend-api/codex/` path, including
  `/responses/compact`.
- Savings accounting: the text baseline's warmth window follows the cache
  tier the session writes (3600 s after a 1h-tier write, else 300 s). The gate
  and the savings math price from one resolver.
- `INKLING_PRICES=kosha` (opt-in) prices from a build-time table of
  first-party rows in a kosha registry snapshot (`pnpm prices:gen`,
  `pnpm prices:check`). Unpriced models pass through, and dashboard dollars
  use each model's own input price, with unpriced rows counted apart.
- `inkling-mcp` reports its name as `inkling-mcp`, answers a notification sent
  with an id, caps a buffered stdio message at 8 MiB, and also listens on
  `::1`. Installs from git with `npx --yes --package github:sriinnu/inkling
  inkling-mcp`; `prepare` builds `dist/`. Claude Code plugin and marketplace
  manifests in `.claude-plugin/`.
- Logo and README header.
