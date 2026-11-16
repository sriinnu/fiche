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
- Architecture write-up and diagrams in `docs/ARCHITECTURE.md`.
- MCP server (`inkling mcp`, also `inkling-mcp`) over stdio and stateless
  Streamable HTTP. Tools: `check_model`, `transform_request`, `health`,
  `stats`. Stdio `Content-Length` frames are counted in UTF-8 bytes.
- Text-only reader matching covers `claude-opus-5.5`, Vertex
  `claude-opus-5-5@…` and `x-ai.grok-…` spellings.
