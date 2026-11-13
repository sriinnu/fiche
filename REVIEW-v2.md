# Inkling review v2

The body below is the review of `151227d`, before the fixes. The [remediation](#remediation) section is what changed after it, with before and after numbers.

Independent review of `pxpipe-fork` 0.17.0-fork.1 (`151227d` on `main`). The fork imports teamchong/pxpipe v0.16.0 (`9e0e0e99`) and adds `@sriinnu/pakt@0.10.0` plus an MCP server. `REVIEW.md` was treated as a list of claims to check, not as evidence. Line numbers are from this tree before the fixes that follow this review.

No provider API was called. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, and `GROK_API_KEY` were unset, and there is no `~/.pxpipe/config.json`. Every token figure below is an estimate. Text tokens are `@sriinnu/pakt` `countTokens`. That function uses `o200k_base` only when `getModelEncoding` recognizes the id (`gpt-4o` did). `claude-*`, `gemini-*`, `grok-*`, and `gpt-5.6-sol` returned no encoding and fell through to `cl100k_base`. Image tokens are `visionTokens()` on the rendered page sizes in `src/core/vision-cost.ts`. They are not Anthropic, OpenAI, Google, or xAI usage fields. `REVIEW.md`'s statement that these counts are o200k is not true for the model ids the fork actually routes.

## Executive verdict

Inkling is not yet a strict improvement on upstream pxpipe 0.16.0, and it is not safe as the daily proxy in front of Claude Code's default Opus 5.5.

The identity, Host-header, and "absent `prompt_cache_breakpoint`" fixes described in `REVIEW.md` are real and still present. The open problems are also real, and one of them is worse than that write-up: a PAKT hit can make a strong reader more expensive than upstream imaging, and the Docker image does not start. On code and prose, Opus 5.5, Sonnet 5.5, Haiku 5.5, and Grok stay on raw text while an image of the same body is far cheaper. Sonnet, Haiku, and Grok are not in upstream's default allowlist, so leaving them as text matches upstream until someone opts them in. Opus 5.5 is in the default allowlist. Upstream images it. This fork does not, unless `PXPIPE_FORCE_IMAGES=1`. That is a daily-use regression on the model Claude Code sends by default.

The MCP server does speak newline-delimited JSON-RPC and a loopback HTTP check. Installing it does not reduce the bill. The tool list is about 925 `cl100k` tokens on every later turn, and calling `compress_text` or `transform_request` puts the original text in the tool arguments and the packed text back in the tool result. The proxy is the only path that can remove tokens before the provider sees them. There is no Claude Code plugin manifest, no Cursor install link, and `npx -y pxpipe-fork` 404s. The npm name `inkling` is an unrelated package (`inkling@0.2.1`, lit-html styles).

## What was run

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0, 170 packages, pnpm 10.21.0, Node 22.23.4 |
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm test` | 94 files, 1367 tests, all passed, 25.94s |
| `pnpm run build` | exit 0, `node dist/node.js --version` prints `0.17.0-fork.1` |
| `pnpm exec tsx scripts/measure-hybrid.mts` | reproduced `REVIEW.md` to the token |
| stdio probe | `tsx src/node.ts mcp`, initialize / tools/list / compress_text / ping |
| Docker-shaped start | `node` on a copy of `dist/node.js` with no `node_modules` |

`vitest.config.ts` documents a real historical flake: the append-only cache-stability test was about 30s of CPU and timed out when another file shared the pool. The timeout is now 60s. This run did not flake. That does not make the test a good signal under load.

The suite does not cover the failures below. `tests/review-fixes.test.ts` locks the Opus 5.5 image refusal in as intended (`shouldImageModel('claude-opus-5-5', true)` is `false`). `tests/hybrid-pakt.test.ts` requires Fable to image the already-packed text and to beat an image of the original. Those tests pass because the code does that, not because the result is cheaper than upstream on a realistic body or safe for the cache.

## Previous review, claim by claim

| Claim in `REVIEW.md` | This review |
| --- | --- |
| Legend is appended, not unshifted in front of the Claude Code identity | True. `insertLegend` in `src/core/hybrid.ts` pushes a system block or appends to a string. It does not unshift. The identity test still passes. Appending into `system` is still inside the cached prefix. See H2. |
| Codex bodies with no `prompt_cache_breakpoint` are returned unchanged | True. `scrubPromptCacheBreakpoint` returns the same `Uint8Array` when the key is absent (`src/core/codex-cache.ts` lines 44–46). A planted key is still removed by `JSON.parse` + `JSON.stringify`, which drops the caller's whitespace. See M5. |
| `Content-Length:` inside a JSON line does not flip stdio framing | True. Framing is only when the buffer starts with `Content-Length:` (`src/mcp/server.ts` lines 277–279). |
| HTTP MCP checks Host, Origin, and an 8 MiB body cap | True for HTTP. Stdio lines are not capped. See M4. |
| Opus 5.5 is listed and then not imaged | True. See H1. The numbers in `REVIEW.md` for the mixed prose fixture reproduce exactly (Sonnet 3660 raw, 1130 imaged, 3660 hybrid). |
| A PAKT hit re-stringifies the whole body | True, and it is not limited to whitespace. The legend is written into `system`, which this codebase already treats as inside the cached prefix. See H2. |
| Mixed prose + TypeScript loses to imaging for Sonnet and Grok | True versus a forced `transformRequest`. It is not a regression versus upstream's default proxy, because Sonnet and Grok are not in `DEFAULT_MODEL_BASES`. Opus 5.5 is, and it loses the same way. See H1 and the table. |
| Codex breakpoint policy is correct | The documented route is correct: `/backend-api/codex/responses` and any `chatgpt.com` host do not receive the field, and `api.openai.com` `/v1/responses` still does when the profile asks. A path such as `/backend-api/codex/responses/compact` is still treated as capable when the configured upstream host is not `chatgpt.com`. See M5. |
| Proxy and MCP image rules differ | True. `shouldImageModel` is allowlist plus the PAKT veto. `hybridTransform` images whenever `readerTier` is `image`, with no allowlist check. `gemini-2.5-pro` is refused by the proxy (`isMisresolvedModelId`, no measured profile) and imaged by `hybridTransform`. See M1. |
| L4 skips the round-trip | True. `src/core/pakt-stage.ts` lines 217–228 return `fromPacked` without `roundTrips`. A probe with `semanticBudget: 50` applied the pack and reported `reversible: false`. A decompress that throws is not rejected. |
| Savings table (Fable 564 / 96.8%, Sonnet 939, Grok 936 on 360 monotonic rows) | Reproduced exactly by `scripts/measure-hybrid.mts`. That fixture is the favorable one: the system string is long, the tool result is monotonic JSON, and Fable then images the packed text (1 page, 336 image tokens, 564 billable). It is not what a Claude Code request with tools and `cache_control` does. On that shape, PAKT text costs more than imaging. See H3. |
| Sol agent session images at a loss (2214 vs 2123, +4.3%) | Reproduced. The profitability gate let it through. `hybridTransform` images Sol even though Sol is not in the default allowlist. |

## Per-client verdict

"Upstream" means pxpipe 0.16.0's proxy: image if the model is in `PXPIPE_MODELS` (default `claude-fable-5`, `claude-opus-5-5`, `gemini`) and the existing profitability gate says yes. "Images" below is `transformRequest` / `transformOpenAIResponses` with no PAKT, which is that renderer even when the proxy would not have called it. "Hybrid" is `hybridTransform` as the fork ships it.

Estimates, not API usage. The measure-hybrid rows are the script's own fixtures. The "realistic" rows add a Claude Code identity block, `cache_control`, a tool schema, and the payload.

| Client | Verdict | Evidence | Daily use |
| --- | --- | --- | --- |
| Claude Code on Opus 5.5 | Regresses | Default allowlist includes it (`src/core/applicability.ts` line 55). `shouldImageModel('claude-opus-5-5', true)` is false (`src/core/reader-tier.ts` lines 35–63). Mixed prose, measure-hybrid shape: raw 3660, images 1130, hybrid 3660. Realistic large TypeScript: raw 11413, images 2753, hybrid 11413. Realistic monotonic JSON: raw 9780, images 3257, hybrid 4297. | No. `PXPIPE_FORCE_IMAGES=1` restores images and also restores upstream's weak dense-hex reading. It does not fix the cache rewrite. |
| Claude Code on Sonnet 5.5 | Neutral versus upstream, worse than imaging | Not in the default allowlist, so upstream already passes code through. Hybrid matches that on code (raw 3660, hybrid 3660, forced images 1130, +2530 versus images). Monotonic JSON in the favorable fixture: 17708 → 939. The same JSON inside a request with tools: 9781 → 4298, and forced images were 3258, so PAKT lost to imaging there too. | Safe as "do no harm versus upstream" on code. Not a strict improvement. Opting Sonnet into `PXPIPE_MODELS` still does not image it unless `PXPIPE_FORCE_IMAGES=1` (`shouldImageModel('claude-sonnet-5-5', true)` is false). That opt-in regresses versus upstream. |
| Claude Code on Haiku 5.5 | Same as Sonnet | Realistic large TypeScript: raw 11414, images 2754, hybrid 11414. The veto is the same 5.5 pattern. A second regex matches every `claude-haiku` id, including `claude-haiku-4-5`. | Same as Sonnet. |
| Claude Code / API on Fable 5 | Mixed, not strict | Code ties upstream (measure-hybrid 3657 → 959, both imaged). Favorable JSON: hybrid 564 versus images 3875, because the packed log was itself imaged. Realistic JSON with tools and `cache_control`: hybrid 4295 versus images 2863. PAKT shrank the tool result under `minCompressChars` (1345 < 2000), the image gate skipped, and the fork billed more than upstream. | Do not replace a working Fable proxy with this until the cost check exists. The 96.8% figure is one fixture, and that path images PAKT notation. |
| Codex (Responses, `chatgpt.com`) | Breakpoint fix holds; savings do not | Absent breakpoint: same bytes. Path `/backend-api/codex/responses` and host `chatgpt.com` return `supportsExplicitPromptCacheBreakpoint === false`. `api.openai.com` `/v1/responses` still injects for Sol when the profile's `cacheBreakpoints` is true. Realistic Codex-shaped JSON: raw 5929, images 5929 (gate declined), hybrid 2771 via PAKT, then the whole document is re-stringified. Sol is imaged by `hybridTransform` even when it is not allowlisted. On the short agent session, that image costs 2214 versus raw 2123. | The 400 from `prompt_cache_breakpoint` is fixed for the route in the README. Do not turn Sol imaging on for short sessions, and do not treat a PAKT hit as cache-safe. |
| Gemini | Measured ids follow Fable; unknown ids split | `gemini-3.6-flash` and `gemini-4` are allowlisted and `shouldImageModel` is true. `gemini-2.5-pro` is not measured (`hasGeminiMeasuredProfile` is false for major < 3), so the proxy refuses it, and `hybridTransform` still imaged it in the bench (`allowlisted: false`, `imaged: true`). | The proxy path is the upstream Gemini path, plus the H3 pre-pass. The MCP `transform_request` path will image an unmeasured Gemini id the proxy would have skipped. |
| Grok 4.7 | Neutral by default, opt-in regresses | Not in the default allowlist. Code stays raw (large TypeScript 11411 versus forced images 4776). Favorable JSON: 17705 → 936 with no images. Agent session: forced images 2218 versus raw 2071, so refusing images was the better trade, and upstream would also have refused unless Grok was named. Naming `grok-4.7` in `PXPIPE_MODELS` still does not image (`shouldImageModel(..., true)` is false) until `PXPIPE_FORCE_IMAGES=1`. | Safe as a default. The README's opt-in example does not do what upstream does. |
| Cursor, Claude Code, Codex, Gemini CLI, Grok via MCP | Server works; the bill does not go down | Stdio probe below. Tool schemas are ~925 `cl100k` tokens. A 30-row JSON log compressed 855 tokens in the tool result and still left the original argument in the transcript. | Do not install this expecting the model to save tokens by calling the tools. Use the proxy for that, after the cost check. |

## Benchmark detail

### Favorable fixture, reproduced

`pnpm exec tsx scripts/measure-hybrid.mts`. 360 monotonic JSON rows, system prompt is a repeated sentence, no `cache_control`. Estimates.

| Path | Billable | Versus raw |
| --- | ---: | ---: |
| Raw, Fable id | 17705 | |
| Images only, Fable | 3875 (4 pages) | 78.1% fewer |
| Hybrid, Fable | 564 (1 page of the packed text) | 96.8% fewer |
| Hybrid, Sonnet 5.5 | 939, not imaged | 94.7% fewer |
| Hybrid, Grok 4.7 | 936, not imaged | 94.7% fewer |

Mixed prose + 80 TypeScript functions, same script:

| Model | Raw | Images only | Hybrid |
| --- | ---: | ---: | ---: |
| Fable 5 | 3657 | 959 | 959, tie |
| Sonnet 5.5 | 3660 | 1130 | 3660, +2530 versus images |
| Grok 4.7 | 3657 | 2157 | 3657, +1500 versus images |

Agent session, same script. The log's status flips between 200 and 500, the round-trip guard refuses it, `paktBlocks` is 0:

| Model | Raw | Images only | Hybrid |
| --- | ---: | ---: | ---: |
| Fable 5 | 2071 | 1658 | 1658, tie |
| Sonnet 5.5 | 2149 | 1848 | 2149, +301 versus images |
| Grok 4.7 | 2071 | 2218 | 2071, 147 cheaper than a bad image |
| Sol 5.6 | 2123 | 2214 | 2214, both 4.3% over raw |

### Realistic request

Identity block, `cache_control` on that block, one tool schema, then the payload. Same estimators.

| Fixture | Model | Raw | Images | Hybrid | PAKT blocks |
| --- | --- | ---: | ---: | ---: | ---: |
| Monotonic JSON, 200 rows | Opus 5.5 | 9780 | 3257 | 4297 | 1 |
| Monotonic JSON, 200 rows | Fable 5 | 9778 | 2863 | 4295 | 1 |
| Monotonic JSON, 200 rows | Grok 4.7 | 9778 | 6017 | 4295 | 1 |
| Large TypeScript, 200 functions | Opus 5.5 | 11413 | 2753 | 11413 | 0 |
| Large TypeScript, 200 functions | Sonnet 5.5 | 11414 | 2754 | 11414 | 0 |
| Large TypeScript, 200 functions | Fable 5 | 11411 | 2303 | 2303 | 0 |
| Large TypeScript, 200 functions | Grok 4.7 | 11411 | 4776 | 11411 | 0 |
| Eight tool rounds, non-monotonic JSON | Opus 5.5 | 4274 | 3553 | 4274 | 0 |
| Codex Responses, monotonic JSON | Sol 5.6 | 5929 | 5929 | 2771 | 1 |
| YAML routes | Opus 5.5 | 2597 | 2597 | 1474 | 1 |
| CSV, 80 rows | Opus 5.5 | 2464 | 2464 | 2464 | 0 |
| Repeated prose | Opus 5.5 | 3295 | 1694 | 3295 | 0 |
| Repeated prose | Fable 5 | 3293 | 1524 | 1524 | 0 |

CSV of 1437 characters came back from `packStructured` as null (fail closed). Plain prose is not structured, so PAKT correctly skips it and the weak-reader path then saves nothing. YAML did pack and `decompress` matched the original text on a similar sample.

A pretty-printed body whose first system block carries `cache_control` does not keep its prefix. Input began `{\n  "model":`. After `prepassRequest` it began `{"model":`. The bytes through the marker differed. A body that was already `JSON.stringify` output can keep the bytes before the first `"cache_control"` key, because the mutation sits later. Claude Code does not promise `JSON.stringify` bytes, and the legend is still inserted into `system`.

## Routing as it actually behaves

| Model | Default allowlist | Proxy images | `hybridTransform` / MCP images |
| --- | --- | --- | --- |
| `claude-fable-5` and 5.1 / 5.2 | yes | yes | yes |
| `gemini-3.6-flash`, `gemini-4`, other measured Gemini ids | yes (`gemini` prefix) | yes | yes |
| `gemini-2.5-pro` and other unmeasured Gemini ids | no (`isMisresolvedModelId`) | no | yes |
| `claude-opus-5-5`, Sonnet 5.5, Haiku 5.5 | Opus yes, others no | no, unless named and `PXPIPE_FORCE_IMAGES=1` | no, unless `forceImages: true` |
| `claude-haiku-4-5` and any other `claude-haiku*` | no | no, even if named, unless force | no |
| `claude-opus-5` | no | yes, once named | no (`readerTier` is `pakt-text`) |
| `grok-4.5` / `4.6` / `4.7` | no | no, unless named and force | no, unless `forceImages: true` |
| `gpt-5.6-sol`, `gpt-6.1-sol` | no | yes, once named | yes, even when not named |
| `gpt-6-astra` and other GPT ids | no | yes, once named | no |

`PXPIPE_FORCE_IMAGES` removes the veto. It does not add a model to the allowlist. It does not put `prompt_cache_breakpoint` back on chatgpt.com. Streaming responses are not rewritten. The proxy tees the upstream body for usage and error capture (`src/core/proxy.ts` `teeForUsage`, around line 881) and forwards it. Malformed JSON is left alone. `tool_use` argument objects are not packed unless a nested string is itself long structured text.

## MCP server

### What actually starts

`pnpm exec tsx src/node.ts mcp` speaks stdio. A probe sent `initialize` at protocol `2025-06-18`, `notifications/initialized`, `tools/list`, `compress_text`, and `ping`. Stderr was empty. Four responses came back, matched by id, not by order (`ping` returned before the slower compress). The negotiated version was `2025-06-18`. The tool names were `compress_text`, `inspect_savings`, `transform_request`, `health`, `stats`. A 30-row monotonic JSON log compressed, `reversible` was true, `decompress(..., 'json')` equaled the input, and the result reported 855 tokens saved. `compress_text` with no `text` and an unknown tool name both returned `isError: true` inside a JSON-RPC result, which is what the tool-call spec wants. `resources/list` returned `-32601`, which is correct because the server does not advertise resources.

`bin/mcp.js` only works after `pnpm build`. It imports `dist/node.js`. `dist/` is gitignored. There is no `prepare` script, so `npm install github:sriinnu/inkling` does not build the file the bin loads.

HTTP `POST /mcp` on `127.0.0.1` answered `health` in tests. `GET` is 405. A non-loopback `Host` or `Origin` is 403. Bodies over 8 MiB are 413. That matches Claude Code, Codex, Cursor, and Gemini CLI as long as they speak newline JSON or a single JSON POST. It does not listen on `::1` (`src/mcp/server.ts` line 441), so a client that resolves `localhost` to IPv6 only will fail.

### Schemas versus what hosts expect

Each tool has `inputSchema` (draft 2020-12, `type: object`, `additionalProperties: false`) and the four annotations. That is the shape Claude Code, Codex CLI, Cursor, Gemini CLI (`mcpServers` in `~/.gemini/settings.json`), and Grok CLI (`[mcp_servers.*]` in `~/.grok/config.toml`) accept for stdio. There is no `outputSchema`. `structuredContent` is still returned. Clients that only read `content[].text` are fine, because the same JSON is in the text block. Clients that ignore `structuredContent` without an output schema lose nothing.

Annotations say `idempotentHint: true` for every tool, including `stats`, which increments counters. `readOnlyHint: true` is fair for the payload (nothing is written, nothing is sent) and slightly wrong for `stats`. Extra arguments are not rejected at runtime even though the schema says `additionalProperties: false`.

`notifications/initialized` with an `id` returns `null` (`src/mcp/server.ts` line 243). Spec-correct notifications have no id. A client that set one and then waits will hang.

### Lossless, errors, large inputs

Lossless L1–L3 is a real round-trip for JSON (canonical value) and a string compare for YAML and CSV (`src/core/pakt-stage.ts` lines 85–96). The probe's YAML sample matched `decompress` exactly. Cyclic integer columns are refused, which is why the agent-session log and the eight-round transcript packed zero blocks. That refusal is the right failure. It also means a lot of real tool JSON will not pack.

L4 (`lossy: true` and `semanticBudget > 0`) does not call `roundTrips`. The proxy never sets that. The MCP tool will, if the caller asks.

HTTP bodies and `Content-Length` frames stop at 8 MiB. One newline-delimited line does not (`pushMcpChunk`). A local stdio client can grow the buffer without a newline. The `text.length > MCP_MAX_BYTES` check inside `compress_text` runs only after `JSON.parse`.

### Calling the tools does not save tokens

The tool definitions alone were 3850 characters and 925 `cl100k` tokens. Once the server is connected, that schema sits in the cached tool prefix of every later turn (about 0.1x after the first write, 1.25x on the write, and a full miss if the schema changes).

`compress_text` cannot remove the argument the model just sent. On the 30-row probe the result was 667 characters and 855 tokens smaller than the argument, and the transcript then contained both. Net for that turn is positive cost: argument + result + the tool-call wrapper. `transform_request` is worse. It returns the rewritten request, including base64 page payloads when the tier images, as text the model has to read. `inspect_savings`, `health`, and `stats` are the only calls that stay small, and they still add a round trip.

The Ribhu example in the README tells the model to "compress structured context before answering." That is the expensive direction. A client harness that calls the tool itself and substitutes the result before the model sees the original can save tokens. None of Claude Code, Codex, Cursor, Gemini CLI, or Grok work that way. They all let the model call the tool and then append the result.

### Per host

| Host | Config the host actually reads | This repo | Verdict |
| --- | --- | --- | --- |
| Claude Code | `.mcp.json` `mcpServers`, or a plugin `.claude-plugin/plugin.json` plus `.mcp.json`, with `${CLAUDE_PLUGIN_ROOT}` | README shows a hand-written `node <checkout>/dist/node.js mcp`. No `plugin.json`, no marketplace manifest. `.claude/` is gitignored, which is correct for local notes and is not a plugin. | Stdio works after a local build. Not installable as a plugin. |
| Claude Desktop | `claude_desktop_config.json` `mcpServers` | Same command/args shape as Claude Code. Accurate, and still a manual path. | Works after a local build. |
| Codex CLI | `~/.codex/config.toml` `[mcp_servers.<name>]` with `command`, `args`, optional `env`, or `url` | README matches that shape, including the warning that this block is not the model provider. The provider block correctly uses `/backend-api/codex`. | Works after a local build. HTTP URL works only while `mcp --http` is already running. |
| Cursor | `.cursor/mcp.json` or a deeplink `cursor://anysphere.cursor-deeplink/mcp/install?name=&config=` (base64 of one server object) | README shows the JSON file with a placeholder path. No deeplink. `.cursor/` is gitignored, so a committed project mcp file would have to live somewhere else or be forced. | Works after a local build. Nothing to click. |
| Gemini CLI | `~/.gemini/settings.json` or `.gemini/settings.json`, `mcpServers`, `command` / `args`, or `httpUrl` | No Gemini CLI example. The generic stdio command is the right shape. Gemini's HTTP field is `httpUrl`, not `url`. | Stdio works if someone writes the settings entry. The README does not. |
| Grok CLI | `~/.grok/config.toml` `[mcp_servers.<name>]`, or `grok mcp add` | The "Grok Bot" section describes Cursor's Add MCP dialog, not `~/.grok/config.toml`. | Stdio would work with a Codex-shaped block. The docs describe a different product. |

`npx -y pxpipe-fork mcp` does not resolve. Registry check during this review: `pxpipe-fork` 404, `@sriinnu/inkling` 404, `inkling` is `0.2.1` by another author. `pxpipe-proxy` on npm is upstream 0.16.0, which is not this fork. A one-liner that can work without publishing is `npx --yes --package github:sriinnu/inkling pxpipe-mcp`, and only after a `prepare` script builds `dist/node.js`. That script does not exist today.

## Security and deployment

Checked, and not a new hole: the Worker refuses to attach a configured provider key unless `PXPIPE_WORKER_SECRET` matches (`src/worker.ts` lines 122–139, SHA-256 compare). The Node dashboard stays on loopback (`src/node.ts` lines 524–534) even when `HOST` is public. Normal request logs are method, path, status, timing, and token counts (`src/node.ts` around line 1370). Upstream error bodies are passed to the logger only when `captureErrorReqBody` is set, which is `PXPIPE_DEBUG_CAPTURE_4XX=1` (`src/core/proxy.ts` line 2250). MCP `health` and `stats` return versions and counters. PAKT runs in process. The HTTP MCP server binds `127.0.0.1` and rejects a non-loopback `Host`. Warp targets and provider upstreams are operator configuration, which `docs/SECURITY_MODEL.md` already treats as trusted. I did not find a request-controlled URL fetch.

The Docker image is a hole of a different kind. `scripts/build.mjs` lines 51–53 mark `@sriinnu/pakt` external. The runtime stage copies `dist/node.js` and not `node_modules` (`Dockerfile` lines 34–48). Starting that file with no installed package throws `ERR_MODULE_NOT_FOUND: Cannot find package '@sriinnu/pakt'`. Upstream's image had no runtime dependency. This fork added one and did not install it. The image also still labels `org.opencontainers.image.source` as `https://github.com/teamchong/pxpipe`.

`wrangler.toml` sets `PXPIPE_MODELS` to `claude-fable-5,gemini-3.6-flash`, not the Node default. A Worker deploy does not image Opus 5.5 for a second, independent reason. `prepareHybridBody` imports `./hybrid.js` dynamically and, on failure, continues with `tier: 'image'` and no PAKT (`src/core/proxy.ts` lines 1452–1469). A Worker bundle that drops that import silently reverts to upstream imaging and never says so except for one warning.

## Findings

### Critical

#### C1. The Docker image does not start

`scripts/build.mjs` lines 51–53, `Dockerfile` lines 34–48.

`dist/node.js` contains `import ... from "@sriinnu/pakt"`. The runtime stage copies that file, the license, and nothing else. `node /tmp/inkling-docker-sim/node.js --version` exited 1 with `ERR_MODULE_NOT_FOUND`. `CMD ["node", "dist/node.js"]` fails the same way. The healthcheck never gets a listener.

Fix: in the runtime stage, install production dependencies (`@sriinnu/pakt` and `gpt-tokenizer`) next to `dist/node.js`. Copy `package.json` and the lockfile, run `pnpm install --frozen-lockfile --prod`, and keep the image on `USER node`. Point the OCI source label at `https://github.com/sriinnu/inkling`.

### High

#### H1. Opus 5.5 is allowlisted and then refused images

`src/core/applicability.ts` line 55, `src/core/reader-tier.ts` lines 35–63, `src/core/proxy.ts` lines 1812–1819.

`DEFAULT_MODEL_BASES` is `claude-fable-5`, `claude-opus-5-5`, `gemini`. `PAKT_ONLY` matches `claude-(opus|sonnet|haiku)-5-5`. `shouldImageModel` requires the allowlist and then returns false for every PAKT-only id. The proxy sets `compress: false` for that request. On code, PAKT does not apply, so the original body is forwarded.

Realistic large TypeScript, estimates: Opus raw 11413, upstream-style images 2753, this fork 11413. Mixed prose in `measure-hybrid.mts`: the Sonnet-shaped body is 3660 versus 1130 imaged; Opus takes the same branch. `REVIEW.md` called this an intentional policy. It is still a regression against the proxy it forked, on the model Claude Code uses by default.

Fix: stop using the veto as a hard skip. If the model is allowlisted, render the upstream image candidate from the original body. Price raw, cache-safe PAKT text, and that image candidate. Send the cheapest. `PXPIPE_FORCE_IMAGES` should only add the image candidate for a model that is not allowlisted, which is what the flag's comment already claims it does not do today. Do not image Sonnet, Haiku, or Grok unless they are named. Upstream does not, and their dense-hex scores are why.

#### H2. A PAKT hit rewrites the cached prefix

`src/core/hybrid.ts` lines 109–127 and 154–161. `src/core/transform.ts` lines 1453–1456.

`prepassRequest` parses the body, rewrites leaves, calls `insertLegend`, and `JSON.stringify`s the tree. `insertLegend` appends to `instructions`, to a string `system`, or pushes a new block onto a system array. The image path already refuses to put per-turn text in `req.system` because that field "always precedes the last `cache_control` marker and would void the whole cached prefix."

Pretty-printed probe: the prefix bytes through `cache_control` changed (`{\n  "model"` became `{"model"`). The legend was inside `system`. A cache read is ~0.1x and a cache write is ~1.25x. Busting a warm prefix to save a tool result in the tail costs more than the PAKT saving on any session large enough to be worth caching. Turns also flap: a turn with nothing to pack forwards the client's original bytes, and the next turn that packs sends canonical JSON plus a legend. The provider cache never settles.

Fix: do not rebuild the document. Scan the raw JSON, find the end of the last `cache_control` value, and only replace string literals that begin after that index. Splice the new JSON string in place so every preceding byte is unchanged. Put the legend in that tail, next to the packed text, not in `system` or `instructions`. If the only packable strings sit inside the prefix, skip PAKT and leave the body untouched. If there is no `cache_control`, still splice in place so the bytes before the first edited string stay identical (OpenAI's automatic prefix cache).

#### H3. PAKT runs before the image gate and can discard a cheaper image

`src/core/proxy.ts` lines 1812–1834, `src/core/hybrid.ts` lines 219–257.

The proxy packs first, then runs the image transform on the packed body. On the favorable 360-row fixture that is why Fable's hybrid is 564 instead of 3875: the model is asked to read an image of PAKT notation. On the realistic JSON request the packed tool result was 1345 characters, the image transform returned `below_min_chars (1345 < 2000)`, and Fable's billable went from 2863 (image of the original) to 4295 (PAKT text). Opus, which never images, landed at 4297 against an image candidate of 3257. Both are worse than upstream on that body, and the 564 figure is a different, less readable encoding.

Fix: three candidates, one choice.

1. Raw: the original bytes.
2. PAKT text: the cache-safe splice from H2, only if its billable estimate is lower than raw.
3. Images: the existing transform on the original body, only if the model is allowlisted (or `PXPIPE_FORCE_IMAGES` / `forceImages`), and only if its billable estimate is lower than raw.

Send the minimum. Do not image the packed text. Tie goes to raw, so a zero-saving rewrite does not happen. The Gemini `:countTokens` probe stays as a backstop: if it says the image body is not cheaper, fall back to the cheaper of raw and PAKT, which `src/core/proxy.ts` lines 1867–1887 already try to do for the PAKT half.

This is also the rule that stops Sol's short session from imaging at 2214 against a raw 2123. The current gate let that through. The comparison should use the same `countBillable` plus `visionTokens` the reports already show, and it should refuse a candidate that is not strictly cheaper.

### Medium

#### M1. The proxy and `transform_request` do not use the same rule

`src/core/proxy.ts` lines 1816–1819, `src/core/hybrid.ts` lines 221–222, `src/core/reader-tier.ts` lines 47–53.

The proxy images when `shouldImageModel(model, modelOk)` is true. `hybridTransform` images when `readerTier === 'image'`. Consequences measured or executed this run:

- `gemini-2.5-pro` is not allowlisted and was imaged by `hybridTransform`.
- `gpt-5.6-sol` is imaged by `hybridTransform` with no `PXPIPE_MODELS` entry. The proxy images it only after it is named.
- `claude-opus-5` and `gpt-6-astra` are imaged by the proxy once named (`shouldImageModel` true) and left as text by `transform_request` (`readerTier` is `pakt-text`).

Fix: `chooseEncoding` from H3 is the only entry. The proxy passes `allowImages: modelOk`. MCP passes the same allowlist, and `forceImages: true` is the only override. Delete the second policy.

#### M2. L4 can ship a payload that was never decompressed

`src/core/pakt-stage.ts` lines 212–231.

The lossless path refuses `cacheBreakpoint`, a non-reversible flag, and a failed `roundTrips`. The lossy path checks none of those except `cacheBreakpoint` and the token count. The MCP schema advertises L4. The proxy leaves it off, which is right, and the tool does not.

Fix: always `decompress`. If it throws, discard the pack. Set `reversible: true` only when `roundTrips` passes. A lossy result that decompresses but does not match may still be returned, with `reversible: false`, because that is what the caller asked for.

#### M3. Every Haiku id is vetoed, not just Haiku 5.5

`src/core/reader-tier.ts` lines 33–39.

The comment says Claude 5.5 and Grok. The third regex is `/claude-haiku(?:-|$)/`, which matches `claude-haiku-4-5`. `prefersPaktText('claude-haiku-4-5')` was true in the probe, so naming it in `PXPIPE_MODELS` still does not image it. Upstream would.

Fix: delete that regex. The `5-5` regex already covers `claude-haiku-5-5`. After H3, an allowlisted model is an image candidate anyway. Keep the `5-5` and `grok` patterns only as the default that stays out of the image candidate until the operator names them.

#### M4. A newline-delimited MCP message is unbounded

`src/mcp/server.ts` lines 274–313 versus the HTTP cap at lines 395–404.

`pushMcpChunk` appends until it sees `\n` or a complete `Content-Length` frame. HTTP and framed bodies stop at `MCP_MAX_BYTES` (8 MiB). A single stdio line does not. This is the user's own process, which is why it is not High, and it is still a trivial way to exhaust it.

Fix: if `rest.length` exceeds `MCP_MAX_BYTES` and the message is not yet complete, emit a JSON-RPC `-32600` and clear the buffer.

#### M5. Codex scrub is byte-preserving only when the key is absent

`src/core/codex-cache.ts` lines 24–47. Injection site: `src/core/openai.ts` lines 201–214. Proxy call: `src/core/proxy.ts` lines 1806–1836.

Verified this run:

- No key: the same `Uint8Array` is returned.
- A key inside a string value is not stripped. Good.
- A real key is removed, and the body is `JSON.stringify`'d. A pretty planted body became one line.
- `/backend-api/codex/responses` is incapable even if the upstream host is `api.openai.com`.
- Host `chatgpt.com` is incapable even on `/v1/responses`.
- `/backend-api/codex/responses/compact` with upstream `https://api.openai.com` is capable. A Codex client that grows a new path under that prefix, pointed at the proxy with the default OpenAI upstream, would be injected again and 400.

The documented README configuration (base URL ending in `/backend-api/codex`, `OPENAI_UPSTREAM=https://chatgpt.com`) is safe today. The scrub is the backstop for a client that already set the field, and that backstop rewrites every other byte.

Fix: treat any pathname whose segments contain `backend-api/codex` as incapable. When the key is present, delete that one property with a scanner and fix the neighboring comma. If the scanner cannot prove the edit, then and only then fall back to `JSON.stringify`. Keep returning the original buffer when the key is absent.

#### M6. Nothing installs this as a plugin, and the documented npx command 404s

`package.json` lines 2–9 and 52–64. `README.md` lines 158 and 255–262. `bin/mcp.js`.

`npx -y pxpipe-fork` is not on the registry. `npx -y inkling` would install someone else's package. There is no `.claude-plugin/plugin.json`, no `.claude-plugin/marketplace.json`, no `.mcp.json`, and no Cursor deeplink. The README's Grok section is Cursor's dialog. Gemini CLI is absent. The Ribhu prompt tells the model to compress before answering, which is H4's failure mode.

`bin/mcp.js` and `bin/cli.js` import `dist/node.js`. Without `prepare`, a git install has no `dist/`.

Fix:

- Add `"prepare": "node scripts/build.mjs"` so a git install builds the bin. `prepublishOnly` can stay for publish.
- Do not rename the package to `inkling`. That name is taken. The install command is `npx --yes --package github:sriinnu/inkling pxpipe-mcp` until a scoped name such as `@sriinnu/inkling` is actually published.
- `.claude-plugin/plugin.json` and `.mcp.json` with `command: npx` and those args. `${CLAUDE_PLUGIN_ROOT}` is the wrong pointer here because the checkout does not contain `node_modules` or `dist` until prepare, and Claude Code does not run prepare for a plugin.
- `.claude-plugin/marketplace.json` with one plugin whose source is `./`.
- README: the Cursor link `cursor://anysphere.cursor-deeplink/mcp/install?name=inkling&config=<base64 of the server object>`, the Gemini `mcpServers` block, and a Grok `[mcp_servers.inkling]` block. State, in the tool descriptions and the plugin description, that these tools do not shrink a turn they are called from. The proxy is what saves tokens.
- Replace the Ribhu prompt that says to compress before answering.

### Low

#### L1. HTTP MCP does not listen on `::1`

`src/mcp/server.ts` line 441. Bind `127.0.0.1` and, if the stack allows it, `::1` on the same port. Keep the Host check.

#### L2. A notification that carries an `id` gets silence

`src/mcp/server.ts` line 243. If `id` is present, return `{ result: {} }` for `notifications/initialized` and `notifications/cancelled`. Spec-correct notifications have no id and stay unanswered.

#### L3. The inherited README still says Opus 5.5 is imaged at +2px

`README.md` under "Inherited upstream guide" (the fork heading admits the contradiction and then leaves the upstream text in place). After H1 the cost check may image Opus again, so the page has to describe the choice, not two opposite defaults.

#### L4. "Lossless" for YAML and CSV is a string compare, and the context engine is a second compressor

`src/core/pakt-stage.ts` lines 85–96 and 185–206. JSON compares canonical values. YAML and CSV must match `decompress().text` or that text trimmed. That fails closed, which is why it is Low rather than a correctness bug. `compressWithEngine` builds an engine per tool string and then discards the result when summarization or aging is non-zero. One `compressLossless` call is enough.

#### L5. Savings math is a `cl100k` estimate plus a pixel formula, and the gate does not always agree with it

`src/core/hybrid.ts` lines 61–72. `getModelEncoding('claude-opus-5-5')` is null. The Sol agent session is the concrete disagreement: images billed 2214 against raw 2123 and the gate still compressed. H3's comparison has to use one function, and the dashboard should not present that number as provider usage. `countBillable`'s base64 strip is a linear scan. Fine.

#### L6. Worker config and a swallowed hybrid import diverge from Node

`wrangler.toml` lines 9–13 set a narrower `PXPIPE_MODELS` than `DEFAULT_MODEL_BASES`. `src/core/proxy.ts` lines 1452–1469 turn a failed hybrid import into silent upstream imaging. Log the failure at error level once, and make the Worker model list match the Node default or document the split in `wrangler.toml` itself.

### Nits

- `SERVER_VERSION` in `src/mcp/server.ts` line 15 is a literal. It matches `package.json` today. The bundle already inlines `__PXPIPE_VERSION__` for the CLI. Use that.
- `stats` uses the same `idempotentHint: true` as the pure tools (`src/mcp/server.ts` lines 19–24). Set it false on `stats` only.
- `src/node.ts` help still opens with "pxpipe — token-saving proxy".
- `package.json` `exports` do not expose the MCP module. The bins do. Fine if the README stops implying the package is published.

## Tests that matter and tests that do not

Passed, and worth keeping: identity-block order, absent-key Codex scrub, Host and body-cap rejection, `Content-Length` inside JSON, the cyclic-integer PAKT refusal, and the upstream cache-marker relocation tests. I did not skip or edit any of them for this review.

Not evidence of the claims a reader will take from them:

- `tests/hybrid-pakt.test.ts` requires the packed text to be imaged and to beat images of the original. That locks in H3.
- `tests/review-fixes.test.ts` requires `shouldImageModel('claude-opus-5-5', true)` to be false. That locks in H1.
- Nothing asserts byte equality of the prefix across a PAKT hit.
- Nothing starts `dist/node.js` without `node_modules`.
- Nothing checks MCP framing once the buffer exceeds 8 MiB without a newline.
- Nothing measures a tool-call round trip as a net token change. A test that only asserts `savedPercent > 20` on the tool result will stay green while the conversation gets larger.

The cache-stability file is the one the vitest comment calls out as timing-sensitive. It passed here in a quiet pool. I would not treat a single red run under parallel CPU as a product bug without looking at the timeout first.

## Roadmap

The order is the order that makes every default client no worse than upstream, then strictly better where PAKT is actually cheaper.

1. Fix C1 so the container starts. A proxy that cannot boot is not in the comparison.
2. H2, then H3 and H1 together. One function, `chooseEncoding`, used by the proxy and by `transform_request` (M1). Cache-safe PAKT, image candidate only when allowlisted or forced, send the strict minimum of raw / PAKT text / images of the original. Re-run `measure-hybrid.mts` and the realistic fixture. The acceptance bar: for every allowlisted model, billable estimate ≤ the upstream image-or-raw result; for every other model, billable estimate ≤ raw; the prefix bytes before the last `cache_control` are identical whenever the choice is PAKT or raw.
3. M5, M2, M3, M4, and the cheap lows (L1, L2) in the same MCP and Codex pass. M6 (prepare, plugin manifest, marketplace, Cursor link, Gemini and Grok docs, honest tool text) is what makes the server installable without making the bill worse.
4. Leave L4's string compare as a fail-closed guard. Do not weaken it to chase CSV savings. Leave L5's tokenizer as an estimate and label it, unless a real Anthropic or Gemini count is wired in behind an API key. L6's Worker model list should match Node once H3 lands.

After that, Opus on code should match upstream's image savings, Opus and Fable on monotonic JSON should take PAKT only when it beats that image, Sonnet and Grok should stay at raw on code and beat raw on structured text, and a warm `cache_control` prefix should still hit.

## Remediation

Follow-up PRs, still estimates, still no provider API. `pnpm test` and `pnpm exec tsc --noEmit` passed on each code branch. Docker is not installed here; the runtime layout was installed outside the repo and `node dist/node.js --version` printed `0.17.0-fork.1`. The same file with no `node_modules` still throws `ERR_MODULE_NOT_FOUND`.

| PR | What it changes |
| --- | --- |
| [#11](https://github.com/sriinnu/inkling/pull/11) | H1, H2, H3, M1, M2, M3. Cache-safe splice. Allowlisted models, including Opus 5.5, are image candidates. The sent body is the cheaper of raw, PAKT text, and images of the original. L4 must decompress. The extra Haiku regex is gone. |
| [#12](https://github.com/sriinnu/inkling/pull/12) | C1. The runtime image installs production dependencies. The OCI source label points at this fork. `wrangler.toml` keeps its narrower model list and says so (L6, documented rather than widened). |
| [#13](https://github.com/sriinnu/inkling/pull/13) | M4, M5, M6, L1, L2, and the version / `stats` nits. Stdio cap, notification-with-id, `::1`, in-place Codex scrub, `/backend-api/codex/` including `responses/compact`, plugin manifest, marketplace, Cursor link, Gemini and Grok CLI docs. `prepare` builds `dist/node.js`. |

`npm install github:sriinnu/inkling#cursor/mcp-plugin-and-codex-scrub-c280` installed 99 packages, `prepare` produced `dist/node.js`, and `node dist/node.js --version` printed `0.17.0-fork.1`. `node bin/mcp.js --help` printed the stdio / HTTP usage. The unqualified `npx --yes --package github:sriinnu/inkling pxpipe-mcp` tracks the default branch, so it picks this up once #13 is on `main`.

The server's own name is now `inkling-mcp`: `serverInfo.name` and the bin. `pxpipe-mcp` in the findings above is the name this review saw. The npm package stays `pxpipe-fork`. `inkling` on npm is a different package.

### Before / after

Same estimators as the rest of this file. "Before" is `151227d`. "After" is #11.

| Case | Before | After |
| --- | ---: | ---: |
| Fable, 360 monotonic rows. Raw 17705, images 3875 | Hybrid 564, one image of the packed text | 936 PAKT text, 0 pages. Still under the image, and the model is not asked to read PAKT off a page |
| Fable, mixed prose + TypeScript. Raw 3657, images 959 | 959 | 959 |
| Opus 5.5, ~200 TypeScript functions, identity block, `cache_control`. Raw 8315, images 2165 | 8315, images refused | 2165, imaged, same as the image candidate |
| Sonnet 5.5, same TypeScript. Raw 8316, forced images 2166 | 8316 | 8316. Not allowlisted, so this matches upstream. Prefix bytes through `cache_control` stayed equal |
| Grok 4.7, same TypeScript. Raw 8313, forced images 4193 | 8313 | 8313. Same reason as Sonnet |
| Sol agent session. Raw 2123, images 2214 (+4.3%) | Hybrid imaged at 2214 even though Sol is not allowlisted | 2123. Sol is not an image candidate until `PXPIPE_MODELS` names it |
| Pretty JSON with `cache_control` on the identity block and a monotonic tool result | Prefix bytes changed (`{\n  "model"` became `{"model"`) and the legend was inserted into `system` | Bytes through the end of that `cache_control` object are identical. The legend is inside the tool result, after the boundary |

Naming Sonnet or Grok in `PXPIPE_MODELS` makes images a candidate and the gate's choice is kept when it compresses. That is the upstream opt-in. The default stays text, which is also upstream.

### Still open

- L4. YAML and CSV still have to match `decompress` text. That fails closed. A CSV sample of 1437 characters did not pack. Not loosened.
- L5. `countTokens` is still cl100k for Claude, Gemini, Grok, and Sol. The profile gate, including an operator `charsPerToken`, is what decides that images beat raw. Overriding that with the cl100k estimate rejected images the gate had accepted (a Sol chat fixture was 3095 versus 3062) and broke the upstream tests that set `charsPerToken: 1`. When Sol is allowlisted, a short session can still image at 2214 against a raw 2123, because that is the gate's decision. PAKT is allowed to beat that image; cl100k is not allowed to overturn the gate.
- L6. The Worker model list is still `claude-fable-5,gemini-3.6-flash`. The comment in `wrangler.toml` says it is narrower than Node. Widening it is an operator change, not something this pass guessed.
- The context engine is still built per tool string and then often discarded. The request path no longer needs it; `prepassRequest` calls `packStructured` without a tool name.
- No live provider usage. Nothing here is an Anthropic, OpenAI, Google, or xAI bill.
- The Docker image was not built with Docker. The runtime layout was. `docker` is not installed in this environment.
- Sonnet, Haiku, and Grok on code are a tie with upstream, not a win. Imaging them by default would beat the token estimate and walk into the dense-hex failures upstream already measured. They stay out of the default allowlist.
