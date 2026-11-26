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
4. **[macOS Menubar App (`FicheBar`)](../apps/macos-bar/README.md)** — Native SwiftUI menubar UI for live local stats, auto-start, Pause/Resume, Model scopes, and Stages & Skills.

## Core Engine

5. **[Architecture](./Architecture.md)** — End-to-end request flow, visual diagram, model-scope routing, zero-drop daemon reliability, and Workers-safe `src/core/`.
6. **[Context-MMU Architecture](../docs/CONTEXT_MMU_ARCHITECTURE.md)** — Full `v0.19` specification: `P0–P3`, `LSM-Context`, virtual paging (`pg_<12hex>`), live-tail hydration, and 4-axis calibration.
7. **[Hybrid Optical Engine](./Hybrid-Optical-Engine.md)** — Dense bitmap glyph atlases, 4-axis `fiche calibrate`, Google `contents[0]` cache seal, and verbatim `FactSheet` extraction.
8. **[Text Compiler Pipeline (`P0–P3` & `Context-MMU`)](./Text-Compiler-Pipeline.md)** — `TSCG` + Merkle Schema DAG, `CASI v2` FastCDC, `LSM-Context`, and `Context-MMU` (`pg_<12hex>`, Markovian folding, tail hydration).
9. **[Prefix Cache Safety & Kosha Pricing](./Prefix-Cache-Safety-and-Pricing.md)** — Single-block `L1`/`L0` sticky epochs, `L2` cold repack, `@fiche pin` relocation, and payback/cliff gates.

## Ecosystem, Operations & Reference

10. **[Ecosystem Integration](../docs/ECOSYSTEM_INTEGRATION.md)** — Connecting `kosha-discovery`, `tokmeter`, `Runic`, `LLM Bar`, `baton`, `omit`, and `ribhu` / `chitragupta`.
11. **[Stage Plugins & Agent Skills](../docs/PLUGINS_AND_SKILLS.md)** — `~/.fiche/plugins/` manifests, `~/.agents/skills/` discovery, `/api/plugins`, and extensibility roadmap.
12. **[Latency & Benchmarks](./Latency-and-Benchmarks.md)** — Hot-path engineering, 16-turn cold/warm p50/p95/p99 results, and the `v0.19` 30-turn `Context-MMU` replay.
13. **[Zero-Token Local Stats, Plugins & MCP](./Local-Stats-Plugins-and-MCP.md)** — `~/.fiche/events.jsonl`, `fiche turn-report`, `plugins/fiche-companion/`, `x-fiche-*` headers, `/api/mmu/*`, and 6-tool `fiche-mcp`.
14. **[Troubleshooting & FAQ](./Troubleshooting-and-FAQ.md)** — Loopback security (`403`/`421`), `#33` HTTP/1.1 transport, `#34` `launchd` socket activation, `fiche warp` fail-open, and OAuth `401` diagnostics.
15. **[Migrating from `inkling`](./Migration-from-Inkling.md)** — Backwards-compatibility guarantees for env vars (`FICHE_*` / `INKLING_*`), data paths, pins, HTTP headers, and TypeScript SDK aliases.
