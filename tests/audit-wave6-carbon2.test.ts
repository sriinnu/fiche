import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';

import {
  cleanToolOutput,
  isFileReadToolName,
  applyAnthropicTextHygiene,
  applyOpenAIChatTextHygiene,
  applyOpenAIResponsesTextHygiene,
  applyGoogleTextHygiene,
} from '../src/core/text-hygiene.js';
import {
  collapseHistory,
  type Message,
} from '../src/core/history.js';
import {
  relocateOpenAIPins,
  relocateGooglePins,
} from '../src/core/pin.js';
import {
  FACTSHEET_PAGE_CHARS,
  prepareFactSheet,
  extractFactSheetEntries,
} from '../src/core/factsheet.js';
import { CertificateAuthority } from '../src/warp/ca.js';
import { matchRoute, parseRoute } from '../src/warp/route.js';
import { createWarpHandlers } from '../src/warp/connect.js';
import { buildWarpAppArgs, renderShellInitScript } from '../src/warp/app-launch.js';
import {
  anthropicMessagesToOpenAIResponses,
  openAIResponseToAnthropicMessage,
  openAIResponsesStreamToAnthropic,
  openAIResponsesToAnthropicResponse,
} from '../src/core/messages-responses-bridge.js';
import {
  openAIChatToAnthropicMessage,
  openAIChatStreamToAnthropic,
  openAIChatToAnthropicResponse,
} from '../src/core/messages-chat-bridge.js';
import { createProxy } from '../src/core/proxy.js';
import {
  parseSkillManifest,
  stageTogglesFromOverrides,
} from '../src/core/stage-plugins.js';
import { transformRequest } from '../src/core/transform.js';
import { setAllowedModelBases } from '../src/core/applicability.js';
import { FileTracker } from '../src/file-tracker.js';
import { prune, type SessionsPaths } from '../src/sessions.js';
import type { TrackEvent } from '../src/core/tracker.js';
import { DashboardState } from '../src/dashboard.js';
import { renderRecentFragment } from '../src/dashboard/fragments.js';
import type { StatsPayload } from '../src/dashboard/types.js';

const tmpDirs: string[] = [];
function makeTmpDir(prefix = 'fiche-wave6-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  setAllowedModelBases(null);
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
});

// ---------------------------------------------------------------------------
// Step 1: editSafe file-read & JSON protection across all 4 wire adapters + CODE_DECL_LINE_RE
// ---------------------------------------------------------------------------
describe('Wave 2 Step 1 — editSafe file-read & CODE_DECL_LINE_RE protection', () => {
  const rawJsonFile = JSON.stringify(
    Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      name: `service_${i + 1}`,
      enabled: true,
      timeoutMs: 3000 + i,
    })),
    null,
    2,
  );
  const rawCodeFile = [
    'package main',
    '',
    'func (s *Server) HandleHealth(w http.ResponseWriter, r *http.Request) {',
    '    w.WriteHeader(200)',
    '}',
    '',
    'public static void main(String[] args) {',
    '    System.out.println("ok");',
    '}',
    '',
    'public async Task<int> FetchCountAsync() => 42;',
    '',
    '    indentedTrailing   ',
    '\n\n\n\n',
  ].join('\n');

  it('recognizes common file-read tool names accurately', () => {
    for (const name of ['Read', 'read_file', 'view_file', 'view_file_outline', 'get_file_contents', 'cat', 'mcp__fs__read_file']) {
      expect(isFileReadToolName(name)).toBe(true);
    }
    expect(isFileReadToolName('bash')).toBe(false);
    expect(isFileReadToolName('search_files')).toBe(false);
  });

  it('preserves file-read JSON & code verbatim across all 4 wire adapters while compacting non-file JSON', () => {
    // 1. Anthropic wire
    const antRead = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: rawJsonFile }] },
      ],
    };
    applyAnthropicTextHygiene(antRead, { mode: 'on' });
    expect((antRead.messages[1]!.content[0] as { content: string }).content).toBe(rawJsonFile);

    const antBash = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_bash', name: 'bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: rawJsonFile }] },
      ],
    };
    applyAnthropicTextHygiene(antBash, { mode: 'on', enableToon: true });
    expect((antBash.messages[1]!.content[0] as { content: string }).content).not.toBe(rawJsonFile);
    expect((antBash.messages[1]!.content[0] as { content: string }).content.length).toBeLessThan(rawJsonFile.length);

    // 2. OpenAI Chat wire
    const chatRead = {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: rawJsonFile },
      ],
    };
    applyOpenAIChatTextHygiene(chatRead, { mode: 'on' });
    expect(chatRead.messages[1]!.content).toBe(rawJsonFile);

    // 3. OpenAI Responses wire
    const respRead = {
      input: [
        { type: 'function_call', call_id: 'fc1', name: 'view_file', arguments: '{}' },
        { type: 'function_call_output', call_id: 'fc1', output: rawJsonFile },
      ],
    };
    applyOpenAIResponsesTextHygiene(respRead, { mode: 'on' });
    expect((respRead.input[1] as { output: string }).output).toBe(rawJsonFile);

    // 4. Google wire
    const googleRead = {
      contents: [
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'get_file_contents', response: { content: rawJsonFile } } },
          ],
        },
      ],
    };
    applyGoogleTextHygiene(googleRead, { mode: 'on' });
    expect(
      (googleRead.contents[0]!.parts[0] as { functionResponse: { response: { content: string } } }).functionResponse.response.content,
    ).toBe(rawJsonFile);
  });

  it('protects Go/Java/C# declarations and stays ReDoS-safe on 10k pathological lines', () => {
    const out = cleanToolOutput(rawCodeFile, { mode: 'on', toolName: 'grep' });
    expect(out.text).toContain('func (s *Server) HandleHealth');
    expect(out.text).toContain('public static void main');
    expect(out.text).toContain('public async Task<int> FetchCountAsync');

    const pathological = `${'public static final async override '.repeat(300)}(${'a '.repeat(400)}`;
    const t0 = performance.now();
    cleanToolOutput(pathological, { mode: 'on' });
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Step 2: userTurnBlocks reflow + post-render hard imageBudget guard
// ---------------------------------------------------------------------------
describe('Wave 2 Step 2 — userTurnBlocks reflow & post-render hard imageBudget guard', () => {
  it('collapses over-cap user prompt via reflowed userTurnBlocks and stays within imageBudget', async () => {
    const longPrompt = Array.from(
      { length: 120 },
      (_, i) => `Requirement line ${i}: keep identifiers exact and preserve ordering carefully.`,
    ).join('\n');
    const msgs: Message[] = [
      { role: 'user', content: longPrompt },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? 'assistant' : 'user') as 'user' | 'assistant',
        content: `Followup step ${i}: ` + `alpha beta gamma delta `.repeat(20),
      })),
    ];

    const out = await collapseHistory(msgs, () => true, {
      cols: 100,
      keepTail: 2,
      minCollapsePrefix: 4,
      freezeChunk: 4,
      imageBudget: 8,
    });
    expect(out.info.collapsedImages).toBeLessThanOrEqual(8);
    expect(out.info.collapsedTurns).toBeGreaterThan(0);
    // Over-cap user prompt (>2000 chars) triggered userTurnBlocks rendering
    const synthetic = out.messages[0]?.content;
    expect(Array.isArray(synthetic)).toBe(true);
    const hasImage = Array.isArray(synthetic) && synthetic.some((b) => (b as { type?: string }).type === 'image');
    expect(hasImage).toBe(true);
  });

  it('enforces hard imageBudget after parallel chunk rendering without exceeding budget', async () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 24; i++) {
      msgs.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Turn ${i}: ` + `alpha beta gamma delta `.repeat(260),
      });
    }
    const tight = await collapseHistory(msgs, () => true, {
      cols: 80,
      keepTail: 2,
      minCollapsePrefix: 4,
      freezeChunk: 2,
      imageBudget: 2,
    });
    expect(tight.info.collapsedImages).toBeLessThanOrEqual(2);
    if (tight.info.collapsedTurns === 0) {
      expect(tight.info.reason).toBe('over_budget');
    } else {
      expect(tight.info.collapsedImages).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 3: OpenAI & Google pin relocation pair-splicing & empty-part pruning
// ---------------------------------------------------------------------------
describe('Wave 2 Step 3 — OpenAI & Google pin relocation', () => {
  it('relocateOpenAIPins splices command+reply pairs, strips system-reminder file pins, and preserves tool items', () => {
    const req: Parameters<typeof relocateOpenAIPins>[0] = {
      instructions: '@fiche pin from-instructions',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder>keep-before\n@fiche pin from-file\nkeep-after</system-reminder>' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '@fiche pin always test edge cases' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '@fiche pinned:\n- always test edge cases' }] },
        { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue with the patch.' }] },
      ],
    };

    const moved = relocateOpenAIPins(req);
    expect(moved).toBeGreaterThan(0);
    expect(req.instructions).toBeUndefined();
    const items = req.input as Array<Record<string, unknown>>;
    expect(JSON.stringify(items)).not.toContain('pinned:\n- always test');
    expect(items.some((it) => it.type === 'function_call' && it.call_id === 'call_1')).toBe(true);
    expect(items.some((it) => it.type === 'function_call_output' && it.call_id === 'call_1')).toBe(true);
    const tailText = JSON.stringify(items[items.length - 1]);
    expect(tailText).toContain('always test edge cases');
    expect(tailText).toContain('from-instructions');
    expect(tailText).toContain('from-file');
  });

  it('relocateGooglePins splices pairs, prunes emptied systemInstruction, and preserves functionCall/thought parts', () => {
    const req: Parameters<typeof relocateGooglePins>[0] = {
      systemInstruction: { parts: [{ text: '@fiche pin concise diffs' }] },
      contents: [
        { role: 'user', parts: [{ text: '@fiche pin verify migrations' }] },
        { role: 'model', parts: [{ text: '@fiche pinned:\n- verify migrations' }] },
        { role: 'model', parts: [{ text: 'internal thought', thought: true }, { functionCall: { name: 'Read', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'Read', response: { content: 'ok' } } }, { text: 'Proceed.' }] },
      ],
    };

    const moved = relocateGooglePins(req);
    expect(moved).toBeGreaterThan(0);
    expect(req.systemInstruction).toBeUndefined();
    const joined = JSON.stringify(req.contents);
    expect(joined).toContain('functionCall');
    expect(joined).toContain('functionResponse');
    expect(joined).toContain('internal thought');
    expect(joined).not.toContain('@fiche pinned:');
    const lastContent = req.contents![req.contents!.length - 1]!;
    expect(JSON.stringify(lastContent)).toContain('verify migrations');
    expect(JSON.stringify(lastContent)).toContain('concise diffs');
  });
});

// ---------------------------------------------------------------------------
// Step 4: FactSheet 28 KB paging + MAX_SEEN repeat tally + non-retaining closure
// ---------------------------------------------------------------------------
describe('Wave 2 Step 4 — FactSheet paging & MAX_SEEN repeat accounting', () => {
  it('pages beyond 28 KB FACTSHEET_PAGE_CHARS and increments repeat counts past MAX_SEEN', () => {
    const paddingTokens = Array.from({ length: 20 }, (_, i) => `/tmp/unique_path_${i}/file_${i}.ts`).join('\n');
    const longDoc = [
      '/src/early_anchor_file.ts',
      paddingTokens,
      'x '.repeat(Math.ceil((FACTSHEET_PAGE_CHARS + 2000) / 2)),
      '/src/late_page_file.ts /src/late_page_file.ts',
      '/src/early_anchor_file.ts',
    ].join('\n');

    const fn = prepareFactSheet(longDoc, 'full');
    const covered = new Set<string>(['/src/late_page_file.ts']);
    const rendered = fn(covered);
    // Repeated token stays emitted even when covered in live tail because entry.count >= 2
    expect(rendered).toContain('/src/late_page_file.ts');
    expect(rendered).toContain('/src/early_anchor_file.ts');

    const repeatedPastCap = [
      'RepeatedTokenAlpha',
      ...Array.from({ length: 1100 }, (_, i) => `DistinctSym_${i}_zz`),
      'RepeatedTokenAlpha',
    ].join(' ');
    const entries = extractFactSheetEntries(repeatedPastCap);
    const alpha = entries.find((e) => e.token === 'RepeatedTokenAlpha');
    expect(alpha?.count).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Step 5: Warp CA SKI/AKI, IPv4-mapped IPv6 SAN, >64 host, dot-segment routes, no-SNI TLS, app args
// ---------------------------------------------------------------------------
describe('Wave 2 Step 5 — Warp CA, route normalization, no-SNI TLS & app args', () => {
  it('generates RFC 5280 SKI/AKI certificates accepted by strict openssl verify and handles IPv6/long host SANs', () => {
    const dir = makeTmpDir('fiche-ca-');
    const ca = CertificateAuthority.loadOrCreate(dir);
    expect(ca.spkiPins).toHaveLength(2);

    const leafPath = path.join(dir, 'leaf.pem');
    const leafPem = ca.mintLeafCertPem('api.anthropic.com');
    fs.writeFileSync(leafPath, leafPem, 'utf8');
    const verifyOut = execFileSync(
      'openssl',
      ['verify', '-x509_strict', '-CAfile', ca.certPath, leafPath],
      { encoding: 'utf8' },
    );
    expect(verifyOut).toContain('OK');

    const longHost = `${'sub.'.repeat(18)}example.com`;
    expect(longHost.length).toBeGreaterThan(64);
    const longLeaf = new X509Certificate(ca.mintLeafCertPem(longHost));
    expect(longLeaf.subject).toBe('');
    expect(longLeaf.subjectAltName).toContain(`DNS:${longHost}`);

    const mappedLeaf = new X509Certificate(ca.mintLeafCertPem('::ffff:127.0.0.1'));
    expect(mappedLeaf.subjectAltName).toMatch(/IP Address:(?:.*7F00:1|.*127\.0\.0\.1)/i);
  });

  it('rejects dot-segment traversal in matchRoute', () => {
    const routes = [parseRoute('api.example.com/v1/*=http://127.0.0.1:47821')];
    expect(matchRoute(routes, 'api.example.com', '/v1/messages')).not.toBeNull();
    expect(matchRoute(routes, 'api.example.com', '/v1/../../admin/secret')).toBeNull();
  });

  it('completes real CONNECT TLS handshake without SNI for an IP literal target', async () => {
    const dir = makeTmpDir('fiche-connect-');
    const ca = CertificateAuthority.loadOrCreate(dir);

    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const upPort = (upstream.address() as { port: number }).port;

    const handlers = createWarpHandlers({
      routes: [parseRoute(`127.0.0.1:${upPort}/v1/*=http://127.0.0.1:${upPort}`)],
      ca,
    });
    const proxyServer = http.createServer();
    proxyServer.on('connect', handlers.handleConnect);
    await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', () => r()));
    const proxyPort = (proxyServer.address() as { port: number }).port;

    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          method: 'CONNECT',
          path: `127.0.0.1:${upPort}`,
        });
        req.on('connect', (res, socket) => {
          expect(res.statusCode).toBe(200);
          // Connect over TLS WITHOUT setting `servername` (no SNI — simulates raw IP literal client)
          const tlsSock = tls.connect({
            socket,
            ca: [fs.readFileSync(ca.certPath, 'utf8')],
            checkServerIdentity: () => undefined,
          });
          tlsSock.on('error', reject);
          tlsSock.on('secureConnect', () => {
            tlsSock.write(
              `GET /v1/../v1/ping HTTP/1.1\r\nHost: 127.0.0.1:${upPort}\r\nConnection: close\r\n\r\n`,
            );
          });
          const chunks: Buffer[] = [];
          tlsSock.on('data', (c) => chunks.push(c));
          tlsSock.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const [head, body = ''] = raw.split('\r\n\r\n');
            const status = Number(/HTTP\/1\.\d (\d+)/.exec(head ?? '')?.[1] ?? 0);
            resolve({ status, body });
          });
        });
        req.on('error', reject);
        req.end();
      });
      expect(result.status).toBe(200);
      expect(result.body).toContain('/v1/ping');
    } finally {
      proxyServer.close();
      upstream.close();
    }
  });

  it('preserves 3-arg buildWarpAppArgs compat, adds SPKI/bypass opts, wraps aider, and passes extra flags in fiche-app()', () => {
    const fakeBundle = {
      appName: 'Cursor',
      appPath: '/Applications/Cursor.app',
      executablePath: '/Applications/Cursor.app/Contents/MacOS/Cursor',
      isElectron: true,
    };
    const baseArgs = buildWarpAppArgs(fakeBundle, 'http://127.0.0.1:47821', ['--new-window']);
    expect(baseArgs).toEqual([
      '/Applications/Cursor.app/Contents/MacOS/Cursor',
      '--proxy-server=http://127.0.0.1:47821',
      '--new-window',
    ]);

    const hardenedArgs = buildWarpAppArgs(fakeBundle, 'http://127.0.0.1:47821', ['--new-window'], {
      spkiPins: ['pinA', 'pinB'],
      proxyBypassList: 'localhost;127.0.0.1;[::1]',
    });
    expect(hardenedArgs).toContain('--ignore-certificate-errors-spki-list=pinA,pinB');
    expect(hardenedArgs).toContain('--proxy-bypass-list=localhost;127.0.0.1;[::1]');

    const initScript = renderShellInitScript({ wrap: true });
    expect(initScript).toContain('aider()');
    expect(initScript).toContain('warp --app "$app" -- "$@"');
  });
});

// ---------------------------------------------------------------------------
// Step 6: Messages <-> Responses/Chat bridges & proxy 400 on bridged invalid request
// ---------------------------------------------------------------------------
describe('Wave 2 Step 6 — Messages bridges & fail-open proxy error typing', () => {
  it('handles thinking skip/effort mapping, eventless/headerless SSE, truncated tool JSON, and 4 MiB cap', async () => {
    const reqHigh = JSON.parse(
      new TextDecoder().decode(
        anthropicMessagesToOpenAIResponses(
          new TextEncoder().encode(
            JSON.stringify({
              model: 'gpt-6.2-astra',
              thinking: { type: 'enabled', budget_tokens: 32000 },
              messages: [
                {
                  role: 'assistant',
                  content: [
                    { type: 'thinking', thinking: 'secret scratchpad' },
                    { type: 'redacted_thinking', data: 'abc' },
                    { type: 'text', text: 'Working...' },
                  ],
                },
                { role: 'user', content: 'Continue' },
              ],
            }),
          ),
        ),
      ),
    ) as { reasoning?: { effort?: string }; input: unknown[] };
    expect(reqHigh.reasoning?.effort).toBe('high');
    expect(JSON.stringify(reqHigh.input)).not.toContain('secret scratchpad');
    expect(JSON.stringify(reqHigh.input)).not.toContain('redacted_thinking');

    // Responses incomplete truncated JSON recovery
    const incompleteResp = openAIResponseToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'gpt-6.2-astra',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'function_call', call_id: 'call_t', name: 'Write', arguments: '{"path":"a.ts","content":"cut...' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      'gpt-6.2-astra',
    );
    expect((incompleteResp.content as Array<{ input: { _raw?: string } }>)[0]!.input._raw).toContain('cut...');

    // Responses eventless + headerless SSE sniffing
    const eventlessStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"response.created","response":{"id":"r1","model":"gpt-6.2-astra"}}\n\n' +
          'data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
          'data: {"type":"response.completed","response":{"id":"r1","model":"gpt-6.2-astra","status":"completed","usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
        ));
        controller.close();
      },
    });
    const headerlessRes = await openAIResponsesToAnthropicResponse(
      new Response(eventlessStream, { status: 200, headers: { 'content-type': 'text/plain' } }),
      'gpt-6.2-astra',
    );
    expect(headerlessRes.headers.get('content-type')).toContain('text/event-stream');
    const sseText = await headerlessRes.text();
    expect(sseText).toContain('event: message_start');
    expect(sseText).toContain('hello');

    // Chat truncated tool JSON + headerless SSE + 4 MiB guard
    const chatTrunc = openAIChatToAnthropicMessage(
      {
        id: 'chat_1',
        model: 'gpt-6.2-astra',
        choices: [{
          finish_reason: 'length',
          message: {
            role: 'assistant',
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Edit', arguments: '{"bad":true,' } }],
          },
        }],
      },
      'gpt-6.2-astra',
    );
    expect((chatTrunc.content as Array<{ input: { _raw?: string } }>)[0]!.input._raw).toBe('{"bad":true,');

    const hugeSse = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(4 * 1024 * 1024 + 50)}`));
        controller.close();
      },
    });
    const cappedText = await new Response(openAIResponsesStreamToAnthropic(hugeSse, 'm')).text();
    expect(cappedText).toContain('exceeded maximum size');
    const cappedChatText = await new Response(openAIChatStreamToAnthropic(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${'y'.repeat(4 * 1024 * 1024 + 50)}`));
          c.close();
        },
      }),
      'm',
    )).text();
    expect(cappedChatText).toContain('exceeded maximum size');

    const chatSniff = await openAIChatToAnthropicResponse(
      new Response('data: {"id":"c1","choices":[{"delta":{"content":"hi"}}]}\n\n', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
      'gpt-6.2-astra',
    );
    expect(chatSniff.headers.get('content-type')).toContain('text/event-stream');
  });

  it('returns typed HTTP 400 invalid_request_error on invalid bridged Messages request without contacting real APIs', async () => {
    const handler = createProxy({
      upstream: 'http://127.0.0.1:9',
      openAIUpstream: 'http://127.0.0.1:9',
      openAIApiKey: ['sk', 'openai', 'test', '0000'].join('-'),
      openAIModels: ['gpt-6.2-astra'],
    });
    const invalidBridged = JSON.stringify({ model: 'gpt-6.2-astra', messages: 'not-an-array' });
    const res = await handler(
      new Request('http://127.0.0.1:47821/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: invalidBridged,
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe('invalid_request_error');
  });
});

// ---------------------------------------------------------------------------
// Step 7: Stage toggles + parseSkillManifest + FileTracker / prune concurrency
// ---------------------------------------------------------------------------
describe('Wave 2 Step 7 — Stage toggles, skill slug validation & concurrent FileTracker/prune', () => {
  it('validates skill slugs against path traversal and disables stages via stageTogglesFromOverrides', async () => {
    expect(parseSkillManifest('# bad', '../escape')).toBeNull();
    expect(parseSkillManifest('---\nname: Good Skill\ndescription: ok\n---', 'good-skill')?.id).toBe('skill:good-skill');

    const toggles = stageTogglesFromOverrides({
      'optical-microfiche': false,
      'tscg-schema': true,
      'toon-structured': false,
    });
    expect(toggles.optical).toBe(false);
    expect(toggles.tscg).toBe(true);
    expect(toggles.toon).toBe(false);

    setAllowedModelBases(['claude-fable-5']);
    const body = JSON.stringify({
      model: 'claude-fable-5',
      system: Array.from({ length: 40 }, (_, i) => `Static system block ${i}: keep accurate citations.`).join('\n'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const out = await transformRequest(new TextEncoder().encode(body), {
      stageToggles: { optical: false },
    });
    expect(out.info.imageCount ?? 0).toBe(0);
  });

  it('preserves concurrent FileTracker writes during sessions.prune rewrite without losing or corrupting lines', async () => {
    const dir = makeTmpDir('fiche-prune-');
    const paths: SessionsPaths = {
      eventsFile: path.join(dir, 'events.jsonl'),
      sidecarDir: path.join(dir, '4xx-bodies'),
    };
    const tracker = new FileTracker(paths.eventsFile);
    try {
      const oldTs = '2020-01-01T00:00:00.000Z';
      const recentTs = new Date().toISOString();
      tracker.emit({
        ts: oldTs,
        method: 'POST',
        path: '/v1/messages',
        status: 200,
        duration_ms: 10,
        first_user_sha8: 'old11111',
      });
      tracker.emit({
        ts: recentTs,
        method: 'POST',
        path: '/v1/messages',
        status: 200,
        duration_ms: 10,
        first_user_sha8: 'new22222',
      });

      const prunePromise = prune(paths, { olderThanDays: 30, force: true });
      tracker.emit({
        ts: recentTs,
        method: 'POST',
        path: '/v1/messages',
        status: 200,
        duration_ms: 15,
        first_user_sha8: 'live3333',
      });
      const report = await prunePromise;
      tracker.close();

      expect(report.sessionsRemoved).toContain('old11111');
      const lines = fs.readFileSync(paths.eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TrackEvent);
      const ids = new Set(lines.map((l) => l.first_user_sha8));
      expect(ids.has('old11111')).toBe(false);
      expect(ids.has('new22222')).toBe(true);
      expect(ids.has('live3333')).toBe(true);
    } finally {
      tracker.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Step 8: Restart-proof replay + Tokmeter daily & per-model SVG charts + hygiene badges
// ---------------------------------------------------------------------------
describe('Wave 2 Step 8 — Restart-proof replay & Tokmeter-style dashboard analytics', () => {
  it('restores lifetime, daily (14d), per-model stats from .1 + active events while bounding rings to 50', async () => {
    const dir = makeTmpDir('fiche-replay-');
    const paths: SessionsPaths = {
      eventsFile: path.join(dir, 'events.jsonl'),
      sidecarDir: path.join(dir, '4xx-bodies'),
    };
    const now = new Date();
    const todayIso = now.toISOString();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
    const yesterdayIso = yesterday.toISOString();

    // Cold turns with baseline_cacheable_tokens: 2000 (3000 - 2000 tail = 1000)
    // baselineInputEff = 2000 * 1.25 + 1000 * 1.0 = 3500; actual = 1000 -> saved weighted = 2500/ev
    const rotatedEvents: TrackEvent[] = Array.from({ length: 30 }, () => ({
      ts: yesterdayIso,
      method: 'POST',
      path: '/v1/messages',
      model: 'claude-fable-5',
      status: 200,
      duration_ms: 100,
      compressed: true,
      image_count: 2,
      input_tokens: 1000,
      output_tokens: 50,
      cache_create_tokens: 0,
      cache_read_tokens: 0,
      baseline_tokens: 3000,
      baseline_cacheable_tokens: 2000,
      baseline_probe_status: 'ok',
      first_user_sha8: 'sess-yday',
    }));

    // Today: baseline = 1500, cacheable = 1000 -> baselineInputEff = 1000 * 1.25 + 500 = 1750; actual = 500 -> saved weighted = 1250/ev
    const activeEvents: TrackEvent[] = [
      ...Array.from({ length: 30 }, () => ({
        ts: todayIso,
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-fable-5',
        status: 200,
        duration_ms: 100,
        compressed: true,
        image_count: 1,
        input_tokens: 500,
        output_tokens: 20,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        baseline_tokens: 1500,
        baseline_cacheable_tokens: 1000,
        baseline_probe_status: 'ok',
        first_user_sha8: 'sess-today',
      })),
      {
        ts: todayIso,
        method: 'POST',
        path: '/v1/messages',
        model: 'claude-opus-5-5',
        status: 200,
        duration_ms: 80,
        compressed: true,
        reason: 'text_hygiene',
        image_count: 0,
        text_hygiene_saved_tokens: 400,
        text_hygiene_stages: ['ws', 'toon'],
        input_tokens: 600,
        output_tokens: 40,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
      },
    ];

    fs.writeFileSync(`${paths.eventsFile}.1`, rotatedEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(paths.eventsFile, activeEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');

    setAllowedModelBases(['claude-fable-5']);
    const dash = new DashboardState(paths, async () => new Map());
    await dash.replay(paths.eventsFile);

    const stats = (await dash.serveStats().json()) as StatsPayload;
    expect(stats.requests).toBe(61);
    expect(stats.compressed_requests).toBe(61);
    expect(stats.imaged_requests).toBe(60);
    expect(stats.text_compressed_requests).toBe(1);
    expect(stats.raw_saved_tokens).toBe(30 * 2000 + 30 * 1000 + 400);
    expect(stats.saved_input_tokens).toBe(30 * 2500 + 30 * 1250 + 400);
    expect(stats.saved_usd).toBeGreaterThan(0);
    expect(stats.daily).toHaveLength(14);
    expect(stats.daily?.at(-1)?.is_today).toBe(true);
    expect(stats.today?.requests).toBe(31);
    expect(stats.by_model?.['claude-fable-5']?.imaged).toBe(60);
    expect(stats.by_model?.['claude-opus-5-5']?.text_compressed).toBe(1);

    // Recent ring strictly capped at 50 despite 61 replayed lifetime events
    const recent = (await dash.serveRecent().json()) as { recent: Array<{ compression_mode?: string; cc_added?: number }> };
    expect(recent.recent).toHaveLength(50);
    const tailRow = recent.recent.at(-1)!;
    expect(tailRow.compression_mode).toBe('text');
    expect(tailRow.cc_added).toBeUndefined();

    // Fragment assertions: SVG 14-day chart + text-hygiene badge
    const analyticsHtml = await (await dash.serveFragment('analytics', new URL('http://127.0.0.1/fragments/analytics'), 47821)).text();
    expect(analyticsHtml).toContain('data-chart="daily"');
    expect(analyticsHtml).toContain('Live today');
    expect(analyticsHtml).toContain('claude-fable-5');

    const recentHtml = renderRecentFragment(recent as never);
    expect(recentHtml).toContain('badge-hyg');
    expect(recentHtml).toContain('text-hygiene');
    expect(recentHtml).toContain('badge-img');
  });
});
