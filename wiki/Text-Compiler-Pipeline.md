# 4-Layer Deterministic Text Compiler Pipeline

On text-tier models (and on textual blocks alongside optical rendering), `fiche` runs four composable, pure-TypeScript compression stages without ever risking code edits:

## 0. Edit & Action Preservation Guard (`isCodeOrDiffProtected`)

Before mutating whitespace, folding lines, or transforming JSON, `src/core/text-hygiene.ts` inspects the block in a single zero-array newline scan:
- Source file reads (numbered lines `123→`, declarations) and unified diffs (`diff --git`, `@@`, `---`/`+++` pairs) are marked **code-protected**.
- On code-protected blocks, terminal stripping cleans only literal ANSI escape sequences and leaves every space, tab, indentation level, and repeated line intact so `Edit` / `apply_patch` anchors never break.

## Layer 1 — `TSCG`: Tool-Schema & Static-Prompt Compiler (`src/core/schema-compiler.ts`)

- Strips redundant JSON Schema metadata (`$schema`, `$comment`, titles mirroring keys, decorative divider lines, unclosed HTML comments in linear O(N) time via `stripHtmlComments`).
- Preserves parameter names, required arrays, types, enums, and constraints verbatim.
- Deduplicates cross-tool shared instruction prose and caches compiled outputs (bounded 4 MiB caches).

## Layer 2 — Deterministic Observation Hygiene (`src/core/text-hygiene.ts`, `src/core/toon.ts`)

1. **Terminal Emulation (`emulateTerminal`)**: Resolves `\r` progress overwrites, `\x08` backspaces, CSI/OSC ANSI escape sequences, and trailing line whitespace cleanly in O(N).
2. **`Drain` Structural Log Folding (`foldRepetitiveLogs`)**: Anchors head/tail lines plus any stack frames, error/warning keywords, or `file:line` references (via linear backtracking-free `hasFileLineLocation`), and folds contiguous/high-frequency boilerplate templates into explicit `[... K similar lines folded ...]`.
3. **Bijective `@toon` Tabular Compiler (`encodeToon` / `decodeToon`)**: Converts uniform arrays of objects (≥5 rows, ≤24 columns, ≥75% density) into schema-once pipe-delimited rows when strictly profitable (≥20% token savings measured symmetrically via `estimateTokenPair`). Guaranteed 100% lossless round-trip (`decodeToon(encodeToon(x)) === x`).

## Layer 3 — `ACDC`: Append-Only Frozen-Epoch History Compactor (`src/core/text-history.ts`)

- Runs **before** `CASI` so `CASI` never indexes a block that becomes an epoch digest (preventing circular live-tail references).
- Groups aged observations behind the active tail (`keepTailMessages`, default 6) into fixed epochs (`>= 4000` tokens).
- Seals an epoch once when its payback / cliff threshold clears `kosha` economics, emitting deterministic structural skeletons (`[fiche epoch-digest <refId>: ...]`) + embedded `FactSheet` anchors via `extractStructuralDigest` (backed by an 8 MiB digest cache).
- Live tail turns stay raw and untouched, and sealed epochs stay bit-identical across subsequent turns.

## Layer 4 — `CASI-Delta`: Cross-Turn Duplicate & Diff Index (`src/core/casi-delta.ts`)

- Scans remaining verbatim tool outputs monotonically in prefix order (`0 -> N-1`) using dual 64-bit hashes and line postings (`LinePostings` skipping ultra-hot boilerplate lines).
- **Exact Duplicate**: Emits `[fiche cas: exact duplicate of earlier tool output <refId> ...]`.
- **Modified File / Log Re-read**: Computes line-level anchor alignment (`lisAnchors`) and emits `[fiche cas-delta vs <refId>: matched/total lines unchanged; only changed hunks below (±2 context)]`.
