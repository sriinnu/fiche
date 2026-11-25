import { describe, expect, it } from 'vitest';
import {
  GEAR_TABLE,
  canonicalForMatching,
  createCasiIndex,
  stripLineGutter,
} from '../src/core/casi-delta.js';
import {
  applyAnthropicTextHygiene,
  applyGoogleTextHygiene,
  applyOpenAIChatTextHygiene,
  applyOpenAIResponsesTextHygiene,
} from '../src/core/text-hygiene.js';

describe('CASI v2: Gutter-Normalized FastCDC Rope', () => {
  it('exports deterministic SplitMix32 GEAR_TABLE, stripLineGutter, and canonicalForMatching', () => {
    expect(GEAR_TABLE).toBeInstanceOf(Uint32Array);
    expect(GEAR_TABLE).toHaveLength(256);
    expect(new Set(GEAR_TABLE).size).toBe(256);

    expect(stripLineGutter('   1→  const x = 1;')).toEqual({ lineNum: 1, body: '  const x = 1;' });
    expect(stripLineGutter('42\treturn x;')).toEqual({ lineNum: 42, body: 'return x;' });
    expect(stripLineGutter('  12 │   indented')).toEqual({ lineNum: 12, body: '  indented' });
    expect(stripLineGutter('  12 |')).toEqual({ lineNum: 12, body: '' });
    expect(stripLineGutter('L905: const y = 2;')).toEqual({ lineNum: 905, body: 'const y = 2;' });
    expect(stripLineGutter('12345678\ttoo-many-digits')).toEqual({
      lineNum: null,
      body: '12345678\ttoo-many-digits',
    });
    expect(stripLineGutter('plain code line')).toEqual({ lineNum: null, body: 'plain code line' });

    const canon = canonicalForMatching(
      '2026-11-23T14:22:05.123Z INFO step completed in 42.5ms at 14:22:05',
    );
    expect(canon).toBe('<TS> INFO step completed in <DUR> at <TIME>');
  });

  it('detects uniform line-number shifts (+deltaL / -deltaL) on unchanged guttered file reads', () => {
    const bodies = Array.from(
      { length: 40 },
      (_, i) => `export function step_${i}(arg: number): number { return arg + ${i * 7}; }`,
    );
    const readV1 = bodies.map((b, i) => `${String(i + 1).padStart(4)}→${b}`).join('\n');
    const readShifted = bodies.map((b, i) => `${String(i + 11).padStart(4)}→${b}`).join('\n');

    const casi = createCasiIndex();
    expect(casi.ingest(readV1, 'read_1', 0).changed).toBe(false);
    const shiftedRes = casi.ingest(readShifted, 'read_2', 1);
    expect(shiftedRes.changed).toBe(true);
    expect(shiftedRes.kind).toBe('exact_dup');
    expect(shiftedRes.baseRefId).toBe('read_1');
    expect(shiftedRes.text).toBe(
      `[fiche cas: lines shifted +10L vs read_1 (40 lines, ${readShifted.length} chars) — body unchanged]`,
    );

    // Negative shift (-5L) works symmetrically
    const readBase20 = bodies.map((b, i) => `${String(i + 20).padStart(4)}→${b}`).join('\n');
    const readDown5 = bodies.map((b, i) => `${String(i + 15).padStart(4)}→${b}`).join('\n');
    const casi2 = createCasiIndex();
    casi2.ingest(readBase20, 'r_a', 0);
    const downRes = casi2.ingest(readDown5, 'r_b', 1);
    expect(downRes.changed).toBe(true);
    expect(downRes.text).toContain('lines shifted -5L vs r_a');
  });

  it('aligns +3L shifted files with edits via canonical bodies while keeping exact curLines & duration edits lossless', () => {
    const bodies = Array.from(
      { length: 70 },
      (_, i) => `export const configItem_${i} = { index: ${i}, label: "node_${i}" };`,
    );
    const v1 = bodies.map((b, i) => `${String(i + 1).padStart(4)}→${b}`).join('\n');
    const editedBodies = [...bodies];
    editedBodies[25] = 'export const configItem_25 = { index: 25, label: "CHANGED_25" };';
    const v2 = editedBodies.map((b, i) => `${String(i + 4).padStart(4)}→${b}`).join('\n');

    const casi = createCasiIndex();
    casi.ingest(v1, 'read_1', 0);
    const deltaRes = casi.ingest(v2, 'read_2', 1);
    expect(deltaRes.changed).toBe(true);
    expect(deltaRes.kind).toBe('delta');
    expect(deltaRes.text).toContain('-  26→export const configItem_25 = { index: 25, label: "node_25" };');
    expect(deltaRes.text).toContain('+  29→export const configItem_25 = { index: 25, label: "CHANGED_25" };');
    expect(deltaRes.text).toContain('   28→export const configItem_24');

    // Never mask a literal duration change ("10ms" -> "500ms") in guttered code as "body unchanged"
    const codeWithDur1 = Array.from({ length: 40 }, (_, i) =>
      `${String(i + 1).padStart(4)}→export const timeout_${i} = ${i === 15 ? '"10ms"' : `"${i + 100}"`};`,
    ).join('\n');
    const codeWithDur2 = Array.from({ length: 40 }, (_, i) =>
      `${String(i + 4).padStart(4)}→export const timeout_${i} = ${i === 15 ? '"500ms"' : `"${i + 100}"`};`,
    ).join('\n');
    const casiDur = createCasiIndex();
    casiDur.ingest(codeWithDur1, 'd1', 0);
    const durRes = casiDur.ingest(codeWithDur2, 'd2', 1);
    expect(durRes.changed).toBe(true);
    expect(durRes.kind).toBe('delta');
    expect(durRes.text).toContain('"10ms"');
    expect(durRes.text).toContain('"500ms"');
  });

  it('aligns logs across shifting ISO timestamps & durations while emitting exact curLines inside hunks', () => {
    const makeLog = (hour: number, baseMs: number, errorLine: string) =>
      Array.from({ length: 60 }, (_, i) => {
        if (i === 30) return `2026-11-23T${String(hour).padStart(2, '0')}:00:30Z ${errorLine}`;
        return `2026-11-23T${String(hour).padStart(2, '0')}:00:${String(i).padStart(2, '0')}Z INFO job_${i} completed in ${baseMs + i}ms`;
      }).join('\n');

    const log1 = makeLog(10, 10, 'INFO checkpoint_30 healthy');
    const log2 = makeLog(14, 80, 'ERROR checkpoint_30 failed with code 503');

    const casi = createCasiIndex();
    casi.ingest(log1, 'run_1', 0);
    const delta = casi.ingest(log2, 'run_2', 1);
    expect(delta.changed).toBe(true);
    expect(delta.kind).toBe('delta');
    expect(delta.text).toContain('-2026-11-23T10:00:30Z INFO checkpoint_30 healthy');
    expect(delta.text).toContain('+2026-11-23T14:00:30Z ERROR checkpoint_30 failed with code 503');
    // Context lines inside hunk preserve run_2's exact timestamp & duration (never <TS>/<DUR>)
    expect(delta.text).toContain(' 2026-11-23T14:00:29Z INFO job_29 completed in 109ms');
    expect(delta.text).not.toContain('<TS>');
    expect(delta.text).not.toContain('<DUR>');
  });

  it('falls back to FastCDC sub-block slice splice on overlapping file windows (read 1..300 -> 200..500)', () => {
    const fullFile = Array.from(
      { length: 500 },
      (_, i) => `export function moduleHandler_${i + 1}(input: string): string { return input + "_${i + 1}"; }`,
    );
    const slice1 = fullFile
      .slice(0, 300)
      .map((line, i) => `${String(i + 1).padStart(4)}→${line}`)
      .join('\n');
    const slice2 = fullFile
      .slice(199, 500)
      .map((line, i) => `${String(i + 200).padStart(4)}→${line}`)
      .join('\n');

    const casi = createCasiIndex();
    expect(casi.ingest(slice1, 'read_1_300', 0).changed).toBe(false);
    const spliced = casi.ingest(slice2, 'read_200_500', 1);
    expect(spliced.changed).toBe(true);
    expect(spliced.kind).toBe('slice');
    expect(spliced.baseRefId).toBe('read_1_300');
    expect(spliced.text).toMatch(
      /\[fiche cas-slice: lines 1\.\.101 identical to read_1_300:200\.\.300 \(101 lines, \d+ chars\) — omitted; file L200\.\.300\]/,
    );
    // Tail lines 301..500 must remain verbatim
    expect(spliced.text).toContain(' 301→export function moduleHandler_301');
    expect(spliced.text).toContain(' 500→export function moduleHandler_500');
    expect(spliced.savedChars).toBeGreaterThan(5000);

    // Chain depth <= 1: re-ingesting the spliced output must not create a depth-2 reference
    const secondIdentical = casi.ingest(slice2, 'read_200_500_again', 2);
    expect(secondIdentical.kind).toBe('slice');
    expect(secondIdentical.baseRefId).toBe('read_1_300');
  });

  it('enforces prefix monotonicity (minBaseTurnGroup) across shifted dup and FastCDC slice', () => {
    const fullFile = Array.from(
      { length: 400 },
      (_, i) => `export const record_${i + 1} = "payload_value_${i + 1}_padding";`,
    );
    const win1 = fullFile.slice(0, 220).map((l, i) => `${String(i + 1).padStart(4)}→${l}`).join('\n');
    const win1Shifted = fullFile.slice(0, 220).map((l, i) => `${String(i + 10).padStart(4)}→${l}`).join('\n');
    const win2 = fullFile.slice(119, 340).map((l, i) => `${String(i + 120).padStart(4)}→${l}`).join('\n');

    // Old entry at turnGroup 1 (< minBaseTurnGroup = 4) must not be referenced by slice or shifted dup
    const casiBlocked = createCasiIndex();
    expect(casiBlocked.ingest(win1, 'old_read', 1, 4).changed).toBe(false);
    const sliceBlocked = casiBlocked.ingest(win2, 'live_read', 5, 4);
    expect(sliceBlocked.changed).toBe(false);
    expect(sliceBlocked.text).toBe(win2);

    const casiShiftBlocked = createCasiIndex();
    expect(casiShiftBlocked.ingest(win1, 'old_read', 1, 4).changed).toBe(false);
    const shiftBlocked = casiShiftBlocked.ingest(win1Shifted, 'live_shift', 5, 4);
    expect(shiftBlocked.changed).toBe(false);
    expect(shiftBlocked.text).toBe(win1Shifted);

    // Re-ingesting win1 at turnGroup 5 (>= 4) is blocked vs turnGroup 1, so win1 indexes at turnGroup 5;
    // then win2 at turnGroup 7 slices cleanly against turnGroup 5 ('fresh_read') — first eligible occurrence wins!
    const casiAllow = createCasiIndex();
    expect(casiAllow.ingest(win1, 'old_read', 1, 4).changed).toBe(false);
    expect(casiAllow.ingest(win1, 'fresh_read', 5, 4).changed).toBe(false);
    const allowed = casiAllow.ingest(win2, 'live_read_2', 7, 4);
    expect(allowed.changed).toBe(true);
    expect(allowed.kind).toBe('slice');
    expect(allowed.baseRefId).toBe('fresh_read');
  });

  it('seeds tool_use.input / functionCall.args read-only across all 4 wire adapters without mutating assistant turns', () => {
    const fileLines = Array.from(
      { length: 60 },
      (_, i) => `export function writtenFn_${i}(x: number): number { return x * ${i + 2}; }`,
    );
    const fileContent = fileLines.join('\n');
    const gutteredRead = fileLines.map((l, i) => `${String(i + 1).padStart(4)}→${l}`).join('\n');
    expect(fileContent.length).toBeGreaterThanOrEqual(400);

    // 1. Anthropic wire
    const anthReq = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_write',
              name: 'write_file',
              input: { file_path: 'src/mod.ts', content: fileContent },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_write', content: 'wrote ok' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_read', name: 'read_file', input: { file_path: 'src/mod.ts' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: gutteredRead }],
        },
      ],
    };
    const anthStats = applyAnthropicTextHygiene(anthReq);
    expect(anthStats.changed).toBe(true);
    expect((anthReq.messages[0]!.content[0] as { input: { content: string } }).input.content).toBe(fileContent);
    const anthReadOut = (anthReq.messages[3]!.content[0] as { content: string }).content;
    expect(anthReadOut).toContain('tu_write:in.content');
    expect(anthReadOut).toContain('[fiche cas');

    // 2. OpenAI Chat wire
    const chatReq = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_write',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ file_path: 'src/mod.ts', content: fileContent }),
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_write', content: 'wrote ok' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_read',
              type: 'function',
              function: { name: 'read_file', arguments: '{"file_path":"src/mod.ts"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_read', content: gutteredRead },
      ],
    };
    const chatStats = applyOpenAIChatTextHygiene(chatReq);
    expect(chatStats.changed).toBe(true);
    expect(chatReq.messages[3]!.content).toContain('call_write:in.content');
    expect(chatReq.messages[3]!.content).toContain('[fiche cas');

    // 3. OpenAI Responses wire
    const respReq = {
      input: [
        {
          type: 'function_call',
          call_id: 'fc_write',
          name: 'write_file',
          arguments: JSON.stringify({ file_path: 'src/mod.ts', content: fileContent }),
        },
        { type: 'function_call_output', call_id: 'fc_write', output: 'wrote ok' },
        {
          type: 'function_call',
          call_id: 'fc_read',
          name: 'read_file',
          arguments: '{"file_path":"src/mod.ts"}',
        },
        { type: 'function_call_output', call_id: 'fc_read', output: gutteredRead },
      ],
    };
    const respStats = applyOpenAIResponsesTextHygiene(respReq);
    expect(respStats.changed).toBe(true);
    expect((respReq.input[3] as { output: string }).output).toContain('fc_write:in.content');
    expect((respReq.input[3] as { output: string }).output).toContain('[fiche cas');

    // 4. Google wire (plus verify causal chronological guard: future functionCall cannot seed earlier functionResponse!)
    const googleReq = {
      contents: [
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'read_file', response: { content: gutteredRead } } }],
        },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'write_file', args: { file_path: 'src/mod.ts', content: fileContent } } }],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'read_file', response: { content: gutteredRead } } }],
        },
      ],
    };
    const gStats = applyGoogleTextHygiene(googleReq);
    expect(gStats.changed).toBe(true);
    // First read_file (cIdx=0) MUST stay verbatim (write_file is in the future cIdx=1)
    expect(
      (googleReq.contents[0]!.parts[0] as { functionResponse: { response: { content: string } } }).functionResponse.response.content,
    ).toBe(gutteredRead);
    // Second read_file (cIdx=2) matches earlier read_file (cIdx=0) or seeded write_file
    expect(
      (googleReq.contents[2]!.parts[0] as { functionResponse: { response: { content: string } } }).functionResponse.response.content,
    ).toContain('[fiche cas');
  });

  it('handles 4000-line CASI v2 ingest and FastCDC chunking within latency budget', () => {
    const lines = Array.from(
      { length: 4000 },
      (_, i) => `${String(i + 1).padStart(5)}→export const sym_${i} = ${i};`,
    );
    const docA = lines.slice(0, 2600).join('\n');
    const docB = lines.slice(1500, 4000).join('\n');

    const casi = createCasiIndex();
    const t0 = performance.now();
    casi.ingest(docA, 'r0', 0);
    const res = casi.ingest(docB, 'r1', 1);
    const dt = performance.now() - t0;

    expect(dt).toBeLessThan(150);
    expect(res.changed).toBe(true);
    expect(res.kind).toBe('slice');
  });

  it('never drops duration/timeout edits in unguttered YAML/config files via canonical matching', () => {
    const buildConfig = (timeoutVal: string, retriesVal: number) =>
      [
        'service:',
        '  name: payment-ledger-worker',
        '  environment: production',
        `  timeout: ${timeoutVal}`,
        '  region: eu-central-1',
        '  circuit_breaker: true',
        '  keepalive: true',
        '  backoff_strategy: exponential',
        '  max_payload_kb: 2048',
        '  worker_pool: default',
        '  queue_name: ledger.events',
        `  retries: ${retriesVal}`,
        '  dead_letter_topic: ledger.dlq',
        '  metrics_port: 9102',
        '  health_path: /healthz',
        '  tls_mode: strict',
        '  description: Production payment verification service configuration with durable persistence, strict validation, and full auditing enabled across every deployment zone',
        '  notes: Maintain strict schema invariants across all regional deployments without mutating timeout thresholds or health endpoints',
        '  observability_endpoint: https://telemetry.internal.example/v1/metrics/payments-ledger-worker',
        '  compliance_profile: pci-dss-level-1-immutable-audit-trail-strict-enforcement',
      ].join('\n');

    const cfg1 = buildConfig('10ms', 2);
    const cfg2 = buildConfig('500ms', 3);
    expect(cfg1.length).toBeGreaterThanOrEqual(400);
    expect(cfg2.length).toBeGreaterThanOrEqual(800);

    const casi = createCasiIndex();
    casi.ingest(cfg1, 'cfg_1', 0);
    const delta = casi.ingest(cfg2, 'cfg_2', 1);
    expect(delta.changed).toBe(true);
    // Must surface BOTH changed fields (timeout: 500ms must NEVER be hidden by <DUR> normalization).
    expect(delta.text).toContain('timeout: 500ms');
    expect(delta.text).toContain('retries: 3');
  });
});
