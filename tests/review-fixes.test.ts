import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_CODE_OAUTH_IDENTITY } from '../src/core/transform.js';
import { transformAnyRequest } from '../src/core/request-transform.js';
import { scrubPromptCacheBreakpoint } from '../src/core/codex-cache.js';
import { shouldImageModel } from '../src/core/reader-tier.js';
import { MCP_MAX_BYTES, hostHeaderAllowed, pushMcpChunk, startHttpServer } from '../src/mcp/server.js';

const enc = new TextEncoder();

function repetitiveJson(): string {
  return JSON.stringify({
    events: Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      status: 'ok',
      path: 'src/core/request-transform.ts',
      note: 'review fixture row',
    })),
  });
}

describe('review fixes', () => {
  const prev = process.env.INKLING_FORCE_IMAGES;
  afterEach(() => {
    if (prev === undefined) delete process.env.INKLING_FORCE_IMAGES;
    else process.env.INKLING_FORCE_IMAGES = prev;
  });

  it('returns a weak-reader request byte-identical, Claude Code identity included', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'claude-opus-5-5',
      system: [
        { type: 'text', text: CLAUDE_CODE_OAUTH_IDENTITY },
        { type: 'text', text: 'Follow the repository conventions.' },
      ],
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: repetitiveJson() }],
      }],
    }));
    const result = await transformAnyRequest(body, { model: 'claude-opus-5-5', wire: 'anthropic', charsPerToken: 1, minCompressChars: 1 });
    expect(result.report.readerTier).toBe('text');
    expect(result.report.imaged).toBe(false);
    expect(result.body).toBe(body);
  });

  it('does not reserialize a Codex body that has no breakpoint', () => {
    const raw = enc.encode('{\n  "model": "gpt-5.6-sol",\n  "input": "hi"\n}\n');
    expect(scrubPromptCacheBreakpoint(raw)).toBe(raw);
    const planted = enc.encode(JSON.stringify({
      input: [{ content: [{ type: 'input_text', text: 'hi', prompt_cache_breakpoint: { mode: 'explicit' } }] }],
    }));
    const scrubbed = JSON.parse(new TextDecoder().decode(scrubPromptCacheBreakpoint(planted))) as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(scrubbed.input[0]!.content[0]).not.toHaveProperty('prompt_cache_breakpoint');
  });

  it('does not treat Content-Length inside a JSON line as stdio framing', () => {
    const framed: boolean[] = [];
    const rest = pushMcpChunk(
      '',
      '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"note":"Content-Length: 5"}}\n',
      (_message, wasFramed) => framed.push(wasFramed),
    );
    expect(rest).toBe('');
    expect(framed).toEqual([false]);
  });

  it('keeps FORCE_IMAGES from imaging a model that is not allowlisted', () => {
    delete process.env.INKLING_FORCE_IMAGES;
    expect(shouldImageModel('claude-fable-5', true)).toBe(true);
    expect(shouldImageModel('claude-opus-5', true)).toBe(true);
    expect(shouldImageModel('claude-opus-5-5', true)).toBe(false);
    expect(shouldImageModel('claude-opus-5-5', true, true)).toBe(true);
    expect(shouldImageModel('grok-4.7', false)).toBe(false);
    expect(shouldImageModel('grok-4.7', false, true)).toBe(false);
    expect(shouldImageModel('grok-4.7', true)).toBe(false);
    expect(shouldImageModel('grok-4.7', true, true)).toBe(true);
    expect(shouldImageModel('gpt-5.6-sol', false)).toBe(false);
    expect(shouldImageModel('gpt-5.6-sol', true)).toBe(true);
  });

  it('does not write INKLING_FORCE_IMAGES while transforming one MCP-style call', async () => {
    delete process.env.INKLING_FORCE_IMAGES;
    await transformAnyRequest(enc.encode(JSON.stringify({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
    })), {
      model: 'claude-sonnet-5-5',
      wire: 'anthropic',
      compress: false,
      forceImages: true,
    });
    expect(process.env.INKLING_FORCE_IMAGES).toBeUndefined();
  });

  it('rejects a non-loopback Host and an oversized HTTP body', async () => {
    expect(hostHeaderAllowed('evil.example')).toBe(false);
    expect(hostHeaderAllowed('127.0.0.1:47823')).toBe(true);
    expect(hostHeaderAllowed('[::1]:47823')).toBe(true);
    const server = await startHttpServer(0);
    const post = (host: string, body: Buffer | string) => new Promise<{ status: number }>((resolve, reject) => {
      const payload = typeof body === 'string' ? Buffer.from(body) : body;
      let settled = false;
      const finish = (status: number) => {
        if (settled) return;
        settled = true;
        resolve({ status });
      };
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host,
          'content-type': 'application/json',
          'content-length': payload.length,
        },
      }, (res) => {
        res.resume();
        res.on('end', () => finish(res.statusCode ?? 0));
      });
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') finish(413);
        else reject(err);
      });
      req.end(payload);
    });
    try {
      expect((await post('evil.example', '{}')).status).toBe(403);
      expect((await post(`127.0.0.1:${server.port}`, Buffer.alloc(MCP_MAX_BYTES + 1, 0x78))).status).toBe(413);
      const ok = await post(`127.0.0.1:${server.port}`, JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'ping',
      }));
      expect(ok.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
