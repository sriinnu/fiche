# Changelog

inkling follows [Semantic Versioning](https://semver.org/) (pre-1.0: minor =
features or behaviour changes, patch = fixes). Where the code comes from is in
the README's Credits section.

## 0.17.0

- Renamed to inkling everywhere, with no aliases for the old names. Commands
  are `inkling` and `inkling-mcp`. Environment variables are `INKLING_*`,
  headers are `x-inkling-*`, and state lives in `~/.inkling`. Rename an existing
  config, env file or state directory by hand.
- Hybrid pipeline: lossless PAKT L1–L3 (`@sriinnu/pakt@0.10.0`) on structured
  tool results, then images only for readers that can use them. Claude 5.5
  and Grok stay on PAKT text unless `INKLING_FORCE_IMAGES=1`.
- PAKT touches tool-result text only (Anthropic `tool_result`, Responses
  `function_call_output`, Chat `role: "tool"`, Gemini `functionResponse`).
  Tool-call arguments, `tool_use.input`, thinking blocks, tool definitions,
  metadata, system prompts and conversation text are never rewritten.
- PAKT runs only for in-scope models and respects `compress: false`.
  `INKLING_PAKT=off` turns the PAKT stage off on its own.
- Each tool result is packed or left alone on its own merits, and the legend
  rides in front of the first packed tool result instead of the system prompt.
  A later turn can no longer rewrite an earlier one and bust the prompt cache.
- The round-trip guard refuses JSON that `JSON.parse` cannot keep exactly
  (integers past 2^53, non-canonical numbers, duplicate keys). The proxy does
  not reserialize such a request at all. CSV is no longer offered: PAKT
  0.10.0's CSV decompress does not round-trip.
- ChatGPT Codex (`chatgpt.com`, `/backend-api/codex/responses`) no longer
  receives `prompt_cache_breakpoint`. api.openai.com still does when the
  profile asks. `INKLING_GPT_PROFILES` `cacheBreakpoints: false` is honoured.
  The scrub is a text edit of the injected object only, so large integers and
  a tool-schema property named `prompt_cache_breakpoint` survive.
- MCP server (`inkling mcp`, also `inkling-mcp`) over stdio and stateless
  Streamable HTTP. Tools: `compress_text`, `inspect_savings`,
  `transform_request`, `health`, `stats`. Stdio `Content-Length` frames are
  counted in UTF-8 bytes.
- PAKT-only reader matching covers `claude-opus-5.5`, Vertex
  `claude-opus-5-5@…` and `x-ai.grok-…` spellings.
