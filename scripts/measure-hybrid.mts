import { transformRequest } from '../src/core/transform.ts';
import { hybridTransform, countBillable } from '../src/core/hybrid.ts';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.ts';
import { visionTokens } from '../src/core/vision-cost.ts';

function events(n: number) {
  return {
    events: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      user: 'octocat',
      status: 'ok',
      path: 'src/core/hybrid.ts',
      service: 'pxpipe-fork',
      ms: 5000 + i,
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
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'events.json' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: JSON.stringify(payload) }] },
      { role: 'user', content: 'Which status repeated?' },
    ],
  };
}

function pageTokens(info: { imageDims?: Array<{ width: number; height: number }> }, model: string) {
  const pricing = resolveGptProfile(model);
  return (info.imageDims ?? []).reduce((sum, dim) => sum + visionTokens(pricing, dim.width, dim.height), 0);
}

const model = 'claude-fable-5';
const body = new TextEncoder().encode(JSON.stringify(request(model, events(360))));
const imagesOnly = await transformRequest(body, { model });
const hybrid = await hybridTransform(body, { model, wire: 'anthropic' });
const rawImg = pageTokens(imagesOnly.info, model);
const hybImg = pageTokens(hybrid.info, model);
const rawBill = countBillable(imagesOnly.body, rawImg, model);
const weakBody = new TextEncoder().encode(JSON.stringify(request('claude-sonnet-5-5', events(360))));
const weak = await hybridTransform(weakBody, { model: 'claude-sonnet-5-5', wire: 'anthropic' });
const grok = await hybridTransform(
  new TextEncoder().encode(JSON.stringify(request('grok-4.7', events(360)))),
  { model: 'grok-4.7', wire: 'anthropic' },
);
console.log(JSON.stringify({
  originalTokens: hybrid.report.originalTokens,
  imageOnly: {
    pages: (imagesOnly.info.imageDims ?? []).length,
    imageTokens: rawImg,
    billable: rawBill,
    savedPct: Math.round((1 - rawBill / hybrid.report.originalTokens) * 1000) / 10,
  },
  hybridFable: {
    pages: (hybrid.info.imageDims ?? []).length,
    imageTokens: hybImg,
    billable: hybrid.report.billableTokens,
    savedPct: hybrid.report.savedPercent,
    paktBlocks: hybrid.report.paktBlocks,
  },
  sonnet55: {
    imaged: weak.report.imaged,
    savedPct: weak.report.savedPercent,
    billable: weak.report.billableTokens,
    original: weak.report.originalTokens,
  },
  grok47: {
    imaged: grok.report.imaged,
    savedPct: grok.report.savedPercent,
    billable: grok.report.billableTokens,
    original: grok.report.originalTokens,
  },
}, null, 2));
