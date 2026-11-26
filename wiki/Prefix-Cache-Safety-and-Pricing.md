# Prefix Cache Safety & Kosha Pricing

In multi-turn coding agents, 85–95% of billed tokens are KV-cache hits (`0.05×–0.10×` read cost on Anthropic/OpenAI/Gemini). Trimming even `50` tokens inside a `10,000`-token warm prefix busts the cache across all `10,000` tokens (`9.5×` segment spike / `+8,950` net penalty = `179×` worse than the `50` tokens saved).

## Four Cache-Conservation Rules in `fiche` (`v0.19`)

1. **Deterministic Pure Block Transforms (`P0` XML-Island `TSCG` + `Drain` + `@toon`)**:
   - Volatile XML envelopes (`VOLATILE_XML_TAGS`) are separated before static deduplication (`140` chars / `96` schema), while `P0` keeps `cleanUserPayloads` off by default and preserves canonical `firstUserSha8`.
2. **Single-Block `LSM-Context` Sticky Epochs (`L1` / `L0` / `L2`, `src/core/text-history.ts`)**:
   - Seals large blocks (`>= 1,500` tok) past `L1` (`tail = 2`) and aged turns past `L0` (`tail = 6`) strictly one block at a time (`[item]`) keyed by `(sessionKey, fnv64Hex)` with FIFO eviction — preventing multi-block merge invalidation.
   - `L2` cold repack fires only when upstream `usage` confirms cache expiration (`everCacheAlive && !lastCacheAlive`, `1h + 30s` idle, or `413` backstop) with `justRepacked` cooldown across all `5` provider cache-read JSON `usage` fields.
   - `session-state.ts` persists freeze floors and Turn-1 skill catalog pins (`PINNED_SKILLS_MAX = 32` across `512` LRU sessions) in `~/.fiche/session-state.json`.
   - Anthropic adapters conserve the caller's single cache marker without inventing extra `cache_control` blocks; OpenAI Codex routes (`/backend-api/codex/` and `chatgpt.com`) strip unsupported `prompt_cache_breakpoint`.
3. **Google `contents[0]` Seal & Live-Tail Isolation (`src/core/google.ts`)**:
   - Mutable `pinnedUserText` is routed onto the trailing live `user` turn instead of `contents[0]`, and `CASI` is turned off whenever Optical is active (`!opticalEnabled`) — raising 30-turn Google Optical cache hit from **`11.9%` → `79.7%`**.
4. **Live-Tail Instruction Pins (`src/core/pin.ts`) & `Context-MMU` Tail Hydration**:
   - `@fiche pin <rule>` and `Context-MMU` `[fiche vm-hydrate]` (`±15`-line slices) inject strictly into the trailing uncached turn so sealed historical prefixes stay byte-identical.

## Kosha Pricing & Long-Context Cliff Avoidance (`src/core/pricing.ts`)

Set `FICHE_PRICES=kosha` (or use built-in snapshot rows) to enable exact model-band pricing (`cache read`, `5m` vs `1h` `cache write`, output ratio, and long-context pricing cliffs):
- `resolvePriceRates(model, ctx)` + `evaluateCliffAvoidance(...)` quantify when crossing a provider's long-context cliff (e.g., 200K tokens on 2×–4× tier transitions) pays back epoch sealing immediately on turn 1.
- When a cliff is avoided, `fiche` records `cliffAvoided` in `TrackEvent` and emits `x-fiche-cliff-saved-usd` downstream.
