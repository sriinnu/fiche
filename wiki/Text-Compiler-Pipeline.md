# Text Compiler Pipeline (`P0–P3` & `Context-MMU`)

On text-tier models (and on non-optical blocks), `fiche` runs a four-pass (`P0–P3`) pure-TypeScript compiler plus `Context-MMU` virtual memory without mutating live source edits or sealed KV-cache prefixes:

## 0. Edit & Action Preservation Guard (`isCodeOrDiffProtected` & Live Tail)

Before mutating whitespace, folding lines, or transforming JSON, `src/core/text-hygiene.ts` inspects blocks in a single zero-array newline scan:
- Source file reads (`FILE_READ_TOOL_RE`, numbered lines `123→`, declarations) and unified diffs (`diff --git`, `@@`, `---`/`+++` pairs) are marked **code-protected**.
- On code-protected blocks, terminal stripping cleans only literal ANSI escape sequences and leaves spaces, tabs, indentation, and repeated lines verbatim. Live-tail `read_file`/`view_file` responses stay verbatim until sealed into history so `Edit` / `apply_patch` / `replace_file_content` anchors remain exact.

## `P0` — Structural Normalization (`src/core/schema-compiler.ts`, `src/core/text-hygiene.ts`)

- **XML-Island `TSCG`**: Isolates `6` volatile `VOLATILE_XML_TAGS` (`<env>`, `<context>`, `<system-reminder>`, etc.) before deduplicating tool schemas (`96` chars) and static system text (`140` chars), while stripping redundant `$schema`/`$comment` metadata and preserving `dependent*` property containers.
- **Merkle Schema DAG**: Factors repeated JSON subschemas into shared `$defs._fN` entries on Anthropic and OpenAI wires (cleanly bypassed on Google wires).
- **Observation Hygiene, JSON Unwrap & `@toon`**: Emulates `\r`/`\x08`/ANSI (`emulateTerminal`), folds repetitive logs (`Drain`, anchored on stack frames/errors/`file:line`), unwraps single-level JSON-in-JSON across `8` wrapper keys (`output`, `stdout`, `stderr`, `content`, `result`, `body`, `text`, `data`) with `@fiche-kv` fallback, and encodes uniform arrays (`>=5` rows) into bijective `@toon`.
- **Opt-In User Prompt Hygiene**: `cleanUserPayloads` stays `false` by default across all `4` wires (protecting Turn-1 prompts `>= 4,000` chars); canonical pre-hygiene `firstUserSha8` stays unchanged everywhere.

## `P1` — `CASI v2` FastCDC & `seedBase` (`src/core/casi-delta.ts`)

- Strips line-number gutters, seeds bases directly from assistant `Write` / `Edit` calls (`seedBase`), aligns shifted re-reads via `lisAnchors`, restricts timestamp/duration canonicalization strictly to real log streams, and falls back to `GEAR_TABLE` FastCDC (`8–48` lines) to emit exact `[fiche cas-delta vs <refId>: ...]`.
- **Optical Mutual Exclusion**: Disabled automatically whenever Optical rendering is active (`!opticalEnabled`) so live tail diffs never emit orphan pointers into PNG plates.

## `P2` — `LSM-Context` Single-Block Sticky Epochs (`src/core/text-history.ts`)

- Seals large observations (`>= 1,500` tok) past `L1` (`tail = 2`) and aged blocks past `L0` (`tail = 6`) **strictly as 1-block `[item]` sticky epochs** keyed by `(sessionKey, fnv64Hex)` with FIFO eviction — preventing multi-block coalesce from breaking warm KV prefixes.
- Triggers `L2` cold-cache repack only when upstream `usage` confirms cache expiration (`everCacheAlive && !lastCacheAlive`, `1h + 30s` idle, or `413` backstop) with `justRepacked` cooldown across all `5` provider cache-read JSON `usage` fields.

## `P3` — `Context-MMU` Virtual Memory (`src/core/context-mmu.ts`)

- **Virtual Paging (`ContextPageStore`)**: Indexes evicted blocks under deterministic zero-`Buffer` UTF-8 `pg_<12hex>` IDs in a per-`sessionKey` RAM-first LRU (`512` pages / `16 MiB`; opt-in `FICHE_MMU_PERSIST=1`).
- **Turn-1 Skill Linker (`linkSessionSkills`)**: Keeps `DEFAULT_CORE_SKILLS` + top `6` task-relevant skills on Turn 1, stubs remaining `>= 10`-skill catalog descriptions as `[pgId]`, persists pinned skill hashes in `session-state.ts`, and auto-hydrates later mentions.
- **`FAIL→PASS` Markovian Folding (`foldMarkovianEpisodes`)**: Anchors on the first failing test/command, preserves pre-failure file reads, checks payback/cliff economics before archiving into `ContextPageStore`, and collapses resolved loops once verified.
- **Birth-Time IDF Pruning (`pruneLowDensityBlob`) & Live-Tail Hydration (`computeTailHydration`)**: Coalesces noisy unstructured search/log dumps while sparing code/JSON/YAML/stack frames, and injects `±15`-line symbol slices strictly inside the uncached trailing live turn (`[fiche vm-hydrate]`, `MAX_DEREF_CHARS = 65_536`).
