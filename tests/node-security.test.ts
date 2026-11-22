import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// NTFS has no POSIX permission bits: Node reports 0o666 for every file and
// directory on Windows, and chmodSync() only toggles the read-only flag. The
// hardening in src/node.ts still runs there — only the assertion is moot, so
// we check the mode where the platform can actually express it.
const hasPosixModes = process.platform !== 'win32';

function expectMode(target: string, expected: number): void {
  if (!hasPosixModes) return;
  expect(fs.statSync(target).mode & 0o777).toBe(expected);
}

let child: ChildProcess | undefined;
let upstream: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  }
  child = undefined;
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startNode(extraEnv: Record<string, string> = {}): Promise<{
  base: string;
  eventsFile: string;
  configFile: string;
}> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkling-node-security-'));
  const port = await freePort();
  const upstreamPort = await freePort();
  upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/count_tokens')) {
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    res.end(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 1 },
    }));
  });
  await new Promise<void>((resolve) => upstream!.listen(upstreamPort, '127.0.0.1', resolve));
  const eventsFile = path.join(dir, 'data', 'events.jsonl');
  const configFile = path.join(dir, 'config', 'config.json');
  child = spawn(process.execPath, [tsxCli, 'src/node.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      INKLING_LOG: eventsFile,
      INKLING_CONFIG: configFile,
      // Session state persists to ~/.inkling/session-state.json by default; keep
      // test children off the developer's real file.
      INKLING_SESSION_STATE: 'off',
      INKLING_MODELS: 'claude-fable-5',
      ANTHROPIC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout?.on('data', (b) => output.push(String(b)));
  child.stderr?.on('data', (b) => output.push(String(b)));
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(output.join(''))), 30_000);
    const poll = () => {
      if (output.join('').includes('[fiche] listening on')) {
        clearTimeout(deadline);
        resolve();
        return;
      }
      if (child?.exitCode !== null) {
        clearTimeout(deadline);
        reject(new Error(output.join('')));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
  return { base: `http://127.0.0.1:${port}`, eventsFile, configFile };
}

describe('Node dashboard security', () => {
  it('rejects cross-origin mutations and accepts same-origin mutations', async () => {
    const { base, configFile } = await startNode();
    const denied = await fetch(`${base}/fragments/models`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      body: 'list=off',
    });
    expect(denied.status).toBe(403);
    expect(fs.existsSync(configFile)).toBe(false);

    const allowed = await fetch(`${base}/fragments/models`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: base,
        'sec-fetch-site': 'same-origin',
      },
      body: 'list=claude-fable-5',
    });
    expect(allowed.status).toBe(200);
    expectMode(configFile, 0o600);
    expectMode(path.dirname(configFile), 0o700);
  });

  it('rejects dashboard requests with a non-loopback Host header', async () => {
    const { base } = await startNode();
    const response = await fetch(`${base}/fragments/models`, {
      method: 'POST',
      headers: {
        host: 'attacker.example',
        origin: 'http://attacker.example',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'list=off',
    });
    expect(response.status).toBe(403);
  });

  it('guards the proxy API against cross-site pages and rebound Hosts', async () => {
    const { base } = await startNode();
    const body = JSON.stringify({ model: 'claude-fable-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
    const post = (headers: Record<string, string>) => fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    // fetch() drops a caller-set Host header, so Host cases go through node:http.
    const withHost = (host: string) => new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/v1/messages`);
      const req = httpRequest({
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(body);
    });
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect(await withHost('evil.example:47821')).toBe(421);
    expect((await post({})).status).toBe(200);
    expect(await withHost('api.anthropic.com')).toBe(200);
  });

  it('creates the event log and containing directory with private permissions', async () => {
    const { base, eventsFile } = await startNode();
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    for (let i = 0; i < 100 && !fs.existsSync(eventsFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expectMode(eventsFile, 0o600);
    expectMode(path.dirname(eventsFile), 0o700);
  });

  it('creates rendered PNG dumps with private permissions', async () => {
    const dumpDir = path.join(os.tmpdir(), `inkling-dumps-${process.pid}-${Date.now()}`);
    const { base } = await startNode({ INKLING_DUMP_DIR: dumpDir });
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 1,
        system: 'Sensitive system context. '.repeat(1000),
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    let files: string[] = [];
    for (let i = 0; i < 100 && files.length === 0; i++) {
      files = fs.readdirSync(dumpDir);
      if (files.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expectMode(dumpDir, 0o700);
    expect(files.length).toBeGreaterThan(0);
    expectMode(path.join(dumpDir, files[0]!), 0o600);
    fs.rmSync(dumpDir, { recursive: true, force: true });
  });
});
