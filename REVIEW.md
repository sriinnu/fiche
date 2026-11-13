# Review of pxpipe-fork 0.17.0-fork.1

Reviewed as a change on top of pxpipe v0.16.0 (`9e0e0e99`), not as a defense of the fork. Line numbers are from this tree after the fixes below.

No upstream test was skipped, deleted, or had its assertion loosened. The only existing test that failed on the fork (`tests/worker-profile.test.ts`, explicit `PXPIPE_MODELS=claude-opus-5` must still image) was kept as written; the proxy was changed so that opt-in still images. New tests live in `tests/review-fixes.test.ts` plus the earlier Codex, hybrid, and MCP files.

Upstream PNG geometries were not edited. Fable stays bare Spleen 5×8. Other Claude ids stay Spleen 5×8 with `cellHBonus: 2`. Grok stays JetBrains Mono 14px, 84 columns, max height 512. Sol stays 14px / 84 columns / 1954px.

## Critical

### C1. PAKT legend was inserted in front of the Claude Code identity. Fixed.

`src/core/hybrid.ts` `insertLegend` used to `unshift` a system block and, when `system` was a string, prepend the legend. Claude Code subscription traffic is classified on the first system block. If that block is not exactly `You are Claude Code, Anthropic's official CLI for Claude.` (or the two longer variants in `src/core/transform.ts` around line 199), the API answers `429 rate_limit_error: "Error"` even when the account has quota (`#149` in the upstream comment). A `role: "system"` message unshifted into `messages` is also illegal on the Anthropic Messages API.

Fixed: the legend is appended as a later system block, or appended to a system/instructions string. If there is no system or instructions field, it is not inserted. `tests/review-fixes.test.ts` checks the identity block stays at index 0.

## High

### H1. Every Codex JSON body was re-serialized, even when it had no breakpoint. Fixed.

`src/core/codex-cache.ts` `scrubPromptCacheBreakpoint` used to `JSON.parse` and `JSON.stringify` unconditionally. The proxy calls it for every request whose upstream is `chatgpt.com` or whose path is `/backend-api/codex/responses` (`src/core/proxy.ts` around line 1836). A passthrough that upstream would have forwarded byte-for-byte was rewritten (whitespace, key order of nested objects that `JSON.stringify` normalizes). That can miss a prompt cache and surprise any client that signs the body.

Fixed: the original bytes are returned when the key is absent. Covered by `tests/review-fixes.test.ts`.

### H2. A JSON payload containing the text `Content-Length:` flipped stdio into LSP framing. Fixed.

`src/mcp/server.ts` `runStdioServer` used to set `framed = true` when any stdin chunk included that substring. The next response was then `Content-Length` framed, which newline-JSON clients (Claude, Cursor, Codex, Pi, Ribhu) will not parse. One `compress_text` of a log line was enough.

Fixed: framing is detected only when the buffer starts with `Content-Length:`. A mention inside a JSON line stays newline-delimited. Tested.

### H3. The HTTP MCP server had no body cap and did not check Host. Fixed.

`startHttpServer` (`src/mcp/server.ts` around line 377) binds `127.0.0.1` only, which is correct, but it accepted any `Host`. A DNS-rebinding page can connect to `127.0.0.1` while sending `Host: attacker.example`. There was also no limit on `req` chunks, so a local client could grow the process without bound, and a thrown handler left the response open.

Fixed: `Host` must be `localhost`, `127.0.0.1`, or `::1` (optional port). Bodies and `Content-Length` frames over 8 MiB are rejected (`413` / JSON-RPC `-32600`). Handler failures return `-32603` instead of hanging. `Origin`, when present, must also be loopback. No `Access-Control-Allow-Origin` is set, so a browser still cannot read the response cross-origin. Tested for Host and the size cap.

### H4. Default Claude Opus 5.5 no longer images ordinary sessions. Open.

Upstream v0.16.0 images `claude-opus-5-5` by default (`DEFAULT_MODEL_BASES` in `src/core/applicability.ts`). This fork keeps it in that list, then `shouldImageModel` (`src/core/reader-tier.ts` line 61) refuses to image it unless `PXPIPE_FORCE_IMAGES=1`.

On the mixed prose-and-code fixture below, that is not a wash. Upstream-style imaging bills 1,130 tokens (69.1% under the 3,660 raw). The fork sends the raw 3,660 and saves nothing, because the tool result is source code, not JSON. The same shape shows up on the agent-session fixture (1,848 imaged vs 2,149 raw). For a laptop session that is mostly code and prose, the fork is worse than upstream on the default Claude model.

This matches the requested policy (do not send dense pages to Claude 5.5). It is still a daily-use regression. It is not fixed, on purpose.

### H5. Any successful PAKT hit rewrites the whole JSON document. Open.

`src/core/hybrid.ts` lines 154–157 parse the request, edit a leaf, and `JSON.stringify` the tree. Whitespace in the cached system prefix changes even when the only packed string is an uncached tool result. Anthropic prompt cache keys on those bytes. Upstream does the same thing when it images; it does not do it when it passes the body through. The fork now rewrites on PAKT-only hits too.

Not fixed. A surgical replace of one string would be a real change to the rewriter, not a one-line patch.

## Medium

### M1. The proxy and the MCP server do not use the same image rule. Open.

The proxy images when `shouldImageModel` says so: allowlisted, and not Claude 5.5 or Grok (`src/core/proxy.ts` line 1816). `hybridTransform` images when `readerTier === 'image'` (`src/core/hybrid.ts` around line 212). Opus 5, GPT-6 Astra, and any other allowlisted id that is not Gemini, Fable 5, or Sol are imaged by the proxy and left as text by `transform_request`. Unknown models are text on both paths, which is safe. The split is not.

### M2. "Lossless" is semantic for JSON, and only a string compare for YAML and CSV. Open.

`src/core/pakt-stage.ts` lines 77–95. JSON must `JSON.parse` to the same canonical value. Key order and insignificant whitespace are not preserved. YAML and CSV must match `decompress(...).text` or that text trimmed. PAKT 0.10.0's own `reversible: true` flag is not trusted: cyclic integers come back wrong (negative deltas stored as absolutes). The guard catches that and keeps the original. A realistic log whose `status` flips between 200 and 500 was refused on the agent-session fixture (`paktBlocks: 0`). That refusal is correct and it also means a lot of agent JSON will not pack.

L4 (`lossy === true` and `semanticBudget > 0`, line 213) skips the round-trip check entirely. The proxy never sets that. The MCP tool will, if the caller asks. A bad L4 result can ship.

### M3. Newline-delimited MCP input is still unbounded. Open.

HTTP bodies and `Content-Length` frames stop at 8 MiB. A single newline-delimited JSON line does not. A local stdio client can still force a large allocation. Lower than H3 because stdio is the user's own process.

### M4. `PXPIPE_FORCE_IMAGES` used to be process-global inside the MCP tool. Fixed.

`tools/call` for `transform_request` wrote `process.env.PXPIPE_FORCE_IMAGES` for the duration of the call. Two overlapping HTTP calls could flip each other's tier. The flag is now an argument to `readerTier` / `prepassRequest` / `hybridTransform`. The test checks the environment variable is untouched.

The flag still does not add a model to the allowlist. `shouldImageModel('grok-4.7', false, true)` is false. Sonnet 5.5 and Grok image only when they are named in `PXPIPE_MODELS` and the flag is set. The README said the flag imaged them "anyway". That sentence is corrected. Opus 5.5 is already in the default scope, so the flag alone does image Opus 5.5.

### M5. Chat Completions toward chatgpt.com were not scrubbed. Fixed.

Injection of `prompt_cache_breakpoint` exists only in `responsesCacheBreakpoint` (`src/core/openai.ts`). Chat Completions never added it, including under warp (warp only retargets the connection; the proxy still sees the path and `OPENAI_UPSTREAM`). A client that put the field on a chat body aimed at `chatgpt.com` would still have been forwarded. The scrub now covers chat and the messages bridge as well as Responses, and it is a no-op when the key is absent (H1).

`api.openai.com` `/v1/responses` still receives the field when the profile has `cacheBreakpoints: true`. `PXPIPE_GPT_PROFILES` with `cacheBreakpoints: false` is honored (`src/core/gpt-model-profiles.ts`). Covered by `tests/codex-cache-breakpoint.test.ts`.

### M6. A Gemini countTokens revert threw away a good PAKT rewrite. Fixed.

`src/core/proxy.ts` around line 1871. If the image probe says the transformed body is not cheaper, the proxy used to restore `bodyIn`, including when PAKT had already shrunk a tool result. It now restores the PAKT body when the pre-pass changed something, and marks the reason `pakt_text`. The existing Gemini revert test uses prose, so it still expects the original body. That test was not edited.

## Low

### L1. HTTP does not listen on `::1`. Open.

`server.listen(port, '127.0.0.1')` (`src/mcp/server.ts` line 441). A client that resolves `localhost` to IPv6 only will fail to connect. Binding `::1` as well would still be loopback. Not done in this pass.

### L2. A notification that includes an `id` gets silence. Open.

`handleMcpMessage` returns `null` for `notifications/initialized` and `notifications/cancelled` even if the client set `id`. Stdio then writes nothing and a strict client waits. Spec-correct notifications have no `id`.

### L3. The billable counter and the profitability gate disagree on small sessions. Open.

On the agent-session fixture, Sol is imaged and the counter says the result costs 4.3% more than raw text (2,214 vs 2,123). The gate let it through. That is upstream gate behavior, not a new image profile. Worth knowing before trusting a savings percentage from `inspect_savings` on a short transcript.

### L4. Inherited README still describes upstream defaults. Open.

The top of `README.md` is the fork. Below "Inherited upstream guide", the v0.16.0 text still says Opus 5.5 is imaged at +2px. The heading says so. It will confuse a quick reader.

### L5. Context engine duplicates `compress()` per tool string. Open.

`compressWithEngine` in `src/core/pakt-stage.ts` builds a new engine for every tool-result string, with summarization and tail truncation rejected after the fact. It is extra CPU and another code path to drift. Not removed here.

## Nits

- `SERVER_VERSION` in `src/mcp/server.ts` is a string literal, not the package version. They match today.
- `src/mcp/server.ts` re-exports `countBillable` for no caller outside tests that import the server.
- `src/node.ts` help still opens with "pxpipe — token-saving proxy".
- `package.json` `exports` do not expose the MCP module. The bins do: `pxpipe`, `pxpipe-fork` (`bin/cli.js`), `pxpipe-mcp` (`bin/mcp.js`). `files` includes `NOTICE`.
- Tool annotations (`readOnlyHint`, `destructiveHint: false`, `idempotentHint`, `openWorldHint: false`) match the implementation after M4. The tools do not write disk, do not open network connections, and do not keep the prompt. `stats` increments counters, which is the only side effect. `lossy: true` is deterministic but not fidelity-preserving; the annotation does not claim fidelity.

## Routing table, as it actually behaves

| Model | In default `PXPIPE_MODELS`? | Proxy images? | MCP `transform_request` images? |
| --- | --- | --- | --- |
| Gemini (any id containing `gemini`) | yes (`gemini`) | yes | yes |
| `claude-fable-5`, `5-1`, `5-2` | yes | yes | yes |
| `gpt-5.6-sol`, `gpt-6.1-sol` | no | only if named | yes (tier is image; MCP does not consult the allowlist) |
| `claude-opus-5` | no | only if named | no |
| `claude-opus-5-5` | yes | no, unless `PXPIPE_FORCE_IMAGES=1` | no, unless `forceImages: true` |
| `claude-sonnet-5-5`, `claude-haiku-5-5` | no | no, unless named and `PXPIPE_FORCE_IMAGES=1` | no, unless `forceImages: true` |
| `grok-4.5`, `4.6`, `4.7` | no | no, unless named and `PXPIPE_FORCE_IMAGES=1` | no, unless `forceImages: true` |
| Other GPT / unknown | no | only if named | no |

`PXPIPE_MODELS` is the allowlist. `PXPIPE_FORCE_IMAGES` only removes the Claude 5.5 / Grok veto. Neither flag re-enables `prompt_cache_breakpoint` on `chatgpt.com` or `/backend-api/codex/responses`.

Streaming responses are not rewritten. The fork only touches the request body, same as upstream. Malformed JSON is left alone. `tool_use` argument objects are not packed unless a nested string is itself long structured text. `tool_result` string content is the path that packs.

## Security and privacy

- No new code phones home. `@sriinnu/pakt` compresses locally. `health` and `stats` return version strings and counters, not prompts or keys.
- The inherited proxy can still log upstream error bodies when `PXPIPE_DEBUG_CAPTURE_4XX` is set. That is upstream behavior and still off by default.
- The HTTP MCP port is loopback. Host is checked (H3). There is no CORS allow-list, which is what you want on loopback.
- Path traversal does not apply: the MCP tools do not read the filesystem.
- The base64 stripper in `countBillable` is a linear scan, not a nested-quantifier ReDoS. `JSON.parse` on an 8 MiB body is still CPU, and that is now the cap for HTTP.
- Dependency surface added by the fork is `@sriinnu/pakt@0.10.0`, which pulls `@modelcontextprotocol/sdk`, `zod`, and its own `gpt-tokenizer`. The fork does not start PAKT's MCP server. The package is MIT, author Srinivas Pendela.

## Packaging and credits

`package.json` name `pxpipe-fork`, version `0.17.0-fork.1`. Bins point at `bin/cli.js` and `bin/mcp.js`. `bin/mcp.js` splices the `mcp` argument and loads `dist/node.js`, so `pnpm build` is required before the bin works. `exports` still point at `dist/`, which is gitignored and produced by the build. `LICENSE` keeps the upstream MIT text and copyright, then a fork notice naming Steven (https://github.com/teamchong) and the v0.16.0 commit. `NOTICE` credits the same upstream and PAKT (`@sriinnu/pakt`, https://github.com/sriinnu/clipforge-PAKT, Srinivas Pendela, MIT). Those credits match the imported tag and the published package.

Client configs in the README match the shapes checked for this review:

- Claude Code / Desktop: `mcpServers` with `command` and `args`.
- Codex: `[mcp_servers.pxpipe_fork]` with `command`, `args`, `[mcp_servers.pxpipe_fork.env]`, and a separate `url` form. This is not the model-provider block; that one is further up and still uses `/backend-api/codex`.
- Pi: same JSON, plus `pi mcp add pxpipe-fork -- node <checkout>/dist/node.js mcp` and `--url` for HTTP, which matches https://pi.dev/docs/latest/mcp.
- Ribhu: extension JSON `mcp.command` / `mcp.args` as documented in `docs/extensions.md` on https://github.com/sriinnu/ribhu. `.mcp.json` is mentioned as a second place `/mcp` lists, not as a format this review verified in source.
- Cursor and Grok Bot: the same command and args.
- OpenCode: `type: local` and a `command` array.

`npx -y pxpipe-fork` will not resolve until this package is installed or published. The README says to use `node <checkout>/dist/node.js`. That is accurate. Nothing was published from this review.

## Savings

Re-ran `pnpm exec tsx scripts/measure-hybrid.mts` after the legend fix. Tokens are o200k (`gpt-4o` via PAKT's counter) after base64 is removed, plus vision tokens from the rendered page sizes. "Image only" is `transformRequest` with no PAKT, which is the upstream renderer, including on models the fork would not image.

### Repetitive JSON log (360 monotonic rows)

This is the favourable case. It is not a typical edit session.

| Path | Pages | Billable | vs raw |
| --- | ---: | ---: | ---: |
| Raw (Fable id) | 0 | 17,705 | — |
| Images only, Fable 5 | 4 | 3,875 | 78.1% fewer |
| Hybrid, Fable 5 | 1 | 564 | 96.8% fewer |
| Hybrid, Sonnet 5.5 (text) | 0 | 939 | 94.7% fewer |
| Hybrid, Grok 4.7 (text) | 0 | 936 | 94.7% fewer |

Hybrid beats images here (564 vs 3,875) because the packed log fits one short page, and the weak-reader text is still far under the raw JSON. The earlier "96.8%" claim still holds on this fixture and only on this kind of fixture.

### Mixed prose and TypeScript

System prompt is repeated instructions. The tool result is 80 small functions, not JSON. PAKT declines (`paktBlocks: 0`).

| Model | Raw | Images only | Fork hybrid | Fork vs images |
| --- | ---: | ---: | ---: | ---: |
| Fable 5 | 3,657 | 959 (73.8% under raw, 2 pages) | 959, imaged | tie |
| Sonnet 5.5 | 3,660 | 1,130 (69.1% under raw) | 3,660, not imaged | fork costs 2,530 more |
| Grok 4.7 | 3,657 | 2,157 (41% under raw, 6 pages at 14px) | 3,657, not imaged | fork costs 1,500 more |

### Agent session (tool doc, six turns, one small JSON log)

The log's status column is not monotonic. The round-trip guard refuses it, so PAKT does nothing.

| Model | Raw | Images only | Fork hybrid | Fork vs images |
| --- | ---: | ---: | ---: | ---: |
| Fable 5 | 2,071 | 1,658 (19.9% under raw) | 1,658, imaged | tie |
| Sonnet 5.5 | 2,149 | 1,848 (14% under raw) | 2,149, not imaged | fork costs 301 more |
| Grok 4.7 | 2,071 | 2,218 (7.1% over raw) | 2,071, not imaged | fork costs 147 less, because not imaging was the better trade |
| Sol 5.6 | 2,123 | 2,214 (4.3% over raw) | 2,214, imaged | tie, and both lose to raw text |

## Verdict

Not ready as the daily proxy for Claude Code on Opus 5.5. The identity bug had to be fixed before that was even safe to try, and after the fix the default path still drops upstream's image savings on code and prose (H4). Turn imaging back on with `PXPIPE_FORCE_IMAGES=1` if you want the v0.16.0 Opus 5.5 behavior, and accept the weak hex reading upstream already measured.

Usable for Codex against `chatgpt.com`, with the breakpoint fix in place and passthrough bodies no longer rewritten when the field is absent. Sol still images when you name it, which on a short session can cost more than raw text (the table above).

Grok is safe from an accidental image bill. It only gets cheaper when the tool result is repetitive structured data that survives the round-trip guard. On source code it saves nothing, and that is worse than the 14px image path when that path would have saved tokens, and better when the 14px path would have lost them.

The MCP server is fit to connect from Claude, Codex, Pi, Cursor, and Ribhu after `pnpm build`, on loopback, with the Host check. Do not expose it past `127.0.0.1`.
