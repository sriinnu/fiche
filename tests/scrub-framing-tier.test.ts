import { describe, expect, it } from 'vitest';
import { scrubPromptCacheBreakpoint } from '../src/core/codex-cache.js';
import { jsonLosslessUnderParse, packStructured } from '../src/core/pakt-stage.js';
import { prefersPaktText } from '../src/core/reader-tier.js';
import { pushMcpChunk } from '../src/mcp/server.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('Codex breakpoint scrub', () => {
  it('removes the injected object without reserializing the rest', () => {
    const raw = '{"trace":12345678901234567890,"ratio":1.0,"input":[{"content":[{"type":"input_text","text":"hi","prompt_cache_breakpoint":{"mode":"explicit"}}]}]}';
    const out = dec.decode(scrubPromptCacheBreakpoint(enc.encode(raw)));
    expect(out).toBe('{"trace":12345678901234567890,"ratio":1.0,"input":[{"content":[{"type":"input_text","text":"hi"}]}]}');
  });

  it('removes it when it is the first key', () => {
    const raw = '{"input":[{"prompt_cache_breakpoint":{"mode":"explicit"},"type":"input_text","text":"hi"}]}';
    expect(dec.decode(scrubPromptCacheBreakpoint(enc.encode(raw)))).toBe('{"input":[{"type":"input_text","text":"hi"}]}');
  });

  it('leaves a tool-schema property of the same name alone', () => {
    const raw = '{"tools":[{"parameters":{"properties":{"prompt_cache_breakpoint":{"type":"string"}}}}]}';
    const bytes = enc.encode(raw);
    expect(scrubPromptCacheBreakpoint(bytes)).toBe(bytes);
  });

  it('leaves the text inside a string alone', () => {
    const raw = JSON.stringify({ input: 'see ,"prompt_cache_breakpoint":{"mode":"explicit"} here' });
    const bytes = enc.encode(raw);
    expect(scrubPromptCacheBreakpoint(bytes)).toBe(bytes);
  });
});

describe('JSON safety for the round-trip guard', () => {
  it('refuses what JSON.parse would change', () => {
    expect(jsonLosslessUnderParse('{"id":12345678901234567890}')).toBe(false);
    expect(jsonLosslessUnderParse('{"a":1.0}')).toBe(false);
    expect(jsonLosslessUnderParse('{"a":1e3}')).toBe(false);
    expect(jsonLosslessUnderParse('{"a":1,"a":2}')).toBe(false);
    expect(jsonLosslessUnderParse('[1.5,-3,0,"x\\"y",{"b":null,"c":[true,false]}]')).toBe(true);
  });

  it('does not pack a big-integer document', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: 9007199254740993 + i, status: 'ok' }));
    const text = JSON.stringify(rows).replace(/"id":(\d+)/g, (_, n) => `"id":1${n}`);
    expect(packStructured(text)).toBeNull();
  });
});

describe('MCP stdio framing', () => {
  it('counts Content-Length in UTF-8 bytes', () => {
    const a = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { note: 'café 🚀' } });
    const b = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const frame = (s: string) => `Content-Length: ${Buffer.byteLength(s, 'utf8')}\r\n\r\n${s}`;
    const got: unknown[] = [];
    const rest = pushMcpChunk('', frame(a) + frame(b), (m) => got.push(m));
    expect(rest).toBe('');
    expect(got).toEqual([JSON.parse(a), JSON.parse(b)]);
  });
});

describe('PAKT-only reader spellings', () => {
  it.each([
    'claude-opus-5-5',
    'claude-opus-5.5',
    'claude-opus-5-5@20261001',
    'anthropic.claude-sonnet-5-5-v1:0',
    'x-ai/grok-4.7',
    'x-ai.grok-4.7',
    'grok-4.7',
  ])('%s stays on PAKT text', (id) => {
    expect(prefersPaktText(id, false)).toBe(true);
  });

  it.each(['claude-fable-5', 'claude-opus-5', 'gemini-3-pro'])('%s is not PAKT-only', (id) => {
    expect(prefersPaktText(id, false)).toBe(false);
  });
});
