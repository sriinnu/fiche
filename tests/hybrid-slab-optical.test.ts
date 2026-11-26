import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearStickyMarkovEpisodesForTests,
  getGlobalMmuStore,
  resetGlobalMmuStore,
} from '../src/core/context-mmu.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import {
  transformOpenAIChatCompletions,
  transformOpenAIResponses,
} from '../src/core/openai.js';
import { resetSessionState } from '../src/core/session-state.js';
import { resetTextEpochStickyState } from '../src/core/text-history.js';
import {
  applyClientSessionIdentity,
  resolveOpticalHistoryPolicy,
  transformRequest,
  type TransformInfo,
} from '../src/core/transform.js';

const SAVED_ENV = {
  FICHE_PRICES: process.env.FICHE_PRICES,
  INKLING_PRICES: process.env.INKLING_PRICES,
  FICHE_OPTICAL_MODE: process.env.FICHE_OPTICAL_MODE,
  INKLING_OPTICAL_MODE: process.env.INKLING_OPTICAL_MODE,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function resetAllState(): void {
  resetGlobalMmuStore();
  resetSessionState();
  resetTextEpochStickyState();
  clearStickyMarkovEpisodesForTests();
}

beforeEach(() => {
  restoreEnv();
  resetAllState();
});

afterEach(() => {
  restoreEnv();
  resetAllState();
});

function makeLargeSystemPrompt(label: string): string {
  const sections = Array.from(
    { length: 28 },
    (_, i) =>
      `### ${label} Rule ${i + 1}\n` +
      `Always verify module boundaries, invariant contracts, deterministic formatting, and error handling for subsystem_${i + 1}. ` +
      `Reject unvalidated input payloads, preserve exact file line formatting on edits, and log structured diagnostics.`,
  );
  return sections.join('\n\n');
}

function makeDummyInfo(): TransformInfo {
  return {
    compressed: false,
    origChars: 0,
    compressedChars: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    imageCount: 0,
    imageBytes: 0,
  };
}

describe('resolveOpticalHistoryPolicy', () => {
  it('preserves full-optical in legacy mode and switches kosha cheap-read models (<160k) to hybrid', () => {
    delete process.env.FICHE_PRICES;
    delete process.env.INKLING_PRICES;
    delete process.env.FICHE_OPTICAL_MODE;
    delete process.env.INKLING_OPTICAL_MODE;

    // Legacy defaults to full
    expect(
      resolveOpticalHistoryPolicy({
        model: 'gemini-4-argon',
        estPromptTokens: 25_000,
        textHygieneActive: true,
      }),
    ).toBe('full');

    // Explicit hybrid overrides legacy
    expect(
      resolveOpticalHistoryPolicy({
        opticalMode: 'hybrid',
        model: 'gemini-4-argon',
        estPromptTokens: 25_000,
        textHygieneActive: true,
      }),
    ).toBe('hybrid');

    // Kosha mode: 0.05x read rate + <160k -> hybrid
    process.env.FICHE_PRICES = 'kosha';
    expect(
      resolveOpticalHistoryPolicy({
        model: 'gemini-4-argon',
        estPromptTokens: 25_000,
        textHygieneActive: true,
      }),
    ).toBe('hybrid');
    expect(
      resolveOpticalHistoryPolicy({
        model: 'claude-opus-5-5',
        estPromptTokens: 80_000,
        textHygieneActive: true,
      }),
    ).toBe('hybrid');

    // >= 160k token cliff threshold -> full
    expect(
      resolveOpticalHistoryPolicy({
        model: 'gemini-4-argon',
        estPromptTokens: 160_000,
        textHygieneActive: true,
      }),
    ).toBe('full');

    // Explicit opticalMode='full', collapseHistory=true, or inactive text hygiene -> full
    expect(
      resolveOpticalHistoryPolicy({
        opticalMode: 'full',
        model: 'gemini-4-argon',
        estPromptTokens: 25_000,
        textHygieneActive: true,
      }),
    ).toBe('full');
    expect(
      resolveOpticalHistoryPolicy({
        collapseHistory: true,
        model: 'gemini-4-argon',
        estPromptTokens: 25_000,
        textHygieneActive: true,
      }),
    ).toBe('full');
    expect(
      resolveOpticalHistoryPolicy({
        model: 'gemini-4-argon',
        estPromptTokens: 25_000,
        textHygieneActive: false,
      }),
    ).toBe('full');

    // Env override FICHE_OPTICAL_MODE
    process.env.FICHE_OPTICAL_MODE = 'full';
    expect(
      resolveOpticalHistoryPolicy({
        model: 'gemini-4-argon',
        estPromptTokens: 25_000,
        textHygieneActive: true,
      }),
    ).toBe('full');
  });
});

describe('Hybrid Slab-Optical + Prefix-Monotonic Text-MMU', () => {
  it('Google Gemini (gemini-4-argon): keeps Turn-1 static slab optical & immutable, compacts dynamic turns via Text-MMU, preserves editSafe & >=85% prefix cache hit', async () => {
    process.env.FICHE_PRICES = 'kosha';

    const reportBlock = (idx: number, extraLine?: string) =>
      [
        `=== Diagnostic Report Batch ${idx} ===`,
        ...Array.from(
          { length: 42 },
          (_, j) =>
            `module_${j}_service_${(idx + j) % 7}: latency_ms=${10 + ((j * 7 + idx * 3) % 90)}, throughput=${100 + j * 11}, checksum=h${(j * 31 + idx).toString(16)}`,
        ),
        ...(extraLine ? [extraLine] : []),
        `Summary: batch_${idx} verification complete with 1 warning in src/service.ts:${idx + 10}`,
      ].join('\n');

    const olderCodeBlock = [
      '// File: src/legacy/constants.ts',
      ...Array.from(
        { length: 240 },
        (_, i) =>
          i === 40
            ? 'export function computeLegacyChecksum(seed: number): number { return (seed * 31) >>> 0; }'
            : `export const LEGACY_CONST_${i} = ${i * 13}; // legacy constant table entry ${i}`,
      ),
    ].join('\n');

    const recentFileCode = [
      'export function computeOrderTotal(items: readonly number[]): number {',
      '  // exact indentation must stay verbatim for editSafe',
      '  let   sum = 0;',
      '  for (const x of items) sum += x;',
      '  return sum;',
      '}',
    ].join('\n');

    const buildGooglePayload = (withExtraTurn: boolean) => {
      const contents: Array<Record<string, unknown>> = [
        { role: 'user', parts: [{ text: 'Audit the batch diagnostics and update computeOrderTotal.' }] },
        { role: 'model', parts: [{ functionCall: { name: 'bash', args: { cmd: 'diag 1' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'bash', response: { output: reportBlock(1) } } }] },
        { role: 'model', parts: [{ functionCall: { name: 'bash', args: { cmd: 'diag 2' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'bash', response: { output: reportBlock(1, 'extra_probe: delta_line_2 ok') } } }] },
        { role: 'model', parts: [{ functionCall: { name: 'bash', args: { cmd: 'diag 3' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'bash', response: { output: reportBlock(3) } } }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'src/legacy/constants.ts' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: olderCodeBlock } } }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'src/order.ts' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: recentFileCode } } }] },
      ];
      if (withExtraTurn) {
        contents.push({ role: 'model', parts: [{ text: 'Reviewed computeOrderTotal.' }] });
        contents.push({ role: 'user', parts: [{ text: 'Proceed with adding tax calculation.' }] });
      }
      return new TextEncoder().encode(
        JSON.stringify({
          systemInstruction: { parts: [{ text: makeLargeSystemPrompt('Gemini') }] },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'read_file',
                  description: 'Read a workspace source file verbatim with line numbers and exact whitespace.',
                  parameters: {
                    type: 'OBJECT',
                    properties: { path: { type: 'STRING', description: 'Workspace-relative file path to inspect.' } },
                    required: ['path'],
                  },
                },
                {
                  name: 'bash',
                  description: 'Execute a shell command in the workspace root and return stdout/stderr.',
                  parameters: {
                    type: 'OBJECT',
                    properties: { cmd: { type: 'STRING', description: 'Shell command string to execute.' } },
                    required: ['cmd'],
                  },
                },
              ],
            },
          ],
          contents,
        }),
      );
    };

    const opts = {
      compress: true,
      clientSessionId: 'hybrid-gemini-1',
      clientSessionSource: 'fiche-header' as const,
    };
    const r1 = await transformGoogleGenerateContent(buildGooglePayload(false), 'gemini-4-argon', opts);
    const r2 = await transformGoogleGenerateContent(buildGooglePayload(true), 'gemini-4-argon', opts);

    expect(r1.info.compressed).toBe(true);
    expect(r1.info.reason).toBe('hybrid_slab_optical');
    expect(r1.info.imageCount).toBeGreaterThan(0);
    expect(r1.info.collapsedImages).toBeUndefined();
    expect(r1.info.toolResultImgs).toBeUndefined();
    expect(r1.info.historyReason).toBeUndefined();
    expect(r1.info.textHygieneStages).toContain('hybrid_slab_optical');
    expect(r1.info.textHygieneStages).toEqual(expect.arrayContaining(['casi_delta']));
    expect(
      r1.info.textHygieneStages?.some((s) => s === 'acdc_epoch' || s === 'mmu_page'),
    ).toBe(true);

    const parsed1 = JSON.parse(new TextDecoder().decode(r1.body)) as {
      systemInstruction: { parts: Array<{ text?: string }> };
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    const parsed2 = JSON.parse(new TextDecoder().decode(r2.body)) as typeof parsed1;

    // Turn-1 static slab in contents[0] stays byte-identical across turns
    expect(JSON.stringify(parsed2.contents[0])).toBe(JSON.stringify(parsed1.contents[0]));
    expect(parsed2.systemInstruction).toEqual(parsed1.systemInstruction);

    // Prefix cache hit rate across turns (shared leading contents bytes / total r1 bytes) >= 85%
    let matchedChars = 0;
    let totalR1Chars = 0;
    for (let i = 0; i < parsed1.contents.length; i++) {
      const s1 = JSON.stringify(parsed1.contents[i]);
      const s2 = JSON.stringify(parsed2.contents[i]);
      totalR1Chars += s1.length;
      if (s1 === s2) matchedChars += s1.length;
    }
    expect(matchedChars / totalR1Chars).toBeGreaterThanOrEqual(0.85);

    // editSafe: recent read_file output in live tail preserves exact indentation/code verbatim
    const recentResp = parsed2.contents[10]?.parts?.[0] as
      | { functionResponse?: { response?: { content?: string } } }
      | undefined;
    expect(recentResp?.functionResponse?.response?.content).toBe(recentFileCode);
  });

  it('Anthropic (claude-opus-5-5): runs Turn-1 static slab optical + dynamic Text-MMU in hybrid mode', async () => {
    process.env.FICHE_PRICES = 'kosha';

    const repeatedLog = Array.from(
      { length: 42 },
      (_, i) => `2026-11-24T11:00:${String(i).padStart(2, '0')}Z INFO check=${i} status=ok`,
    ).join('\n');

    const req = {
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      system: makeLargeSystemPrompt('Anthropic'),
      tools: [
        {
          name: 'bash',
          description: 'Run shell command in workspace',
          input_schema: {
            type: 'object',
            properties: { cmd: { type: 'string', description: 'Shell command' } },
            required: ['cmd'],
          },
        },
      ],
      messages: [
        { role: 'user', content: 'Inspect the build logs.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'test 1' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: repeatedLog }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'bash', input: { cmd: 'test 2' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: repeatedLog + '\n2026-11-24T11:01:00Z ERROR step_2 failed' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_3', name: 'bash', input: { cmd: 'test 3' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: repeatedLog + '\n2026-11-24T11:02:00Z INFO step_3 ok' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Logs reviewed.' }] },
        { role: 'user', content: 'Summarize failures.' },
      ],
    };

    const res = await transformRequest(new TextEncoder().encode(JSON.stringify(req)), {
      model: 'claude-opus-5-5',
      clientSessionId: 'hybrid-anth-1',
      clientSessionSource: 'fiche-header',
    });

    expect(res.info.compressed).toBe(true);
    expect(res.info.reason).toBe('hybrid_slab_optical');
    expect(res.info.imageCount).toBeGreaterThan(0);
    expect(res.info.collapsedImages).toBeUndefined();
    expect(res.info.toolResultImgs).toBeUndefined();
    expect(res.info.textHygieneStages).toContain('hybrid_slab_optical');
    expect(res.info.textHygieneStages).toContain('casi_delta');
    expect(res.info.textHygieneSavedChars ?? 0).toBeGreaterThan(0);
  });

  it('OpenAI Responses (gpt-5.4): runs static slab optical + dynamic Text-MMU in hybrid mode', async () => {
    process.env.FICHE_PRICES = 'kosha';

    const repeatedLog = Array.from(
      { length: 42 },
      (_, i) => `2026-11-24T12:00:${String(i).padStart(2, '0')}Z INFO task=${i} ok=true`,
    ).join('\n');

    const req = {
      model: 'gpt-5.4',
      instructions: makeLargeSystemPrompt('Responses'),
      tools: [
        {
          type: 'function',
          name: 'run_cmd',
          description: 'Execute diagnostic command in workspace',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string', description: 'Command string' } },
            required: ['cmd'],
          },
        },
      ],
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Run diagnostics.' }] },
        { type: 'function_call', call_id: 'fc_1', name: 'run_cmd', arguments: '{"cmd":"diag 1"}' },
        { type: 'function_call_output', call_id: 'fc_1', output: repeatedLog },
        { type: 'function_call', call_id: 'fc_2', name: 'run_cmd', arguments: '{"cmd":"diag 2"}' },
        { type: 'function_call_output', call_id: 'fc_2', output: repeatedLog + '\n2026-11-24T12:01:00Z ERROR diag_2 failed' },
        { type: 'function_call', call_id: 'fc_3', name: 'run_cmd', arguments: '{"cmd":"diag 3"}' },
        { type: 'function_call_output', call_id: 'fc_3', output: repeatedLog + '\n2026-11-24T12:02:00Z INFO diag_3 ok' },
        { role: 'user', content: [{ type: 'input_text', text: 'Report summary.' }] },
      ],
    };

    const res = await transformOpenAIResponses(new TextEncoder().encode(JSON.stringify(req)), {
      model: 'gpt-5.4',
      clientSessionId: 'hybrid-resp-1',
      clientSessionSource: 'fiche-header',
    });

    expect(res.info.compressed).toBe(true);
    expect(res.info.reason).toBe('hybrid_slab_optical');
    expect(res.info.imageCount).toBeGreaterThan(0);
    expect(res.info.collapsedImages).toBeUndefined();
    expect(res.info.textHygieneStages).toContain('hybrid_slab_optical');
    expect(res.info.textHygieneStages).toContain('casi_delta');
    expect(res.info.textHygieneSavedChars ?? 0).toBeGreaterThan(0);
  });
});

describe('Active-Turn-Only Intent Window (extract*LiveTailTexts)', () => {
  it('does NOT re-trigger mmu_hydrate on stale symbols from Turn t-1 user prompt across Anthropic, Google, Chat, and Responses', async () => {
    const store = getGlobalMmuStore();
    const staleBody = [
      'export function verifyStaleLeakGuardSymbol(token: string): boolean {',
      '  return token === "STALE_HYDRATE_SENTINEL";',
      '}',
    ].join('\n');
    const pad = Array.from({ length: 24 }, (_, i) => `const pad_${i} = ${i};`).join('\n');

    const seedPage = async (sessionId: string, anchor: string) => {
      const sessionKey = await applyClientSessionIdentity(makeDummyInfo(), anchor, {
        clientSessionId: sessionId,
        clientSessionSource: 'fiche-header',
      });
      store.storePage({
        sessionKey: sessionKey!,
        refId: 'prev_read',
        filePath: 'src/guard.ts',
        rawText: `${pad}\n${staleBody}`,
      });
    };

    // 1. Anthropic
    await seedPage('tail-anth', 'Check verifyStaleLeakGuardSymbol');
    const anthReq = {
      model: 'claude-opus-5-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'Check verifyStaleLeakGuardSymbol in src/guard.ts.' },
        { role: 'assistant', content: [{ type: 'text', text: 'Done checking.' }] },
        { role: 'user', content: 'Now summarize overall readiness.' },
      ],
    };
    const anthOut = await transformRequest(new TextEncoder().encode(JSON.stringify(anthReq)), {
      model: 'claude-opus-5-5',
      imageCompress: false,
      textHygiene: 'on',
      clientSessionId: 'tail-anth',
      clientSessionSource: 'fiche-header',
    });
    expect(anthOut.info.textHygieneStages ?? []).not.toContain('mmu_hydrate');
    expect(new TextDecoder().decode(anthOut.body)).not.toContain('STALE_HYDRATE_SENTINEL');

    // Multi-block Anthropic trailing user message with BOTH tool_result fault & text prompt hydrates!
    const anthFaultReq = {
      model: 'claude-opus-5-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'Earlier turn.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_x', name: 'bash', input: { cmd: 'test' } }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_x', content: 'TypeError: verifyStaleLeakGuardSymbol failed\n  at check (guard.ts:2)' },
            { type: 'text', text: 'Explain this failure.' },
          ],
        },
      ],
    };
    const anthFaultOut = await transformRequest(new TextEncoder().encode(JSON.stringify(anthFaultReq)), {
      model: 'claude-opus-5-5',
      imageCompress: false,
      textHygiene: 'on',
      clientSessionId: 'tail-anth',
      clientSessionSource: 'fiche-header',
    });
    expect(anthFaultOut.info.textHygieneStages ?? []).toContain('mmu_hydrate');
    expect(new TextDecoder().decode(anthFaultOut.body)).toContain('STALE_HYDRATE_SENTINEL');

    // 2. Google Gemini
    await seedPage('tail-goog', 'Check verifyStaleLeakGuardSymbol');
    const googReq = {
      contents: [
        { role: 'user', parts: [{ text: 'Check verifyStaleLeakGuardSymbol in src/guard.ts.' }] },
        { role: 'model', parts: [{ text: 'Done checking.' }] },
        { role: 'user', parts: [{ text: 'Now summarize overall readiness.' }] },
      ],
    };
    const googOut = await transformGoogleGenerateContent(
      new TextEncoder().encode(JSON.stringify(googReq)),
      'gemini-4-neon',
      {
        imageCompress: false,
        textHygiene: 'on',
        clientSessionId: 'tail-goog',
        clientSessionSource: 'fiche-header',
      },
    );
    expect(googOut.info.textHygieneStages ?? []).not.toContain('mmu_hydrate');
    expect(new TextDecoder().decode(googOut.body)).not.toContain('STALE_HYDRATE_SENTINEL');

    // 3. OpenAI Chat Completions
    await seedPage('tail-chat', 'Check verifyStaleLeakGuardSymbol');
    const chatReq = {
      model: 'gpt-5.4',
      messages: [
        { role: 'user', content: 'Check verifyStaleLeakGuardSymbol in src/guard.ts.' },
        { role: 'assistant', content: 'Done checking.' },
        { role: 'user', content: 'Now summarize overall readiness.' },
      ],
    };
    const chatOut = await transformOpenAIChatCompletions(
      new TextEncoder().encode(JSON.stringify(chatReq)),
      {
        model: 'gpt-5.4',
        imageCompress: false,
        textHygiene: 'on',
        clientSessionId: 'tail-chat',
        clientSessionSource: 'fiche-header',
      },
    );
    expect(chatOut.info.textHygieneStages ?? []).not.toContain('mmu_hydrate');
    expect(new TextDecoder().decode(chatOut.body)).not.toContain('STALE_HYDRATE_SENTINEL');

    // 4. OpenAI Responses
    await seedPage('tail-resp', 'Check verifyStaleLeakGuardSymbol');
    const respReq = {
      model: 'gpt-5.4',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Check verifyStaleLeakGuardSymbol in src/guard.ts.' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Done checking.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Now summarize overall readiness.' }] },
      ],
    };
    const respOut = await transformOpenAIResponses(
      new TextEncoder().encode(JSON.stringify(respReq)),
      {
        model: 'gpt-5.4',
        imageCompress: false,
        textHygiene: 'on',
        clientSessionId: 'tail-resp',
        clientSessionSource: 'fiche-header',
      },
    );
    expect(respOut.info.textHygieneStages ?? []).not.toContain('mmu_hydrate');
    expect(new TextDecoder().decode(respOut.body)).not.toContain('STALE_HYDRATE_SENTINEL');
  });
});
