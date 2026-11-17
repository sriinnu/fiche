import { afterEach, describe, expect, it } from 'vitest';
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

describe('MCP server', () => {
  afterEach(() => resetMcpStatsForTests());

  it('lists tools with directory annotations and answers initialize', async () => {
    const init = await handleMcpMessage(rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    }));
    const initBody = init as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(initBody.result.protocolVersion).toBe('2025-03-26');
    expect(initBody.result.serverInfo.name).toBe('inkling-mcp');
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
    const transformed = await handleMcpMessage(rpc('tools/call', {
      name: 'transform_request',
      arguments: {
        model: 'grok-4.7',
        wire: 'anthropic',
        upstream: 'https://chatgpt.com',
        pathname: '/backend-api/codex/responses',
        request,
      },
    }));
    const body = (transformed as { result: { structuredContent: { report: { readerTier: string; imaged: boolean; promptCacheBreakpoint: boolean; savedVsOriginal: number }; request: unknown } } }).result.structuredContent;
    expect(body.report.readerTier).toBe('text');
    expect(body.report.imaged).toBe(false);
    expect(body.report.promptCacheBreakpoint).toBe(false);
    expect(body.report.savedVsOriginal).toBe(0);
    expect(body.request).toEqual(request);
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
      expect(json.result.structuredContent.name).toBe('inkling-mcp');
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
});
