import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import * as http2 from 'node:http2';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createNodeUpstreamFetch, type NodeUpstreamFetch } from '../src/node-fetch.js';
import { createProxy } from '../src/core/proxy.js';
import { CertificateAuthority } from '../src/warp/ca.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanupTasks.splice(0).reverse()) {
    await fn();
  }
});

function createH2TlsServer(caDir: string, idleMs: number) {
  const ca = CertificateAuthority.loadOrCreate(caDir);
  const creds = ca.leafCredentialsFor('127.0.0.1');
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createSecureServer({
    key: creds.key,
    cert: creds.cert,
    SNICallback: (_servername, cb) => {
      try {
        cb(null, ca.secureContextFor('127.0.0.1'));
      } catch (err) {
        cb(err as Error);
      }
    },
    allowHTTP1: true,
  });
  server.setTimeout(idleMs);
  server.on('session', (session) => {
    sessions.add(session);
    session.on('error', () => {});
    session.on('close', () => sessions.delete(session));
    session.setTimeout(idleMs, () => {
      session.close();
    });
  });
  return { server, sessions, caCert: fs.readFileSync(ca.certPath) };
}

describe('Issue #33: Node HTTP/1.1 upstream fetch + H2 idle timeout survival + body cleanup', () => {
  it('survives H2 TLS server idle timeouts after aborted requests and mid-stream disconnects', async () => {
    const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-h2-ca-'));
    const { server, sessions, caCert } = createH2TlsServer(caDir, 90);
    cleanupTasks.push(async () => {
      for (const s of sessions) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(caDir, { recursive: true, force: true });
    });

    server.on('stream', (stream, headers) => {
      stream.on('error', () => {});
      const reqPath = headers[':path'] ?? '/';
      if (reqPath === '/sse-hang') {
        stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
        stream.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        return;
      }
      if (reqPath === '/hang-headers') {
        return;
      }
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ id: 'm1', usage: { input_tokens: 4, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] }));
    });
    server.on('request', (req, res) => {
      if (req.httpVersion.startsWith('2')) return;
      req.resume();
      if (req.url === '/sse-hang') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        return;
      }
      if (req.url === '/hang-headers') return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm1', usage: { input_tokens: 4, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] }));
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const upstreamBase = `https://127.0.0.1:${port}`;

    const upstreamFetch: NodeUpstreamFetch = createNodeUpstreamFetch({
      ca: caCert,
      keepAliveMsecs: 50,
      keepAliveTimeout: 90,
    });
    cleanupTasks.push(() => upstreamFetch.destroy());

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    cleanupTasks.push(() => {
      process.off('uncaughtException', onUncaught);
    });

    const proxy = createProxy({
      fetch: upstreamFetch.fetch,
      upstream: upstreamBase,
      apiKey: 'sk-ant-test-key',
    });

    // 1. Normal request establishes pooled keep-alive connection.
    const r1 = await proxy(new Request('http://127.0.0.1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    }));
    expect(r1.status).toBe(200);
    await r1.text();

    // 2. Abort fetch before headers arrive.
    const abortAc = new AbortController();
    const r2Promise = upstreamFetch.fetch(`${upstreamBase}/hang-headers`, {
      method: 'POST',
      body: '{}',
      signal: abortAc.signal,
    });
    abortAc.abort();
    await expect(r2Promise).rejects.toMatchObject({ name: 'AbortError' });

    // 3. Cancel client response mid-SSE stream through createProxy.
    const r3 = await proxy(new Request('http://127.0.0.1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    }));
    // Consume via direct SSE path then verify cancellation works cleanly.
    await r3.body?.cancel();

    const sseRes = await upstreamFetch.fetch(`${upstreamBase}/sse-hang`, { method: 'GET' });
    const reader = sseRes.body!.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    await reader.cancel();

    // 4. Wait past server + agent idle reaper timeout (90ms).
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(uncaught).toEqual([]);

    // 5. Follow-up request through the same proxy & fetch succeeds cleanly.
    const r4 = await proxy(new Request('http://127.0.0.1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'after idle' }] }),
    }));
    expect(r4.status).toBe(200);
    const json4 = (await r4.json()) as { content: Array<{ text: string }> };
    expect(json4.content[0]?.text).toBe('ok');
    expect(uncaught).toEqual([]);
  });

  it('decompresses gzip/br, preserves multi set-cookie, does not follow 302, handles 204/HEAD and streaming SSE', async () => {
    const server: HttpServer = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/gzip') {
          const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ encoding: 'gzip', echo: bodyText })));
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': String(gz.byteLength),
            'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'],
          });
          res.end(gz);
          return;
        }
        if (req.url === '/br') {
          const br = zlib.brotliCompressSync(Buffer.from('hello brotli'));
          res.writeHead(200, {
            'content-type': 'text/plain',
            'content-encoding': 'br',
            'content-length': String(br.byteLength),
          });
          res.end(br);
          return;
        }
        if (req.url === '/204') {
          res.writeHead(204, { 'x-empty': 'yes' });
          res.end();
          return;
        }
        if (req.url === '/head') {
          res.writeHead(200, { 'content-length': '1234', 'content-encoding': 'gzip' });
          res.end();
          return;
        }
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'https://evil.example/steal' });
          res.end();
          return;
        }
        if (req.url === '/sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: chunk1\n\n');
          setTimeout(() => {
            if (!res.destroyed && !res.writableEnded) {
              res.write('data: chunk2\n\n');
              res.end();
            }
          }, 25);
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const transport = createNodeUpstreamFetch();
    cleanupTasks.push(async () => {
      transport.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    // Streamed ReadableStream request body + gzip response + multi Set-Cookie
    const reqStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('streamed-'));
        c.enqueue(new TextEncoder().encode('payload'));
        c.close();
      },
    });
    const gzRes = await transport.fetch(`${base}/gzip`, {
      method: 'POST',
      body: reqStream,
      duplex: 'half',
    } as RequestInit);
    expect(gzRes.status).toBe(200);
    expect(gzRes.headers.get('content-encoding')).toBeNull();
    expect(gzRes.headers.get('content-length')).toBeNull();
    expect(gzRes.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; HttpOnly']);
    expect(await gzRes.json()).toEqual({ encoding: 'gzip', echo: 'streamed-payload' });

    const brRes = await transport.fetch(`${base}/br`);
    expect(brRes.status).toBe(200);
    expect(await brRes.text()).toBe('hello brotli');

    const noContent = await transport.fetch(`${base}/204`);
    expect(noContent.status).toBe(204);
    expect(noContent.body).toBeNull();

    const headRes = await transport.fetch(`${base}/head`, { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(headRes.body).toBeNull();

    const redirRes = await transport.fetch(`${base}/redirect`, { redirect: 'manual' });
    expect(redirRes.status).toBe(302);
    expect(redirRes.headers.get('location')).toBe('https://evil.example/steal');
    await redirRes.body?.cancel();

    // Streaming SSE delivers chunk1 immediately without buffering until EOF
    const sseRes = await transport.fetch(`${base}/sse`);
    const reader = sseRes.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('chunk1');
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain('chunk2');
    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  it('cancels late headers-timeout response bodies and propagates client AbortSignal in createProxy', async () => {
    let cancelledLateBody = false;
    let sawUpstreamAborted = false;
    let releaseLateFetch!: (r: Response) => void;

    const proxySlowHeaders = createProxy({
      upstream: 'https://upstream.example',
      apiKey: 'sk-ant-test',
      upstreamHeadersTimeoutMs: 25,
      fetch: async (_url, init) => {
        init?.signal?.addEventListener('abort', () => {
          sawUpstreamAborted = true;
        });
        return await new Promise<Response>((resolve) => {
          releaseLateFetch = resolve;
        });
      },
    });

    const timeoutRes = await proxySlowHeaders(new Request('http://127.0.0.1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    }));
    expect(timeoutRes.status).toBe(504);
    expect(sawUpstreamAborted).toBe(true);

    // Resolve the timed-out fetch late and assert its body is cancelled promptly.
    releaseLateFetch(new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelledLateBody = true;
      },
    }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelledLateBody).toBe(true);

    // Client disconnect before upstream headers arrives aborts the upstream signal.
    let clientAbortObserved = false;
    const clientAc = new AbortController();
    const proxyClientAbort = createProxy({
      upstream: 'https://upstream.example',
      apiKey: 'sk-ant-test',
      fetch: async (_url, init) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            clientAbortObserved = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    });
    const reqPromise = proxyClientAbort(new Request('http://127.0.0.1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      signal: clientAc.signal,
    }));
    setTimeout(() => clientAc.abort(), 15);
    const abortRes = await reqPromise;
    expect(abortRes.status).toBe(499);
    expect(clientAbortObserved).toBe(true);
  });
});
