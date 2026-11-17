import * as zlib from 'node:zlib';

/**
 * Decode a compressed inbound request body so inkling can read and transform it.
 *
 * Codex's built-in `openai` provider zstd-compresses its Responses POST
 * (`enable_request_compression`, on by default) when it falls back from
 * WebSocket to HTTP. Without decoding, the body is unreadable JSON, the
 * transform is skipped and the request is forwarded as-is: safe, but it saves
 * nothing and nothing says why.
 *
 * `encoding` is the raw Content-Encoding value. Codings are applied in listed
 * order, so they are undone in reverse. Returns `undefined` for anything it
 * cannot decode (unknown coding, zstd on a Node without it, corrupt bytes, or
 * output past `maxBytes`); the caller then forwards the original bytes and
 * header untouched. `maxBytes` bounds the decompressed size, so a small
 * compressed body cannot expand into an out-of-memory host.
 */
export function decodeRequestBody(
  bytes: Uint8Array,
  encoding: string,
  maxBytes: number,
): Uint8Array<ArrayBuffer> | undefined {
  const codings = encoding
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '' && c !== 'identity');
  if (codings.length === 0) return undefined;
  let buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opts = { maxOutputLength: maxBytes };
  try {
    for (const coding of codings.reverse()) {
      switch (coding) {
        case 'gzip':
        case 'x-gzip':
          buf = zlib.gunzipSync(buf, opts);
          break;
        case 'deflate':
          // RFC 9110 deflate is zlib-wrapped, but some clients send raw deflate.
          try {
            buf = zlib.inflateSync(buf, opts);
          } catch (err) {
            if (err instanceof RangeError) throw err;
            buf = zlib.inflateRawSync(buf, opts);
          }
          break;
        case 'br':
          buf = zlib.brotliDecompressSync(buf, opts);
          break;
        case 'zstd': {
          const zstd = (zlib as { zstdDecompressSync?: (b: Buffer, o: object) => Buffer }).zstdDecompressSync;
          if (typeof zstd !== 'function') return undefined;
          buf = zstd(buf, opts);
          break;
        }
        default:
          return undefined;
      }
    }
  } catch {
    return undefined;
  }
  if (buf.byteLength > maxBytes) return undefined;
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
