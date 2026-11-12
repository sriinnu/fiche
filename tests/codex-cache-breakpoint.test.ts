import { afterEach, describe, expect, it } from 'vitest';
import { transformOpenAIResponses } from '../src/core/openai.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import {
  bodyHasPromptCacheBreakpoint,
  scrubPromptCacheBreakpoint,
  supportsExplicitPromptCacheBreakpoint,
} from '../src/core/codex-cache.js';
import { hybridTransform } from '../src/core/hybrid.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const INSTRUCTIONS = 'These are detailed instructions for the coding agent. '.repeat(400);

function solBody() {
  return enc.encode(JSON.stringify({
    model: 'gpt-5.6-sol',
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: 'Reply with exactly: pxpipe OK' }],
  }));
}

describe('ChatGPT Codex prompt_cache_breakpoint', () => {
  const prev = process.env.PXPIPE_GPT_PROFILES;
  afterEach(() => {
    if (prev === undefined) delete process.env.PXPIPE_GPT_PROFILES;
    else process.env.PXPIPE_GPT_PROFILES = prev;
  });

  it('treats the Codex path and chatgpt.com as incapable, and api.openai.com as capable', () => {
    expect(supportsExplicitPromptCacheBreakpoint({
      pathname: '/backend-api/codex/responses',
      upstream: 'https://chatgpt.com',
    })).toBe(false);
    expect(supportsExplicitPromptCacheBreakpoint({
      pathname: '/v1/responses',
      upstream: 'https://chatgpt.com',
    })).toBe(false);
    expect(supportsExplicitPromptCacheBreakpoint({
      pathname: '/v1/responses',
      upstream: 'https://api.openai.com',
    })).toBe(true);
    expect(supportsExplicitPromptCacheBreakpoint({ pathname: '/v1/responses' })).toBe(true);
  });

  it('still injects the breakpoint for api.openai.com Sol profiles', async () => {
    const result = await transformOpenAIResponses(solBody(), { charsPerToken: 1, minCompressChars: 1 });
    expect(result.info.compressed).toBe(true);
    expect(bodyHasPromptCacheBreakpoint(result.body)).toBe(true);
    const out = JSON.parse(dec.decode(result.body)) as { input: Array<{ content?: Array<Record<string, unknown>> }> };
    const parts = out.input.flatMap((item) => item.content ?? []);
    expect(parts.some((part) => part.prompt_cache_breakpoint)).toBe(true);
  });

  it('omits the breakpoint when the caller marks the route incapable', async () => {
    for (const model of ['gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-astra']) {
      const body = enc.encode(JSON.stringify({
        model,
        instructions: INSTRUCTIONS,
        input: [{ role: 'user', content: 'Reply with exactly: pxpipe OK' }],
      }));
      const result = await transformOpenAIResponses(body, {
        charsPerToken: 1,
        minCompressChars: 1,
        explicitPromptCacheBreakpoints: false,
      });
      expect(bodyHasPromptCacheBreakpoint(result.body), model).toBe(false);
    }
  });

  it('honors cacheBreakpoints: false in PXPIPE_GPT_PROFILES', async () => {
    expect(resolveGptProfile('gpt-5.6-sol').cacheBreakpoints).toBe(true);
    process.env.PXPIPE_GPT_PROFILES = JSON.stringify({ 'gpt-5.6-sol': { cacheBreakpoints: false } });
    expect(resolveGptProfile('gpt-5.6-sol').cacheBreakpoints).toBe(false);
    const result = await transformOpenAIResponses(solBody(), { charsPerToken: 1, minCompressChars: 1 });
    expect(bodyHasPromptCacheBreakpoint(result.body)).toBe(false);
  });

  it('strips a planted breakpoint and does not let the hybrid reintroduce one on Codex', async () => {
    const planted = enc.encode(JSON.stringify({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi', prompt_cache_breakpoint: { mode: 'explicit' } }] }],
    }));
    expect(bodyHasPromptCacheBreakpoint(scrubPromptCacheBreakpoint(planted))).toBe(false);
    const result = await hybridTransform(solBody(), {
      model: 'gpt-5.6-sol',
      wire: 'responses',
      route: { pathname: '/backend-api/codex/responses', upstream: 'https://chatgpt.com' },
      explicitPromptCacheBreakpoints: false,
      charsPerToken: 1,
      minCompressChars: 1,
    });
    expect(result.report.promptCacheBreakpoint).toBe(false);
    expect(bodyHasPromptCacheBreakpoint(result.body)).toBe(false);
  });
});
