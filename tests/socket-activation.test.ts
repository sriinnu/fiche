import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveInheritedListenFd, SD_LISTEN_FDS_START } from '../src/launchd-socket.js';
import { mergeNoProxy } from '../src/warp/index.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_NODE_PATH = path.join(REPO_ROOT, 'dist', 'node.js');
const HAS_DARWIN_LAUNCHD =
  process.platform === 'darwin'
  && fs.existsSync('/usr/bin/cc')
  && fs.existsSync('/bin/launchctl');

function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('unexpected address family')));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpJsonRequest(opts: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        agent: false,
        headers: {
          connection: 'close',
          ...(opts.body ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}),
          ...opts.headers,
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const json = JSON.parse(text) as Record<string, unknown>;
            resolve({ status: res.statusCode ?? 0, json });
          } catch (err) {
            reject(new Error(`invalid JSON response (${res.statusCode}): ${text} (${(err as Error).message})`));
          }
        });
      },
    );
    req.once('timeout', () => {
      req.destroy(new Error(`request timed out after ${opts.timeoutMs}ms`));
    });
    req.once('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('socket activation helpers', () => {
  it('resolves fd 3 only when LISTEN_PID matches and LISTEN_FDS >= 1', () => {
    expect(resolveInheritedListenFd({ LISTEN_PID: '4242', LISTEN_FDS: '1' }, 4242)).toBe(SD_LISTEN_FDS_START);
    expect(resolveInheritedListenFd({ LISTEN_PID: ' 4242 ', LISTEN_FDS: ' 3 ' }, 4242)).toBe(3);
    expect(resolveInheritedListenFd({ LISTEN_PID: '9999', LISTEN_FDS: '1' }, 4242)).toBeNull();
    expect(resolveInheritedListenFd({ LISTEN_PID: '4242', LISTEN_FDS: '0' }, 4242)).toBeNull();
    expect(resolveInheritedListenFd({ LISTEN_PID: '4242', LISTEN_FDS: '-1' }, 4242)).toBeNull();
    expect(resolveInheritedListenFd({ LISTEN_PID: 'abc', LISTEN_FDS: '1' }, 4242)).toBeNull();
    expect(resolveInheritedListenFd({}, 4242)).toBeNull();
  });

  it('merges loopback hosts into NO_PROXY without dropping existing entries', () => {
    expect(mergeNoProxy(undefined)).toBe('localhost,127.0.0.1,::1');
    expect(mergeNoProxy('')).toBe('localhost,127.0.0.1,::1');
    expect(mergeNoProxy('corp.internal,10.0.0.0/8')).toBe('corp.internal,10.0.0.0/8,localhost,127.0.0.1,::1');
    expect(mergeNoProxy('LOCALHOST,corp.internal,[::1]')).toBe('LOCALHOST,corp.internal,[::1],127.0.0.1');
  });

  it('service install --dry-run --json renders socket-activated plist with zero disk writes', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-dryrun-'));
    try {
      const label = `com.sriinnu.fiche.dryrun.${process.pid}`;
      const plistPath = path.join(tmpHome, 'Library', 'LaunchAgents', `${label}.plist`);
      const stdout = execFileSync(
        process.execPath,
        [DIST_NODE_PATH, 'service', 'install', '--dry-run', '--json'],
        {
          env: {
            ...process.env,
            HOME: tmpHome,
            FICHE_SERVICE_LABEL: label,
            FICHE_PLIST_PATH: plistPath,
            PORT: '49111',
            HOST: '127.0.0.1',
            FICHE_LOG: path.join(tmpHome, 'events.jsonl'),
            FICHE_CONFIG: path.join(tmpHome, 'config.json'),
          },
          encoding: 'utf8',
        },
      );
      const parsed = JSON.parse(stdout) as {
        ok: boolean;
        dry_run: boolean;
        label: string;
        socket_activated: boolean;
        plist_installed: boolean;
        plist_path: string;
        plist_xml: string;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.label).toBe(label);
      expect(parsed.plist_installed).toBe(false);
      expect(parsed.plist_path).toBe(plistPath);
      expect(parsed.plist_xml).toContain(`<string>${label}</string>`);
      expect(parsed.plist_xml).toContain('<key>ThrottleInterval</key>\n  <integer>1</integer>');
      expect(parsed.plist_xml).toContain('<key>ExitTimeOut</key>\n  <integer>65</integer>');
      if (HAS_DARWIN_LAUNCHD) {
        expect(parsed.socket_activated).toBe(true);
        expect(parsed.plist_xml).toContain('<key>Sockets</key>');
        expect(parsed.plist_xml).toContain('<key>Listeners</key>');
        expect(parsed.plist_xml).toContain('<key>SockNodeName</key>\n      <string>127.0.0.1</string>');
        expect(parsed.plist_xml).toContain('<key>SockServiceName</key>\n      <string>49111</string>');
        expect(parsed.plist_xml).toContain('fiche-launchd-exec');
      }
      // Strict dry-run invariant: zero disk writes.
      expect(fs.existsSync(plistPath)).toBe(false);
      expect(fs.existsSync(path.join(tmpHome, '.fiche'))).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('macOS launchd socket activation', () => {
  it.runIf(HAS_DARWIN_LAUNCHD)(
    'keeps listening socket open with zero ECONNREFUSED across repeated service restarts',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-launchd-e2e-'));
      const label = `com.sriinnu.fiche.test.${process.pid}.${Date.now()}`;
      const plistPath = path.join(tmpDir, 'Library', 'LaunchAgents', `${label}.plist`);

      const upstream = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'msg_test_sa',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 12, output_tokens: 2 },
              }),
            );
          }, 30);
        });
      });

      await new Promise<void>((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(0, '127.0.0.1', () => resolve());
      });

      const upstreamAddr = upstream.address();
      if (!upstreamAddr || typeof upstreamAddr === 'string') {
        upstream.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error('upstream server failed to bind ephemeral port');
      }

      const proxyPort = await reserveEphemeralPort();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: tmpDir,
        FICHE_SERVICE_LABEL: label,
        FICHE_PLIST_PATH: plistPath,
        PORT: String(proxyPort),
        HOST: '127.0.0.1',
        FICHE_LOG: path.join(tmpDir, 'events.jsonl'),
        FICHE_CONFIG: path.join(tmpDir, 'config.json'),
        FICHE_SESSION_STATE: 'off',
        FICHE_MODELS: 'off',
        FICHE_SHUTDOWN_DRAIN_MS: '1500',
        ANTHROPIC_UPSTREAM: `http://127.0.0.1:${upstreamAddr.port}`,
      };

      let running = true;
      let healthTimer: NodeJS.Timeout | undefined;
      let messagesTimer: NodeJS.Timeout | undefined;
      const inFlight = new Set<Promise<void>>();

      try {
        const installOut = await execFileAsync(
          process.execPath,
          [DIST_NODE_PATH, 'service', 'install', '--json'],
          { env, encoding: 'utf8' },
        );
        const installJson = JSON.parse(installOut.stdout) as {
          ok: boolean;
          socket_activated: boolean;
          running: boolean;
          pid: number | null;
        };
        expect(installJson.ok).toBe(true);
        expect(installJson.socket_activated).toBe(true);
        expect(installJson.running).toBe(true);
        expect(typeof installJson.pid).toBe('number');

        let refused = 0;
        let failedRequests = 0;
        let healthOk = 0;
        let messagesOk = 0;
        let messageSeq = 0;
        const errors: string[] = [];
        const observedPids = new Set<number>();

        const track = (promise: Promise<void>) => {
          inFlight.add(promise);
          void promise.finally(() => inFlight.delete(promise));
        };

        const fireHealth = () => {
          if (!running) return;
          track(
            httpJsonRequest({
              port: proxyPort,
              method: 'GET',
              path: '/api/health',
              timeoutMs: 5000,
            })
              .then((res) => {
                if (res.status !== 200) {
                  failedRequests++;
                  errors.push(`health HTTP ${res.status}`);
                  return;
                }
                healthOk++;
                if (typeof res.json.pid === 'number') {
                  observedPids.add(res.json.pid);
                }
              })
              .catch((err: unknown) => {
                const code = (err as NodeJS.ErrnoException)?.code;
                if (code === 'ECONNREFUSED') refused++;
                failedRequests++;
                errors.push(`health err (${code ?? 'unknown'}): ${(err as Error).message}`);
              }),
          );
        };

        const fireMessage = () => {
          if (!running) return;
          const seq = ++messageSeq;
          const payload = JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 16,
            messages: [{ role: 'user', content: `ping-${seq}` }],
          });
          track(
            httpJsonRequest({
              port: proxyPort,
              method: 'POST',
              path: '/v1/messages',
              body: payload,
              headers: {
                'content-type': 'application/json',
                'x-api-key': 'sk-ant-test',
                'anthropic-version': '2023-06-01',
              },
              timeoutMs: 6000,
            })
              .then((res) => {
                if (res.status !== 200 || res.json.type !== 'message') {
                  failedRequests++;
                  errors.push(`messages HTTP ${res.status}`);
                  return;
                }
                messagesOk++;
              })
              .catch((err: unknown) => {
                const code = (err as NodeJS.ErrnoException)?.code;
                if (code === 'ECONNREFUSED') refused++;
                failedRequests++;
                errors.push(`messages err (${code ?? 'unknown'}): ${(err as Error).message}`);
              }),
          );
        };

        // Keep total churn (~30 brand-new TCP conn/s) inside macOS kern.ipc.somaxconn=128
        // across launchd ThrottleInterval:1 (~2s) back-to-back restarts.
        healthTimer = setInterval(fireHealth, 50);
        messagesTimer = setInterval(fireMessage, 100);
        await new Promise((r) => setTimeout(r, 150));

        const restart1Out = await execFileAsync(
          process.execPath,
          [DIST_NODE_PATH, 'service', 'restart', '--json'],
          { env, encoding: 'utf8' },
        );
        const restart1Json = JSON.parse(restart1Out.stdout) as { ok: boolean; pid: number | null };
        expect(restart1Json.ok).toBe(true);
        expect(restart1Json.pid).not.toBeNull();
        expect(restart1Json.pid).not.toBe(installJson.pid);

        await new Promise((r) => setTimeout(r, 150));

        const restart2Out = await execFileAsync(
          process.execPath,
          [DIST_NODE_PATH, 'service', 'restart', '--json'],
          { env, encoding: 'utf8' },
        );
        const restart2Json = JSON.parse(restart2Out.stdout) as { ok: boolean; pid: number | null };
        expect(restart2Json.ok).toBe(true);
        expect(restart2Json.pid).not.toBeNull();
        expect(restart2Json.pid).not.toBe(restart1Json.pid);

        await new Promise((r) => setTimeout(r, 150));

        running = false;
        clearInterval(healthTimer);
        clearInterval(messagesTimer);
        await Promise.allSettled([...inFlight]);

        expect(errors).toEqual([]);
        expect(refused).toBe(0);
        expect(failedRequests).toBe(0);
        expect(healthOk).toBeGreaterThanOrEqual(10);
        expect(messagesOk).toBeGreaterThanOrEqual(4);
        expect(observedPids.size).toBeGreaterThanOrEqual(2);
      } finally {
        running = false;
        if (healthTimer) clearInterval(healthTimer);
        if (messagesTimer) clearInterval(messagesTimer);
        await Promise.allSettled([...inFlight]);
        try {
          await execFileAsync(
            process.execPath,
            [DIST_NODE_PATH, 'service', 'uninstall', '--json'],
            { env, encoding: 'utf8' },
          );
        } catch {
          // Best-effort uninstall in finally
        }
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
