# Privacy Policy

**`fiche`** (`@sriinnu/fiche`, including the CLI daemon, `fiche-mcp`, the web dashboard, and `FicheBar.app`) is built for **100% local-first execution** with **zero product telemetry, analytics, or tracking**.

---

## 1. Local-Only Data Processing

- **Loopback by default**: The proxy daemon (`fiche`) binds strictly to `127.0.0.1:47821` (plus optional `::1` for `fiche-mcp --http`). No usage analytics, crash reports, telemetry beacons, or update pings are sent to the author or any third party.
- **No stored prompts or request bodies**: Both the proxy and `fiche-mcp` keep prompt payloads and tool outputs strictly in ephemeral request memory. Neither `events.jsonl`, `stats`, nor `health` writes raw prompt text by default. (Opt-in debug capture flags such as `FICHE_DEBUG_CAPTURE_4XX` are disabled by default.)
- **Upstream forwarding**: When running as a live proxy or `fiche warp` interceptor, requests travel solely between your local coding agent/desktop app, the loopback `fiche` proxy, and your configured AI provider API using your own credentials, untouched.

## 2. What Stays on Your Disk (`~/.fiche` & `~/.config/fiche`)

All persisted state stays locally under owner-only POSIX file permissions (`0600` / `0700`):

- `~/.fiche/events.jsonl` — Metadata-only accounting rows (timestamp, model name, token counts, weighted savings, dollar estimates, stage tags, latency, and prefix-cache hit ratios). No source code or prompt contents are stored.
- `~/.fiche/session-state.json` — In-session structural hashes / append-only optical & `LSM-Context` freeze boundaries and Turn-1 skill catalog pins used solely to preserve upstream KV prefix caches across turns.
- **In-memory `Context-MMU` default (opt-in disk persistence only)**: `ContextPageStore` virtual pages stay strictly in daemon RAM unless you explicitly set `FICHE_MMU_PERSIST=1` (with `FICHE_SESSION_STATE` enabled), which writes `0600` (`O_EXCL | O_NOFOLLOW`) JSON to `~/.fiche/mmu-pages.json` capped at `32 MiB`, `24h` idle TTL, and filtered to skip high-confidence secret patterns (`PEM`, `Bearer`, `sk-*`, GitHub/AWS keys).
- `~/.config/fiche/calibrated-models.json` — Local 4-axis vision calibration profiles written atomically with `0600` permissions by `fiche calibrate`.
- `~/.fiche/plugins/` & `~/.config/fiche/config.json` — Your local plugin/skill enablement state and model configuration.
- `~/.fiche/bin/fiche-launchd-exec` & `~/.fiche/daemon.{out,err}.log` — Compiled local macOS `<launch.h>` socket-activation trampoline (`0755`) and `launchd` process lifecycle logs.

You can purge all local state at any time:

```bash
rm -rf ~/.fiche ~/.config/fiche
```

## 3. Offline Export (`fiche export`) & `FicheBar.app`

- **`fiche export`** writes rendered `page-*.png`, `factsheet.txt`, `prompt.txt`, and `manifest.json` files strictly to the local output directory you specify, making **zero network requests**.
- **`FicheBar.app`** communicates exclusively with your local loopback daemon (`http://127.0.0.1:47821`) and `launchctl`. Clicking external links (**GitHub Repository**, **Sponsor**, or **fiche.srinivas.dev**) opens your default browser only on explicit user action.

## 4. Third-Party Upstream Providers & Security Guarantees

Prompts and compressed artifacts forwarded upstream are governed by the privacy policy of the LLM provider you configure (Anthropic, OpenAI / ChatGPT Codex, Google Gemini, DeepSeek, Moonshot, Z.AI, xAI, etc.). For threat-model boundaries, loopback `Origin`/`Host` DNS-rebinding guards, and `fiche warp` TLS isolation, see [SECURITY.md](./SECURITY.md) and [docs/SECURITY_MODEL.md](./docs/SECURITY_MODEL.md).

## 5. Contact

Questions or privacy disclosures may be filed via [GitHub Security Advisories](https://github.com/sriinnu/fiche/security/advisories/new) or issues on [github.com/sriinnu/fiche](https://github.com/sriinnu/fiche).
