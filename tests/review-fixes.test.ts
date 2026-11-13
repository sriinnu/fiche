import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_CODE_OAUTH_IDENTITY } from '../src/core/transform.js';
import { prepassRequest, hybridTransform } from '../src/core/hybrid.js';
import { scrubPromptCacheBreakpoint } from '../src/core/codex-cache.js';
import { shouldImageModel } from '../src/core/reader-tier.js';
import { MCP_MAX_BYTES, hostHeaderAllowed, pushMcpChunk, startHttpServer } from '../src/mcp/server.js';

const enc = new TextEncoder();

function repetitiveJson(): string {
  return JSON.stringify({
    events: Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      status: 'ok',
      path: 'src/core/hybrid.ts',
      note: 'review fixture row',
    })),
  });
}

describe('review fixes', () => {
  const prev = process.env.PXPIPE_FORCE_IMAGES;
  afterEach(() => {
    if (prev === undefined) delete process.env.PXPIPE_FORCE_IMAGES;
    else process.env.PXPIPE_FORCE_IMAGES = prev;
  });

  it('keeps the Claude Code identity and the cache_control prefix byte-identical', () => {
    const pretty = `{
  "model": "claude-opus-5-5",
  "system": [
    { "type": "text", "text": ${JSON.stringify(CLAUDE_CODE_OAUTH_IDENTITY)}, "cache_control": { "type": "ephemeral" } },
    { "type": "text", "text": "Follow the repository conventions." }
  ],
  "messages": [{
    "role": "user",
    "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": ${JSON.stringify(repetitiveJson())} }]
  }]
}`;
    const body = enc.encode(pretty);
    const pre = prepassRequest(body, 'claude-opus-5-5');
    expect(pre.changed).toBe(true);
    const outText = new TextDecoder().decode(pre.body);
    const boundary = pretty.indexOf('"cache_control"');
    const end = pretty.indexOf('}', pretty.indexOf('}', boundary) + 1);
    expect(outText.slice(0, end + 1)).toBe(pretty.slice(0, end + 1));
    const out = JSON.parse(outText) as {
      system: Array<{ text: string }>;
      messages: Array<{ role?: string; content?: Array<{ content?: string }> }>;
    };
    expect(out.system[0]!.text).toBe(CLAUDE_CODE_OAUTH_IDENTITY);
    expect(out.system.some((block) => block.text.includes('Pipe-Aligned Kompact Text'))).toBe(false);
    expect(out.messages.some((message) => message.role === 'system')).toBe(false);
    expect(out.messages[0]!.content?.[0]?.content).toContain('Pipe-Aligned Kompact Text');
    expect(out.messages[0]!.content?.[0]?.content).toContain('@from json');
  });

  it('does not reserialize a Codex body that has no breakpoint', () => {
    const raw = enc.encode('{\n  "model": "gpt-5.6-sol",\n  "input": "hi"\n}\n');
    expect(scrubPromptCacheBreakpoint(raw)).toBe(raw);
    const plantedPretty = '{\n  "model": "gpt-5.6-sol",\n  "input": "hi",\n  "prompt_cache_breakpoint": { "mode": "explicit" }\n}\n';
    const scrubbedPretty = new TextDecoder().decode(scrubPromptCacheBreakpoint(enc.encode(plantedPretty)));
    expect(scrubbedPretty).toBe('{\n  "model": "gpt-5.6-sol",\n  "input": "hi"\n}\n');
    expect(scrubbedPretty.startsWith('{\n  "model"')).toBe(true);
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
    delete process.env.PXPIPE_FORCE_IMAGES;
    expect(shouldImageModel('claude-fable-5', true)).toBe(true);
    expect(shouldImageModel('claude-opus-5', true)).toBe(true);
    expect(shouldImageModel('claude-opus-5-5', true)).toBe(true);
    expect(shouldImageModel('claude-opus-5-5', true, true)).toBe(true);
    expect(shouldImageModel('grok-4.7', false)).toBe(false);
    expect(shouldImageModel('grok-4.7', false, true)).toBe(false);
    expect(shouldImageModel('grok-4.7', true)).toBe(true);
    expect(shouldImageModel('claude-haiku-4-5', true)).toBe(true);
    expect(shouldImageModel('gpt-5.6-sol', false)).toBe(false);
    expect(shouldImageModel('gpt-5.6-sol', true)).toBe(true);
  });

  it('does not write PXPIPE_FORCE_IMAGES while transforming one MCP-style call', async () => {
    delete process.env.PXPIPE_FORCE_IMAGES;
    await hybridTransform(enc.encode(JSON.stringify({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
    })), {
      model: 'claude-sonnet-5-5',
      wire: 'anthropic',
      compress: false,
      forceImages: true,
    });
    expect(process.env.PXPIPE_FORCE_IMAGES).toBeUndefined();
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
