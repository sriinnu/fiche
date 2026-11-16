# Architecture

inkling is a local proxy between a coding agent and its model API. It renders the
stale, bulky parts of each request as dense PNG pages of text, because providers
bill an image by its pixel area, not by how many characters are drawn on it.

A 1568×728 page bills at about 1,456 tokens on Anthropic and holds about 28k
characters of 5×8 glyphs. As text, those characters cost roughly 7k–19k tokens.
That gap is the whole product. Everything else makes it safe, cache-friendly and
measurable.

## System map

![inkling architecture](architecture/architecture.svg)

| Layer | Files | Job |
|---|---|---|
| Entry points | `src/node.ts`, `src/worker.ts`, `src/warp/`, `src/mcp/server.ts` | CLI and local server (port 47821), Cloudflare Worker build, the `warp` CONNECT proxy, MCP server |
| Proxy core | `src/core/proxy.ts`, `src/core/provider-router.ts` | Routing, credential classification, model-scope gate, forwarding, streaming, events |
| Wire transforms | `src/core/transform.ts` (Anthropic), `openai.ts` + `openai-history.ts` (Responses, Chat), `google.ts`, `history.ts`, `schema-strip.ts` | Find the static slab, the closed-tool history prefix, large tool results and reminders, and replace them with image blocks |
| Renderer | `src/core/render.ts`, `atlas*.ts`, `png.ts`, `factsheet.ts`, `vision-cost.ts`, `*-model-profiles.ts` | Text to grayscale PNG, one font and geometry profile per model family, plus the verbatim factsheet |
| Cache state | `src/core/session-state.ts`, `codex-cache.ts` | Keep old pages byte-identical so they stay in the prompt cache; repack only when no cache is live |
| Accounting | `src/core/baseline.ts`, `measurement.ts`, `tracker.ts`, `cpt-fit.ts`, `src/stats.ts`, `src/dashboard*.ts` | Cache-aware "without inkling" baseline, JSONL event log, fitted chars-per-token, dashboard |
| Extras | `src/core/pin.ts`, `messages-chat-bridge.ts`, `messages-responses-bridge.ts` | `@inkling pin`, and Anthropic-wire clients driving GPT or Chat Completions upstreams |

## One request

![One request through inkling](architecture/request-flow.svg)

- **Imaged:** the system prompt and tool-definition slab, the oldest prefix of
  closed tool sequences, and large tool results and `<system-reminder>` blocks.
- **Always text:** the live tail (`keepTail` turns), any open tool sequence, the
  latest assistant `tool_use` turn, and the current user turn.
- **Per block, image only when cheaper.** Image tokens come from pixel area; text
  tokens are `chars ÷ CPT`, with CPT fitted from logged events.
- **Factsheet.** Paths, SHAs, UUIDs, versions, flags and large numbers ride next
  to each image as plain text (about 96 tokens, deterministic), so the model never
  has to copy them off pixels.

## Cache stability

Most spend on long agent sessions is cache reads at 0.1× the input price, so
inkling never changes bytes it already sent:

- The history grid is append-only. A chunk's pixels depend only on its message
  range, so old pages are read from cache on every later turn.
- With no live cache, `packFill` repacks pages for density instead.
- The factsheet uses a fixed order and contains no timestamps or randomness.
- `prompt_cache_breakpoint` is removed for ChatGPT Codex, which rejects it.

## Which models get images

Images go only to models that read dense glyphs exactly: Gemini, Fable 5 (Fable
5.1 and 5.2 with +2px row spacing) and opt-in Sol. Claude 5.5 (Opus, Sonnet,
Haiku) and Grok understand rendered pages but misread single characters, so they
receive text. Measurements are in the README's model table and in `eval/`.

## Further reading

- [CACHING_AND_SAVINGS.md](CACHING_AND_SAVINGS.md): how the baseline is computed
- [HISTORY_CACHE_MODEL.md](HISTORY_CACHE_MODEL.md): the history grid and freeze rules
- [MODEL_RENDER_PROFILES.md](MODEL_RENDER_PROFILES.md): per-model fonts and geometry
- [SECURITY_MODEL.md](SECURITY_MODEL.md): credentials and routing
