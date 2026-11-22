<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/fiche-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../assets/fiche-logo-light.svg">
  <img alt="fiche — Microfiche for coding agents" src="../assets/fiche-logo-light.svg" width="320">
</picture>

</div>

# `fiche` Wiki

Welcome to the **`fiche`** technical handbook — *microfiche for coding agents*.

`fiche` is a <5 ms local/edge context compiler and proxy for Claude Code, OpenAI Codex, Antigravity / Gemini, DeepSeek, Kimi, GLM, and Grok. Every transformation is deterministic, append-only prefix-cache safe, edit-preserving, and runs without any `node:` dependencies in its core engine.

## Start Here

1. **[Getting Started Guide](../docs/GETTING_STARTED.md)** — Install, choose Daemon vs. `fiche-mcp` vs. `fiche export`, enable macOS `fiche service` + `FicheBar`, and verify savings.
2. **[Coding Agents Setup](./Coding-Agents-Setup.md)** — Wire **Antigravity**, **Claude Code**, **OpenAI Codex**, **Cursor**, **OpenCode**, **Gemini CLI**, and multi-provider gateways cleanly.
3. **[CLI & Offline Export](./CLI-and-Offline-Export.md)** — Full CLI flags (`fiche`, `fiche warp`, `fiche export`, `fiche turn-report`, `fiche stats`, `fiche mcp`, `fiche service`), env vars, and `@fiche pin`.
4. **[macOS Menubar App (`FicheBar`)](../apps/macos-bar/README.md)** — Native SwiftUI menubar UI for live telemetry, auto-start, Pause/Resume, Model scopes, and Stages & Skills.

## Core Engine

5. **[Architecture](./Architecture.md)** — End-to-end request flow, visual diagram, model-scope routing, security boundaries, and Workers-safe `src/core/`.
6. **[Hybrid Optical Engine](./Hybrid-Optical-Engine.md)** — Dense bitmap glyph atlases, reflow (`↵`), PNG Average filtering, and verbatim `FactSheet` extraction.
7. **[4-Layer Text Compiler Pipeline](./Text-Compiler-Pipeline.md)** — `TSCG`, Terminal Emulation + `Drain` log folding, bijective `@toon`, `ACDC` frozen epochs, `CASI-Delta` cross-turn deltas, and `isCodeOrDiffProtected`.
8. **[Prefix Cache Safety & Kosha Pricing](./Prefix-Cache-Safety-and-Pricing.md)** — Append-only sealing, carry-over boundaries, `@fiche pin` live-tail relocation, and payback/cliff gates.

## Ecosystem, Operations & Reference

9. **[Ecosystem Integration](../docs/ECOSYSTEM_INTEGRATION.md)** — Connecting `kosha-discovery`, `tokmeter`, `Runic`, `LLM Bar`, `baton`, `omit`, and `ribhu` / `chitragupta`.
10. **[Stage Plugins & Agent Skills](../docs/PLUGINS_AND_SKILLS.md)** — `~/.fiche/plugins/` manifests, `~/.agents/skills/` discovery, `/api/plugins`, and extensibility roadmap.
11. **[Latency & Benchmarks](./Latency-and-Benchmarks.md)** — Hot-path engineering (`hasLongUnbrokenBpeChunk`, ASCII LUTs, Buffer tail scans), cold vs. warm p50/p95/p99 charts, and 16-model results.
12. **[Zero-Token Telemetry, Plugins & MCP](./Telemetry-Plugins-and-MCP.md)** — `~/.fiche/events.jsonl`, `fiche turn-report`, `plugins/fiche-telemetry/`, `x-fiche-*` response headers, and `fiche-mcp`.
13. **[Troubleshooting & FAQ](./Troubleshooting-and-FAQ.md)** — Loopback security (`403`/`421`), `x-fiche-bypass`, `editSafe`, and coexisting with `tokmeter`/`kosha`.
14. **[Migrating from `inkling`](./Migration-from-Inkling.md)** — Backwards-compatibility guarantees for env vars (`FICHE_*` / `INKLING_*`), data paths, pins, HTTP headers, and TypeScript SDK aliases.
