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
Pass HTTP header `x-fiche-bypass: 1` (or click **Disable compression** in the dashboard kill switch at `http://127.0.0.1:47821/`). `fiche` strips the bypass header and forwards the payload byte-for-byte upstream.
