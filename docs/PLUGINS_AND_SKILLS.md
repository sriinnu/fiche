# Stage Plugins & Agent Skills

`fiche` separates its compiler pipeline (`src/core/stage-plugins.ts`) from host discovery (`src/node.ts`) so pipeline stages, third-party manifests, and agent `SKILL.md` skills can be inspected and toggled live without touching core proxy code.

---

## 1. Built-In Compiler Stages

Every `fiche` instance registers five authoritative built-in stages (`BUILTIN_STAGE_PLUGINS`):

| Stage ID | Pipeline Phase | Description |
| :--- | :--- | :--- |
| `optical-microfiche` | `optical` | Renders bulky stale context into lossless PNG pages + verbatim `FactSheet` anchors for strong vision readers (`claude-fable-5`, measured `gemini`, opt-in `sol`) |
| `tscg-schema` | `pre-hygiene` | Deterministic prefix-safe tool schema and static system-prompt compaction (`src/core/schema-compiler.ts`) |
| `toon-structured` | `hygiene` | Lossless bijective `@toon` tabular encoding for repetitive JSON array payloads (`src/core/toon.ts`) |
| `acdc-epochs` | `history` | Amortized cache-safe deterministic collapsing of aged text turns (`src/core/text-history.ts`) |
| `casi-delta` | `hygiene` | Content-addressed cross-turn inverted-index deduplication and line deltas (`src/core/casi-delta.ts`) |

Built-in stage IDs are reserved so third-party manifests cannot shadow core stages.

---

## 2. Custom Plugin Manifests (`~/.fiche/plugins/<id>/plugin.json`)

The Node host scans `$FICHE_PLUGINS_DIR` (default: `~/.fiche/plugins/`) for subdirectories or symlinks containing a `plugin.json` manifest:

```json
{
  "id": "sql-plan-reducer",
  "name": "SQL EXPLAIN Reducer",
  "version": "0.1.0",
  "stage": "hygiene",
  "description": "Collapses repetitive PostgreSQL EXPLAIN cost trees while preserving table/index names.",
  "entry": "./index.mjs",
  "enabled": true
}
```

### Valid Manifest Fields (`parsePluginManifest`)

- `id` *(string, optional — defaults to `name` or folder name)*: must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`.
- `name` / `displayName` *(string)*: human-readable display name shown in `FicheBar` and `/api/plugins`.
- `version` *(string, optional)*: semantic version string.
- `stage` *(enum)*: currently validated values in `src/core/stage-plugins.ts` are `"pre-hygiene" | "hygiene" | "history" | "optical" | "skill"` (defaults to `"hygiene"` if omitted or unrecognized).
- `description` *(string)*: concise summary of what the stage or integration does.
- `enabled` *(boolean, optional, default `true`)*: initial default state before user overrides.
- `entry` *(string, optional)*: relative path metadata for companion script/hook entrypoints.

---

## 3. Agent Skill Discovery (`SKILL.md`)

The Node host automatically discovers agent skills from:

1. `~/.agents/skills/<skill-name>/SKILL.md`
2. `~/.gemini/config/plugins/fiche-telemetry/skills/<skill-name>/SKILL.md`

*(Skills stored under `~/.claude/skills/<skill-name>/` can be symlinked into `~/.agents/skills/` to share one canonical copy across Claude Code, Codex, and Antigravity.)*

`parseSkillManifest()` parses YAML frontmatter (`name`, `description`) and registers each skill with ID `skill:<directory-name>` and `stage: "skill"`.

`fiche` ships its built-in skill at [`plugins/fiche-telemetry/skills/fiche/SKILL.md`](../plugins/fiche-telemetry/skills/fiche/SKILL.md), covering `fiche-mcp` tools (`stats`, `check_model`, `transform_request`, `health`), `fiche warp`, `fiche turn-report`, and `fiche export`.

---

## 4. Live Control API & Persistence (`~/.config/fiche/plugins.json`)

### HTTP Endpoints (Loopback-Only)

- **`GET /api/plugins`** — returns merged built-in stages, discovered `~/.fiche/plugins/` manifests, and discovered `SKILL.md` skills:
  ```bash
  curl -s http://127.0.0.1:47821/api/plugins
  ```
- **`POST /api/plugins`** — toggles any stage, plugin, or skill live:
  ```bash
  curl -s -X POST http://127.0.0.1:47821/api/plugins \
    -H 'Content-Type: application/json' \
    -d '{"id":"toon-structured","enabled":true}'
  ```

Overrides persist atomically to **`~/.config/fiche/plugins.json`** (override via `$FICHE_PLUGINS_CONFIG`) with owner-only POSIX permissions (`0o700` directory, `0o600` file).

### `FicheBar` → Stages & Skills Tab

Inside **`FicheBar.app`** ([apps/macos-bar/README.md](../apps/macos-bar/README.md)), the **Stages & Skills** tab renders every entry from `/api/plugins` with live toggles and quick buttons to open `~/.fiche/plugins/` and `~/.agents/skills/` directly in Finder.

---

## 5. Extensibility Roadmap

The current registry ships declarative metadata discovery, live HTTP/UI toggles, and persistent overrides. Upcoming execution-hook milestones include:

1. **Pluggable `post-hygiene` Reducers**: sandboxed ESM/WASM filters for SQL query plans, OpenAPI/GraphQL AST pruning, and framework-specific test runner templates (Jest, Vitest, Pytest, Cargo).
2. **Pluggable `post-turn` Exporters**: custom sinks alongside `~/.fiche/events.jsonl` (OTLP metrics, SQLite rollups, or webhook alerts).
3. **Custom `pricing` Adapters**: live HTTP/file price-card plugins complementing `FICHE_PRICES=kosha` for private deployments, custom enterprise discounts, or self-hosted GPU clusters.
