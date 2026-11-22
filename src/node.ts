/**
 * Node entrypoint — `node:http` server + minimal CLI flag parsing.
 *
 * Wraps the runtime-agnostic `createProxy` from src/core/proxy.ts. The
 * heavy lifting (transform, render, PNG) is identical to the Worker
 * version; only the request/response plumbing differs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createWarpRuntime } from './warp/index.js';
import {
  renderShellInitScript,
  resolveMacAppBundle,
  type ResolvedMacApp,
} from './warp/app-launch.js';
import { runMcpCommand } from './mcp/cli.js';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isIP } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProxy, parseGatewayHeaders, resolveUpstreams, type ProxyConfig } from './core/proxy.js';
import { readBrandEnv } from './core/env.js';
import { guardProxyRequest, parseAllowedHosts } from './core/request-guard.js';
import { buildUpstreamRegistry, parseUpstreamHosts } from './core/upstream-hosts.js';
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
import { decodeRequestBody } from './request-decoding.js';
import {
  toTrackEvent,
  TRACK_BODY_INLINE_MAX,
  type Tracker,
  type TrackEvent,
} from './core/tracker.js';
import {
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

/** Runtime config. The core transform tuning comes from DEFAULTS in
 *  transform.ts; startup knobs cover deployment plus emergency GPT scope
 *  control. No CLI flags beyond --help/--version. */
interface RuntimeConfig {
  port: number;
  /** Interface to bind. Defaults to 127.0.0.1; non-loopback bindings expose
   *  only the proxy API because dashboard routes remain loopback-only. */
  host: string;
  upstream: string;
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
      const dir = path.dirname(file);
      const parentExists = fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!parentExists) fs.chmodSync(dir, 0o700);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
        fs.chmodSync(file, 0o600);
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* nothing to clean */
        }
        throw err;
      }
    },
  };
}

function normalizeModelsConfig(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const models = value.map((v) => String(v).trim()).filter(Boolean);
    return models.length > 0 ? models.join(',') : 'off';
  }
  if (typeof value === 'string') return value.trim() || 'off';
  return undefined;
}

function applyConfigFileDefaults(): void {
  const explicit = readBrandEnv('CONFIG');
  const file = explicit ?? (fs.existsSync(DEFAULT_CONFIG_FILE) || !fs.existsSync(LEGACY_CONFIG_FILE) ? DEFAULT_CONFIG_FILE : LEGACY_CONFIG_FILE);
  if (!fs.existsSync(file)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    console.warn(`[fiche] ignored invalid config ${file}: ${(e as Error).message}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const cfg = parsed as Record<string, unknown>;

  // Env wins over file config. The dashboard can still override the scope at
  // runtime (in-memory) for an emergency live flip.
  if (readBrandEnv('MODELS') === undefined) {
    const models = normalizeModelsConfig(cfg.models);
    if (models !== undefined) process.env.FICHE_MODELS = models;
  }
}

/** Dashboard persistence hook: write the runtime model scope back to the
 *  config file's `models` key so chip toggles survive a restart. Other keys
 *  are preserved; an invalid existing file is left untouched.
 *  NOTE: on the next start an explicit FICHE_MODELS / INKLING_MODELS env still
 *  wins over the persisted value. */
function persistModelBasesToConfig(bases: readonly string[]): void {
  const file = readBrandEnv('CONFIG') ?? DEFAULT_CONFIG_FILE;
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[fiche] could not persist model scope: invalid config object ${file}`);
      return;
    }
    cfg = parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[fiche] could not persist model scope: invalid config ${file}: ${(e as Error).message}`);
      return;
    }
  }
  // Empty array round-trips as 'off' via normalizeModelsConfig on load.
  cfg.models = [...bases];
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const parentExists = fs.existsSync(path.dirname(file));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!parentExists) fs.chmodSync(path.dirname(file), 0o700);
    // Write-then-rename so a crash mid-write can't corrupt the config.
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The write may have failed before the temporary file was created.
    }
    console.warn(`[fiche] could not persist model scope to ${file}: ${(e as Error).message}`);
  }
}

// ---- Stage plugins & skills discovery + persistence ------------------------

function resolvePluginsConfigFile(): string {
  return readBrandEnv('PLUGINS_CONFIG')?.trim()
    || path.join(os.homedir(), '.config', 'fiche', 'plugins.json');
}

const FORBIDDEN_OVERRIDE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let pluginOverridesCache:
  | { file: string; mtimeMs: number; overrides: PluginOverrides }
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
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (
    pluginOverridesCache &&
    pluginOverridesCache.file === file &&
    pluginOverridesCache.mtimeMs === mtimeMs
  ) {
    return pluginOverridesCache.overrides;
  }
  const overrides = mtimeMs >= 0 ? loadPluginOverrides(file) : (Object.create(null) as PluginOverrides);
  pluginOverridesCache = { file, mtimeMs, overrides };
  return overrides;
}

function savePluginOverrides(overrides: PluginOverrides, file = resolvePluginsConfigFile()): void {
  const dir = path.dirname(file);
  const parentExists = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!parentExists) fs.chmodSync(dir, 0o700);
  const sanitized = Object.create(null) as PluginOverrides;
  for (const [k, v] of Object.entries(overrides)) {
    if (!FORBIDDEN_OVERRIDE_KEYS.has(k) && typeof v === 'boolean') {
      sanitized[k] = v;
    }
  }
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    pluginOverridesCache = undefined;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
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
  return {
    port: Number(process.env.PORT ?? 47821),
    // Loopback by default; opt into all-interfaces exposure explicitly via HOST.
    host: process.env.HOST?.trim() || '127.0.0.1',
    upstream: process.env.ANTHROPIC_UPSTREAM ?? sharedUpstream ?? 'https://api.anthropic.com',
    openAIUpstream: process.env.OPENAI_UPSTREAM ?? sharedUpstream ?? 'https://api.openai.com',
    openAIApiKey: process.env.OPENAI_API_KEY,
    googleUpstream: process.env.GOOGLE_UPSTREAM,
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
  fiche export [...]     render files/diff to PNG pages + cost report (see fiche export --help)
  fiche mcp [--http P]   MCP server for every agent (stdio, or Streamable HTTP)
  fiche warp [--app <Name|Path>] [--route PATTERN=TARGET]... -- CMD
                        run a CLI or macOS desktop app (Cursor, Antigravity,
                        OpenCode, Claude, Runic...) behind the proxy without a
                        custom base URL, so client-side first-party gates keep
                        working.
  fiche shell-init [--wrap]
                        print zsh/bash helper functions (fclaude, fcodex, fagy,
                        fcursor, fiche-app) or transparent wrappers (--wrap).
  fiche stats [--json] [--file <p>]
                        summarize the events log offline (no server needed),
                        incl. measured savings; defaults to $FICHE_LOG
  fiche turn-report [--format cli|agy|claude-statusline|json]
                        report latest turn & session savings with zero LLM tokens
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
  PORT                    listen port (default 47821)
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
  FICHE_UPSTREAM_HOSTS    extra provider hosts to follow (comma list of
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
                          supports {"models": [...]} or {"models": "off"}
  FICHE_LOG               JSONL events path (default ~/.fiche/events.jsonl)
  FICHE_SESSION_STATE     where per-session cache pins (freeze-step floor, cache
                          liveness) survive a restart; 0/off disables
                          (default ~/.fiche/session-state.json). Without it a
                          restart drops every live session's floor.
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
  return injected ?? process.env.npm_package_version ?? '0.17.0';
}

function printVersion(): void {
  console.log(resolvedCliVersion());
}

// ---- node:http <-> Web Request/Response bridge ---------------------------

function toWebRequest(req: IncomingMessage): Request {
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

  // Stream the body with explicit listener cleanup and abort/cancel guards so
  // cancelling mid-stream (e.g. >16 MiB cap) never enqueues onto a closed stream.
  let body: BodyInit | undefined;
  if (hasBody) {
    let closed = false;
    let onData: ((chunk: Buffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    let onError: ((err: Error) => void) | undefined;
    let onClose: (() => void) | undefined;
    const detach = () => {
      if (onData) req.off('data', onData);
      if (onEnd) req.off('end', onEnd);
      if (onError) req.off('error', onError);
      if (onClose) req.off('close', onClose);
    };
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        onData = (chunk: Buffer) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            closed = true;
            detach();
            req.destroy();
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
        onClose = () => {
          if (closed) return;
          if (!req.complete) {
            onError?.(new Error('client request aborted'));
          }
        };
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('close', onClose);
      },
      cancel() {
        if (closed) return;
        closed = true;
        detach();
        req.destroy();
      },
    });
  }

  return new Request(url, {
    method,
    headers,
    body,
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
  const cancelBody = () => {
    if (!finished) void reader.cancel().catch(() => undefined);
  };
  out.once('close', cancelBody);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && !out.write(value)) await waitForDrain(out);
    }
    if (!out.writableEnded) out.end();
  } catch (err) {
    if (isConnectionAbort(err) || out.destroyed || out.writableEnded) {
      if (!out.destroyed && !out.writableEnded) out.destroy(err instanceof Error ? err : undefined);
      return;
    }
    throw err;
  } finally {
    finished = true;
    out.off('close', cancelBody);
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

/** Reject browser cross-site writes to the unauthenticated loopback dashboard. */
function isSameOriginDashboardRequest(req: IncomingMessage, url: URL): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') return false;
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
    await fs.promises.writeFile(filePath, bytesGz, { mode: 0o600 });
    await fs.promises.chmod(filePath, 0o600);
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

const SERVICE_LABEL = 'com.sriinnu.fiche';

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

function resolvePlistPath(): string {
  const override = process.env.FICHE_PLIST_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function renderLaunchdPlist(opts: {
  execPath?: string;
  entryPath?: string;
  ficheDir?: string;
}): string {
  const execPath = opts.execPath ?? process.execPath;
  const entryPath = opts.entryPath ?? resolveServiceEntryPath();
  const ficheDir = opts.ficheDir ?? path.join(os.homedir(), '.fiche');
  const outLog = path.join(ficheDir, 'daemon.out.log');
  const errLog = path.join(ficheDir, 'daemon.err.log');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(SERVICE_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(execPath)}</string>`,
    `    <string>${escapeXml(entryPath)}</string>`,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    '    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>',
    '    <key>FICHE_PRICES</key>',
    '    <string>kosha</string>',
    '    <key>FICHE_TEXT_HYGIENE</key>',
    '    <string>on</string>',
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
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
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function pollHealth(port: number, budgetMs = 2000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port, 250);
    if (health) return health;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function runServiceCommand(argv: string[]): Promise<number> {
  const jsonFlag = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const action = argv.find((a) => !a.startsWith('-')) ?? 'status';
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`fiche service — manage the macOS launchd background daemon

Usage:
  fiche service install [--json]     install & start ~/Library/LaunchAgents/${SERVICE_LABEL}.plist
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

  const port = Number(process.env.PORT ?? 47821);
  const plistPath = resolvePlistPath();
  const ficheDir = path.join(os.homedir(), '.fiche');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `${domainTarget}/${SERVICE_LABEL}`;

  const emitResult = (payload: Record<string, unknown>, humanLine: string, code = 0): number => {
    if (jsonFlag) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else console.log(humanLine);
    return code;
  };

  if (action === 'status') {
    const plistInstalled = fs.existsSync(plistPath);
    const health = dryRun ? null : await fetchHealth(port);
    const payload = {
      running: Boolean(health),
      pid: typeof health?.pid === 'number' ? health.pid : null,
      plist_installed: plistInstalled,
      plist_path: plistPath,
      port,
      compression_enabled: typeof health?.compression_enabled === 'boolean' ? health.compression_enabled : null,
      price_mode: typeof health?.price_mode === 'string' ? health.price_mode : (readBrandEnv('PRICES') || 'default'),
      ...(typeof health?.version === 'string' ? { version: health.version } : {}),
    };
    const msg = health
      ? `[fiche service] running (pid=${payload.pid}, port=${port}, compression=${payload.compression_enabled ? 'on' : 'off'}, prices=${payload.price_mode})`
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
    const plistXml = renderLaunchdPlist({ ficheDir });
    if (!dryRun) {
      fs.mkdirSync(ficheDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plistXml, { mode: 0o600 });
    }
    runLaunchctl(['bootout', serviceTarget], dryRun);
    const boot = await bootstrapWithRetry(dryRun);
    if (boot.status !== 0 && !dryRun) {
      return emitResult(
        { ok: false, action: 'install', error: boot.stderr.trim() || `launchctl bootstrap exited ${boot.status}`, plist_path: plistPath },
        `[fiche service] install failed: ${boot.stderr.trim() || `exit ${boot.status}`}`,
        1,
      );
    }
    const health = dryRun ? null : await pollHealth(port);
    return emitResult(
      {
        ok: true,
        action: 'install',
        dry_run: dryRun,
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
        await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
          method: 'POST',
          signal: AbortSignal.timeout(500),
        });
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
      { ok: true, action: 'uninstall', dry_run: dryRun, removed, plist_path: plistPath },
      `[fiche service] ${dryRun ? 'would uninstall' : `uninstalled (${removed ? `removed ${plistPath}` : 'plist was absent'})`}`,
    );
  }

  if (action === 'stop') {
    if (!dryRun) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
          method: 'POST',
          signal: AbortSignal.timeout(500),
        });
      } catch {
        // Not running
      }
    }
    runLaunchctl(['bootout', serviceTarget], dryRun);
    return emitResult(
      { ok: true, action: 'stop', dry_run: dryRun, running: false, plist_path: plistPath },
      `[fiche service] ${dryRun ? 'would stop' : 'stopped'}`,
    );
  }

  if (action === 'start') {
    if (!dryRun && !fs.existsSync(plistPath)) {
      fs.mkdirSync(ficheDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, renderLaunchdPlist({ ficheDir }), { mode: 0o600 });
    }
    let boot = runLaunchctl(['kickstart', '-k', serviceTarget], dryRun);
    if (boot.status !== 0) {
      boot = await bootstrapWithRetry(dryRun);
    }
    if (boot.status !== 0 && !dryRun) {
      return emitResult(
        { ok: false, action: 'start', error: boot.stderr.trim() || `launchctl exited ${boot.status}`, plist_path: plistPath },
        `[fiche service] start failed: ${boot.stderr.trim() || `exit ${boot.status}`}`,
        1,
      );
    }
    const health = dryRun ? null : await pollHealth(port);
    return emitResult(
      { ok: true, action: 'start', dry_run: dryRun, running: Boolean(health), pid: health?.pid ?? null, port, plist_path: plistPath },
      `[fiche service] ${dryRun ? 'would start' : `started${health ? ` (pid=${health.pid})` : ''}`}`,
    );
  }

  // restart: kickstart atomically when already loaded; fall back to bootout + retry bootstrap
  if (!dryRun && !fs.existsSync(plistPath)) {
    fs.mkdirSync(ficheDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, renderLaunchdPlist({ ficheDir }), { mode: 0o600 });
  }
  let boot = runLaunchctl(['kickstart', '-k', serviceTarget], dryRun);
  if (boot.status !== 0 && !dryRun) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(500),
      });
    } catch {
      // Not running
    }
    runLaunchctl(['bootout', serviceTarget], dryRun);
    boot = await bootstrapWithRetry(dryRun);
  }
  if (boot.status !== 0 && !dryRun) {
    return emitResult(
      { ok: false, action: 'restart', error: boot.stderr.trim() || `launchctl exited ${boot.status}`, plist_path: plistPath },
      `[fiche service] restart failed: ${boot.stderr.trim() || `exit ${boot.status}`}`,
      1,
    );
  }
  const health = dryRun ? null : await pollHealth(port);
  return emitResult(
    { ok: true, action: 'restart', dry_run: dryRun, running: Boolean(health), pid: health?.pid ?? null, port, plist_path: plistPath },
    `[fiche service] ${dryRun ? 'would restart' : `restarted${health ? ` (pid=${health.pid})` : ''}`}`,
  );
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'mcp') {
    applyConfigFileDefaults();
    await runMcpCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'service') {
    const code = await runServiceCommand(argv.slice(1));
    process.exit(code);
  }
  if (argv[0] === 'shell-init') {
    const rest = argv.slice(1);
    const wrap = rest.includes('--wrap');
    const unknown = rest.filter((a) => a !== '--wrap');
    if (unknown.length > 0) {
      console.error(`[fiche] shell-init: unknown option ${unknown[0]} (supported: --wrap)`);
      process.exit(2);
    }
    process.stdout.write(renderShellInitScript({ wrap }));
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
  // `warp` runs an agent behind a CONNECT proxy and redirects its inference
  // traffic into the fiche instance already running. It starts no proxy of its own, so
  // it exits through its own branch below rather than falling through here.
  let warpCommand: string[] | undefined;
  let warpAppSpec: string | undefined;
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
    createWarpRuntime({ port: opts.port, routes: warpRoutes, app: resolvedWarpApp }).launch(warpCommand);
    return;
  }
  // A/B harness passthrough switch (see the `transform` callback below).
  const forcePassthrough = /^(1|true|yes|on)$/i.test(readBrandEnv('DISABLE') ?? '');
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
  // the dashboard. Telemetry (2026-06, 897 sessions / 21,347 measured
  // rows) showed 5 mode flips ever and losses at 0.8% of wins — all
  // one-time cache-create amortization — so closing the loop would not
  // change decisions. Re-run that reconciliation before wiring one in.
  if (opts.sessionStateFile) {
    const restored = configureSessionStateStore(fileSessionStateStore(opts.sessionStateFile));
    console.log(`[fiche] session state: ${restored} session(s) restored from ${opts.sessionStateFile}`);
  } else {
    console.log('[fiche] session state: persistence off (FICHE_SESSION_STATE)');
  }

  const tracker: Tracker = new FileTracker(opts.eventsFile);

  // Sidecar dir for oversized 4xx request-body samples. Lives next to the
  // events.jsonl so a single `rm -rf` cleans up both. Lazy-mkdir'd on first
  // sidecar write (see maybeWriteBodySidecar).
  const bodySidecarDir = path.join(path.dirname(opts.eventsFile), '4xx-bodies');

  let shutdownHandler: ((sig: string) => void) | undefined;
  const pendingOnRequests = new Set<Promise<void>>();

  // Live dashboard state — populated on every request via onRequest below,
  // served via the route interception in front of the proxy handler. The
  // SessionsPaths handle lets the dashboard surface session/disk/stats data
  // without reaching back into module-scope globals.
  const dashboard = new DashboardState(
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
      onShutdown: () => shutdownHandler?.('API_SHUTDOWN'),
    },
  );
  // Seed the "recent requests" table from the JSONL log so a process restart
  // doesn't reset what you can see in the UI. Best-effort; ignored on error.
  await dashboard.replay(opts.eventsFile).catch(() => {});

  // Follow the agent to its own third-party host (warp Host, or /to/<host>/).
  const upstreamRegistry = buildUpstreamRegistry(parseUpstreamHosts(readBrandEnv('UPSTREAM_HOSTS')));
  const followHosts = !/^(?:0|false|off|no)$/i.test((readBrandEnv('FOLLOW_HOSTS') ?? '').trim());
  const config: ProxyConfig = {
    authToken: anthropicAuthToken,
    provider: opts.provider,
    gatewayBaseUrl: opts.gatewayBaseUrl,
    gatewayHeaders: opts.gatewayHeaders,
    upstream: opts.upstream,
    openAIUpstream: opts.openAIUpstream,
    openAIApiKey: opts.openAIApiKey,
    googleUpstream: opts.googleUpstream,
    cloudflareUpstream: opts.cloudflareUpstream,
    cloudflareApiKey: opts.cloudflareApiKey,
    openAIModels: opts.openAIModels,
    cloudflareModels: opts.cloudflareModels,
    captureErrorReqBody: opts.captureErrorReqBody,
    maxRequestBytes: opts.maxRequestBytes,
    decodeRequestBody,
    followHosts,
    upstreamRegistry,
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
        !toggles.optical || !toggles.tscg || !toggles.toon || !toggles.acdc || !toggles.casi;
      const rawHorizon = (readBrandEnv('HISTORY_AMORTIZATION_HORIZON') ?? '').trim();
      const parsedHorizon = rawHorizon ? Number.parseInt(rawHorizon, 10) : NaN;
      if (Number.isFinite(parsedHorizon) && parsedHorizon >= 1 && parsedHorizon <= 100) {
        return {
          historyAmortizationHorizon: parsedHorizon,
          ...(hasDisabledStage ? { stageToggles: toggles } : {}),
        };
      }
      // Active path: use DEFAULTS in transform.ts for break-even gating.
      return hasDisabledStage ? { stageToggles: toggles } : {};
    },
    onRequest: (e) => {
      const task = (async () => {
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
        const cacheRead = e.usage?.cache_read_input_tokens ?? 0;
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
          const trimmed = e.errorBody.length > 400
            ? e.errorBody.slice(0, 400) + '…'
            : e.errorBody;
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
      })();
      pendingOnRequests.add(task);
      void task.finally(() => {
        pendingOnRequests.delete(task);
      });
      return task;
    },
  };
  const handle = createProxy(config);
  const allowedHosts = parseAllowedHosts(readBrandEnv('ALLOWED_HOSTS'));

  const allowPrivateDashboard = /^(1|true|yes|on)$/i.test(
    (readBrandEnv('DASHBOARD_ALLOW_PRIVATE') ?? '').trim(),
  );

  const server = createServer((req, res) => {
    req.socket?.setNoDelay?.(true);
    Promise.resolve()
      .then(async () => {
        // Local dashboard routes — handled BEFORE the proxy so they never hit
        // api.anthropic.com (which would 404 them).
        const rawReqUrl = req.url ?? '/';
        const rawHost = req.headers.host ?? 'localhost';
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
          const remoteAllowed =
            isLoopbackAddress(req.socket.remoteAddress) ||
            (allowPrivateDashboard && isPrivateAddress(req.socket.remoteAddress));
          if (
            !remoteAllowed
            || !isLoopbackHostname(rawHostHostname)
            || !isLoopbackHostname(url.hostname)
            || req.headers['sec-fetch-site'] === 'cross-site'
          ) {
            await writeWebResponse(new Response('dashboard is loopback-only', { status: 403 }), res);
            return;
          }
          if (isDashboardMutation(route, req.method ?? 'GET')
            && !isSameOriginDashboardRequest(req, url)) {
            await writeWebResponse(new Response('cross-origin dashboard mutation denied', { status: 403 }), res);
            return;
          }
          const webRes = await dispatchDashboard(
            dashboard,
            route,
            req.method ?? 'GET',
            url,
            opts.port,
            () => readRequestBody(req),
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
          { allowedHosts, providerHosts: new Set(upstreamRegistry.keys()) },
        );
        if (denial) {
          await writeWebResponse(new Response(JSON.stringify({ error: denial.reason, message: denial.message }), {
            status: denial.status,
            headers: { 'content-type': 'application/json' },
          }), res);
          return;
        }
        const webReq = toWebRequest(req);
        const webRes = await handle(webReq);
        await writeWebResponse(webRes, res);
      })
      .catch((err) => {
        if (isConnectionAbort(err) && (req.aborted || res.destroyed)) return;
        console.error('[fiche] handler error:', err);
        if (!res.headersSent) res.statusCode = 500;
        if (!res.writableEnded) res.end();
      });
  });
  server.on('connection', (socket) => socket.setNoDelay(true));
  // IPv6 literals need bracket notation to form a valid URL (http://[::1]:47821).
  const displayHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  const isLoopbackHost =
    opts.host === '127.0.0.1' || opts.host === 'localhost' || opts.host === '::1';
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

  server.listen(opts.port, opts.host, () => {
    console.log(`[fiche] listening on http://${displayHost}:${opts.port}`);
    if (!isLoopbackHost) {
      console.warn(
        `[fiche] bound to ${opts.host}; proxy API is reachable off-host, ` +
          `but dashboard routes remain loopback-only.`,
      );
    }
    announce();
    console.log(`[fiche] dashboard → http://127.0.0.1:${opts.port}/`);
  });

  // server.close() only stops accepting new connections and waits for open
  // ones to drain — it does NOT end idle keep-alive sockets. The dashboard tab
  // (htmx polls every 2s) and the Claude Code client both hold keep-alive
  // sockets open, so a naive close() never fires its callback and the first
  // Ctrl+C appears to hang. We drop idle sockets immediately, force-close any
  // in-flight ones after a short grace period, and let a second signal exit now.
  let shuttingDown = false;
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
      flushSessionState();
      // Flush+close the tracker so we don't drop the last few events on exit.
      if (tracker instanceof FileTracker) tracker.close();
    }
    process.exit(exitCode);
  };
  const shutdown = (sig: string) => {
    if (shuttingDown) {
      console.log(`[fiche] ${sig} again — forcing exit`);
      if (!flushedOnExit) {
        flushedOnExit = true;
        flushSessionState();
        if (tracker instanceof FileTracker) tracker.close();
      }
      process.exit(130);
    }
    shuttingDown = true;
    console.log(`[fiche] ${sig} — shutting down`);
    // Drain in-flight connections first so late finishing requests don't lose
    // session state or write to an already-closed tracker.
    const deadline = setTimeout(() => {
      server.closeAllConnections?.();
      void flushAndExit(0);
    }, 1500);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      void flushAndExit(0);
    });
    // Drop idle keep-alive sockets so close()'s callback can actually fire.
    server.closeIdleConnections?.();
  };
  shutdownHandler = shutdown;
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[fiche] fatal:', err);
  process.exit(1);
});
