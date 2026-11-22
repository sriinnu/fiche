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
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket, type SecureContext } from 'node:tls';

import type { CertificateAuthority } from './ca.js';
import { hostCouldMatch, matchRoute, rewriteUrl, type Route } from './route.js';

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
  routes: readonly Route[];
  ca: CertificateAuthority;
  /** Called the first time each route diverts a request, for the log. */
  onDivert?: (host: string, path: string, target: string) => void;
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

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
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
  const { routes, ca, onDivert } = options;
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
    let target: URL;
    try {
      normalizedOrigin = new URL(origin);
      resolvedReq = new URL(requestUri, normalizedOrigin);
      if (resolvedReq.origin !== normalizedOrigin.origin) {
        throw new Error('origin mismatch');
      }
      const path = resolvedReq.pathname;
      const normalizedUri = resolvedReq.pathname + resolvedReq.search;
      const route = matchRoute(routes, hostPort, path);
      target = new URL(route ? rewriteUrl(route, normalizedUri) : `${origin}${normalizedUri}`);
      if (route && !announced.has(route.pattern)) {
        announced.add(route.pattern);
        onDivert?.(hostPort, path, target.origin);
      }
    } catch {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('fiche warp: bad request target');
      }
      return;
    }

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const outbound = send({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      // Keep the agent's original Host: the downstream routes (and an upstream
      // may sign) on the vhost, not on wherever we happened to send the bytes.
      headers: forwardHeaders(req.headers),
      setHost: false,
      agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
    });
    outbound.setNoDelay?.(true);

    let upstreamRes: IncomingMessage | undefined;
    const abortDownstream = (err?: Error): void => {
      if (!res.writableEnded && !res.destroyed) {
        res.destroy(err);
      }
    };
    outbound.on('response', (upstream) => {
      upstreamRes = upstream;
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
    });
    outbound.on('error', (err) => {
      if (!req.destroyed) req.destroy?.();
      // Our own teardown below surfaces here as ECONNRESET; the client is
      // already gone, so writing a 502 into it would throw.
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.destroy?.(err);
        return;
      }
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`fiche warp: upstream error: ${err.message}`);
    });
    // An SSE completion only ends when the model stops. If the agent is killed
    // mid-stream nothing else cancels the upstream: the response keeps draining
    // into a dead socket, and the keepAlive agent later hands that same
    // half-consumed connection to the next request.
    const cleanup = () => {
      upstreamRes?.destroy();
      outbound.destroy();
    };
    res.on('close', () => {
      if (res.writableFinished) return;
      cleanup();
    });
    res.on('error', cleanup);
    req.on('error', (err) => {
      if (!outbound.destroyed) outbound.destroy(err);
    });
    req.pipe(outbound);
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
   * Upgrades always go to the real host, never to a route. Route targets speak
   * HTTP, and the control plane behind /remote-control pairing is exactly the
   * traffic that has to stay first-party, so this splices raw TLS instead of
   * re-originating through an HTTP client (which would drop the Upgrade and can
   * never produce a 101).
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
    const upstream = tlsConnect({ host, port: portNum, servername: host }, () => {
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

    if (!hostCouldMatch(routes, authority(host, port))) {
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

    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head?.length) clientSocket.unshift(head);
    // Mint a fallback SecureContext bound to the CONNECT target host so no-SNI
    // clients (e.g., IP literals) still complete the TLS handshake cleanly.
    let fallbackContext: SecureContext;
    try {
      fallbackContext = ca.secureContextFor(host);
    } catch {
      clientSocket.destroy();
      return;
    }
    const tlsSocket = new TLSSocket(clientSocket, {
      isServer: true,
      secureContext: fallbackContext,
      SNICallback: (name, cb) => {
        try {
          cb(null, ca.secureContextFor(name || host));
        } catch (err) {
          cb(err as Error);
        }
      },
      ALPNProtocols: ['http/1.1'],
    });
    connectTargets.set(tlsSocket, { host, port });
    clientSocket.on('error', () => {
      if (!tlsSocket.destroyed) tlsSocket.destroy();
    });
    tlsSocket.on('error', () => {
      if (!tlsSocket.destroyed) tlsSocket.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
    tlsSocket.once('secure', () => {
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
