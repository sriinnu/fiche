/**
 * Node entrypoint — `node:http` server + minimal CLI flag parsing.
 *
 * Wraps the runtime-agnostic `createProxy` from src/core/proxy.ts. The
 * heavy lifting (transform, render, PNG) is identical to the Worker
 * version; only the request/response plumbing differs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ensureLaunchdSocketShim, resolveInheritedListenFd } from './launchd-socket.js';
import { createWarpRuntime, loadOrCreateWarpToken } from './warp/index.js';
import { createNodeUpstreamFetch } from './node-fetch.js';
import {
  renderShellInitScript,
  resolveMacAppBundle,
  type ResolvedMacApp,
} from './warp/app-launch.js';
import { runMcpCommand } from './mcp/cli.js';
import { once } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isIP, Server as NetServer, type Socket } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createProxy,
  parseGatewayHeaders,
  resolveTrustAdjacentToolRoundsEnv,
  resolveUpstreams,
  type ProxyConfig,
} from './core/proxy.js';
import { readBrandEnv } from './core/env.js';
import { getAllowedModelBases, setAllowedModelBases } from './core/applicability.js';
import { guardProxyRequest, parseAllowedHosts } from './core/request-guard.js';
import {
  buildUpstreamRegistry,
  detectProvidersFromEnv,
  getEnabledProviders,
  listProviderStatuses,
  normalizeProviderId,
  parseProvidersSpec,
  parseUpstreamHosts,
  PROVIDER_CATALOG,
  setEnabledProviders,
  type ProviderId,
} from './core/upstream-hosts.js';
import { isRunnable } from './warp/resolve.js';
import {
  isThirdPartyPlugin,
  mergeStagePlugins,
  parsePluginManifest,
  parseSkillManifest,
  stageTogglesFromOverrides,
  type PluginOverrides,
  type StagePluginDescriptor,
} from './core/stage-plugins.js';
import { FileTracker } from './file-tracker.js';
import {
  chatCompletionsUrl,
} from './core/messages-chat-bridge.js';
import {
  parseExportArgv,
  runExportCore,
  type ExportParsed,
  type ExportResult,
} from './core/export.js';
import { readExportTextFile } from './export-collect.js';
import { decodeRequestBodyWithStatus } from './request-decoding.js';
import {
  redactSecrets,
  toTrackEvent,
  TRACK_BODY_INLINE_MAX,
  type Tracker,
  type TrackEvent,
} from './core/tracker.js';
import {
  configureMaxSessions,
  configureSessionStateStore,
  flushSessionState,
  type SessionStateStore,
} from './core/session-state.js';
import {
  DashboardState,
  dashboardPath,
  dispatchDashboard,
  isDashboardMutation,
} from './dashboard.js';
import { runStats } from './stats.js';
import { defaultEventsFilePath, runTurnReportCli } from './turn-report.js';
import {
  defaultCalibratedProfilesPath,
  loadCalibratedProfilesFile,
  runCalibrationCli,
} from './calibrate.js';
import {
  configureMmuLimits,
  configureMmuPersistence,
  flushMmuPersistence,
  getGlobalMmuStore,
} from './core/context-mmu.js';
import { fileMmuPersistenceStore, MMU_CLI_USAGE, parseMmuCliArgs } from './mmu-store.js';
import {
  extractKoshaModelBases,
  loadKoshaSnapshot,
  mergeModelBases,
  type KoshaRegistrySnapshot,
} from './kosha-sync.js';

/** Runtime config. The core transform tuning comes from DEFAULTS in
 *  transform.ts; startup knobs cover deployment plus emergency GPT scope
 *  control. No CLI flags beyond --help/--version. */
interface RuntimeConfig {
  port: number;
  /** Interface to bind. Defaults to 127.0.0.1; non-loopback bindings expose
   *  only the proxy API because dashboard routes remain loopback-only. */
  host: string;
  upstream: string;
  sharedUpstream?: string;
  openAIUpstream: string;
  openAIApiKey?: string;
  googleUpstream?: string;
  /** Independent Cloudflare OpenAI-compatible endpoint. */
  cloudflareUpstream?: string;
  cloudflareApiKey?: string;
  openAIModels?: string[];
  cloudflareModels?: string[];
  provider?: 'cloudflare-ai-gateway';
  gatewayBaseUrl?: string;
  gatewayHeaders?: Record<string, string>;
  eventsFile: string;
  /** Where the per-session cache pins survive a restart; undefined = off. */
  sessionStateFile?: string;
  /** Persist 4xx request and upstream error bodies for debugging. Off unless
   *  INKLING_DEBUG_CAPTURE_4XX=1. */
  captureErrorReqBody: boolean;
  /** Ceiling on a buffered inbound request body. Unset leaves the core default
   *  (16 MiB). Raise it only if a real client needs more; the default binding is
   *  loopback, but HOST can expose this process to a network. */
  maxRequestBytes?: number;
}

const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.config', 'fiche', 'config.json');
const LEGACY_CONFIG_FILE = path.join(os.homedir(), '.config', 'inkling', 'config.json');
const DEFAULT_EVENTS_FILE = path.join(os.homedir(), '.fiche', 'events.jsonl');
const DEFAULT_SESSION_STATE_FILE = path.join(os.homedir(), '.fiche', 'session-state.json');

/** FICHE_SESSION_STATE (or INKLING_SESSION_STATE): a path, or 0/off/false/no to disable. */
function resolveSessionStateFile(): string | undefined {
  const raw = readBrandEnv('SESSION_STATE')?.trim();
  if (raw === undefined || raw === '') return DEFAULT_SESSION_STATE_FILE;
  if (/^(0|off|false|no)$/i.test(raw)) return undefined;
  return raw;
}

function atomicWriteFileSync(
  filePath: string,
  data: string | Uint8Array,
  opts: { mode?: number; dirMode?: number; fsync?: boolean } = {},
): void {
  const mode = opts.mode ?? 0o600;
  const dirMode = opts.dirMode ?? 0o700;
  const fsync = opts.fsync ?? true;
  const dir = path.dirname(filePath);
  const parentExists = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  if (!parentExists) fs.chmodSync(dir, dirMode);
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      mode,
    );
    const buf =
      typeof data === 'string'
        ? Buffer.from(data, 'utf8')
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    while (offset < buf.length) {
      const n = fs.writeSync(fd, buf, offset, buf.length - offset);
      if (n <= 0) throw new Error('short write returned 0 bytes');
      offset += n;
    }
    fs.fchmodSync(fd, mode);
    if (fsync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * File-backed {@link SessionStateStore}. Same write-then-rename discipline as the
 * config writer above: a crash mid-write leaves the previous file intact. Mode
 * 0600 — the file holds session fingerprints (sha8 of the first user turn) and
 * counters, never prompt text, but it is still per-user state.
 */
function fileSessionStateStore(file: string): SessionStateStore {
  return {
    load(): string | undefined {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },
    save(text: string): void {
      atomicWriteFileSync(file, text, { mode: 0o600, dirMode: 0o700, fsync: true });
    },
  };
}

function normalizeCsvConfig(value: unknown, emptyToken: 'off' | 'none' = 'off'): string | undefined {
  if (Array.isArray(value)) {
    const items = value.map((v) => String(v).trim()).filter(Boolean);
    return items.length > 0 ? items.join(',') : emptyToken;
  }
  if (typeof value === 'string') return value.trim() || emptyToken;
  return undefined;
}

function readConfigObject(): { file: string; cfg: Record<string, unknown> } | null {
  const explicit = readBrandEnv('CONFIG');
  const file = explicit ?? (fs.existsSync(DEFAULT_CONFIG_FILE) || !fs.existsSync(LEGACY_CONFIG_FILE) ? DEFAULT_CONFIG_FILE : LEGACY_CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    console.warn(`[fiche] ignored invalid config ${file}: ${(e as Error).message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return { file, cfg: parsed as Record<string, unknown> };
}

function normalizePositiveIntConfig(raw: unknown): string | undefined {
  const n = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== ''
      ? Number(raw.trim())
      : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return String(Math.floor(n));
}

function parseOptionalPositiveIntEnv(name: string): number | undefined {
  const raw = readBrandEnv(name)?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function applyConfigFileDefaults(): void {
  const loaded = readConfigObject();
  if (!loaded) return;
  const { cfg } = loaded;

  // Env wins over file config. The dashboard can still override the scope at
  // runtime (in-memory) for an emergency live flip.
  if (readBrandEnv('MODELS') === undefined) {
    const models = normalizeCsvConfig(cfg.models, 'off');
    if (models !== undefined) process.env.FICHE_MODELS = models;
  }
  if (readBrandEnv('PROVIDERS') === undefined) {
    const providers = normalizeCsvConfig(cfg.providers, 'none');
    if (providers !== undefined) process.env.FICHE_PROVIDERS = providers;
  }
  if (readBrandEnv('UPSTREAM_HOSTS') === undefined && cfg.custom_hosts !== undefined) {
    const hosts = Array.isArray(cfg.custom_hosts)
      ? cfg.custom_hosts.map((v) => String(v).trim()).filter(Boolean).join(',')
      : typeof cfg.custom_hosts === 'string'
        ? cfg.custom_hosts.trim()
        : undefined;
    if (hosts) process.env.FICHE_UPSTREAM_HOSTS = hosts;
  }
  if (readBrandEnv('MMU_MAX_PAGES') === undefined) {
    const v = normalizePositiveIntConfig(cfg.mmu_max_pages);
    if (v !== undefined) process.env.FICHE_MMU_MAX_PAGES = v;
  }
  if (readBrandEnv('MMU_MAX_MB') === undefined) {
    const v = normalizePositiveIntConfig(cfg.mmu_max_mb);
    if (v !== undefined) process.env.FICHE_MMU_MAX_MB = v;
  }
  if (readBrandEnv('MAX_SESSIONS') === undefined) {
    const v = normalizePositiveIntConfig(cfg.max_sessions);
    if (v !== undefined) process.env.FICHE_MAX_SESSIONS = v;
  }
}

/** Atomically merge keys into ~/.config/fiche/config.json (preserving unrelated keys). */
function persistConfigPatch(patch: Record<string, unknown>): boolean {
  const file = readBrandEnv('CONFIG') ?? DEFAULT_CONFIG_FILE;
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[fiche] could not persist config: invalid config object ${file}`);
      return false;
    }
    cfg = parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[fiche] could not persist config ${file}: ${(e as Error).message}`);
      return false;
    }
  }
  Object.assign(cfg, patch);
  try {
    atomicWriteFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
      fsync: true,
    });
    return true;
  } catch (e) {
    console.warn(`[fiche] could not persist config to ${file}: ${(e as Error).message}`);
    return false;
  }
}

function persistModelBasesToConfig(bases: readonly string[]): void {
  persistConfigPatch({ models: [...bases] });
}

function persistProvidersToConfig(providers: readonly ProviderId[]): void {
  persistConfigPatch({ providers: [...providers] });
}

function persistCustomHostsToConfig(hosts: readonly string[]): void {
  persistConfigPatch({ custom_hosts: [...hosts] });
}

// ---- Stage plugins & skills discovery + persistence ------------------------

function resolvePluginsConfigFile(): string {
  return readBrandEnv('PLUGINS_CONFIG')?.trim()
    || path.join(os.homedir(), '.config', 'fiche', 'plugins.json');
}

const FORBIDDEN_OVERRIDE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let pluginOverridesCache:
  | { file: string; mtimeMs: number; ino: number; size: number; overrides: PluginOverrides }
  | undefined;

function loadPluginOverrides(file = resolvePluginsConfigFile()): PluginOverrides {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Object.create(null) as PluginOverrides;
    }
    const out = Object.create(null) as PluginOverrides;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (FORBIDDEN_OVERRIDE_KEYS.has(k)) continue;
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return Object.create(null) as PluginOverrides;
  }
}

function getActivePluginOverrides(file = resolvePluginsConfigFile()): PluginOverrides {
  let mtimeMs = -1;
  let ino = -1;
  let size = -1;
  try {
    const st = fs.statSync(file);
    mtimeMs = st.mtimeMs;
    ino = st.ino;
    size = st.size;
  } catch {
    mtimeMs = -1;
  }
  if (
    pluginOverridesCache &&
    pluginOverridesCache.file === file &&
    pluginOverridesCache.mtimeMs === mtimeMs &&
    pluginOverridesCache.ino === ino &&
    pluginOverridesCache.size === size
  ) {
    return pluginOverridesCache.overrides;
  }
  const overrides = mtimeMs >= 0 ? loadPluginOverrides(file) : (Object.create(null) as PluginOverrides);
  pluginOverridesCache = { file, mtimeMs, ino, size, overrides };
  return overrides;
}

function savePluginOverrides(overrides: PluginOverrides, file = resolvePluginsConfigFile()): void {
  const sanitized = Object.create(null) as PluginOverrides;
  for (const [k, v] of Object.entries(overrides)) {
    if (!FORBIDDEN_OVERRIDE_KEYS.has(k) && typeof v === 'boolean') {
      sanitized[k] = v;
    }
  }
  atomicWriteFileSync(file, `${JSON.stringify(sanitized, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
    fsync: true,
  });
  pluginOverridesCache = undefined;
}

function discoverCustomPlugins(pluginsRoot: string, out: StagePluginDescriptor[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifestPath = path.join(pluginsRoot, entry.name, 'plugin.json');
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = parsePluginManifest(raw, entry.name, manifestPath);
      if (parsed) out.push(parsed);
    } catch {
      // Missing or unreadable plugin.json
    }
  }
}

function discoverSkillsDir(skillsRoot: string, out: StagePluginDescriptor[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    try {
      const raw = fs.readFileSync(skillPath, 'utf8');
      const parsed = parseSkillManifest(raw, entry.name, skillPath);
      if (parsed) out.push(parsed);
    } catch {
      // Missing or unreadable SKILL.md
    }
  }
}

function listNodeStagePlugins(): StagePluginDescriptor[] {
  const home = os.homedir();
  const discovered: StagePluginDescriptor[] = [];
  const customDir = readBrandEnv('PLUGINS_DIR')?.trim() || path.join(home, '.fiche', 'plugins');
  discoverCustomPlugins(customDir, discovered);
  discoverSkillsDir(path.join(home, '.agents', 'skills'), discovered);
  discoverSkillsDir(
    path.join(home, '.gemini', 'config', 'plugins', 'fiche-companion', 'skills'),
    discovered,
  );
  discoverSkillsDir(
    path.join(home, '.gemini', 'config', 'plugins', 'fiche-telemetry', 'skills'),
    discovered,
  );
  return mergeStagePlugins(discovered, loadPluginOverrides());
}

function setNodePluginEnabled(
  id: string,
  enabled: boolean,
): { plugin: StagePluginDescriptor; plugins: StagePluginDescriptor[] } | null {
  const current = listNodeStagePlugins();
  if (!current.some((p) => p.id === id)) return null;
  const overrides = loadPluginOverrides();
  overrides[id] = enabled;
  try {
    savePluginOverrides(overrides);
  } catch (err) {
    console.warn(`[fiche] could not persist plugin overrides: ${(err as Error).message}`);
  }
  const plugins = listNodeStagePlugins();
  const plugin = plugins.find((p) => p.id === id);
  return plugin ? { plugin, plugins } : null;
}

function setNodeThirdPartyPluginsEnabled(
  enabled: boolean,
): { updatedCount: number; enabled: boolean; plugins: StagePluginDescriptor[] } {
  const current = listNodeStagePlugins();
  const overrides = loadPluginOverrides();
  let updatedCount = 0;
  for (const item of current) {
    if (!isThirdPartyPlugin(item)) continue;
    overrides[item.id] = enabled;
    updatedCount += 1;
  }
  try {
    savePluginOverrides(overrides);
  } catch (err) {
    console.warn(`[fiche] could not persist plugin overrides: ${(err as Error).message}`);
  }
  return { updatedCount, enabled, plugins: listNodeStagePlugins() };
}

function resolvePortEnvRaw(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fichePort = env.FICHE_PORT?.trim();
  if (fichePort) return fichePort;
  return env.PORT;
}

function parseEnvPort(raw: string | undefined = resolvePortEnvRaw()): number {
  if (raw === undefined || !raw.trim()) return 47821;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 47821;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 && n <= 65535 ? n : 47821;
}

function parseStrictPortArg(raw: string | undefined, context: string): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) {
    console.error(`[fiche] ${context}: invalid --port value "${raw ?? ''}" (expected integer 1..65535)`);
    process.exit(2);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    console.error(`[fiche] ${context}: --port out of range "${raw ?? ''}" (expected 1..65535)`);
    process.exit(2);
  }
  return n;
}

function resolveWarpTokenDir(): string {
  const ficheHomeDir = path.join(os.homedir(), '.fiche');
  const legacyHomeDir = path.join(os.homedir(), '.inkling');
  return fs.existsSync(ficheHomeDir) || !fs.existsSync(legacyHomeDir) ? ficheHomeDir : legacyHomeDir;
}

function readExistingWarpToken(): string | undefined {
  const tokenPath = path.join(resolveWarpTokenDir(), 'warp-token');
  let fd: number | undefined;
  try {
    fd = fs.openSync(tokenPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size <= 0 || st.size > 256) return undefined;
    const token = fs.readFileSync(fd, 'utf8').trim();
    return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

const DEFAULT_SHUTDOWN_DRAIN_MS = 60_000;
const MAX_SHUTDOWN_DRAIN_MS = 600_000;

function parseShutdownDrainMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_SHUTDOWN_DRAIN_MS;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_SHUTDOWN_DRAIN_MS
    ? n
    : DEFAULT_SHUTDOWN_DRAIN_MS;
}

function parseCli(argv: string[]): RuntimeConfig {
  // Only flags accepted are --help and --version. Anything else is an
  // error — there is exactly ONE way to run fiche and the dashboard
  // exposes every metric the operator might want to inspect.
  for (const a of argv) {
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
    if (a === '--version') {
      printVersion();
      process.exit(0);
    }
    if (a.startsWith('-')) {
      console.error(`[fiche] unknown option: ${a}`);
      console.error(`[fiche] this build accepts no flags; run \`fiche --help\` for env vars`);
      process.exit(2);
    }
  }
  applyConfigFileDefaults();
  const sharedUpstream = readBrandEnv('UPSTREAM');
  const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const cfToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const parseModels = (value: string | undefined): string[] | undefined => {
    if (value === undefined) return undefined;
    return value.split(',').map((model) => model.trim()).filter(Boolean);
  };
  const cloudflareUpstream = cfAccount && cfToken
    ? `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/v1`
    : undefined;
  const trimmedShared = sharedUpstream?.trim() || undefined;
  return {
    port: parseEnvPort(resolvePortEnvRaw()),
    // Loopback by default; opt into all-interfaces exposure explicitly via HOST.
    host: process.env.HOST?.trim() || '127.0.0.1',
    upstream: process.env.ANTHROPIC_UPSTREAM?.trim() || trimmedShared || 'https://api.anthropic.com',
    sharedUpstream: trimmedShared,
    openAIUpstream: process.env.OPENAI_UPSTREAM?.trim() || trimmedShared || 'https://api.openai.com',
    openAIApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    googleUpstream: process.env.GOOGLE_UPSTREAM?.trim() || undefined,
    cloudflareUpstream,
    cloudflareApiKey: cfToken,
    openAIModels: parseModels(process.env.OPENAI_MODELS),
    cloudflareModels: parseModels(process.env.CLOUDFLARE_MODELS),
    provider: parseProvider(readBrandEnv('PROVIDER')),
    gatewayBaseUrl: readBrandEnv('GATEWAY_BASE_URL'),
    gatewayHeaders: parseGatewayHeaders(readBrandEnv('GATEWAY_HEADERS')),
    eventsFile: readBrandEnv('LOG') ?? DEFAULT_EVENTS_FILE,
    sessionStateFile: resolveSessionStateFile(),
    // Off by default: either side of a 4xx may hold prompts or secrets.
    // Opt in for debugging only. (issue #69)
    captureErrorReqBody: readBrandEnv('DEBUG_CAPTURE_4XX') === '1',
    maxRequestBytes: parseMaxRequestBytes(readBrandEnv('MAX_REQUEST_BYTES')),
  };
}

/** A bad limit exits instead of being ignored. The core also refuses to treat a
 *  broken value as "no limit", but a host that was asked for 8MB and silently ran
 *  at 16 would be a worse answer than a startup error. */
function parseMaxRequestBytes(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (raw === undefined || raw === '') return undefined;
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    console.error(
      `[fiche] FICHE_MAX_REQUEST_BYTES must be a positive whole number of bytes, got: ${value}`,
    );
    process.exit(2);
  }
  return bytes;
}

function parseProvider(v: string | undefined): 'cloudflare-ai-gateway' | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'cloudflare-ai-gateway') return v;
  console.error(`[fiche] unknown FICHE_PROVIDER: ${v}`);
  process.exit(2);
}

function printHelp(): void {
  console.log(`fiche — microfiche context compiler & token-saving proxy for coding agents

Usage:
  fiche                  run the proxy (no flags)
  fiche providers [...]  list/enable/disable/detect opted-in AI providers
                         (list | set | enable | disable | detect [--apply] | add-host | remove-host)
  fiche models [...]     list/enable/disable/sync-kosha models eligible for compression
                         (list | set | enable | disable | sync-kosha [--apply] [--all-providers] [--providers <csv>] [--file <path>] [--replace])
  fiche calibrate [...]  run synthetic Auto-Canary optical calibration for a model
                         (<model> [--provider ...] [--band auto|...] [--dry-run] [--list] [--clear <m>] [--json])
  fiche mmu [...]        inspect Context-MMU virtual memory stats and paged blocks
                         ([stats | pages | page <id>] [--query <text>] [--session <key>] [--port P] [--json])
  fiche export [...]     render files/diff to PNG pages + cost report (see fiche export --help)
  fiche mcp [--http P]   MCP server for every agent (stdio, or Streamable HTTP)
  fiche warp [--app <Name|Path>] [--port <N>] [--providers <csv|all|none>] [--all-providers] [--verbose] [--route PATTERN=TARGET]... -- CMD
                        run a CLI or macOS desktop app (Cursor, Antigravity,
                        Claude, ChatGPT/Codex...) behind the proxy without a
                        custom base URL, so client-side first-party gates keep
                        working. Only opted-in providers are intercepted.
  fiche shell-init [--wrap] [--port <N>]
                        print zsh/bash helper functions (fclaude, fcodex, fribhu,
                        fagy, fcursor, fiche-app) or transparent wrappers (--wrap).
  fiche stats [--json] [--file <p>]
                        summarize the events log offline (no server needed),
                        incl. measured savings; defaults to $FICHE_LOG
  fiche turn-report [--format cli|agy|claude-statusline|json]
                        report latest turn & session savings with zero LLM tokens
  fiche status [--json] alias for \`fiche service status\`
  fiche service <action>
                        manage macOS launchd background daemon
                        (install | uninstall | start | stop | restart | status)

The proxy compiles eligible tools, schemas, reminders, tool_results,
and history; tracks events to disk; and measures real saved_pct via
/v1/messages/count_tokens. Dashboard controls can disable compression live.

Live sessions and cleanup tools live in the dashboard at
  http://127.0.0.1:<port>/  (default port 47821)
For after-the-fact analysis without the server running, use fiche stats.

Flags:
  -h, --help              show this help
      --version           show version

Environment (legacy INKLING_* aliases are also accepted):
  FICHE_PORT              listen / target daemon port (default 47821; preferred over PORT)
  PORT                    fallback listen port if FICHE_PORT is unset (default 47821)
  HOST                    interface to bind (default 127.0.0.1, loopback only).
                          Non-loopback bindings expose only the proxy API;
                          dashboard routes remain loopback-only.
  FICHE_ALLOWED_HOSTS     extra Host/Origin names the proxy API accepts
                          (comma list; '*' turns the check off). Browser
                          requests from non-loopback pages, and Hosts that are
                          public DNS names (DNS rebinding), are refused.
  FICHE_FOLLOW_HOSTS      0 to stop following agents to their own provider
                          host (warp Host, or base URL .../to/<host>/). On by
                          default; only registered hosts, https:443, the
                          agent's own credential.
  FICHE_PROVIDERS         comma-separated built-in providers to intercept & follow
                          (default anthropic,openai,google; or 'all' / 'none').
                          Opt in to third-party hosts with \`fiche providers enable <id>\`.
  FICHE_WARP_VERBOSE      1 to print every expanded warp route line on startup
  FICHE_UPSTREAM_HOSTS    extra custom provider hosts to follow (comma list of
                          host[/api-prefix], e.g. llm.example.com/anthropic)
  FICHE_UPSTREAM          upstream API base for every API family
  ANTHROPIC_UPSTREAM      Anthropic API base; overrides FICHE_UPSTREAM
                           (default https://api.anthropic.com)
  OPENAI_UPSTREAM         OpenAI API base; overrides FICHE_UPSTREAM
                           (default https://api.openai.com)
  OPENAI_API_KEY          optional OpenAI key override; otherwise forwarded
  OPENAI_MODELS           comma-separated exact model ids routed to OpenAI
                          Responses
  CLOUDFLARE_MODELS       comma-separated exact model ids routed to Cloudflare
  CLOUDFLARE_ACCOUNT_ID   with CLOUDFLARE_API_TOKEN, zero-config Cloudflare
  CLOUDFLARE_API_TOKEN    Workers AI endpoint and bearer token
  FICHE_PROVIDER          optional: 'cloudflare-ai-gateway' — route both API
                          families through one gateway base URL
  FICHE_GATEWAY_BASE_URL  gateway base URL (required with FICHE_PROVIDER)
  FICHE_GATEWAY_HEADERS   extra upstream headers: JSON object or k=v;k2=v2
  FICHE_MODELS            comma-separated model bases allowed to compress
                          (default claude-fable-5,gemini).
                          Out-of-scope models pass through untouched. Weak or
                          unmeasured readers (Claude 5.5, Grok, Gemini 4
                          hydrogen/carbon/neon, GPT-6 Astra) use the 4-layer
                          text compiler (TSCG+TOON+CASI+ACDC), not images,
                          unless FICHE_FORCE_IMAGES=1.
  FICHE_FORCE_IMAGES      1 images weak readers too (Claude 5.5, Grok). Does not
                          re-enable prompt_cache_breakpoint on ChatGPT Codex.
  FICHE_CONFIG            JSON config path (default ~/.config/fiche/config.json)
                          supports {"providers": [...], "models": [...],
                          "custom_hosts": [...], "mmu_max_pages": N,
                          "mmu_max_mb": N, "max_sessions": N}
  FICHE_LOG               JSONL events path (default ~/.fiche/events.jsonl)
  FICHE_SESSION_STATE     where per-session cache pins (freeze-step floor, cache
                          liveness) survive a restart; 0/off disables
                          (default ~/.fiche/session-state.json). Without it a
                          restart drops every live session's floor.
  FICHE_MAX_SESSIONS      max tracked sessions in RAM (default 512, [64, 8192])
  FICHE_MMU_MAX_PAGES     max Context-MMU virtual pages in RAM (default 512, [64, 16384])
  FICHE_MMU_MAX_MB        max Context-MMU RAM budget in MiB (default 16, [4, 256])
  FICHE_MMU_PERSIST       1/true/on to persist non-secret Context-MMU pages
                          (24h idle TTL) alongside events.jsonl; default off
                          (daemon memory-only). Honored only when
                          FICHE_SESSION_STATE is not disabled.
  FICHE_DUMP_DIR          debug: write every rendered PNG here (what the model
                          sees); off unless set. Compress arm only.
  FICHE_RENDER_CACHE_BYTES  max bytes of rendered pages to keep in memory
                          (default 64 MiB here; 8 MiB on Workers, where the
                          isolate has ~128 MiB for everything). Frozen history
                          chunks are byte-identical across turns, so
                          re-rendering them is wasted CPU; 0 disables the cache.
                          Live counters at /proxy-stats under render_cache.
  FICHE_DEBUG_CAPTURE_4XX debug: set to 1 to persist full 4xx request and
                          upstream error bodies (prompts + any secrets in
                          context) to disk. Off by default.
  FICHE_SHUTDOWN_DRAIN_MS ms to wait for active proxy/SSE streams to finish
                          after SIGINT/SIGTERM before force-closing sockets
                          (default 60000 when active requests > 0, else 1500).
  FICHE_TRUST_ADJACENT_TOOL_ROUNDS  1 = let history collapse split adjacent tool
                          call/result pairs for every client; 0 = never. Unset:
                          on only for Claude Code (claude-cli/ UA + x-app: cli).

Use with Claude Code:
  ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude

Use with OpenAI-compatible GPT clients:
  OPENAI_BASE_URL=http://127.0.0.1:47821/v1
`);
}

// Package version, inlined at bundle time by scripts/build.mjs via esbuild
// `define`. Under a non-bundled dev runner (tsx) the identifier is not defined;
// `typeof` returns "undefined" instead of throwing (ECMA-262 §13.5.3), so the
// guard is safe. `npm_package_version` is only a dev fallback: npm sets it just
// inside its own run-script env, so for `npx @sriinnu/fiche` or a global bin it is
// undefined (or reflects the *consumer's* package), never this tool's version.
declare const __FICHE_VERSION__: string | undefined;
declare const __INKLING_VERSION__: string | undefined;

function resolvedCliVersion(): string {
  const injected =
    typeof __FICHE_VERSION__ === 'string'
      ? __FICHE_VERSION__
      : typeof __INKLING_VERSION__ === 'string'
        ? __INKLING_VERSION__
        : undefined;
  return injected ?? process.env.npm_package_version ?? '0.19.0';
}

function printVersion(): void {
  console.log(resolvedCliVersion());
}

// ---- node:http <-> Web Request/Response bridge ---------------------------

function toWebRequest(req: IncomingMessage, signal?: AbortSignal): Request {
  const rawProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0]!.trim().toLowerCase()
    : '';
  const proto = rawProto === 'https' || rawProto === 'http' ? rawProto : 'http';
  const host = req.headers.host ?? 'localhost';
  const url = `${proto}://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else headers.append(k, v);
  }

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  // Stream with pull-based backpressure so large passthrough uploads stay
  // bounded and early rejections (e.g. declared Content-Length over limit)
  // pull zero bytes off the socket while leaving TCP alive to flush 413.
  let body: BodyInit | undefined;
  if (hasBody) {
    let closed = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    let onData: ((chunk: Buffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    let onError: ((err: Error) => void) | undefined;
    let onAborted: (() => void) | undefined;
    let onClose: (() => void) | undefined;
    const detach = () => {
      if (onData) req.off('data', onData);
      if (onEnd) req.off('end', onEnd);
      if (onError) req.off('error', onError);
      if (onAborted) req.off('aborted', onAborted);
      if (onClose) req.off('close', onClose);
    };
    body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controllerRef = controller;
          onData = (chunk: Buffer) => {
            if (closed) return;
            try {
              // Copy out of Node's shared Buffer slab pool before enqueuing.
              controller.enqueue(new Uint8Array(chunk));
              if ((controller.desiredSize ?? 0) <= 0) req.pause();
            } catch {
              closed = true;
              detach();
              req.pause();
            }
          };
          onEnd = () => {
            if (closed) return;
            closed = true;
            detach();
            try {
              controller.close();
            } catch {
              /* stream already closed */
            }
          };
          onError = (e: Error) => {
            if (closed) return;
            closed = true;
            detach();
            try {
              controller.error(e);
            } catch {
              /* stream already closed */
            }
          };
          onAborted = () => {
            if (closed) return;
            closed = true;
            detach();
            try {
              controller.error(new Error('client request aborted'));
            } catch {
              /* stream already closed */
            }
          };
          onClose = () => {
            if (closed || req.complete) return;
            closed = true;
            detach();
            try {
              controller.error(new Error('client request closed'));
            } catch {
              /* stream already closed */
            }
          };
          req.on('data', onData);
          req.on('end', onEnd);
          req.on('error', onError);
          req.on('aborted', onAborted);
          req.on('close', onClose);
          req.pause();
        },
        pull() {
          if (!closed && controllerRef) req.resume();
        },
        cancel() {
          if (closed) return;
          closed = true;
          detach();
          // Pause rather than destroy: req shares its TCP socket with res, so
          // destroying req here would abort a 413 response before it flushes.
          req.pause();
        },
      },
      { highWaterMark: 0 },
    );
  }

  return new Request(url, {
    method,
    headers,
    body,
    ...(signal ? { signal } : {}),
    // @ts-expect-error — duplex is required for streamed request bodies in Node 18+
    duplex: hasBody ? 'half' : undefined,
  });
}

function isConnectionAbort(err: unknown): boolean {
  const e = err as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };
  const name = typeof e?.name === 'string' ? e.name : '';
  const code = typeof e?.code === 'string'
    ? e.code
    : typeof e?.cause?.code === 'string'
      ? e.cause.code
      : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  const causeMessage = typeof e?.cause?.message === 'string' ? e.cause.message : '';
  return name === 'AbortError' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    message === 'client response closed' ||
    message === 'terminated' ||
    message.includes('aborted') ||
    causeMessage.includes('other side closed');
}

function waitForDrain(out: ServerResponse): Promise<void> {
  if (out.destroyed || out.writableEnded || out.closed) {
    return Promise.reject(new Error('client response closed'));
  }
  // Do NOT use Promise.race([once(out,'drain'), once(out,'close')]): the losing
  // once() never detaches its listener, and events.once() also attaches an
  // implicit 'error' listener. On a long streamed response every backpressure
  // cycle would then leak one 'close' + one 'error' listener on the same
  // ServerResponse, triggering MaxListenersExceededWarning, unbounded heap
  // growth, and eventually a silent OOM exit of the proxy. Manage the listeners
  // manually and remove all of them on whichever event fires first. 'error' must
  // be handled too: with no 'error' listener attached, an error emitted while we
  // wait would crash the process as an unhandled 'error' event.
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      out.off('drain', onDrain);
      out.off('close', onClose);
      out.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('client response closed'));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    out.once('drain', onDrain);
    out.once('close', onClose);
    out.once('error', onError);
  });
}

async function writeWebResponse(res: Response, out: ServerResponse): Promise<void> {
  if (out.destroyed || out.writableEnded || out.closed) {
    await res.body?.cancel().catch(() => undefined);
    return;
  }
  out.statusCode = res.status;
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'set-cookie') return;
    out.setHeader(k, v);
  });
  if (cookies.length > 0) {
    out.setHeader('set-cookie', cookies.length === 1 ? cookies[0]! : cookies);
  } else {
    const singleCookie = res.headers.get('set-cookie');
    if (singleCookie !== null) out.setHeader('set-cookie', singleCookie);
  }
  if (!res.body) {
    out.end();
    return;
  }
  out.socket?.setNoDelay?.(true);
  out.flushHeaders();
  const reader = res.body.getReader();
  let finished = false;
  let completed = false;
  const cancelBody = () => {
    if (!finished) void reader.cancel().catch(() => undefined);
  };
  out.once('close', cancelBody);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (out.destroyed || out.writableEnded || out.closed) {
        throw new Error('client response closed');
      }
      if (value && !out.write(value)) await waitForDrain(out);
    }
    if (!out.writableEnded) out.end();
  } catch (err) {
    if (isConnectionAbort(err) || out.destroyed || out.writableEnded || out.closed) {
      if (!out.destroyed && !out.writableEnded) out.destroy(err instanceof Error ? err : undefined);
      return;
    }
    throw err;
  } finally {
    finished = true;
    out.off('close', cancelBody);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Read the entire request body as text. Bounded at 1 MiB — every dashboard
 *  POST is tiny JSON (a few hundred bytes). The cap is a defense against a
 *  pathological/malicious client; legitimate proxy traffic doesn't hit these
 *  routes. */
async function readRequestBody(req: IncomingMessage): Promise<string> {
  const MAX = 1024 * 1024;
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = chunk as Buffer;
    bytes += b.byteLength;
    if (bytes > MAX) throw new Error('request body too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
}

function normalizeIpAddress(address: string | undefined): string {
  if (!address) return '';
  const lower = address.trim().toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower;
}

function isPrivateAddress(address: string | undefined): boolean {
  const ip = normalizeIpAddress(address);
  if (!ip) return false;
  const parts = ip.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

function extractHostHeaderHostname(rawHost: string): string {
  const trimmed = rawHost.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end > 0 ? trimmed.slice(0, end + 1) : '';
  }
  const colon = trimmed.indexOf(':');
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || host === '::1'
    || (isIP(host) === 4 && host.split('.')[0] === '127');
}

function normalizedSecFetchSite(req: IncomingMessage): string {
  const raw = req.headers['sec-fetch-site'];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** Reject browser cross-site / same-site writes to the unauthenticated loopback dashboard. */
function isSameOriginDashboardRequest(req: IncomingMessage, url: URL): boolean {
  const fetchSite = normalizedSecFetchSite(req);
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true; // local CLI/curl clients do not send Origin
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(dir: string): void {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed) {
    fs.chmodSync(dir, 0o700);
  } else if ((fs.statSync(dir).mode & 0o077) !== 0) {
    throw new Error('directory is accessible by other users');
  }
}

// ---- FileTracker ----------------------------------------------------------

// FileTracker lives in ./file-tracker.ts so prune() coordination stays decoupled cleanly.

// ---- 4xx body sidecar writer ---------------------------------------------

/**
 * For oversized 4xx body samples that won't fit inline in the JSONL row, we
 * write them to a sidecar file at `<dir>/${ts}-${sha8}.json.gz`. The path
 * lands in the event as `req_body_sample_path`. Survives log rotation and
 * stays out of the streaming dashboard.
 *
 * Failure mode: directory unwritable or write fails → returns undefined and
 * the body sample is silently dropped (we still keep the sha8 and error_body
 * for diagnostics; the request itself was never blocked by this).
 */
async function maybeWriteBodySidecar(
  bytesGz: Uint8Array,
  sha8: string | undefined,
  dir: string,
): Promise<string | undefined> {
  try {
    // Lazy mkdir — only when we actually need to write.
    ensurePrivateDirectory(dir);
  } catch {
    return undefined;
  }
  // Filename: timestamp + sha8 keeps collisions effectively impossible and
  // makes the file naturally sortable. Sha8 fallback covers the edge case
  // where the hash wasn't computed (zero-byte body, etc.).
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = sha8 ?? 'nohash';
  const filePath = path.join(dir, `${ts}-${tag}.json.gz`);
  try {
    atomicWriteFileSync(filePath, bytesGz, { mode: 0o600, dirMode: 0o700, fsync: true });
    return filePath;
  } catch {
    return undefined;
  }
}

// ---- fiche export ---------------------------------------------------------

function printExportHelp(): void {
  console.log(`fiche export — render code/text to PNG pages for compressed LLM context

Usage:
  fiche export [target ...]    default target is "." (current directory)

Targets:
  Files or directories to include. Multiple targets are joined with a header
  separator line. Defaults to "." when none are given.

Options:
  --include <glob>   include only files matching glob (repeatable)
  --exclude <glob>   exclude files matching glob (repeatable)
  --git              render "git diff HEAD" plus untracked files
  --diff <ref>       render "git diff <ref>"
  --stdin            read source text from stdin instead of files
  --out <dir>        base output directory (default \$TMPDIR or /tmp)
  --model <id>       model id for vision-token estimate (default claude-sonnet-4-5)
  --json             print report as JSON
  --open             reveal the output folder when done (macOS) so you can
                     drag the PNG pages straight into your chat
  -h, --help         show this help

Output:
  <out>/fiche-export-<hash>/
    page-001.png ...  rendered image pages
    factsheet.txt     verbatim precision tokens (paths, SHAs, ids, numbers)
    manifest.json     metadata + token report
    prompt.txt        paste-ready agent instruction referencing the images

Report columns:
  text tokens   approximate tokens if the source were sent as plain text
  image tokens  estimated tokens to send the rendered PNG pages
  % saved       (text − image) / text × 100

Examples:
  fiche export .                              # whole directory
  fiche export --include "*.ts" src/          # TypeScript files only
  fiche export --git                          # uncommitted changes
  fiche export --diff HEAD~3                  # last 3 commits
  fiche export --open src/                    # render src/, then reveal the folder
  cat big-file.txt | fiche export --stdin
`);
}

/** Directories never descended into when walking files. */
const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
  '__pycache__', '.cache', '.next', '.nuxt', '.turbo',
]);

interface CollectedFile {
  relPath: string;
  content: string;
}

/** Recursively walk a directory, collecting text files that pass include/exclude filters. */
function walkDir(
  dir: string,
  rootDir: string,
  include: string[],
  exclude: string[],
  out: CollectedFile[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      walkDir(full, rootDir, include, exclude, out);
    } else if (entry.isFile()) {
      // Bulk directory walk: skip silently on any gate miss (per-file warnings
      // would be noise across a whole tree).
      const r = readExportTextFile(full, rel, include, exclude);
      if (r.kind === 'ok') out.push({ relPath: rel, content: r.content });
    }
  }
}

/** Collect files from a list of targets (files or directories). */
function collectFilesFromTargets(
  targets: string[],
  include: string[],
  exclude: string[],
): CollectedFile[] {
  const files: CollectedFile[] = [];
  for (const target of targets) {
    let st: fs.Stats;
    try { st = fs.statSync(target); } catch {
      console.warn(`[fiche export] skipping inaccessible target: ${target}`);
      continue;
    }
    if (st.isDirectory()) {
      walkDir(target, target, include, exclude, files);
    } else if (st.isFile()) {
      const rel = path.basename(target);
      const r = readExportTextFile(target, rel, include, exclude);
      if (r.kind === 'ok') files.push({ relPath: rel, content: r.content });
      else if (r.kind !== 'excluded') {
        console.warn(`[fiche export] skipping ${r.kind} file: ${target}`);
      }
    }
  }
  return files;
}

/** Run a git command in `cwd`, return stdout string or null on failure. */
function gitRun(args: string[], cwd: string): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) return null;
  return result.stdout ?? null;
}

/** Collect source text for the export run. Returns [sourceText, sourceFiles[]] */
async function collectSource(opts: ExportParsed): Promise<[string, string[]]> {
  // --stdin
  if (opts.stdin) {
    const chunks: string[] = [];
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      if (typeof chunk === 'string') chunks.push(chunk);
    }
    return [chunks.join(''), []];
  }

  // --diff <ref>
  if (opts.diff !== undefined) {
    const cwd = opts.targets.length > 0 ? opts.targets[0]! : process.cwd();
    const diff = gitRun(['diff', '--end-of-options', opts.diff], cwd);
    if (diff === null) {
      console.error(`[fiche export] git diff ${opts.diff} failed`);
      process.exit(1);
    }
    return [diff, []];
  }

  // --git
  if (opts.git) {
    const cwd = opts.targets.length > 0 ? opts.targets[0]! : process.cwd();
    const diff = gitRun(['diff', 'HEAD'], cwd) ?? '';
    // Collect untracked files
    const untrackedOut = gitRun(['ls-files', '--others', '--exclude-standard'], cwd) ?? '';
    const untrackedFiles = untrackedOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let untracked = '';
    for (const rel of untrackedFiles) {
      const full = path.join(cwd, rel);
      // Same include/exclude + size + binary gate as directory mode. Untracked
      // files previously bypassed all of it: --include/--exclude were ignored
      // and an oversized file was read fully into memory.
      const r = readExportTextFile(full, rel, opts.include, opts.exclude);
      if (r.kind === 'ok') untracked += `\n===== ${rel} =====\n` + r.content;
      else if (r.kind !== 'excluded') {
        console.warn(`[fiche export] skipping ${r.kind} untracked file: ${rel}`);
      }
    }
    const sourceText = diff + untracked;
    return [sourceText, []];
  }

  // File/directory mode (default)
  const targets = opts.targets.length > 0 ? opts.targets : ['.'];
  const files = collectFilesFromTargets(targets, opts.include, opts.exclude);
  if (files.length === 0) {
    console.warn('[fiche export] no files collected');
  }
  const sourceText = files
    .map((f) => `===== ${f.relPath} =====\n${f.content}`)
    .join('\n\n');
  const sourceFiles = files.map((f) => f.relPath);
  return [sourceText, sourceFiles];
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function printExportReport(opts: ExportParsed, outDir: string, sourceFiles: string[], result: ExportResult): void {
  const { manifest } = result;
  const { tokenReport, pages } = manifest;
  const totalPngBytes = pages.reduce((s, p) => s + p.bytes, 0);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        outDir,
        fileCount: sourceFiles.length,
        sourceChars: manifest.sourceChars,
        pageCount: pages.length,
        totalPngBytes,
        textTokens: tokenReport.textTokens,
        imageTokens: tokenReport.imageTokens,
        percentSaved: tokenReport.percentSaved,
        factsheetItemCount: tokenReport.factsheetItemCount,
        factsheetDropped: tokenReport.factsheetDropped,
        model: manifest.model,
        cols: manifest.cols,
        generatedAt: manifest.generatedAt,
      }) + '\n',
    );
    return;
  }

  const saved = tokenReport.percentSaved;
  const savedStr = saved >= 0 ? `${saved.toFixed(1)}% saved` : `${Math.abs(saved).toFixed(1)}% more expensive`;
  const droppedNote = tokenReport.factsheetDropped > 0
    ? ` (${tokenReport.factsheetDropped} dropped)`
    : '';
  console.log(
    `\nfiche export\n` +
    `  out:            ${outDir}\n` +
    `  files:          ${formatNumber(sourceFiles.length)}\n` +
    `  source chars:   ${formatNumber(manifest.sourceChars)}\n` +
    `  pages:          ${pages.length} (${formatNumber(totalPngBytes)} bytes)\n` +
    `  text tokens:    ~${formatNumber(tokenReport.textTokens)}\n` +
    `  image tokens:   ~${formatNumber(tokenReport.imageTokens)}  (${savedStr})\n` +
    `  factsheet:      ${tokenReport.factsheetItemCount} items${droppedNote}\n`,
  );
  console.log(
    `next — get this into your chat:\n` +
    `  1. attach the ${pages.length} page-*.png file${pages.length === 1 ? '' : 's'} from that folder\n` +
    `  2. paste prompt.txt alongside them (it tells the model what the images are)\n` +
    `     factsheet.txt has the verbatim paths / ids / numbers if you need exact strings\n` +
    (opts.open ? `  opening the folder…\n` : `  tip: add --open to reveal the folder automatically\n`),
  );
}

async function runExport(argv: string[]): Promise<void> {
  const parseResult = parseExportArgv(argv);

  if (parseResult.kind === 'help') {
    printExportHelp();
    process.exit(0);
  }
  if (parseResult.kind === 'error') {
    console.error(`[fiche export] ${parseResult.message}`);
    console.error(`[fiche export] run \`fiche export --help\` for usage`);
    process.exit(2);
  }

  const opts = parseResult.parsed;

  // Collect source text
  const [sourceText, sourceFiles] = await collectSource(opts);

  // Unique output dir: <out>/fiche-export-XXXXXX/. mkdtemp guarantees a fresh, random
  // directory so concurrent runs never collide and stale page-NNN.png never bleed in.
  fs.mkdirSync(opts.out, { recursive: true });
  const outDir = fs.mkdtempSync(path.join(opts.out, 'fiche-export-'));

  // Run core export
  const result = await runExportCore(sourceText, {
    sourceFiles,
    cols: opts.cols,
    model: opts.model,
  });

  // Write artifacts
  for (const artifact of result.artifacts) {
    // The bundle contains source and prompt-derived content. mkdtemp creates
    // its directory owner-only; keep each artifact owner-only as well.
    fs.writeFileSync(path.join(outDir, artifact.filename), artifact.data, { mode: 0o600 });
  }

  // Print report
  printExportReport(opts, outDir, sourceFiles, result);

  // --open: reveal the output folder (macOS `open`) so the PNG pages can be
  // dragged straight into a chat. Best-effort; a failed open is non-fatal
  // since the report already printed the path.
  if (opts.open) {
    spawnSync('open', [outDir], { stdio: 'ignore' });
  }
}

// ---- macOS launchd daemon service -----------------------------------------

const DEFAULT_SERVICE_LABEL = 'com.sriinnu.fiche';
const SERVICE_LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;
const SERVICE_PASSTHROUGH_ENV_KEYS = [
  'FICHE_LOG',
  'FICHE_CONFIG',
  'FICHE_SESSION_STATE',
  'FICHE_SHUTDOWN_DRAIN_MS',
  'FICHE_MMU_MAX_PAGES',
  'FICHE_MMU_MAX_MB',
  'FICHE_MAX_SESSIONS',
  'FICHE_UPSTREAM',
  'ANTHROPIC_UPSTREAM',
  'OPENAI_UPSTREAM',
  'GOOGLE_UPSTREAM',
  'FICHE_PROVIDERS',
  'FICHE_UPSTREAM_HOSTS',
  'FICHE_ALLOWED_HOSTS',
  'FICHE_FOLLOW_HOSTS',
  'FICHE_MODELS',
  'FICHE_FORCE_IMAGES',
] as const;

function resolveServiceLabel(): string {
  const override = process.env.FICHE_SERVICE_LABEL?.trim();
  if (override) {
    if (!SERVICE_LABEL_PATTERN.test(override)) {
      throw new Error(`Invalid FICHE_SERVICE_LABEL "${override}" (expected [A-Za-z0-9._-]+)`);
    }
    return override;
  }
  return DEFAULT_SERVICE_LABEL;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveServiceEntryPath(): string {
  const override = process.env.FICHE_SERVICE_ENTRY?.trim();
  if (override) return path.resolve(override);
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  if (currentFile.endsWith(`${path.sep}dist${path.sep}node.js`) || path.basename(currentFile) === 'node.js') {
    return currentFile;
  }
  const distCandidate = path.resolve(currentDir, '..', 'dist', 'node.js');
  if (fs.existsSync(distCandidate)) return distCandidate;
  const binCandidate = path.resolve(currentDir, '..', 'bin', 'cli.js');
  if (fs.existsSync(binCandidate)) return binCandidate;
  return currentFile;
}

function resolvePlistPath(label = resolveServiceLabel()): string {
  const override = process.env.FICHE_PLIST_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function collectServiceExtraEnv(): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const key of SERVICE_PASSTHROUGH_ENV_KEYS) {
    const val = process.env[key]?.trim();
    if (val) extra[key] = val;
  }
  return extra;
}

function renderLaunchdPlist(opts: {
  label?: string;
  execPath?: string;
  entryPath?: string;
  shimPath?: string | null;
  ficheDir?: string;
  port?: number;
  host?: string;
  extraEnv?: Record<string, string>;
}): string {
  const label = opts.label ?? resolveServiceLabel();
  const execPath = opts.execPath ?? process.execPath;
  const entryPath = opts.entryPath ?? resolveServiceEntryPath();
  const shimPath = opts.shimPath ?? null;
  const ficheDir = opts.ficheDir ?? path.join(os.homedir(), '.fiche');
  const port = opts.port ?? 47821;
  const host = opts.host ?? '127.0.0.1';
  const outLog = path.join(ficheDir, 'daemon.out.log');
  const errLog = path.join(ficheDir, 'daemon.err.log');

  const envMap = new Map<string, string>([
    ['PATH', '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'],
    ['FICHE_PRICES', 'kosha'],
    ['FICHE_TEXT_HYGIENE', 'on'],
  ]);
  if (port !== 47821 || process.env.FICHE_PORT?.trim() || process.env.PORT?.trim()) {
    envMap.set('FICHE_PORT', String(port));
    envMap.set('PORT', String(port));
  }
  if (host !== '127.0.0.1' || process.env.HOST?.trim()) {
    envMap.set('HOST', host);
  }
  for (const [k, v] of Object.entries(opts.extraEnv ?? {})) {
    if (v) envMap.set(k, v);
  }

  const programArgs = shimPath ? [shimPath, execPath, entryPath] : [execPath, entryPath];
  const socketLines: string[] = [];
  if (shimPath) {
    socketLines.push(
      '  <key>Sockets</key>',
      '  <dict>',
      '    <key>Listeners</key>',
      '    <dict>',
    );
    const family =
      isIP(host) === 4 || host === 'localhost'
        ? 'IPv4'
        : isIP(host) === 6
          ? 'IPv6'
          : null;
    if (family) {
      socketLines.push('      <key>SockFamily</key>', `      <string>${family}</string>`);
    }
    if (host !== '0.0.0.0' && host !== '::') {
      socketLines.push(
        '      <key>SockNodeName</key>',
        `      <string>${escapeXml(host === 'localhost' ? '127.0.0.1' : host)}</string>`,
      );
    }
    socketLines.push(
      '      <key>SockServiceName</key>',
      `      <string>${escapeXml(String(port))}</string>`,
      '      <key>SockType</key>',
      '      <string>stream</string>',
      '      <key>SockPassive</key>',
      '      <true/>',
      '    </dict>',
      '  </dict>',
    );
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArgs.map((arg) => `    <string>${escapeXml(arg)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...[...envMap.entries()].flatMap(([k, v]) => [
      `    <key>${escapeXml(k)}</key>`,
      `    <string>${escapeXml(v)}</string>`,
    ]),
    '  </dict>',
    ...socketLines,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>1</integer>',
    '  <key>ExitTimeOut</key>',
    '  <integer>65</integer>',
    '  <key>ProcessType</key>',
    '  <string>Standard</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(outLog)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(errLog)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function runLaunchctl(args: string[], dryRun: boolean): { status: number; stdout: string; stderr: string } {
  if (dryRun || process.env.FICHE_SERVICE_NO_LAUNCHCTL === '1') {
    return { status: 0, stdout: '', stderr: '' };
  }
  const res = spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

async function fetchHealth(port: number, timeoutMs = 350): Promise<Record<string, unknown> | null> {
  let res: Response | undefined;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { connection: 'close' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const parsed = (await res.json()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    await res?.body?.cancel().catch(() => undefined);
    return null;
  }
}

async function pollHealth(
  port: number,
  budgetMs = 2000,
  excludePid?: number,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port, Math.min(2000, Math.max(500, deadline - Date.now())));
    if (health && (excludePid === undefined || health.pid !== excludePid)) {
      return health;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function runServiceCommand(argv: string[]): Promise<number> {
  const jsonFlag = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const action = argv.find((a) => !a.startsWith('-')) ?? 'status';
  const serviceLabel = resolveServiceLabel();
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`fiche service — manage the macOS launchd background daemon

Usage:
  fiche service install [--json]     install & start ~/Library/LaunchAgents/${serviceLabel}.plist
  fiche service uninstall [--json]   stop & remove the LaunchAgent plist
  fiche service start [--json]       start the daemon via launchd
  fiche service stop [--json]        stop the daemon cleanly
  fiche service restart [--json]     restart the daemon
  fiche service status [--json]      print daemon health and plist status
`);
    return 0;
  }

  const validActions = new Set(['install', 'uninstall', 'start', 'stop', 'restart', 'status']);
  if (!validActions.has(action)) {
    console.error(`[fiche service] unknown action: ${action} (expected install|uninstall|start|stop|restart|status)`);
    return 2;
  }

  const port = parseEnvPort(resolvePortEnvRaw());
  const host = process.env.HOST?.trim() || '127.0.0.1';
  const plistPath = resolvePlistPath(serviceLabel);
  const ficheDir = path.join(os.homedir(), '.fiche');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `${domainTarget}/${serviceLabel}`;

  const emitResult = (payload: Record<string, unknown>, humanLine: string, code = 0): number => {
    if (jsonFlag) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else console.log(humanLine);
    return code;
  };

  const buildServicePlist = () => {
    const shim = ensureLaunchdSocketShim(ficheDir, dryRun);
    const plistXml = renderLaunchdPlist({
      label: serviceLabel,
      ficheDir,
      port,
      host,
      shimPath: shim.supported ? shim.shimPath : null,
      extraEnv: collectServiceExtraEnv(),
    });
    return { plistXml, shim };
  };

  if (action === 'status') {
    const plistInstalled = fs.existsSync(plistPath);
    const health = dryRun ? null : await fetchHealth(port);
    const payload = {
      running: Boolean(health),
      pid: typeof health?.pid === 'number' ? health.pid : null,
      label: serviceLabel,
      plist_installed: plistInstalled,
      plist_path: plistPath,
      port,
      compression_enabled: typeof health?.compression_enabled === 'boolean' ? health.compression_enabled : null,
      active_requests: typeof health?.active_requests === 'number' ? health.active_requests : null,
      price_mode: typeof health?.price_mode === 'string' ? health.price_mode : (readBrandEnv('PRICES') || 'default'),
      ...(typeof health?.version === 'string' ? { version: health.version } : {}),
    };
    const msg = health
      ? `[fiche service] running (pid=${payload.pid}, port=${port}, active=${payload.active_requests ?? 0}, compression=${payload.compression_enabled ? 'on' : 'off'}, prices=${payload.price_mode})`
      : `[fiche service] stopped (plist=${plistInstalled ? 'installed' : 'not installed'}, port=${port})`;
    return emitResult(payload, msg);
  }

  const bootstrapWithRetry = async (dry: boolean): Promise<{ status: number; stdout: string; stderr: string }> => {
    let res = runLaunchctl(['bootstrap', domainTarget, plistPath], dry);
    if (dry || res.status === 0) return res;
    // launchd `bootout` reaps asynchronously; retry briefly when EIO/reap race hits.
    for (let attempt = 0; attempt < 12 && res.status !== 0; attempt += 1) {
      await new Promise((r) => setTimeout(r, 150));
      res = runLaunchctl(['bootstrap', domainTarget, plistPath], false);
    }
    return res;
  };

  if (action === 'install') {
    const prevHealth = dryRun ? null : await fetchHealth(port, 350);
    const prevPid = typeof prevHealth?.pid === 'number' ? prevHealth.pid : undefined;
    const { plistXml, shim } = buildServicePlist();
    const socketActivated = Boolean(shim.supported && shim.shimPath);
    if (!dryRun) {
      fs.mkdirSync(ficheDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      atomicWriteFileSync(plistPath, plistXml, { mode: 0o600, dirMode: 0o755, fsync: true });
    }
    runLaunchctl(['bootout', serviceTarget], dryRun);
    const boot = await bootstrapWithRetry(dryRun);
    if (boot.status !== 0 && !dryRun) {
      return emitResult(
        { ok: false, action: 'install', error: boot.stderr.trim() || `launchctl bootstrap exited ${boot.status}`, plist_path: plistPath, label: serviceLabel },
        `[fiche service] install failed: ${boot.stderr.trim() || `exit ${boot.status}`}`,
        1,
      );
    }
    const health = dryRun ? null : await pollHealth(port, 10_000, prevPid);
    return emitResult(
      {
        ok: true,
        action: 'install',
        dry_run: dryRun,
        label: serviceLabel,
        socket_activated: socketActivated,
        plist_installed: dryRun ? fs.existsSync(plistPath) : true,
        plist_path: plistPath,
        ...(dryRun ? { plist_xml: plistXml } : {}),
        running: Boolean(health),
        pid: health?.pid ?? null,
        port,
      },
      `[fiche service] ${dryRun ? 'would install' : 'installed'} ${plistPath}${health ? ` (running pid=${health.pid})` : ''}`,
    );
  }

  if (action === 'uninstall') {
    if (!dryRun) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
          method: 'POST',
          signal: AbortSignal.timeout(500),
        });
        await res.body?.cancel().catch(() => undefined);
      } catch {
        // Not running
      }
    }
    runLaunchctl(['bootout', serviceTarget], dryRun);
    let removed = false;
    if (!dryRun) {
      try {
        fs.unlinkSync(plistPath);
        removed = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return emitResult(
      { ok: true, action: 'uninstall', dry_run: dryRun, removed, plist_path: plistPath, label: serviceLabel },
      `[fiche service] ${dryRun ? 'would uninstall' : `uninstalled (${removed ? `removed ${plistPath}` : 'plist was absent'})`}`,
    );
  }

  if (action === 'stop') {
    if (!dryRun) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
          method: 'POST',
          signal: AbortSignal.timeout(500),
        });
        await res.body?.cancel().catch(() => undefined);
      } catch {
        // Not running
      }
    }
    runLaunchctl(['bootout', serviceTarget], dryRun);
    return emitResult(
      { ok: true, action: 'stop', dry_run: dryRun, running: false, plist_path: plistPath, label: serviceLabel },
      `[fiche service] ${dryRun ? 'would stop' : 'stopped'}`,
    );
  }

  if (action === 'start') {
    if (!dryRun && !fs.existsSync(plistPath)) {
      const { plistXml } = buildServicePlist();
      fs.mkdirSync(ficheDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      atomicWriteFileSync(plistPath, plistXml, { mode: 0o600, dirMode: 0o755, fsync: true });
    }
    let boot = runLaunchctl(['kickstart', '-k', serviceTarget], dryRun);
    if (boot.status !== 0) {
      boot = await bootstrapWithRetry(dryRun);
    }
    if (boot.status !== 0 && !dryRun) {
      return emitResult(
        { ok: false, action: 'start', error: boot.stderr.trim() || `launchctl exited ${boot.status}`, plist_path: plistPath, label: serviceLabel },
        `[fiche service] start failed: ${boot.stderr.trim() || `exit ${boot.status}`}`,
        1,
      );
    }
    const health = dryRun ? null : await pollHealth(port, 10_000);
    return emitResult(
      { ok: true, action: 'start', dry_run: dryRun, label: serviceLabel, running: Boolean(health), pid: health?.pid ?? null, port, plist_path: plistPath },
      `[fiche service] ${dryRun ? 'would start' : `started${health ? ` (pid=${health.pid})` : ''}`}`,
    );
  }

  // restart: kickstart atomically when already loaded; fall back to bootout + retry bootstrap
  const prevHealth = dryRun ? null : await fetchHealth(port, 350);
  const prevPid = typeof prevHealth?.pid === 'number' ? prevHealth.pid : undefined;
  if (!dryRun && !fs.existsSync(plistPath)) {
    const { plistXml } = buildServicePlist();
    fs.mkdirSync(ficheDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    atomicWriteFileSync(plistPath, plistXml, { mode: 0o600, dirMode: 0o755, fsync: true });
  }
  let boot = runLaunchctl(['kickstart', '-k', serviceTarget], dryRun);
  if (boot.status !== 0 && !dryRun) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(500),
      });
      await res.body?.cancel().catch(() => undefined);
    } catch {
      // Not running
    }
    runLaunchctl(['bootout', serviceTarget], dryRun);
    boot = await bootstrapWithRetry(dryRun);
  }
  if (boot.status !== 0 && !dryRun) {
    return emitResult(
      { ok: false, action: 'restart', error: boot.stderr.trim() || `launchctl exited ${boot.status}`, plist_path: plistPath, label: serviceLabel },
      `[fiche service] restart failed: ${boot.stderr.trim() || `exit ${boot.status}`}`,
      1,
    );
  }
  const health = dryRun ? null : await pollHealth(port, 10_000, prevPid);
  return emitResult(
    { ok: true, action: 'restart', dry_run: dryRun, label: serviceLabel, running: Boolean(health), pid: health?.pid ?? null, port, plist_path: plistPath },
    `[fiche service] ${dryRun ? 'would restart' : `restarted${health ? ` (pid=${health.pid})` : ''}`}`,
  );
}

async function syncDaemonJson(
  port: number,
  apiPath: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1500),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

function detectLocalProviderSignals(): Map<ProviderId, string[]> {
  const signals = new Map<ProviderId, string[]>();
  const addSignal = (id: ProviderId, reason: string) => {
    const list = signals.get(id) ?? [];
    if (!list.includes(reason)) list.push(reason);
    signals.set(id, list);
  };
  for (const hit of detectProvidersFromEnv(process.env)) {
    addSignal(hit.id, `env:${hit.matchedEnvKey}`);
  }
  const checks: Array<{ id: ProviderId; clis: readonly string[]; apps: readonly string[] }> = [
    { id: 'anthropic', clis: ['claude'], apps: ['Claude'] },
    { id: 'openai', clis: ['codex'], apps: ['ChatGPT'] },
    { id: 'google', clis: ['gemini', 'agy'], apps: ['Antigravity'] },
    { id: 'kimi', clis: ['kimi'], apps: [] },
  ];
  for (const c of checks) {
    for (const cli of c.clis) {
      if (isRunnable(cli, process.env)) addSignal(c.id, `cli:${cli}`);
    }
    if (process.platform === 'darwin') {
      for (const app of c.apps) {
        if (resolveMacAppBundle(app)) addSignal(c.id, `app:${app}`);
      }
    }
  }
  return signals;
}

function configuredCustomHostSpecs(): string[] {
  const raw = readBrandEnv('UPSTREAM_HOSTS')?.trim() ?? '';
  if (!raw) return [];
  const entries = parseUpstreamHosts(raw);
  const out: string[] = [];
  for (const e of entries) {
    const nonEmpty = e.prefixes.filter((p) => p !== '');
    if (nonEmpty.length === 0) out.push(e.host);
    else for (const p of nonEmpty) out.push(`${e.host}${p}`);
  }
  return out;
}

async function runProvidersCommand(argv: readonly string[], port: number): Promise<number> {
  applyConfigFileDefaults();
  const jsonFlag = argv.includes('--json');
  const applyFlag = argv.includes('--apply');
  const pos = argv.filter((a) => a !== '--json' && a !== '--apply');
  const sub = (pos[0] ?? 'list').toLowerCase();
  const rest = pos.slice(1);
  const availableIds = PROVIDER_CATALOG.map((p) => p.id).join(', ');

  const commitProviders = async (next: readonly ProviderId[], action: string): Promise<number> => {
    setEnabledProviders(next);
    const saved = persistConfigPatch({ providers: [...next] });
    const synced = await syncDaemonJson(port, '/api/providers', { providers: [...next] });
    if (jsonFlag) {
      console.log(JSON.stringify({ ok: true, action, enabled: [...next], saved, synced }, null, 2));
      return 0;
    }
    const label = next.length > 0 ? next.join(', ') : 'none';
    console.log(`[fiche] providers ${action}: ${label} (${synced ? 'updated running daemon + config' : saved ? 'saved to config.json' : 'runtime only'})`);
    return 0;
  };

  if (sub === 'list') {
    const statuses = listProviderStatuses();
    const enabled = statuses.filter((p) => p.enabled);
    const optIn = statuses.filter((p) => !p.enabled);
    const customHosts = configuredCustomHostSpecs();
    if (jsonFlag) {
      console.log(JSON.stringify({ enabled: enabled.map((p) => p.id), providers: statuses, custom_hosts: customHosts }, null, 2));
      return 0;
    }
    console.log(`Active providers (${enabled.length}): ${enabled.map((p) => p.id).join(', ') || 'none'}`);
    for (const p of enabled) {
      console.log(`  ✓ ${p.id.padEnd(11)} ${p.label} (${p.hosts.join(', ')})`);
    }
    if (customHosts.length > 0) {
      console.log(`Custom hosts (${customHosts.length}): ${customHosts.join(', ')}`);
    }
    if (optIn.length > 0) {
      console.log(`Opt-in third-party (${optIn.length}): ${optIn.map((p) => p.id).join(', ')}`);
    }
    console.log('\nExamples:\n  fiche providers detect --apply\n  fiche providers enable openrouter deepseek\n  fiche providers add-host llm.example.com/anthropic');
    return 0;
  }

  if (sub === 'detect') {
    const detectedMap = detectLocalProviderSignals();
    const detectedIds = [...detectedMap.keys()];
    const thirdPartyEnabled = getEnabledProviders().filter((id) =>
      PROVIDER_CATALOG.some((p) => p.id === id && p.tier === 'third-party'),
    );
    const recommended = [...new Set([...detectedIds, ...thirdPartyEnabled])];
    if (applyFlag) {
      return commitProviders(recommended, 'detected');
    }
    if (jsonFlag) {
      console.log(JSON.stringify({
        detected: detectedIds.map((id) => ({ id, signals: detectedMap.get(id) ?? [] })),
        recommended,
      }, null, 2));
      return 0;
    }
    if (detectedIds.length === 0) {
      console.log('No local provider CLIs, apps, or API key env vars detected.');
    } else {
      console.log('Detected providers on this machine:');
      for (const id of detectedIds) {
        console.log(`  • ${id.padEnd(11)} ${(detectedMap.get(id) ?? []).join(', ')}`);
      }
      console.log(`\nRun \`fiche providers detect --apply\` or \`fiche providers set ${recommended.join(',')}\` to apply.`);
    }
    return 0;
  }

  if (sub === 'set') {
    if (rest.length === 0) {
      console.error('[fiche] providers set needs a provider list, "all", or "none"');
      return 2;
    }
    const { providers, unknown } = parseProvidersSpec(rest.join(','));
    if (unknown.length > 0 || providers === null) {
      console.error(`[fiche] unknown provider(s): ${unknown.join(', ')}\nAvailable: ${availableIds}`);
      return 2;
    }
    return commitProviders(providers, 'set');
  }

  if (sub === 'enable' || sub === 'add') {
    if (rest.length === 0) {
      console.error(`[fiche] providers ${sub} needs at least one provider id (${availableIds})`);
      return 2;
    }
    const { providers, unknown } = parseProvidersSpec(rest.join(','));
    if (unknown.length > 0 || providers === null) {
      console.error(`[fiche] unknown provider(s): ${unknown.join(', ')}\nAvailable: ${availableIds}`);
      return 2;
    }
    const merged = [...new Set([...getEnabledProviders(), ...providers])];
    return commitProviders(merged, 'enabled');
  }

  if (sub === 'disable' || sub === 'remove') {
    if (rest.length === 0) {
      console.error('[fiche] providers disable needs at least one provider id');
      return 2;
    }
    const { providers, unknown } = parseProvidersSpec(rest.join(','));
    if (unknown.length > 0 || providers === null) {
      console.error(`[fiche] unknown provider(s): ${unknown.join(', ')}\nAvailable: ${availableIds}`);
      return 2;
    }
    const drop = new Set(providers);
    const next = getEnabledProviders().filter((id) => !drop.has(id));
    return commitProviders(next, 'disabled');
  }

  if (sub === 'add-host') {
    const spec = rest[0]?.trim();
    if (!spec || parseUpstreamHosts(spec).length === 0) {
      console.error('[fiche] providers add-host needs a public hostname[/prefix], e.g. llm.example.com/anthropic');
      return 2;
    }
    const normalizedSpec = configuredCustomHostSpecsFromInput([spec])[0];
    if (!normalizedSpec) {
      console.error('[fiche] providers add-host: invalid host specification');
      return 2;
    }
    const nextHosts = [...new Set([...configuredCustomHostSpecs(), normalizedSpec])];
    persistCustomHostsToConfig(nextHosts);
    if (jsonFlag) {
      console.log(JSON.stringify({ ok: true, custom_hosts: nextHosts, restart_required: true }, null, 2));
      return 0;
    }
    console.log(`[fiche] custom hosts saved: ${nextHosts.join(', ')} (run \`fiche service restart\` to reload running daemon)`);
    return 0;
  }

  if (sub === 'remove-host') {
    const targetHost = rest[0]?.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]?.replace(/\.$/, '');
    if (!targetHost) {
      console.error('[fiche] providers remove-host needs a hostname');
      return 2;
    }
    const nextHosts = configuredCustomHostSpecs().filter((item) => {
      const hostOnly = item.split('/')[0]?.toLowerCase();
      return hostOnly !== targetHost;
    });
    persistCustomHostsToConfig(nextHosts);
    if (jsonFlag) {
      console.log(JSON.stringify({ ok: true, custom_hosts: nextHosts, restart_required: true }, null, 2));
      return 0;
    }
    console.log(`[fiche] custom hosts saved: ${nextHosts.length > 0 ? nextHosts.join(', ') : 'none'} (run \`fiche service restart\` to reload running daemon)`);
    return 0;
  }

  console.error(`[fiche] unknown providers subcommand: ${sub} (expected: list | set | enable | disable | detect | add-host | remove-host)`);
  return 2;
}

function configuredCustomHostSpecsFromInput(items: readonly string[]): string[] {
  const entries = parseUpstreamHosts(items.join(','));
  const out: string[] = [];
  for (const e of entries) {
    const nonEmpty = e.prefixes.filter((p) => p !== '');
    if (nonEmpty.length === 0) out.push(e.host);
    else for (const p of nonEmpty) out.push(`${e.host}${p}`);
  }
  return out;
}

async function runModelsCommand(argv: readonly string[], port: number): Promise<number> {
  applyConfigFileDefaults();
  const jsonFlag = argv.includes('--json');
  const pos = argv.filter((a) => a !== '--json');
  const sub = (pos[0] ?? 'list').toLowerCase();
  const rest = pos.slice(1);

  const commitModels = async (next: readonly string[], action: string): Promise<number> => {
    setAllowedModelBases(next);
    const saved = persistConfigPatch({ models: [...next] });
    const synced = await syncDaemonJson(port, '/api/models', { models: [...next] });
    if (jsonFlag) {
      console.log(JSON.stringify({ ok: true, action, models: [...next], saved, synced }, null, 2));
      return 0;
    }
    console.log(`[fiche] models ${action}: ${next.length > 0 ? next.join(', ') : 'off'} (${synced ? 'updated running daemon + config' : saved ? 'saved to config.json' : 'runtime only'})`);
    return 0;
  };

  if (sub === 'list') {
    const models = getAllowedModelBases();
    if (jsonFlag) {
      console.log(JSON.stringify({ models }, null, 2));
      return 0;
    }
    console.log(`Enabled model bases (${models.length}): ${models.length > 0 ? models.join(', ') : 'off'}`);
    return 0;
  }
  if (sub === 'set') {
    const raw = rest.join(',').trim();
    const next = !raw || /^(?:0|false|no|off|none)$/i.test(raw)
      ? []
      : raw.split(',').map((s) => s.trim()).filter(Boolean);
    return commitModels(next, 'set');
  }
  if (sub === 'enable' || sub === 'add') {
    const items = rest.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) {
      console.error(`[fiche] models ${sub} needs at least one model id`);
      return 2;
    }
    const next = [...new Set([...getAllowedModelBases(), ...items])];
    return commitModels(next, 'enabled');
  }
  if (sub === 'disable' || sub === 'remove') {
    const drop = new Set(rest.flatMap((s) => s.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean));
    if (drop.size === 0) {
      console.error(`[fiche] models ${sub} needs at least one model id`);
      return 2;
    }
    const next = getAllowedModelBases().filter((m) => !drop.has(m.toLowerCase()));
    return commitModels(next, 'disabled');
  }
  if (sub === 'sync-kosha' || sub === 'sync') {
    let apply = false;
    let allProviders = false;
    let replace = false;
    let explicitFile: string | undefined;
    let providersArg: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--apply') {
        apply = true;
      } else if (arg === '--all-providers') {
        allProviders = true;
      } else if (arg === '--replace') {
        replace = true;
      } else if (arg === '--file') {
        const val = rest[i + 1];
        if (!val || val.startsWith('-')) {
          console.error('[fiche] models sync-kosha: --file needs a path');
          return 2;
        }
        explicitFile = val;
        i += 1;
      } else if (arg.startsWith('--file=')) {
        explicitFile = arg.slice('--file='.length);
      } else if (arg === '--providers') {
        const val = rest[i + 1];
        if (!val || val.startsWith('-')) {
          console.error('[fiche] models sync-kosha: --providers needs a comma-separated list');
          return 2;
        }
        providersArg = val;
        i += 1;
      } else if (arg.startsWith('--providers=')) {
        providersArg = arg.slice('--providers='.length);
      } else {
        console.error(`[fiche] models sync-kosha: unknown option: ${arg}`);
        return 2;
      }
    }
    if (allProviders && providersArg !== undefined) {
      console.error('[fiche] models sync-kosha: --all-providers and --providers are mutually exclusive');
      return 2;
    }

    let targetProviders: ProviderId[];
    if (allProviders) {
      targetProviders = PROVIDER_CATALOG.map((p) => p.id);
    } else if (providersArg !== undefined) {
      const { providers, unknown } = parseProvidersSpec(providersArg);
      if (unknown.length > 0 || !providers || providers.length === 0) {
        const available = PROVIDER_CATALOG.map((p) => p.id).join(', ');
        console.error(
          `[fiche] unknown or empty provider(s): ${unknown.join(', ') || '(empty)'}\nAvailable: ${available}`,
        );
        return 2;
      }
      targetProviders = [...providers];
    } else {
      targetProviders = getEnabledProviders();
    }

    let loaded: { snapshot: KoshaRegistrySnapshot; source: string };
    try {
      loaded = loadKoshaSnapshot(explicitFile);
    } catch (e) {
      console.error(`[fiche] models sync-kosha failed: ${(e as Error).message}`);
      return 1;
    }

    const extracted = extractKoshaModelBases(loaded.snapshot, { providers: targetProviders });
    const existing = getAllowedModelBases();
    const { merged, added } = mergeModelBases(existing, extracted.bases, replace);

    let saved = false;
    let synced = false;
    if (apply) {
      setAllowedModelBases(merged);
      saved = persistConfigPatch({ models: merged });
      synced = await syncDaemonJson(port, '/api/models', { models: merged });
    }

    if (jsonFlag) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            action: 'sync-kosha',
            applied: apply,
            replace,
            source: loaded.source,
            providers: targetProviders,
            providersMatched: extracted.providersMatched,
            scannedModels: extracted.scannedModels,
            matchedModels: extracted.matchedModels,
            discoveredCount: extracted.bases.length,
            added,
            models: merged,
            saved,
            synced,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (!apply) {
      console.log(
        `[fiche] models sync-kosha (dry-run, ${loaded.source}): ` +
          `${extracted.matchedModels}/${extracted.scannedModels} chat models -> ` +
          `${extracted.bases.length} normalized bases (+${added.length} new over current ${existing.length})`,
      );
      if (added.length > 0) {
        console.log(`  would add (${added.length}): ${added.join(', ')}`);
      } else {
        console.log('  no new model bases to add');
      }
      console.log('Run again with --apply to write config.json and update the running daemon.');
      return 0;
    }

    console.log(
      `[fiche] models sync-kosha applied (${loaded.source}): ` +
        `${merged.length} total model bases (+${added.length} new; ` +
        `${synced ? 'updated running daemon + config' : saved ? 'saved to config.json' : 'runtime only'})`,
    );
    return 0;
  }
  console.error(`[fiche] unknown models subcommand: ${sub} (expected: list | set | enable | disable | sync-kosha)`);
  return 2;
}

function applyMmuLimitsFromEnv(): { maxPages: number; maxBytes: number } {
  const mmuMaxPagesEnv = parseOptionalPositiveIntEnv('MMU_MAX_PAGES');
  const mmuMaxMbEnv = parseOptionalPositiveIntEnv('MMU_MAX_MB');
  if (mmuMaxPagesEnv !== undefined || mmuMaxMbEnv !== undefined) {
    return configureMmuLimits({
      ...(mmuMaxPagesEnv !== undefined ? { maxPages: mmuMaxPagesEnv } : {}),
      ...(mmuMaxMbEnv !== undefined ? { maxBytes: mmuMaxMbEnv * 1024 * 1024 } : {}),
    });
  }
  const store = getGlobalMmuStore();
  return { maxPages: store.maxPages, maxBytes: store.maxBytes };
}

function scaledMmuFileMaxBytes(maxBytes: number): number {
  return Math.min(512 * 1024 * 1024, Math.max(32 * 1024 * 1024, maxBytes * 4));
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'mcp') {
    applyConfigFileDefaults();
    await runMcpCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'providers') {
    const port = parseEnvPort(resolvePortEnvRaw());
    const code = await runProvidersCommand(argv.slice(1), port);
    process.exit(code);
  }
  if (argv[0] === 'models') {
    const port = parseEnvPort(resolvePortEnvRaw());
    const code = await runModelsCommand(argv.slice(1), port);
    process.exit(code);
  }
  if (argv[0] === 'service') {
    const code = await runServiceCommand(argv.slice(1));
    process.exit(code);
  }
  if (argv[0] === 'status') {
    const code = await runServiceCommand(['status', ...argv.slice(1)]);
    process.exit(code);
  }
  if (argv[0] === 'shell-init') {
    const rest = argv.slice(1);
    let wrap = false;
    let explicitPort: number | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      if (a === '--wrap') {
        wrap = true;
      } else if (a === '-h' || a === '--help') {
        console.log('Usage: fiche shell-init [--wrap] [--port <1..65535>]');
        return;
      } else if (a === '--port') {
        const val = rest[++i];
        explicitPort = parseStrictPortArg(val, 'shell-init');
      } else if (a.startsWith('--port=')) {
        explicitPort = parseStrictPortArg(a.slice('--port='.length), 'shell-init');
      } else {
        console.error(`[fiche] shell-init: unknown option ${a} (supported: --wrap, --port <N>)`);
        process.exit(2);
      }
    }
    const envPort = parseEnvPort(resolvePortEnvRaw());
    const effectivePort = explicitPort ?? (envPort !== 47821 ? envPort : undefined);
    process.stdout.write(renderShellInitScript({ wrap, ...(effectivePort !== undefined ? { port: effectivePort } : {}) }));
    return;
  }
  if (argv[0] === 'export') {
    await runExport(argv.slice(1));
    return; // server never starts
  }
  if (argv[0] === 'stats') {
    // Offline log analysis — reads the events JSONL without a running proxy.
    // The live dashboard covers the same data while fiche is up.
    const defaultFile = defaultEventsFilePath();
    const { code, out, err } = await runStats(argv.slice(1), defaultFile);
    if (out) process.stdout.write(out + '\n');
    if (err) process.stderr.write(err + '\n');
    process.exit(code); // server never starts
  }
  if (argv[0] === 'turn-report') {
    const defaultFile = defaultEventsFilePath();
    const { code, out, err } = runTurnReportCli(argv.slice(1), defaultFile);
    if (out) process.stdout.write(out + '\n');
    if (err) process.stderr.write(err + '\n');
    process.exit(code); // server never starts
  }
  if (argv[0] === 'calibrate') {
    const code = await runCalibrationCli(argv.slice(1));
    process.exit(code); // server never starts
  }
  if (argv[0] === 'mmu') {
    const parsed = parseMmuCliArgs(argv.slice(1), resolvePortEnvRaw());
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exit(parsed.exitCode);
    }
    if (parsed.help) {
      console.log(MMU_CLI_USAGE);
      process.exit(0);
    }

    const { sub, asJson, port, query: queryArg, pageId: pageIdArg, sessionKey } = parsed;
    const eventsPath = defaultEventsFilePath();
    const sessionStatePath = resolveSessionStateFile();
    const mmuPath = path.join(path.dirname(sessionStatePath ?? eventsPath), 'mmu-pages.json');
    if (sub === 'page') {
      const qs = new URLSearchParams();
      if (pageIdArg) qs.set('id', pageIdArg);
      if (queryArg) qs.set('query', queryArg);
      if (sessionKey) qs.set('sessionKey', sessionKey);
      let payload: unknown;
      let daemonHttpError: string | undefined;
      try {
        const controlToken = readExistingWarpToken();
        const res = await fetch(`http://127.0.0.1:${port}/api/mmu/page?${qs.toString()}`, {
          ...(controlToken ? { headers: { 'x-fiche-control-token': controlToken } } : {}),
          signal: AbortSignal.timeout(400),
        });
        if (res.ok) {
          payload = await res.json();
        } else {
          const errJson = (await res.json().catch(() => null)) as { error?: string } | null;
          daemonHttpError = errJson?.error ?? `HTTP ${res.status}`;
        }
      } catch {
        // Daemon unreachable — fallback to offline mmu-pages.json below if present
      }
      if (daemonHttpError) {
        console.error(`[fiche] ${daemonHttpError}`);
        process.exit(1);
      }
      if (!payload) {
        applyConfigFileDefaults();
        const effectiveMmu = applyMmuLimitsFromEnv();
        configureMmuPersistence(
          fileMmuPersistenceStore(mmuPath, { maxFileBytes: scaledMmuFileMaxBytes(effectiveMmu.maxBytes) }),
        );
        const store = getGlobalMmuStore();
        if (pageIdArg) {
          const hit = store.derefPage(pageIdArg, { sessionKey, query: queryArg, maxLines: 120 });
          if (!hit) {
            console.error(`[fiche] MMU page not found: ${pageIdArg}`);
            process.exit(1);
          }
          payload = {
            pageId: hit.page.id,
            refId: hit.page.refId,
            sessionKey: hit.page.sessionKey,
            filePath: hit.page.filePath,
            startLine: hit.startLine,
            endLine: hit.endLine,
            text: hit.text,
          };
        } else {
          const matches = store.searchPages(queryArg!, sessionKey);
          if (matches.length === 0) {
            console.error(`[fiche] no MMU pages matching query: ${queryArg}`);
            process.exit(1);
          }
          const top = matches[0]!;
          const hit = store.derefPage(top.page.id, { sessionKey: top.page.sessionKey, query: queryArg, maxLines: 120 });
          payload = {
            pageId: top.page.id,
            refId: top.page.refId,
            sessionKey: top.page.sessionKey,
            filePath: top.page.filePath,
            startLine: hit?.startLine ?? 1,
            endLine: hit?.endLine ?? 0,
            text: hit?.text ?? '',
          };
        }
      }
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const p = payload as { pageId: string; refId?: string; filePath?: string; startLine: number; endLine: number; text: string };
        console.log(`[fiche mmu] ${p.pageId} (${p.filePath ?? p.refId ?? 'block'} L${p.startLine}-${p.endLine})\n${p.text}`);
      }
      process.exit(0);
    }

    let statsPayload: unknown;
    let statsHttpError: string | undefined;
    const statsQs = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : '';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/mmu/stats${statsQs}`, {
        signal: AbortSignal.timeout(400),
      });
      if (res.ok) {
        statsPayload = await res.json();
      } else {
        const errJson = (await res.json().catch(() => null)) as { error?: string } | null;
        statsHttpError = errJson?.error ?? `HTTP ${res.status}`;
      }
    } catch {
      // Daemon unreachable — fallback to offline mmu-pages.json below if present
    }
    if (statsHttpError) {
      console.error(`[fiche] ${statsHttpError}`);
      process.exit(1);
    }
    if (!statsPayload) {
      applyConfigFileDefaults();
      const effectiveMmu = applyMmuLimitsFromEnv();
      configureMmuPersistence(
        fileMmuPersistenceStore(mmuPath, { maxFileBytes: scaledMmuFileMaxBytes(effectiveMmu.maxBytes) }),
      );
      const store = getGlobalMmuStore();
      const pages = store.listPages(sessionKey);
      const safePages = pages.slice(0, 50).map((p) => {
        if (sessionKey) return p;
        const { factTokens: _omitted, ...rest } = p;
        return rest;
      });
      statsPayload = { stats: store.getStats(), pageCount: pages.length, pages: safePages };
    }
    if (asJson) {
      console.log(JSON.stringify(statsPayload, null, 2));
    } else {
      const data = statsPayload as {
        stats: { activePages: number; pagesStored: number; tailHydrations: number; markovFolds: number; skillsStubbed: number; densityPrunedBlocks: number };
        pages?: Array<{ id: string; refId: string; filePath?: string; lineCount: number }>;
      };
      const st = data.stats;
      console.log(
        `[fiche mmu] activePages=${st.activePages} stored=${st.pagesStored} hydrations=${st.tailHydrations} markovFolds=${st.markovFolds} skillStubs=${st.skillsStubbed} densityPruned=${st.densityPrunedBlocks}`,
      );
      if (sub === 'pages' && data.pages) {
        for (const p of data.pages) {
          console.log(`  ${p.id}  ${String(p.lineCount).padStart(4)}L  ${p.filePath ?? p.refId}`);
        }
      }
    }
    process.exit(0);
  }
  if (argv[0] !== undefined && !argv[0].startsWith('-') && argv[0] !== 'warp') {
    console.error(`[fiche] unknown command: ${argv[0]}`);
    console.error(
      '[fiche] supported commands: mcp, providers, models, service, status, shell-init, export, stats, turn-report, calibrate, mmu, warp (run `fiche --help` for usage)',
    );
    process.exit(2);
  }
  // `warp` runs an agent behind a CONNECT proxy and redirects its inference
  // traffic into the fiche instance already running. It starts no proxy of its own, so
  // it exits through its own branch below rather than falling through here.
  let warpCommand: string[] | undefined;
  let warpAppSpec: string | undefined;
  let warpPortOverride: number | undefined;
  let warpProvidersSpec: string | undefined;
  let warpAllProviders = false;
  let warpVerbose = false;
  const warpRoutes: string[] = [];
  let cliArgv = argv;
  if (argv[0] === 'warp') {
    const sep = argv.indexOf('--');
    warpCommand = sep < 0 ? [] : argv.slice(sep + 1);
    // warp's own flags live before the `--`; parseCli accepts none of them, so
    // they are consumed here rather than passed through.
    const warpArgv = argv.slice(1, sep < 0 ? argv.length : sep);
    const rest: string[] = [];
    for (let i = 0; i < warpArgv.length; i += 1) {
      const a = warpArgv[i]!;
      if (a === '--app') {
        const spec = warpArgv[i + 1];
        if (spec === undefined) {
          console.error('[fiche] warp: --app needs a macOS app name or .app path (e.g. Cursor, Antigravity)');
          process.exit(2);
        }
        warpAppSpec = spec;
        i += 1;
        continue;
      }
      if (a.startsWith('--app=')) {
        warpAppSpec = a.slice('--app='.length);
        continue;
      }
      if (a === '--route') {
        const spec = warpArgv[i + 1];
        if (spec === undefined) {
          console.error('[fiche] warp: --route needs PATTERN=TARGET');
          process.exit(2);
        }
        warpRoutes.push(spec);
        i += 1;
        continue;
      }
      if (a.startsWith('--route=')) {
        warpRoutes.push(a.slice('--route='.length));
        continue;
      }
      if (a === '--providers' || a === '--provider') {
        const spec = warpArgv[i + 1];
        if (spec === undefined) {
          console.error(`[fiche] warp: ${a} needs comma-separated provider ids, "all", or "none"`);
          process.exit(2);
        }
        warpProvidersSpec = spec;
        i += 1;
        continue;
      }
      if (a.startsWith('--providers=')) {
        warpProvidersSpec = a.slice('--providers='.length);
        continue;
      }
      if (a.startsWith('--provider=')) {
        warpProvidersSpec = a.slice('--provider='.length);
        continue;
      }
      if (a === '--all-providers') {
        warpAllProviders = true;
        continue;
      }
      if (a === '-v' || a === '--verbose') {
        warpVerbose = true;
        continue;
      }
      if (a === '--port') {
        const spec = warpArgv[i + 1];
        warpPortOverride = parseStrictPortArg(spec, 'warp');
        i += 1;
        continue;
      }
      if (a.startsWith('--port=')) {
        warpPortOverride = parseStrictPortArg(a.slice('--port='.length), 'warp');
        continue;
      }
      rest.push(a);
    }
    cliArgv = rest;
  }
  // Stats / sessions / cleanup tools live in the dashboard
  // (see http://127.0.0.1:${port}/).
  const opts = parseCli(cliArgv);

  // warp only redirects traffic: it decrypts the agent's TLS and re-points the
  // inference path at the fiche instance you already have running, so that instance
  // does the transforming, the tracking and the dashboard. Everything below —
  // tracker, proxy pipeline, listener — belongs to that instance, not to us.
  if (warpCommand) {
    let warpProviders: ProviderId[] | undefined;
    if (warpAllProviders) {
      warpProviders = PROVIDER_CATALOG.map((p) => p.id);
    } else if (warpProvidersSpec !== undefined) {
      const parsed = parseProvidersSpec(warpProvidersSpec);
      if (parsed.unknown.length > 0 || parsed.providers === null) {
        console.error(
          `[fiche] warp: unknown provider(s): ${parsed.unknown.join(', ')} (available: ${PROVIDER_CATALOG.map((p) => p.id).join(', ')})`,
        );
        process.exit(2);
      }
      warpProviders = parsed.providers;
    }
    let resolvedWarpApp: ResolvedMacApp | undefined;
    if (warpAppSpec !== undefined) {
      resolvedWarpApp = resolveMacAppBundle(warpAppSpec) ?? undefined;
      if (!resolvedWarpApp) {
        console.error(
          `[fiche] warp: could not find macOS app "${warpAppSpec}" in /Applications or ~/Applications`,
        );
        process.exit(2);
      }
    }
    createWarpRuntime({
      port: warpPortOverride ?? opts.port,
      routes: warpRoutes,
      providers: warpProviders,
      verbose: warpVerbose,
      app: resolvedWarpApp,
    }).launch(warpCommand);
    return;
  }
  // Capture systemd / fiche-launchd-exec socket activation state early and strip
  // LISTEN_FDS / LISTEN_PID so child processes do not re-inherit fd 3.
  const inheritedListenFd = resolveInheritedListenFd(process.env, process.pid);
  delete process.env.LISTEN_FDS;
  delete process.env.LISTEN_PID;
  // A/B harness passthrough switch (see the `transform` callback below).
  const forcePassthrough = /^(1|true|yes|on)$/i.test(readBrandEnv('DISABLE') ?? '');
  const trustAdjacent = resolveTrustAdjacentToolRoundsEnv(readBrandEnv('TRUST_ADJACENT_TOOL_ROUNDS'));
  const trustAdjacentToolRounds = trustAdjacent.value;
  if (trustAdjacent.warning) console.warn(trustAdjacent.warning);
  if (forcePassthrough) {
    console.log('[fiche] FICHE_DISABLE set — passthrough mode (compress=false), still logging usage + baselines');
  }
  // Subscription bearers expire. A client that froze its bearer at startup — a
  // container handed CLAUDE_CODE_OAUTH_TOKEN as an env var — cannot renew one,
  // so its max session length is the token's remaining life. When this is set we
  // resolve the bearer per request from the file instead, which keeps rotation
  // on the host with a single writer: N parallel containers refreshing their own
  // copies would rotate each other's credential out from under them.
  // Cached on mtime, so it costs a stat per request rather than a read.
  const authTokenFile = process.env.ANTHROPIC_OAUTH_TOKEN_FILE?.trim() || undefined;
  let authTokenCache: { mtimeMs: number; token: string } | undefined;
  const anthropicAuthToken = authTokenFile
    ? (): string | undefined => {
        try {
          const { mtimeMs } = fs.statSync(authTokenFile);
          if (authTokenCache?.mtimeMs !== mtimeMs) {
            authTokenCache = { mtimeMs, token: fs.readFileSync(authTokenFile, 'utf8').trim() };
          }
          return authTokenCache.token || undefined;
        } catch {
          // Mid-rotation the writer may have unlinked it; last good beats none.
          return authTokenCache?.token;
        }
      }
    : undefined;
  if (authTokenFile) {
    console.log(`[fiche] ANTHROPIC_OAUTH_TOKEN_FILE set — bearer resolved per request from ${authTokenFile}`);
  }
  // Debug aid: when FICHE_DUMP_DIR is set, persist every rendered PNG this
  // process emits, so you can eyeball exactly what the model received (OCR /
  // legibility audits, demo inspection). Best-effort — never affects requests.
  // Note: the FICHE_DISABLE arm renders nothing, so only the compress proxy
  // produces files here.
  let imageDumpDir: string | undefined = readBrandEnv('DUMP_DIR')?.trim() || undefined;
  let imageDumpSeq = 0;
  if (imageDumpDir) {
    try {
      ensurePrivateDirectory(imageDumpDir);
      console.log(`[fiche] FICHE_DUMP_DIR set — dumping rendered PNGs to ${imageDumpDir}`);
    } catch (err) {
      console.warn(`[fiche] FICHE_DUMP_DIR unusable (${(err as Error).message}) — image dumping disabled`);
      imageDumpDir = undefined;
    }
  }
  // Transform options pass through empty — the proxy uses the DEFAULTS
  // baked into transform.ts. There are no behavior toggles: system slab,
  // reminders, tool_results, and history compression all run
  // unconditionally; the per-block break-even gate decides per-call
  // whether to actually image each piece. The function-form `transform`
  // below is ONLY a kill switch (INKLING_DISABLE / dashboard toggle →
  // compress:false); on the active path it returns {}, so the gate always
  // runs on static DEFAULTS — charsPerToken=4, priorWarm*=0 — which leaves
  // the warm-baseline and anti-flapping burn terms inert. That is
  // deliberate, NOT an oversight: there is no live-α feedback loop from
  // Local event logs (2026-06, 897 sessions / 21,347 measured
  // rows) showed 5 mode flips ever and losses at 0.8% of wins — all
  // one-time cache-create amortization — so closing the loop would not
  // change decisions. Re-run that reconciliation before wiring one in.
  const isLoopbackHost = isLoopbackHostname(opts.host);
  // IPv6 literals need bracket notation to form a valid URL (http://[::1]:47821).
  const displayHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  const tracker: Tracker = new FileTracker(opts.eventsFile);
  // Sidecar dir for oversized 4xx request-body samples. Lives next to the
  // events.jsonl so a single `rm -rf` cleans up both. Lazy-mkdir'd on first
  // sidecar write (see maybeWriteBodySidecar).
  const bodySidecarDir = path.join(path.dirname(opts.eventsFile), '4xx-bodies');
  const upstreamFetch = createNodeUpstreamFetch();
  const allowedHosts = parseAllowedHosts(readBrandEnv('ALLOWED_HOSTS'));
  const allowPrivateDashboard = /^(1|true|yes|on)$/i.test(
    (readBrandEnv('DASHBOARD_ALLOW_PRIVATE') ?? '').trim(),
  );
  const warpTokenDir = resolveWarpTokenDir();
  let cachedWarpTokenDigest: Buffer | undefined;
  let cachedWarpTokenMtimeMs = -1;
  const verifyWarpAuthHeader = (presented: string | string[] | undefined): boolean => {
    if (typeof presented !== 'string') return false;
    const trimmed = presented.trim();
    if (!trimmed) return false;
    const tokenPath = path.join(warpTokenDir, 'warp-token');
    try {
      let currentMtime = -1;
      try {
        currentMtime = fs.statSync(tokenPath).mtimeMs;
      } catch {
        currentMtime = -1;
      }
      if (!cachedWarpTokenDigest || currentMtime !== cachedWarpTokenMtimeMs) {
        const expected = loadOrCreateWarpToken(warpTokenDir);
        cachedWarpTokenDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
        try {
          cachedWarpTokenMtimeMs = fs.statSync(tokenPath).mtimeMs;
        } catch {
          cachedWarpTokenMtimeMs = Date.now();
        }
      }
      const actualDigest = crypto.createHash('sha256').update(trimmed, 'utf8').digest();
      return crypto.timingSafeEqual(actualDigest, cachedWarpTokenDigest);
    } catch {
      return false;
    }
  };

  let shutdownHandler: ((sig: string) => void) | undefined;
  let activeProxyRequests = 0;
  let shuttingDown = false;
  const shutdownDrainMs = parseShutdownDrainMs(readBrandEnv('SHUTDOWN_DRAIN_MS'));
  const pendingOnRequests = new Set<Promise<void>>();

  let markReady!: () => void;
  let markFailed!: (err: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });
  readyPromise.catch(() => {});

  let dashboard!: DashboardState;
  let upstreamRegistry!: ReturnType<typeof buildUpstreamRegistry>;
  let config!: ProxyConfig;
  let handle!: ReturnType<typeof createProxy>;

  type ConnTrack = { active: number; completed: number };
  const connTrack = new Map<Socket, ConnTrack>();
  const closeIdleSockets = (includeFreshUnstarted: boolean) => {
    for (const [sock, state] of connTrack) {
      if (state.active > 0) continue;
      if (!includeFreshUnstarted && state.completed === 0) continue;
      if (includeFreshUnstarted && state.completed === 0 && sock.bytesRead > 0) continue;
      if (!sock.destroyed && !sock.writableEnded) sock.end();
    }
  };

  let server!: ReturnType<typeof createServer>;
  const boundPort = (): number => {
    const addr = server.address();
    return addr && typeof addr === 'object' ? addr.port : opts.port;
  };

  server = createServer((req, res) => {
    const reqSocket = req.socket;
    reqSocket?.setNoDelay?.(true);
    const connState = reqSocket ? connTrack.get(reqSocket) : undefined;
    if (connState) connState.active++;
    if (shuttingDown && !res.headersSent) res.setHeader('connection', 'close');
    res.once('close', () => {
      if (!connState) return;
      connState.active = Math.max(0, connState.active - 1);
      connState.completed++;
      if (shuttingDown && connState.active === 0 && !reqSocket.destroyed && !reqSocket.writableEnded) {
        setImmediate(() => {
          if (connState.active === 0 && !reqSocket.destroyed && !reqSocket.writableEnded) {
            reqSocket.end();
          }
        });
      }
    });
    Promise.resolve()
      .then(async () => {
        await readyPromise;
        // Local dashboard routes — handled BEFORE the proxy so they never hit
        // api.anthropic.com (which would 404 them).
        const rawReqUrl = req.url ?? '/';
        const rawHostHeader = req.headers.host;
        const isHttp11Plus =
          (req.httpVersionMajor === 1 && req.httpVersionMinor >= 1) || req.httpVersionMajor >= 2;
        if (isHttp11Plus && (!rawHostHeader || !rawHostHeader.trim())) {
          await writeWebResponse(
            new Response(
              JSON.stringify({ error: 'missing_host', message: 'HTTP/1.1+ request requires Host header' }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            ),
            res,
          );
          return;
        }
        const rawHost = rawHostHeader?.trim() || 'localhost';
        const rawHostHostname = extractHostHeaderHostname(rawHost);
        const nonOriginForm =
          rawReqUrl.startsWith('//') || !rawReqUrl.startsWith('/') || rawReqUrl.startsWith('/\\');
        if (nonOriginForm) {
          await writeWebResponse(new Response('invalid request target', { status: 400 }), res);
          return;
        }
        let url: URL;
        try {
          url = new URL(rawReqUrl, `http://${rawHost}`);
        } catch {
          await writeWebResponse(new Response('invalid request target', { status: 400 }), res);
          return;
        }
        const route = dashboardPath(url.pathname);
        if (route) {
          const fetchSite = normalizedSecFetchSite(req);
          const isMutation = isDashboardMutation(route, req.method ?? 'GET');
          const isSensitiveRead =
            route.kind !== 'html' && route.kind !== 'favicon' && route.kind !== 'api-health';
          const remoteAllowed =
            isLoopbackAddress(req.socket.remoteAddress) ||
            (allowPrivateDashboard && isPrivateAddress(req.socket.remoteAddress));
          if (
            !remoteAllowed
            || !isLoopbackHostname(rawHostHostname)
            || !isLoopbackHostname(url.hostname)
            || fetchSite === 'cross-site'
            || ((isMutation || isSensitiveRead) && fetchSite === 'same-site')
          ) {
            await writeWebResponse(new Response('dashboard is loopback-only', { status: 403 }), res);
            return;
          }
          if (
            (isMutation || req.headers.origin !== undefined)
            && !isSameOriginDashboardRequest(req, url)
          ) {
            await writeWebResponse(new Response('cross-origin dashboard request denied', { status: 403 }), res);
            return;
          }
          const webRes = await dispatchDashboard(
            dashboard,
            route,
            req.method ?? 'GET',
            url,
            boundPort(),
            () => readRequestBody(req),
            {
              headers: req.headers,
              controlTokenAuthorized: verifyWarpAuthHeader(req.headers['x-fiche-control-token']),
            },
          );
          if (webRes) {
            await writeWebResponse(webRes, res);
            return;
          }
        }
        // Proxy API: refuse browser cross-site requests and rebound Hosts, which
        // would otherwise spend the configured keys (see core/request-guard.ts).
        const denial = guardProxyRequest(
          {
            host: req.headers.host,
            origin: req.headers.origin,
            secFetchSite: typeof req.headers['sec-fetch-site'] === 'string'
              ? req.headers['sec-fetch-site']
              : undefined,
          },
          {
            allowedHosts,
            providerHosts: new Set(upstreamRegistry.keys()),
            warpAuthenticated: verifyWarpAuthHeader(req.headers['x-fiche-warp-auth']),
            httpVersionMajor: req.httpVersionMajor,
            httpVersionMinor: req.httpVersionMinor,
          },
        );
        if (denial) {
          await writeWebResponse(new Response(JSON.stringify({ error: denial.reason, message: denial.message }), {
            status: denial.status,
            headers: { 'content-type': 'application/json' },
          }), res);
          return;
        }
        activeProxyRequests++;
        const clientAbort = new AbortController();
        const onReqAborted = () => {
          if (!clientAbort.signal.aborted) clientAbort.abort(new Error('client request aborted'));
        };
        const onReqClose = () => {
          if (!req.complete && !clientAbort.signal.aborted) {
            clientAbort.abort(new Error('client request closed prematurely'));
          }
        };
        const onResClose = () => {
          if (!res.writableFinished && !clientAbort.signal.aborted) {
            clientAbort.abort(new Error('client disconnected'));
          }
        };
        req.once('aborted', onReqAborted);
        req.once('close', onReqClose);
        res.once('close', onResClose);
        try {
          const webReq = toWebRequest(req, clientAbort.signal);
          const webRes = await handle(webReq);
          if (clientAbort.signal.aborted || res.destroyed || res.writableEnded) {
            await webRes.body?.cancel().catch(() => undefined);
            return;
          }
          // If the handler answered without draining the request body (e.g. an
          // early 413), close the keep-alive socket after flushing the response
          // so unread body bytes cannot desync the next pipelined request.
          if (!req.complete && !res.headersSent) res.setHeader('connection', 'close');
          await writeWebResponse(webRes, res);
        } finally {
          req.off('aborted', onReqAborted);
          req.off('close', onReqClose);
          res.off('close', onResClose);
          activeProxyRequests = Math.max(0, activeProxyRequests - 1);
          if (shuttingDown && activeProxyRequests === 0) {
            closeIdleSockets(false);
          }
        }
      })
      .catch((err) => {
        if (isConnectionAbort(err) && (req.aborted || res.destroyed)) return;
        console.error('[fiche] handler error:', err);
        if (!res.headersSent) res.statusCode = 500;
        if (!res.writableEnded) res.end();
      });
  });
  server.requestTimeout = 0;
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    connTrack.set(socket, { active: 0, completed: 0 });
    socket.once('close', () => {
      connTrack.delete(socket);
    });
  });

  let listeningStarted = false;
  server.on('error', (err) => {
    console.error('[fiche] server error:', err);
    if (!listeningStarted) {
      markFailed(err);
      process.exit(1);
    }
  });

  // server.close() only stops accepting new connections and waits for open
  // ones to drain — it does NOT end idle keep-alive sockets. The dashboard tab
  // (htmx polls every 2s) and coding agent clients hold keep-alive sockets
  // open, so we drop idle sockets immediately, allow active SSE streams to
  // drain up to `shutdownDrainMs` (default 60s when activeProxyRequests > 0,
  // 1.5s when idle), and let a second signal exit immediately.
  let flushedOnExit = false;
  const flushAndExit = async (exitCode: number): Promise<void> => {
    if (!flushedOnExit) {
      flushedOnExit = true;
      if (pendingOnRequests.size > 0) {
        await Promise.race([
          Promise.allSettled([...pendingOnRequests]),
          new Promise<void>((r) => setTimeout(r, 300)),
        ]);
      }
      // Pins first: losing a freeze-step floor re-keys a whole prefix.
      upstreamFetch.destroy();
      flushSessionState();
      flushMmuPersistence();
      // Flush+close the tracker so we don't drop the last few events on exit.
      if (tracker instanceof FileTracker) tracker.close();
    }
    process.exit(exitCode);
  };
  let firstShutdownSignal: string | undefined;
  let apiShutdownTermIgnored = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) {
      if (firstShutdownSignal === 'API_SHUTDOWN' && sig === 'SIGTERM' && !apiShutdownTermIgnored) {
        apiShutdownTermIgnored = true;
        console.log('[fiche] SIGTERM received during API_SHUTDOWN drain — continuing graceful drain');
        return;
      }
      console.log(`[fiche] ${sig} again — forcing exit`);
      if (!flushedOnExit) {
        flushedOnExit = true;
        upstreamFetch.destroy();
        flushSessionState();
        flushMmuPersistence();
        if (tracker instanceof FileTracker) tracker.close();
      }
      process.exit(130);
    }
    shuttingDown = true;
    firstShutdownSignal = sig;
    const drainMs = activeProxyRequests > 0 ? shutdownDrainMs : 1500;
    if (activeProxyRequests > 0) {
      console.log(
        `[fiche] ${sig} — draining ${activeProxyRequests} active request(s) ` +
          `(up to ${Math.round(drainMs / 1000)}s); send ${sig} again to force exit`,
      );
    } else {
      console.log(`[fiche] ${sig} — shutting down`);
    }
    // Drain in-flight connections first so late finishing requests don't lose
    // session state or write to an already-closed tracker.
    const idleSweep = setTimeout(() => {
      closeIdleSockets(true);
    }, 500);
    idleSweep.unref();
    const deadline = setTimeout(() => {
      clearTimeout(idleSweep);
      server.closeAllConnections?.();
      void flushAndExit(0);
    }, drainMs);
    deadline.unref();
    // Use net.Server.prototype.close directly so Node 19+ httpServerPreClose()
    // does not call closeIdleConnections() and destroy() freshly accepted
    // sockets whose HTTP request bytes are still pre-parse (TCP RST / ECONNRESET).
    // Idle keep-alive sockets are gracefully ended via connTrack below.
    NetServer.prototype.close.call(server, () => {
      clearTimeout(idleSweep);
      clearTimeout(deadline);
      void flushAndExit(0);
    });
    // Drop idle keep-alive sockets immediately while giving freshly accepted
    // sockets a brief window to deliver their first request bytes cleanly.
    closeIdleSockets(false);
  };
  shutdownHandler = shutdown;
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const announce = () => {
    const routes = resolveUpstreams(config);
    console.log(`[fiche] anthropic upstream → ${routes.anthropic}`);
    console.log(`[fiche] openai upstream → ${routes.openai}`);
    if (opts.cloudflareUpstream !== undefined) {
      console.log(
        `[fiche] cloudflare upstream → ${chatCompletionsUrl(opts.cloudflareUpstream)} ` +
          `(models: ${opts.cloudflareModels?.join(', ') || 'none'})`,
      );
    }
    console.log(`[fiche] tracking events → ${opts.eventsFile}`);
    if (opts.captureErrorReqBody) {
      console.warn(
        `[fiche] FICHE_DEBUG_CAPTURE_4XX=1 — persisting full 4xx request and ` +
          `upstream error bodies (prompts + any secrets in context) to ${bodySidecarDir}. ` +
          `Debugging only.`,
      );
    }
  };

  // Bind BEFORE slow store/replay restoration so socket-activated restarts and
  // cold boots start accepting TCP connections into the backlog immediately.
  const onListening = () => {
    listeningStarted = true;
    const listenPort = boundPort();
    const mode = inheritedListenFd !== null ? ` (socket-activated fd=${inheritedListenFd})` : '';
    console.log(`[fiche] listening on http://${displayHost}:${listenPort}${mode}`);
    if (!isLoopbackHost) {
      console.warn(
        `[fiche] bound to ${opts.host}; proxy API is reachable off-host, ` +
          `but dashboard routes remain loopback-only.`,
      );
    }
    void readyPromise.then(() => {
      announce();
      console.log(`[fiche] dashboard → http://127.0.0.1:${listenPort}/`);
    }).catch(() => {});
  };
  if (inheritedListenFd !== null) {
    server.listen({ fd: inheritedListenFd }, onListening);
  } else {
    server.listen(opts.port, opts.host, onListening);
  }

  try {
    const maxSessionsEnv = parseOptionalPositiveIntEnv('MAX_SESSIONS');
    if (maxSessionsEnv !== undefined) {
      const effectiveSessions = configureMaxSessions(maxSessionsEnv);
      console.log(`[fiche] session state limit: max ${effectiveSessions} sessions`);
    }
    const mmuMaxPagesEnv = parseOptionalPositiveIntEnv('MMU_MAX_PAGES');
    const mmuMaxMbEnv = parseOptionalPositiveIntEnv('MMU_MAX_MB');
    const effectiveMmu = applyMmuLimitsFromEnv();
    if (mmuMaxPagesEnv !== undefined || mmuMaxMbEnv !== undefined) {
      console.log(
        `[fiche] context-mmu limits: max ${effectiveMmu.maxPages} pages, ` +
          `${Math.round(effectiveMmu.maxBytes / (1024 * 1024))} MiB`,
      );
    }
    if (opts.sessionStateFile) {
      const restored = configureSessionStateStore(fileSessionStateStore(opts.sessionStateFile));
      console.log(`[fiche] session state: ${restored} session(s) restored from ${opts.sessionStateFile}`);
    } else {
      console.log('[fiche] session state: persistence off (FICHE_SESSION_STATE)');
    }
    try {
      const calPath = defaultCalibratedProfilesPath();
      const calCount = loadCalibratedProfilesFile(calPath);
      if (calCount > 0) {
        console.log(`[fiche] calibration: ${calCount} calibrated model profile(s) loaded from ${calPath}`);
      }
    } catch {
      // Best-effort calibration restore
    }
    const mmuPersistEnabled =
      Boolean(opts.sessionStateFile) && /^(1|true|yes|on)$/i.test(readBrandEnv('MMU_PERSIST') ?? '');
    if (mmuPersistEnabled) {
      try {
        const mmuPath = path.join(path.dirname(opts.sessionStateFile!), 'mmu-pages.json');
        const mmuPages = configureMmuPersistence(
          fileMmuPersistenceStore(mmuPath, { maxFileBytes: scaledMmuFileMaxBytes(effectiveMmu.maxBytes) }),
        );
        if (mmuPages > 0) {
          console.log(`[fiche] context-mmu: ${mmuPages} virtual page(s) restored from ${mmuPath}`);
        }
      } catch {
        // Best-effort MMU restore
      }
    } else {
      console.log('[fiche] context-mmu: memory-only (set FICHE_MMU_PERSIST=1 to enable disk persistence)');
    }

    // Live dashboard state — populated on every request via onRequest below,
    // served via the route interception in front of the proxy handler. The
    // SessionsPaths handle lets the dashboard surface session/disk/stats data
    // without reaching back into module-scope globals.
    dashboard = new DashboardState(
      {
        eventsFile: opts.eventsFile,
        sidecarDir: bodySidecarDir,
      },
      undefined,
      persistModelBasesToConfig,
      {
        version: resolvedCliVersion(),
        host: opts.host,
        listPlugins: listNodeStagePlugins,
        setPluginEnabled: setNodePluginEnabled,
        setThirdPartyPluginsEnabled: setNodeThirdPartyPluginsEnabled,
        onProvidersPersist: persistProvidersToConfig,
        onShutdown: () => shutdownHandler?.('API_SHUTDOWN'),
        getActiveRequests: () => activeProxyRequests,
        verifyControlToken: verifyWarpAuthHeader,
      },
    );
    // Seed the "recent requests" table from the JSONL log so a process restart
    // doesn't reset what you can see in the UI. Best-effort; ignored on error.
    await dashboard.replay(opts.eventsFile).catch(() => {});

    // Follow the agent to its own third-party host (warp Host, or /to/<host>/).
    upstreamRegistry = buildUpstreamRegistry(parseUpstreamHosts(readBrandEnv('UPSTREAM_HOSTS')));
    const followHosts = !/^(?:0|false|off|no)$/i.test((readBrandEnv('FOLLOW_HOSTS') ?? '').trim());
    const DEFAULT_NODE_MAX_REQUEST_BYTES = 64 << 20;
    config = {
    fetch: upstreamFetch.fetch,
    authToken: anthropicAuthToken,
    provider: opts.provider,
    gatewayBaseUrl: opts.gatewayBaseUrl,
    gatewayHeaders: opts.gatewayHeaders,
    upstream: opts.upstream,
    sharedUpstream: opts.sharedUpstream,
    openAIUpstream: opts.openAIUpstream,
    openAIApiKey: opts.openAIApiKey,
    googleUpstream: opts.googleUpstream,
    cloudflareUpstream: opts.cloudflareUpstream,
    cloudflareApiKey: opts.cloudflareApiKey,
    openAIModels: opts.openAIModels,
    cloudflareModels: opts.cloudflareModels,
    captureErrorReqBody: opts.captureErrorReqBody,
    maxRequestBytes: opts.maxRequestBytes ?? (isLoopbackHost ? DEFAULT_NODE_MAX_REQUEST_BYTES : undefined),
    oversizedBodyPolicy: isLoopbackHost ? 'passthrough' : 'reject',
    decodeRequestBody: decodeRequestBodyWithStatus,
    followHosts,
    upstreamRegistry,
    enabledProviders: () => getEnabledProviders(),
    // Per-request transform options:
    //   1. Runtime kill switch — when the dashboard "passthrough" toggle
    //      is off, force compress=false so /v1/messages forwards
    //      untransformed. Lets the operator instantly disable the proxy
    //      when upstream is unhealthy without restarting.
    //   2. Otherwise use DEFAULTS in transform.ts for break-even gating.
    transform: () => {
      // A/B harness: INKLING_DISABLE=1 forces passthrough (compress=false) for the
      // whole process, so the "normal" arm can be scripted on its own port while
      // still logging real usage + count_tokens baselines to its own INKLING_LOG.
      // (The dashboard kill switch does the same thing at runtime.)
      if (forcePassthrough || !dashboard.getCompressionEnabled()) return { compress: false };
      const toggles = stageTogglesFromOverrides(getActivePluginOverrides());
      const hasDisabledStage =
        !toggles.optical ||
        !toggles.tscg ||
        !toggles.toon ||
        !toggles.acdc ||
        !toggles.casi ||
        !toggles.lsm ||
        !toggles.mmu ||
        !toggles.skillLinker;
      const rawHorizon = (readBrandEnv('HISTORY_AMORTIZATION_HORIZON') ?? '').trim();
      const parsedHorizon = rawHorizon ? Number.parseInt(rawHorizon, 10) : NaN;
      const horizonOpt =
        Number.isFinite(parsedHorizon) && parsedHorizon >= 1 && parsedHorizon <= 100
          ? { historyAmortizationHorizon: parsedHorizon }
          : {};
      return {
        ...horizonOpt,
        ...(hasDisabledStage ? { stageToggles: toggles } : {}),
        ...(trustAdjacentToolRounds !== undefined ? { separateAdjacentToolPairs: trustAdjacentToolRounds } : {}),
      };
    },
    onRequest: (e) => {
      const task = (async () => {
        try {
          // Feed the dashboard BEFORE tracker.emit — toTrackEvent strips
          // info.firstImagePng, so capturing has to happen on the raw event.
          dashboard.update(e);
          // Debug: persist this request's rendered PNGs (see INKLING_DUMP_DIR above).
          // Filenames sort by request order: <stamp>_reqNNN_<model>_pNN.png.
          if (imageDumpDir && e.info?.imagePngs && e.info.imagePngs.length > 0) {
            const seq = ++imageDumpSeq;
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const modelTag = (e.model ?? 'model').replace(/[^A-Za-z0-9._-]+/g, '_');
            const pngs = e.info.imagePngs;
            for (let i = 0; i < pngs.length; i++) {
              const name = `${stamp}_req${String(seq).padStart(3, '0')}_${modelTag}_p${String(i + 1).padStart(2, '0')}.png`;
              try {
                fs.writeFileSync(path.join(imageDumpDir, name), pngs[i]!, { mode: 0o600 });
              } catch (err) {
                console.warn(`[fiche] PNG dump write failed: ${(err as Error).message}`);
                break; // dir vanished / full — stop hammering it this request
              }
            }
            console.log(`  ↳ dumped ${pngs.length} rendered png(s) → ${imageDumpDir}`);
          }
          // Terse human-readable console line.
          const extra: string[] = [];
          if (e.info?.toolResultImgs) extra.push(`tr+${e.info.toolResultImgs}`);
          if ((e.info?.textHygieneSavedTokens ?? 0) > 0) {
            const stagesLabel = (e.info?.textHygieneStages ?? []).length > 0
              ? `[${e.info!.textHygieneStages!.join('+')}]`
              : '';
            extra.push(`text=-${e.info!.textHygieneSavedTokens}tok${stagesLabel}`);
          }
          const extraTag = extra.length > 0 ? ` (${extra.join(' ')})` : '';
          const baseTag = e.info?.compressed
            ? `compressed ${e.info.origChars}ch → ${e.info.imageCount}img/${e.info.imageBytes}B${extraTag}`
            : e.info?.reason
              ? e.info.reason === 'unsupported_model' && e.model
                ? `skip(unsupported=${e.model})${extraTag}`
                : `skip(${e.info.reason})${extraTag}`
              : extraTag.trim();
          const tag = baseTag;
          const cacheRead = e.usage?.cache_read_input_tokens ?? e.usage?.cached_tokens ?? 0;
          const inputTokens = e.usage?.input_tokens ?? 0;
          const usageTag =
            e.usage !== undefined
              ? ` tokens=${inputTokens}+${e.usage.output_tokens ?? 0} cache_read=${cacheRead}`
              : '';
          // Split the wall clock into the half we control and the half we don't:
          // `tx` is local render+encode, the remainder is upstream. Without this the
          // duration alone can't distinguish our CPU from a slow provider.
          //
          // `fb` further splits the upstream half: request start → response headers,
          // so it covers upload + provider queue/processing but NOT generation. With
          // all three, `fb - tx` isolates how much a large image payload costs to put
          // on the wire, which is the number that decides whether shrinking IDATs pays.
          const timingParts = [`${e.durationMs}ms`];
          if (e.transformMs !== undefined) {
            timingParts.push(
              `tx=${e.transformMs}ms`,
              `up=${Math.max(0, e.durationMs - e.transformMs)}ms`,
            );
          }
          if (e.firstByteMs !== undefined) timingParts.push(`fb=${e.firstByteMs}ms`);
          const timing = timingParts.join(' ');
          console.log(
            `[${new Date().toISOString()}] ${e.method} ${e.path} → ${e.status} (${timing}) ${tag}${usageTag}`,
          );

          // Upstream error bodies are present only under INKLING_DEBUG_CAPTURE_4XX;
          // custom gateways may echo prompt fragments or credentials in them.
          if (e.errorBody) {
            const redacted = redactSecrets(e.errorBody);
            const trimmed = redacted.length > 400
              ? redacted.slice(0, 400) + '…'
              : redacted;
            console.warn(`[fiche ${e.status}] upstream body: ${trimmed}`);
          }

          // Canary: surface unknown tag-shaped blocks so a Claude Code release
          // that adds a new dynamic tag is caught within hours.
          if (e.info?.unknownStaticTags && e.info.unknownStaticTags.length > 0) {
            console.warn(
              `[fiche warn] unknown tag(s) in static slab: ${e.info.unknownStaticTags.join(', ')}  ` +
                `— may need to add to DYNAMIC_BLOCK_TAGS (per-turn) or KNOWN_STATIC_TAGS (static) in src/core/transform.ts`,
            );
          }

          // If the proxy captured a gzipped 4xx body that won't fit inline in
          // the JSONL row, write it to a sidecar file and put the path on the
          // event instead. Threshold: gz_bytes * 4/3 > inline cap (b64 expansion).
          if (e.reqBodyGz && e.reqBodyGz.byteLength * 4 > TRACK_BODY_INLINE_MAX * 3) {
            const writtenPath = await maybeWriteBodySidecar(
              e.reqBodyGz,
              e.reqBodySha8,
              bodySidecarDir,
            );
            if (writtenPath) {
              e.reqBodySamplePath = writtenPath;
              e.reqBodyGz = undefined; // tracker will pick up the path instead
            }
            // If write failed: leave reqBodyGz; the tracker will silently drop
            // it (still too big to inline). We never lose the sha8 / error_body.
          }

          // Persistent JSONL event for offline analysis (inkling stats etc.).
          tracker.emit(toTrackEvent(e));
        } catch (err) {
          console.warn(
            `[fiche] onRequest telemetry failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
      pendingOnRequests.add(task);
      void task.finally(() => {
        pendingOnRequests.delete(task);
      });
      return task;
    },
  };
    handle = createProxy(config);
    markReady();
  } catch (err) {
    markFailed(err);
    throw err;
  }
}

main().catch((err) => {
  console.error('[fiche] fatal:', err);
  process.exit(1);
});
