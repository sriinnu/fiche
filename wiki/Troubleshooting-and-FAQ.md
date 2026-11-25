# Troubleshooting & FAQ

### 1. Why did a model receive compressed text instead of optical PNG images?
Check `fiche-mcp`'s `check_model` tool or `FICHE_MODELS`:
- Strong verified bitmap readers (`claude-fable-5`, vision Gemini tiers, opt-in `gpt-5.6-sol` / `gpt-6.x-sol`) receive **Optical Microfiche PNGs + FactSheets**.
- Fast/coding text models (`claude-opus-5-5`, `gpt-6-astra`, `gpt-6.2-astra`, `gemini-4-neon`, `gemini-4-carbon`, `gemini-4-hydrogen`, `deepseek`, `kimi`, `glm`, `grok`) are routed to the **4-Layer Deterministic Text Compiler** (`readerTier === 'text'`) to guarantee zero OCR recall degradation.
- To test optical imaging on any model anyway, set `FICHE_FORCE_IMAGES=1` (or enable via the Live Dashboard).

### 2. Why did the proxy return HTTP `403` or `421`?
`fiche` enforces loopback Origin & Host-header security (`src/core/request-guard.ts`) to prevent malicious web pages or DNS rebinding from spending configured API keys:
- Cross-origin browser `fetch()` / XHR mutations from non-loopback origins return `403`.
- Unknown `Host` headers return `421`.
- If running behind a reverse proxy or tailnet host, set `FICHE_ALLOWED_HOSTS="your-host.ts.net"` (and optionally `FICHE_DASH_LABEL` to label the host in the dashboard UI).

### 3. Does compression break exact file edits (`Edit`, `apply_patch`, `replace_file_content`)?
No. `isCodeOrDiffProtected()` scans tool outputs for numbered source reads (`123→`, declarations) and unified diffs (`diff --git`, `@@`, `---`/`+++`). Protected blocks preserve exact spaces, tabs, indentation, and repeated lines. Wait-to-seal history gates (`ACDC` / optical history) keep recent tail turns (`keepTailMessages`, default `6`) raw and untouched.

### 4. Why do my `Edit` calls fail or why is prefix cache hit rate low (<80%)?
- Ensure upstream clients preserve consistent system prompt + tool ordering across turns.
- Do not mix conflicting prompt rewrites in front of `fiche`. Put `@fiche pin <rule>` instead of editing system instructions mid-session.
- Check `FICHE_SESSION_STATE` is enabled so sealed epoch freeze boundaries persist across proxy restarts.

### 5. Can `fiche` coexist with `tokmeter`, `drishti`, `kosha`, and `pakt`?
Yes:
- `fiche` focuses on **coding-agent HTTP proxy & hybrid optical/deterministic context compilation** (`TSCG + Terminal/Drain + TOON + ACDC + CASI-Delta`).
- Existing Claude/Codex hooks and MCP servers (`kosha`, `tokmeter`/`drishti`, `pakt`, `grimoire`, `rea`) remain untouched when `fiche` is registered alongside them.
- `FICHE_PRICES=kosha` directly reuses `kosha`'s calibrated pricing & long-context cliff math inside `fiche`'s gate.

### 6. How do I temporarily bypass `fiche` on a single request?
Pass HTTP header `x-fiche-bypass: 1` (or click **Disable compression** in the dashboard kill switch at `http://127.0.0.1:47821/`, or run `FICHE_BYPASS=1 <cli>` when using `fiche shell-init --wrap`). `fiche` strips the bypass header and forwards the payload byte-for-byte upstream.

### 7. What happens to already-running CLIs or Desktop Apps if I stop or restart the daemon?
- **Normal restart (`fiche service restart` or `FicheBar -> Restart`)**: Zero drops (`#34`). `launchctl kickstart -k` keeps the socket open via `<key>Sockets</key>` + `~/.fiche/bin/fiche-launchd-exec` (`LISTEN_FDS=1`), the new process binds before slow startup restore (`readyPromise`), and the dying process drains active SSE streams for up to `60s` (`ExitTimeOut: 65`). Use `fiche service restart` rather than `fiche service install` during live runs (`install` reloads the plist via `bootout`).
- **Daemon stopped (`fiche service stop` / `FicheBar -> Stop`)**: Active streaming requests finish draining (`<= 60s`), existing `fiche warp` processes automatically fail open directly to upstream on `ECONNREFUSED` (`failOpenOnDivertRefused: true`, and reattach automatically once the daemon returns), and newly launched wrapped commands skip proxying cleanly (`FICHE_BYPASS=1`). Only direct `ANTHROPIC_BASE_URL=http://127.0.0.1:47821` / `OPENAI_BASE_URL=...` setups (without `fiche warp`) cannot fail open when `:47821` is stopped.

### 8. Why did Node 26 crash with `InformationalError: socket idle timeout`, or why did Google return `401 UNAUTHENTICATED` after `>60s`?
- **`InformationalError: socket idle timeout` (`#33`)**: Caused by Node 26 / `undici` HTTP/2 idle-socket reaping on aborted streams (`nodejs/undici#6143`). Fixed in `v0.19.0` via dedicated HTTP/1.1 keep-alive `node:http` / `node:https` transport (`src/node-fetch.ts`) and client-disconnect `AbortController` propagation.
- **Google `401 UNAUTHENTICATED` on long `/v1internal:streamGenerateContent` turns**: `fiche` never strips Google OAuth credentials (`STRIP_REQ_HEADERS` and `stripAnthropicCredentials` only touch `sk-ant-*`) and merges `NO_PROXY=localhost,127.0.0.1,::1` so local OAuth refresh callbacks bypass the warp proxy. A `401` arriving after `>60s` TTFB with `200 OK` immediately after indicates an expired/revalidated upstream OAuth2 token; restart the wrapped CLI once if it predates `NO_PROXY` support, or test directly with `FICHE_BYPASS=1`.

### 9. Where do `Context-MMU` virtual pages live on disk?
Nowhere by default — `ContextPageStore` runs strictly in daemon RAM. Set `FICHE_MMU_PERSIST=1` (alongside `FICHE_SESSION_STATE`) to opt into `0600` (`O_EXCL | O_NOFOLLOW`) persistence at `~/.fiche/mmu-pages.json` (`32 MiB` cap, `24h` idle TTL, high-confidence secrets excluded).
