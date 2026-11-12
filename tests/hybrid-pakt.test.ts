import { afterEach, describe, expect, it } from 'vitest';
import { decompress } from '@sriinnu/pakt';
import { packStructured } from '../src/core/pakt-stage.js';
import { readerTier } from '../src/core/reader-tier.js';
import { countBillable, hybridTransform } from '../src/core/hybrid.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import { visionTokens } from '../src/core/vision-cost.js';
import { transformRequest } from '../src/core/transform.js';

function events(n: number, ms: (i: number) => number) {
  return {
    events: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      user: 'octocat',
      status: 'ok',
      path: 'src/core/hybrid.ts',
      service: 'pxpipe-fork',
      ms: ms(i),
      note: 'static slab cache hit on the system prompt',
    })),
  };
}

function request(model: string, payload: unknown) {
  return {
    model,
    max_tokens: 256,
    system: 'You are a coding agent. Follow repository conventions and re-fetch exact ids with tools. '.repeat(40),
    messages: [
      { role: 'user', content: 'Inspect the event log.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'events.json' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: JSON.stringify(payload) }],
      },
      { role: 'user', content: 'Which status repeated?' },
    ],
  };
}

describe('PAKT stage', () => {
  it('packs monotonic JSON losslessly and refuses cyclic deltas that would not round-trip', () => {
    const good = JSON.stringify(events(80, (i) => 1000 + i));
    const packed = packStructured(good, { model: 'gpt-4o', toolName: 'read' });
    expect(packed?.applied).toBe(true);
    expect(packed!.savedPercent).toBeGreaterThan(25);
    expect(packed!.reversible).toBe(true);
    const back = decompress(packed!.text, 'json');
    expect(back.data).toEqual(JSON.parse(good));

    const cyclic = JSON.stringify(events(80, (i) => 120 + (i % 3)));
    expect(packStructured(cyclic, { model: 'gpt-4o' })).toBeNull();
  });

  it('leaves prose and L4 off unless asked', () => {
    expect(packStructured('The quick brown fox jumps over the lazy dog. '.repeat(30))).toBeNull();
    const good = JSON.stringify(events(40, (i) => 1000 + i));
    const lossy = packStructured(good, { lossy: true, semanticBudget: 0 });
    expect(lossy?.reversible).not.toBe(false);
  });
});

describe('reader tier', () => {
  const prev = process.env.PXPIPE_FORCE_IMAGES;
  afterEach(() => {
    if (prev === undefined) delete process.env.PXPIPE_FORCE_IMAGES;
    else process.env.PXPIPE_FORCE_IMAGES = prev;
  });

  it('images strong readers and keeps Claude 5.5 and Grok on PAKT text', () => {
    expect(readerTier('claude-fable-5')).toBe('image');
    expect(readerTier('claude-fable-5-2')).toBe('image');
    expect(readerTier('gemini-4-argon')).toBe('image');
    expect(readerTier('gpt-5.6-sol')).toBe('image');
    expect(readerTier('gpt-6.1-sol')).toBe('image');
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'grok-4.5', 'grok-4.6', 'grok-4.7', 'claude-opus-5']) {
      expect(readerTier(model), model).toBe('pakt-text');
    }
    process.env.PXPIPE_FORCE_IMAGES = '1';
    expect(readerTier('claude-opus-5-5')).toBe('image');
  });
});

describe('hybrid pipeline', () => {
  it('saves more billable tokens than imaging alone on a structured agent fixture', async () => {
    const body = new TextEncoder().encode(JSON.stringify(request('claude-fable-5', events(360, (i) => 5000 + i))));
    const imagesOnly = await transformRequest(body, { model: 'claude-fable-5' });
    const hybrid = await hybridTransform(body, { model: 'claude-fable-5', wire: 'anthropic' });
    const pricing = resolveGptProfile('claude-fable-5');
    const vision = (info: { imageDims?: Array<{ width: number; height: number }> }) =>
      (info.imageDims ?? []).reduce((sum, dim) => sum + visionTokens(pricing, dim.width, dim.height), 0);
    const imageOnlyBill = countBillable(imagesOnly.body, vision(imagesOnly.info), 'claude-fable-5');
    expect(hybrid.report.paktBlocks).toBeGreaterThan(0);
    expect(hybrid.report.imaged).toBe(true);
    expect(hybrid.report.billableTokens).toBeLessThan(hybrid.report.originalTokens);
    expect(hybrid.report.savedPercent).toBeGreaterThan(30);
    expect(hybrid.report.billableTokens).toBeLessThan(imageOnlyBill);
    expect(vision(hybrid.info)).toBeLessThan(vision(imagesOnly.info));
  });

  it('keeps weak vision models on PAKT text with zero images', async () => {
    const payload = events(120, (i) => 8000 + i);
    const raw = JSON.stringify(payload);
    const body = new TextEncoder().encode(JSON.stringify(request('claude-sonnet-5-5', payload)));
    const result = await hybridTransform(body, { model: 'claude-sonnet-5-5', wire: 'anthropic' });
    expect(result.report.readerTier).toBe('pakt-text');
    expect(result.report.imaged).toBe(false);
    expect(result.info.imageCount).toBe(0);
    expect(new TextDecoder().decode(result.body)).toContain('@from json');
    expect(result.report.savedPercent).toBeGreaterThan(20);
    const packed = new TextDecoder().decode(result.body);
    const match = packed.match(/@from json[\s\S]*$/);
    expect(match).toBeTruthy();
    // The tool result itself still decompresses. Pull the packed block back out.
    const tool = JSON.parse(packed).messages[2].content[0].content as string;
    expect(decompress(tool, 'json').data).toEqual(JSON.parse(raw));
    expect(result.report.promptCacheBreakpoint).toBe(false);
  });
});
