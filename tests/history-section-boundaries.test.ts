import { describe, expect, it } from 'vitest';
import { transformOpenAIResponses } from '../src/core/openai.js';

// Replayed Codex traffic: in a long agentic turn the latest user message is
// protected, so the closed rounds just before it could not seal into a history
// section. When the next user message arrived, they sealed and a new segment
// was inserted far up the prefix, re-billing everything after it uncached.
// User messages are now permanent section boundaries, so a new user turn must
// leave every earlier history segment where it was, byte for byte.

const enc = new TextEncoder();
const dec = new TextDecoder();
type Item = Record<string, unknown> & { content?: unknown };

function round(i: number): Item[] {
  const id = `call_${i}`;
  return [
    { type: 'function_call', call_id: id, name: 'read', arguments: `{"path":"src/file${i}.ts"}` },
    { type: 'function_call_output', call_id: id, output: `line ${i} of the file with some code in it\n`.repeat(25) },
  ];
}

function rounds(from: number, to: number): Item[] {
  const out: Item[] = [];
  for (let i = from; i < to; i++) out.push(...round(i));
  return out;
}

const user = (text: string): Item => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

async function run(input: Item[]) {
  const r = await transformOpenAIResponses(
    enc.encode(JSON.stringify({ model: 'gpt-5.6-sol', instructions: 'Agent rules. '.repeat(800), input })),
    { explicitPromptCacheBreakpoints: false },
  );
  return JSON.parse(dec.decode(r.body)) as { input: Item[] };
}

const isHistory = (item: Item) => Array.isArray(item.content)
  && (item.content as Array<{ type?: string }>).some((p) => p.type === 'input_image')
  && JSON.stringify(item.content).includes('Earlier turns');

describe('history sections across a new user turn', () => {
  it('keeps every earlier history segment in place when the next user message arrives', async () => {
    const turn1 = [user('Start the task. '.repeat(20)), ...rounds(0, 23), user('Now continue. '.repeat(20)), ...rounds(23, 60)];
    const turn2 = [...turn1, user('One more thing. '.repeat(20)), ...rounds(60, 61)];
    const a = await run(turn1);
    const b = await run(turn2);
    const lastHistoryA = a.input.reduce((last, item, i) => (isHistory(item) ? i : last), -1);
    expect(lastHistoryA).toBeGreaterThan(0);
    let firstDiff = 0;
    while (firstDiff < a.input.length && JSON.stringify(a.input[firstDiff]) === JSON.stringify(b.input[firstDiff])) firstDiff++;
    // The combined fact sheet rides on the last segment and may move; nothing
    // before the last turn-1 segment may change.
    expect(firstDiff).toBeGreaterThanOrEqual(lastHistoryA);
  });
});
