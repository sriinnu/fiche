import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let child: ChildProcess | undefined;
let upstream: Server | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  }
  child = undefined;
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('Zero-drop graceful SSE drain and launchd plist', () => {
  it('exposes active_requests on /api/health and lets a >2.1s SSE stream finish cleanly across SIGTERM', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-drain-'));
    const port = await freePort();
    const upstreamPort = await freePort();

    let sendSecondChunk!: () => void;
    upstream = createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      );
      sendSecondChunk = () => {
        res.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"survived-sigterm"}}\n\n',
        );
        res.write(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        );
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      };
    });
    await new Promise<void>((resolve) => upstream!.listen(upstreamPort, '127.0.0.1', resolve));

    const eventsFile = path.join(tmpDir, 'events.jsonl');
    const configFile = path.join(tmpDir, 'config.json');
    child = spawn(process.execPath, [tsxCli, 'src/node.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        FICHE_LOG: eventsFile,
        FICHE_CONFIG: configFile,
        FICHE_SESSION_STATE: 'off',
        FICHE_MODELS: 'claude-fable-5',
        FICHE_SHUTDOWN_DRAIN_MS: '10000',
        ANTHROPIC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs: string[] = [];
    child.stdout?.on('data', (d) => logs.push(String(d)));
    child.stderr?.on('data', (d) => logs.push(String(d)));

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(logs.join(''))), 20_000);
      const poll = () => {
        if (logs.join('').includes('[fiche] listening on')) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        if (child?.exitCode !== null) {
          clearTimeout(deadline);
          reject(new Error(logs.join('')));
          return;
        }
        setTimeout(poll, 15);
      };
      poll();
    });

    const base = `http://127.0.0.1:${port}`;
    const idleHealth = (await (await fetch(`${base}/api/health`)).json()) as {
      active_requests: number;
    };
    expect(idleHealth.active_requests).toBe(0);

    const streamRes = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(streamRes.status).toBe(200);

    const reader = streamRes.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    const activeHealth = (await (await fetch(`${base}/api/health`)).json()) as {
      active_requests: number;
    };
    expect(activeHealth.active_requests).toBe(1);

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child!.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );

    child.kill('SIGTERM');

    // Wait > 2100 ms (past the old 1500 ms hard closeAllConnections deadline) while streaming.
    await new Promise((r) => setTimeout(r, 2100));
    expect(child.exitCode).toBeNull();

    sendSecondChunk();

    const chunks: Uint8Array[] = [first.value!];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value) chunks.push(next.value);
    }
    const fullSse = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    expect(fullSse).toContain('survived-sigterm');
    expect(fullSse).toContain('message_stop');

    const exit = await exitPromise;
    expect(exit.code).toBe(0);
    expect(logs.join('')).toContain('draining 1 active request(s)');
  }, 30_000);

  it('continues draining active SSE stream when POST /api/shutdown is followed immediately by SIGTERM', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-bootout-drain-'));
    const port = await freePort();
    const upstreamPort = await freePort();

    let sendSecondChunk!: () => void;
    upstream = createServer((req, res) => {
      req.resume();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      );
      sendSecondChunk = () => {
        res.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"survived-bootout-sigterm"}}\n\n',
        );
        res.write(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        );
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      };
    });
    await new Promise<void>((resolve) => upstream!.listen(upstreamPort, '127.0.0.1', resolve));

    const eventsFile = path.join(tmpDir, 'events.jsonl');
    const configFile = path.join(tmpDir, 'config.json');
    child = spawn(process.execPath, [tsxCli, 'src/node.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        FICHE_LOG: eventsFile,
        FICHE_CONFIG: configFile,
        FICHE_SESSION_STATE: 'off',
        FICHE_MODELS: 'claude-fable-5',
        FICHE_SHUTDOWN_DRAIN_MS: '10000',
        ANTHROPIC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs: string[] = [];
    child.stdout?.on('data', (d) => logs.push(String(d)));
    child.stderr?.on('data', (d) => logs.push(String(d)));

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(logs.join(''))), 20_000);
      const poll = () => {
        if (logs.join('').includes('[fiche] listening on')) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        if (child?.exitCode !== null) {
          clearTimeout(deadline);
          reject(new Error(logs.join('')));
          return;
        }
        setTimeout(poll, 15);
      };
      poll();
    });

    const base = `http://127.0.0.1:${port}`;
    const streamRes = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(streamRes.status).toBe(200);

    const reader = streamRes.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child!.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );

    const shutdownRes = await fetch(`${base}/api/shutdown`, { method: 'POST' });
    await shutdownRes.body?.cancel();
    // Simulate immediate `launchctl bootout` SIGTERM while API_SHUTDOWN drain is active.
    child.kill('SIGTERM');

    await new Promise((r) => setTimeout(r, 650));
    expect(child.exitCode).toBeNull();

    sendSecondChunk();

    const chunks: Uint8Array[] = [first.value!];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value) chunks.push(next.value);
    }
    const fullSse = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    expect(fullSse).toContain('survived-bootout-sigterm');
    expect(fullSse).toContain('message_stop');

    const exit = await exitPromise;
    expect(exit.code).toBe(0);
    expect(logs.join('')).toContain('SIGTERM received during API_SHUTDOWN drain — continuing graceful drain');
  }, 30_000);

  it('includes ExitTimeOut 65 in generated launchd plist for graceful draining', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-plist-'));
    const { stdout } = await execFileAsync(
      process.execPath,
      [tsxCli, 'src/node.ts', 'service', 'install', '--dry-run', '--json'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FICHE_PLIST_PATH: path.join(tmpDir, 'com.sriinnu.fiche.plist'),
          FICHE_SERVICE_NO_LAUNCHCTL: '1',
        },
      },
    );
    const parsed = JSON.parse(stdout) as { ok: boolean; plist_xml: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.plist_xml).toContain('<key>ExitTimeOut</key>');
    expect(parsed.plist_xml).toContain('<integer>65</integer>');
  }, 20_000);
});
