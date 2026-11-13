/**
 * In-place edits of JSON string values.
 *
 * Anthropic's prompt cache is the exact prefix through the last
 * `cache_control` block. Rebuilding the document with `JSON.stringify`
 * changes that prefix. This scanner replaces only string literals that
 * start after the block that owns the last `cache_control` key, so every
 * preceding byte stays identical. With no marker, replacements still splice
 * in place, which keeps the bytes before the first edit identical for
 * OpenAI's automatic prefix cache.
 */

export interface JsonStringSpan {
  /** Index of the opening quote. */
  start: number;
  /** Index just past the closing quote. */
  end: number;
  decoded: string;
}

export interface JsonScan {
  strings: JsonStringSpan[];
  /** End index of the object that owns the last `cache_control` key. 0 if none. */
  boundary: number;
}

function decodeEscape(text: string, i: number): { char: string; next: number } | null {
  const c = text[i];
  if (c === undefined) return null;
  if (c === 'u') {
    const hex = text.slice(i + 1, i + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
    return { char: String.fromCharCode(Number.parseInt(hex, 16)), next: i + 5 };
  }
  const simple: Record<string, string> = {
    '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
  };
  const mapped = simple[c];
  if (mapped === undefined) return null;
  return { char: mapped, next: i + 1 };
}

export function scanJsonStrings(text: string): JsonScan | null {
  const strings: JsonStringSpan[] = [];
  const stack: Array<{ kind: '{' | '['; cache: boolean }> = [];
  let boundary = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      i += 1;
      let decoded = '';
      let closed = false;
      while (i < n) {
        const ch = text[i]!;
        if (ch === '\\') {
          const escaped = decodeEscape(text, i + 1);
          if (!escaped) return null;
          decoded += escaped.char;
          i = escaped.next;
          continue;
        }
        if (ch === '"') {
          i += 1;
          closed = true;
          break;
        }
        decoded += ch;
        i += 1;
      }
      if (!closed) return null;
      let j = i;
      while (j < n && /\s/.test(text[j]!)) j += 1;
      if (text[j] === ':') {
        const frame = stack[stack.length - 1];
        if (decoded === 'cache_control' && frame?.kind === '{') frame.cache = true;
      } else {
        strings.push({ start, end: i, decoded });
      }
      continue;
    }
    if (c === '{') {
      stack.push({ kind: '{', cache: false });
      i += 1;
      continue;
    }
    if (c === '[') {
      stack.push({ kind: '[', cache: false });
      i += 1;
      continue;
    }
    if (c === '}' || c === ']') {
      const frame = stack.pop();
      if (!frame || (c === '}' && frame.kind !== '{') || (c === ']' && frame.kind !== '[')) return null;
      i += 1;
      if (frame.kind === '{' && frame.cache) boundary = i;
      continue;
    }
    i += 1;
  }
  if (stack.length !== 0) return null;
  return { strings, boundary };
}

/** Replace string tokens from the end so earlier offsets stay valid. */
export function spliceJsonStrings(text: string, replacements: Array<{ start: number; end: number; next: string }>): string {
  const ordered = [...replacements].sort((a, b) => b.start - a.start);
  let out = text;
  for (const replacement of ordered) {
    out = out.slice(0, replacement.start) + replacement.next + out.slice(replacement.end);
  }
  return out;
}
