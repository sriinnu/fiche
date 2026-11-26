import { describe, expect, it } from 'vitest';
import {
  compileSegmentedStaticText,
  compileStaticText,
  compileToolSchemas,
  factorSharedSchemaSubtrees,
  splitVolatileXmlIslands,
} from '../src/core/schema-compiler.js';
import {
  applyAnthropicTextHygiene,
  applyGoogleTextHygiene,
  applyOpenAIChatTextHygiene,
  applyOpenAIResponsesTextHygiene,
  cleanToolOutput,
  unwrapNestedJsonStrings,
} from '../src/core/text-hygiene.js';
import { decodeToon } from '../src/core/toon.js';

describe('P0: splitVolatileXmlIslands & compileSegmentedStaticText', () => {
  it('identifies all 6 volatile XML tags case-insensitively and fails open on unclosed tags', () => {
    const samples = [
      'Static intro\n',
      '<ENV>\nos=darwin\ndate=2026-11-23\n</env>',
      '\nMiddle prose\n',
      '<Context source="cli">\nbranch=main\n</CONTEXT >',
      '\n',
      '<System-Reminder>\nNever fabricate paths.\n</system-reminder>',
      '\n',
      '<fast_mode_info>enabled=false</FAST_MODE_INFO>',
      '\n',
      '<git_status>\nM src/a.ts\n</git_status>',
      '\n',
      '<ADDITIONAL_METADATA>{"k":"v"}</additional_metadata>',
      '\nStatic outro\n',
      '<environment>not-a-volatile-tag</environment>',
    ].join('');

    const islands = splitVolatileXmlIslands(samples);
    expect(islands.map((s) => s.text).join('')).toBe(samples);

    const volatiles = islands.filter((s) => s.volatile).map((s) => s.text);
    expect(volatiles).toHaveLength(6);
    expect(volatiles[0]).toContain('<ENV>');
    expect(volatiles[1]).toContain('<Context source="cli">');
    expect(volatiles[2]).toContain('<System-Reminder>');
    expect(volatiles[3]).toContain('<fast_mode_info>');
    expect(volatiles[4]).toContain('<git_status>');
    expect(volatiles[5]).toContain('<ADDITIONAL_METADATA>');

    const staticJoined = islands
      .filter((s) => !s.volatile)
      .map((s) => s.text)
      .join('');
    expect(staticJoined).toContain('<environment>not-a-volatile-tag</environment>');
    expect(staticJoined).toContain('Static intro');
    expect(staticJoined).toContain('Static outro');

    // Unclosed volatile tag must fail open as volatile to EOF.
    const unclosed = 'Static head\n<system-reminder>\ndynamic tail without closing tag\nmore dynamic';
    const unclosedIslands = splitVolatileXmlIslands(unclosed);
    expect(unclosedIslands).toEqual([
      { volatile: false, text: 'Static head\n' },
      { volatile: true, text: '<system-reminder>\ndynamic tail without closing tag\nmore dynamic' },
    ]);

    // Self-closing tag support
    const selfClosed = 'Head <env/> Tail';
    expect(splitVolatileXmlIslands(selfClosed)).toEqual([
      { volatile: false, text: 'Head ' },
      { volatile: true, text: '<env/>' },
      { volatile: false, text: ' Tail' },
    ]);
  });

  it('stays linear O(N) on pathological repeated unclosed <env tags', () => {
    const pathological = '<env '.repeat(12_000) + 'tail';
    const t0 = performance.now();
    const islands = splitVolatileXmlIslands(pathological);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(50);
    expect(islands.map((s) => s.text).join('')).toBe(pathological);
  });

  it('compiles static islands around volatile XML while keeping volatile XML & code fences byte-identical', () => {
    const sharedPara =
      'Follow strict verification rules across every module in this workspace: read source files before editing, verify exact exported symbols, and report observed test counts honestly.';
    const envBlock = '<env>\n  cwd=/tmp/ws   \n  <!-- keep inside env -->\n  ====================================\n</env>';
    const gitBlock = '<git_status>\n  M src/core/text-hygiene.ts   \n  ?? tests/new.test.ts   \n</git_status>';
    const codeFence = '```ts\nconst   keep_exact   =   true;\n<!-- keep inside fence -->\n```';

    const prompt = [
      'You are Claude Code, Anthropic\'s official CLI for Claude.',
      '<!-- internal build marker to strip cleanly -->\n========================================\n' + sharedPara,
      envBlock,
      codeFence,
      sharedPara,
      gitBlock,
      sharedPara + '   ',
    ].join('\n\n');

    const res = compileSegmentedStaticText(prompt);
    expect(res.changed).toBe(true);
    expect(res.savedChars).toBeGreaterThanOrEqual(150);
    expect(res.savedTokens).toBeGreaterThan(0);
    expect(res.text).toContain(envBlock);
    expect(res.text).toContain(gitBlock);
    expect(res.text).toContain(codeFence);
    expect(res.text).not.toContain('<!-- internal build marker');
    expect(res.text).toContain('[#S1] ' + sharedPara);
    expect(res.text).toContain('See [#S1] above.');
  });

  it('triggers compileSegmentedStaticText at >=150 chars & >=3% while leaving compileStaticText thresholds intact', () => {
    // ~1000 chars total, ~180 chars of HTML comment + divider bloat (~18% saved, < 1200 total chars)
    const comment = '<!-- ' + 'x'.repeat(160) + ' -->';
    const prose = Array.from(
      { length: 12 },
      (_, i) => `Rule ${i}: enforce strict deterministic behavior and zero regressions cleanly.`,
    ).join('\n');
    const mediumPrompt = `${comment}\n========================================\n${prose}`;
    expect(mediumPrompt.length).toBeGreaterThan(300);
    expect(mediumPrompt.length).toBeLessThan(1200);

    expect(compileStaticText(mediumPrompt).changed).toBe(false);
    const segRes = compileSegmentedStaticText(mediumPrompt);
    expect(segRes.changed).toBe(true);
    expect(segRes.savedChars).toBeGreaterThanOrEqual(150);
    expect(segRes.text).not.toContain('<!--');
  });

  it('compiles static system prompts containing <env> / <git_status> across all 4 wire engines', () => {
    const sharedPara =
      'Verify every file path and symbol before reporting results, keep deterministic transforms pure, and avoid O(N^2) regex patterns in hot paths.';
    const envBlock = '<env>\nos=darwin   \n====================================\n</env>';
    const sysPrompt = [
      '<!-- strip comment -->\n====================================\n' + sharedPara,
      envBlock,
      sharedPara,
      sharedPara,
    ].join('\n\n');

    const anthReq = { system: sysPrompt, messages: [{ role: 'user', content: 'hi' }] };
    const anthStats = applyAnthropicTextHygiene(anthReq, { deepTextCompact: true });
    expect(anthStats.changed).toBe(true);
    expect(anthStats.stages).toContain('tscg');
    expect(anthReq.system).toContain(envBlock);
    expect(anthReq.system).toContain('See [#S1] above.');

    const chatReq = {
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: 'hi' },
      ],
    };
    const chatStats = applyOpenAIChatTextHygiene(chatReq, { deepTextCompact: true });
    expect(chatStats.changed).toBe(true);
    expect(chatReq.messages[0]!.content).toContain(envBlock);
    expect(chatReq.messages[0]!.content).toContain('See [#S1] above.');

    const respReq = {
      instructions: sysPrompt,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    };
    const respStats = applyOpenAIResponsesTextHygiene(respReq, { deepTextCompact: true });
    expect(respStats.changed).toBe(true);
    expect(respReq.instructions).toContain(envBlock);
    expect(respReq.instructions).toContain('See [#S1] above.');

    const googleReq = {
      systemInstruction: { parts: [{ text: sysPrompt }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    };
    const googleStats = applyGoogleTextHygiene(googleReq, { deepTextCompact: true });
    expect(googleStats.changed).toBe(true);
    expect(googleReq.systemInstruction.parts[0]!.text).toContain(envBlock);
    expect(googleReq.systemInstruction.parts[0]!.text).toContain('See [#S1] above.');
  });
});

describe('P0: compileToolSchemas Merkle factoring & 96-char paragraph dedup', () => {
  it('deduplicates shared description paragraphs down to minParaChars=96', () => {
    // 104 chars (>= 96 and < 120)
    const para104 =
      'Validate target file path strictly inside workspace root without traversing outside permitted directories.';
    expect(para104.length).toBeGreaterThanOrEqual(96);
    expect(para104.length).toBeLessThan(120);

    const tools = Array.from({ length: 4 }, (_, i) => ({
      name: `fs_op_${i}`,
      description: `${para104}\n\nRuns operation ${i}.`,
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: para104 },
        },
      },
    }));

    const res = compileToolSchemas(tools, 'anthropic');
    expect(res.changed).toBe(true);
    expect(tools[0]!.description).toContain('[#T1] ' + para104);
    expect(tools[1]!.description).toContain('See [#T1] above.');
    expect((tools[0]!.input_schema.properties.path as { description: string }).description).toBe(
      'See [#T1] above.',
    );
  });

  it('hoists repeated schema subtrees bottom-up to $defs._fN on non-Google wires and skips Google', () => {
    const bigLeaf = {
      type: 'object',
      required: ['street', 'city', 'postalCode', 'countryCode'],
      additionalProperties: false,
      properties: {
        street: { type: 'string', minLength: 1, maxLength: 120, description: 'Street address line 1' },
        city: { type: 'string', minLength: 1, maxLength: 80, description: 'Municipality or city name' },
        postalCode: { type: 'string', pattern: '^[A-Z0-9-]{3,12}$', description: 'Postal routing code' },
        countryCode: { type: 'string', enum: ['US', 'CA', 'GB', 'DE', 'FR', 'JP', 'IN'] },
      },
    };
    expect(JSON.stringify(bigLeaf).length).toBeGreaterThanOrEqual(220);

    const makeAnthTools = () => [
      {
        name: 'create_order',
        description: 'Creates an order.',
        input_schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          $defs: {
            _f1: { type: 'string', description: 'Pre-existing _f1 collision test' },
            Currency: { type: 'string', enum: ['USD', 'EUR'] },
          },
          properties: {
            billingAddress: structuredClone(bigLeaf),
            shippingAddress: structuredClone(bigLeaf),
            returnAddress: structuredClone(bigLeaf),
          },
        },
      },
    ];

    const anthTools = makeAnthTools();
    const anthRes = compileToolSchemas(anthTools, 'anthropic');
    expect(anthRes.changed).toBe(true);
    expect(anthRes.savedChars).toBeGreaterThanOrEqual(200);
    const anthSchema = anthTools[0]!.input_schema as Record<string, unknown>;
    const defs = anthSchema.$defs as Record<string, unknown>;
    // Existing _f1 and Currency must stay intact; hoisted subtree takes _f2
    expect(defs._f1).toEqual({ type: 'string', description: 'Pre-existing _f1 collision test' });
    expect(defs.Currency).toEqual({ type: 'string', enum: ['USD', 'EUR'] });
    expect(defs._f2).toEqual(bigLeaf);
    const props = anthSchema.properties as Record<string, unknown>;
    expect(props.billingAddress).toEqual({ $ref: '#/$defs/_f2' });
    expect(props.shippingAddress).toEqual({ $ref: '#/$defs/_f2' });
    expect(props.returnAddress).toEqual({ $ref: '#/$defs/_f2' });

    // OpenAI Chat & OpenAI Responses also factor cleanly
    const chatTools = [
      {
        type: 'function',
        function: {
          name: 'create_order',
          description: 'Creates an order.',
          parameters: {
            type: 'object',
            properties: {
              a: structuredClone(bigLeaf),
              b: structuredClone(bigLeaf),
              c: structuredClone(bigLeaf),
            },
          },
        },
      },
    ];
    expect(compileToolSchemas(chatTools, 'openai_chat').changed).toBe(true);
    expect((chatTools[0]!.function.parameters as Record<string, unknown>).$defs).toBeDefined();

    const respTools = [
      {
        type: 'function',
        name: 'create_order',
        description: 'Creates an order.',
        parameters: {
          type: 'object',
          properties: {
            a: structuredClone(bigLeaf),
            b: structuredClone(bigLeaf),
            c: structuredClone(bigLeaf),
          },
        },
      },
    ];
    expect(compileToolSchemas(respTools, 'openai_responses').changed).toBe(true);
    expect((respTools[0]!.parameters as Record<string, unknown>).$defs).toBeDefined();

    // Google wire MUST NEVER emit $defs or $ref!
    const googleTools = [
      {
        functionDeclarations: [
          {
            name: 'create_order',
            description: 'Creates an order.',
            parameters: {
              type: 'OBJECT',
              properties: {
                a: structuredClone(bigLeaf),
                b: structuredClone(bigLeaf),
                c: structuredClone(bigLeaf),
              },
            },
          },
        ],
      },
    ];
    const googleRes = compileToolSchemas(googleTools, 'google');
    expect(googleRes.changed).toBe(false);
    expect(JSON.stringify(googleTools)).not.toContain('$defs');
    expect(JSON.stringify(googleTools)).not.toContain('$ref');
  });

  it('factors nested Merkle subtrees bottom-up without hoisting properties maps or <120-char wins', () => {
    const innerLeaf = {
      type: 'object',
      additionalProperties: false,
      required: ['host', 'port', 'tls', 'timeoutMs'],
      properties: {
        host: { type: 'string', format: 'hostname', description: 'Upstream server hostname' },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        tls: { type: 'boolean', description: 'Require TLS encryption' },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
      },
    };
    const outerWrapper = {
      type: 'object',
      required: ['endpoint', 'retries', 'backoffStrategy'],
      properties: {
        endpoint: structuredClone(innerLeaf),
        retries: { type: 'integer', minimum: 0, maximum: 10, description: 'Max retry count before abort' },
        backoffStrategy: { type: 'string', enum: ['linear', 'exponential', 'decorrelated_jitter'] },
      },
    };
    const candidate = [
      {
        name: 'deploy_mesh',
        input_schema: {
          type: 'object',
          properties: {
            primary: structuredClone(outerWrapper),
            secondary: structuredClone(outerWrapper),
            fallbackEndpoint: structuredClone(innerLeaf),
          },
        },
      },
    ];

    const changed = factorSharedSchemaSubtrees(candidate);
    expect(changed).toBe(true);
    const schema = candidate[0]!.input_schema as Record<string, unknown>;
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    const props = schema.properties as Record<string, unknown>;
    // Bottom-up: innerLeaf (3 occurrences) hoisted to _f1; outerWrapper (2 occurrences, >=220 chars even with $ref) hoisted to _f2
    expect(defs._f1).toEqual(innerLeaf);
    expect(defs._f2).toBeDefined();
    expect((defs._f2!.properties as Record<string, unknown>).endpoint).toEqual({ $ref: '#/$defs/_f1' });
    expect(props.primary).toEqual({ $ref: '#/$defs/_f2' });
    expect(props.secondary).toEqual({ $ref: '#/$defs/_f2' });
    expect(props.fallbackEndpoint).toEqual({ $ref: '#/$defs/_f1' });
  });
});

describe('P0: unwrapNestedJsonStrings & cleanUserPayloads', () => {
  it('unwraps nested JSON string fields into lossless @toon or clean minified JSON', () => {
    const innerRows = Array.from({ length: 24 }, (_, i) => ({
      id: i,
      service: `worker-${i % 3}`,
      region: 'us-central1',
      status: 'healthy',
    }));
    const wrappedTabular = JSON.stringify({
      ok: true,
      output: JSON.stringify(innerRows, null, 2),
    });

    const resToon = unwrapNestedJsonStrings(wrappedTabular);
    expect(resToon).not.toBeNull();
    expect(resToon!.stage).toBe('toon');
    expect(decodeToon(resToon!.text)).toEqual({ ok: true, output: innerRows });

    const cleanRes = cleanToolOutput(wrappedTabular);
    expect(cleanRes.changed).toBe(true);
    expect(cleanRes.stages).toContain('toon');
    expect(decodeToon(cleanRes.text)).toEqual({ ok: true, output: innerRows });

    // Non-tabular nested JSON unwraps cleanly to minified JSON when >=15% & >=40 tokens drop
    const deepNonTabular = {
      config: {
        alpha: { nested: { x: Array.from({ length: 12 }, (_, i) => [`key_${i}`, i * 2]) } },
        beta: { rules: ['strict', 'pure', 'deterministic', 'prefix-safe'] },
      },
      flags: ['a', 'b', 'c', 'd', 'e', 'f'],
    };
    const wrappedNonTabular = JSON.stringify({
      status: 200,
      result: JSON.stringify(deepNonTabular, null, 2),
    });
    const resJson = unwrapNestedJsonStrings(wrappedNonTabular);
    expect(resJson).not.toBeNull();
    expect(resJson!.stage).toBe('json_unwrap');
    expect(resJson!.text).toContain('@fiche-kv');
    expect(resJson!.text).toContain('status: 200');
    expect(resJson!.text).toContain('--- result (json-string) ---');
    expect(resJson!.text).toContain(JSON.stringify(deepNonTabular));
  });

  it('unwraps small JSON envelopes with heavily escaped multi-line strings into @fiche-kv and folds logs', () => {
    const logLines = [
      '2026-11-23T10:00:00Z INFO starting test suite',
      ...Array.from(
        { length: 45 },
        (_, i) =>
          `\x1b[32m2026-11-23T10:01:${String(i % 60).padStart(2, '0')}Z\x1b[0m INFO worker=10.0.0.1:8080 "task ${i}" completed in ${10 + i}ms`,
      ),
      '2026-11-23T10:02:00Z ERROR AssertionError: mismatch at src/core/app.ts:88',
    ].join('\n');

    const envelope = JSON.stringify({
      exitCode: 1,
      command: 'pnpm test',
      stdout: logLines,
      stderr: 'line1 "warn"\nline2 "warn"\nline3 "warn"\nline4 "warn"\n',
    });

    const unwrapped = unwrapNestedJsonStrings(envelope);
    expect(unwrapped).not.toBeNull();
    expect(unwrapped!.stage).toBe('json_unwrap');
    expect(unwrapped!.text).toContain('@fiche-kv');
    expect(unwrapped!.text).toContain('exitCode: 1');
    expect(unwrapped!.text).toContain('--- stdout ---');
    expect(unwrapped!.text).toContain('ERROR AssertionError: mismatch at src/core/app.ts:88');
    expect(unwrapped!.text).toMatch(/\[\.\.\. \d+ similar lines folded \.\.\.\]/);
    expect(unwrapped!.text).not.toContain('\x1b[32m');

    // Never unwraps read_file outputs via cleanToolOutput
    const protectedRead = cleanToolOutput(envelope, { toolName: 'read_file' });
    expect(protectedRead.changed).toBe(false);
    expect(protectedRead.text).toBe(envelope);
  });

  it('gates bulky user payload cleaning behind cleanUserPayloads:true while protecting code & XML islands', () => {
    const tabular = JSON.stringify(
      { rows: Array.from({ length: 40 }, (_, i) => ({ id: i, host: `node-${i % 4}`, ok: true })) },
      null,
      2,
    );
    expect(tabular.length).toBeGreaterThanOrEqual(1500);

    const reminder = '<system-reminder>\nKeep this reminder   exact   and   unmodified.\n</system-reminder>';
    const userWithXml = `${reminder}\n${tabular}`;

    const makeChat = () => ({
      messages: [
        { role: 'user', content: userWithXml },
        {
          role: 'user',
          content: Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(4)}→  const x${i} = ${i};`).join('\n'),
        },
        { role: 'user', content: JSON.stringify({ small: Array.from({ length: 10 }, (_, i) => ({ i, v: 'x' })) }, null, 2) },
      ],
    });

    // Default (cleanUserPayloads omitted / false): untouched
    const defaultReq = makeChat();
    const defaultStats = applyOpenAIChatTextHygiene(defaultReq);
    expect(defaultStats.changed).toBe(false);
    expect(defaultReq.messages[0]!.content).toBe(userWithXml);

    // Explicit cleanUserPayloads: true
    const optInReq = makeChat();
    const optInStats = applyOpenAIChatTextHygiene(optInReq, { cleanUserPayloads: true });
    expect(optInStats.changed).toBe(true);
    expect(optInReq.messages[0]!.content).toContain(reminder);
    expect(optInReq.messages[0]!.content).toContain('@toon');
    expect(optInReq.messages[0]!.content.length).toBeLessThan(userWithXml.length);
    // Code-protected user block & <1500 char user block stay verbatim
    expect(optInReq.messages[1]!.content).toBe(defaultReq.messages[1]!.content);
    expect(optInReq.messages[2]!.content).toBe(defaultReq.messages[2]!.content);

    // Anthropic, Responses, Google wires also obey cleanUserPayloads: true
    const anthReq = {
      messages: [{ role: 'user', content: [{ type: 'text', text: userWithXml }] }],
    };
    expect(applyAnthropicTextHygiene(anthReq, { cleanUserPayloads: true }).changed).toBe(true);
    expect((anthReq.messages[0]!.content[0] as { text: string }).text).toContain(reminder);
    expect((anthReq.messages[0]!.content[0] as { text: string }).text).toContain('@toon');

    const respReq = {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: userWithXml }] }],
    };
    expect(applyOpenAIResponsesTextHygiene(respReq, { cleanUserPayloads: true }).changed).toBe(true);
    expect((respReq.input[0]!.content[0] as { text: string }).text).toContain(reminder);
    expect((respReq.input[0]!.content[0] as { text: string }).text).toContain('@toon');

    const googleReq = {
      contents: [{ role: 'user', parts: [{ text: userWithXml }] }],
    };
    expect(applyGoogleTextHygiene(googleReq, { cleanUserPayloads: true }).changed).toBe(true);
    expect(googleReq.contents[0]!.parts[0]!.text).toContain(reminder);
    expect(googleReq.contents[0]!.parts[0]!.text).toContain('@toon');
  });
});
