# Migrating from `inkling`

The package was renamed from `@sriinnu/inkling` to **`@sriinnu/fiche`** (`fiche` / `fiche-mcp`), with full runtime backwards compatibility so existing setups keep working without breaking.

## What Changed

| Surface | Previous (`inkling`) | New (`fiche`) |
| :--- | :--- | :--- |
| npm package | `@sriinnu/inkling` | `@sriinnu/fiche` |
| CLI binaries | `inkling`, `inkling-mcp` | `fiche`, `fiche-mcp` |
| Companion plugin | `plugins/inkling-telemetry/` | `plugins/fiche-companion/` |
| Env vars | `INKLING_*` | `FICHE_*` (`INKLING_*` fallback built in) |
| Data directory | `~/.inkling/` | `~/.fiche/` (auto-falls back to `~/.inkling/` if present) |
| Config file | `~/.config/inkling/config.json` | `~/.config/fiche/config.json` (legacy read fallback) |
| HTTP headers | `x-inkling-bypass`, `x-inkling-secret` | `x-fiche-bypass`, `x-fiche-secret` (both accepted) |
| Downstream headers | `x-inkling-saved-tokens`, `x-inkling-stages`, `x-inkling-cliff-saved-usd` | `x-fiche-saved-tokens`, `x-fiche-stages`, `x-fiche-cliff-saved-usd` |
| Chat pin command | `@inkling pin` | `@fiche pin` (`@inkling pin` still honored) |

## Library TypeScript API Backwards Compatibility

`src/core/index.ts` exports the canonical `fiche` names:
- `isFicheSupportedModel`, `isFicheSupportedGptModel`
- `FicheOptions`, `FicheReason`, `FicheTransformInput`, `FicheTransformResult`, `FicheTransformInfo`, `FicheApplicabilityInput`, `FicheApplicabilityReason`

Existing `Inkling*` / `isInkling*` types and helpers remain exported as `@deprecated` aliases so existing programmatic callers compile untouched.
