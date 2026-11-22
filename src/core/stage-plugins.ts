/**
 * Extensible pipeline stages & skills registry (edge/browser-safe: zero `node:` imports).
 *
 * Built-in stages represent Fiche's 5 deterministic/optical compiler stages.
 * Node hosts discover custom `~/.fiche/plugins/` manifests and `~/.agents/skills/`
 * / `~/.gemini/config/plugins/fiche-telemetry/skills/` entries and merge them with
 * persisted enabled overrides via `mergeStagePlugins()`.
 */

export type PipelineStage = 'pre-hygiene' | 'hygiene' | 'history' | 'optical' | 'skill';
export type PluginKind = 'builtin' | 'custom' | 'skill';

export interface StagePluginDescriptor {
  readonly id: string;
  readonly name: string;
  readonly stage: PipelineStage;
  readonly kind: PluginKind;
  readonly description: string;
  readonly enabled: boolean;
  readonly version?: string;
  readonly sourcePath?: string;
}

export type PluginOverrides = Record<string, boolean>;

const VALID_STAGES: ReadonlySet<PipelineStage> = new Set([
  'pre-hygiene',
  'hygiene',
  'history',
  'optical',
  'skill',
]);

/** Built-in Fiche context-compiler pipeline stages, enabled by default. */
export const BUILTIN_STAGE_PLUGINS: readonly StagePluginDescriptor[] = [
  {
    id: 'optical-microfiche',
    name: 'Optical Microfiche',
    stage: 'optical',
    kind: 'builtin',
    description: 'Renders bulky stale context into dense lossless PNG pages for strong page readers.',
    enabled: true,
  },
  {
    id: 'tscg-schema',
    name: 'TSCG Schema Compiler',
    stage: 'pre-hygiene',
    kind: 'builtin',
    description: 'Deterministic prefix-safe tool schema and static system-prompt compaction.',
    enabled: true,
  },
  {
    id: 'toon-structured',
    name: 'TOON Structured Encoder',
    stage: 'hygiene',
    kind: 'builtin',
    description: 'Lossless tabular TOON encoding for repetitive JSON array payloads in tool outputs.',
    enabled: true,
  },
  {
    id: 'acdc-epochs',
    name: 'ACDC Epoch Collapse',
    stage: 'history',
    kind: 'builtin',
    description: 'Amortized cache-safe deterministic collapsing of older text history turns.',
    enabled: true,
  },
  {
    id: 'casi-delta',
    name: 'CASI Delta Deduplicator',
    stage: 'hygiene',
    kind: 'builtin',
    description: 'Content-addressed duplicate and delta referencing across live tool outputs.',
    enabled: true,
  },
];

export function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id.trim());
}

/** True for third-party plugins and extensions (built-in compiler stages and fiche's own skill stay excluded). */
export function isThirdPartyPlugin(plugin: Pick<StagePluginDescriptor, 'id' | 'kind'>): boolean {
  return plugin.kind !== 'builtin' && plugin.id !== 'skill:fiche';
}

/** Parse a `plugin.json` manifest into a StagePluginDescriptor, or null if malformed. */
export function parsePluginManifest(
  rawJson: string,
  fallbackId: string,
  sourcePath?: string,
): StagePluginDescriptor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const rawId = typeof obj.id === 'string' && obj.id.trim()
    ? obj.id.trim()
    : typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : fallbackId.trim();
  if (!isValidPluginId(rawId)) return null;
  const name = typeof obj.displayName === 'string' && obj.displayName.trim()
    ? obj.displayName.trim()
    : typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : rawId;
  const stage: PipelineStage =
    typeof obj.stage === 'string' && VALID_STAGES.has(obj.stage as PipelineStage)
      ? (obj.stage as PipelineStage)
      : 'hygiene';
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : true;
  const version = typeof obj.version === 'string' && obj.version.trim() ? obj.version.trim() : undefined;
  return {
    id: rawId,
    name,
    stage,
    kind: 'custom',
    description,
    enabled,
    ...(version !== undefined ? { version } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  };
}

/** Parse YAML frontmatter from a `SKILL.md` file into a skill StagePluginDescriptor. */
export function parseSkillManifest(
  markdown: string,
  fallbackId: string,
  sourcePath?: string,
): StagePluginDescriptor | null {
  const cleanFallback = fallbackId.trim();
  if (!cleanFallback) return null;
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  let name = cleanFallback;
  let description = '';
  if (fmMatch && fmMatch[1]) {
    for (const rawLine of fmMatch[1].split(/\r?\n/)) {
      const sep = rawLine.indexOf(':');
      if (sep <= 0) continue;
      const key = rawLine.slice(0, sep).trim().toLowerCase();
      let val = rawLine.slice(sep + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key === 'name' && val) name = val;
      else if (key === 'description' && val) description = val;
    }
  }
  const idBase = cleanFallback.startsWith('skill:') ? cleanFallback : `skill:${cleanFallback}`;
  return {
    id: idBase,
    name,
    stage: 'skill',
    kind: 'skill',
    description,
    enabled: true,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  };
}

/** Merge built-in stages with discovered custom plugins/skills and persisted overrides. */
export function mergeStagePlugins(
  discovered: readonly StagePluginDescriptor[],
  overrides: PluginOverrides = {},
): StagePluginDescriptor[] {
  const byId = new Map<string, StagePluginDescriptor>();
  for (const builtin of BUILTIN_STAGE_PLUGINS) {
    const enabled = typeof overrides[builtin.id] === 'boolean' ? overrides[builtin.id]! : builtin.enabled;
    byId.set(builtin.id, { ...builtin, enabled });
  }
  for (const item of discovered) {
    // Built-in stage IDs stay authoritative so third-party manifests cannot shadow core stages.
    if (byId.has(item.id)) continue;
    const enabled = typeof overrides[item.id] === 'boolean' ? overrides[item.id]! : item.enabled;
    byId.set(item.id, { ...item, enabled });
  }
  return [...byId.values()];
}
