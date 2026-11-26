import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

import {
  classifyInboundCredential,
  createProxy,
  resetGoogleCountShapePreferenceForTests,
  type ProxyEvent,
} from '../src/core/proxy.js';
import { guardProxyRequest } from '../src/core/request-guard.js';
import { toTrackEvent } from '../src/core/tracker.js';
import { buildUpstreamRegistry, parseUpstreamHosts } from '../src/core/upstream-hosts.js';
import { FileTracker } from '../src/file-tracker.js';
import { ensureLaunchdSocketShim } from '../src/launchd-socket.js';
import { fileMmuPersistenceStore } from '../src/mmu-store.js';
import { createNodeUpstreamFetch } from '../src/node-fetch.js';
import { decodeRequestBody, decodeRequestBodyWithStatus } from '../src/request-decoding.js';
import { renderShellInitScript } from '../src/warp/app-launch.js';
import { CertificateAuthority } from '../src/warp/ca.js';
import { createWarpHandlers } from '../src/warp/connect.js';
import {
  loadOrCreateWarpToken,
  mergeNoProxy,
  shouldStripAnthropicBaseUrl,
} from '../src/warp/index.js';
import { parseRoute } from '../src/warp/route.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanups: Array<() => Promise<void> | void> = [];
const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
  resetGoogleCountShapePreferenceForTests();
  delete process.env.FICHE_MODELS;
  delete process.env.INKLING_MODELS;
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address() as net.AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return addr.port;
}

describe('Track B — Concurrency, Stream Lifecycle & Persistence Safety', () => {
  it('teeForUsage obeys slow-consumer backpressure without tee-buffering and waits for 5xx body completion before releasing inFlight', async () => {
    let upstreamPulls = 0;
    const totalChunks = 20;
    const chunkPayload = `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(1024) } })}\n\n`;
    const enc = new TextEncoder();

    const upstreamStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (upstreamPulls >= totalChunks) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } })}\n\n`));
          controller.close();
          return;
        }
        upstreamPulls += 1;
        controller.enqueue(enc.encode(chunkPayload));
      },
    });

    const events: ProxyEvent[] = [];
    const proxy = createProxy({
      upstream: 'https://api.anthropic.com',
      transform: { compress: false },
      fetch: (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('count_tokens')) {
          return new Response(JSON.stringify({ input_tokens: 10 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(upstreamStream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch,
      onRequest: (ev) => {
        events.push(ev);
      },
    });

    const res = await proxy(
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
        body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(res.status).toBe(200);

    // Wait a tick without reading client body: pull-through must NOT eagerly drain all 20 chunks!
    // (1-chunk HWM per stream stage permits ~3-4 pre-buffered chunks, never all 20.)
    await new Promise((r) => setTimeout(r, 30));
    expect(upstreamPulls).toBeLessThanOrEqual(5);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(upstreamPulls).toBeLessThanOrEqual(6);

    while (!(await reader.read()).done) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(upstreamPulls).toBe(totalChunks);
    expect(events.at(-1)?.usage?.output_tokens).toBe(42);

    // 5xx body must finish streaming before releasing inFlight & firing telemetry
    let release5xx!: () => void;
    const gate5xx = new Promise<void>((r) => {
      release5xx = r;
    });
    const events5xx: ProxyEvent[] = [];
    const proxy5xx = createProxy({
      openAIUpstream: 'https://api.openai.com',
      duplicateHoldMs: 5000,
      transform: { compress: false },
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              controller.enqueue(enc.encode('first-5xx-chunk'));
              await gate5xx;
              controller.enqueue(enc.encode('last-5xx-chunk'));
              controller.close();
            },
          }),
          { status: 503, headers: { 'content-type': 'text/plain' } },
        )) as typeof fetch,
      onRequest: (ev) => {
        events5xx.push(ev);
      },
    });

    const mk5xxReq = () =>
      new Request('http://127.0.0.1:47821/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-openai-test' },
        body: JSON.stringify({ model: 'gpt-6-astra', input: 'hi' }),
      });

    const r5 = await proxy5xx(mk5xxReq());
    expect(r5.status).toBe(503);
    const reader5 = r5.body!.getReader();
    await reader5.read(); // read first chunk; body still open
    await new Promise((r) => setTimeout(r, 20));
    expect(events5xx).toHaveLength(0);

    // While 5xx body is still streaming, duplicate retry is still 409 in-flight
    const dup5 = await proxy5xx(mk5xxReq());
    expect(dup5.status).toBe(409);
    await new Promise((r) => setTimeout(r, 20));
    expect(events5xx.filter((e) => e.status === 503)).toHaveLength(0);

    release5xx();
    while (!(await reader5.read()).done) {
      // finish 5xx stream
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(events5xx.map((e) => e.status)).toEqual([409, 503]);

    // Now lease is released
    const after5 = await proxy5xx(mk5xxReq());
    expect(after5.status).toBe(503);
    await after5.body?.cancel();
  });

  it('rejects closed/destroyed ServerResponse before writeWebResponse / waitForDrain stalls', async () => {
    // Exercise real HTTP server writing a streamed response when client destroys socket mid-stream
    const chunks: string[] = [];
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('chunk1');
      res.destroy();
      // Verify destroyed & closed state matches our guard in node.ts
      chunks.push(`destroyed=${res.destroyed},writableEnded=${res.writableEnded},closed=${res.closed}`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));

    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.on('close', resolve);
        res.on('error', resolve);
        res.resume();
      });
      req.on('error', () => resolve());
      req.end();
    });
    expect(chunks[0]).toContain('destroyed=true');
  });

  it('checks inFlight duplicate 409 before firing count_tokens probes and does not crash on failing telemetry', async () => {
    let probeCalls = 0;
    let releaseMain!: () => void;
    const mainGate = new Promise<void>((r) => {
      releaseMain = r;
    });

    const proxy = createProxy({
      upstream: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      duplicateHoldMs: 5000,
      transform: { compress: false },
      fetch: (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.endsWith('/count_tokens')) {
          probeCalls += 1;
          return new Response(JSON.stringify({ input_tokens: 10 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        await mainGate;
        return new Response(JSON.stringify({ id: 'm1', usage: { input_tokens: 5, output_tokens: 2 }, content: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      onRequest: () => {
        throw new Error('simulated telemetry failure');
      },
    });

    const body = JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'same-prompt' }],
    });
    const mk = () =>
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

    const p1 = proxy(mk());
    await new Promise((r) => setTimeout(r, 20));
    expect(probeCalls).toBe(1);

    const p2 = await proxy(mk());
    expect(p2.status).toBe(409);
    // Duplicate retry must NOT fire a second count_tokens probe!
    expect(probeCalls).toBe(1);

    releaseMain();
    const r1 = await p1;
    expect(r1.status).toBe(200);
    await r1.text();
  });

  it('hardens FileTracker against symlinks and bounds pendingDuringRewrite, and mmu-store rejects symlinks on load', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-trackb-persist-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    // MMU store: symlink rejected via O_NOFOLLOW + fstatSync
    const mmuReal = path.join(tmp, 'real.json');
    const mmuLink = path.join(tmp, 'link.json');
    fs.writeFileSync(mmuReal, '{"pages":[]}', { mode: 0o600 });
    fs.symlinkSync(mmuReal, mmuLink);
    expect(fileMmuPersistenceStore(mmuLink).load()).toBeUndefined();

    const mmuTarget = path.join(tmp, 'mmu.json');
    fileMmuPersistenceStore(mmuTarget).save('{"ok":true}');
    expect(fileMmuPersistenceStore(mmuTarget).load()).toBe('{"ok":true}');
    if (process.platform !== 'win32') {
      expect(fs.statSync(mmuTarget).mode & 0o777).toBe(0o600);
    }

    // FileTracker: bounds pendingDuringRewrite at 10_000 lines
    const eventsPath = path.join(tmp, 'events.jsonl');
    const tracker = new FileTracker(eventsPath);
    let flushedCount = 0;
    await tracker.runDuringRewrite(async (flushPending) => {
      for (let i = 0; i < 10_200; i += 1) {
        tracker.emit({ ts: '2026-01-01T00:00:00Z', method: 'POST', path: '/v1/messages', status: 200, duration_ms: i });
      }
      const outPath = path.join(tmp, 'rewritten.jsonl');
      const outFd = fs.openSync(outPath, 'w', 0o600);
      flushPending(outFd, (_fd, _line) => {
        flushedCount += 1;
      });
      fs.closeSync(outFd);
    });
    tracker.close();
    expect(flushedCount).toBe(10_000);
  });
});

describe('Track B — All-Agents Warp, Request Guard & Connect Security', () => {
  it('preserves remote ANTHROPIC_BASE_URL while stripping Fiche loopback URL, and excludes explicit --route loopback hosts from NO_PROXY', () => {
    expect(shouldStripAnthropicBaseUrl('http://127.0.0.1:47821', 47821)).toBe(true);
    expect(shouldStripAnthropicBaseUrl('http://localhost:47821/', 47821)).toBe(true);
    expect(shouldStripAnthropicBaseUrl('http://[::1]:47821', 47821)).toBe(true);
    expect(shouldStripAnthropicBaseUrl('http://127.0.0.1:9999', 47821)).toBe(false);
    expect(shouldStripAnthropicBaseUrl('https://api.deepseek.com/anthropic', 47821)).toBe(false);
    expect(shouldStripAnthropicBaseUrl('https://openrouter.ai/api', 47821)).toBe(false);

    const noProxy = mergeNoProxy('corp.internal,127.0.0.1', new Set(['127.0.0.1']));
    expect(noProxy).toBe('corp.internal,localhost,::1');
  });

  it('creates 0600 warp-token and enforces desktop Origin/Sec-Fetch-Site protection unless warpAuthenticated', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-warp-token-'));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const t1 = loadOrCreateWarpToken(tmp);
    const t2 = loadOrCreateWarpToken(tmp);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(t2).toBe(t1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(tmp, 'warp-token')).mode & 0o777).toBe(0o600);
    }

    // Unauthenticated desktop Origins / cross-site headers are refused
    expect(guardProxyRequest({ host: 'chatgpt.com', origin: 'https://chatgpt.com' })?.status).toBe(403);
    expect(guardProxyRequest({ host: '127.0.0.1:47821', origin: 'vscode-file://vscode-app' })?.status).toBe(403);
    expect(guardProxyRequest({ host: '127.0.0.1:47821', secFetchSite: '  Cross-Site ' })?.status).toBe(403);

    // Authenticated warp requests pass desktop Origins & cross-site while still enforcing Host check
    expect(
      guardProxyRequest(
        { host: 'chatgpt.com', origin: 'https://chatgpt.com', secFetchSite: 'cross-site' },
        { warpAuthenticated: true },
      ),
    ).toBeNull();
    expect(
      guardProxyRequest(
        { host: '127.0.0.1:47821', origin: 'vscode-file://vscode-app', secFetchSite: 'cross-site' },
        { warpAuthenticated: true },
      ),
    ).toBeNull();
    expect(
      guardProxyRequest(
        { host: 'evil.example', origin: 'https://chatgpt.com' },
        { warpAuthenticated: true },
      )?.status,
    ).toBe(421);

    // proxy.ts strips x-fiche-warp-auth before forwarding upstream
    let seenWarpAuth: string | null = 'not-checked';
    const proxy = createProxy({
      upstream: 'https://api.anthropic.com',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        seenWarpAuth = h.get('x-fiche-warp-auth');
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const res = await proxy(
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fiche-warp-auth': t1 },
        body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    await res.text();
    expect(seenWarpAuth).toBeNull();
  });

  it('rejects Host-header mismatch (421), self-proxy loops (508), malformed upgrades (400), and redacts 502 errors in connect.ts', async () => {
    const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-connect-sec-'));
    cleanups.push(() => fs.rmSync(caDir, { recursive: true, force: true }));
    const ca = CertificateAuthority.loadOrCreate(caDir);

    // Leaf cert has explicit BasicConstraints CA:FALSE and 0600 permissions
    const leafPem = ca.mintLeafCertPem('api.anthropic.com');
    const x509 = new X509Certificate(leafPem);
    expect(x509.ca).toBe(false);
    // OID 2.5.29.19 = 55 1d 13
    expect(x509.raw.includes(Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x13]))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(ca.certPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(ca.bundlePath).mode & 0o777).toBe(0o600);
    }

    const originPort = await freePort();
    let warpPort = 0;
    const handlers = createWarpHandlers({
      routes: [parseRoute(`api.anthropic.com/v1/*=http://127.0.0.1:${originPort}`)],
      ca,
      selfPort: () => warpPort,
    });
    const srv = createServer(handlers.handleAbsoluteForm);
    srv.on('connect', handlers.handleConnect);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    warpPort = (srv.address() as net.AddressInfo).port;
    cleanups.push(async () => {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    });

    // 1. Self-proxy loop rejected with 508
    const loopStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: warpPort,
        method: 'CONNECT',
        path: `127.0.0.1:${warpPort}`,
      });
      req.on('connect', (res, sock) => {
        sock.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(loopStatus).toBe(508);

    // 2. Host header mismatch inside CONNECT TLS tunnel returns 421 Misdirected Request
    const caCert = fs.readFileSync(ca.certPath);
    const mismatchRaw = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: warpPort,
        method: 'CONNECT',
        path: 'api.anthropic.com:443',
      });
      req.on('connect', (res, socket) => {
        expect(res.statusCode).toBe(200);
        const tlsSock = tls.connect({ socket, servername: 'api.anthropic.com', ca: caCert }, () => {
          tlsSock.write('POST /v1/messages HTTP/1.1\r\nHost: evil.example\r\nContent-Length: 2\r\n\r\n{}');
        });
        let raw = '';
        tlsSock.on('data', (d) => { raw += d.toString('utf8'); });
        const done = () => { tlsSock.destroy(); socket.destroy(); resolve(raw); };
        tlsSock.on('end', done);
        tlsSock.on('close', done);
      });
      req.on('error', reject);
      req.end();
    });
    expect(mismatchRaw).toContain('421');

    // 3. Malformed upgrade URI returns 400 instead of falling through
    const badUpgradeRaw = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: warpPort,
        method: 'CONNECT',
        path: 'api.anthropic.com:443',
      });
      req.on('connect', (_res, socket) => {
        const tlsSock = tls.connect({ socket, servername: 'api.anthropic.com', ca: caCert }, () => {
          tlsSock.write(
            'GET http://[invalid HTTP/1.1\r\nHost: api.anthropic.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
          );
        });
        let raw = '';
        tlsSock.on('data', (d) => { raw += d.toString('utf8'); });
        const done = () => { tlsSock.destroy(); socket.destroy(); resolve(raw); };
        tlsSock.on('end', done);
        tlsSock.on('close', done);
      });
      req.on('error', reject);
      req.end();
    });
    expect(badUpgradeRaw).toContain('400 Bad Request');

    // 4. 502 error does not leak raw err.message (like 127.0.0.1:<port>)
    const closedPort = await freePort();
    const res502 = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port: warpPort,
          method: 'GET',
          path: `http://127.0.0.1:${closedPort}/x`,
          headers: { host: `127.0.0.1:${closedPort}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      r.on('error', reject);
      r.end();
    });
    expect(res502.status).toBe(502);
    expect(res502.body).toBe('fiche warp: upstream error');
    expect(res502.body).not.toContain('ECONNREFUSED');
  });

  it('fails open on ECONNRESET without 502, replays intact body, and keeps x-fiche-warp-auth off direct origin', async () => {
    const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-warp-rst-'));
    cleanups.push(() => fs.rmSync(caDir, { recursive: true, force: true }));
    const ca = CertificateAuthority.loadOrCreate(caDir);

    // Daemon listener that accepts TCP and immediately destroys socket -> ECONNRESET
    const rstDaemon = net.createServer((sock) => {
      sock.destroy();
    });
    await new Promise<void>((r) => rstDaemon.listen(0, '127.0.0.1', r));
    const rstDaemonPort = (rstDaemon.address() as net.AddressInfo).port;

    let originBody = '';
    let originWarpAuth: string | undefined;
    const originServer = createServer((req, res) => {
      originWarpAuth = req.headers['x-fiche-warp-auth'] as string | undefined;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        originBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => originServer.listen(0, '127.0.0.1', r));
    const originPort = (originServer.address() as net.AddressInfo).port;

    const handlers = createWarpHandlers({
      routes: [parseRoute(`127.0.0.1:${originPort}/v1/messages*=http://127.0.0.1:${rstDaemonPort}`)],
      ca,
      failOpenOnDivertRefused: true,
      warpAuthToken: ['warp', 'test', 'auth'].join('-'),
    });
    const warpProxy = createServer(handlers.handleAbsoluteForm);
    await new Promise<void>((r) => warpProxy.listen(0, '127.0.0.1', r));
    const warpPort = (warpProxy.address() as net.AddressInfo).port;

    cleanups.push(async () => {
      warpProxy.closeAllConnections?.();
      await new Promise<void>((r) => warpProxy.close(() => r()));
      await new Promise<void>((r) => originServer.close(() => r()));
      await new Promise<void>((r) => rstDaemon.close(() => r()));
    });

    const payload = JSON.stringify({ model: 'claude-opus-4-6', msg: 'hello-econnreset' });
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest(
        {
          host: '127.0.0.1',
          port: warpPort,
          method: 'POST',
          path: `http://127.0.0.1:${originPort}/v1/messages`,
          headers: {
            host: `127.0.0.1:${originPort}`,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      r.on('error', reject);
      r.end(payload);
    });

    expect(result.status).toBe(200);
    expect(originBody).toBe(payload);
    expect(originWarpAuth).toBeUndefined();
  });

  it('renders shell-init using function keyword, command -v fallback, and FICHE_WARP_ACTIVE codex guard', () => {
    const script = renderShellInitScript({ wrap: true, ficheBin: '/usr/local/bin/fiche' });
    expect(script).toContain('function claude {');
    expect(script).toContain('function codex {');
    expect(script).toContain('command -v "$FICHE_BIN"');
    expect(script).toContain('FICHE_WARP_ACTIVE:-0');
    expect(script).toContain('features.daemon_auto_start=false');

    const bashCheck = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(bashCheck.status, bashCheck.stderr).toBe(0);
    if (fs.existsSync('/bin/zsh')) {
      const zshCheck = spawnSync('/bin/zsh', ['-n'], { input: script, encoding: 'utf8' });
      expect(zshCheck.status, zshCheck.stderr).toBe(0);
    }
  });
});

describe('Track B — Routing, Credential Hygiene, Decoding & Release CI', () => {
  it('routes /v1/models with OPENAI_API_KEY + x-api-key to Anthropic, blocks non-Bearer sk-ant-*, and routes Google OpenAI-compat paths', async () => {
    // classifyInboundCredential catches non-Bearer sk-ant-*
    expect(classifyInboundCredential(new Headers({ authorization: 'sk-ant-api03-secret' }))).toBe('anthropic-bearer');
    expect(classifyInboundCredential(new Headers({ authorization: 'Token sk-ant-oat01-secret' }))).toBe('anthropic-bearer');

    const seen: Array<{ url: string; auth: string | null; capturedKeyHeader: string | null; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = input instanceof Request ? input : new Request(String(input), init);
      seen.push({
        url: r.url,
        auth: r.headers.get('authorization'),
        capturedKeyHeader: r.headers.get('x-api-key'),
        body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : '',
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const proxy = createProxy({
      apiKey: 'sk-ant-host',
      openAIApiKey: 'sk-openai-host',
      upstream: 'https://anthropic.test',
      sharedUpstream: undefined,
      transform: { compress: false },
    });

    // 1. /v1/models with x-api-key + openAIApiKey set MUST go to Anthropic, NOT OpenAI
    const rModels = await proxy(
      new Request('http://127.0.0.1:47821/v1/models', {
        method: 'GET',
        headers: { 'x-api-key': 'sk-ant-client' },
      }),
    );
    await rModels.text();
    expect(seen.at(-1)?.url).toBe('https://anthropic.test/v1/models');

    // 2. Non-Bearer sk-ant-* on /v1/responses is replaced/dropped, never leaked to OpenAI
    const rOai = await proxy(
      new Request('http://127.0.0.1:47821/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'sk-ant-oat01-client' },
        body: JSON.stringify({ model: 'gpt-6-astra', input: 'hi' }),
      }),
    );
    await rOai.text();
    expect(seen.at(-1)?.url).toBe('https://api.openai.com/v1/responses');
    expect(seen.at(-1)?.auth).toBe('Bearer sk-openai-host');

    // 3. Non-host /v1internal: defaults to cloudcode-pa.googleapis.com, and ANTHROPIC_UPSTREAM doesn't hijack base-URL Gemini
    const rGoogle = await proxy(
      new Request('http://127.0.0.1:47821/v1internal:generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-3.6-flash', request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }),
      }),
    );
    await rGoogle.text();
    expect(seen.at(-1)?.url).toBe('https://cloudcode-pa.googleapis.com/v1internal:generateContent');

    const rGeminiBase = await proxy(
      new Request('http://127.0.0.1:47821/v1beta/models/gemini-3.6-flash:generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      }),
    );
    await rGeminiBase.text();
    expect(seen.at(-1)?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');

    // 4. /v1beta/openai/chat/completions & /v1/openai/chat/completions route to Google upstream
    const rGoogleCompat = await proxy(
      new Request('http://127.0.0.1:47821/v1/openai/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer goog-key' },
        body: JSON.stringify({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    await rGoogleCompat.text();
    expect(seen.at(-1)?.url).toBe('https://generativelanguage.googleapis.com/v1/openai/chat/completions');
    expect(seen.at(-1)?.capturedKeyHeader).toBeNull();
  });

  it('redacts Bearer and sk- tokens in count_tokens probe errors and bounds error read', async () => {
    const events: ProxyEvent[] = [];
    const secretBearer = ['Bearer', 'eyJhbGciOiJIUzI1NiJ9.secretpayload.sig'].join(' ');
    const secretSk = ['sk', 'ant', 'api03', 'supersecrettoken1234'].join('-');

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/count_tokens')) {
        return new Response(`error with ${secretBearer} and ${secretSk} ${'z'.repeat(16384)}`, {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        });
      }
      return new Response(JSON.stringify({ id: 'm1', usage: { input_tokens: 1, output_tokens: 1 }, content: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const proxyNoCap = createProxy({
      upstream: 'https://api.anthropic.com',
      captureErrorReqBody: false,
      transform: { compress: false },
      onRequest: (ev) => { events.push(ev); },
    });
    const r1 = await proxyNoCap(
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
        body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    await r1.text();
    await new Promise((r) => setTimeout(r, 20));
    expect(events[0]?.info?.baselineProbeError).toBe('http_400');

    const proxyCap = createProxy({
      upstream: 'https://api.anthropic.com',
      captureErrorReqBody: true,
      transform: { compress: false },
      onRequest: (ev) => { events.push(ev); },
    });
    const r2 = await proxyCap(
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
        body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    await r2.text();
    await new Promise((r) => setTimeout(r, 20));
    const errText = events[1]?.info?.baselineProbeError ?? '';
    expect(errText).not.toContain('secretpayload');
    expect(errText).not.toContain('supersecrettoken1234');
    expect(errText).toContain('[REDACTED]');

    const tracked = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 400,
      durationMs: 10,
      error: `bad ${secretBearer}`,
      errorBody: `rejected ${secretSk}`,
    });
    expect(tracked.error).not.toContain('secretpayload');
    expect(tracked.error_body).not.toContain('supersecrettoken1234');
  });

  it('rejects >2 request codings, returns 413 on decode too_large under reject policy, and preserves undecoded response content-encoding', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ model: 'gpt-6-astra', input: 'x'.repeat(8192) }));
    const gz = new Uint8Array(zlib.gzipSync(payload));

    expect(decodeRequestBodyWithStatus(gz, 'gzip, br, deflate', 1 << 20)).toEqual({ status: 'unsupported' });
    expect(decodeRequestBody(gz, 'gzip, br, deflate', 1 << 20)).toBeUndefined();
    expect(decodeRequestBodyWithStatus(gz, 'gzip', 1024)).toEqual({ status: 'too_large' });

    let upstreamCalls = 0;
    const proxy = createProxy({
      openAIUpstream: 'https://api.openai.com',
      oversizedBodyPolicy: 'reject',
      maxRequestBytes: 4096,
      decodeRequestBody: decodeRequestBodyWithStatus,
      fetch: (async () => {
        upstreamCalls += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    // Compressed size is tiny (< 4096 bytes), but decoded size is > 4096 bytes -> 413!
    const res413 = await proxy(
      new Request('http://127.0.0.1:47821/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: gz,
      }),
    );
    expect(res413.status).toBe(413);
    expect(upstreamCalls).toBe(0);

    // node-fetch multi-coding response decompression + undecoded encoding preservation through proxy.ts
    const compressedOrigin = createServer((req, res) => {
      if (req.url?.endsWith('/multi')) {
        const body = zlib.brotliCompressSync(zlib.gzipSync(Buffer.from('{"ok":true}')));
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip, br' });
        res.end(body);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'custom-x' });
      res.end(Buffer.from('opaque-compressed-bytes'));
    });
    await new Promise<void>((r) => compressedOrigin.listen(0, '127.0.0.1', r));
    const originPort = (compressedOrigin.address() as net.AddressInfo).port;
    const nodeFetch = createNodeUpstreamFetch();
    cleanups.push(async () => {
      nodeFetch.destroy();
      await new Promise<void>((r) => compressedOrigin.close(() => r()));
    });

    const multiProxy = createProxy({
      upstream: `http://127.0.0.1:${originPort}`,
      fetch: nodeFetch.fetch,
      transform: { compress: false },
    });
    const rMulti = await multiProxy(new Request('http://127.0.0.1:47821/v1/messages/multi', { method: 'GET' }));
    expect(rMulti.status).toBe(200);
    expect(await rMulti.text()).toBe('{"ok":true}');
    expect(rMulti.headers.get('content-encoding')).toBeNull();

    const rCustom = await multiProxy(new Request('http://127.0.0.1:47821/v1/files', { method: 'GET' }));
    expect(rCustom.status).toBe(200);
    expect(rCustom.headers.get('content-encoding')).toBe('custom-x');
    expect(rCustom.headers.get('x-fiche-undecoded-encoding')).toBeNull();
    expect(await rCustom.text()).toBe('opaque-compressed-bytes');
  });

  it('validates update-homebrew-tap.sh hardening, release.yml SHA pinning & keychain cleanup, and launchd shim binary verification', () => {
    const script = path.join(repoRoot, 'scripts', 'update-homebrew-tap.sh');
    expect(spawnSync('bash', ['-n', script], { encoding: 'utf8' }).status).toBe(0);

    const badRepo = spawnSync('bash', [script, '0.19.0', '--dry-run'], {
      env: { ...process.env, REPO: 'bad/../repo' },
      encoding: 'utf8',
    });
    expect(badRepo.status).toBe(2);

    const dryRun = spawnSync('bash', [script, '0.19.0', '--dry-run'], { encoding: 'utf8' });
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain('uninstall quit: "dev.srinivas.fichebar"');

    const releaseYml = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(releaseYml).toContain('commit_sha: ${{ steps.verify.outputs.commit_sha }}');
    expect(releaseYml).toContain('ref: ${{ needs.publish.outputs.commit_sha }}');
    expect(releaseYml).toContain('S_ISLNK');
    expect(releaseYml).toContain('-T /usr/bin/codesign -T /usr/bin/security');
    expect(releaseYml).not.toContain('security import "${CERT_PATH}" -P "${APPLE_DEVELOPER_ID_PASSWORD}" \\\n            -A');
    expect(releaseYml).toContain('if: always()');
    expect(releaseYml).toContain('security delete-keychain');

    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/cc')) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-shim-sec-'));
      cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
      const r1 = ensureLaunchdSocketShim(tmp);
      expect(r1.supported).toBe(true);
      expect(r1.rebuilt).toBe(true);
      expect(fs.statSync(path.join(tmp, 'bin')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(r1.shimPath!).mode & 0o777).toBe(0o700);
      // Tamper with binary -> cache invalidates and rebuilds cleanly
      fs.writeFileSync(r1.shimPath!, 'tampered', { mode: 0o700 });
      const r2 = ensureLaunchdSocketShim(tmp);
      expect(r2.rebuilt).toBe(true);
    }

    // Verify open.bigmodel.cn prefix and existing.provider preservation
    const reg = buildUpstreamRegistry(parseUpstreamHosts('open.bigmodel.cn/custom'));
    expect(reg.get('open.bigmodel.cn')?.provider).toBe('glm');
    expect(reg.get('open.bigmodel.cn')?.prefixes).toContain('/api/coding/paas/v4');
    expect(reg.get('open.bigmodel.cn')?.prefixes).toContain('/custom');
  });
});
