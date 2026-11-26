/**
 * The CONNECT proxy warp puts in front of the child process.
 *
 * Ported from wardex proxy.go, with two deliberate narrowings:
 *
 *  - wardex decrypts every host once --mitm is on; warp decrypts only hosts a
 *    route could match and blindly tunnels the rest. Under warp the agent
 *    believes it is talking straight to api.anthropic.com, so the less we
 *    terminate, the fewer ways that belief can break.
 *  - wardex owns its listener; warp attaches to the proxy server fiche is
 *    already running. CONNECT is a distinct event from a normal request, so one
 *    port serves both the origin-form traffic fiche handles and the
 *    absolute-form/CONNECT traffic a forward proxy handles.
 */

import {
  Agent as HttpAgent,
  createServer as createHttpServer,
  request as httpRequest,
} from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
  Agent as HttpsAgent,
  request as httpsRequest,
} from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket, type SecureContext } from 'node:tls';

import type { CertificateAuthority } from './ca.js';
import { hostCouldMatch, matchRoute, normalizeRoutePath, rewriteUrl, type Route } from './route.js';

const DNS_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

function isValidSniHost(name: string): boolean {
  if (isIP(name) !== 0) return true;
  return name.length > 0 && name.length <= 253 && DNS_HOST_RE.test(name);
}

function normalizeHostKey(host: string): string {
  const stripped = host.replace(/\.$/, '');
  return isIP(stripped) !== 0 ? stripped : stripped.toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const norm = normalizeHostKey(host);
  return norm === 'localhost' || norm === '::1' || norm.startsWith('127.');
}

const FAIL_OPEN_ERRNO = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
const FAIL_OPEN_CONNECT_TIMEOUT_MS = 1500;
const FAIL_OPEN_REPLAY_CAP_BYTES = 4 * 1024 * 1024;

function isFailOpenError(err: unknown): boolean {
  if (err instanceof AggregateError) {
    return err.errors.length > 0 && err.errors.every((inner) => isFailOpenError(inner));
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && FAIL_OPEN_ERRNO.has(code);
}

/** Canonical Host header value for `protocol` (`https:` omits `:443`, `http:` omits `:80`). */
function canonicalHostHeader(host: string, port: string, protocol: string): string {
  const normHost = normalizeHostKey(host);
  const bracketed = normHost.includes(':') && !normHost.startsWith('[') ? `[${normHost}]` : normHost;
  const isDefaultPort =
    (protocol === 'https:' && port === '443') || (protocol === 'http:' && port === '80');
  return isDefaultPort ? bracketed : `${bracketed}:${port}`;
}

/** Validate client-supplied `Host` header against expected `host:port` (when present). */
function hostHeaderMatches(
  rawHostHeader: string | string[] | undefined,
  expectedHost: string,
  expectedPort: string,
): boolean {
  if (rawHostHeader === undefined) return true;
  if (Array.isArray(rawHostHeader)) return false;
  const trimmed = rawHostHeader.trim();
  if (!trimmed) return false;
  const parsed = splitHostPort(trimmed, expectedPort);
  return normalizeHostKey(parsed.host) === normalizeHostKey(expectedHost) && parsed.port === expectedPort;
}

/**
 * Hop-by-hop headers are meaningful only on a single connection, so they must
 * not be copied onto the re-originated request (RFC 9110 7.6.1).
 */
const HOP_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface WarpHandlerOptions {
  routes: readonly Route[] | (() => readonly Route[]);
  ca: CertificateAuthority;
  /** Called the first time each route diverts a request, for the log. */
  onDivert?: (host: string, path: string, target: string) => void;
  /**
   * When true, a diverted route whose target refuses or resets the TCP connection
   * before response headers arrive transparently retries once directly against
   * the original upstream origin. Defaults to `false`.
   */
  failOpenOnDivertRefused?: boolean;
  /** Per-user loopback token injected as `x-fiche-warp-auth` ONLY on diverted requests to Fiche. */
  warpAuthToken?: string;
  /** Warp proxy's own bound port, used to reject self-proxy loops. */
  selfPort?: number | (() => number | undefined);
}

export interface WarpHandlers {
  /** Attach as the server's 'connect' listener. */
  handleConnect: (req: IncomingMessage, socket: Socket, head: Buffer) => void;
  /** Call from the request handler for absolute-form request targets. */
  handleAbsoluteForm: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * A CONNECT handler reachable off-host is an open relay, and fiche's HOST env
 * var permits a non-loopback bind. The dashboard already refuses non-loopback
 * callers; the proxy duty needs the same guard for the same reason.
 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const lower = address.toLowerCase();
  return (
    lower === '::1' || lower.startsWith('127.') || lower.startsWith('::ffff:127.')
  );
}

function splitHostPort(value: string, fallbackPort: string): { host: string; port: string } {
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return { host: value, port: fallbackPort };
    const rest = value.slice(end + 1);
    return {
      host: value.slice(1, end),
      port: rest.startsWith(':') && rest.length > 1 ? rest.slice(1) : fallbackPort,
    };
  }
  const i = value.lastIndexOf(':');
  if (i < 0) return { host: value, port: fallbackPort };
  return { host: value.slice(0, i), port: value.slice(i + 1) || fallbackPort };
}

function parsePort(port: string): number | null {
  if (!/^\d+$/.test(port)) return null;
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** `host:port`, bracketing IPv6 literals so the result is URL-parseable. */
function authority(host: string, port: string): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function forwardHeaders(
  headers: IncomingHttpHeaders,
  canonicalHost?: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (value === undefined || HOP_HEADERS.has(lower) || lower === 'x-fiche-warp-auth') continue;
    if (canonicalHost !== undefined && lower === 'host') continue;
    out[key] = value;
  }
  if (canonicalHost !== undefined) {
    out.host = canonicalHost;
  }
  return out;
}

function pipeSockets(a: Socket, b: Socket): void {
  a.setNoDelay?.(true);
  b.setNoDelay?.(true);
  a.pipe(b);
  b.pipe(a);
  const destroy = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', destroy);
  b.on('error', destroy);
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
}

/**
 * Every request the agent makes crosses this hop. Node's global agents default
 * to keepAlive:false, so without these each call pays a fresh TCP handshake —
 * plus a full TLS handshake to the real host on the passthrough path.
 */
const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true });

export function createWarpHandlers(options: WarpHandlerOptions): WarpHandlers {
  const { ca, onDivert } = options;
  const getRoutes = (): readonly Route[] =>
    typeof options.routes === 'function' ? options.routes() : options.routes;
  const isSelfLoop = (host: string, portNum: number, socketLocalPort?: number): boolean => {
    if (!isLoopbackHost(host)) return false;
    const configuredSelf =
      typeof options.selfPort === 'function' ? options.selfPort() : options.selfPort;
    if (configuredSelf !== undefined && portNum === configuredSelf) return true;
    if (socketLocalPort !== undefined && portNum === socketLocalPort) return true;
    return false;
  };
  const announced = new Set<string>();

  /** Re-originate one request, to a route target or to the real host. */
  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    /** "host" or "host:port": routes may select on the port. */
    hostPort: string,
    requestUri: string,
    // Where the bytes actually go when no route matches. Passed in rather than
    // rebuilt from `host`: a plain `http://host:8080` request reaching us in
    // absolute form must not be re-originated as `https://host:443`.
    origin: string,
  ) => {
    req.socket?.setNoDelay?.(true);
    res.socket?.setNoDelay?.(true);
    let normalizedOrigin: URL;
    let resolvedReq: URL;
    let path: string;
    let normalizedUri: string;
    let directTarget: URL;
    let divertTarget: URL | null = null;
    try {
      normalizedOrigin = new URL(origin);
      resolvedReq = new URL(requestUri, normalizedOrigin);
      if (resolvedReq.origin !== normalizedOrigin.origin) {
        throw new Error('origin mismatch');
      }
      path = normalizeRoutePath(resolvedReq.pathname);
      normalizedUri = path + resolvedReq.search;
      const route = matchRoute(getRoutes(), hostPort, path);
      directTarget = new URL(`${origin}${normalizedUri}`);
      if (route) {
        divertTarget = new URL(rewriteUrl(route, normalizedUri));
        if (!announced.has(route.pattern)) {
          announced.add(route.pattern);
          onDivert?.(hostPort, path, divertTarget.origin);
        }
      }
    } catch {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('fiche warp: bad request target');
      }
      return;
    }

    const expectedHost = normalizedOrigin.hostname.startsWith('[') && normalizedOrigin.hostname.endsWith(']')
      ? normalizedOrigin.hostname.slice(1, -1)
      : normalizedOrigin.hostname;
    const expectedPort =
      normalizedOrigin.port || (normalizedOrigin.protocol === 'https:' ? '443' : '80');
    if (!hostHeaderMatches(req.headers.host, expectedHost, expectedPort)) {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(421, { 'content-type': 'text/plain' });
        res.end('fiche warp: Misdirected Request');
      }
      return;
    }
    const targetPortNum = parsePort(expectedPort);
    if (targetPortNum !== null && isSelfLoop(expectedHost, targetPortNum, req.socket?.localPort)) {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(508, { 'content-type': 'text/plain' });
        res.end('fiche warp: proxy loop detected');
      }
      return;
    }
    if (divertTarget) {
      const divHost = divertTarget.hostname.startsWith('[') && divertTarget.hostname.endsWith(']')
        ? divertTarget.hostname.slice(1, -1)
        : divertTarget.hostname;
      const divPort = Number(divertTarget.port || (divertTarget.protocol === 'https:' ? 443 : 80));
      if (isSelfLoop(divHost, divPort, req.socket?.localPort)) {
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(508, { 'content-type': 'text/plain' });
          res.end('fiche warp: route self-loop detected');
        }
        return;
      }
    }

    const authoritativeHost = canonicalHostHeader(expectedHost, expectedPort, normalizedOrigin.protocol);

    let activeOutbound: ReturnType<typeof httpRequest> | undefined;
    let activeUpstreamRes: IncomingMessage | undefined;
    let downstreamClosed = false;
    let responseStarted = false;

    const cleanupActive = () => {
      downstreamClosed = true;
      activeUpstreamRes?.destroy();
      activeOutbound?.destroy();
    };
    res.on('close', () => {
      if (res.writableFinished) return;
      cleanupActive();
    });
    res.on('error', cleanupActive);
    req.on('error', (err) => {
      downstreamClosed = true;
      if (activeOutbound && !activeOutbound.destroyed) activeOutbound.destroy(err);
    });

    const abortDownstream = (err?: Error): void => {
      if (!res.writableEnded && !res.destroyed) {
        res.destroy(err);
      }
    };

    const allowInitialFailOpen = Boolean(divertTarget && options.failOpenOnDivertRefused);
    const bufferedChunks: Buffer[] = [];
    let bufferedBytes = 0;
    let bufferOverflowed = false;
    let reqStreamEnded = Boolean(req.readableEnded);
    let activeSink: ReturnType<typeof httpRequest> | undefined;

    if (allowInitialFailOpen) {
      req.on('data', (chunk: Buffer) => {
        if (downstreamClosed) return;
        if (!responseStarted && !bufferOverflowed) {
          if (bufferedBytes + chunk.byteLength <= FAIL_OPEN_REPLAY_CAP_BYTES) {
            bufferedChunks.push(chunk);
            bufferedBytes += chunk.byteLength;
          } else {
            bufferOverflowed = true;
            bufferedChunks.length = 0;
          }
        }
        if (activeSink && !activeSink.destroyed && !activeSink.writableEnded) {
          const ok = activeSink.write(chunk);
          if (!ok && bufferOverflowed) req.pause?.();
        }
      });
      req.on('end', () => {
        reqStreamEnded = true;
        if (activeSink && !activeSink.destroyed && !activeSink.writableEnded) {
          activeSink.end();
        }
      });
    }

    const sendToTarget = (target: URL, allowFailOpen: boolean, isDivert: boolean): void => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const hostname =
        target.hostname.startsWith('[') && target.hostname.endsWith(']')
          ? target.hostname.slice(1, -1)
          : target.hostname;
      const outHeaders = forwardHeaders(req.headers, authoritativeHost);
      if (isDivert && options.warpAuthToken) {
        outHeaders['x-fiche-warp-auth'] = options.warpAuthToken;
      }
      if (allowFailOpen) {
        req.pause?.();
      }
      const outbound = send({
        protocol: target.protocol,
        hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: target.pathname + target.search,
        // Keep the authoritative Host (stripped of default :443/:80) so downstream
        // routes on the vhost rather than the divert loopback port.
        headers: outHeaders,
        setHost: false,
        agent: allowFailOpen ? false : (target.protocol === 'https:' ? httpsAgent : httpAgent),
      });
      activeOutbound = outbound;
      outbound.setNoDelay?.(true);

      let piped = false;
      let retried = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const clearConnectTimer = () => {
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
      };

      const startPipe = () => {
        clearConnectTimer();
        if (piped || downstreamClosed || outbound.destroyed) return;
        piped = true;
        if (allowInitialFailOpen) {
          activeSink = outbound;
          for (const chunk of bufferedChunks) {
            if (outbound.destroyed || outbound.writableEnded) break;
            outbound.write(chunk);
          }
          if (reqStreamEnded) {
            if (!outbound.destroyed && !outbound.writableEnded) outbound.end();
          } else {
            outbound.on('drain', () => {
              if (!downstreamClosed) req.resume?.();
            });
            req.resume?.();
          }
          return;
        }
        if (req.readableEnded) outbound.end();
        else req.pipe(outbound);
      };

      const onResponse = (upstream: IncomingMessage) => {
        clearConnectTimer();
        responseStarted = true;
        bufferedChunks.length = 0;
        activeUpstreamRes = upstream;
        upstream.socket?.setNoDelay?.(true);
        upstream.on('error', abortDownstream);
        upstream.on('aborted', () => abortDownstream());
        upstream.on('close', () => {
          if (!upstream.complete) abortDownstream();
        });
        res.writeHead(upstream.statusCode ?? 502, forwardHeaders(upstream.headers));
        res.flushHeaders?.();
        // Streamed, never buffered: /v1/messages is SSE and must arrive token by
        // token or the agent appears to hang until the response completes.
        upstream.pipe(res);
      };

      const onError = (err: Error) => {
        clearConnectTimer();
        if (
          allowFailOpen
          && !retried
          && !responseStarted
          && !bufferOverflowed
          && !downstreamClosed
          && !res.headersSent
          && !res.writableEnded
          && !res.destroyed
          && isFailOpenError(err)
        ) {
          retried = true;
          if (activeSink === outbound) activeSink = undefined;
          outbound.off('response', onResponse);
          outbound.off('error', onError);
          outbound.on('error', () => {});
          if (!outbound.destroyed) outbound.destroy();
          const failKey = `${hostPort}${path}:failopen`;
          if (!announced.has(failKey)) {
            announced.add(failKey);
            if (!process.stdout.isTTY) {
              console.error(`[fiche] warp: ${target.origin} failed (${hostPort}${path}) — failing open direct`);
            }
          }
          sendToTarget(directTarget, false, false);
          return;
        }
        bufferedChunks.length = 0;
        if (!req.destroyed) req.destroy?.();
        // Our own teardown below surfaces here as ECONNRESET; the client is
        // already gone, so writing a 502 into it would throw.
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) {
          res.destroy?.(err);
          return;
        }
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('fiche warp: upstream error');
      };

      outbound.on('response', onResponse);
      outbound.on('error', onError);
      outbound.once('close', clearConnectTimer);

      if (allowFailOpen) {
        outbound.once('socket', (sock) => {
          if (!sock.connecting) {
            startPipe();
          } else {
            connectTimer = setTimeout(() => {
              connectTimer = undefined;
              const timeoutErr = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
              outbound.destroy(timeoutErr);
            }, FAIL_OPEN_CONNECT_TIMEOUT_MS);
            connectTimer.unref?.();
            sock.once('connect', startPipe);
          }
        });
      } else {
        startPipe();
      }
    };

    const initialTarget = divertTarget ?? directTarget;
    sendToTarget(initialTarget, allowInitialFailOpen, Boolean(divertTarget));
  };

  const connectTargets = new WeakMap<Socket, { host: string; port: string }>();
  const PROXY_ONLY_UPGRADE_HEADERS = new Set([
    'proxy-authorization',
    'proxy-connection',
    'proxy-authenticate',
  ]);

  const handleDecrypted = (req: IncomingMessage, res: ServerResponse): void => {
    const bound = connectTargets.get(req.socket);
    const servername = (req.socket as TLSSocket).servername || '';
    // Prefer the authoritative CONNECT authority over the HTTP Host header so
    // an inner request cannot domain-front across an already-established tunnel.
    const { host, port } = bound ?? splitHostPort(servername || req.headers.host || '', '443');
    forward(req, res, authority(host, port), req.url ?? '/', `https://${authority(host, port)}`);
  };

  /**
   * Unmatched upgrades (such as Claude Code `/remote-control` or ChatGPT UI
   * sockets) splice directly to the real host so first-party pairing stays
   * intact. WebSocket upgrades on a *matched* HTTP-diverted route (such as
   * `chatgpt.com/backend-api/codex/responses*` or `api.openai.com/v1/responses*`)
   * return `426 Upgrade Required` (`websocket_unsupported`, matching `proxy.ts`),
   * telling Codex to switch immediately to HTTP POST through Fiche.
   */
  const handleUpgrade = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    const bound = connectTargets.get(req.socket) ?? connectTargets.get(clientSocket);
    const servername = (req.socket as TLSSocket).servername || '';
    const { host, port } = bound ?? splitHostPort(servername || req.headers.host || '', '443');
    const portNum = parsePort(port);
    if (!host || portNum === null) {
      clientSocket.destroy();
      return;
    }
    if (String(req.headers.upgrade ?? '').toLowerCase().includes('websocket')) {
      try {
        const hostPort = authority(host, port);
        if (!hostHeaderMatches(req.headers.host, host, port)) {
          clientSocket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
          return;
        }
        const resolved = new URL(req.url ?? '/', `https://${hostPort}`);
        const reqPath = normalizeRoutePath(resolved.pathname);
        if (matchRoute(getRoutes(), hostPort, reqPath)) {
          const body = JSON.stringify({
            error: {
              type: 'websocket_unsupported',
              message: 'fiche proxies HTTP only; retry over HTTP',
            },
          });
          clientSocket.end(
            'HTTP/1.1 426 Upgrade Required\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Connection: close\r\n\r\n' +
            body,
          );
          return;
        }
      } catch {
        clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
    }
    const upstream = tlsConnect(
      { host, port: portNum, servername: isIP(host) !== 0 ? undefined : host },
      () => {
      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (PROXY_ONLY_UPGRADE_HEADERS.has(key.toLowerCase())) continue;
        for (const v of Array.isArray(value) ? value : [value]) {
          if (v !== undefined) lines.push(`${key}: ${v}`);
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      pipeSockets(clientSocket, upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.once('close', () => {
      if (!upstream.destroyed) upstream.destroy();
    });
  };

  // Non-listening HTTP parser fed per-CONNECT TLSSockets once TLS handshake completes.
  const decryptedServer = createHttpServer();
  decryptedServer.on('request', handleDecrypted);
  decryptedServer.on('upgrade', handleUpgrade);
  decryptedServer.on('clientError', (_err, socket) => socket.destroy());

  const handleConnect = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    clientSocket.setNoDelay?.(true);
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const { host, port } = splitHostPort(req.url ?? '', '443');
    const portNum = parsePort(port);
    if (!host || portNum === null) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (isSelfLoop(host, portNum, req.socket?.localPort)) {
      clientSocket.end('HTTP/1.1 508 Loop Detected\r\n\r\n');
      return;
    }

    if (!hostCouldMatch(getRoutes(), authority(host, port))) {
      const upstream = netConnect({ host, port: portNum }, () => {
        if (clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (head?.length) upstream.write(head);
        pipeSockets(clientSocket, upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.once('close', () => {
        if (!upstream.destroyed) upstream.destroy();
      });
      return;
    }

    // Mint a fallback SecureContext bound to the CONNECT target host before replying 200
    // so no-SNI clients (e.g., IP literals) complete TLS cleanly and failures return 502.
    let fallbackContext: SecureContext;
    try {
      fallbackContext = ca.secureContextFor(host);
    } catch {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head?.length) clientSocket.unshift(head);

    const hostNorm = normalizeHostKey(host);
    const hostIsIp = isIP(hostNorm) !== 0;
    const tlsSocket = new TLSSocket(clientSocket, {
      isServer: true,
      secureContext: fallbackContext,
      SNICallback: (name, cb) => {
        try {
          if (!name) {
            cb(null, fallbackContext);
            return;
          }
          if (!isValidSniHost(name)) {
            cb(new Error('invalid SNI hostname'));
            return;
          }
          const sniNorm = normalizeHostKey(name);
          if (!hostIsIp) {
            if (sniNorm !== hostNorm) {
              cb(new Error('SNI mismatch with CONNECT target'));
              return;
            }
          } else if (sniNorm !== hostNorm && !hostCouldMatch(getRoutes(), authority(sniNorm, port))) {
            cb(new Error('SNI not permitted for IP CONNECT target'));
            return;
          }
          cb(null, ca.secureContextFor(sniNorm));
        } catch (err) {
          cb(err as Error);
        }
      },
      ALPNProtocols: ['http/1.1'],
    });
    connectTargets.set(tlsSocket, { host, port });
    const handshakeTimer = setTimeout(() => {
      if (!tlsSocket.destroyed) tlsSocket.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    }, 30_000);
    handshakeTimer.unref();
    const clearHandshakeTimer = () => clearTimeout(handshakeTimer);
    clientSocket.on('error', () => {
      clearHandshakeTimer();
      if (!tlsSocket.destroyed) tlsSocket.destroy();
    });
    tlsSocket.on('error', () => {
      clearHandshakeTimer();
      if (!tlsSocket.destroyed) tlsSocket.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
    tlsSocket.once('close', clearHandshakeTimer);
    tlsSocket.once('secure', () => {
      clearHandshakeTimer();
      if (!tlsSocket.destroyed) decryptedServer.emit('connection', tlsSocket);
    });
  };

  const handleAbsoluteForm = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('fiche warp: forward proxy is loopback-only');
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('fiche warp: bad absolute URI');
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('fiche warp: unsupported scheme');
      return;
    }
    // A pattern that names a port is matched against "host:port", and the
    // CONNECT path always supplies one via authority(host, port) — but
    // URL.host omits a DEFAULT port, so `api.anthropic.com:443/v1/*` matched
    // a CONNECT and then silently missed the very same request in absolute
    // form. Put the implied port back so both paths hand matchRoute the same
    // authority. target.host already brackets an IPv6 literal and already
    // carries a non-default port, so it only ever needs the default appended.
    const hostPort = target.port
      ? target.host
      : `${target.host}:${target.protocol === 'https:' ? 443 : 80}`;
    // target.origin, not a rebuilt https:// URL: scheme and non-default port
    // are part of where this request was actually going.
    forward(req, res, hostPort, target.pathname + target.search, target.origin);
  };

  return { handleConnect, handleAbsoluteForm };
}
