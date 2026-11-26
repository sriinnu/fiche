/**
 * Syncs Fiche's `models` allowlist from a local Kosha model registry snapshot
 * (`~/.kosha/registry.json`, `$KOSHA_REGISTRY`, `--file <path>`, or
 * `kosha registry export` CLI fallback).
 *
 * Node-only module: never imported from `src/core/`.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderId } from './core/upstream-hosts.js';

export interface KoshaRegistryModel {
  readonly id?: string;
  readonly modelId?: string;
  readonly provider?: string;
  readonly providerId?: string;
  readonly mode?: string | null;
  readonly status?: string | null;
}

export interface KoshaRegistryProviderBlock {
  readonly id?: string;
  readonly providerId?: string;
  readonly models?: readonly KoshaRegistryModel[];
}

export interface KoshaRegistrySnapshot {
  readonly schemaVersion?: number | string;
  readonly discoveredAt?: string;
  readonly models?: readonly KoshaRegistryModel[];
  readonly providers?: readonly KoshaRegistryProviderBlock[];
}

export interface KoshaExtractOptions {
  readonly providers: readonly ProviderId[];
}

export interface KoshaExtractResult {
  readonly bases: string[];
  readonly scannedModels: number;
  readonly matchedModels: number;
  readonly providersMatched: ProviderId[];
}

/**
 * Map Kosha provider identifiers (including `-cn` and billing/coding sub-feeds)
 * to Fiche's canonical `ProviderId` values.
 */
export const KOSHA_PROVIDER_TO_FICHE: Readonly<Record<string, ProviderId>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  kimi: 'kimi',
  moonshot: 'kimi',
  'moonshot-cn': 'kimi',
  glm: 'glm',
  zai: 'glm',
  'zai-coding-plan': 'glm',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  qwen: 'qwen',
  alibaba: 'qwen',
  'alibaba-cn': 'qwen',
  'alibaba-token-plan': 'qwen',
  openrouter: 'openrouter',
  xai: 'xai',
  groq: 'groq',
  together: 'together',
  fireworks: 'fireworks',
  cerebras: 'cerebras',
  mistral: 'mistral',
  perplexity: 'perplexity',
  cohere: 'cohere',
  sambanova: 'sambanova',
  github: 'github',
  azure: 'azure',
  vercel: 'vercel',
};

const SKIP_EXACT_PLACEHOLDERS = new Set([
  'auto',
  'search',
  'container',
  'aqa',
  'chat-latest',
  'chat',
  'default',
  'latest',
  'free',
  'firerouter',
  'gpt',
  'claude',
]);

const NON_LLM_MODALITY_RE =
  /(?:^|[-_.])(embed|embedding|rerank|moderation|safeguard|prompt-guard|whisper|tts|audio|speech|voice|asr|ocr|transcribe|realtime|image|flux|sora|veo|lyria|imagen|video)(?:$|[-_.])/;

const TRAILING_DATE_RE = /(?:-\d{4}-\d{2}-\d{2}|-\d{2}-\d{4}|-\d{8}|-\d{6}|-\d{4})+$/g;
const TRAILING_VARIANT_RE =
  /-(?:latest|preview|beta|ga|exp|fast|highspeed|non-reasoning|reasoning|thinking|instruct|chat|fp8|bf16|turbo)$/g;

/**
 * Normalize a raw Kosha model ID into a clean, deduplicatable model-base entry
 * suitable for `FICHE_MODELS` / `~/.config/fiche/config.json` `models`.
 * Returns `null` for aliases (`~...`), router endpoints (`/routers/`),
 * placeholders (`auto`, `chat-latest`, `free`, `firerouter`, overly-broad `gpt`/`claude`),
 * non-LLM modalities (embeddings, audio, voice, asr, ocr, image, video, moderation),
 * or malformed IDs.
 */
export function normalizeKoshaModelBase(rawId: string): string | null {
  let s = String(rawId || '').trim().toLowerCase();
  if (!s || s.startsWith('~') || s.includes('/routers/')) return null;

  // Strip bracketed context tags (e.g. `[1m]`)
  s = s.replace(/\[[^\]]*\]/g, '');

  // Strip provider/account namespace segments (`google/gemini-...`, `accounts/fireworks/models/...`)
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);

  // Strip colon routing/variant suffixes (`:free`, `:exacto`, `:peft:...`, `:0813`)
  // and Vertex `@version` / `@date` suffixes (`claude-opus-5-5@20261001`).
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(0, at);

  s = s.trim();
  if (!s || SKIP_EXACT_PLACEHOLDERS.has(s)) return null;

  let prev: string;
  do {
    prev = s;
    s = s.replace(TRAILING_DATE_RE, '');
    s = s.replace(TRAILING_VARIANT_RE, '');
    s = s.replace(TRAILING_DATE_RE, '');
  } while (s !== prev);

  if (
    !s ||
    (s.length < 3 && !/^o[1-9]$/.test(s)) ||
    SKIP_EXACT_PLACEHOLDERS.has(s) ||
    NON_LLM_MODALITY_RE.test(s)
  ) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(s)) return null;

  // Collapse every Gemini variant to the family base `gemini` (matches DEFAULT_MODEL_BASES).
  if (s === 'gemini' || s.startsWith('gemini-')) return 'gemini';
  return s;
}

function iterSnapshotModels(
  snapshot: KoshaRegistrySnapshot,
): Array<{ providerRaw: string; modelRaw: string; mode: string; status: string }> {
  const out: Array<{ providerRaw: string; modelRaw: string; mode: string; status: string }> = [];
  const push = (m: KoshaRegistryModel, fallbackProvider?: string) => {
    const modelRaw = String(m.modelId ?? m.id ?? '').trim();
    const providerRaw = String(m.providerId ?? m.provider ?? fallbackProvider ?? '').trim();
    if (!modelRaw || !providerRaw) return;
    out.push({
      providerRaw,
      modelRaw,
      mode: String(m.mode ?? 'chat').toLowerCase(),
      status: String(m.status ?? '').toLowerCase(),
    });
  };
  if (Array.isArray(snapshot.models)) {
    for (const m of snapshot.models) {
      if (m && typeof m === 'object') push(m);
    }
  }
  if (Array.isArray(snapshot.providers)) {
    for (const p of snapshot.providers) {
      if (!p || typeof p !== 'object' || !Array.isArray(p.models)) continue;
      const fallbackProvider = String(p.providerId ?? p.id ?? '').trim();
      for (const m of p.models) {
        if (m && typeof m === 'object') push(m, fallbackProvider);
      }
    }
  }
  return out;
}

function modelBaseCovers(prefix: string, candidate: string): boolean {
  const p = prefix.toLowerCase();
  const c = candidate.toLowerCase();
  return c === p || c.startsWith(`${p}-`);
}

/**
 * Extract normalized, deduplicated, prefix-collapsed chat model bases for the
 * selected Fiche providers from a Kosha registry snapshot.
 */
export function extractKoshaModelBases(
  snapshot: KoshaRegistrySnapshot,
  opts: KoshaExtractOptions,
): KoshaExtractResult {
  const allowedProviders = new Set<ProviderId>(opts.providers);
  const rawBases = new Set<string>();
  const providersMatched = new Set<ProviderId>();
  const entries = iterSnapshotModels(snapshot);
  let matchedModels = 0;

  for (const item of entries) {
    if (item.mode !== 'chat') continue;
    if (item.status === 'retired' || item.status === 'deprecated') continue;
    const mapped = KOSHA_PROVIDER_TO_FICHE[item.providerRaw.toLowerCase()];
    if (!mapped || !allowedProviders.has(mapped)) continue;
    const base = normalizeKoshaModelBase(item.modelRaw);
    if (!base) continue;
    matchedModels += 1;
    providersMatched.add(mapped);
    rawBases.add(base);
  }

  // Collapse prefix-redundant children (e.g. keep `claude-fable-5`, drop `claude-fable-5-1`).
  const shortestFirst = [...rawBases].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const candidate of shortestFirst) {
    if (kept.some((prefix) => modelBaseCovers(prefix, candidate))) continue;
    kept.push(candidate);
  }
  kept.sort((a, b) => a.localeCompare(b));

  return {
    bases: kept,
    scannedModels: entries.length,
    matchedModels,
    providersMatched: [...providersMatched].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Merge newly discovered Kosha model bases with Fiche's current `models` list.
 * Preserves existing bases and skips any discovered base already covered by an
 * existing shorter prefix (`deepseek` already matches `deepseek-coder`), unless
 * `replace` is true.
 */
export function mergeModelBases(
  existing: readonly string[],
  discovered: readonly string[],
  replace: boolean,
): { merged: string[]; added: string[] } {
  const existingClean = [...new Set(existing.map((s) => s.trim()).filter(Boolean))];
  if (replace) {
    const replaced = [...new Set(discovered.map((s) => s.trim()).filter(Boolean))];
    const added = replaced.filter(
      (cand) => !existingClean.some((e) => modelBaseCovers(e, cand)),
    );
    return { merged: replaced, added };
  }

  const merged = [...existingClean];
  const added: string[] = [];
  for (const cand of discovered) {
    const clean = cand.trim();
    if (!clean) continue;
    if (merged.some((cur) => modelBaseCovers(cur, clean))) continue;
    merged.push(clean);
    added.push(clean);
  }
  return { merged, added };
}

/**
 * Load a Kosha registry snapshot from `--file`, `$KOSHA_REGISTRY`,
 * `~/.kosha/registry.json`, or `kosha registry export`.
 */
export function loadKoshaSnapshot(explicitFile?: string): {
  snapshot: KoshaRegistrySnapshot;
  source: string;
} {
  if (explicitFile) {
    const resolved = path.resolve(explicitFile);
    let raw: string;
    try {
      raw = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      throw new Error(`Could not read Kosha registry file ${resolved}: ${(e as Error).message}`);
    }
    return { snapshot: parseRegistryObject(raw, resolved), source: resolved };
  }

  const candidates: string[] = [];
  const envPath = process.env.KOSHA_REGISTRY?.trim();
  if (envPath) candidates.push(path.resolve(envPath));
  candidates.push(path.join(os.homedir(), '.kosha', 'registry.json'));

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    return { snapshot: parseRegistryObject(raw, filePath), source: filePath };
  }

  const proc = spawnSync('kosha', ['registry', 'export'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000,
  });
  if (proc.error || proc.status !== 0 || !proc.stdout?.trim()) {
    const detail = proc.error?.message || proc.stderr?.trim() || `exit ${proc.status ?? 'unknown'}`;
    throw new Error(
      `Could not load Kosha registry (~/.kosha/registry.json not found and \`kosha registry export\` failed: ${detail}). Run \`kosha update\` or pass \`--file <path>\`.`,
    );
  }
  return {
    snapshot: parseRegistryObject(proc.stdout, 'kosha registry export'),
    source: 'kosha registry export',
  };
}

function parseRegistryObject(raw: string, label: string): KoshaRegistrySnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(`Invalid Kosha registry JSON from ${label}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid Kosha registry root from ${label}: expected JSON object`);
  }
  return parsed as KoshaRegistrySnapshot;
}
