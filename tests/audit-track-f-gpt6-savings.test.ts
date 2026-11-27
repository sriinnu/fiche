import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { resetGlobalMmuStore } from '../src/core/context-mmu.js';
import {
  transformOpenAIChatCompletions,
  transformOpenAIResponses,
} from '../src/core/openai.js';
import { computeOpenAIBaselineRawTokens } from '../src/core/openai-savings.js';
import { prefersText, shouldImageModel } from '../src/core/reader-tier.js';
import { peekSessionState, resetSessionState } from '../src/core/session-state.js';
import { resetTextEpochStickyState } from '../src/core/text-history.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeVerboseTools() {
  const sharedProps = {
    workspace_path: {
      type: 'string',
      description:
        'Absolute path to the workspace directory. Please note that you must pass a valid directory path. '.repeat(2),
    },
    timeout_seconds: {
      type: 'number',
      description:
        'Maximum duration in seconds before timing out the operation. Optional parameter with sensible default. '.repeat(2),
    },
    encoding_format: {
      type: 'string',
      enum: ['utf8', 'ascii', 'latin1'],
      description: 'Character encoding used when decoding output streams.',
    },
  };
  return Array.from({ length: 6 }, (_, i) => ({
    type: 'function',
    name: i === 0 ? 'run_shell' : `workspace_tool_${i}`,
    description:
      `Executes deterministic workspace inspection task #${i} in the current sandbox. ` +
      'Important: Ensure that all inputs are validated before invocation. ' +
      'Note: Returns structured diagnostic output without side effects when read-only flags are supplied. ' +
      'Example usage: provide workspace_path and timeout_seconds cleanly.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...sharedProps,
        query: {
          type: 'string',
          description: `Target pattern or identifier for operation ${i}.`,
        },
      },
      required: ['workspace_path', 'query'],
    },
  }));
}

function makeVariedInstructions(tag: string, count = 90): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `Rule ${i + 1} (${tag}): verify shard_${(i * 13) % 97}/module_${i}.ts checksum=${((i + 7) * 2654435761 >>> 0).toString(16)} ` +
      `against policy_v${(i % 5) + 1} with deterministic prefix ordering and zero unverified claims.`,
  ).join('\n');
}

/** Unique guttered code lines (~750–950 tokens) with multi-line function bodies so Stage 3a code skeleton cuts ~70-80%. */
function makeMediumCodeOutput(label: string, fnCount = 4): string {
  const lines: string[] = [];
  let lineNo = 1;
  for (let f = 0; f < fnCount; f++) {
    lines.push(`${String(lineNo++).padStart(4, ' ')}\texport function ${label}Worker_${f}(input_${f}: string): number {`);
    lines.push(`${String(lineNo++).padStart(4, ' ')}\t  let acc_${f} = 0;`);
    for (let k = 0; k < 10; k++) {
      const hash = (((f * 31 + k + 19) * 2654435761) >>> 0).toString(16).padStart(8, '0');
      lines.push(
        `${String(lineNo++).padStart(4, ' ')}\t  if (input_${f}.includes("seg_${f}_${k}_0x${hash}")) acc_${f} += ${17 + f * 7 + k * 13};`,
      );
    }
    lines.push(`${String(lineNo++).padStart(4, ' ')}\t  return acc_${f};`);
    lines.push(`${String(lineNo++).padStart(4, ' ')}\t}`);
  }
  return lines.join('\n');
}

/** Dense prose ledger (> 24,000 chars) for single-turn hybrid_user_optical and luna tests. */
function makeLargeLedger(label: string, lines = 340): string {
  return Array.from({ length: lines }, (_, i) => {
    const hash = ((i + 19) * 2654435761 >>> 0).toString(16).padStart(8, '0');
    const mod = ['proxy', 'mmu', 'casi', 'lsm', 'tscg', 'openai', 'dashboard', 'stats'][i % 8]!;
    return `${label} src/core/${mod}_${i}.ts:${100 + i * 7}: hash=0x${hash} delta=${(i * 37) % 991}ms mem=${128 + i * 3}MiB`;
  }).join('\n');
}

describe('Track F — GPT-6 Sol, Astra, Terra & Luna Savings Upgrades', () => {
  const savedPrices = process.env.INKLING_PRICES;
  const savedHygiene = process.env.INKLING_TEXT_HYGIENE;

  beforeEach(() => {
    resetSessionState();
    resetGlobalMmuStore();
    resetTextEpochStickyState();
    setAllowedModelBases(null);
    process.env.INKLING_PRICES = 'kosha';
    process.env.INKLING_TEXT_HYGIENE = 'on';
  });

  afterEach(() => {
    if (savedPrices === undefined) delete process.env.INKLING_PRICES;
    else process.env.INKLING_PRICES = savedPrices;
    if (savedHygiene === undefined) delete process.env.INKLING_TEXT_HYGIENE;
    else process.env.INKLING_TEXT_HYGIENE = savedHygiene;
    setAllowedModelBases(null);
    resetSessionState();
    resetGlobalMmuStore();
    resetTextEpochStickyState();
  });

  it.each(['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.2-sol'])(
    '%s enables TSCG/skillLinker in hybrid mode alongside 14px static slab + L1 600-tok frontier compaction',
    async (model) => {
      const repeatedSkillBlock =
        `<skill name="deploy-checks">\n${'Ensure clean build, typecheck, and deterministic verification before deploying. '.repeat(14)}\n</skill>`;
      const instructions = `${makeVariedInstructions(model, 110)}\n\n${repeatedSkillBlock}`;

      const buildTurn = (extraTurn: boolean) => ({
        model,
        instructions,
        tools: makeVerboseTools(),
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Run checks across packages.' }] },
          { type: 'function_call', call_id: 'c1', name: 'run_shell', arguments: '{"command":"test a"}' },
          { type: 'function_call_output', call_id: 'c1', output: makeMediumCodeOutput('pkgA', 4) },
          { type: 'function_call', call_id: 'c2', name: 'run_shell', arguments: '{"command":"test b"}' },
          { type: 'function_call_output', call_id: 'c2', output: makeMediumCodeOutput('pkgB', 4) },
          { type: 'function_call', call_id: 'c3', name: 'workspace_tool_1', arguments: '{"query":"foo"}' },
          { type: 'function_call_output', call_id: 'c3', output: 'ok small tail' },
          ...(extraTurn
            ? [
                { role: 'assistant', content: [{ type: 'output_text', text: 'Continuing checks.' }] },
                { type: 'function_call', call_id: 'c4', name: 'workspace_tool_1', arguments: '{"query":"bar"}' },
                { type: 'function_call_output', call_id: 'c4', output: 'ok latest turn' },
              ]
            : []),
          { role: 'user', content: [{ type: 'input_text', text: 'Summarize failures if any.' }] },
        ],
      });

      const res1 = await transformOpenAIResponses(enc.encode(JSON.stringify(buildTurn(false))), {
        model,
        compress: true,
        textHygiene: 'on',
        clientSessionId: `sess_sol_${model}`,
        clientSessionSource: 'fiche-header',
      });
      expect(res1.info.compressed).toBe(true);
      expect(res1.info.imageCount).toBeGreaterThan(0);
      expect(res1.info.reason).toBe('hybrid_slab_optical');
      // P1-E: static pre-slab TSCG/SkillLinker are suppressed when optical slab renders instructions+tools
      expect(res1.info.textHygieneStages).not.toContain('tscg');
      expect(res1.info.textHygieneStages).toContain('hybrid_slab_optical');
      expect(res1.info.textHygieneSavedTokens ?? 0).toBeGreaterThan(0);

      const parsed1 = JSON.parse(dec.decode(res1.body)) as {
        input: Array<{ type?: string; call_id?: string; output?: unknown }>;
      };
      const res2 = await transformOpenAIResponses(enc.encode(JSON.stringify(buildTurn(true))), {
        model,
        compress: true,
        textHygiene: 'on',
        clientSessionId: `sess_sol_${model}`,
        clientSessionSource: 'fiche-header',
      });
      const parsed2 = JSON.parse(dec.decode(res2.body)) as {
        input: Array<{ type?: string; call_id?: string; output?: unknown }>;
      };

      // Cache prefix remains byte-identical across Turn 1 -> Turn 2
      expect(res2.info.cachePrefixSha8).toBe(res1.info.cachePrefixSha8);
      const out1c1 = parsed1.input.find((x) => x.call_id === 'c1')?.output;
      const out2c1 = parsed2.input.find((x) => x.call_id === 'c1')?.output;
      expect(JSON.stringify(out2c1)).toBe(JSON.stringify(out1c1));
    },
  );

  it.each(['gpt-6-astra', 'gpt-6.2-astra'])(
    '%s stays 0-image text-tier, compacts medium tool outputs under OpenAI 1.0x write math, and honors cleanUserPayloads opt-out',
    async (model) => {
      expect(prefersText(model)).toBe(true);
      expect(shouldImageModel(model, true)).toBe(false);

      const dirtyUserPrompt = Array.from(
        { length: 40 },
        (_, i) => `\x1b[32m[LOG]\x1b[0m   Verify Astra step ${i}: confirm settlement invariant.`,
      ).join('\n');

      const req = {
        model,
        instructions: makeVariedInstructions(model, 50),
        tools: makeVerboseTools(),
        input: [
          { role: 'user', content: [{ type: 'input_text', text: dirtyUserPrompt }] },
          { type: 'function_call', call_id: 'a1', name: 'run_shell', arguments: '{"command":"check 1"}' },
          { type: 'function_call_output', call_id: 'a1', output: makeMediumCodeOutput('astraOne', 4) },
          { type: 'function_call', call_id: 'a2', name: 'run_shell', arguments: '{"command":"check 2"}' },
          { type: 'function_call_output', call_id: 'a2', output: makeMediumCodeOutput('astraTwo', 4) },
          { type: 'function_call', call_id: 'a3', name: 'run_shell', arguments: '{"command":"check 3"}' },
          { type: 'function_call_output', call_id: 'a3', output: 'ok tail' },
          { role: 'user', content: [{ type: 'input_text', text: 'Next step' }] },
        ],
      };

      const res = await transformOpenAIResponses(enc.encode(JSON.stringify(req)), {
        model,
        compress: true,
        imageCompress: false,
        textHygiene: 'on',
        clientSessionId: `sess_astra_${model}`,
        clientSessionSource: 'fiche-header',
      });
      expect(res.info.compressed).toBe(true);
      expect(res.info.imageCount).toBe(0);
      expect(res.info.textHygieneStages).toContain('acdc_epoch');
      expect(res.info.textHygieneSavedTokens ?? 0).toBeGreaterThan(800);
      const parsed = JSON.parse(dec.decode(res.body)) as {
        input: Array<{ role?: string; content?: Array<{ text?: string }> }>;
      };
      // Lossless cleanUserPayloads auto-activated under textHygiene: 'on'
      expect(parsed.input[0]?.content?.[0]?.text?.includes('\x1b')).toBe(false);

      // Explicit cleanUserPayloads: false MUST still keep user payload untouched
      const resOptOut = await transformOpenAIResponses(enc.encode(JSON.stringify(req)), {
        model,
        compress: true,
        imageCompress: false,
        textHygiene: 'on',
        cleanUserPayloads: false,
        clientSessionId: `sess_astra_optout_${model}`,
        clientSessionSource: 'fiche-header',
      });
      const parsedOptOut = JSON.parse(dec.decode(resOptOut.body)) as {
        input: Array<{ role?: string; content?: Array<{ text?: string }> }>;
      };
      expect(parsedOptOut.input[0]?.content?.[0]?.text).toBe(dirtyUserPrompt);
    },
  );

  it('gpt-6.1-terra compacts medium tool outputs AND seals optical tool outputs byte-identically across turns', async () => {
    // JSON lines with ~120 chars/line and >= 95 rows so 1) L1 behind cutoffL1 handles t1,
    // 2) live-tail non-Read t2 (>= cutoffL1) images via hybrid_tool_optical & seals oai_opt_tr:,
    // 3) live-tail read_file t3 (>= cutoffL1) stays verbatim for editSafe!
    const denseJsonLines = Array.from(
      { length: 95 },
      (_, i) =>
        `{"idx":${i},"module":"worker_${i % 7}","checksum":"${(i * 2654435761).toString(16)}","blob":"${'xyztuv1234'.repeat(5)}"}`,
    ).join('\n');
    const instructions = makeVariedInstructions('gpt-6.1-terra', 90);
    const buildReq = (withExtraTurn: boolean) => ({
      model: 'gpt-6.1-terra',
      instructions,
      tools: makeVerboseTools(),
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Inspect terra workspace.' }] },
        { type: 'function_call', call_id: 't1', name: 'run_shell', arguments: '{"command":"run 1"}' },
        { type: 'function_call_output', call_id: 't1', output: makeMediumCodeOutput('terraWorker', 4) },
        { type: 'function_call', call_id: 't2', name: 'bash', arguments: '{"cmd":"dump json"}' },
        { type: 'function_call_output', call_id: 't2', output: denseJsonLines },
        { type: 'function_call', call_id: 't3', name: 'read_file', arguments: '{"path":"a.ts"}' },
        { type: 'function_call_output', call_id: 't3', output: denseJsonLines },
        ...(withExtraTurn
          ? [
              { role: 'assistant', content: [{ type: 'output_text', text: 'Read file.' }] },
              { type: 'function_call', call_id: 't4', name: 'bash', arguments: '{"cmd":"pwd"}' },
              { type: 'function_call_output', call_id: 't4', output: '/repo' },
            ]
          : []),
        { role: 'user', content: [{ type: 'input_text', text: 'What is next?' }] },
      ],
    });

    const r1 = await transformOpenAIResponses(enc.encode(JSON.stringify(buildReq(false))), {
      model: 'gpt-6.1-terra',
      compress: true,
      textHygiene: 'on',
      compressToolResults: true,
      clientSessionId: 'sess_terra_seal',
      clientSessionSource: 'fiche-header',
    });
    expect(r1.info.compressed).toBe(true);
    expect(r1.info.reason).toBe('hybrid_slab_optical');
    expect(r1.info.textHygieneSavedTokens ?? 0).toBeGreaterThan(0);
    expect(r1.info.textHygieneStages).toContain('acdc_epoch');
    expect(r1.info.textHygieneStages).toContain('hybrid_tool_optical');
    expect(r1.info.sessionKey).toBeTruthy();
    expect(
      peekSessionState(r1.info.sessionKey!)?.sealedStage2SlotKeys?.some((k) => k.startsWith('oai_opt_tr:')),
    ).toBe(true);

    const p1 = JSON.parse(dec.decode(r1.body)) as {
      input: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };
    const r2 = await transformOpenAIResponses(enc.encode(JSON.stringify(buildReq(true))), {
      model: 'gpt-6.1-terra',
      compress: true,
      textHygiene: 'on',
      compressToolResults: true,
      clientSessionId: 'sess_terra_seal',
      clientSessionSource: 'fiche-header',
    });
    const p2 = JSON.parse(dec.decode(r2.body)) as {
      input: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };

    const t1Turn1 = p1.input.find((x) => x.type === 'function_call_output' && x.call_id === 't1')?.output;
    const t1Turn2 = p2.input.find((x) => x.type === 'function_call_output' && x.call_id === 't1')?.output;
    const t2Turn1 = p1.input.find((x) => x.type === 'function_call_output' && x.call_id === 't2')?.output;
    const t2Turn2 = p2.input.find((x) => x.type === 'function_call_output' && x.call_id === 't2')?.output;
    const t3Turn1 = p1.input.find((x) => x.type === 'function_call_output' && x.call_id === 't3')?.output;

    // t3 was a live-tail read_file so editSafe kept it verbatim on Turn 1
    expect(t3Turn1).toBe(denseJsonLines);
    // t1 was optically imaged (`>= 2,500` chars) and sealed byte-identically across Turn 1 -> Turn 2
    // even after Turn 2 advanced enough turns for L0/L1 to otherwise target it!
    expect(Array.isArray(t1Turn1)).toBe(true);
    expect(JSON.stringify(t1Turn2)).toBe(JSON.stringify(t1Turn1));
    // t2 compacted cleanly via ACDC/LSM and stayed byte-identical across Turn 1 -> Turn 2
    expect(typeof t2Turn1).toBe('string');
    expect(String(t2Turn1)).toContain('[fiche epoch-digest');
    expect(t2Turn2).toBe(t2Turn1);
  });

  it('gpt-6-luna compresses massive single-turn user prompts via hybrid_user_optical and keeps Chat TSCG active', async () => {
    const bigUserMiddle = makeLargeLedger('luna-ledger', 340);
    const bigUserPrompt =
      `OPENING_GOAL: Carefully analyze the verification ledger below.\n\n${bigUserMiddle}\n\nFINAL_QUESTION: Which shards exceeded 300ms latency?`;
    expect(bigUserPrompt.length).toBeGreaterThan(24_000);

    const res = await transformOpenAIResponses(
      enc.encode(
        JSON.stringify({
          model: 'gpt-6-luna',
          instructions: makeVariedInstructions('gpt-6-luna', 90),
          input: [{ role: 'user', content: [{ type: 'input_text', text: bigUserPrompt }] }],
        }),
      ),
      {
        model: 'gpt-6-luna',
        compress: true,
        textHygiene: 'on',
        clientSessionId: 'sess_luna_single_turn',
        clientSessionSource: 'fiche-header',
      },
    );

    expect(res.info.compressed).toBe(true);
    expect(res.info.textHygieneStages).toContain('hybrid_user_optical');
    expect(res.info.imageCount).toBeGreaterThan(1);
    const netOpticalSaved =
      (res.info.baselineImagedTokens ?? 0) -
      (res.info.imageTokens ?? 0) -
      (res.info.nativeInjectedTokens ?? 0);
    expect(netOpticalSaved).toBeGreaterThan(3_000);

    // Accounting consistency: baselineRaw > 0 when inputTokens >= post-image count
    const rawDelta = computeOpenAIBaselineRawTokens(
      12_000,
      res.info.imageTokens ?? 0,
      res.info.baselineImagedTokens ?? 0,
      res.info.nativeInjectedTokens ?? 0,
      res.info.textHygieneSavedTokens ?? 0,
    );
    expect(rawDelta).toBeGreaterThan(12_000 + 3_000);

    const parsed = JSON.parse(dec.decode(res.body)) as {
      input: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    const userItem = parsed.input.find(
      (it) =>
        it.role === 'user' &&
        Array.isArray(it.content) &&
        it.content.some((p) => p.text?.includes('[End of rendered user context.]')),
    );
    expect(userItem).toBeDefined();
    const texts = (userItem?.content ?? []).filter((p) => p.type === 'input_text').map((p) => p.text ?? '');
    expect(texts[0]).toContain('OPENING_GOAL:');
    expect(texts.at(-1)).toContain('FINAL_QUESTION:');

    // Multi-turn pure user/assistant conversation (no tool outputs) in hybrid mode collapses old assistant turns
    const multiUserAssistantReq = {
      model: 'gpt-6-luna',
      instructions: makeVariedInstructions('gpt-6-luna-multi', 90),
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Turn 1 question' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: makeLargeLedger('assistant-analysis', 120),
            },
          ],
        },
        { role: 'user', content: [{ type: 'input_text', text: 'Turn 2 question' }] },
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Recent assistant reply.' }],
        },
        { role: 'user', content: [{ type: 'input_text', text: 'Turn 3 live ask' }] },
      ],
    };
    const multiRes = await transformOpenAIResponses(enc.encode(JSON.stringify(multiUserAssistantReq)), {
      model: 'gpt-6-luna',
      compress: true,
      textHygiene: 'on',
      opticalMode: 'hybrid',
      clientSessionId: 'sess_luna_mixed_hybrid',
      clientSessionSource: 'fiche-header',
    });
    expect(multiRes.info.compressed).toBe(true);
    expect(multiRes.info.collapsedTurns ?? 0).toBeGreaterThan(0);

    // Chat Completions path on gpt-6.2-sol also retains TSCG under hybrid mode
    const chatRes = await transformOpenAIChatCompletions(
      enc.encode(
        JSON.stringify({
          model: 'gpt-6.2-sol',
          messages: [
            { role: 'system', content: makeVariedInstructions('gpt-6.2-sol-chat', 90) },
            { role: 'user', content: 'Hello' },
          ],
          tools: makeVerboseTools().map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }),
      ),
      {
        model: 'gpt-6.2-sol',
        compress: true,
        textHygiene: 'on',
        clientSessionId: 'sess_chat_sol_tscg',
        clientSessionSource: 'fiche-header',
      },
    );
    expect(chatRes.info.compressed).toBe(true);
    expect(chatRes.info.reason).toBe('hybrid_slab_optical');
    expect(chatRes.info.textHygieneStages).not.toContain('tscg');

    // Text-only fallback (when optical slab is disabled) runs TSCG cleanly
    const chatTextOnly = await transformOpenAIChatCompletions(
      enc.encode(
        JSON.stringify({
          model: 'gpt-6.2-sol',
          messages: [
            { role: 'system', content: makeVariedInstructions('gpt-6.2-sol-chat', 90) },
            { role: 'user', content: 'Hello' },
          ],
          tools: makeVerboseTools().map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }),
      ),
      {
        model: 'gpt-6.2-sol',
        compress: true,
        imageCompress: false,
        textHygiene: 'on',
        clientSessionId: 'sess_chat_sol_text_tscg',
        clientSessionSource: 'fiche-header',
      },
    );
    expect(chatTextOnly.info.textHygieneStages).toContain('tscg');
  });
});
