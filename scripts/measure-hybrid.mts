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

function mixedProseAndCode(model: string) {
  const prose = [
    'You are a coding agent working in a TypeScript repository.',
    'Prefer small diffs. Do not rename public exports.',
    'When a test fails, read the assertion before changing production code.',
    'The proxy listens on loopback. Do not bind a public interface.',
    'Keep the Claude Code identity block as the first system block.',
  ].join('\n');
  const source = Array.from({ length: 80 }, (_, i) =>
    `export function step${i}(value: number): number {\n  if (value < 0) return 0;\n  return value + ${i} * 3;\n}\n`,
  ).join('\n');
  return {
    model,
    max_tokens: 256,
    system: prose.repeat(8),
    messages: [
      { role: 'user', content: 'Read src/steps.ts and say whether step12 can return a negative number.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'src/steps.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: source }] },
      { role: 'user', content: 'Answer in one sentence.' },
    ],
  };
}

function agentSession(model: string) {
  const toolDoc = {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns matching lines with paths. '.repeat(40),
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Ripgrep pattern. Do not pass a multiline expression.' },
        path: { type: 'string', description: 'Directory or file to search. Relative to the workspace.' },
      },
    },
  };
  const history = Array.from({ length: 6 }, (_, i) => ([
    { role: 'user', content: `Look at failure ${i}. The assertion expected 200 and got 500 from the proxy.` },
    { role: 'assistant', content: `I will read tests/proxy-${i}.test.ts and the handler it calls.` },
  ])).flat();
  const log = JSON.stringify({
    events: Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      route: '/v1/messages',
      status: i % 7 === 0 ? 500 : 200,
      model,
      note: 'counted after the request returned',
    })),
  });
  return {
    model,
    max_tokens: 256,
    system: 'You are a coding agent. Recent turns stay text. Re-fetch exact ids with tools. '.repeat(12),
    tools: [toolDoc],
    messages: [
      ...history,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_log', content: log }] },
      { role: 'user', content: 'Which status codes appear more than once?' },
    ],
  };
}

async function measure(label: string, model: string, payload: unknown) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const imagesOnly = await transformRequest(body, { model });
  const hybrid = await hybridTransform(body, { model, wire: 'anthropic' });
  const rawImg = pageTokens(imagesOnly.info, model);
  const imageBill = countBillable(imagesOnly.body, rawImg, model);
  const original = countBillable(body, 0, model);
  return {
    label,
    model,
    original,
    imageOnly: {
      pages: (imagesOnly.info.imageDims ?? []).length,
      imageTokens: rawImg,
      billable: imageBill,
      savedPct: original > 0 ? Math.round((1 - imageBill / original) * 1000) / 10 : 0,
    },
    hybrid: {
      tier: hybrid.report.readerTier,
      imaged: hybrid.report.imaged,
      pages: (hybrid.info.imageDims ?? []).length,
      paktBlocks: hybrid.report.paktBlocks,
      billable: hybrid.report.billableTokens,
      savedPct: hybrid.report.savedPercent,
      deltaVsImages: hybrid.report.billableTokens - imageBill,
    },
  };
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
const rows = [
  {
    fixture: 'repetitive-json',
    fable: {
      original: hybrid.report.originalTokens,
      imageOnlyPages: (imagesOnly.info.imageDims ?? []).length,
      imageOnlyTokens: rawImg,
      imageOnlyBillable: rawBill,
      imageOnlySavedPct: Math.round((1 - rawBill / hybrid.report.originalTokens) * 1000) / 10,
      hybridPages: (hybrid.info.imageDims ?? []).length,
      hybridBillable: hybrid.report.billableTokens,
      hybridSavedPct: hybrid.report.savedPercent,
      hybridImageTokens: hybImg,
    },
    sonnet55: { imaged: weak.report.imaged, billable: weak.report.billableTokens, savedPct: weak.report.savedPercent, original: weak.report.originalTokens },
    grok47: { imaged: grok.report.imaged, billable: grok.report.billableTokens, savedPct: grok.report.savedPercent, original: grok.report.originalTokens },
  },
  await measure('mixed-prose-code', 'claude-fable-5', mixedProseAndCode('claude-fable-5')),
  await measure('mixed-prose-code', 'claude-sonnet-5-5', mixedProseAndCode('claude-sonnet-5-5')),
  await measure('mixed-prose-code', 'grok-4.7', mixedProseAndCode('grok-4.7')),
  await measure('agent-session', 'claude-fable-5', agentSession('claude-fable-5')),
  await measure('agent-session', 'claude-sonnet-5-5', agentSession('claude-sonnet-5-5')),
  await measure('agent-session', 'grok-4.7', agentSession('grok-4.7')),
  await measure('agent-session', 'gpt-5.6-sol', agentSession('gpt-5.6-sol')),
];
console.log(JSON.stringify(rows, null, 2));
