/**
 * MCP server for the pxpipe-fork hybrid (stdio and stateless Streamable HTTP).
 * One tool surface for every client. Tools are local, deterministic, and do
 * not send the payload anywhere.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { countTokens } from '@sriinnu/pakt';
import { packStructuredOrOriginal, PAKT_LEGEND } from '../core/pakt-stage.js';
import { readerTier } from '../core/reader-tier.js';
import { hybridTransform, countBillable, type HybridWire } from '../core/hybrid.js';
import { supportsExplicitPromptCacheBreakpoint } from '../core/codex-cache.js';

export const MCP_PROTOCOL = '2025-03-26';
export const SERVER_NAME = 'pxpipe-fork';
export const SERVER_VERSION = '0.17.0-fork.1';

const ANNOTATIONS = {
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
  compressCalls: number;
  inspectCalls: number;
  transformCalls: number;
  tokensSaved: number;
}

const stats: McpStats = {
  startedAt: new Date().toISOString(),
  calls: 0,
  compressCalls: 0,
  inspectCalls: 0,
  transformCalls: 0,
  tokensSaved: 0,
};

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
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
    annotations: ANNOTATIONS,
  };
}

export const MCP_TOOLS = [
  tool(
    'compress_text',
    'Lossless PAKT (L1–L3) for one JSON, YAML, CSV, or markdown string. Returns the original text when packing would grow it or would not decompress back to the same data. L4 runs only when lossy is true and semanticBudget is a positive integer. Does not call a model and does not emit prompt_cache_breakpoint.',
    {
      text: { type: 'string', description: 'Structured text to pack.' },
      model: { type: 'string', description: 'Model id used only to count tokens. No API call.' },
      lossy: { type: 'boolean', description: 'Enable PAKT L4. Off unless true AND semanticBudget > 0.' },
      semanticBudget: { type: 'integer', minimum: 0, description: 'L4 token budget. Required for lossy mode.' },
    },
    ['text'],
  ),
  tool(
    'inspect_savings',
    'Estimate tokens before and after lossless PAKT, and what the hybrid router would do for a model (PAKT text for weak vision, PAKT then images for strong readers). No network.',
    {
      text: { type: 'string', description: 'Structured text or a JSON request body.' },
      model: { type: 'string', description: 'Model id. Selects the reader tier and the token counter.' },
    },
    ['text'],
  ),
  tool(
    'transform_request',
    'Run the hybrid pipeline on an LLM request JSON object: lossless PAKT on structured tool results, schemas, JSON, YAML, and CSV, then pxpipe images only if the model is a strong page reader (Gemini, Fable 5, Sol 5.6/6.1). Claude 5.5 and Grok stay on PAKT text. Set upstream to https://chatgpt.com or wire path /backend-api/codex/responses to force-strip prompt_cache_breakpoint.',
    {
      request: { type: 'object', description: 'Provider request JSON (Anthropic messages, OpenAI responses, chat completions, or Gemini).' },
      model: { type: 'string', description: 'Model id. Overrides request.model when set.' },
      wire: { type: 'string', enum: ['auto', 'anthropic', 'responses', 'chat', 'google'], description: 'Request shape. auto detects.' },
      upstream: { type: 'string', description: 'Upstream base URL. chatgpt.com disables explicit cache breakpoints.' },
      pathname: { type: 'string', description: 'Request path, for example /backend-api/codex/responses.' },
      forceImages: { type: 'boolean', description: 'Image even on a weak reader. Does not re-enable Codex breakpoints.' },
      lossy: { type: 'boolean', description: 'Enable PAKT L4. Off by default.' },
      semanticBudget: { type: 'integer', minimum: 0 },
    },
    ['request'],
  ),
  tool(
    'health',
    'Fork identity, versions, and the Codex breakpoint policy. Returns no secrets and no request data.',
    {},
    [],
  ),
  tool(
    'stats',
    'In-memory counters for this MCP process: calls and tokens saved. No payloads.',
    {},
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

async function callTool(name: string, args: Record<string, unknown>) {
  stats.calls += 1;
  if (name === 'health') {
    return textResult({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocol: MCP_PROTOCOL,
      forkOf: 'https://github.com/teamchong/pxpipe',
      upstreamVersion: '0.16.0',
      upstreamCommit: '9e0e0e99b4483f40e8a58036bb1f6a1a81c331e3',
      pakt: '@sriinnu/pakt@0.10.0',
      paktRepo: 'https://github.com/sriinnu/clipforge-PAKT',
      legend: PAKT_LEGEND,
      codex: 'prompt_cache_breakpoint is omitted for chatgpt.com and /backend-api/codex/responses',
      l4: 'off unless a tool call sets lossy true and semanticBudget > 0',
    });
  }
  if (name === 'stats') return textResult({ ...stats });
  if (name === 'compress_text') {
    const text = args.text;
    if (typeof text !== 'string') return textResult({ error: 'text must be a string' }, true);
    stats.compressCalls += 1;
    const packed = packStructuredOrOriginal(text, {
      model: typeof args.model === 'string' ? args.model : undefined,
      lossy: args.lossy === true,
      semanticBudget: typeof args.semanticBudget === 'number' ? args.semanticBudget : undefined,
    });
    if (packed.savedTokens > 0) stats.tokensSaved += packed.savedTokens;
    return textResult({
      compressed: packed.text,
      applied: packed.applied,
      format: packed.format,
      via: packed.via,
      reversible: packed.reversible,
      originalTokens: packed.originalTokens,
      packedTokens: packed.packedTokens,
      savedTokens: packed.savedTokens,
      savedPercent: packed.savedPercent,
      promptCacheBreakpoint: false,
    });
  }
  if (name === 'inspect_savings') {
    const text = args.text;
    if (typeof text !== 'string') return textResult({ error: 'text must be a string' }, true);
    stats.inspectCalls += 1;
    const model = typeof args.model === 'string' ? args.model : 'gpt-4o';
    const packed = packStructuredOrOriginal(text, { model });
    const tier = readerTier(model);
    const originalTokens = countTokens(text, model);
    return textResult({
      model,
      readerTier: tier,
      route: tier === 'image'
        ? 'PAKT on structured leaves, then pxpipe images for bulky context'
        : 'PAKT text only; dense images stay off because this reader is weak',
      originalTokens,
      paktTokens: packed.applied ? packed.packedTokens : originalTokens,
      paktSavedTokens: packed.savedTokens,
      paktSavedPercent: packed.savedPercent,
      paktApplied: packed.applied,
      reversible: packed.reversible,
      imageDefault: tier === 'image',
    });
  }
  if (name === 'transform_request') {
    const request = asRecord(args.request);
    if (!request) return textResult({ error: 'request must be an object' }, true);
    stats.transformCalls += 1;
    const model = typeof args.model === 'string'
      ? args.model
      : typeof request.model === 'string' ? request.model : undefined;
    const wire = (typeof args.wire === 'string' ? args.wire : 'auto') as HybridWire;
    const upstream = typeof args.upstream === 'string' ? args.upstream : undefined;
    const pathname = typeof args.pathname === 'string' ? args.pathname : undefined;
    const previous = process.env.PXPIPE_FORCE_IMAGES;
    if (args.forceImages === true) process.env.PXPIPE_FORCE_IMAGES = '1';
    else if (args.forceImages === false) delete process.env.PXPIPE_FORCE_IMAGES;
    try {
      const body = new TextEncoder().encode(JSON.stringify({ ...request, ...(model ? { model } : {}) }));
      const result = await hybridTransform(body, {
        model,
        wire,
        lossy: args.lossy === true,
        semanticBudget: typeof args.semanticBudget === 'number' ? args.semanticBudget : undefined,
        route: { upstream, pathname },
        explicitPromptCacheBreakpoints: supportsExplicitPromptCacheBreakpoint({ upstream, pathname }),
      });
      if (result.report.savedVsOriginal > 0) stats.tokensSaved += result.report.savedVsOriginal;
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
    } finally {
      if (previous === undefined) delete process.env.PXPIPE_FORCE_IMAGES;
      else process.env.PXPIPE_FORCE_IMAGES = previous;
    }
  }
  return textResult({ error: `unknown tool ${name}` }, true);
}

export async function handleMcpMessage(message: unknown): Promise<unknown | null> {
  const rpc = asRecord(message) as JsonRpc | null;
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return { jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: -32600, message: 'invalid jsonrpc request' } };
  }
  const id = rpc.id ?? null;
  const notify = rpc.id === undefined;
  if (rpc.method === 'notifications/initialized' || rpc.method === 'notifications/cancelled') return null;
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
        instructions: 'pxpipe-fork hybrid: lossless PAKT for structured text, pxpipe images only for Gemini, Fable 5, and Sol. Claude 5.5 and Grok get PAKT text. L4 is opt-in. This server does not store prompts.',
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

/** Newline-delimited JSON, plus LSP Content-Length frames if a client sends them. */
export function pushMcpChunk(buffer: string, chunk: string, onMessage: (message: unknown) => void): string {
  let rest = buffer + chunk;
  while (rest.length > 0) {
    if (rest.startsWith('Content-Length:')) {
      const headerEnd = rest.indexOf('\r\n\r\n');
      const alt = headerEnd >= 0 ? headerEnd : rest.indexOf('\n\n');
      if (alt < 0) break;
      const header = rest.slice(0, alt);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        rest = rest.slice(alt + (headerEnd >= 0 ? 4 : 2));
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = alt + (headerEnd >= 0 ? 4 : 2);
      if (rest.length < bodyStart + length) break;
      const json = rest.slice(bodyStart, bodyStart + length);
      rest = rest.slice(bodyStart + length);
      try { onMessage(JSON.parse(json)); } catch { /* ignore a bad frame */ }
      continue;
    }
    const nl = rest.indexOf('\n');
    if (nl < 0) break;
    const line = rest.slice(0, nl).replace(/\r$/, '').trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try { onMessage(JSON.parse(line)); } catch { /* ignore */ }
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
  const write = (message: unknown) => {
    process.stdout.write(encodeMcpMessage(message, framed));
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (chunk.includes('Content-Length:')) framed = true;
    buffer = pushMcpChunk(buffer, chunk, (message) => {
      void handleMcpMessage(message).then((response) => {
        if (response) write(response);
      });
    });
  });
  await new Promise<void>((resolve) => {
    process.stdin.on('end', () => resolve());
    process.stdin.on('close', () => resolve());
  });
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

export function startHttpServer(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !originAllowed(origin)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin not allowed' }));
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
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
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
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = address && typeof address === 'object' ? address.port : port;
      resolve({
        port: bound,
        close: () => new Promise((done, fail) => server.close((err) => err ? fail(err) : done())),
      });
    });
  });
}

export function resetMcpStatsForTests(): void {
  stats.calls = 0;
  stats.compressCalls = 0;
  stats.inspectCalls = 0;
  stats.transformCalls = 0;
  stats.tokensSaved = 0;
}

export { countBillable };
