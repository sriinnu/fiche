import { describe, expect, it } from 'vitest';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from '../src/core/openai.js';

// Replayed Codex traffic showed full cache busts (170k-460k tokens re-billed
// uncached) whenever Codex appended a small developer note mid-session, such as
// "<tools>Added deferred tool namespaces ...</tools>". The static slab used to
// collect EVERY system/developer item, so the note was hoisted into the slab at
// the front and its last page re-rendered. Only the leading authority items are
// static; later ones must stay native, in place, and leave the prefix untouched.

const enc = new TextEncoder();
const dec = new TextDecoder();
const DEV = 'Detailed developer rules for the coding agent, kept stable all session. '.repeat(400);
const LATE = '<tools>\nAdded deferred tool namespaces:\n- mcp__example\n</tools>';

type Item = { role?: string; content?: unknown };

describe('static slab holds only leading authority items', () => {
  it('Responses: a mid-session developer note leaves the earlier prefix byte-identical', async () => {
    const turn1 = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: DEV }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First request.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    ];
    const turn2 = [
      ...turn1,
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: LATE }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second request.' }] },
    ];
    const run = async (input: unknown[]) => {
      const r = await transformOpenAIResponses(
        enc.encode(JSON.stringify({ model: 'gpt-5.6-sol', input })),
        { explicitPromptCacheBreakpoints: false },
      );
      expect(r.info.compressed).toBe(true);
      return JSON.parse(dec.decode(r.body)) as { input: Item[] };
    };
    const a = await run(turn1);
    const b = await run(turn2);
    expect(JSON.stringify(b.input.slice(0, a.input.length))).toBe(JSON.stringify(a.input));
    const late = b.input.find((item) => item.role === 'developer' && JSON.stringify(item.content).includes('mcp__example'));
    expect(late).toBeDefined();
  });

  it('Chat: a mid-session system note leaves the earlier prefix byte-identical', async () => {
    const turn1 = [
      { role: 'system', content: DEV },
      { role: 'user', content: 'First request.' },
      { role: 'assistant', content: 'Done.' },
    ];
    const turn2 = [...turn1, { role: 'system', content: LATE }, { role: 'user', content: 'Second request.' }];
    const run = async (messages: unknown[]) => {
      const r = await transformOpenAIChatCompletions(
        enc.encode(JSON.stringify({ model: 'gpt-5.6-sol', messages })),
        { explicitPromptCacheBreakpoints: false },
      );
      expect(r.info.compressed).toBe(true);
      return JSON.parse(dec.decode(r.body)) as { messages: Item[] };
    };
    const a = await run(turn1);
    const b = await run(turn2);
    expect(JSON.stringify(b.messages.slice(0, a.messages.length))).toBe(JSON.stringify(a.messages));
    expect(b.messages.some((m) => m.role === 'system' && m.content === LATE)).toBe(true);
  });
});
