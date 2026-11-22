# Prefix Cache Safety & Kosha Pricing

In multi-turn coding agents, 85–95% of billed tokens are KV-cache hits (0.05×–0.10× read cost on Anthropic/OpenAI/Gemini). Mutating historical content naively invalidates the cache prefix and triggers a full 1.0×–1.25× write across the remaining transcript.

## Three Cache-Conservation Rules in `fiche`

1. **Deterministic Pure Block Transforms**:
   - Stage 1 (`TSCG`) and Stage 2 (`emulateTerminal`, `foldRepetitiveLogs`, `encodeToon`) are pure functions of a single message/block `f(block)`, so a tool output enters the prefix compacted on turn *t* and stays byte-identical on turns *t+1 ... t+N*.
2. **Append-Only Sealed Boundaries (`src/core/history.ts`, `src/core/text-history.ts`)**:
   - Optical history pages and `ACDC` epochs only seal completed prefix chunks behind the recent tail.
   - Sealed pages keep stable chunk boundaries across growth (`session-state.ts` persists freeze-step floors in `~/.fiche/session-state.json`) so earlier cache entries stay bit-identical.
   - Anthropic adapters never invent extra `cache_control` markers — the caller's single cache marker is conserved at the clean boundary; OpenAI Codex routes (`/backend-api/codex/` and `chatgpt.com`) automatically strip unsupported `prompt_cache_breakpoint`.
3. **Live-Tail Instruction Pins (`src/core/pin.ts`)**:
   - `@fiche pin <rule>` (and legacy `@inkling pin <rule>`) removes matching pin lines deterministically from early `CLAUDE.md`/`AGENTS.md` or earlier user turns and appends them cleanly at the live tail (`[fiche pin] ...`), keeping rules in the model's recency window without mutating the cached prefix.

## Kosha Pricing & Long-Context Cliff Avoidance (`src/core/pricing.ts`)

Set `FICHE_PRICES=kosha` (or use built-in snapshot rows) to enable exact model-band pricing (`cache read`, `5m` vs `1h` `cache write`, output ratio, and long-context pricing cliffs):
- `resolvePriceRates(model, ctx)` + `evaluateCliffAvoidance(...)` quantify when crossing a provider's long-context cliff (e.g., 200K tokens on 2×–4× tier transitions) pays back epoch sealing immediately on turn 1.
- When a cliff is avoided, `fiche` records `cliffAvoided` in `TrackEvent` and emits `x-fiche-cliff-saved-usd` downstream.
