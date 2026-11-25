/**
 * Node HTTP/1.1 keep-alive `fetch` implementation for upstream proxy calls.
 *
 * Homebrew Node v26.13.1 bundles undici v8.12.4, whose HTTP/2 idle reaper
 * (`onHttp2SessionIdleTimeout`, nodejs/undici#6143) passes `InformationalError`
 * into `util.destroy(socket, err)` and crashes the process on lingering
 * `ClientHttp2Stream` handles after aborted fetches. Using `node:http` and
 * `node:https` keep-alive agents avoids HTTP/2 transport altogether while
 * enforcing explicit stream error handlers, pull-based backpressure, and prompt
 * upstream teardown on client disconnect or `AbortSignal`.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type { Readable } from 'node:stream';
import * as zlib from 'node:zlib';

export interface NodeUpstreamFetchOptions {
  /** Initial TCP keep-alive probe delay in ms (default 1000). */
  keepAliveMsecs?: number;
  /** Maximum concurrent sockets per upstream host:port (default 256). */
  maxSockets?: number;
  /** Idle socket pool timeout in ms before closing unused keep-alive sockets. */
  keepAliveTimeout?: number;
  /** Verify TLS certificates upstream (default true). */
  rejectUnauthorized?: boolean;
  /** Optional trusted CA certificate(s) appended to TLS verification. */
  ca?: string | Buffer | Array<string | Buffer>;
}

export interface NodeUpstreamFetch {
  fetch: typeof globalThis.fetch;
  destroy: () => void;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' && reason.length > 0 ? reason : 'The operation was aborted.',
    'AbortError',
  );
}

function isReadableStreamBody(body: unknown): body is ReadableStream<Uint8Array> {
  return (
    typeof body === 'object'
    && body !== null
    && typeof (body as { getReader?: unknown }).getReader === 'function'
  );
}

function resolveBufferedBody(body: BodyInit): Uint8Array | string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError('Unsupported request body type for Node upstream fetch');
}

function createDecompressStream(contentEncoding: string): {
  stream: Readable & NodeJS.ReadWriteStream;
  decompressed: boolean;
} | null {
  const coding = contentEncoding.trim().toLowerCase();
  if (!coding || coding === 'identity') return null;
  if (coding === 'gzip' || coding === 'x-gzip') {
    return {
      stream: zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH }),
      decompressed: true,
    };
  }
  if (coding === 'deflate') {
    return {
      stream: zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH }),
      decompressed: true,
    };
  }
  if (coding === 'br') {
    return {
      stream: zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH }),
      decompressed: true,
    };
  }
  const createZstd = (zlib as unknown as {
    createZstdDecompress?: () => Readable & NodeJS.ReadWriteStream;
  }).createZstdDecompress;
  if (coding === 'zstd' && typeof createZstd === 'function') {
    return {
      stream: createZstd(),
      decompressed: true,
    };
  }
  return null;
}

function waitForRequestDrain(
  req: http.ClientRequest,
  isAborted: () => boolean,
): Promise<void> {
  if (isAborted() || req.destroyed || req.writableEnded) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      req.off('drain', onDrain);
      req.off('close', onClose);
      req.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    req.once('drain', onDrain);
    req.once('close', onClose);
    req.once('error', onError);
  });
}

function toIncomingHeaders(rawHeaders: http.IncomingHttpHeaders, dropEncodingHeaders: boolean): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (dropEncodingHeaders && (lower === 'content-encoding' || lower === 'content-length')) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        try {
          out.append(key, item);
        } catch {
          // Ignore header values rejected by undici Web Headers validation.
        }
      }
    } else {
      try {
        out.append(key, value);
      } catch {
        // Ignore header values rejected by undici Web Headers validation.
      }
    }
  }
  return out;
}

/**
 * Create a Web `fetch`-compatible function backed by dedicated HTTP/1.1
 * `node:http` and `node:https` keep-alive agents.
 */
export function createNodeUpstreamFetch(
  options: NodeUpstreamFetchOptions = {},
): NodeUpstreamFetch {
  const keepAliveMsecs = options.keepAliveMsecs ?? 1000;
  const maxSockets = options.maxSockets ?? 256;
  const keepAliveTimeout = options.keepAliveTimeout;
  const rejectUnauthorized = options.rejectUnauthorized ?? true;

  const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs,
    maxSockets,
    ...(keepAliveTimeout !== undefined ? { keepAliveTimeout } : {}),
  });
  const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs,
    maxSockets,
    rejectUnauthorized,
    ...(options.ca !== undefined ? { ca: options.ca } : {}),
    ...(keepAliveTimeout !== undefined ? { keepAliveTimeout } : {}),
  });

  const nodeFetch: typeof globalThis.fetch = (input, init) => {
    const reqObj = input instanceof Request ? input : null;
    const urlStr = reqObj ? reqObj.url : input instanceof URL ? input.href : String(input);
    const targetUrl = new URL(urlStr);
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return Promise.reject(new TypeError(`Unsupported protocol: ${targetUrl.protocol}`));
    }

    const method = (init?.method ?? reqObj?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? reqObj?.headers);
    if (!headers.has('accept-encoding')) {
      headers.set('accept-encoding', 'gzip, deflate, br');
    }

    const signal = init?.signal ?? reqObj?.signal;
    if (signal?.aborted) {
      return Promise.reject(toAbortError(signal.reason));
    }

    const outgoingHeaders: http.OutgoingHttpHeaders = {};
    headers.forEach((value, key) => {
      outgoingHeaders[key] = value;
    });

    const rawBody = init?.body !== undefined ? init.body : reqObj?.body ?? null;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      let aborted = false;
      let activeIncoming: http.IncomingMessage | undefined;
      let activeDecoder: (Readable & NodeJS.ReadWriteStream) | undefined;
      let activeBodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let activeStreamEnded = false;
      let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      const noop = () => {};

      const cleanupAbortListener = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      const isHttps = targetUrl.protocol === 'https:';
      const requestFn = isHttps ? https.request : http.request;
      const defaultPort = isHttps ? 443 : 80;
      const hostname =
        targetUrl.hostname.startsWith('[') && targetUrl.hostname.endsWith(']')
          ? targetUrl.hostname.slice(1, -1)
          : targetUrl.hostname;

      const clientReq = requestFn({
        protocol: targetUrl.protocol,
        hostname,
        port: targetUrl.port ? Number(targetUrl.port) : defaultPort,
        method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: outgoingHeaders,
        agent: isHttps ? httpsAgent : httpAgent,
      });

      const tearDownStreams = (err?: Error) => {
        if (bodyReader) {
          void bodyReader.cancel(err).catch(() => undefined);
          bodyReader = undefined;
        }
        if (activeDecoder && !activeDecoder.destroyed) {
          activeDecoder.destroy(err);
        }
        if (activeIncoming && !activeIncoming.destroyed) {
          activeIncoming.destroy(err);
        }
        if (!clientReq.destroyed) {
          clientReq.destroy(err);
        }
      };

      const failBeforeResponse = (err: unknown) => {
        cleanupAbortListener();
        if (!settled) {
          settled = true;
          tearDownStreams(err instanceof Error ? err : new Error(String(err)));
          reject(err);
        }
      };

      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        const abortErr = toAbortError(signal?.reason);
        cleanupAbortListener();
        if (!settled) {
          settled = true;
          tearDownStreams(abortErr);
          reject(abortErr);
          return;
        }
        if (!activeStreamEnded && activeBodyController) {
          activeStreamEnded = true;
          try {
            activeBodyController.error(abortErr);
          } catch {
            // Stream controller already closed/errored.
          }
        }
        tearDownStreams(abortErr);
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Keep an error sink attached for the entire ClientRequest lifetime so
      // late teardown errors (after headers or abort) never trigger uncaughtException.
      clientReq.on('error', (err) => {
        if (!settled) {
          failBeforeResponse(err);
          return;
        }
        if (!activeStreamEnded && activeBodyController) {
          activeStreamEnded = true;
          try {
            activeBodyController.error(err);
          } catch {
            // Already closed/errored.
          }
        }
        tearDownStreams(err);
      });

      clientReq.on('response', (incoming) => {
        activeIncoming = incoming;
        // Attach a persistent sink immediately so HTTP socket teardown or idle
        // closes can never emit an unhandled 'error' on IncomingMessage.
        incoming.on('error', noop);

        if (aborted || signal?.aborted) {
          const abortErr = toAbortError(signal?.reason);
          if (!settled) {
            settled = true;
            cleanupAbortListener();
            tearDownStreams(abortErr);
            reject(abortErr);
          } else {
            tearDownStreams(abortErr);
          }
          return;
        }

        const status = incoming.statusCode ?? 200;
        const statusText = incoming.statusMessage ?? '';
        const hasNullBody = method === 'HEAD' || NULL_BODY_STATUSES.has(status);

        if (hasNullBody) {
          settled = true;
          cleanupAbortListener();
          const resHeaders = toIncomingHeaders(incoming.headers, false);
          incoming.resume();
          resolve(new Response(null, { status, statusText, headers: resHeaders }));
          return;
        }

        const rawEncoding = typeof incoming.headers['content-encoding'] === 'string'
          ? incoming.headers['content-encoding']
          : '';
        const decoderSpec = createDecompressStream(rawEncoding);
        const resHeaders = toIncomingHeaders(incoming.headers, Boolean(decoderSpec?.decompressed));
        const bodyStream: Readable = decoderSpec ? incoming.pipe(decoderSpec.stream) : incoming;
        if (decoderSpec) {
          activeDecoder = decoderSpec.stream;
          decoderSpec.stream.on('error', noop);
        }

        settled = true;
        const webBody = new ReadableStream<Uint8Array>({
          start(controller) {
            activeBodyController = controller;
            bodyStream.pause();

            const cleanupStream = () => {
              cleanupAbortListener();
              bodyStream.off('data', onData);
              bodyStream.off('end', onEnd);
              bodyStream.off('error', onStreamError);
              incoming.off('aborted', onUpstreamAborted);
              incoming.off('close', onUpstreamClose);
              if (decoderSpec) incoming.off('error', onStreamError);
            };

            const failStream = (err: Error) => {
              if (activeStreamEnded) return;
              activeStreamEnded = true;
              cleanupStream();
              tearDownStreams(err);
              try {
                controller.error(err);
              } catch {
                // Controller already closed or errored.
              }
            };

            const onData = (chunk: Buffer) => {
              if (activeStreamEnded) return;
              bodyStream.pause();
              try {
                // Copy out of Node's shared slab pool so callers retaining
                // chunks see immutable bytes.
                controller.enqueue(new Uint8Array(chunk));
              } catch (enqueueErr) {
                failStream(enqueueErr instanceof Error ? enqueueErr : new Error(String(enqueueErr)));
              }
            };

            const onEnd = () => {
              if (activeStreamEnded) return;
              activeStreamEnded = true;
              cleanupStream();
              try {
                controller.close();
              } catch {
                // Controller already closed.
              }
            };

            const onStreamError = (err: Error) => {
              failStream(err);
            };

            const onUpstreamAborted = () => {
              if (!activeStreamEnded) {
                failStream(new Error('upstream response aborted'));
              }
            };

            const onUpstreamClose = () => {
              if (!activeStreamEnded && !incoming.complete) {
                failStream(new Error('upstream response closed prematurely'));
              }
            };

            bodyStream.on('data', onData);
            bodyStream.once('end', onEnd);
            bodyStream.on('error', onStreamError);
            if (decoderSpec) {
              incoming.on('error', onStreamError);
            }
            incoming.once('aborted', onUpstreamAborted);
            incoming.once('close', onUpstreamClose);
          },
          pull() {
            if (!activeStreamEnded && !aborted) {
              bodyStream.resume();
            }
          },
          cancel() {
            activeStreamEnded = true;
            cleanupAbortListener();
            tearDownStreams();
          },
        });

        resolve(new Response(webBody, { status, statusText, headers: resHeaders }));
      });

      // Write request body (empty, buffered, or streamed).
      if (rawBody === null || rawBody === undefined) {
        clientReq.end();
        return;
      }

      if (isReadableStreamBody(rawBody)) {
        const reader = rawBody.getReader();
        bodyReader = reader;
        void (async () => {
          try {
            while (!aborted && !clientReq.destroyed) {
              const { done, value } = await reader.read();
              if (aborted || clientReq.destroyed) {
                await reader.cancel().catch(() => undefined);
                return;
              }
              if (done) {
                if (!clientReq.destroyed && !clientReq.writableEnded) {
                  clientReq.end();
                }
                return;
              }
              if (value && value.byteLength > 0) {
                const ok = clientReq.write(value);
                if (!ok) {
                  await waitForRequestDrain(clientReq, () => aborted);
                }
              }
            }
          } catch (err) {
            failBeforeResponse(err);
          } finally {
            if (bodyReader === reader) bodyReader = undefined;
            try {
              reader.releaseLock();
            } catch {
              // Reader already released or errored.
            }
          }
        })();
        return;
      }

      try {
        const payload = resolveBufferedBody(rawBody);
        clientReq.end(payload);
      } catch (err) {
        failBeforeResponse(err);
      }
    });
  };

  return {
    fetch: nodeFetch,
    destroy: () => {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}
