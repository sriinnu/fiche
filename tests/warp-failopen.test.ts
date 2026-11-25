import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CertificateAuthority } from '../src/warp/ca.js';
import { createWarpHandlers } from '../src/warp/connect.js';
import { isLocalDaemonReachable } from '../src/warp/index.js';
import { parseRoute } from '../src/warp/route.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distNodeJs = path.join(repoRoot, 'dist', 'node.js');
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('fiche warp daemon-down bypass & mid-session fail-open', () => {
  it('isLocalDaemonReachable distinguishes listening vs closed loopback ports', async () => {
    const srv = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address();
    const openPort = typeof addr === 'object' && addr ? addr.port : 0;
    cleanups.push(() => new Promise<void>((resolve) => srv.close(() => resolve())));

    expect(await isLocalDaemonReachable(openPort)).toBe(true);
    const closedPort = await freePort();
    expect(await isLocalDaemonReachable(closedPort)).toBe(false);
  });

  it('fails open directly to origin with intact body and auth headers when diverted target refuses TCP connection', async () => {
    const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-warp-failopen-ca-'));
    const ca = CertificateAuthority.loadOrCreate(caDir);
    const closedDaemonPort = await freePort();

    let receivedMethod = '';
    let receivedAuth = '';
    let receivedBody = '';
    const originServer: Server = createServer((req, res) => {
      receivedMethod = req.method ?? '';
      receivedAuth = String(req.headers.authorization ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ direct: true, length: receivedBody.length }));
      });
    });
    await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', resolve));
    const originPort = (originServer.address() as net.AddressInfo).port;

    const handlers = createWarpHandlers({
      routes: [parseRoute(`127.0.0.1:${originPort}/v1/messages*=http://127.0.0.1:${closedDaemonPort}`)],
      ca,
      failOpenOnDivertRefused: true,
    });
    const warpProxy = createServer(handlers.handleAbsoluteForm);
    await new Promise<void>((resolve) => warpProxy.listen(0, '127.0.0.1', resolve));
    const warpPort = (warpProxy.address() as net.AddressInfo).port;

    cleanups.push(async () => {
      await new Promise<void>((resolve) => warpProxy.close(() => resolve()));
      await new Promise<void>((resolve) => originServer.close(() => resolve()));
      fs.rmSync(caDir, { recursive: true, force: true });
    });

    const payload = JSON.stringify({ model: 'gemini-4-hydrogen-xhigh', prompt: 'x'.repeat(2048) });
    // Exercise absolute-form proxy request over HTTP via node:http or curl —
    // node:http request targeting the warp proxy directly matches HTTP_PROXY behavior.
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest({
        host: '127.0.0.1',
        port: warpPort,
        method: 'POST',
        path: `http://127.0.0.1:${originPort}/v1/messages`,
        headers: {
          host: `127.0.0.1:${originPort}`,
          'content-type': 'application/json',
          authorization: 'Bearer ya29.test-oauth-token',
          'content-length': String(Buffer.byteLength(payload)),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      r.on('error', reject);
      r.end(payload);
    });

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ direct: true, length: payload.length });
    expect(receivedMethod).toBe('POST');
    expect(receivedAuth).toBe('Bearer ya29.test-oauth-token');
    expect(receivedBody).toBe(payload);
  });

  it('launches child directly unwrapped without proxy/CA env when local daemon is stopped', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-warp-home-'));
    const closedPort = await freePort();
    cleanups.push(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

    // Ensure dist/node.js is built before spawning CLI binary.
    if (!fs.existsSync(distNodeJs)) {
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: repoRoot });
    }

    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome, PORT: String(closedPort) };
    delete childEnv.HTTP_PROXY;
    delete childEnv.http_proxy;
    delete childEnv.HTTPS_PROXY;
    delete childEnv.https_proxy;
    delete childEnv.NODE_EXTRA_CA_CERTS;
    delete childEnv.SSL_CERT_FILE;
    delete childEnv.CURL_CA_BUNDLE;
    delete childEnv.REQUESTS_CA_BUNDLE;

    const childScript = 'console.log(JSON.stringify({ bypass: process.env.FICHE_BYPASS ?? null, httpsProxy: process.env.HTTPS_PROXY ?? null, sslCertFile: process.env.SSL_CERT_FILE ?? null, nodeExtraCa: process.env.NODE_EXTRA_CA_CERTS ?? null }))';
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [distNodeJs, 'warp', '--', process.execPath, '-e', childScript],
        { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`daemon on 127.0.0.1:${closedPort} is not running`);
    expect(result.stderr).toContain('directly (unwrapped)');
    expect(JSON.parse(result.stdout.trim())).toEqual({
      bypass: '1',
      httpsProxy: null,
      sslCertFile: null,
      nodeExtraCa: null,
    });
    expect(fs.existsSync(path.join(tmpHome, '.fiche', 'warp-ca.pem'))).toBe(false);
  });
});
