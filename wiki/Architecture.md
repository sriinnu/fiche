# Architecture

![fiche architecture](../docs/architecture/fiche-architecture.svg)

![fiche request flow](../docs/architecture/request-flow.svg)

`fiche` intercepts inference traffic (or transforms payloads offline via library / MCP / `fiche export`) using a clean split between a **pure runtime-agnostic core** (`src/core/`, zero `node:` imports) and **host adapters** (`src/node.ts`, `src/worker.ts`, `src/warp/`, `src/mcp/`, `apps/macos-bar/`).

---

## 1. End-to-End Topology

```mermaid
flowchart LR
  subgraph CLIENTS["Coding CLIs & Desktop Apps"]
    CLIS["claude · codex · gemini · opencode · agy"]
    APPS["Desktop Apps via 'fiche warp --app'"]
    SHELL["'fiche shell-init [--wrap]' (fclaude / fcodex / fiche-app)"]
    BAR["FicheBar.app (5 Apple HIG Themes + Control)"]
  end

  subgraph LOCAL["Local Loopback Stack (127.0.0.1:47821)"]
    WARP["CONNECT MITM + Loopback Guard"]
    PROXY["fiche Hybrid Context Proxy + Dashboard"]
    MCP["fiche-mcp (Stdio / :47823 HTTP)"]
    STATE["~/.fiche/ (events.jsonl · session-state.json · plugins/)"]
  end

  subgraph UPSTREAM["First-Party + 23 COMPAT Hosts"]
    ANT["api.anthropic.com"]
    OAI["api.openai.com · chatgpt.com/backend-api/codex"]
    GOOG["generativelanguage / cloudcode-pa (/v1internal:*)"]
    COMPAT["DeepSeek · Moonshot · Kimi · Z.AI · xAI · OpenRouter · Groq · +16"]
  end

  CLIS --> WARP
  APPS --> WARP
  SHELL --> WARP
  WARP --> PROXY
  BAR <-->|"Poll & POST /api/*"| PROXY
  MCP -->|"check_model / transform_request"| PROXY
  PROXY <--> STATE
  PROXY --> ANT
  PROXY --> OAI
  PROXY --> GOOG
  PROXY --> COMPAT
```

---

## 2. Hybrid Context Compiler Router

```mermaid
flowchart TD
  REQ["Inbound Wire Request"] --> GUARD{"Origin / Host & Bypass Guard"}
  GUARD -->|"x-fiche-bypass: 1"| PASS["Forward Verbatim"]
  GUARD -->|"Loopback / Trusted"| WIRE["Normalize Wire Format"]

  WIRE --> WTYPE{"Wire Family"}
  WTYPE --> ANT_W["Anthropic Messages (/v1/messages)"]
  WTYPE --> OAI_W["OpenAI Responses & Chat (/v1/responses, /v1/chat/completions)"]
  WTYPE --> GOOG_W["Google Gemini & /v1internal:* (:generateContent, :streamGenerateContent)"]

  ANT_W --> SCOPE{"readerTier(model) & FICHE_MODELS"}
  OAI_W --> SCOPE
  GOOG_W --> SCOPE

  SCOPE -->|"OPTICAL Tier (Fable 5, Gemini Vision, Opt-in Sol)"| OPT["Optical Microfiche + Text Hygiene + FactSheet"]
  SCOPE -->|"TEXT Tier (Astra, Opus 5.5, Neon/Carbon, DeepSeek, Kimi, GLM, Grok)"| TXT["4-Layer Text Compiler (0 images)"]

  subgraph TEXT4["Deterministic Text Pipeline (src/core/)"]
    S1["Stage 1: TSCG (Schema & Static Compiler)"]
    S2["Stage 2: Terminal ANSI/CR + @toon + Drain Log Fold"]
    S3["Stage 3: ACDC (Frozen Epoch Digestion)"]
    S4["Stage 4: CASI-Delta (Cross-Turn Line Hash Dedupe)"]
    S1 --> S2 --> S3 --> S4
  end

  TXT --> S1
  OPT --> EDIT{"editSafe Guard (isCodeOrDiffProtected)"}
  S4 --> EDIT
  EDIT -->|"Numbered Reads & Diffs Exact"| SEAL["Append-Only Prefix Cache Boundary + @fiche pin Tail"]
```

---

## 3. Prefix-Cache Seal & Zero-Token Telemetry Sequence

```mermaid
sequenceDiagram
  autonumber
  participant Agent as Coding Agent / IDE
  participant Proxy as fiche Proxy (src/core/proxy.ts)
  participant State as Session State (~/.fiche/session-state.json)
  participant Upstream as Provider API (Prompt Cache)
  participant UI as FicheBar.app / Dashboard / Hook

  Agent->>Proxy: Turn N messages + tool results
  Proxy->>State: Lookup sealed chunks / optical history grid
  State-->>Proxy: Immutable bytes for Turns 1..K (prefix-stable)
  Proxy->>Proxy: Compile new chunk K+1 (preserving live tail & @fiche pin)
  Proxy->>Upstream: Forward compiled payload + original credentials
  Upstream-->>Proxy: SSE / JSON response + cache_read_input_tokens
  Proxy-->>Agent: Response + x-fiche-saved-tokens / x-fiche-stages / x-fiche-cliff-saved-usd
  Proxy->>State: Append TrackEvent to ~/.fiche/events.jsonl (<5 ms tail write)
  UI-->>State: Poll /api/health, /proxy-stats, /api/last-turn.json, PostInvocation hook (0 LLM tokens)
```

---

## 4. Module Map (`src/` & `apps/`)

| Module | Path | Responsibility |
| :--- | :--- | :--- |
| **Pure Core Engine** | `src/core/` | Zero `node:` imports: wire transforms (`transform.ts`, `openai.ts`, `google.ts`), 4-layer text pipeline (`schema-compiler.ts`, `text-hygiene.ts`, `toon.ts`, `text-history.ts`, `casi-delta.ts`), optical PNG renderer (`render.ts`, `atlas*.ts`, `png.ts`, `factsheet.ts`), cache state (`session-state.ts`, `codex-cache.ts`), 23-host COMPAT registry (`upstream-hosts.ts`), `kosha` pricing & baselines (`pricing.ts`, `baseline.ts`, `measurement.ts`), and plugins (`stage-plugins.ts`) |
| **Loopback Proxy & CLI** | `src/node.ts`, `src/worker.ts` | Local HTTP daemon (`127.0.0.1:47821`), Cloudflare Workers adapter, `fiche export`, `fiche turn-report`, `fiche stats`, `fiche service` (`launchd`) |
| **TLS Warp & App Launch** | `src/warp/` | Local HTTPS `CONNECT` interceptor (`connect.ts`, `ca.ts`, `resolve.ts`, `route.ts`) + macOS GUI launcher & shell helpers (`app-launch.ts`) for `fiche warp --app` and `fiche shell-init [--wrap]` |
| **Local Dashboard** | `src/dashboard.ts`, `src/dashboard/` | Editorial Warm Paper live telemetry dashboard, PNG crop inspector, `/fragments/plugins`, and `/api/models` / `/api/plugins` controls |
| **MCP Server** | `src/mcp/` | Stdio & stateless Streamable HTTP MCP server (`fiche-mcp` / `:47823`) exposing `check_model`, `transform_request`, `health`, `stats` |
| **Fast Telemetry Tail** | `src/turn-report.ts`, `src/sessions.ts`, `src/stats.ts` | Bounded reverse-tail buffer scanner (`<5 ms`) powering CLI rollups, Antigravity `PostInvocation`, and Claude `statusLine` |
| **macOS Companion** | `apps/macos-bar/` | Native Swift 6 / SwiftUI `FicheBar.app` with 5 Apple HIG themes (`Editorial`, `Native`, `Slate`, `Terminal`, `Midnight`), weighted-vs-raw savings readout, 1-click third-party toggles, and About/Sponsor window |

---

## 5. Model Routing & Font Bands (`src/core/reader-tier.ts`)

1. **Dense 5×8 bitmap (`spleen-5x8`, 5×8 cell + `Unifont` 8px fallback)**: `claude-fable-5`, measured `gemini` vision tiers (`gemini-3.6-flash`, `3.7-flash`, `3.8-flash`, `gemini-4-argon`), `gpt-6` (non-Sol), and default GPT fallback (`312` cols on Claude/Gemini, `152` cols on GPT).
2. **Spaced 5×8 bitmap (`spleen-5x8` + `2px` row spacing → 5×10 cell)**: `claude-fable-5-1`, `claude-fable-5-2`, and other opt-in Claude models (`312` cols, `1568×728` max). Intermediate `jetbrains-mono-10` (`6×11`) and `jetbrains-mono-12` (`8×13`) atlases are also compiled for `FICHE_GPT_PROFILES`.
3. **Native 14px (`jetbrains-mono-14`, 9×16 cell + `Unifont` 14px fallback)**: opt-in `gpt-5.6-sol` / `gpt-6.1-sol` / `gpt-6.2-sol` (`84` cols, `764×1954`), opt-in `grok-*` (`84` cols, `764×512`), and opt-in `qwen3.8-27b` (`84` cols, `764×512`, `providerImageCap: 32`).
4. **Text-only deterministic hygiene (zero images)**: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-*`, `gpt-6*-astra`, `gemini-4-neon`, `gemini-4-carbon`, `gemini-4-hydrogen`, `deepseek`, `kimi`, `glm`, `minimax`, and `grok` (unless `FICHE_FORCE_IMAGES=1`). Includes Google `/v1internal:*` `functionResponse.parts[].text` compression for non-Gemini models routed through Antigravity.

## Further Reading

- [Detailed Architecture Reference](../docs/ARCHITECTURE.md)
- [Hybrid Optical Engine](./Hybrid-Optical-Engine.md) · [4-Layer Text Compiler](./Text-Compiler-Pipeline.md)
- [Prefix Cache Safety & Kosha Pricing](./Prefix-Cache-Safety-and-Pricing.md)
- [Security Model](../docs/SECURITY_MODEL.md) · [Privacy Policy](../PRIVACY.md)
