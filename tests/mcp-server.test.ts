import { createServer as createNodeHttpServer } from 'node:http';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalMmuStore, resetGlobalMmuStore } from '../src/core/context-mmu.js';
import {
  MCP_MAX_BYTES,
  MCP_TOOLS,
  encodeMcpMessage,
  handleMcpMessage,
  pushMcpChunk,
  resetMcpStatsForTests,
  startHttpServer,
} from '../src/mcp/server.js';

const events = JSON.stringify({
  events: Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    user: 'octocat',
    status: 'ok',
    path: 'src/mcp/server.ts',
    note: 'mcp fixture row',
  })),
});

function rpc(method: string, params?: unknown, id: number | null = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

async function reserveUnusedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('MCP server', () => {
  let prevPort: string | undefined;

  beforeEach(async () => {
    prevPort = process.env.PORT;
    process.env.PORT = String(await reserveUnusedPort());
  });

  afterEach(() => {
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    resetMcpStatsForTests();
    resetGlobalMmuStore();
  });

  it('lists tools with directory annotations and answers initialize', async () => {
    const init = await handleMcpMessage(rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    }));
    const initBody = init as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(initBody.result.protocolVersion).toBe('2025-03-26');
    expect(initBody.result.serverInfo.name).toBe('fiche-mcp');
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const withId = await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'notifications/initialized' });
    expect(withId).toEqual({ jsonrpc: '2.0', id: 9, result: {} });

    const listed = await handleMcpMessage(rpc('tools/list'));
    const tools = (listed as { result: { tools: typeof MCP_TOOLS } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'check_model',
      'transform_request',
      'health',
      'stats',
      'page_in',
      'mmu_stats',
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.annotations.idempotentHint).toBe(tool.name !== 'stats');
      expect(tool.inputSchema.type).toBe('object');
      if (tool.name === 'transform_request') {
        expect(tool.description).toContain('does not remove text already in the conversation');
      }
    }
  });

  it('reports the tier for a model and returns a weak-reader request unchanged', async () => {
    const checked = await handleMcpMessage(rpc('tools/call', {
      name: 'check_model',
      arguments: { model: 'claude-opus-5-5' },
    }));
    const tier = (checked as { result: { structuredContent: { readerTier: string; action: string } } }).result.structuredContent;
    expect(tier.readerTier).toBe('text');
    expect(tier.action).toMatch(/passthrough/);

    const request = {
      model: 'grok-4.7',
      max_tokens: 64,
      system: 'You are a coding agent.',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: events }] }],
    };
    const passthrough = await handleMcpMessage(rpc('tools/call', {
      name: 'transform_request',
      arguments: {
        model: 'grok-4.7',
        wire: 'anthropic',
        upstream: 'https://chatgpt.com',
        pathname: '/backend-api/codex/responses',
        request,
      },
    }));
    const passBody = (passthrough as {
      result: { structuredContent: { report: { textCompressed?: boolean; savedVsOriginal: number } } };
    }).result.structuredContent;
    expect(passBody.report.textCompressed).toBeFalsy();
    expect(passBody.report.savedVsOriginal).toBe(0);

    const transformed = await handleMcpMessage(rpc('tools/call', {
      name: 'transform_request',
      arguments: {
        model: 'grok-4.7',
        wire: 'anthropic',
        upstream: 'https://chatgpt.com',
        pathname: '/backend-api/codex/responses',
        textHygiene: 'on',
        request,
      },
    }));
    const body = (transformed as {
      result: {
        structuredContent: {
          report: {
            readerTier: string;
            imaged: boolean;
            textCompressed?: boolean;
            textStages?: string[];
            promptCacheBreakpoint: boolean;
            savedVsOriginal: number;
          };
          request: { messages: Array<{ content: Array<{ content: string }> }> };
        };
      };
    }).result.structuredContent;
    expect(body.report.readerTier).toBe('text');
    expect(body.report.imaged).toBe(false);
    expect(body.report.promptCacheBreakpoint).toBe(false);
    expect(body.report.textCompressed).toBe(true);
    expect(body.report.textStages).toContain('toon');
    expect(body.report.savedVsOriginal).toBeGreaterThan(0);
    expect(body.request.messages[0]?.content[0]?.content).toContain('@toon');

    const cleanRequest = {
      model: 'grok-4.7',
      max_tokens: 64,
      system: 'You are a coding agent.',
      messages: [{ role: 'user', content: 'Explain the checksum mismatch.' }],
    };
    const cleanTransformed = await handleMcpMessage(rpc('tools/call', {
      name: 'transform_request',
      arguments: {
        model: 'grok-4.7',
        wire: 'anthropic',
        upstream: 'https://chatgpt.com',
        pathname: '/backend-api/codex/responses',
        request: cleanRequest,
      },
    }));
    const cleanBody = (cleanTransformed as { result: { structuredContent: { report: { readerTier: string; imaged: boolean; promptCacheBreakpoint: boolean; savedVsOriginal: number }; request: unknown } } }).result.structuredContent;
    expect(cleanBody.report.readerTier).toBe('text');
    expect(cleanBody.report.imaged).toBe(false);
    expect(cleanBody.report.promptCacheBreakpoint).toBe(false);
    expect(cleanBody.report.savedVsOriginal).toBe(0);
    expect(cleanBody.request).toEqual(cleanRequest);
  });

  it('speaks newline frames and streamable HTTP', async () => {
    const frames: unknown[] = [];
    let buffer = '';
    const raw = encodeMcpMessage(rpc('ping'), false) + encodeMcpMessage(rpc('tools/list', {}, 2), false);
    buffer = pushMcpChunk(buffer, raw, (message) => frames.push(message));
    expect(buffer).toBe('');
    expect(frames).toHaveLength(2);
    const tooBig: unknown[] = [];
    pushMcpChunk('', 'x'.repeat(MCP_MAX_BYTES + 1), (message) => tooBig.push(message));
    expect(JSON.stringify(tooBig[0])).toContain('message exceeds');

    const http = await startHttpServer(0);
    try {
      const res = await fetch(`http://127.0.0.1:${http.port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(rpc('tools/call', { name: 'health', arguments: {} }, 7)),
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { result: { structuredContent: { name: string; codex: string } } };
      expect(json.result.structuredContent.name).toBe('fiche-mcp');
      expect(json.result.structuredContent.codex).toContain('chatgpt.com');
      const denied = await fetch(`http://127.0.0.1:${http.port}/mcp`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(denied.status).toBe(403);
    } finally {
      await http.close();
    }
  });

  it('serves page_in and mmu_stats from in-process MMU store and falls back to daemon loopback', async () => {
    const store = getGlobalMmuStore();
    const code = [
      '// src/demo/auth.ts',
      'export function helperOne() { return 1; }',
      'export async function verifySessionToken(tok: string): Promise<boolean> {',
      '  return tok.startsWith("live_");',
      '}',
      'export function helperTwo() { return 2; }',
    ].join('\n');
    const page = store.storePage({
      sessionKey: 'sess-mcp-1',
      refId: 'src/demo/auth.ts',
      toolName: 'Read',
      rawText: code,
    });

    // 1) page_in by exact pageId + line slice
    const byId = await handleMcpMessage(rpc('tools/call', {
      name: 'page_in',
      arguments: { pageId: page.id, startLine: 3, endLine: 5 },
    }, 10)) as { result: { isError: boolean; structuredContent: { source: string; pageId: string; startLine: number; endLine: number; text: string } } };
    expect(byId.result.isError).toBe(false);
    expect(byId.result.structuredContent.source).toBe('local');
    expect(byId.result.structuredContent.pageId).toBe(page.id);
    expect(byId.result.structuredContent.startLine).toBe(3);
    expect(byId.result.structuredContent.endLine).toBe(5);
    expect(byId.result.structuredContent.text).toContain('verifySessionToken');

    // 2) page_in by symbol query
    const byQuery = await handleMcpMessage(rpc('tools/call', {
      name: 'page_in',
      arguments: { query: 'verifySessionToken', maxLines: 4 },
    }, 11)) as { result: { isError: boolean; structuredContent: { pageId: string; text: string; matches: unknown[] } } };
    expect(byQuery.result.isError).toBe(false);
    expect(byQuery.result.structuredContent.pageId).toBe(page.id);
    expect(byQuery.result.structuredContent.text).toContain('verifySessionToken');
    expect(byQuery.result.structuredContent.matches.length).toBeGreaterThanOrEqual(1);

    // 3) page_in error on missing args and missing pageId
    const missingArgs = await handleMcpMessage(rpc('tools/call', {
      name: 'page_in',
      arguments: {},
    }, 12)) as { result: { isError: boolean } };
    expect(missingArgs.result.isError).toBe(true);

    const missingPage = await handleMcpMessage(rpc('tools/call', {
      name: 'page_in',
      arguments: { pageId: 'pg_000000000000' },
    }, 13)) as { result: { isError: boolean } };
    expect(missingPage.result.isError).toBe(true);

    // 4) mmu_stats local inspection
    const localStatsRes = await handleMcpMessage(rpc('tools/call', {
      name: 'mmu_stats',
      arguments: { sessionKey: 'sess-mcp-1' },
    }, 14)) as { result: { isError: boolean; structuredContent: { source: string; pageCount: number; stats: { pagesStored: number } } } };
    expect(localStatsRes.result.isError).toBe(false);
    expect(localStatsRes.result.structuredContent.source).toBe('local');
    expect(localStatsRes.result.structuredContent.pageCount).toBe(1);
    expect(localStatsRes.result.structuredContent.stats.pagesStored).toBeGreaterThanOrEqual(1);

    // 5) Standalone stdio MCP fallback when global store is empty
    resetGlobalMmuStore();
    const daemonMock = createNodeHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/mmu/page') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          pageId: 'pg_deadbeefcafe',
          startLine: 1,
          endLine: 2,
          text: 'daemon line 1\ndaemon line 2',
        }));
        return;
      }
      if (url.pathname === '/api/mmu/stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          stats: { pagesStored: 9 },
          pageCount: 9,
          pages: [],
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => daemonMock.listen(0, '127.0.0.1', () => resolve()));
    const prevPort = process.env.PORT;
    try {
      const addr = daemonMock.address() as { port: number };
      process.env.PORT = String(addr.port);

      const remotePage = await handleMcpMessage(rpc('tools/call', {
        name: 'page_in',
        arguments: { pageId: 'pg_deadbeefcafe' },
      }, 15)) as { result: { isError: boolean; structuredContent: { source: string; pageId: string; text: string } } };
      expect(remotePage.result.isError).toBe(false);
      expect(remotePage.result.structuredContent.source).toBe('daemon');
      expect(remotePage.result.structuredContent.pageId).toBe('pg_deadbeefcafe');
      expect(remotePage.result.structuredContent.text).toContain('daemon line 1');

      const remoteStats = await handleMcpMessage(rpc('tools/call', {
        name: 'mmu_stats',
        arguments: {},
      }, 16)) as { result: { isError: boolean; structuredContent: { source: string; pageCount: number } } };
      expect(remoteStats.result.isError).toBe(false);
      expect(remoteStats.result.structuredContent.source).toBe('daemon');
      expect(remoteStats.result.structuredContent.pageCount).toBe(9);
    } finally {
      await new Promise<void>((resolve) => daemonMock.close(() => resolve()));
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }

    // 6) Offline daemon fails cleanly and swiftly
    const prevPort2 = process.env.PORT;
    try {
      process.env.PORT = '1'; // closed port on loopback
      const offlinePage = await handleMcpMessage(rpc('tools/call', {
        name: 'page_in',
        arguments: { pageId: 'pg_deadbeefcafe' },
      }, 17)) as { result: { isError: boolean; structuredContent: { error: string } } };
      expect(offlinePage.result.isError).toBe(true);
      expect(offlinePage.result.structuredContent.error).toContain('unreachable');

      const offlineStats = await handleMcpMessage(rpc('tools/call', {
        name: 'mmu_stats',
        arguments: {},
      }, 18)) as { result: { isError: boolean; structuredContent: { daemonRunning: boolean; pageCount: number } } };
      expect(offlineStats.result.isError).toBe(false);
      expect(offlineStats.result.structuredContent.daemonRunning).toBe(false);
      expect(offlineStats.result.structuredContent.pageCount).toBe(0);
    } finally {
      if (prevPort2 === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort2;
    }
  });
});
