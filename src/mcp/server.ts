/**
 * MCP server for fiche (stdio and stateless Streamable HTTP).
 * One tool surface for every client. Tools are local, deterministic, and do
 * not send the payload anywhere.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAllowedModelBases, getConfiguredModelBases, isFicheSupportedModel } from '../core/applicability.js';
import { readBrandEnv } from '../core/env.js';
import { isMisresolvedModelId } from '../core/gpt-model-profiles.js';
import { shouldImageModel } from '../core/reader-tier.js';
import { isTextHygieneActive, resolveTextHygieneMode, type TextHygieneMode } from '../core/text-hygiene.js';
import { resolveOpticalHistoryPolicy } from '../core/transform.js';
import { transformAnyRequest, countBillable, type RequestWire } from '../core/request-transform.js';
import { supportsExplicitPromptCacheBreakpoint } from '../core/codex-cache.js';
import { getGlobalMmuStore } from '../core/context-mmu.js';
import { defaultEventsFilePath, readTurnReport } from '../turn-report.js';

declare const __FICHE_VERSION__: string | undefined;

export const MCP_PROTOCOL = '2025-03-26';
export const SERVER_NAME = 'fiche-mcp';
export const SERVER_VERSION = typeof __FICHE_VERSION__ !== 'undefined' ? __FICHE_VERSION__ : '0.19.0';
/** Hard cap for one MCP message. Larger frames are rejected, not buffered. */
export const MCP_MAX_BYTES = 8 * 1024 * 1024;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpStats {
  startedAt: string;
  calls: number;
  checkCalls: number;
  transformCalls: number;
  tokensSaved: number;
}

const stats: McpStats = {
  startedAt: new Date().toISOString(),
  calls: 0,
  checkCalls: 0,
  transformCalls: 0,
  tokensSaved: 0,
};

const COST_NOTE = ' Calling this does not remove text already in the conversation. The argument and this result are both billed. The proxy is what saves tokens on live traffic.';

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } = READ_ONLY,
) {
  return {
    name,
    description,
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    annotations,
  };
}

export const MCP_TOOLS = [
  tool(
    'check_model',
    'What fiche does for a model: whether it is in compression scope, and whether it gets images (strong page readers such as Gemini, Fable 5, Sol 5.6/6.1/6.2) or uses the 4-layer text compiler and passes clean text through (weak or unmeasured readers such as Claude 5.5, Grok, DeepSeek, Kimi, Astra). Queries live daemon /api/models when running.',
    {
      model: { type: 'string', description: 'Model id, for example claude-fable-5 or gpt-6-astra.' },
      forceImages: { type: 'boolean', description: 'Optional override to test forced imaging on an allowlisted model.' },
      textHygiene: { type: 'string', enum: ['auto', 'on', 'off'], description: 'Optional text hygiene mode override.' },
    },
    ['model'],
  ),
  tool(
    'transform_request',
    'Run fiche on an LLM request JSON object: bulky context becomes images for strong page readers (Gemini, Fable 5, Sol 5.6/6.1/6.2); text-tier models run the 4-layer deterministic text compiler (TSCG+TOON+CASI+ACDC) with zero image rendering and pass clean payloads through unchanged. Set upstream to https://chatgpt.com or any /backend-api/codex/ path to force-strip prompt_cache_breakpoint.' + COST_NOTE,
    {
      request: { type: 'object', description: 'Provider request JSON (Anthropic messages, OpenAI responses, chat completions, or Gemini).' },
      model: { type: 'string', description: 'Model id. Overrides request.model when set.' },
      wire: { type: 'string', enum: ['auto', 'anthropic', 'responses', 'chat', 'google'], description: 'Request shape. auto detects.' },
      upstream: { type: 'string', description: 'Upstream base URL. chatgpt.com disables explicit cache breakpoints.' },
      pathname: { type: 'string', description: 'Request path, for example /backend-api/codex/responses.' },
      forceImages: { type: 'boolean', description: 'Image even on a weak reader. Does not re-enable Codex breakpoints.' },
      textHygiene: { type: 'string', enum: ['auto', 'on', 'off'], description: 'Text hygiene mode (auto, on, or off).' },
    },
    ['request'],
  ),
  tool(
    'health',
    'Server identity, version, and the Codex breakpoint policy. Returns no secrets and no request data.',
    {},
    [],
  ),
  tool(
    'stats',
    'In-memory counters for this MCP process: calls and tokens saved. No payloads. This call increments the counters.',
    {},
    [],
    { ...READ_ONLY, idempotentHint: false },
  ),
  tool(
    'page_in',
    'Retrieve verbatim lines from Fiche Context-MMU virtual memory by pageId (e.g. pg_...) or symbol/text query, optionally sliced by startLine/endLine/maxLines. Queries the local MMU store first, then falls back to the running proxy daemon on loopback.',
    {
      pageId: { type: 'string', description: 'MMU page ID to dereference, for example pg_a1b2c3d4e5f6.' },
      query: { type: 'string', description: 'Symbol name, file basename, or text query to find or focus an MMU page (<= 512 chars).' },
      sessionKey: { type: 'string', description: 'Optional session key to scope page lookup to one session.' },
      startLine: { type: 'number', description: '1-based start line within the matched page.' },
      endLine: { type: 'number', description: '1-based end line within the matched page.' },
      maxLines: { type: 'number', description: 'Maximum lines to return (default 120, max 500).' },
    },
    [],
  ),
  tool(
    'mmu_stats',
    'Inspect Fiche Context-MMU virtual memory counters and resident page metadata (no raw page bodies). Queries the local MMU store first, then falls back to the running proxy daemon on loopback.',
    {
      sessionKey: { type: 'string', description: 'Optional session key filter for resident MMU pages.' },
    },
    [],
  ),
];

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function resolveDaemonPort(): number {
  const envPort = Number(process.env.PORT ?? 47821);
  return Number.isSafeInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : 47821;
}

function parsePositiveIntArg(value: unknown, field: string): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return { ok: false, error: `${field} must be a positive integer` };
  }
  return { ok: true, value };
}

function matchesModelBases(model: string, bases: readonly string[]): boolean {
  const base = model.replace(/\[[^\]]*\]/g, '').toLowerCase();
  if (!base || isMisresolvedModelId(base)) return false;
  const slash = base.lastIndexOf('/');
  const unqualified = slash >= 0 ? base.slice(slash + 1) : null;
  return bases.some((b) => {
    const target = b.toLowerCase();
    const hit = (id: string): boolean =>
      id === target || id.startsWith(`${target}-`) || id.startsWith(`${target}.`);
    return hit(base) || (unqualified !== null && hit(unqualified));
  });
}

function readConfigModelBases(): string[] | null {
  const explicit = readBrandEnv('CONFIG');
  if (process.env.VITEST && explicit === undefined) return null;
  const defaultFile = path.join(os.homedir(), '.config', 'fiche', 'config.json');
  const legacyFile = path.join(os.homedir(), '.config', 'inkling', 'config.json');
  const file = explicit ?? (fs.existsSync(defaultFile) || !fs.existsSync(legacyFile) ? defaultFile : legacyFile);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (Array.isArray(parsed.models)) {
      return parsed.models.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof parsed.models === 'string') {
      const trimmed = parsed.models.trim();
      if (!trimmed || /^(0|false|no|off|none)$/i.test(trimmed)) return [];
      return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    /* ignore invalid config */
  }
  return null;
}

function combineMmuStats(
  localStats: Record<string, unknown>,
  daemonStats: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!daemonStats) return { ...localStats };
  const combined: Record<string, unknown> = { ...daemonStats };
  for (const [k, v] of Object.entries(localStats)) {
    const dv = combined[k];
    if (typeof v === 'number' && typeof dv === 'number') {
      combined[k] = dv + v;
    } else if (dv === undefined) {
      combined[k] = v;
    }
  }
  return combined;
}

async function callTool(name: string, args: Record<string, unknown>) {
  stats.calls += 1;
  if (name === 'health') {
    const port = resolveDaemonPort();
    let proxy: Record<string, unknown> = {
      running: false,
      port,
      hint: 'Start proxy daemon with `fiche` or `fiche service start`',
    };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(250),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        proxy = { running: true, ...data };
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
    } catch {
      // Proxy daemon unreachable — fast fail-open status
    }
    return textResult({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocol: MCP_PROTOCOL,
      codex: 'prompt_cache_breakpoint is omitted for chatgpt.com and /backend-api/codex/responses',
      proxy,
    });
  }
  if (name === 'stats') {
    const report = readTurnReport(defaultEventsFilePath());
    return textResult({
      ...stats,
      proxy: report.lastTurn
        ? {
            lastTurn: report.lastTurn,
            session: report.session,
          }
        : null,
    });
  }
  if (name === 'page_in') {
    if (args.pageId !== undefined && (typeof args.pageId !== 'string' || !args.pageId.trim())) {
      return textResult({ error: 'pageId must be a non-empty string' }, true);
    }
    if (args.query !== undefined && (typeof args.query !== 'string' || !args.query.trim())) {
      return textResult({ error: 'query must be a non-empty string' }, true);
    }
    if (args.sessionKey !== undefined && (typeof args.sessionKey !== 'string' || !args.sessionKey.trim())) {
      return textResult({ error: 'sessionKey must be a non-empty string' }, true);
    }
    const pageId = typeof args.pageId === 'string' ? args.pageId.trim() : undefined;
    const query = typeof args.query === 'string' ? args.query.trim() : undefined;
    const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey.trim() : undefined;
    if (query && query.length > 512) {
      return textResult({ error: 'query must be <= 512 chars' }, true);
    }
    if (!pageId && !query) {
      return textResult({ error: 'pageId or query must be provided' }, true);
    }
    const startParsed = parsePositiveIntArg(args.startLine, 'startLine');
    if (!startParsed.ok) return textResult({ error: startParsed.error }, true);
    const endParsed = parsePositiveIntArg(args.endLine, 'endLine');
    if (!endParsed.ok) return textResult({ error: endParsed.error }, true);
    const maxParsed = parsePositiveIntArg(args.maxLines, 'maxLines');
    if (!maxParsed.ok) return textResult({ error: maxParsed.error }, true);
    const maxLines = maxParsed.value !== undefined ? Math.min(500, maxParsed.value) : 120;

    const store = getGlobalMmuStore();
    if (pageId) {
      const hit = store.derefPage(pageId, {
        sessionKey,
        startLine: startParsed.value,
        endLine: endParsed.value,
        query,
        maxLines,
      });
      if (hit) {
        return textResult({
          source: 'local',
          pageId: hit.page.id,
          refId: hit.page.refId,
          sessionKey: hit.page.sessionKey,
          filePath: hit.page.filePath,
          lineCount: hit.page.lineCount,
          startLine: hit.startLine,
          endLine: hit.endLine,
          text: hit.text,
          symbols: hit.page.symbols,
        });
      }
    } else {
      const matches = store.searchPages(query!, sessionKey);
      if (matches.length > 0) {
        const top = matches[0]!;
        const hit = store.derefPage(top.page.id, {
          sessionKey: top.page.sessionKey,
          startLine: startParsed.value,
          endLine: endParsed.value,
          query,
          maxLines,
        });
        return textResult({
          source: 'local',
          pageId: top.page.id,
          refId: top.page.refId,
          sessionKey: top.page.sessionKey,
          filePath: top.page.filePath,
          lineCount: top.page.lineCount,
          startLine: hit?.startLine ?? 1,
          endLine: hit?.endLine ?? 0,
          text: hit?.text ?? '',
          symbols: top.page.symbols,
          matches: matches.slice(0, 5).map((m) => ({
            pageId: m.page.id,
            refId: m.page.refId,
            filePath: m.page.filePath,
            score: m.score,
            matchedLine: m.matchedLine,
          })),
        });
      }
    }

    const port = resolveDaemonPort();
    const qs = new URLSearchParams();
    if (pageId) qs.set('pageId', pageId);
    if (query) qs.set('query', query);
    if (sessionKey) qs.set('sessionKey', sessionKey);
    if (startParsed.value !== undefined) qs.set('startLine', String(startParsed.value));
    if (endParsed.value !== undefined) qs.set('endLine', String(endParsed.value));
    qs.set('maxLines', String(maxLines));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/mmu/page?${qs.toString()}`, {
        signal: AbortSignal.timeout(250),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data) {
        const msg = typeof data?.error === 'string' ? data.error : `MMU page lookup failed (HTTP ${res.status})`;
        return textResult({ error: msg, source: 'daemon', port }, true);
      }
      return textResult({ source: 'daemon', ...data });
    } catch {
      return textResult({
        error: 'MMU page not found locally and fiche proxy daemon is unreachable',
        port,
        hint: 'Start proxy daemon with `fiche` or `fiche service start`',
      }, true);
    }
  }
  if (name === 'mmu_stats') {
    if (args.sessionKey !== undefined && (typeof args.sessionKey !== 'string' || !args.sessionKey.trim())) {
      return textResult({ error: 'sessionKey must be a non-empty string' }, true);
    }
    const sessionKey = typeof args.sessionKey === 'string' ? args.sessionKey.trim() : undefined;
    const store = getGlobalMmuStore();
    const allPages = store.listPages();
    const storeStats = store.getStats();
    const hasLocalState =
      allPages.length > 0 ||
      storeStats.pagesStored > 0 ||
      storeStats.tailHydrations > 0 ||
      storeStats.markovFolds > 0 ||
      storeStats.skillsStubbed > 0 ||
      storeStats.densityPrunedBlocks > 0;
    const localPages = sessionKey ? store.listPages(sessionKey) : allPages;
    const safeLocalPages = localPages.slice(0, 50).map((p) => {
      if (sessionKey) return p;
      const { factTokens: _omitted, ...rest } = p;
      return rest;
    });
    const localPayload = {
      stats: storeStats,
      pageCount: localPages.length,
      pages: safeLocalPages,
    };

    const port = resolveDaemonPort();
    const qs = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : '';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/mmu/stats${qs}`, {
        signal: AbortSignal.timeout(250),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !data) {
        if (hasLocalState) {
          return textResult({
            source: 'local',
            daemonRunning: false,
            port,
            ...localPayload,
            local: localPayload,
            daemon: null,
          });
        }
        const msg = typeof data?.error === 'string' ? data.error : `MMU stats lookup failed (HTTP ${res.status})`;
        return textResult({ error: msg, source: 'daemon', port }, true);
      }
      if (!hasLocalState) {
        return textResult({
          source: 'daemon',
          daemonRunning: true,
          port,
          ...data,
          local: localPayload,
          daemon: data,
        });
      }
      const daemonStats = asRecord(data.stats);
      const daemonPageCount = typeof data.pageCount === 'number' ? data.pageCount : 0;
      const daemonPages = Array.isArray(data.pages) ? data.pages : [];
      const seenPageIds = new Set<string>();
      const mergedPages: unknown[] = [];
      for (const p of [...daemonPages, ...safeLocalPages]) {
        const rec = asRecord(p);
        const pid = typeof rec?.id === 'string' ? rec.id : undefined;
        if (pid) {
          if (seenPageIds.has(pid)) continue;
          seenPageIds.add(pid);
        }
        mergedPages.push(p);
        if (mergedPages.length >= 50) break;
      }
      return textResult({
        source: 'combined',
        daemonRunning: true,
        port,
        stats: combineMmuStats(storeStats as unknown as Record<string, unknown>, daemonStats),
        pageCount: daemonPageCount + localPages.length,
        pages: mergedPages,
        local: localPayload,
        daemon: data,
      });
    } catch {
      // Daemon offline — return local state
    }
    return textResult({
      source: 'local',
      daemonRunning: false,
      port,
      ...localPayload,
      local: localPayload,
      daemon: null,
    });
  }
  if (name === 'check_model') {
    const model = args.model;
    if (typeof model !== 'string' || !model.trim()) return textResult({ error: 'model must be a non-empty string' }, true);
    stats.checkCalls += 1;

    const forceImages = args.forceImages === true ? true : args.forceImages === false ? false : undefined;
    const hygieneArg: TextHygieneMode | undefined =
      args.textHygiene === 'auto' || args.textHygiene === 'on' || args.textHygiene === 'off'
        ? args.textHygiene
        : undefined;

    let inScope = isFicheSupportedModel(model);
    let scopeSource: 'daemon' | 'runtime' | 'env' | 'config' | 'default' = 'default';
    let compressionEnabled: boolean | undefined;
    let daemonEngineMode: 'optical' | 'hybrid' | 'text' | undefined;

    const port = resolveDaemonPort();
    const shouldQueryDaemon = !process.env.VITEST || process.env.PORT !== undefined;
    let gotDaemon = false;
    if (shouldQueryDaemon) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/models`, {
          signal: AbortSignal.timeout(250),
        });
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          const rawBases = Array.isArray(data?.allowed_models)
            ? data.allowed_models
            : Array.isArray(data?.models)
              ? data.models
              : null;
          if (rawBases && rawBases.every((m) => typeof m === 'string')) {
            inScope = matchesModelBases(model, rawBases as string[]);
            scopeSource = 'daemon';
            gotDaemon = true;
            if (typeof data?.compression_enabled === 'boolean') {
              compressionEnabled = data.compression_enabled;
            }
            if (Array.isArray(data?.catalog)) {
              const norm = model.trim().toLowerCase();
              const catHit = (data.catalog as Array<Record<string, unknown>>).find(
                (c) => typeof c?.id === 'string' && c.id.toLowerCase() === norm,
              );
              if (
                catHit &&
                (catHit.engine_mode === 'optical' || catHit.engine_mode === 'hybrid' || catHit.engine_mode === 'text')
              ) {
                daemonEngineMode = catHit.engine_mode;
              }
            }
          }
        } else {
          await res.body?.cancel().catch(() => undefined);
        }
      } catch {
        // Daemon unreachable — fall back to runtime / env / config.json
      }
    }

    if (!gotDaemon) {
      const allowed = getAllowedModelBases();
      const configured = getConfiguredModelBases();
      const hasRuntimeOverride =
        allowed.length !== configured.length || allowed.some((v, idx) => v !== configured[idx]);
      if (hasRuntimeOverride) {
        inScope = isFicheSupportedModel(model);
        scopeSource = 'runtime';
      } else if (readBrandEnv('MODELS') !== undefined) {
        inScope = isFicheSupportedModel(model);
        scopeSource = 'env';
      } else {
        const cfgBases = readConfigModelBases();
        if (cfgBases !== null) {
          inScope = matchesModelBases(model, cfgBases);
          scopeSource = 'config';
        } else {
          inScope = isFicheSupportedModel(model);
          scopeSource = 'default';
        }
      }
    }

    const tier = shouldImageModel(model, inScope, forceImages) ? 'image' : 'text';
    const hygieneMode = resolveTextHygieneMode(hygieneArg);
    const hygieneActive = isTextHygieneActive(hygieneArg);
    const engineMode: 'optical' | 'hybrid' | 'text' =
      forceImages === undefined && hygieneArg === undefined && daemonEngineMode
        ? daemonEngineMode
        : tier === 'image'
          ? (resolveOpticalHistoryPolicy({ model, textHygieneActive: hygieneActive }) === 'hybrid'
              ? 'hybrid'
              : 'optical')
          : 'text';
    return textResult({
      model,
      inScope,
      readerTier: tier,
      engineMode,
      textEngine: tier === 'image' ? 'image+TOON+hygiene' : 'TSCG+TOON+CASI+ACDC',
      scopeSource,
      ...(compressionEnabled !== undefined ? { compressionEnabled } : {}),
      action: !inScope
        ? hygieneMode === 'on'
          ? 'passthrough as text: outside FICHE_MODELS, 4-layer text hygiene forced on'
          : 'passthrough: model is outside FICHE_MODELS'
        : tier === 'image'
          ? engineMode === 'hybrid'
            ? 'hybrid: Turn-1 optical slab + Text-MMU history'
            : 'images for bulky stale context; live turns stay text'
          : 'passthrough as text: image rendering disabled; uses 4-layer text engine (TSCG+TOON+CASI+ACDC)',
    });
  }
  if (name === 'transform_request') {
    const request = asRecord(args.request);
    if (!request) return textResult({ error: 'request must be an object' }, true);
    stats.transformCalls += 1;
    const model = typeof args.model === 'string'
      ? args.model
      : typeof request.model === 'string' ? request.model : undefined;
    const wire = (typeof args.wire === 'string' ? args.wire : 'auto') as RequestWire;
    const upstream = typeof args.upstream === 'string' ? args.upstream : undefined;
    const pathname = typeof args.pathname === 'string' ? args.pathname : undefined;
    const textHygiene: TextHygieneMode | undefined =
      args.textHygiene === 'auto' || args.textHygiene === 'on' || args.textHygiene === 'off'
        ? args.textHygiene
        : undefined;
    const looksGoogleAuto =
      wire === 'auto' &&
      !Array.isArray(request.input) &&
      typeof request.instructions !== 'string' &&
      !Array.isArray(request.messages) &&
      (request.systemInstruction !== undefined || request.contents !== undefined);
    const isGooglePayload = wire === 'google' || looksGoogleAuto;
    const outboundPayload = isGooglePayload
      ? request
      : { ...request, ...(model ? { model } : {}) };
    const body = new TextEncoder().encode(JSON.stringify(outboundPayload));
    if (body.byteLength > MCP_MAX_BYTES) {
      return textResult({ error: `request exceeds ${MCP_MAX_BYTES} bytes` }, true);
    }
    try {
      const result = await transformAnyRequest(body, {
        model,
        wire,
        forceImages: args.forceImages === true ? true : args.forceImages === false ? false : undefined,
        ...(textHygiene !== undefined ? { textHygiene } : {}),
        route: { upstream, pathname },
        explicitPromptCacheBreakpoints: supportsExplicitPromptCacheBreakpoint({ upstream, pathname }),
      });
      stats.tokensSaved += result.report.savedVsOriginal;
      let transformed: unknown;
      try {
        transformed = JSON.parse(new TextDecoder().decode(result.body));
      } catch {
        transformed = null;
      }
      return textResult({
        request: transformed,
        report: result.report,
      });
    } catch (err) {
      return textResult({ error: err instanceof Error ? err.message : 'transform failed' }, true);
    }
  }
  return textResult({ error: `unknown tool ${name}` }, true);
}

export async function handleMcpMessage(message: unknown): Promise<unknown | null> {
  const rpc = asRecord(message) as (JsonRpc & { error?: unknown }) | null;
  if (rpc && rpc.jsonrpc === '2.0' && rpc.method === undefined && asRecord(rpc.error)) {
    return rpc;
  }
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return { jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: -32600, message: 'invalid jsonrpc request' } };
  }
  const id = rpc.id ?? null;
  const notify = rpc.id === undefined;
  if (rpc.method === 'notifications/initialized' || rpc.method === 'notifications/cancelled') {
    // A client that sends these with an id still expects a reply.
    if (rpc.id === undefined) return null;
    return { jsonrpc: '2.0', id: rpc.id, result: {} };
  }
  if (rpc.method === 'initialize') {
    const requested = typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : MCP_PROTOCOL;
    const protocolVersion = requested === '2024-11-05' || requested === '2025-03-26' || requested === '2025-06-18'
      ? requested
      : MCP_PROTOCOL;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'fiche renders bulky stale context as images for strong page readers (Gemini, Fable 5, Sol) and runs the 4-layer deterministic text compiler (TSCG+TOON+CASI+ACDC) on text-tier models while passing clean payloads through. This server does not store prompts.',
      },
    };
  }
  if (rpc.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (rpc.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  if (rpc.method === 'tools/call') {
    const params = rpc.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = asRecord(params.arguments) ?? {};
    const result = await callTool(name, args);
    return { jsonrpc: '2.0', id, result };
  }
  if (notify) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${rpc.method}` } };
}

const LSP_HEADER_PREFIX_RE = /^(?:content-length|content-type)\s*:/i;
const LSP_MAX_HEADER_BYTES = 16 * 1024;
const mcpDrainStates = new WeakMap<
  (message: unknown, framed: boolean) => void,
  { dropLspBytes: number; dropLine: boolean }
>();

/** Newline-delimited JSON, plus LSP Content-Length frames if a client sends them. */
export function pushMcpChunk(buffer: string, chunk: string, onMessage: (message: unknown, framed: boolean) => void): string {
  let drain = mcpDrainStates.get(onMessage);
  if (!drain) {
    drain = { dropLspBytes: 0, dropLine: false };
    mcpDrainStates.set(onMessage, drain);
  }

  let rest: string;
  if (drain.dropLspBytes > 0) {
    const chunkBuf = Buffer.from(chunk, 'utf8');
    if (chunkBuf.length < drain.dropLspBytes) {
      drain.dropLspBytes -= chunkBuf.length;
      return '';
    }
    rest = chunkBuf.subarray(drain.dropLspBytes).toString('utf8');
    drain.dropLspBytes = 0;
  } else if (drain.dropLine) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) return '';
    drain.dropLine = false;
    rest = chunk.slice(nl + 1);
  } else {
    rest = buffer + chunk;
  }

  while (rest.length > 0) {
    // Only a leading header is framing. A JSON payload that mentions
    // "Content-Length:" must not flip the session into LSP mode.
    if (LSP_HEADER_PREFIX_RE.test(rest)) {
      const crlfEnd = rest.indexOf('\r\n\r\n');
      const lfEnd = rest.indexOf('\n\n');
      const useCrlf = crlfEnd >= 0 && (lfEnd < 0 || crlfEnd <= lfEnd);
      const alt = useCrlf ? crlfEnd : lfEnd;
      if (alt < 0) {
        if (Buffer.byteLength(rest, 'utf8') > LSP_MAX_HEADER_BYTES) {
          onMessage({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: `frame exceeds ${MCP_MAX_BYTES} bytes` },
          }, true);
          drain.dropLine = true;
          return '';
        }
        break;
      }
      const sep = useCrlf ? 4 : 2;
      const header = rest.slice(0, alt);
      const match = /^content-length\s*:\s*(\d+)/im.exec(header);
      if (!match) {
        rest = rest.slice(alt + sep);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = alt + sep;
      const bytes = Buffer.from(rest.slice(bodyStart), 'utf8');
      if (!Number.isFinite(length) || length < 0 || length > MCP_MAX_BYTES) {
        onMessage({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: `frame exceeds ${MCP_MAX_BYTES} bytes` },
        }, true);
        if (Number.isFinite(length) && length > 0) {
          if (bytes.length >= length) {
            rest = bytes.subarray(length).toString('utf8');
            continue;
          }
          drain.dropLspBytes = length - bytes.length;
        }
        return '';
      }
      // Content-Length counts UTF-8 bytes, not UTF-16 code units.
      if (bytes.length < length) break;
      const json = bytes.subarray(0, length).toString('utf8');
      rest = bytes.subarray(length).toString('utf8');
      try {
        onMessage(JSON.parse(json), true);
      } catch {
        onMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, true);
      }
      continue;
    }
    const nl = rest.indexOf('\n');
    if (nl < 0) {
      if (Buffer.byteLength(rest, 'utf8') > MCP_MAX_BYTES) {
        onMessage({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: `message exceeds ${MCP_MAX_BYTES} bytes` },
        }, false);
        drain.dropLine = true;
        return '';
      }
      break;
    }
    const rawLine = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (Buffer.byteLength(rawLine, 'utf8') > MCP_MAX_BYTES) {
      onMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: `message exceeds ${MCP_MAX_BYTES} bytes` },
      }, false);
      continue;
    }
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    try {
      onMessage(JSON.parse(line), false);
    } catch {
      onMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, false);
    }
  }
  return rest;
}

export function encodeMcpMessage(message: unknown, framed: boolean): string {
  const json = JSON.stringify(message);
  if (!framed) return `${json}\n`;
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

export async function runStdioServer(): Promise<void> {
  let buffer = '';
  let framed = false;
  let stdoutBroken = false;
  const activeRequests = new Set<Promise<void>>();
  const onStdoutError = (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
      stdoutBroken = true;
    }
  };
  process.stdout.on('error', onStdoutError);
  const write = (message: unknown) => {
    if (stdoutBroken || process.stdout.destroyed || !process.stdout.writable) return;
    try {
      process.stdout.write(encodeMcpMessage(message, framed));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') stdoutBroken = true;
      else throw err;
    }
  };
  const dispatch = (message: unknown, messageFramed: boolean) => {
    if (messageFramed) framed = true;
    const p = handleMcpMessage(message)
      .then((response) => {
        if (response) write(response);
      })
      .catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : 'internal error';
        write({ jsonrpc: '2.0', id: null, error: { code: -32603, message: messageText } });
      })
      .finally(() => {
        activeRequests.delete(p);
      });
    activeRequests.add(p);
  };
  process.stdin.setEncoding('utf8');
  const onData = (chunk: string) => {
    buffer = pushMcpChunk(buffer, chunk, dispatch);
  };
  process.stdin.on('data', onData);
  try {
    await new Promise<void>((resolve) => {
      const finish = () => {
        if (buffer.trim().length > 0 && !LSP_HEADER_PREFIX_RE.test(buffer)) {
          buffer = pushMcpChunk(buffer, '\n', dispatch);
        }
        resolve();
      };
      process.stdin.once('end', finish);
      process.stdin.once('close', finish);
    });
    while (activeRequests.size > 0) {
      await Promise.allSettled([...activeRequests]);
    }
  } finally {
    process.stdin.off('data', onData);
    process.stdout.off('error', onStdoutError);
  }
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!origin.trim()) return false;
  try {
    return loopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** DNS rebinding sends Host: attacker.example while connecting to 127.0.0.1. */
export function hostHeaderAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let hostname = hostHeader.trim();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end >= 0 ? hostname.slice(1, end) : hostname;
  } else {
    hostname = hostname.replace(/:\d+$/, '');
  }
  return loopbackHost(hostname);
}

export function startHttpServer(
  port: number,
  options: { ipv4Only?: boolean; retriesLeft?: number } = {},
): Promise<{ port: number; ipv6Listening: boolean; close: () => Promise<void> }> {
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
    if ((typeof origin === 'string' && !originAllowed(origin)) || !hostHeaderAllowed(host)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'loopback only' }));
      return;
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'stateless streamable HTTP accepts POST /mcp only' }));
      return;
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'POST /mcp' }));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      received += chunk.length;
      if (received > MCP_MAX_BYTES) {
        rejected = true;
        // Signal `Connection: close` so keep-alive clients (e.g. Node 24 globalAgent)
        // never pool/reuse this socket, and drain without abruptly triggering EPIPE.
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'body too large' } }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });
    req.on('end', () => {
      if (rejected) return;
      void (async () => {
        try {
          let message: unknown;
          try {
            message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
            return;
          }
          const response = await handleMcpMessage(message);
          if (!response) {
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch (err) {
          if (res.writableEnded) return;
          const messageText = err instanceof Error ? err.message : 'internal error';
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: messageText } }));
        }
      })();
    });
  };
  // Listen on ::1 too, so a client that resolves localhost to IPv6 connects.
  const server = createServer(onRequest);
  const v6 = createServer(onRequest);
  const closeServer = (target: Server) => new Promise<void>((done, fail) => {
    if (!target.listening) { done(); return; }
    target.close((err) => err ? fail(err) : done());
  });
  const retriesLeft = options.retriesLeft ?? (port === 0 ? 3 : 0);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = address && typeof address === 'object' ? address.port : port;
      let settled = false;
      const finish = (ipv6Listening: boolean) => {
        if (settled) return;
        settled = true;
        resolve({
          port: bound,
          ipv6Listening,
          close: async () => {
            await closeServer(server);
            await closeServer(v6);
          },
        });
      };
      if (options.ipv4Only) {
        finish(false);
        return;
      }
      v6.once('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
          finish(false);
          return;
        }
        if (port === 0 && err.code === 'EADDRINUSE' && retriesLeft > 0) {
          settled = true;
          void closeServer(server).then(
            () => startHttpServer(0, { ...options, retriesLeft: retriesLeft - 1 }).then(resolve, reject),
            reject,
          );
          return;
        }
        settled = true;
        void closeServer(server).finally(() => {
          reject(new Error(`failed to bind ::1:${bound} (${err.code ?? err.message}); pass --ipv4 to bind 127.0.0.1 only`));
        });
      });
      v6.listen(bound, '::1', () => finish(true));
    });
  });
}

export function resetMcpStatsForTests(): void {
  stats.calls = 0;
  stats.checkCalls = 0;
  stats.transformCalls = 0;
  stats.tokensSaved = 0;
}

export { countBillable };
