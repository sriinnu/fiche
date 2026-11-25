import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { setAllowedModelBases } from '../src/core/applicability.js';
import {
  ContextPageStore,
  configureMmuLimits,
  getGlobalMmuStore,
  resetGlobalMmuStore,
} from '../src/core/context-mmu.js';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { prefersText, shouldImageModel } from '../src/core/reader-tier.js';
import {
  configureMaxSessions,
  getMaxSessions,
  noteHistoryRequest,
  resetSessionState,
  sessionStateSize,
} from '../src/core/session-state.js';
import {
  extractKoshaModelBases,
  loadKoshaSnapshot,
  mergeModelBases,
  normalizeKoshaModelBase,
  type KoshaRegistrySnapshot,
} from '../src/kosha-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_NODE_PATH = path.join(REPO_ROOT, 'dist', 'node.js');

const DEFAULT_MMU_BYTES = 16 * 1024 * 1024;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function reserveClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('unexpected address')));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

afterEach(() => {
  setAllowedModelBases(null);
  resetSessionState();
  configureMaxSessions(undefined);
  resetGlobalMmuStore();
  configureMmuLimits({ maxPages: 512, maxBytes: DEFAULT_MMU_BYTES });
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('swarm hardening: kosha model sync', () => {
  it('normalizes model IDs and skips aliases, routers, placeholders, and non-LLM modalities', () => {
    expect(normalizeKoshaModelBase('google/gemini-3.6-flash[1m]')).toBe('gemini');
    expect(normalizeKoshaModelBase('gemini-4-argon-preview-09-2025')).toBe('gemini');
    expect(normalizeKoshaModelBase('accounts/fireworks/models/deepseek-v4.1-flash-1017:peft:262144')).toBe(
      'deepseek-v4.1-flash',
    );
    expect(normalizeKoshaModelBase('openrouter/qwen/qwen3-coder-plus:free')).toBe('qwen3-coder-plus');
    expect(normalizeKoshaModelBase('gpt-5.6-sol-2025-11-01')).toBe('gpt-5.6-sol');

    // Rejected placeholders / aliases / meta-routers / non-LLM modalities
    expect(normalizeKoshaModelBase('~anthropic/claude-fable-latest')).toBeNull();
    expect(normalizeKoshaModelBase('accounts/fireworks/routers/glm-latest')).toBeNull();
    expect(normalizeKoshaModelBase('openrouter/free')).toBeNull();
    expect(normalizeKoshaModelBase('openai/gpt-chat-latest')).toBeNull();
    expect(normalizeKoshaModelBase('firerouter')).toBeNull();
    expect(normalizeKoshaModelBase('auto')).toBeNull();
    expect(normalizeKoshaModelBase('chat-latest')).toBeNull();
    expect(normalizeKoshaModelBase('text-embedding-3-large')).toBeNull();
    expect(normalizeKoshaModelBase('grok-voice')).toBeNull();
    expect(normalizeKoshaModelBase('qwen3-asr-flash')).toBeNull();
    expect(normalizeKoshaModelBase('mistral-ocr-latest')).toBeNull();
  });

  it('extracts deduplicated prefix-collapsed chat bases from both Kosha shapes and merges cleanly', () => {
    const snapshot: KoshaRegistrySnapshot = {
      models: [
        { providerId: 'anthropic', modelId: 'claude-fable-5', mode: 'chat', status: 'active' },
        { providerId: 'anthropic', modelId: 'claude-fable-5-1', mode: 'chat', status: 'active' },
        { providerId: 'google', modelId: 'gemini-3.6-flash', mode: 'chat', status: 'active' },
        { providerId: 'google', modelId: 'gemini-3.1-pro-preview', mode: 'chat', status: 'deprecated' },
        { providerId: 'deepseek', modelId: 'deepseek-chat', mode: 'chat', status: 'retired' },
        { providerId: 'deepseek', modelId: 'deepseek-v4-pro-0813', mode: 'chat', status: 'active' },
        { providerId: 'moonshot', modelId: 'kimi-k2.6', mode: 'chat', status: 'active' },
        { providerId: 'zai-coding-plan', modelId: 'glm-5.1', mode: 'chat', status: 'active' },
        { providerId: 'alibaba', modelId: 'qwen3-coder-plus', mode: 'chat', status: 'active' },
        { providerId: 'alibaba', modelId: 'qwen3-asr-flash', mode: 'chat', status: 'active' },
        { providerId: 'openrouter', modelId: 'openrouter/free', mode: 'chat', status: 'active' },
        { providerId: 'openrouter', modelId: 'openai/gpt-chat-latest', mode: 'chat', status: null },
        { providerId: 'openai', modelId: 'text-embedding-3-small', mode: 'embedding', status: 'active' },
      ],
      providers: [
        {
          id: 'xai',
          models: [
            { id: 'grok-4.20-0309-reasoning', mode: 'chat', status: 'active' },
            { id: 'grok-voice', mode: 'chat', status: 'active' },
          ],
        },
      ],
    };

    const res = extractKoshaModelBases(snapshot, {
      providers: ['anthropic', 'google', 'deepseek', 'kimi', 'glm', 'qwen', 'openrouter', 'xai', 'openai'],
    });
    expect(res.bases).toEqual([
      'claude-fable-5',
      'deepseek-v4-pro',
      'gemini',
      'glm-5.1',
      'grok-4.20',
      'kimi-k2.6',
      'qwen3-coder-plus',
    ]);

    // Prefix coverage when merging with existing hand-curated bases (`deepseek` covers `deepseek-v4-pro`)
    const merged = mergeModelBases(['claude-fable-5', 'gemini', 'deepseek'], res.bases, false);
    expect(merged.added).toEqual(['glm-5.1', 'grok-4.20', 'kimi-k2.6', 'qwen3-coder-plus']);
    expect(merged.merged).toEqual([
      'claude-fable-5',
      'gemini',
      'deepseek',
      'glm-5.1',
      'grok-4.20',
      'kimi-k2.6',
      'qwen3-coder-plus',
    ]);

    // Replace mode overwrites list cleanly with discovered set
    const replaced = mergeModelBases(['legacy-only'], res.bases, true);
    expect(replaced.merged).toEqual(res.bases);
    expect(replaced.added).toEqual(res.bases);
  });

  it('runs fiche models sync-kosha dry-run and --apply cleanly against isolated config paths', async () => {
    const dir = makeTempDir('fiche-kosha-cli-');
    const registryPath = path.join(dir, 'registry.json');
    const cfgPath = path.join(dir, 'config.json');
    const unreachablePort = await reserveClosedPort();

    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        models: [
          { providerId: 'deepseek', modelId: 'deepseek-v4-pro', mode: 'chat', status: 'active' },
          { providerId: 'alibaba', modelId: 'qwen3.7-coder-plus', mode: 'chat', status: 'active' },
          { providerId: 'openai', modelId: 'gpt-5.6-sol', mode: 'chat', status: 'active' },
        ],
      }),
    );

    // Direct loader sanity check
    const loaded = loadKoshaSnapshot(registryPath);
    expect(loaded.source).toBe(registryPath);

    const env = {
      ...process.env,
      HOME: dir,
      FICHE_CONFIG: cfgPath,
      PORT: String(unreachablePort),
    };

    // Dry-run must NOT create or modify config.json
    const dryOut = execFileSync(
      'node',
      [DIST_NODE_PATH, 'models', 'sync-kosha', '--file', registryPath, '--providers', 'deepseek,qwen', '--json'],
      { cwd: REPO_ROOT, env, encoding: 'utf8' },
    );
    const dryJson = JSON.parse(dryOut) as {
      ok: boolean;
      applied: boolean;
      added: string[];
      models: string[];
      saved: boolean;
    };
    expect(dryJson.ok).toBe(true);
    expect(dryJson.applied).toBe(false);
    expect(dryJson.saved).toBe(false);
    expect(dryJson.added).toEqual(['deepseek-v4-pro', 'qwen3.7-coder-plus']);
    expect(fs.existsSync(cfgPath)).toBe(false);

    // --apply writes isolated FICHE_CONFIG cleanly while keeping defaults
    const applyOut = execFileSync(
      'node',
      [
        DIST_NODE_PATH,
        'models',
        'sync-kosha',
        '--file',
        registryPath,
        '--providers',
        'deepseek,qwen',
        '--apply',
        '--json',
      ],
      { cwd: REPO_ROOT, env, encoding: 'utf8' },
    );
    const applyJson = JSON.parse(applyOut) as {
      ok: boolean;
      applied: boolean;
      saved: boolean;
      models: string[];
    };
    expect(applyJson.ok).toBe(true);
    expect(applyJson.applied).toBe(true);
    expect(applyJson.saved).toBe(true);
    expect(applyJson.models).toEqual(['claude-fable-5', 'gemini', 'deepseek-v4-pro', 'qwen3.7-coder-plus']);

    const writtenCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { models?: string[] };
    expect(writtenCfg.models).toEqual(['claude-fable-5', 'gemini', 'deepseek-v4-pro', 'qwen3.7-coder-plus']);
  });
});

describe('swarm hardening: provider-neutral x-fiche-session-id & parallel 409 dedupe', () => {
  it('isolates sessionKey, strips x-fiche-session-id / x-inkling-session-id, and preserves x-claude-code-session-id across all 4 wires', async () => {
    setAllowedModelBases(['claude-fable-5', 'gpt-5.6-sol', 'gemini']);

    const upstreamHeadersSeen: Array<{ url: string; headers: Record<string, string> }> = [];
    const events: ProxyEvent[] = [];

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const reqObj = input instanceof Request ? input : new Request(input, init);
      const hObj: Record<string, string> = {};
      reqObj.headers.forEach((v, k) => {
        hObj[k.toLowerCase()] = v;
      });
      upstreamHeadersSeen.push({ url: reqObj.url, headers: hObj });

      if (reqObj.url.includes('/v1/messages/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 100 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (reqObj.url.includes('/v1/messages')) {
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-fable-5',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 100, output_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (reqObj.url.includes('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'chat_1',
            object: 'chat.completion',
            model: 'gpt-5.6-sol',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (reqObj.url.includes('/v1/responses')) {
        return new Response(
          JSON.stringify({
            id: 'resp_1',
            object: 'response',
            model: 'gpt-5.6-sol',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
            usage: { input_tokens: 100, output_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const proxy = createProxy({
      upstream: 'https://anthropic.test',
      openAIUpstream: 'https://openai.test',
      passthroughUpstream: 'https://gemini.test',
      fetch: mockFetch,
      transform: {},
      onRequest: (e) => events.push(e),
    });

    const identicalPrompt = 'Inspect src/core/proxy.ts for swarm session isolation.';
    const waitEvent = async () => new Promise((r) => setTimeout(r, 15));

    // 1. OpenAI Chat wire with x-fiche-session-id vs second worker
    await proxy(
      new Request('http://127.0.0.1/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-openai-test',
          'x-fiche-session-id': 'swarm-chat-worker-a',
        },
        body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: identicalPrompt }] }),
      }),
    ).then((r) => r.text());
    await proxy(
      new Request('http://127.0.0.1/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-openai-test',
          'x-inkling-session-id': 'swarm-chat-worker-b',
        },
        body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: identicalPrompt }] }),
      }),
    ).then((r) => r.text());

    // 2. OpenAI Responses wire with x-fiche-session-id
    await proxy(
      new Request('http://127.0.0.1/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-openai-test',
          'x-fiche-session-id': 'swarm-resp-worker-1',
        },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: [{ role: 'user', content: identicalPrompt }] }),
      }),
    ).then((r) => r.text());

    // 3. Google Gemini wire with x-fiche-session-id
    await proxy(
      new Request('http://127.0.0.1/v1beta/models/gemini-3.6-pro:generateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': 'AIzaTestKey',
          'x-fiche-session-id': 'swarm-google-worker-1',
        },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: identicalPrompt }] }] }),
      }),
    ).then((r) => r.text());

    // 4. Anthropic wire with x-fiche-session-id AND legacy x-claude-code-session-id
    await proxy(
      new Request('http://127.0.0.1/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-test',
          'x-fiche-session-id': 'swarm-anth-worker-1',
        },
        body: JSON.stringify({
          model: 'claude-fable-5',
          max_tokens: 64,
          messages: [{ role: 'user', content: identicalPrompt }],
        }),
      }),
    ).then((r) => r.text());
    await proxy(
      new Request('http://127.0.0.1/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-test',
          'x-claude-code-session-id': 'cc-uuid-12345678',
        },
        body: JSON.stringify({
          model: 'claude-fable-5',
          max_tokens: 64,
          messages: [{ role: 'user', content: identicalPrompt }],
        }),
      }),
    ).then((r) => r.text());

    await waitEvent();

    expect(events).toHaveLength(6);
    const [chatA, chatB, resp1, gem1, anthFiche, anthCc] = events;

    // Every fiche/inkling header event gets distinct session_key despite identical Turn-1 prompt
    expect(chatA?.info?.sessionKeySource).toBe('fiche-header');
    expect(chatB?.info?.sessionKeySource).toBe('fiche-header');
    expect(resp1?.info?.sessionKeySource).toBe('fiche-header');
    expect(gem1?.info?.sessionKeySource).toBe('fiche-header');
    expect(anthFiche?.info?.sessionKeySource).toBe('fiche-header');
    expect(anthCc?.info?.sessionKeySource).toBe('claude-code-header');

    const keys = [
      chatA?.info?.sessionKey,
      chatB?.info?.sessionKey,
      resp1?.info?.sessionKey,
      gem1?.info?.sessionKey,
      anthFiche?.info?.sessionKey,
      anthCc?.info?.sessionKey,
    ];
    expect(new Set(keys).size).toBe(6);

    // Strip verification: upstream never sees x-fiche-session-id or x-inkling-session-id
    for (const entry of upstreamHeadersSeen) {
      expect(entry.headers['x-fiche-session-id']).toBeUndefined();
      expect(entry.headers['x-inkling-session-id']).toBeUndefined();
    }
    // Anthropic inference request retains x-claude-code-session-id
    const anthInferenceCalls = upstreamHeadersSeen.filter((u) => u.url.endsWith('/v1/messages'));
    expect(anthInferenceCalls).toHaveLength(2);
    expect(anthInferenceCalls[1]?.headers['x-claude-code-session-id']).toBe('cc-uuid-12345678');
  });

  it('allows concurrent identical Turn-1 prompts across distinct x-fiche-session-id while deduping same-session 409', async () => {
    setAllowedModelBases(['gpt-5.6-sol']);

    let releaseUpstream!: () => void;
    const gate = new Promise<void>((r) => {
      releaseUpstream = r;
    });
    let upstreamCount = 0;

    const mockFetch: typeof globalThis.fetch = async () => {
      upstreamCount += 1;
      await gate;
      return new Response(
        JSON.stringify({
          id: `chat_${upstreamCount}`,
          object: 'chat.completion',
          model: 'gpt-5.6-sol',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const proxy = createProxy({
      openAIUpstream: 'https://openai.test',
      duplicateHoldMs: 5000,
      fetch: mockFetch,
      transform: {},
    });

    const body = JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Identical Turn-1 swarm worker task' }],
    });

    const makeReq = (sid: string) =>
      proxy(
        new Request('http://127.0.0.1/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer sk-openai-test',
            'x-fiche-session-id': sid,
          },
          body,
        }),
      );

    // Launch worker-1, worker-2, and a duplicate retry of worker-1 while all are in-flight
    const p1 = makeReq('worker-1');
    const p2 = makeReq('worker-2');
    await new Promise((r) => setTimeout(r, 20));
    const p1Dup = makeReq('worker-1');

    const resDup = await p1Dup;
    expect(resDup.status).toBe(409);
    const dupBody = (await resDup.json()) as { error?: { message?: string } };
    expect(dupBody.error?.message).toMatch(/already in progress/i);

    releaseUpstream();
    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(upstreamCount).toBe(2);
  });
});

describe('swarm hardening: configurable MMU & session limits and reader tiers', () => {
  it('clamps configureMmuLimits / configureMaxSessions and evicts oldest entries when shrinking', () => {
    // Clamping checks
    expect(configureMaxSessions(10)).toBe(64);
    expect(configureMaxSessions(99_999)).toBe(8192);
    expect(getMaxSessions()).toBe(8192);
    expect(configureMaxSessions(1024)).toBe(1024);

    // Seed 80 sessions then shrink cap to 64 -> oldest evicted down to 64
    resetSessionState();
    for (let i = 0; i < 80; i += 1) {
      noteHistoryRequest(`sess-${i}`);
    }
    expect(sessionStateSize()).toBe(80);
    expect(configureMaxSessions(64)).toBe(64);
    expect(sessionStateSize()).toBe(64);

    // MMU global limits clamping [64, 16384] pages & [4 MiB, 256 MiB] bytes
    const clampedLow = configureMmuLimits({ maxPages: 8, maxBytes: 1024 });
    expect(clampedLow).toEqual({ maxPages: 64, maxBytes: 4 * 1024 * 1024 });
    const clampedHigh = configureMmuLimits({ maxPages: 100_000, maxBytes: 2048 * 1024 * 1024 });
    expect(clampedHigh).toEqual({ maxPages: 16_384, maxBytes: 256 * 1024 * 1024 });

    // Immediate eviction when global store shrinks
    configureMmuLimits({ maxPages: 128, maxBytes: 16 * 1024 * 1024 });
    const globalStore = getGlobalMmuStore();
    for (let i = 0; i < 80; i += 1) {
      globalStore.storePage({
        sessionKey: `s-${i}`,
        refId: `ref-${i}`,
        rawText: `function fn_${i}() { return ${i}; } // ${'x'.repeat(200)}`,
      });
    }
    expect(globalStore.getStats().activePages).toBe(80);
    configureMmuLimits({ maxPages: 64 });
    expect(globalStore.getStats().activePages).toBe(64);

    // Direct ContextPageStore.setLimits also evicts strictly down to small bounds
    const smallStore = new ContextPageStore({ maxPages: 10, maxBytes: 1024 * 1024 });
    for (let i = 0; i < 6; i += 1) {
      smallStore.storePage({
        sessionKey: 'local',
        refId: `p-${i}`,
        rawText: `const item_${i} = ${i}; // ${'y'.repeat(120)}`,
      });
    }
    expect(smallStore.getStats().activePages).toBe(6);
    smallStore.setLimits({ maxPages: 3 });
    expect(smallStore.getStats().activePages).toBe(3);
  });

  it('keeps Kosha-synced open-weight and third-party families in deterministic text tier by default', () => {
    const textOnlyModels = [
      'qwen3-coder-plus',
      'mistral-large',
      'codestral',
      'meta-llama/llama-3.3-70b',
      'command-a',
      'gpt-oss-120b',
      'gemma-4-31b-it',
    ];
    for (const id of textOnlyModels) {
      expect(prefersText(id, false), id).toBe(true);
      expect(shouldImageModel(id, true, false), id).toBe(false);
    }
  });
});
