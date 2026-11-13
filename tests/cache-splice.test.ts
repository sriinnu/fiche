import { describe, expect, it } from 'vitest';
import { scanJsonStrings, spliceJsonStrings } from '../src/core/cache-splice.js';
import { prepassRequest } from '../src/core/hybrid.js';

describe('cache-preserving JSON splice', () => {
  it('finds the end of the object that owns the last cache_control', () => {
    const text = '{"system":[{"type":"text","text":"keep","cache_control":{"type":"ephemeral"}}],"messages":[{"content":"tail"}]}';
    const scan = scanJsonStrings(text);
    expect(scan).not.toBeNull();
    const boundary = scan!.boundary;
    expect(text.slice(0, boundary)).toBe('{"system":[{"type":"text","text":"keep","cache_control":{"type":"ephemeral"}}');
    expect(scan!.strings.map((span) => span.decoded)).toContain('keep');
    expect(scan!.strings.map((span) => span.decoded)).toContain('tail');
  });

  it('does not treat a cache_control mention inside a string as a marker', () => {
    const text = '{"note":"cache_control is a word","ok":true}';
    const scan = scanJsonStrings(text);
    expect(scan!.boundary).toBe(0);
  });

  it('leaves bytes before the boundary untouched when a later string shrinks', () => {
    const events = JSON.stringify({
      events: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, status: 'ok', path: 'src/a.ts', note: 'row' })),
    });
    const pretty = `{
  "model": "claude-opus-5-5",
  "system": [
    { "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.", "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [ { "role": "user", "content": [ { "type": "tool_result", "content": ${JSON.stringify(events)} } ] } ]
}`;
    const pre = prepassRequest(new TextEncoder().encode(pretty), 'claude-opus-5-5');
    expect(pre.changed).toBe(true);
    const out = new TextDecoder().decode(pre.body);
    const marker = pretty.indexOf('"cache_control"');
    const blockEnd = pretty.indexOf('}', pretty.indexOf('}', marker) + 1);
    expect(out.slice(0, blockEnd + 1)).toBe(pretty.slice(0, blockEnd + 1));
    expect(out).toContain('@from json');
  });

  it('splices from the end so earlier offsets stay valid', () => {
    const text = '{"a":"one","b":"two"}';
    const out = spliceJsonStrings(text, [
      { start: text.indexOf('"one"'), end: text.indexOf('"one"') + 5, next: '"ONE"' },
      { start: text.indexOf('"two"'), end: text.indexOf('"two"') + 5, next: '"TWO"' },
    ]);
    expect(out).toBe('{"a":"ONE","b":"TWO"}');
  });
});
