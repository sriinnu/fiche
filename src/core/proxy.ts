/**
 * fiche proxy as a single Web-standard fetch handler.
 * Adapted by src/node.ts and src/worker.ts; uses only Request/Response/URL/fetch.
 */

import { readBrandEnv } from './env.js';
import { markCacheDead, noteCacheOutcome, responseLeftNoCache } from './session-state.js';
import { transformRequest, type TransformOptions, type TransformInfo } from './transform.js';
import { isClaudeModel, transformOpenAIChatCompletions, transformOpenAIResponses } from './openai.js';
import {
  isAnthropicMessagesPath,
  isInConfiguredModelBases,
  isInklingSupportedGptModel,
  isInklingSupportedModel,
} from './applicability.js';
import {
  buildBaselineCountTokensBody,
  buildCacheablePrefixCountTokensBody,
  isThreadContinuation,
} from './measurement.js';
import type { Usage } from './types.js';
import {
  anthropicMessagesToOpenAIResponses,
  openAIResponsesToAnthropicResponse,
} from './messages-responses-bridge.js';
import {
  anthropicMessagesToOpenAIChat,
  chatCompletionsUrl,
  openAIChatToAnthropicResponse,
} from './messages-chat-bridge.js';
import { pinCommandResponse, pinCommandResponseOpenAI } from './pin.js';
import { withClientToolRoundShape } from './client-tool-round.js';
import { isGoogleInferencePath, parseGoogleModelFromPath, transformGoogleGenerateContent } from './google.js';
import { isGeminiModel } from './gemini-model-profiles.js';
import { resolveGptProfile } from './gpt-model-profiles.js';
import { scrubPromptCacheBreakpoint, supportsExplicitPromptCacheBreakpoint } from './codex-cache.js';
import {
  DEFAULT_UPSTREAM_REGISTRY,
  isFollowRefusal,
  refuseUnfollowedProviderHost,
  resolveFollowTarget,
  type ProviderId,
  type UpstreamRegistry,
} from './upstream-hosts.js';
import { shouldImageModel } from './reader-tier.js';
import { resolveTextHygieneMode } from './text-hygiene.js';

export {
  parseTrustAdjacentToolRounds,
  resolveTrustAdjacentToolRoundsEnv,
  withClientToolRoundShape,
} from './client-tool-round.js';

export interface ProxyConfig {
  /** 'cloudflare-ai-gateway': routes both families through gatewayBaseUrl;
   *  OpenAI paths drop the `/v1` prefix to match gateway shape. */
  provider?: 'cloudflare-ai-gateway';
  /** Gateway base URL (account/gateway-scoped). Required when provider is set. */
  gatewayBaseUrl?: string;
  /** Extra headers injected on every upstream request (e.g. gateway auth). */
  gatewayHeaders?: Record<string, string>;
  /** Anthropic API base, no trailing slash. Defaults to api.anthropic.com. */
  upstream?: string;
  /** Override or supply an API key. If unset, we forward whatever the client sent. */
  apiKey?: string;
  /** Override the Anthropic `authorization` bearer. Pass a function to re-resolve
   *  per request: subscription tokens expire, and a client that froze its bearer
   *  at startup (a container env var) cannot renew one mid-run. Resolving here
   *  keeps rotation on the host, with a single writer. */
  authToken?: string | (() => string | undefined);
  /** OpenAI API base for GPT chat completions, no trailing slash. */
  openAIUpstream?: string;
  /** Override or supply an OpenAI API key. If unset, we forward Authorization. */
  openAIApiKey?: string;
  /** Google API base for Gemini / CloudCode inference, no trailing slash. */
  googleUpstream?: string;
  /** Cloudflare's OpenAI-compatible Chat Completions endpoint and bearer key. */
  cloudflareUpstream?: string;
  cloudflareApiKey?: string;
  /** Exact model ids routed to each non-default provider. Unlisted Claude
   * models retain normal Anthropic routing. */
  openAIModels?: string[];
  cloudflareModels?: string[];
  /** Pass a function to inject dynamic values per-request (e.g. live charsPerToken);
   *  static object for Workers/tests. */
  transform?: TransformOptions | (() => TransformOptions);
  /** Called after every request — useful for logging / metrics in the host. */
  onRequest?: (event: ProxyEvent) => void | Promise<void>;
  /** Persist 4xx diagnostics: the gzipped request body plus the upstream error
   *  body. Off by default because either side may contain prompts or secrets. */
  captureErrorReqBody?: boolean;
  /** Abort the upstream request if response headers have not arrived within this
   *  many ms. Cleared once headers land, so long generations are unaffected.
   *  0 (default) disables so upstream and client control timeouts. */
  upstreamHeadersTimeoutMs?: number;
  /** Abort the upstream response if no bytes arrive for this many ms.
   *  0 (default) disables so buffered tool-call streams pass through as-is. */
  upstreamIdleTimeoutMs?: number;
  /** How long an in-flight request may reject an identical retry before the dedupe
   *  fails open. Prevents one stalled request from permanently 409-ing its retries.
   *  0 disables dedupe entirely. */
  duplicateHoldMs?: number;
  /** Hard ceiling, in bytes, on an inbound request body inkling will hold in
   *  memory. Transformable routes have to read the whole body, so without a
   *  ceiling one client decides how much the proxy allocates: a Worker or a Node
   *  instance bound to anything other than loopback is then one long request away
   *  from memory exhaustion. Over-limit bodies get a provider-shaped 413 before
   *  any upstream call. Routes inkling only labels are never rejected by this -
   *  they carry uploads and audio - but their model sniff is bounded too.
   *
   *  Defaults to {@link DEFAULT_MAX_REQUEST_BYTES}. A non-integer, zero or
   *  negative value is ignored in favour of that default: an unusable limit must
   *  not silently become no limit. */
  maxRequestBytes?: number;
  /** How transformable routes handle an inbound body larger than {@link maxRequestBytes}:
   *  - `'reject'` (default): return provider-shaped 413 without calling upstream (Workers / non-loopback).
   *  - `'passthrough'`: stop buffering at the ceiling and stream buffered chunks + remainder
   *    straight to upstream, logging `body_too_large`. Fails closed with 413 on `/v1/messages`
   *    when `openAIModels` / `cloudflareModels` bridging is configured. */
  oversizedBodyPolicy?: 'reject' | 'passthrough';
  /** Undo a request `Content-Encoding` on transformable routes so the body can
   *  be read. Codex's built-in provider zstd-compresses its Responses POST; left
   *  encoded, the transform silently skips it. Return `undefined` when the coding
   *  is unknown, the bytes are corrupt, or the output would pass `maxBytes`: the
   *  original bytes and header are then forwarded untouched. A decoded body is
   *  forwarded as plain bytes without the header, since chatgpt.com has been seen
   *  to refuse zstd on image-heavy bodies. Core stays runtime-neutral, so the Node
   *  entry supplies this; without it, encoded bodies pass through as before. */
  decodeRequestBody?: (bytes: Uint8Array, encoding: string, maxBytes: number) => Uint8Array<ArrayBuffer> | undefined;
  /** "Follow the agent": forward a request whose Host is a registered
   *  third-party provider (as under `inkling warp`), or whose path is
   *  `/to/<host>/...`, to that host over https instead of the configured
   *  upstreams. Only the agent's own credential travels; configured keys,
   *  gateway headers, bridges and baseline probes never apply. Off by default:
   *  a public Worker with this on would relay anyone's traffic. See
   *  core/upstream-hosts.ts. */
  followHosts?: boolean;
  /** Registry for `followHosts`; defaults to the built-in provider list. */
  upstreamRegistry?: UpstreamRegistry;
  /** Opted-in built-in providers (`anthropic`, `openai`, `google`, ...). */
  enabledProviders?: readonly ProviderId[] | (() => readonly ProviderId[]);
  /** Custom `fetch` implementation for upstream requests and token probes (defaults to `globalThis.fetch`).
   *  Node callers pass a keep-alive HTTP/1.1 transport to avoid Node 26 undici HTTP/2 idle-reaper crashes. */
  fetch?: typeof globalThis.fetch;
  /** Optional Edge Runtime hook (`ctx.waitUntil`) to keep async telemetry alive past response return. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface ProxyEvent {
  method: string;
  path: string;
  /** Top-level request model when present. Used for telemetry/dashboard labels only. */
  model?: string;
  /** Provider cost/usage semantics after any internal wire bridge. Unlike
   * `path`, this describes the upstream that actually billed the request. */
  accountingProvider?: 'anthropic' | 'openai' | 'google';
  status: number;
  /** Wall-clock ms from request start to event fire (≈ end of upstream body). */
  durationMs: number;
  /** Wall-clock ms from request start to upstream response headers. */
  firstByteMs?: number;
  /** Wall-clock ms spent in the local transform (render + encode), excluding any
   *  upstream probe. `durationMs - transformMs` is the upstream half, so a slow
   *  request can be attributed to our own CPU vs the provider without guessing. */
  transformMs?: number;
  info?: TransformInfo;
  /** Usage block from Anthropic's response — input/output/cache tokens. */
  usage?: Usage;
  /** Model stop reason from the response ("end_turn", "tool_use", "max_tokens",
   *  "refusal", …). "refusal" = safety classifier fired on the transformed request —
   *  scorers must fail cost comparisons on refusal rows (refusals emit almost no
   *  output and would otherwise look "cheaper"). OpenAI finish_reason ("stop",
   *  "length", "content_filter", …) is normalized into the same field. */
  stopReason?: string;
  error?: string;
  /** First ~2 KiB of the upstream 4xx body (not captured on 2xx or 5xx). */
  errorBody?: string;
  /** sha256[0..8] of the transformed outgoing body — set on every /v1/messages POST for correlation. */
  reqBodySha8?: string;
  /** Gzipped transformed body, populated only on 4xx. Node may write to sidecar (see reqBodySamplePath). */
  reqBodyGz?: Uint8Array;
  /** Set by the Node host instead of reqBodyGz when the body was written to a sidecar file. */
  reqBodySamplePath?: string;
  /** Ground-truth char counts from the response stream, independent of usage.output_tokens.
   *  Absent when the body couldn't be scanned (5xx, unknown content-type). See OutputMeasurement. */
  measurement?: OutputMeasurement;
  /** Upstream response media/encoding metadata for scanner diagnostics. */
  responseContentType?: string;
  responseContentEncoding?: string;
}

/** Max chars of 4xx error body captured on ProxyEvent — enough for Anthropic's full error JSON. */
const ERROR_BODY_MAX = 2048;

/** Disabled by default (0): upstream and client control request/stream timeouts. */
const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 0;
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 0;
/** Past this, an in-flight entry is treated as stale and a retry is let through. */
const DEFAULT_DUPLICATE_HOLD_MS = 60_000;
/**
 * Budget for a count-tokens probe. Both probes fail closed (null keeps the original
 * body), so expiring one costs that request's savings, never correctness. The Google
 * pair is awaited before the forward, so this is worst-case added latency; the
 * Anthropic pair only feeds telemetry.
 *
 * Neither provider publishes a latency SLO for count-tokens, and we have no probe
 * timing of our own, so this is not a measured figure. It is bounded by the one number
 * we do have: p99 time-to-headers for a full generation on the same route (30s over
 * 2166 Gemini requests in our telemetry). A probe does strictly less work than
 * first-token generation, so one that misses that mark is wedged rather than slow.
 */
const COUNT_TOKENS_TIMEOUT_MS = 30_000;
/** Sweep the in-flight map early once it grows past plausible real concurrency. */
const INFLIGHT_SWEEP_SIZE = 256;
/** Floor between size-triggered sweeps so genuine high concurrency stays O(1)/request. */
const INFLIGHT_SWEEP_MIN_INTERVAL_MS = 1_000;

function combineAbortSignals(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parent) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSignal, parent]);
  }
  if (parent.aborted) return parent;
  const ac = new AbortController();
  const onParent = () => {
    timeoutSignal.removeEventListener('abort', onTimeout);
    ac.abort(parent.reason);
  };
  const onTimeout = () => {
    parent.removeEventListener('abort', onParent);
    ac.abort(timeoutSignal.reason);
  };
  parent.addEventListener('abort', onParent, { once: true });
  timeoutSignal.addEventListener('abort', onTimeout, { once: true });
  return ac.signal;
}

/**
 * Abort the response if no chunk arrives for `ms`. Wraps the raw upstream stream so
 * the watchdog sees real network activity rather than post-transform output.
 */
function withIdleTimeout(
  res: Response,
  firstChunkMs: number,
  ms: number,
  onIdle: () => void,
): Response {
  if (!res.body || ms <= 0) return res;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  // The watchdog errors its own controller rather than relying on the fetch
  // implementation to tear the body down when the signal aborts.
  let ctl: TransformStreamDefaultController<Uint8Array> | undefined;
  const arm = (budget: number): void => {
    clear();
    timer = setTimeout(() => {
      timer = undefined;
      onIdle();
      try {
        ctl?.error(new Error(`fiche: upstream stalled for ${budget}ms`));
      } catch {
        /* already errored or closed */
      }
    }, budget);
  };
  const watched = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        ctl = controller;
        // Nothing has streamed yet: the model may still be starting up, which is the
        // same wait the headers budget covers. Real traffic has taken >120s just to
        // return headers (max 146s over 41k requests), so charging the mid-stream idle
        // budget here would abort healthy slow starts.
        arm(firstChunkMs > 0 ? firstChunkMs : ms);
      },
      transform(chunk, controller) {
        // Bytes have flowed: from here a long silence means wedged, not slow.
        arm(ms);
        controller.enqueue(chunk);
      },
      flush() {
        clear();
      },
    }),
  );
  // Wrap readable so consumer cancel() clears any pending idle watchdog immediately.
  const watchedReader = watched.getReader();
  const guardedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await watchedReader.read();
        if (done) {
          clear();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        clear();
        controller.error(err);
      }
    },
    cancel(reason) {
      clear();
      return watchedReader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(guardedBody, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * Passthrough that notifies on client disconnect. `cancel` deliberately does not await
 * the inner cancel: with a wedged upstream that call can hang, which would in turn hang
 * the caller's `body.cancel()`.
 */
function withClientDisconnect(
  body: ReadableStream<Uint8Array>,
  onCancel: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      onCancel(reason);
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Cap on bodies buffered only to sniff a model name, on paths inkling does not
 *  transform. Chat requests naming a model are far below this; uploads that blow
 *  past it stream through unbuffered. */
const MODEL_SNIFF_MAX_BYTES = 1 << 20;

/** Default ceiling on a buffered inbound body: 16 MiB.
 *
 *  Chosen against what the transform actually has to hold, not against what a
 *  provider accepts. Real Claude Code requests measured on production traffic sit
 *  far below this even with a 400k system slab and a long tool-heavy history, so
 *  the limit is not reachable by ordinary use. Hosts that genuinely need more can
 *  raise it explicitly; nothing raises it implicitly. */
export const DEFAULT_MAX_REQUEST_BYTES = 16 << 20;

/** Validate a host-supplied ceiling. Garbage falls back to the default rather
 *  than disabling the check, because "0" or NaN meaning "unlimited" is exactly
 *  the failure mode this option exists to remove. */
function resolveMaxRequestBytes(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_MAX_REQUEST_BYTES;
  return configured;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

type BoundedBody =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; observedBytes: number; declaredBytes?: number; restoredBody?: BodyInit | null };

/**
 * Read a whole request body, stopping once it exceeds `limit`.
 *
 * The declared `content-length` is used only as a shortcut to act without
 * reading a byte. It is never the authority: chunked senders omit it, and a
 * wrong value costs the sender nothing. The streaming loop is what enforces the
 * cap, so a body that lies about its size is bounded by the same number as one
 * that declares nothing.
 *
 * When `restoreOnOverflow` is true, the buffered chunks are replayed lazily ahead
 * of the untouched remainder as a ReadableStream (dropping each chunk reference
 * as handed off upstream), or `req.body` is returned untouched when `content-length`
 * already proved overflow.
 */
async function readBodyBounded(
  req: Request,
  limit: number,
  restoreOnOverflow = false,
): Promise<BoundedBody> {
  const declaredRaw = req.headers.get('content-length');
  const declared = declaredRaw === null ? NaN : Number(declaredRaw);
  const declaredBytes = Number.isFinite(declared) && declared >= 0 ? declared : undefined;
  if (declaredBytes !== undefined && declaredBytes > limit) {
    return {
      ok: false,
      observedBytes: 0,
      declaredBytes,
      ...(restoreOnOverflow ? { restoredBody: req.body } : {}),
    };
  }

  const body = req.body;
  if (!body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        if (!restoreOnOverflow) {
          await reader.cancel().catch(() => {});
          return { ok: false, observedBytes: total, ...(declaredBytes !== undefined ? { declaredBytes } : {}) };
        }
        chunks.push(value);
        let index = 0;
        const restored = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index < chunks.length) {
              const chunk = chunks[index]!;
              chunks[index] = undefined as unknown as Uint8Array;
              index++;
              controller.enqueue(chunk);
              return;
            }
            try {
              for (;;) {
                const { done: nextDone, value: nextValue } = await reader.read();
                if (nextDone) {
                  controller.close();
                  return;
                }
                if (nextValue && nextValue.byteLength > 0) {
                  controller.enqueue(nextValue);
                  return;
                }
              }
            } catch (err) {
              controller.error(err);
            }
          },
          cancel(reason) {
            chunks.length = 0;
            return reader.cancel(reason);
          },
        });
        return {
          ok: false,
          observedBytes: total,
          ...(declaredBytes !== undefined ? { declaredBytes } : {}),
          restoredBody: restored,
        };
      }
      chunks.push(value);
    }
  } catch (err) {
    // A client that hangs up mid-body lands here. Release the socket and let the
    // host's error path answer, which is what an unbounded read did too.
    await reader.cancel().catch(() => {});
    throw err;
  }
  return { ok: true, bytes: concatChunks(chunks, total) };
}

/**
 * Read at most `maxPrefix` bytes for inspection while keeping the body
 * forwardable byte-for-byte.
 *
 * Used on routes inkling does not transform, where the only thing wanted from the
 * body is the model name for a dashboard label. Rejecting those requests is not
 * an option - the same route carries uploads and audio - so instead of buffering
 * everything, the consumed prefix is replayed ahead of the untouched remainder.
 * Memory stays at one prefix regardless of how large the upload is.
 */
async function sniffPrefixRestoringBody(
  req: Request,
  maxPrefix: number,
): Promise<{ prefix: Uint8Array<ArrayBuffer>; body: BodyInit | null }> {
  const body = req.body;
  if (!body) return { prefix: new Uint8Array(0), body: null };

  const reader = body.getReader();
  const prefixChunks: Uint8Array[] = [];
  let total = 0;
  let exhausted = false;
  try {
    while (total < maxPrefix) {
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      prefixChunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }

  const prefix = concatChunks(prefixChunks, total);
  // The whole body fit inside the prefix, so those bytes ARE the body.
  if (exhausted) return { prefix, body: prefix };

  const restored = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of prefixChunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value && value.byteLength > 0) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { prefix, body: restored };
}

/** Read the actual top-level `model` field. The body is already buffered for
 * transformation, so parsing it is both safer and simpler than a prefix regex
 * (which could mistake `metadata.model` for the routing model). */
function readModelField(body: Uint8Array): string | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown };
    return typeof value.model === 'string' && value.model.length <= 200 ? value.model : null;
  } catch {
    return null;
  }
}

/** Responses defaults to non-streaming when `stream` is absent. */
function readStreamField(body: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

/** Read only a bounded clone of a request while leaving its original body
 * untouched for streaming passthrough. */
async function readBoundedClone(req: Request): Promise<Uint8Array | null> {
  const reader = req.clone().body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= MODEL_SNIFF_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MODEL_SNIFF_MAX_BYTES) return null;
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Read only a bounded clone of a bypassed JSON request. Bypass must keep the
 * original body byte-for-byte, but Responses telemetry still needs to know
 * whether a headerless Codex reply is SSE or JSON. */
async function readStreamFieldFromClone(req: Request): Promise<boolean> {
  const body = await readBoundedClone(req);
  return body !== null && readStreamField(body);
}

// Claude Code only admits gateway-discovered ids beginning with "claude" or
// "anthropic". Prefix provider ids for discovery, then remove that compatibility
// prefix before INKLING_MODELS matching and upstream routing.
const CLAUDE_GATEWAY_MODEL_PREFIX = 'claude-';

function claudeGatewayModelId(model: string): string {
  if (model.startsWith('claude-') || model.startsWith('anthropic')) return model;
  return CLAUDE_GATEWAY_MODEL_PREFIX + model;
}

function resolveClaudeGatewayModelId(model: string | null): string | undefined {
  if (!model?.startsWith(CLAUDE_GATEWAY_MODEL_PREFIX)) return undefined;
  const providerModel = model.slice(CLAUDE_GATEWAY_MODEL_PREFIX.length);
  return providerModel.includes('/') ? providerModel : undefined;
}

function routedModelDisplayName(model: string, route: 'openai' | 'cloudflare'): string {
  if (route === 'cloudflare' && /kimi-k3/i.test(model)) return 'Kimi K3 (Cloudflare)';
  return `${model} (${route === 'cloudflare' ? 'Cloudflare' : 'OpenAI'})`;
}

/** Gzip via CompressionStream — available in Node 18+ and Cloudflare Workers. */
async function gzipBytes(body: Uint8Array): Promise<Uint8Array> {
  // Cast: TS doesn't model Response(Uint8Array) even though it works in both runtimes.
  const stream = new Response(body as BufferSource).body!.pipeThrough(
    new CompressionStream('gzip'),
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** SHA-256 hex of a byte buffer. */
async function sha256Bytes(body: Uint8Array): Promise<string> {
  // Cast: Web Crypto accepts Uint8Array at runtime despite the BufferSource type.
  const digest = await crypto.subtle.digest('SHA-256', body as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

/**
 * Ground-truth char counts from the response stream, independent of usage.output_tokens.
 * redactedBlockCount blocks are opaque server bytes — no char count available for those.
 */
export interface OutputMeasurement {
  textChars: number;
  thinkingChars: number;
  toolUseChars: number;
  redactedBlockCount: number;
}

/** Parse one SSE block into the running usage + measurement accumulators. Silent on malformed input. */
function processSseEvent(
  block: string,
  m: OutputMeasurement,
  state: { usage: Usage | undefined; stopReason: string | undefined },
): void {
  // Parse `event:` + `data:` lines; continuation data: lines concatenate per SSE spec.
  let event = '';
  let data = '';
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).replace(/^\s/, '');
  }
  if (!data) return;
  let j: unknown;
  try {
    j = JSON.parse(data);
  } catch {
    return;
  }
  const obj = j as Record<string, unknown>;
  // The Responses wire format identifies events in the JSON `type` field.
  // Some providers also emit an SSE `event:` line, but ChatGPT's
  // /backend-api/codex/responses commonly does not. Prefer the official JSON
  // discriminator when present and use the SSE name as a compatibility fallback.
  const eventType = typeof obj.type === 'string' ? obj.type : event;

  if (eventType !== 'message_delta' && eventType !== 'message_start') {
    // OpenAI chunks have no `event:` line; usage only present when stream_options.include_usage is set.
    const openAIUsage = normalizeUsage((obj as { usage?: unknown }).usage);
    if (openAIUsage) state.usage = openAIUsage;
  }
  // OpenAI Responses API streams usage nested under `response` on the terminal
  // terminal Responses event — not at the top level.
  if (
    eventType === 'response.completed'
    || eventType === 'response.incomplete'
    || eventType === 'response.failed'
  ) {
    const resp = obj.response as
      | {
          usage?: unknown;
          incomplete_details?: { reason?: unknown };
          error?: { code?: unknown; message?: unknown };
        }
      | undefined;
    const respUsage = normalizeUsage(resp?.usage);
    if (respUsage) state.usage = respUsage;
    // Responses API has no stop_reason; normalize terminal status/reason.
    // Preserve a refusal observed in an earlier delta rather than overwriting it.
    const reason = resp?.incomplete_details?.reason;
    const failureCode = resp?.error?.code;
    state.stopReason = typeof reason === 'string' ? reason
      : eventType === 'response.incomplete' ? 'incomplete'
      : eventType === 'response.failed'
        ? (typeof failureCode === 'string' ? failureCode : 'failed')
        : state.stopReason ?? 'stop';
  }
  // Responses streaming deltas are not Chat Completions `choices[]` chunks.
  // Count their visible/reasoning/tool payloads directly from the JSON event.
  if (eventType === 'response.refusal.delta' || eventType === 'response.refusal.done') {
    // `.done` repeats the completed refusal text; only deltas are additive.
    if (eventType === 'response.refusal.delta' && typeof obj.delta === 'string') {
      m.textChars += obj.delta.length;
    }
    state.stopReason = 'refusal';
  } else if (eventType === 'response.output_text.delta' && typeof obj.delta === 'string') {
    m.textChars += obj.delta.length;
  } else if (
    (eventType === 'response.reasoning_text.delta'
      || eventType === 'response.reasoning_summary_text.delta')
    && typeof obj.delta === 'string'
  ) {
    m.thinkingChars += obj.delta.length;
  } else if (
    (eventType === 'response.function_call_arguments.delta'
      || eventType === 'response.custom_tool_call_input.delta')
    && typeof obj.delta === 'string'
  ) {
    m.toolUseChars += obj.delta.length;
  }
  // Google AI Studio / CloudCode streaming chunks: usageMetadata object.
  const usageObj = obj.usageMetadata ?? (obj.response as Record<string, unknown> | undefined)?.usageMetadata;
  if (usageObj && typeof usageObj === 'object') {
    const gUsage = normalizeUsage(usageObj);
    if (gUsage) state.usage = gUsage;
  }
  measureGoogleCandidates(obj, m, state);

  measureOpenAIChoices(obj, m);
  // OpenAI chat chunks: the final chunk carries choices[].finish_reason (earlier chunks ship null).
  const choices = obj.choices;
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const fr = (c as { finish_reason?: unknown } | undefined)?.finish_reason;
      if (typeof fr === 'string') state.stopReason = fr;
    }
  }

  if (eventType === 'message_start') {
    const msg = obj.message as { usage?: Usage } | undefined;
    const usage = normalizeUsage(msg?.usage);
    if (usage) state.usage = usage;
  } else if (eventType === 'content_block_start') {
    const cb = obj.content_block as { type?: string } | undefined;
    if (cb?.type === 'redacted_thinking') m.redactedBlockCount += 1;
  } else if (eventType === 'content_block_delta') {
    const d = obj.delta as
      | { type?: string; text?: string; thinking?: string; partial_json?: string }
      | undefined;
    if (d?.type === 'text_delta' && typeof d.text === 'string') {
      m.textChars += d.text.length;
    } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
      m.thinkingChars += d.thinking.length;
    } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
      m.toolUseChars += d.partial_json.length;
    }
  } else if (eventType === 'message_delta') {
    // Anthropic ships the final stop_reason here ("end_turn", "refusal", …).
    const d = obj.delta as { stop_reason?: unknown } | undefined;
    if (typeof d?.stop_reason === 'string') state.stopReason = d.stop_reason;
    // Authoritative final output_tokens; merge over message_start (which ships output_tokens: 1).
    const u = obj.usage as Partial<Usage> | undefined;
    if (u) {
      if (!state.usage) state.usage = {} as Usage;
      const cur = state.usage;
      if (typeof u.output_tokens === 'number') cur.output_tokens = u.output_tokens;
      if (
        typeof u.input_tokens === 'number' &&
        (cur.input_tokens === undefined || cur.input_tokens === 0 || u.input_tokens > 0)
      ) {
        cur.input_tokens = u.input_tokens;
      }
      if (typeof u.cache_creation_input_tokens === 'number') {
        cur.cache_creation_input_tokens = u.cache_creation_input_tokens;
      }
      if (typeof u.cache_read_input_tokens === 'number') {
        cur.cache_read_input_tokens = u.cache_read_input_tokens;
      }
      if (typeof u.cache_creation === 'object' && u.cache_creation !== null) {
        cur.cache_creation = {
          ...cur.cache_creation,
          ...u.cache_creation,
        };
      }
      if (typeof u.server_tool_use === 'object' && u.server_tool_use !== null) {
        cur.server_tool_use = {
          ...cur.server_tool_use,
          ...u.server_tool_use,
        };
      }
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonObjects(text: string): Record<string, unknown>[] | null {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(objectRecord).filter((item): item is Record<string, unknown> => item !== null);
    }
    const item = objectRecord(parsed);
    return item ? [item] : null;
  } catch {
    const match = /"usageMetadata"\s*:\s*(\{[^}]+\})/.exec(trimmed);
    if (match && match[1]) {
      try {
        const usageMetadata: unknown = JSON.parse(match[1]);
        return [{ usageMetadata }];
      } catch {}
    }
  }
  return null;
}

function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const out: Usage = {};

  if (typeof u.input_tokens === 'number') out.input_tokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') out.output_tokens = u.output_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') {
    out.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  if (typeof u.cache_read_input_tokens === 'number') {
    out.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  if (typeof u.cache_creation === 'object' && u.cache_creation !== null) {
    out.cache_creation = u.cache_creation as Usage['cache_creation'];
  }
  if (typeof u.server_tool_use === 'object' && u.server_tool_use !== null) {
    out.server_tool_use = u.server_tool_use as Usage['server_tool_use'];
  }

  // OpenAI field aliases.
  if (typeof u.prompt_tokens === 'number') out.input_tokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') out.output_tokens = u.completion_tokens;

  // Google AI Studio field aliases.
  if (typeof u.promptTokenCount === 'number') out.input_tokens = u.promptTokenCount;
  if (typeof u.candidatesTokenCount === 'number' || typeof u.thoughtsTokenCount === 'number') {
    out.output_tokens =
      (typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : 0) +
      (typeof u.thoughtsTokenCount === 'number' ? u.thoughtsTokenCount : 0);
  }
  if (typeof u.cachedContentTokenCount === 'number') out.cached_tokens = u.cachedContentTokenCount;
  // OpenAI prompt-cache hits live in a details sub-object: Responses uses
  // `input_tokens_details.cached_tokens`, Chat uses `prompt_tokens_details`.
  const details =
    (u.input_tokens_details as Record<string, unknown> | undefined) ??
    (u.prompt_tokens_details as Record<string, unknown> | undefined);
  if (details && typeof details.cached_tokens === 'number') {
    out.cached_tokens = details.cached_tokens;
  }
  // Root-level cached_tokens fallback (some OpenAI-compatible gateways).
  if (out.cached_tokens === undefined && typeof u.cached_tokens === 'number') {
    out.cached_tokens = u.cached_tokens;
  }
  // DeepSeek top-level prompt_cache_hit_tokens / prompt_cache_miss_tokens.
  if (
    typeof u.prompt_cache_hit_tokens === 'number' &&
    (out.cached_tokens === undefined || (out.cached_tokens === 0 && u.prompt_cache_hit_tokens > 0))
  ) {
    out.cached_tokens = u.prompt_cache_hit_tokens;
  }
  if (
    out.input_tokens === undefined &&
    (typeof u.prompt_cache_hit_tokens === 'number' || typeof u.prompt_cache_miss_tokens === 'number')
  ) {
    out.input_tokens =
      (typeof u.prompt_cache_hit_tokens === 'number' ? u.prompt_cache_hit_tokens : 0) +
      (typeof u.prompt_cache_miss_tokens === 'number' ? u.prompt_cache_miss_tokens : 0);
  }
  // Some OpenAI-compatible providers additionally expose prompt-cache writes.
  // Like cached_tokens, this is a diagnostic subset of input_tokens: consumers
  // must not add it to the input total a second time.
  if (details && typeof details.cache_write_tokens === 'number') {
    out.cache_write_tokens = details.cache_write_tokens;
  }
  const outputDetails =
    (u.output_tokens_details as Record<string, unknown> | undefined) ??
    (u.completion_tokens_details as Record<string, unknown> | undefined);
  if (outputDetails && typeof outputDetails.reasoning_tokens === 'number') {
    out.reasoning_output_tokens = outputDetails.reasoning_tokens;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Event info for a request forwarded untouched because the transform threw. */
function failOpenInfo(body: Uint8Array, message: string): TransformInfo {
  return {
    compressed: false,
    reason: `transform_error_fail_open: ${message.slice(0, 200)}`,
    origChars: body.byteLength,
    compressedChars: body.byteLength,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
}

function revertedGoogleInfo(
  info: TransformInfo,
  reason: string,
  baselineProbeStatus: 'ok' | 'failed',
): TransformInfo {
  return {
    ...info,
    compressed: false,
    reason,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    imagePixels: undefined,
    imageTokens: undefined,
    baselineImagedTokens: undefined,
    nativeInjectedTokens: undefined,
    firstImagePng: undefined,
    firstImageWidth: undefined,
    firstImageHeight: undefined,
    imagePngs: undefined,
    imageDims: undefined,
    imageSourceText: undefined,
    imageSourceTexts: undefined,
    toolResultImgs: undefined,
    collapsedTurns: undefined,
    collapsedChars: undefined,
    collapsedImages: undefined,
    historyTextChars: undefined,
    historyReason: undefined,
    bucketChars: undefined,
    gateEval: undefined,
    textHygieneSavedChars: undefined,
    textHygieneSavedTokens: undefined,
    textHygieneBlocks: undefined,
    textHygieneStages: undefined,
    cliffAvoided: undefined,
    baselineProbeStatus,
  };
}

function measureOpenAIChoices(obj: Record<string, unknown>, m: OutputMeasurement): void {
  const choices = obj.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const c = choice as { delta?: unknown; message?: unknown };
    const payload = (c.delta ?? c.message) as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;
    if (typeof payload.content === 'string') m.textChars += payload.content.length;
    if (typeof payload.reasoning_content === 'string') m.thinkingChars += payload.reasoning_content.length;
    const toolCalls = payload.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = (tc as { function?: unknown } | undefined)?.function;
        const args = (fn as { arguments?: unknown } | undefined)?.arguments;
        if (typeof args === 'string') m.toolUseChars += args.length;
      }
    }
  }
}

function measureGoogleCandidates(
  obj: Record<string, unknown>,
  m: OutputMeasurement,
  state?: { stopReason: string | undefined },
): boolean {
  const candidates = Array.isArray(obj.candidates)
    ? obj.candidates
    : (obj.response && typeof obj.response === 'object' && Array.isArray((obj.response as Record<string, unknown>).candidates))
      ? (obj.response as Record<string, unknown>).candidates as unknown[]
      : undefined;
  if (!Array.isArray(candidates)) return false;
  for (const rawCandidate of candidates) {
    const candidate = objectRecord(rawCandidate);
    if (!candidate) continue;
    if (state && typeof candidate.finishReason === 'string') state.stopReason = candidate.finishReason;
    const content = objectRecord(candidate.content);
    if (!Array.isArray(content?.parts)) continue;
    for (const rawPart of content.parts) {
      const part = objectRecord(rawPart);
      if (!part) continue;
      if (typeof part.text === 'string') {
        if (part.thought === true) m.thinkingChars += part.text.length;
        else m.textChars += part.text.length;
      }
      if (part.functionCall !== undefined) {
        try {
          m.toolUseChars += JSON.stringify(part.functionCall).length;
        } catch {}
      }
    }
  }
  return true;
}

/** Measure non-streaming messages.content[] / choices[] / Responses output[] — same OutputMeasurement shape as the SSE accumulator. */
function measureFromMessageJson(j: unknown): OutputMeasurement {
  const m: OutputMeasurement = { textChars: 0, thinkingChars: 0, toolUseChars: 0, redactedBlockCount: 0 };
  if (j && typeof j === 'object') {
    const obj = j as Record<string, unknown>;
    measureOpenAIChoices(obj, m);
    if (Array.isArray(obj.output)) {
      for (const rawItem of obj.output) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as Record<string, unknown>;
        const itemType = typeof item.type === 'string' ? item.type : '';
        if (itemType === 'message' && Array.isArray(item.content)) {
          for (const p of item.content) {
            if (!p || typeof p !== 'object') continue;
            const part = p as { type?: unknown; text?: unknown; refusal?: unknown };
            if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
              m.textChars += part.text.length;
            } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
              m.textChars += part.refusal.length;
            }
          }
        } else if (itemType === 'reasoning') {
          for (const arr of [item.summary, item.content]) {
            if (!Array.isArray(arr)) continue;
            for (const p of arr) {
              if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
                m.thinkingChars += ((p as { text: string }).text).length;
              }
            }
          }
        } else if (itemType === 'function_call' || itemType === 'custom_tool_call') {
          if (typeof item.arguments === 'string') m.toolUseChars += item.arguments.length;
          else if (typeof item.input === 'string') m.toolUseChars += item.input.length;
        }
      }
    }
  }
  const content = (j as { content?: unknown })?.content;
  if (!Array.isArray(content)) return m;
  for (const block of content) {
    const b = block as { type?: string; text?: unknown; thinking?: unknown; input?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string') {
      m.textChars += b.text.length;
    } else if (b?.type === 'thinking' && typeof b.thinking === 'string') {
      m.thinkingChars += b.thinking.length;
    } else if (b?.type === 'redacted_thinking') {
      m.redactedBlockCount += 1;
    } else if (b?.type === 'tool_use') {
      try {
        m.toolUseChars += JSON.stringify(b.input ?? {}).length;
      } catch {
        /* circular / unserialisable input — leave the counter as-is */
      }
    }
  }
  return m;
}

/** Stop reason from a non-streaming response JSON: Anthropic `stop_reason`,
 *  OpenAI chat `choices[].finish_reason`, Responses `status` / `incomplete_details.reason`. */
function readStopReasonFromJson(j: unknown): string | undefined {
  if (!j || typeof j !== 'object') return undefined;
  const obj = j as {
    stop_reason?: unknown;
    choices?: unknown;
    status?: unknown;
    incomplete_details?: { reason?: unknown };
    error?: { code?: unknown };
  };
  if (typeof obj.stop_reason === 'string') return obj.stop_reason;
  if (Array.isArray(obj.choices)) {
    for (const c of obj.choices) {
      const fr = (c as { finish_reason?: unknown } | undefined)?.finish_reason;
      if (typeof fr === 'string') return fr;
    }
  }
  if (obj.status === 'incomplete') {
    const reason = obj.incomplete_details?.reason;
    return typeof reason === 'string' ? reason : 'incomplete';
  }
  if (obj.status === 'failed') {
    const code = obj.error?.code;
    return typeof code === 'string' ? code : 'failed';
  }
  if (typeof obj.status === 'string') {
    return obj.status === 'completed' ? 'stop' : obj.status;
  }
  return undefined;
}

/**
 * Tee the response body to extract usage + output measurement without blocking the client.
 * Streams are scanned to EOF (final output_tokens is in message_delta; redacted_thinking
 * blocks can appear anywhere). 4xx bodies are capped at ERROR_BODY_MAX. 5xx is skipped.
 */
function teeForUsage(
  res: Response,
  assumeResponsesSse = false,
  assumeResponsesJson = false,
  retainStreamReceipt = false,
): {
  response: Response;
  usagePromise: Promise<Usage | undefined>;
  errorBodyPromise: Promise<string | undefined>;
  measurementPromise: Promise<OutputMeasurement | undefined>;
  stopReasonPromise: Promise<string | undefined>;
} {
  // No body at all: nothing to extract on either path.
  if (!res.body) {
    return {
      response: res,
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise: Promise.resolve(undefined),
      measurementPromise: Promise.resolve(undefined),
      stopReasonPromise: Promise.resolve(undefined),
    };
  }
  // 4xx: tee for the error body but skip usage scanning entirely.
  if (res.status >= 400 && res.status < 500) {
    const [forClient, forUs] = res.body.tee();
    const errorBodyPromise = (async (): Promise<string | undefined> => {
      const reader = forUs.getReader();
      const decoder = new TextDecoder();
      let out = '';
      let drained = false;
      try {
        while (out.length < ERROR_BODY_MAX) {
          const { done, value } = await reader.read();
          if (done) {
            drained = true;
            break;
          }
          out += decoder.decode(value, { stream: true });
        }
        out += decoder.decode();
        // Drain the rest so the tee buffer doesn't hold the stream open.
        while (!drained) {
          const { done } = await reader.read();
          if (done) {
            drained = true;
            break;
          }
        }
      } catch {
        /* client may have aborted */
      } finally {
        if (!drained) await reader.cancel().catch(() => undefined);
        try { reader.releaseLock(); } catch { /* already released */ }
      }
      return out.length > ERROR_BODY_MAX ? out.slice(0, ERROR_BODY_MAX) : out;
    })();
    return {
      response: new Response(forClient, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      }),
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise,
      measurementPromise: Promise.resolve(undefined),
      stopReasonPromise: Promise.resolve(undefined),
    };
  }
  // 5xx: skip both (the host already synthesizes an error message).
  if (res.status >= 500) {
    return {
      response: res,
      usagePromise: Promise.resolve(undefined),
      errorBodyPromise: Promise.resolve(undefined),
      measurementPromise: Promise.resolve(undefined),
      stopReasonPromise: Promise.resolve(undefined),
    };
  }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const [forClient, forUs] = res.body.tee();

  // Single read loop resolves all three; exposed as separate promises for call-site readability.
  const scanResult = (async (): Promise<{
    usage: Usage | undefined;
    measurement: OutputMeasurement | undefined;
    stopReason: string | undefined;
  }> => {
    const reader = forUs.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let drained = false;
    let streamedMeasurement: OutputMeasurement | undefined;
    const state: { usage: Usage | undefined; stopReason: string | undefined } = {
      usage: undefined,
      stopReason: undefined,
    };

    try {
      // ChatGPT's /backend-api/codex/responses currently omits Content-Type.
      // The request's top-level `stream` field selects SSE vs JSON for that
      // route; explicit unknown media types still fail closed.
      if (ct.includes('text/event-stream') || (ct === '' && assumeResponsesSse)) {
        // Walk every SSE event to EOF — message_delta (final output_tokens) is last.
        const m: OutputMeasurement = {
          textChars: 0,
          thinkingChars: 0,
          toolUseChars: 0,
          redactedBlockCount: 0,
        };
        streamedMeasurement = m;
        const sseBoundaryRe = /\r\n\r\n|\n\n|\r\r/g;
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            drained = true;
            break;
          }
          const prevLen = buf.length;
          buf += decoder.decode(value, { stream: true });
          // SSE events are terminated by a blank line; start scanning at prevLen - 3 so
          // a split delimiter is caught without rescanning the entire buffer O(N^2).
          sseBoundaryRe.lastIndex = Math.max(0, prevLen - 3);
          let consumedUntil = 0;
          let boundary: RegExpExecArray | null;
          while ((boundary = sseBoundaryRe.exec(buf)) !== null) {
            const block = buf.slice(consumedUntil, boundary.index);
            consumedUntil = boundary.index + boundary[0].length;
            processSseEvent(block, m, state);
          }
          if (consumedUntil > 0) buf = buf.slice(consumedUntil);
          // A malformed/headerless non-SSE response must not make the audit
          // branch buffer without bound. Ordinary Responses events are far
          // smaller; fail closed and drain if no delimiter arrives within 4 MiB.
          if (buf.length > 4 * 1024 * 1024) {
            while (true) {
              const { done: eof } = await reader.read();
              if (eof) {
                drained = true;
                break;
              }
            }
            return { usage: undefined, measurement: undefined, stopReason: undefined };
          }
        }
        buf += decoder.decode();
        if (buf.trim().length > 0) processSseEvent(buf, m, state); // trailing partial event
        return { usage: state.usage, measurement: m, stopReason: state.stopReason };
      }

      if (ct.includes('application/json') || (ct === '' && assumeResponsesJson)) {
        // Buffer up to 4 MiB for telemetry while still draining oversized
        // streams to EOF so the client tee never stalls on backpressure.
        const MAX = 4 * 1024 * 1024;
        let overflow = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            drained = true;
            break;
          }
          if (!overflow) {
            buf += decoder.decode(value, { stream: true });
            if (buf.length > MAX) {
              overflow = true;
              buf = '';
            }
          }
        }
        if (overflow) {
          return { usage: undefined, measurement: undefined, stopReason: undefined };
        }
        buf += decoder.decode();
        try {
          const objects = parseJsonObjects(buf);
          if (!objects) return { usage: undefined, measurement: undefined, stopReason: undefined };
          let usage: Usage | undefined;
          let recognizedGoogle = false;
          const measurement: OutputMeasurement = {
            textChars: 0, thinkingChars: 0, toolUseChars: 0, redactedBlockCount: 0,
          };
          const state: { stopReason: string | undefined } = { stopReason: undefined };
          for (const object of objects) {
            const nextUsage = normalizeUsage(
              object.usage
                ?? object.usageMetadata
                ?? (object.response as Record<string, unknown> | undefined)?.usageMetadata,
            );
            if (nextUsage) usage = nextUsage;
            recognizedGoogle = measureGoogleCandidates(object, measurement, state) || recognizedGoogle;
          }
          const last = objects[objects.length - 1];
          return {
            usage,
            measurement: recognizedGoogle ? measurement : measureFromMessageJson(last),
            stopReason: state.stopReason ?? readStopReasonFromJson(last),
          };
        } catch {
          return { usage: undefined, measurement: undefined, stopReason: undefined };
        }
      }
      // Unknown content-type: drain to release the tee buffer.
      while (true) {
        const { done } = await reader.read();
        if (done) {
          drained = true;
          break;
        }
      }
    } catch {
      if (retainStreamReceipt) {
        return {
          usage: state.usage,
          measurement: streamedMeasurement,
          stopReason: state.stopReason ?? 'stream_error',
        };
      }
    } finally {
      if (!drained) await reader.cancel().catch(() => undefined);
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    return { usage: undefined, measurement: undefined, stopReason: undefined };
  })();

  return {
    response: new Response(forClient, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    }),
    usagePromise: scanResult.then((s) => s.usage),
    errorBodyPromise: Promise.resolve(undefined),
    measurementPromise: scanResult.then((s) => s.measurement),
    stopReasonPromise: scanResult.then((s) => s.stopReason),
  };
}

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';
const DEFAULT_OPENAI_UPSTREAM = 'https://api.openai.com';

/** Headers we strip on the way out — they're hop-by-hop or proxy-injected. */
const STRIP_REQ_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length', // we recompute
  'expect',
  'accept-encoding', // let upstream choose
  'x-fiche-bypass', // fiche-only opt-out signal; never forwarded upstream
  'x-inkling-bypass', // legacy opt-out alias; never forwarded upstream
  'x-fiche-session-id', // fiche-only swarm/session isolation key; never forwarded upstream
  'x-inkling-session-id', // legacy session isolation alias; never forwarded upstream
]);

const STRIP_RES_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding', // we don't re-encode
  'content-length',   // body may differ after streaming
]);

function filterHeaders(src: Headers, strip: Set<string>): Headers {
  const out = new Headers();
  src.forEach((v, k) => {
    if (!strip.has(k.toLowerCase())) out.append(k, v);
  });
  return out;
}

const PASSTHROUGH_PREFIXES = [
  '/anthropic/',
  '/openai/',
  '/google-ai-studio/',
  '/compat/',
] as const;

function isProviderPrefixedPath(pathname: string): boolean {
  return PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Append a provider-prefixed path without doubling the provider segment when
 *  the base already ends with it: base `http://h/anthropic` plus
 *  `/anthropic/v1/messages` is `http://h/anthropic/v1/messages`. */
function joinProviderPath(base: string, path: string): string {
  const segment = /^\/[^/?]+/.exec(path)?.[0];
  return segment && base.endsWith(segment) ? base.slice(0, -segment.length) + path : base + path;
}

/** One optional gateway/provider segment, then an optional `/v1`, before the
 *  wire-shape suffix:
 *
 *    /v1/chat/completions
 *    /openai/v1/chat/completions
 *    /compat/chat/completions    AI Gateway's OpenAI-compatible route
 *    /grok/chat/completions
 *
 *  Wire shape only: whether the body is OpenAI-shaped enough to parse a model
 *  out of. Routing stays with isProviderPrefixedPath/isCanonicalOpenAIPath
 *  above, so a prefixed path still goes to passthroughUpstream. */
const PROVIDER_SEGMENT = String.raw`(?:\/[a-z0-9][a-z0-9._-]*)?(?:\/v1)?`;
const OPENAI_CHAT_PATH = new RegExp(`^${PROVIDER_SEGMENT}\\/chat\\/completions$`);
const OPENAI_RESPONSES_PATH = new RegExp(`^${PROVIDER_SEGMENT}\\/responses$`);

function isOpenAIChatPath(pathname: string): boolean {
  return OPENAI_CHAT_PATH.test(pathname);
}

function isOpenAIResponsesPath(pathname: string): boolean {
  return OPENAI_RESPONSES_PATH.test(pathname)
    || pathname === '/backend-api/codex/responses';
}

/** ChatGPT endpoints used by Codex when `requires_openai_auth = true` is set
 * on a custom provider. Every `/backend-api/` path is ChatGPT's (responses,
 * responses/compact, models, usage), so all of them go to OPENAI_UPSTREAM and
 * never to the Anthropic default, which would swap the ChatGPT bearer for an
 * Anthropic one and hand the conversation to the wrong provider. Only
 * `codex/responses` is transformed; the rest are forwarded byte-for-byte. */
function isChatGPTBackendPath(pathname: string): boolean {
  return pathname.startsWith('/backend-api/');
}

/** Google API shapes that are not inference (countTokens, model listing,
 *  Code Assist control calls). They go to the Google upstream untransformed. */
function isGoogleFamilyPath(pathname: string): boolean {
  return /^\/(?:upload\/)?v1(?:beta|alpha)\//.test(pathname)
    || pathname.startsWith('/v1internal:')
    || /^\/v1\/models\/[^/]+:[A-Za-z]+$/.test(pathname);
}

/** Paths the Anthropic default upstream serves. Anything outside every known
 *  family is refused rather than sent to Anthropic with injected keys. */
function isAnthropicFamilyPath(pathname: string): boolean {
  return pathname.startsWith('/v1/') || pathname.startsWith('/api/');
}

function resolveAuthToken(config: ProxyConfig): string | undefined {
  return typeof config.authToken === 'function' ? config.authToken() : config.authToken;
}

/** What the client presented, by shape only.
 *
 *  Classification never inspects a credential's contents beyond its prefix and
 *  segment structure, and never reads a local token store: inkling does not know
 *  or want to know which account a token belongs to. Shape is enough to decide
 *  routing, and it is the only thing safe to decide it on. */
export type InboundCredential =
  | 'none'
  /** `x-api-key`, which only Anthropic uses. */
  | 'anthropic-key'
  /** `Bearer sk-ant-…`: an Anthropic key or subscription token. */
  | 'anthropic-bearer'
  /** `Bearer <jwt>`: how Codex and ChatGPT subscription auth arrive. */
  | 'oauth-jwt'
  /** `Bearer sk-…` that is not Anthropic: an OpenAI-style API key. */
  | 'api-key-bearer'
  /** A bearer of unrecognised shape. Gateways and self-hosted upstreams use these. */
  | 'opaque-bearer';

const ANTHROPIC_BEARER_RE = /(?:^|,\s*)Bearer\s+sk-ant-/i;
const API_KEY_BEARER_RE = /^Bearer\s+sk-/i;
/** Three base64url segments whose first decodes to a JSON header (`eyJ…`). */
const JWT_BEARER_RE = /^Bearer\s+eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export function classifyInboundCredential(headers: Headers): InboundCredential {
  const authorization = headers.get('authorization') ?? '';
  if (ANTHROPIC_BEARER_RE.test(authorization)) return 'anthropic-bearer';
  if (JWT_BEARER_RE.test(authorization)) return 'oauth-jwt';
  if (API_KEY_BEARER_RE.test(authorization)) return 'api-key-bearer';
  if (authorization.trim() !== '') return 'opaque-bearer';
  if ((headers.get('x-api-key') ?? '').trim() !== '') return 'anthropic-key';
  return 'none';
}

/** The decision for the outgoing `authorization` header. */
export type OutboundAuth =
  /** Forward what the client sent, unchanged. */
  | { action: 'keep-inbound'; reason: string }
  /** Install the host's configured key in its place. */
  | { action: 'replace'; reason: string }
  /** Send no authorization at all. */
  | { action: 'drop'; reason: string };

/**
 * Credential policy for a direct OpenAI-family route: `/v1/responses`,
 * `/v1/chat/completions`, `/v1/models` and the provider-prefixed equivalents,
 * where the client speaks to the OpenAI upstream itself rather than through a
 * Messages bridge.
 *
 * Three rules, in priority order:
 *
 *  1. An Anthropic-shaped credential never reaches an OpenAI upstream. That is a
 *     cross-provider credential disclosure, and a guaranteed 401 on top. The
 *     route classifier already refuses this for the ambiguous `/v1/models` path;
 *     this applies the same rule to every OpenAI route.
 *  2. Subscription OAuth is preserved even when the host has an API key
 *     configured. A Codex user proxying through inkling means to spend their own
 *     subscription; silently substituting the host key bills the wrong account
 *     and usually fails, and the user has no way to see why.
 *  3. Otherwise a configured key replaces whatever arrived, and is used as the
 *     fallback when nothing arrived. This is the documented "host supplies the
 *     credential" mode.
 */
export function resolveOpenAIRouteAuth(
  inbound: InboundCredential,
  hasConfiguredKey: boolean,
): OutboundAuth {
  if (inbound === 'anthropic-bearer' || inbound === 'anthropic-key') {
    return hasConfiguredKey
      ? { action: 'replace', reason: 'anthropic-credential-never-crosses-providers' }
      : { action: 'drop', reason: 'anthropic-credential-never-crosses-providers' };
  }
  if (inbound === 'oauth-jwt') {
    return { action: 'keep-inbound', reason: 'subscription-oauth-belongs-to-the-caller' };
  }
  if (hasConfiguredKey) {
    return { action: 'replace', reason: 'host-configured-key' };
  }
  return inbound === 'none'
    ? { action: 'drop', reason: 'no-credential-available' }
    : { action: 'keep-inbound', reason: 'caller-credential-forwarded' };
}

function isCanonicalOpenAIPath(pathname: string, headers: Headers, hasOpenAIKey: boolean): boolean {
  const isModelsPath = pathname === '/v1/models' || pathname.startsWith('/v1/models/');
  // `/v1/models` exists on BOTH APIs, so it is routed by auth style — but an
  // `sk-ant-…` bearer is Anthropic by construction (Claude Code subscription
  // auth sends `authorization: Bearer sk-ant-oat01-…` with no x-api-key).
  // Without this check that OAuth token would be forwarded to the OpenAI
  // upstream: a credential leak, and a guaranteed 401.
  const bearerIsAnthropic = /^Bearer\s+sk-ant-/i.test(headers.get('authorization') ?? '');
  const looksOpenAIAuth =
    hasOpenAIKey || (headers.has('authorization') && !headers.has('x-api-key') && !bearerIsAnthropic);
  return pathname === '/v1/chat/completions'
    || pathname === '/v1/responses'
    || pathname.startsWith('/v1/responses/')
    || isChatGPTBackendPath(pathname)
    || (isModelsPath && looksOpenAIAuth);
}

/** anthropic-beta values count_tokens has rejected in this process. Clients
 *  (e.g. Claude Code) may send betas that /v1/messages accepts but
 *  /v1/messages/count_tokens does not; we learn them from the 400 and drop them. */
const COUNT_TOKENS_REJECTED_BETAS_MAX = 64;
const countTokensRejectedBetas = new Set<string>();
const REJECTED_BETA_RE = /Unexpected value\(s\) (.+?) for the `anthropic-beta` header/;

/** Extract beta names a count_tokens 400 complained about (backtick-quoted). */
export function parseRejectedBetas(errorBody: string): string[] {
  let msg = errorBody;
  try {
    const j = JSON.parse(errorBody) as { error?: { message?: unknown } };
    if (typeof j?.error?.message === 'string') msg = j.error.message;
  } catch { /* not JSON — scan raw text */ }
  const m = REJECTED_BETA_RE.exec(msg);
  if (!m) return [];
  return [...(m[1] ?? '').matchAll(/`([^`]+)`/g)].map((x) => (x[1] ?? '').trim()).filter(Boolean);
}

function dropRejectedBetas(headers: Headers): void {
  const raw = headers.get('anthropic-beta');
  if (!raw || countTokensRejectedBetas.size === 0) return;
  const kept = raw.split(',').map((b) => b.trim()).filter((b) => b && !countTokensRejectedBetas.has(b));
  if (kept.length) headers.set('anthropic-beta', kept.join(','));
  else headers.delete('anthropic-beta');
}

/** Test hook. */
export function resetCountTokensRejectedBetasForTests(): void {
  countTokensRejectedBetas.clear();
}

/** POST /v1/messages/count_tokens with the given body. Returns the upstream's
 *  `input_tokens` number or null on any failure. count_tokens is documented
 *  as a free endpoint (no input-token billing) — we use it once per request
 *  on the PRE-COMPRESSION body to get the ground-truth baseline. Actual
 *  post-compression tokens already come back free in the /v1/messages usage
 *  block (input_tokens + cache_create + cache_read), so no second probe. */
async function countTokensUpstream(
  countTokensUrl: string,
  body: Uint8Array,
  headers: Headers,
  onError?: (reason: string) => void,
  retried = false,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  parentSignal?: AbortSignal,
): Promise<number | null> {
  let res: Response | undefined;
  try {
    if (parentSignal?.aborted) return null;
    const reqHeaders = new Headers(headers);
    dropRejectedBetas(reqHeaders);
    res = await fetchImpl(countTokensUrl, {
      method: 'POST',
      headers: reqHeaders,
      body: body as unknown as BodyInit,
      redirect: 'manual',
      signal: combineAbortSignals(COUNT_TOKENS_TIMEOUT_MS, parentSignal),
    });
    if (res.status === 400 && !retried) {
      const text = await res.text().catch(() => '');
      const rejected = parseRejectedBetas(text);
      if (rejected.length > 0 && rejected.some((b) => !countTokensRejectedBetas.has(b))) {
        for (const b of rejected) {
          if (countTokensRejectedBetas.size >= COUNT_TOKENS_REJECTED_BETAS_MAX) break;
          countTokensRejectedBetas.add(b);
        }
        return countTokensUpstream(countTokensUrl, body, reqHeaders, onError, true, fetchImpl, parentSignal);
      }
      onError?.(`http_400${text ? ` ${text.slice(0, 300)}` : ''}`);
      return null;
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        await res.body?.cancel().catch(() => undefined);
      }
      onError?.(`http_${res.status}${detail ? ` ${detail}` : ''}`);
      return null;
    }
    const json = (await res.json()) as { input_tokens?: unknown };
    if (typeof json.input_tokens === 'number') return json.input_tokens;
    onError?.('no_input_tokens_in_response');
    return null;
  } catch (e) {
    await res?.body?.cancel().catch(() => undefined);
    onError?.(`fetch_error ${(e as Error)?.name ?? ''}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return null;
  }
}

const preferredGoogleCountShapeByHost = new Map<string, 0 | 1>();

export function resetGoogleCountShapePreferenceForTests(): void {
  preferredGoogleCountShapeByHost.clear();
}

async function countGoogleTokensUpstream(
  countTokensUrl: string,
  body: Uint8Array,
  headers: Headers,
  model: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  parentSignal?: AbortSignal,
): Promise<number | null> {
  try {
    const rawParsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    const request = (rawParsed.request && typeof rawParsed.request === 'object' && !Array.isArray(rawParsed.request))
      ? (rawParsed.request as Record<string, unknown>)
      : rawParsed;
    const shapeBare = JSON.stringify(request);
    const shapeWrapped = JSON.stringify({ generateContentRequest: { ...request, model: `models/${model}` } });
    let host = '';
    try {
      host = new URL(countTokensUrl).host;
    } catch {}
    const preferred = (host ? preferredGoogleCountShapeByHost.get(host) : undefined) ?? 0;
    const orderedShapes: readonly string[] = preferred === 1
      ? [shapeWrapped, shapeBare]
      : [shapeBare, shapeWrapped];
    const deadline = Date.now() + COUNT_TOKENS_TIMEOUT_MS;
    const perShapeTimeout = Math.floor(COUNT_TOKENS_TIMEOUT_MS / orderedShapes.length);
    for (const countBody of orderedShapes) {
      if (parentSignal?.aborted) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      let res: Response | undefined;
      try {
        res = await fetchImpl(countTokensUrl, {
          method: 'POST',
          headers,
          body: countBody,
          redirect: 'manual',
          signal: combineAbortSignals(Math.min(remainingMs, perShapeTimeout), parentSignal),
        });
        if (res.ok) {
          const json = (await res.json()) as { totalTokens?: unknown };
          if (typeof json.totalTokens === 'number') {
            if (host) preferredGoogleCountShapeByHost.set(host, countBody === shapeWrapped ? 1 : 0);
            return json.totalTokens;
          }
        } else {
          await res.body?.cancel().catch(() => {});
        }
      } catch {
        await res?.body?.cancel().catch(() => {});
        // try next payload shape
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve upstream URLs from config. Pure — unit-testable.
 *
 * Every env-derived input is trimmed of leading/trailing whitespace before
 * URL construction, and trailing slashes are stripped so `base + path` joins
 * cleanly. The trim is defensive: a stray space in OPENAI_UPSTREAM /
 * ANTHROPIC_UPSTREAM / INKLING_GATEWAY_BASE_URL (commonly introduced by
 * cmd.exe `set VAR=...`, a copy-paste with a trailing space, or a shell
 * quoting bug in a launcher script) would otherwise build URLs like
 * "https://api.openai.com /v1/..." — fetch() then throws
 * "Failed to parse URL" with no actionable log line, and the operator is
 * left guessing. Trimming at the URL boundary keeps the failure mode loud
 * (the proxy still returns a real 401/502 from upstream) instead of silent.
 */
export function resolveUpstreams(config: ProxyConfig): {
  anthropic: string;
  openai: string;
  stripOpenAIV1: boolean;
} {
  if (config.provider === 'cloudflare-ai-gateway') {
    const base = (config.gatewayBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) {
      throw new Error(
        "provider 'cloudflare-ai-gateway' requires gatewayBaseUrl (INKLING_GATEWAY_BASE_URL)",
      );
    }
    return { anthropic: `${base}/anthropic`, openai: `${base}/openai`, stripOpenAIV1: true };
  }
  return {
    anthropic: (config.upstream ?? DEFAULT_UPSTREAM).trim().replace(/\/+$/, ''),
    openai: (config.openAIUpstream ?? DEFAULT_OPENAI_UPSTREAM).trim().replace(/\/+$/, ''),
    stripOpenAIV1: false,
  };
}

/** Parse INKLING_GATEWAY_HEADERS — JSON object or `k=v;k2=v2`. */
export function parseGatewayHeaders(spec: string | undefined): Record<string, string> {
  if (!spec) return {};
  const trimmed = spec.trim();
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = String(v);
    return out;
  }
  const out: Record<string, string> = {};
  for (const pair of trimmed.split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function extractHostname(hostHeader: string | null): string {
  if (!hostHeader) return '';
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end !== -1 ? trimmed.slice(1, end) : trimmed;
  }
  const colon = trimmed.indexOf(':');
  return colon !== -1 ? trimmed.slice(0, colon) : trimmed;
}

function stripTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.charCodeAt(end - 1) === 47) {
    end--;
  }
  return str.slice(0, end);
}

function urlTargetsBase(targetUrl: string, base: string): boolean {
  const trimmed = stripTrailingSlashes(base.trim());
  if (!trimmed) return false;
  if (targetUrl === trimmed) return true;
  return targetUrl.startsWith(`${trimmed}/`) || targetUrl.startsWith(`${trimmed}?`);
}

function stripAnthropicCredentials(headers: Headers): void {
  if (/\bsk-ant-/i.test(headers.get('authorization') ?? '')) headers.delete('authorization');
  if (/\bsk-ant-/i.test(headers.get('x-api-key') ?? '')) headers.delete('x-api-key');
  headers.delete('x-anthropic-billing-header');
}

function resolveGoogleUpstream(
  req: Request,
  pathname: string,
  passthroughUpstream: string,
  config: ProxyConfig,
): string {
  if (config.googleUpstream) {
    return stripTrailingSlashes(config.googleUpstream.trim());
  }
  if (config.provider === 'cloudflare-ai-gateway') {
    return passthroughUpstream;
  }
  const host = extractHostname(req.headers.get('host'));
  if (host === 'daily-cloudcode-pa.googleapis.com' || host === 'cloudcode-pa.googleapis.com' || pathname.startsWith('/v1internal:')) {
    return host === 'cloudcode-pa.googleapis.com'
      ? 'https://cloudcode-pa.googleapis.com'
      : 'https://daily-cloudcode-pa.googleapis.com';
  }
  if (host === 'generativelanguage.googleapis.com') {
    return 'https://generativelanguage.googleapis.com';
  }
  if (passthroughUpstream !== DEFAULT_UPSTREAM && !passthroughUpstream.endsWith('/anthropic')) {
    return passthroughUpstream;
  }
  return 'https://generativelanguage.googleapis.com';
}

/** Build the proxy fetch handler. */
export function createProxy(config: ProxyConfig = {}) {
  const modelRoutes = new Map<string, 'openai' | 'cloudflare'>();
  const inFlight = new Map<string, { lease: symbol; startedAt: number }>();
  // Entries are released by their holder on every exit path, but the key space is
  // unbounded (one per distinct body) and the map outlives every request, so a single
  // missed release would leak for the daemon's lifetime. An entry past the hold window
  // is already ignored by the duplicate check below, so expiring it costs nothing and
  // bounds the map by real in-window concurrency instead of by release correctness.
  let lastSweptAt = 0;
  const headersTimeoutMs = config.upstreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS;
  const idleTimeoutMs = config.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
  const duplicateHoldMs = config.duplicateHoldMs ?? DEFAULT_DUPLICATE_HOLD_MS;
  const maxRequestBytes = resolveMaxRequestBytes(config.maxRequestBytes);
  const oversizedBodyPolicy = config.oversizedBodyPolicy ?? 'reject';
  // Explicit precedence: Cloudflare > OpenAI > normal family routing.
  for (const model of config.openAIModels ?? []) {
    const id = model.trim();
    if (id) modelRoutes.set(id, 'openai');
  }
  for (const model of config.cloudflareModels ?? []) {
    const id = model.trim();
    if (id) modelRoutes.set(id, 'cloudflare');
  }
  if ((config.cloudflareModels?.length ?? 0) > 0 && config.cloudflareUpstream === undefined) {
    throw new Error('cloudflareModels requires a Cloudflare chat upstream');
  }
  const routes = resolveUpstreams(config);
  const upstream = routes.anthropic;
  const openAIUpstream = routes.openai;
  // Same trim policy as resolveUpstreams: keep provider-prefixed passthroughs
  // (e.g. /openai/*, /google-ai-studio/*) safe from env whitespace — see the
  // JSDoc on resolveUpstreams for the full rationale.
  const gatewayBase = stripTrailingSlashes((config.gatewayBaseUrl ?? '').trim());
  const passthroughUpstream = config.provider === 'cloudflare-ai-gateway'
    ? gatewayBase
    : upstream;
  const gatewayHeaders = config.gatewayHeaders ?? {};
  const applyGatewayHeadersIfTargeted = (h: Headers, targetUrl: string): Headers => {
    if (gatewayBase !== '' && urlTargetsBase(targetUrl, gatewayBase)) {
      for (const [k, v] of Object.entries(gatewayHeaders)) h.set(k, v);
    }
    return h;
  };

  return async function handle(req: Request): Promise<Response> {
    const t0 = Date.now();
    const url = new URL(req.url);
    const path = url.pathname + url.search;

    // inkling speaks HTTP only. A WebSocket handshake forwarded as a plain GET
    // comes back 405 from chatgpt.com, and Codex's built-in provider then
    // retries the socket several times before falling back. 426 is the answer
    // it takes as "use HTTP" on the first try (measured, codex-cli 0.167.1).
    if ((req.headers.get('upgrade') ?? '').toLowerCase().includes('websocket')) {
      return new Response(JSON.stringify({ error: { type: 'websocket_unsupported', message: 'fiche proxies HTTP only; retry over HTTP' } }), {
        status: 426,
        headers: { 'content-type': 'application/json', connection: 'close' },
      });
    }

    // Reversibly disguise the configured upstream id for Claude Code's model
    // picker, matching CLIProxyAPI. The id decodes back to the exact provider
    // model on /v1/messages, so discovery and routing cannot drift apart.
    if (req.method === 'GET' && url.pathname === '/v1/models' && modelRoutes.size > 0) {
      const models = [...modelRoutes].map(([model, route]) => ({
            id: claudeGatewayModelId(model),
            type: 'model',
            display_name: routedModelDisplayName(model, route),
            created_at: '1970-01-01T00:00:00Z',
          }));
      return new Response(JSON.stringify({
        data: models,
        has_more: false,
        first_id: models[0]?.id ?? '',
        last_id: models.at(-1)?.id ?? '',
      }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // reqBodyBytes: kept for lazy gzip on 4xx. reqBodySha8: computed eagerly for correlation.
    let reqBodyBytes: Uint8Array | undefined;
    let reqBodySha8: string | undefined;
let responseContentType: string | undefined;
    let responseContentEncoding: string | undefined;
    let reqBodySha256: string | undefined;
    // Set once the transform returns; read by fire() at event time.
    let transformMs: number | undefined;
    // Why the baseline count_tokens probe failed (status + upstream error), if it did.
    let baselineProbeError: string | undefined;
    const fetchImpl = config.fetch ?? globalThis.fetch;
    const upstreamAbort = new AbortController();
    const clientSignal = req.signal;
    let clientAbortWired = false;
    const onClientAbort = (): void => {
      if (!upstreamAbort.signal.aborted) {
        upstreamAbort.abort(clientSignal?.reason ?? new Error('fiche: client disconnected'));
      }
    };
    const ensureClientAbortWired = (): void => {
      if (clientAbortWired || !clientSignal) return;
      clientAbortWired = true;
      if (clientSignal.aborted) onClientAbort();
      else clientSignal.addEventListener('abort', onClientAbort, { once: true });
    };
    const detachClientAbort = (): void => {
      if (!clientAbortWired || !clientSignal) return;
      clientAbortWired = false;
      clientSignal.removeEventListener('abort', onClientAbort);
    };

    const fire = (
      status: number,
      info?: TransformInfo,
      error?: string,
      firstByteMs?: number,
      usage?: Usage,
      errorBody?: string,
      measurement?: OutputMeasurement,
      stopReason?: string,
    ): Promise<void> => {
      const is4xx = status >= 400 && status < 500;
      // Gzip body lazily (only on 4xx).
      const finalize = async (): Promise<void> => {
        let reqBodyGz: Uint8Array | undefined;
        if (config.captureErrorReqBody && is4xx && reqBodyBytes && reqBodyBytes.byteLength > 0) {
          try {
            reqBodyGz = await gzipBytes(reqBodyBytes);
          } catch {
            // Non-fatal — drop body sample.
          }
        }
        // Await both count_tokens probes so baseline numbers land on the same event row.
        // Each probe is independent; null leaves the field absent and dashboard math degrades cleanly.
        if (info && baselineStatusApplies) {
          // Track both halves so the dashboard can gate on probe completeness (partial vs ok).
          // A missing cacheable-prefix probe must NOT be treated as cacheable=0 — that fabricates savings.
          let baselineResolved: number | null = null;
          let cacheableExpected = false;
          let cacheableResolved: number | null = null;
          if (baselinePromise) {
            try {
              baselineResolved = await baselinePromise;
              if (baselineResolved !== null) info.baselineTokens = baselineResolved;
            } catch {
              /* probe threw — drop */
            }
          }
          if (baselineCacheablePromise) {
            cacheableExpected = true;
            try {
              cacheableResolved = await baselineCacheablePromise;
              if (cacheableResolved !== null) info.baselineCacheableTokens = cacheableResolved;
            } catch {
              /* probe threw */
            }
          }
          if (baselineResolved === null) {
            info.baselineProbeStatus = 'failed';
            if (baselineProbeError) info.baselineProbeError = baselineProbeError;
          } else if (cacheableExpected && cacheableResolved === null) {
            info.baselineProbeStatus = 'partial'; // dashboard excludes row; must not treat as cacheable=0
          } else if (threadContinue) {
            // Delta-only baseline vs full-thread usage: rollups must exclude the row.
            info.baselineProbeStatus = 'partial';
          } else {
            info.baselineProbeStatus = 'ok';
          }
          if (threadContinue) info.threadContinue = true;
        }
        // The Messages compatibility response exposes Anthropic's disjoint
        // usage buckets to the client. Dashboard accounting still needs the
        // original Responses/Chat semantics: input includes the cached subset.
        let eventUsage = usage;
        if ((bridgedGptMessages || bridgedChatMessages) && usage) {
          const converted: Usage = {
            ...usage,
            input_tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
            cached_tokens: usage.cache_read_input_tokens ?? 0,
          };
          if (bridgedChatMessages) delete converted.cache_read_input_tokens;
          eventUsage = converted;
        }
        await config.onRequest?.({
          method: req.method,
          path: url.pathname,
          model: requestModel,
          // Provider-prefixed OpenCode routes such as `/openai/responses` are
          // Responses-shaped even though they are not canonical `/v1/*` paths.
          // Classify by the parsed wire route, otherwise the dashboard ignores
          // GPT image/baseline telemetry and renders As text / Saved as dashes.
          accountingProvider: isGoogleRoute
            ? 'google'
            : isOpenAIChatWire || isOpenAIResponsesWire || bridgedGptMessages || bridgedChatMessages
              ? 'openai'
              : 'anthropic',
          status,
          durationMs: Date.now() - t0,
          firstByteMs,
          transformMs,
          info,
          usage: eventUsage,
          error,
          errorBody,
          reqBodySha8,
          reqBodyGz,
          measurement,
          stopReason,
          responseContentType,
          responseContentEncoding,
        });
      };
      return finalize();
    };
    const fireWait = (...args: Parameters<typeof fire>): void => {
      const p = fire(...args);
      config.waitUntil?.(p);
    };

    // Transform only known shapes; everything else passes through.
    // Explicit per-request opt-out (#111): a subprocess that merely inherited
    // ANTHROPIC_BASE_URL (e.g. a plugin's internal `claude` probe) can send
    // `x-fiche-bypass: 1` (or legacy `x-inkling-bypass: 1`) via ANTHROPIC_CUSTOM_HEADERS
    // to have its traffic forwarded byte-for-byte untouched.
    const bypassHeader = req.headers.get('x-fiche-bypass') ?? req.headers.get('x-inkling-bypass');
    const bypass = bypassHeader !== null && !/^(?:0|false|off|no)$/i.test(bypassHeader.trim());
    const ficheSessionRaw = (req.headers.get('x-fiche-session-id') ?? req.headers.get('x-inkling-session-id'))?.trim() ?? null;
    const ccSessionRaw = req.headers.get('x-claude-code-session-id')?.trim() ?? null;
    const validatedFicheSessionId =
      ficheSessionRaw !== null && /^[A-Za-z0-9._:-]{4,128}$/.test(ficheSessionRaw)
        ? ficheSessionRaw
        : undefined;
    const validatedCcSessionId =
      ccSessionRaw !== null && /^[A-Za-z0-9_-]{8,128}$/.test(ccSessionRaw)
        ? ccSessionRaw
        : undefined;
    const validatedClientSessionId = validatedFicheSessionId ?? validatedCcSessionId;
    const validatedClientSessionSource: 'fiche-header' | 'claude-code-header' | undefined =
      validatedFicheSessionId
        ? 'fiche-header'
        : validatedCcSessionId
          ? 'claude-code-header'
          : undefined;
    const registry = config.upstreamRegistry ?? DEFAULT_UPSTREAM_REGISTRY;
    const rawProviders = typeof config.enabledProviders === 'function'
      ? config.enabledProviders()
      : config.enabledProviders;
    const activeProviderSet = rawProviders ? new Set<string>(rawProviders) : undefined;
    const followed = config.followHosts
      ? resolveFollowTarget(url, req.headers.get('host'), registry, activeProviderSet)
      : refuseUnfollowedProviderHost(req.headers.get('host'), registry);
    const followRefusal = isFollowRefusal(followed) ? followed : null;
    /** Set when this request goes to the agent's own third-party host. */
    const follow = isFollowRefusal(followed) ? null : followed;
    // Followed hosts mount their API under a prefix (`/anthropic`, `/api`, ...);
    // classify on the canonical path, forward the original one.
    const wirePathname = follow ? follow.wirePathname : url.pathname;
    const providerPrefixed = !follow && isProviderPrefixedPath(url.pathname);
    // Wire-shape detection stays independent from transform eligibility. A
    // bypassed Codex request is still an OpenAI Responses request for routing,
    // accounting, and response scanning; only its body transformation is off.
    const isMessagesWire = req.method === 'POST' && isAnthropicMessagesPath(wirePathname);
    const isOpenAIChatWire = req.method === 'POST' && isOpenAIChatPath(wirePathname);
    const isOpenAIResponsesWire = req.method === 'POST' && isOpenAIResponsesPath(wirePathname);
    const isMessages = !bypass && isMessagesWire;
    const isOpenAIChat = !bypass && isOpenAIChatWire;
    const isOpenAIResponses = !bypass && isOpenAIResponsesWire;
    const googleModelFromPath = req.method === 'POST' && !follow
      ? parseGoogleModelFromPath(url.pathname)
      : null;
    const isGoogleInference = req.method === 'POST' && !follow && isGoogleInferencePath(url.pathname);
    const isGoogleRoute = googleModelFromPath !== null || isGoogleInference;
    const isGoogle = isGoogleRoute && !bypass;
    const isGoogleFamily = !follow && (isGoogleRoute || isGoogleFamilyPath(url.pathname));
    const isOpenAIPath = !follow && isCanonicalOpenAIPath(
      url.pathname,
      req.headers,
      config.openAIApiKey !== undefined,
    );
    const googleUpstream = resolveGoogleUpstream(req, url.pathname, passthroughUpstream, config);
    const upstreamBase = follow
      ? follow.origin
      : isGoogleFamily
      ? googleUpstream
      : providerPrefixed
        ? passthroughUpstream
        : isOpenAIPath ? openAIUpstream : upstream;

    let bodyOut: BodyInit | null = null;
    /** Set when `decodeRequestBody` undid the request Content-Encoding. */
    let requestBodyDecoded = false;
    let info: TransformInfo | undefined;
    let requestModel: string | undefined = googleModelFromPath ?? undefined;
    let bridgedGptMessages = false;
    let bridgedChatMessages = false;
    let modelRouteForRequest: 'openai' | 'cloudflare' | undefined;

    // Two count_tokens probes on the pre-compression body (see docs/HISTORY_CACHE_MODEL.md):
    //   baselinePromise          → full-body input_tokens
    //   baselineCacheablePromise → input_tokens truncated at last cache_control marker
    // Dashboard combines them for cache-aware baseline. Both run in parallel with the main forward.
    let baselinePromise: Promise<number | null> | undefined;
    let baselineCacheablePromise: Promise<number | null> | undefined;
    let baselineStatusApplies = false;
    // Server-side thread continuation: probe sees only delta while provider bills full thread.
    let threadContinue = false;
    let responsesStreaming = false;
    let isAnthropicMessagesRoute = false;

    // Refused here, not at resolution: fire() reads the per-request state above.
    if (followRefusal) {
      fireWait(followRefusal.status, undefined, followRefusal.message);
      return new Response(JSON.stringify({ error: followRefusal.reason, message: followRefusal.message }), {
        status: followRefusal.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Default-deny on the stock Anthropic upstream: a path outside every known
    // family (an agent we do not recognise, a stray browser fetch) would
    // otherwise reach api.anthropic.com with the host's keys injected. A
    // custom gateway upstream keeps forwarding unknown paths, since the
    // operator chose where they go.
    if (upstreamBase === DEFAULT_UPSTREAM
      && !isAnthropicFamilyPath(url.pathname)
      && !isMessagesWire) {
      fireWait(404, undefined, `unknown_route: ${url.pathname.slice(0, 200)}`);
      return new Response(JSON.stringify({
        error: 'unknown_route',
        message: `fiche does not forward ${url.pathname}; see docs/SECURITY_MODEL.md`,
      }), { status: 404, headers: { 'content-type': 'application/json' } });
    }

    if (bypass && isOpenAIResponsesWire
      && (req.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
      responsesStreaming = await readStreamFieldFromClone(req);
    }

    if (isMessages || isOpenAIChat || isOpenAIResponses || isGoogle) {
      // Transformable routes have to hold the whole body to rewrite it, so this
      // is the one place a caller could otherwise choose how much memory fiche
      // allocates. Bound the read before allocating past `maxRequestBytes`.
      //
      // Under `'passthrough'` (loopback Node), a body past the ceiling streams
      // straight upstream untouched so multimodal payloads are never broken by
      // a local cap — except when `/v1/messages` model-bridging is configured,
      // where forwarding unparsed Anthropic JSON could cross provider boundaries.
      const canStreamOversized =
        oversizedBodyPolicy === 'passthrough' && !(isMessages && modelRoutes.size > 0);
      const bounded = await readBodyBounded(req, maxRequestBytes, canStreamOversized);
      if (!bounded.ok) {
        if (canStreamOversized) {
          bodyOut = bounded.restoredBody ?? null;
          info = {
            compressed: false,
            reason: 'body_too_large',
            origChars: 0,
            compressedChars: 0,
            imageCount: 0,
            imageBytes: 0,
            staticChars: 0,
            dynamicChars: 0,
            dynamicBlockCount: 0,
          };
        } else {
          const message =
            `request body exceeds the ${maxRequestBytes}-byte fiche limit ` +
            `(${bounded.declaredBytes !== undefined ? `declared ${bounded.declaredBytes}, ` : ''}` +
            `read ${bounded.observedBytes})`;
          const error = isMessages
            ? { type: 'error', error: { type: 'request_too_large', message } }
            : { error: { type: 'request_too_large', message } };
          // Emit like the serialized-size 413 below: a rejected request is still a
          // dashboard row, otherwise over-limit clients are invisible.
          fireWait(413, undefined, message);
          return new Response(JSON.stringify(error), {
            status: 413,
            headers: { 'content-type': 'application/json' },
          });
        }
      } else {
        let bodyIn = bounded.bytes;
        const contentEncoding = (req.headers.get('content-encoding') ?? '').trim();
        if (contentEncoding !== '' && contentEncoding.toLowerCase() !== 'identity' && config.decodeRequestBody) {
          const decoded = config.decodeRequestBody(bodyIn, contentEncoding, maxRequestBytes);
          if (decoded) {
            bodyIn = decoded;
            requestBodyDecoded = true;
          }
        }
        const encodedUndecoded =
          contentEncoding !== '' && contentEncoding.toLowerCase() !== 'identity' && !requestBodyDecoded;
        try {
          const baseTransformOpts = withClientToolRoundShape(
            typeof config.transform === 'function' ? config.transform() : config.transform,
            req.headers,
          );
          // Bytes still under a coding we did not undo must not be rewritten: the
          // header would go out unchanged and the upstream would try to decompress
          // whatever the transform produced. Forward them as they came.
          const transformOpts = encodedUndecoded
            ? { ...baseTransformOpts, compress: false }
            : baseTransformOpts;
          // Fail-closed: unreadable model → no compression, not a risky guess.
          const model = googleModelFromPath ?? readModelField(bodyIn);
          if (isOpenAIResponses) responsesStreaming = readStreamField(bodyIn);
          requestModel = model ?? undefined;
          // A turn whose only content is `@inkling pin` / `@inkling unpin` is
          // configuration, not a question. Answer it here unless compression is
          // paused/disabled: passthrough mode must forward `@fiche pin` untouched.
          if (transformOpts?.compress !== false && (isMessages || isOpenAIChat || isOpenAIResponses)) {
            try {
              const pinReply = isMessages
                ? pinCommandResponse(bodyIn)
                : pinCommandResponseOpenAI(bodyIn, isOpenAIResponses ? 'responses' : 'chat');
              if (pinReply) {
                return new Response(pinReply.body, {
                  status: 200,
                  headers: {
                    'content-type': pinReply.contentType,
                    'cache-control': 'no-cache',
                  },
                });
              }
            } catch {
              // Fail open: malformed pin parsing must never abort a live agent request.
            }
          }
          // /v1/messages is only a wire schema: Claude Code can target a non-
          // Anthropic model (for example GPT-5.6 Sol). Do not apply Claude's
          // renderer or Anthropic count_tokens merely because the route is
          // Messages-shaped. Enabled GPT models take the standalone
          // Messages→Responses bridge; unsupported models still fail closed.
          // Claude Code model aliases decode back to exact Cloudflare model IDs.
          const decodedByAlias = [...modelRoutes.keys()]
            .find((candidate) => claudeGatewayModelId(candidate) === model);
          const decodedChatModel = decodedByAlias ?? resolveClaudeGatewayModelId(model);
          const routedModel = decodedChatModel ?? model;
          // A followed host answers for its own models; never bridge them elsewhere.
          const modelRoute = routedModel && !follow ? modelRoutes.get(routedModel) : undefined;
          modelRouteForRequest = modelRoute;
          const forceChat = isMessages && modelRoute === 'cloudflare';
          const messagesAnthropic = isMessages
            && modelRoute === undefined && !forceChat && (Boolean(follow) || isClaudeModel(model));
          isAnthropicMessagesRoute = messagesAnthropic;
          // Provider routing is explicit. Unlisted Messages models use the
          // default Anthropic route, regardless of how their id is shaped.
          bridgedGptMessages =
            isMessages && !messagesAnthropic && !forceChat
            && modelRoute === 'openai';
          // Messages → Chat Completions bridge toward Cloudflare Workers AI.
          bridgedChatMessages = forceChat;
          const chatStamp = bridgedChatMessages ? routedModel : undefined;
          const effectiveModel = (bridgedGptMessages || bridgedChatMessages) ? routedModel : model;
          // Gemini is in DEFAULT_MODEL_BASES as the family base `gemini`; the same
          // allowlist gates it so INKLING_MODELS / the chip can opt out.
          const modelOk = isGoogle
            ? (isGeminiModel(model) && isInklingSupportedModel(model))
            : isMessages
              ? (messagesAnthropic && isInklingSupportedModel(model))
                || (bridgedGptMessages && isInklingSupportedGptModel(effectiveModel))
                || (bridgedChatMessages && isInklingSupportedGptModel(effectiveModel))
              : isInklingSupportedGptModel(model);
          // Compression eligibility and telemetry follow the model that actually
          // receives the request, not Claude Code's local gateway alias.
          if ((bridgedGptMessages || bridgedChatMessages) && effectiveModel) {
            requestModel = effectiveModel;
          }
          const bridgeBody = bridgedGptMessages
            ? (() => {
                const bridged = JSON.parse(new TextDecoder().decode(
                  anthropicMessagesToOpenAIResponses(bodyIn),
                )) as Record<string, unknown>;
                bridged.model = effectiveModel;
                return new TextEncoder().encode(JSON.stringify(bridged));
              })()
            : bridgedChatMessages
              ? anthropicMessagesToOpenAIChat(bodyIn, chatStamp ?? undefined)
              : bodyIn;
          const routeModel = effectiveModel ?? model ?? undefined;
          // Third-party hosts never get the OpenAI-only breakpoint field.
          const allowBreakpoints = !follow && supportsExplicitPromptCacheBreakpoint({
            pathname: url.pathname,
            upstream: openAIUpstream,
          });
          // Allowlisted models image, except weak or unmeasured readers (Claude
          // 5.5, Grok, Gemini 4 hydrogen/carbon, DeepSeek, Kimi, GLM, MiniMax),
          // which stay text unless INKLING_FORCE_IMAGES=1. When compression is not
          // switched off, weak/text-only/third-party models still receive
          // prefix-safe deterministic text hygiene (`imageCompress: false`).
          const imageThisRequest =
            transformOpts?.stageToggles?.optical !== false &&
            shouldImageModel(routeModel, modelOk);
          const hygieneForcedOn = resolveTextHygieneMode(transformOpts?.textHygiene) === 'on';
          const familyInScope = modelOk || isInConfiguredModelBases(routeModel);
          const killSwitchOff = transformOpts?.compress === false || (!familyInScope && !hygieneForcedOn);
          const effectiveOpts = killSwitchOff
            ? { ...transformOpts, compress: false, explicitPromptCacheBreakpoints: allowBreakpoints }
            : imageThisRequest
              ? { ...transformOpts, imageCompress: true, explicitPromptCacheBreakpoints: allowBreakpoints }
              : { ...transformOpts, imageCompress: false, explicitPromptCacheBreakpoints: allowBreakpoints };
          // Local render+encode cost only. The Google branch below issues upstream
          // count_tokens probes, so the timer closes here rather than after them —
          // otherwise network latency would be charged to our own CPU.
          const tTransform = Date.now();
          // Fail open: a renderer or transform bug must never cost the user a
          // turn. The request goes out as it arrived (after any wire bridge, which
          // the upstream needs), and the event row records why.
          const sessionTransformOpts = validatedClientSessionId && validatedClientSessionSource
            ? {
                clientSessionId: validatedClientSessionId,
                clientSessionSource: validatedClientSessionSource,
              }
            : undefined;
          const optsWithSession = sessionTransformOpts
            ? { ...effectiveOpts, ...sessionTransformOpts }
            : effectiveOpts;
          let r: { body: Uint8Array; info: TransformInfo };
          try {
            r = isGoogle
              ? await transformGoogleGenerateContent(bridgeBody, model!, optsWithSession)
              : isMessages
                ? bridgedGptMessages
                  ? await transformOpenAIResponses(bridgeBody, optsWithSession)
                  : bridgedChatMessages
                    ? await transformOpenAIChatCompletions(bridgeBody, optsWithSession)
                    : await transformRequest(bridgeBody, {
                        ...optsWithSession,
                        model: effectiveModel ?? undefined,
                      })
                : isOpenAIChat
                  ? await transformOpenAIChatCompletions(bridgeBody, optsWithSession)
                  : await transformOpenAIResponses(bridgeBody, optsWithSession);
          } catch (e) {
            r = { body: bridgeBody, info: failOpenInfo(bridgeBody, (e as Error).message) };
          }
          if (!allowBreakpoints && (isOpenAIResponses || isOpenAIChat || bridgedGptMessages || bridgedChatMessages)) {
            try {
              r = { ...r, body: scrubPromptCacheBreakpoint(r.body) };
            } catch {
              // Fail open if response/body scrubbing encounters an unexpected shape.
            }
          }
          transformMs = Date.now() - tTransform;
          // CloudCode PA (`/v1internal:*`) has no `:countTokens` endpoint, and
          // text-hygiene-only turns already have exact local token deltas.
          if (
            isGoogle &&
            r.info.compressed &&
            (r.info.imageCount ?? 0) > 0 &&
            !url.pathname.startsWith('/v1internal:')
          ) {
            try {
              const countUrl = new URL(
                (isGoogleRoute ? googleUpstream : passthroughUpstream) + url.pathname.replace(
                  /:(?:generateContent|streamGenerateContent)$/,
                  ':countTokens',
                ),
              );
              for (const [key, value] of url.searchParams) countUrl.searchParams.append(key, value);
              countUrl.searchParams.delete('alt');
              const countHeaders = applyGatewayHeadersIfTargeted(
                filterHeaders(req.headers, STRIP_REQ_HEADERS),
                countUrl.toString(),
              );
              stripAnthropicCredentials(countHeaders);
              countHeaders.delete('content-encoding');
              countHeaders.set('content-type', 'application/json');
              const syncProbeEnv = readBrandEnv('GOOGLE_SYNC_PROBE') ?? '';
              const googleSyncProbe = !/^(0|false|no|off)$/i.test(syncProbeEnv.trim());
              ensureClientAbortWired();
              if (googleSyncProbe) {
                const [baseline, transformed] = await Promise.all([
                  countGoogleTokensUpstream(countUrl.toString(), bodyIn, countHeaders, model!, fetchImpl, upstreamAbort.signal),
                  countGoogleTokensUpstream(countUrl.toString(), r.body, countHeaders, model!, fetchImpl, upstreamAbort.signal),
                ]);
                if (baseline !== null && transformed !== null) {
                  if (transformed >= baseline) {
                    r = {
                      body: bodyIn,
                      info: revertedGoogleInfo(
                        r.info,
                        `not_profitable (${transformed} >= ${baseline} tokens)`,
                        'ok',
                      ),
                    };
                  } else {
                    r.info.baselineTokens = baseline;
                    r.info.baselineProbeStatus = 'ok';
                  }
                } else {
                  // Upstream gateway does not route :countTokens (e.g. Cloudflare AI Gateway).
                  // Retain local profitability decision computed by transformGoogleGenerateContent.
                  r.info.baselineProbeStatus = 'failed';
                }
              } else {
                baselineStatusApplies = true;
                baselinePromise = countGoogleTokensUpstream(countUrl.toString(), bodyIn, countHeaders, model!, fetchImpl, upstreamAbort.signal);
              }
            } catch {
              r.info.baselineProbeStatus = 'failed';
            }
          }
          if (!modelOk && !r.info.compressed && r.info.reason !== 'mmu_hydrate') r.info.reason = 'unsupported_model';
          bodyOut = r.body as unknown as BodyInit; // TS narrows Uint8Array away from BodyInit
          info = r.info;
          reqBodyBytes = r.body;
          r.info.serializedRequestBytes = r.body.byteLength;
          if (r.body.byteLength > 0) {
            reqBodySha256 = await sha256Bytes(r.body);
            reqBodySha8 = reqBodySha256.slice(0, 8);
          }
          let requestByteLimit: number | undefined;
          try {
            requestByteLimit = requestModel
              ? resolveGptProfile(requestModel).maxSerializedRequestBytes
              : undefined;
          } catch {
            requestByteLimit = undefined;
          }
          if ((r.info.compressed || r.body !== bridgeBody) && requestByteLimit !== undefined) {
            if (r.body.byteLength > requestByteLimit) {
              r.info.sizeLimitOutcome = 'rejected';
              const message = `fiche serialized request exceeds model limit (${r.body.byteLength} > ${requestByteLimit} bytes)`;
              fireWait(413, r.info, message);
              const error = isMessages
                ? { type: 'error', error: { type: 'request_too_large', message } }
                : { error: { type: 'request_too_large', message } };
              detachClientAbort();
              return new Response(JSON.stringify(error), {
                status: 413,
                headers: { 'content-type': 'application/json' },
              });
            } else {
              r.info.sizeLimitOutcome = 'within_limit';
            }
          }

          // Probes go to the configured Anthropic upstream with the host's keys; a
          // followed request's prompt must not be copied there.
          if (isMessages && messagesAnthropic && !follow) {
            try {
              baselineStatusApplies = true;
              threadContinue = isThreadContinuation(bodyIn);
              // Probes fire on the ORIGINAL body before the main forward so all three overlap.
              // count_tokens is not billed; ~30-80ms latency is hidden by the main forward.
              const ctBody = buildBaselineCountTokensBody(bodyIn);
              if (ctBody) {
                // Mirror the actual outbound request base+path: count_tokens lives at
                // `<messages-path>/count_tokens`, so provider-prefixed routes like
                // `/anthropic/messages` probe `/anthropic/messages/count_tokens`,
                // joined like the main forward so a `…/anthropic` base isn't doubled.
                const ctUrl = providerPrefixed
                  ? joinProviderPath(passthroughUpstream, url.pathname + '/count_tokens')
                  : upstream + url.pathname + '/count_tokens';
                const ctHeaders = applyGatewayHeadersIfTargeted(
                  filterHeaders(req.headers, STRIP_REQ_HEADERS),
                  ctUrl,
                );
                ctHeaders.delete('content-encoding');
                ctHeaders.set('content-type', 'application/json');
                const ctAuth = resolveAuthToken(config);
                if (config.apiKey) ctHeaders.delete('authorization');
                if (ctAuth) ctHeaders.delete('x-api-key');
                if (config.apiKey) ctHeaders.set('x-api-key', config.apiKey);
                // The probe carries the client's frozen bearer otherwise, so it 401s
                // exactly when the main forward starts succeeding on the fresh one.
                if (ctAuth) ctHeaders.set('authorization', `Bearer ${ctAuth}`);
                ensureClientAbortWired();
                baselinePromise = countTokensUpstream(ctUrl, ctBody, ctHeaders, (reason) => {
                  baselineProbeError = reason;
                }, false, fetchImpl, upstreamAbort.signal);
                // Null = no markers → cacheable=0 by definition, no probe needed.
                const ctCacheableBody = buildCacheablePrefixCountTokensBody(bodyIn);
                if (ctCacheableBody) {
                  baselineCacheablePromise = countTokensUpstream(
                    ctUrl,
                    ctCacheableBody,
                    new Headers(ctHeaders),
                    undefined,
                    false,
                    fetchImpl,
                    upstreamAbort.signal,
                  );
                }
              }
            } catch {
              // Telemetry-only count_tokens probes must never abort the live request.
            }
          }
        } catch (e) {
          if (
            (bridgedGptMessages || bridgedChatMessages) &&
            ((e as Error).name === 'MessagesBridgeInvalidRequest' || e instanceof SyntaxError)
          ) {
            fireWait(400, undefined, `invalid_request: ${(e as Error).message}`);
            return new Response(JSON.stringify({
              type: 'error',
              error: { type: 'invalid_request_error', message: (e as Error).message },
            }), { status: 400, headers: { 'content-type': 'application/json' } });
          }
          detachClientAbort();
          fireWait(502, undefined, `transform_error: ${(e as Error).message}`);
          return new Response(JSON.stringify({ error: 'fiche transform failed' }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
    } else if (req.method === 'POST') {
      // The model lives in the body, not the path, so read it here too or the
      // dashboard row has a blank Model and token columns. Label only: the body
      // is forwarded byte-for-byte, no transform, no baseline probe, no
      // accounting change. Never overwrite a model already recovered from the
      // path — Google routes name it there and carry no body `model`.
      //
      // This route also carries uploads and audio, so buffer only what can
      // plausibly be a JSON request naming a model: declared JSON, declared
      // length under the cap. Anything else streams and shows a blank Model, as
      // before. A missing content-length is not evidence of a big body —
      // chunked clients omit it — so only an explicit over-cap declaration
      // disqualifies.
      // A declared length over the sniff cap still disqualifies early, but it is
      // no longer the only bound: an undeclared or under-declared body used to
      // reach `arrayBuffer()` and buffer without limit. Now the read itself stops
      // at the cap and the untouched remainder streams on, so the model label is
      // best-effort and the memory cost is fixed either way.
      const declaredType = req.headers.get('content-type') ?? '';
      const declaredLength = Number(req.headers.get('content-length') ?? NaN);
      const worthSniffing =
        declaredType.toLowerCase().includes('json') &&
        !(Number.isFinite(declaredLength) && declaredLength > MODEL_SNIFF_MAX_BYTES);
      if (worthSniffing) {
        const sniffCap = Math.min(MODEL_SNIFF_MAX_BYTES, maxRequestBytes);
        const { prefix, body: restoredBody } = await sniffPrefixRestoringBody(req, sniffCap);
        requestModel ??= readModelField(prefix) ?? undefined;
        bodyOut = restoredBody;
      } else {
        bodyOut = req.body; // pass through unchanged, model stays unknown
      }
    } else {
      bodyOut = req.body; // pass through unchanged
    }

    // Compute the outbound upstreamUrl BEFORE applying credentials or gateway
    // headers so every credential/header rule gates on the true destination.
    // Gateway OpenAI routes drop the `/v1` prefix; provider-prefixed passthrough
    // routes keep their full path so prefix-routing gateways see `/openai/*`,
    // `/google-ai-studio/*`, etc. exactly as the client sent them.
    // The chat bridge forwards to the configured Cloudflare upstream at its
    // /chat/completions endpoint (chatCompletionsUrl normalizes a bare base,
    // a /v1 base, or a full …/chat/completions URL). Every other route appends
    // a path to its resolved base.
    let upstreamUrl: string;
    if (follow) {
      upstreamUrl = follow.origin + follow.outboundPath;
    } else if (bridgedChatMessages) {
      upstreamUrl = chatCompletionsUrl(config.cloudflareUpstream ?? '');
    } else {
      const outPath = bridgedGptMessages
        ? (routes.stripOpenAIV1 ? '/responses' : '/v1/responses')
        : isOpenAIPath && routes.stripOpenAIV1 ? path.replace(/^\/v1(?=\/)/, '') : path;
      const requestUpstreamBase = bridgedGptMessages ? openAIUpstream : upstreamBase;
      upstreamUrl = providerPrefixed && !bridgedGptMessages
        ? joinProviderPath(requestUpstreamBase, outPath)
        : requestUpstreamBase + outPath;
    }

    const outHeaders = filterHeaders(req.headers, STRIP_REQ_HEADERS);
    // The body now travels as plain bytes; a stale coding header would make
    // the upstream try to decompress JSON.
    if (requestBodyDecoded) outHeaders.delete('content-encoding');
    const isAnthropicCredentialRoute =
      !isGoogleFamily
      && !isOpenAIChatWire
      && !isOpenAIResponsesWire
      && (!providerPrefixed || url.pathname.startsWith('/anthropic/'))
      && (isAnthropicFamilyPath(url.pathname) || url.pathname.startsWith('/anthropic/') || isMessagesWire);
    if (follow) {
      // The agent addressed this host with this credential; it is the only one
      // that may travel. No configured key, no gateway header, and never an
      // Anthropic-issued credential, which no third party should ever see.
      stripAnthropicCredentials(outHeaders);
    } else if (isOpenAIPath || url.pathname.startsWith('/openai/') || bridgedGptMessages || bridgedChatMessages) {
      // `x-api-key` is Anthropic-only and never belongs on an OpenAI upstream.
      outHeaders.delete('x-api-key');
      const anthropicHeaders: string[] = [];
      outHeaders.forEach((_value, name) => {
        if (name.toLowerCase().startsWith('anthropic-')) anthropicHeaders.push(name);
      });
      for (const name of anthropicHeaders) outHeaders.delete(name);
      // Only inject openAIApiKey when targeting openAIUpstream or gatewayBaseUrl
      // (never send OPENAI_API_KEY to a custom ANTHROPIC_UPSTREAM on `/openai/*`).
      const targetsOpenAIOrGateway =
        urlTargetsBase(upstreamUrl, openAIUpstream)
        || (gatewayBase !== '' && urlTargetsBase(upstreamUrl, gatewayBase));
      // The chat bridge uses the Cloudflare token; Responses uses the OpenAI key.
      const bridgeKey = bridgedChatMessages
        ? config.cloudflareApiKey
        : targetsOpenAIOrGateway
          ? config.openAIApiKey
          : undefined;
      if (bridgedGptMessages || bridgedChatMessages) {
        // A bridged request came in as Anthropic Messages, so whatever credential
        // it carries is an Anthropic one by construction. Drop it unconditionally
        // and use only what the host configured for the bridge target.
        outHeaders.delete('authorization');
        if (bridgeKey) outHeaders.set('authorization', `Bearer ${bridgeKey}`);
      } else {
        // A direct OpenAI-family route. The client's own credential may be the
        // right one to forward, so decide by shape instead of by whether a host
        // key happens to be set. See resolveOpenAIRouteAuth for the three rules.
        const decision = resolveOpenAIRouteAuth(
          classifyInboundCredential(req.headers),
          bridgeKey !== undefined && bridgeKey !== '',
        );
        if (decision.action === 'drop') outHeaders.delete('authorization');
        else if (decision.action === 'replace') outHeaders.set('authorization', `Bearer ${bridgeKey}`);
        // 'keep-inbound' leaves the header filterHeaders already copied.
      }
    } else if (!isAnthropicCredentialRoute) {
      // Non-Anthropic provider routes (Google, /compat/, /grok/, /xai/, /deepseek/,
      // /kimi/, /glm/, etc.) never receive Anthropic credentials.
      stripAnthropicCredentials(outHeaders);
    } else {
      const bearer = resolveAuthToken(config);
      if (config.apiKey) outHeaders.delete('authorization');
      if (bearer) outHeaders.delete('x-api-key');
      if (config.apiKey) outHeaders.set('x-api-key', config.apiKey);
      if (bearer) outHeaders.set('authorization', `Bearer ${bearer}`);
    }

    if (!follow) applyGatewayHeadersIfTargeted(outHeaders, upstreamUrl);

    // Claude Code smuggles its volatile per-turn billing line inside system
    // text. transform.ts strips it from the body (no body position is both
    // cache-safe and invisible — see the billingLine comments there) and hands
    // it up; it travels upstream as the HTTP header it names.
    if (info?.billingLine && !follow && isAnthropicMessagesRoute) {
      const sep = info.billingLine.indexOf(':');
      if (sep > 0) {
        try {
          const headerName = info.billingLine.slice(0, sep).trim().toLowerCase();
          if (headerName === 'x-anthropic-billing-header') {
            const headerValue = info.billingLine.slice(sep + 1).replace(/[\r\n]+/g, ' ').trim();
            outHeaders.set(headerName, headerValue);
          }
        } catch {
          // Malformed header name/value in billingLine must never crash the proxy.
        }
      }
    }
    let releaseInFlight = (): void => {};
    if (reqBodySha256 && duplicateHoldMs > 0) {
      const headers: [string, string][] = [];
      outHeaders.forEach((value, name) => { headers.push([name, value]); });
      headers.sort(([a], [b]) => a.localeCompare(b));
      const key = await sha256Text(JSON.stringify([
        req.method,
        upstreamUrl,
        headers,
        reqBodySha256,
        validatedClientSessionId ?? '',
      ]));
      const now = Date.now();
      // Time trigger keeps steady state clean; size trigger reclaims promptly if entries
      // ever strand faster than the window. Both are throttled, so cost stays amortized.
      const sinceSweep = now - lastSweptAt;
      if (
        sinceSweep >= duplicateHoldMs
        || (inFlight.size > INFLIGHT_SWEEP_SIZE && sinceSweep >= INFLIGHT_SWEEP_MIN_INTERVAL_MS)
      ) {
        for (const [k, v] of inFlight) {
          if (now - v.startedAt >= duplicateHoldMs) inFlight.delete(k);
        }
        lastSweptAt = now;
      }
      const existing = inFlight.get(key);
      // Fail open once the holder is older than the window: a retry that arrives this
      // late is the client recovering from a stall, not an accidental double-send.
      if (existing && now - existing.startedAt < duplicateHoldMs) {
        detachClientAbort();
        if (!upstreamAbort.signal.aborted) {
          upstreamAbort.abort(new Error('fiche: duplicate request rejected'));
        }
        const message = 'An identical request is already in progress';
        fireWait(409, undefined, 'duplicate_request_in_flight');
        const error = isMessages
          ? { type: 'error', error: { type: 'duplicate_request_in_flight', message } }
          : { error: { type: 'duplicate_request_in_flight', message } };
        return new Response(JSON.stringify(error), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      const lease = Symbol();
      inFlight.set(key, { lease, startedAt: now });
      releaseInFlight = () => {
        if (inFlight.get(key)?.lease === lease) inFlight.delete(key);
      };
    }
    // One controller for the whole exchange: headers timeout, stall watchdog and client
    // disconnect all abort through it, so nothing can hold the socket open indefinitely.
    ensureClientAbortWired();
    let timeoutKind: 'headers' | 'idle' | undefined;
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    // Raced explicitly rather than trusting the fetch implementation to reject on
    // abort — the headers phase must be bounded even if the signal is ignored.
    const HEADERS_TIMEOUT = Symbol('headers-timeout');
    const headersDeadline = new Promise<typeof HEADERS_TIMEOUT>((resolve) => {
      if (headersTimeoutMs <= 0) return;
      headersTimer = setTimeout(() => {
        headersTimer = undefined;
        timeoutKind = 'headers';
        upstreamAbort.abort(new Error('fiche: upstream headers timeout'));
        resolve(HEADERS_TIMEOUT);
      }, headersTimeoutMs);
    });
    const clearHeadersTimer = (): void => {
      if (headersTimer !== undefined) {
        clearTimeout(headersTimer);
        headersTimer = undefined;
      }
    };

    let upstreamRes: Response | undefined;
    try {
      const upstreamFetch = fetchImpl(upstreamUrl, {
        method: req.method,
        headers: outHeaders,
        // Never auto-follow 3xx redirects upstream: cross-origin redirects could
        // forward x-api-key, x-goog-api-key, Authorization, or gateway headers.
        redirect: 'manual' as const,
        body: bodyOut,
        signal: upstreamAbort.signal,
        // duplex is required by spec when sending a stream as body
        ...(bodyOut instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
      const raced =
        headersTimeoutMs > 0 ? await Promise.race([upstreamFetch, headersDeadline]) : await upstreamFetch;
      clearHeadersTimer();
      if (raced === HEADERS_TIMEOUT) {
        // Abandoned: cancel any late response body so streams never linger unconsumed.
        void upstreamFetch.then(
          (lateRes) => lateRes.body?.cancel().catch(() => undefined),
          () => undefined,
        );
        throw new Error('fiche: upstream headers timeout');
      }
      upstreamRes = raced;
      // Watch the raw upstream stream, before any bridge re-encodes it.
      upstreamRes = withIdleTimeout(upstreamRes, headersTimeoutMs, idleTimeoutMs, () => {
        timeoutKind = 'idle';
        upstreamAbort.abort(new Error('fiche: upstream stalled'));
      });
      if (bridgedGptMessages) {
        upstreamRes = await openAIResponsesToAnthropicResponse(upstreamRes, requestModel ?? '');
      } else if (bridgedChatMessages) {
        upstreamRes = await openAIChatToAnthropicResponse(upstreamRes, requestModel ?? '');
      }
    } catch (e) {
      clearHeadersTimer();
      if (upstreamRes?.body && !upstreamRes.body.locked) {
        void upstreamRes.body.cancel().catch(() => undefined);
      }
      if (!upstreamAbort.signal.aborted) {
        upstreamAbort.abort(e instanceof Error ? e : new Error(String(e)));
      }
      detachClientAbort();
      releaseInFlight();
      if (timeoutKind) {
        const detail = timeoutKind === 'headers'
          ? `no response headers within ${headersTimeoutMs}ms`
          : `no upstream bytes for ${idleTimeoutMs}ms`;
        fireWait(504, info, `upstream_timeout: ${detail}`);
        return new Response(JSON.stringify({ error: `fiche upstream timeout (${detail})` }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        });
      }
      fireWait(502, info, `upstream_error: ${(e as Error).message}`);
      return new Response(JSON.stringify({ error: 'fiche upstream unreachable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }

    const finalUpstreamRes = upstreamRes;
    const firstByteMs = Date.now() - t0;
    responseContentType = finalUpstreamRes.headers.get('content-type') ?? undefined;
    responseContentEncoding = finalUpstreamRes.headers.get('content-encoding') ?? undefined;

    // Tee: client gets one side; scanner reads the other for usage/measurement/error body.
    let teed: Response;
    let usagePromise: Promise<Usage | undefined>;
    let errorBodyPromise: Promise<string | undefined>;
    let measurementPromise: Promise<OutputMeasurement | undefined>;
    let stopReasonPromise: Promise<string | undefined>;
    try {
      ({ response: teed, usagePromise, errorBodyPromise, measurementPromise, stopReasonPromise } =
        teeForUsage(
          finalUpstreamRes,
          isOpenAIResponsesWire && responsesStreaming,
          isOpenAIResponsesWire && !responsesStreaming,
          isMessages || isGoogle || isOpenAIChatWire || isOpenAIResponsesWire || bridgedGptMessages || bridgedChatMessages,
        ));
    } catch (e) {
      if (finalUpstreamRes.body && !finalUpstreamRes.body.locked) {
        void finalUpstreamRes.body.cancel().catch(() => undefined);
      }
      if (!upstreamAbort.signal.aborted) {
        upstreamAbort.abort(e instanceof Error ? e : new Error(String(e)));
      }
      detachClientAbort();
      releaseInFlight();
      throw e;
    }

    // Fire event in background once all four resolve (all share the same stream read).
    const bgTask = Promise.all([
      usagePromise.catch(() => undefined),
      errorBodyPromise.catch(() => undefined),
      measurementPromise.catch(() => undefined),
      stopReasonPromise.catch(() => undefined),
    ]).then(([usage, errorBody, measurement, stopReason]) => {
      // A rejected request never populated a prefix cache, so the append-only
      // freeze this session was protecting protects nothing: let the next turn
      // re-cut the grid for density instead of preserving dead bytes.
      const sessionKey = info?.sessionKey ?? info?.firstUserSha8;
      if (responseLeftNoCache(finalUpstreamRes.status, errorBody)) {
        markCacheDead(sessionKey);
      }
      // Feed the provider's own cache accounting back into the session store. A
      // read proves the prefix was live; a create proves one was just written.
      // Either way the next turn must not re-cut the grid or assume cold cache.
      if (finalUpstreamRes.ok && usage !== undefined && (isAnthropicMessagesRoute || isGoogle || isOpenAIChatWire || isOpenAIResponsesWire || bridgedGptMessages || bridgedChatMessages)) {
        noteCacheOutcome(
          sessionKey,
          usage.cache_read_input_tokens ?? usage.cached_tokens,
          bridgedGptMessages || bridgedChatMessages
            ? undefined
            : (usage.cache_creation_input_tokens ?? usage.cache_write_tokens),
        );
      }
      return fire(
        finalUpstreamRes.status,
        info,
        timeoutKind === 'idle' ? `upstream_timeout: no upstream bytes for ${idleTimeoutMs}ms` : undefined,
        firstByteMs,
        usage,
        config.captureErrorReqBody ? errorBody : undefined,
        measurement,
        stopReason,
      );
    }).finally(() => {
      clearHeadersTimer();
      detachClientAbort();
      releaseInFlight();
    });
    config.waitUntil?.(bgTask);

    // Client disconnect: drop the lease immediately and abort upstream, rather than
    // waiting on scanner promises that a wedged connection would never settle.
    const clientBody = teed.body
      ? withClientDisconnect(teed.body, () => {
          clearHeadersTimer();
          detachClientAbort();
          releaseInFlight();
          if (!upstreamAbort.signal.aborted) {
            upstreamAbort.abort(new Error('fiche: client disconnected'));
          }
        })
      : null;

    const resHeaders = filterHeaders(finalUpstreamRes.headers, STRIP_RES_HEADERS);
    if (info && (info.compressed || (info.textHygieneSavedTokens ?? 0) > 0 || (info.textHygieneStages?.length ?? 0) > 0)) {
      const imagedSaved = info.compressed
        ? Math.max(
            0,
            (info.baselineImagedTokens ?? Math.round((info.compressedChars ?? 0) / 4)) -
              (info.imageTokens ?? 0),
          )
        : 0;
      const savedTokens = (info.textHygieneSavedTokens ?? 0) + imagedSaved;
      const stages = [
        ...(info.compressed && (info.imageCount ?? 0) > 0 ? ['image'] : []),
        ...(info.textHygieneStages ?? []),
      ];
      if (savedTokens > 0) resHeaders.set('x-fiche-saved-tokens', String(savedTokens));
      if (stages.length > 0) resHeaders.set('x-fiche-stages', [...new Set(stages)].join(','));
      if (info.cliffAvoided && info.cliffAvoided.savedUsd > 0) {
        resHeaders.set('x-fiche-cliff-saved-usd', info.cliffAvoided.savedUsd.toFixed(4));
      }
    }

    if (!clientBody) detachClientAbort();
    return new Response(clientBody, {
      status: finalUpstreamRes.status,
      statusText: finalUpstreamRes.statusText,
      headers: resHeaders,
    });
  };
}
