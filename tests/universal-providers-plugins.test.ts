import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_UPSTREAM_REGISTRY,
  resolveFollowTarget,
} from '../src/core/upstream-hosts.js';
import { transformGoogleGenerateContent } from '../src/core/google.js';
import { compatRoutes, defaultRoutes } from '../src/warp/index.js';
import { matchRoute } from '../src/warp/route.js';
import {
  buildWarpAppArgs,
  renderShellInitScript,
  resolveMacAppBundle,
} from '../src/warp/app-launch.js';
import {
  DashboardState,
  dispatchDashboard,
  isDashboardMutation,
} from '../src/dashboard.js';
import { renderPluginsFragment } from '../src/dashboard/fragments.js';
import {
  BUILTIN_STAGE_PLUGINS,
  isThirdPartyPlugin,
  mergeStagePlugins,
  type StagePluginDescriptor,
} from '../src/core/stage-plugins.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('universal provider & model support', () => {
  it('routes all newly registered compat providers via /to/ and warp compatRoutes', () => {
    const newProviders: ReadonlyArray<{ host: string; path: string; wirePath: string }> = [
      { host: 'api.groq.com', path: '/openai/v1/chat/completions', wirePath: '/v1/chat/completions' },
      { host: 'api.together.xyz', path: '/v1/chat/completions', wirePath: '/v1/chat/completions' },
      { host: 'api.fireworks.ai', path: '/inference/v1/chat/completions', wirePath: '/v1/chat/completions' },
      { host: 'api.cerebras.ai', path: '/v1/chat/completions', wirePath: '/v1/chat/completions' },
      { host: 'api.mistral.ai', path: '/v1/chat/completions', wirePath: '/v1/chat/completions' },
      { host: 'api.perplexity.ai', path: '/chat/completions', wirePath: '/chat/completions' },
      { host: 'api.cohere.com', path: '/compatibility/v1/chat/completions', wirePath: '/v1/chat/completions' },
      { host: 'api.sambanova.ai', path: '/v1/chat/completions', wirePath: '/v1/chat/completions' },
      { host: 'models.github.ai', path: '/inference/chat/completions', wirePath: '/chat/completions' },
      { host: 'models.inference.ai.azure.com', path: '/v1/chat/completions', wirePath: '/v1/chat/completions' },
      { host: 'ai-gateway.vercel.sh', path: '/v1/chat/completions', wirePath: '/v1/chat/completions' },
    ];

    const cRoutes = compatRoutes(47821);
    for (const p of newProviders) {
      expect(DEFAULT_UPSTREAM_REGISTRY.has(p.host)).toBe(true);
      const target = resolveFollowTarget(new URL(`http://127.0.0.1:47821/to/${p.host}${p.path}`), null);
      expect(target && 'origin' in target ? target.origin : null).toBe(`https://${p.host}`);
      expect(target && 'origin' in target ? target.wirePathname : null).toBe(p.wirePath);
      expect(matchRoute(cRoutes, p.host, p.path)).not.toBeNull();
    }

    const dRoutes = defaultRoutes(47821);
    expect(
      matchRoute(dRoutes, 'generativelanguage.googleapis.com', '/v1beta/openai/chat/completions'),
    ).not.toBeNull();

    // Unknown & metadata hosts remain refused.
    expect(matchRoute(cRoutes, 'evil.example.com', '/v1/chat/completions')).toBeNull();
    const ssrf = resolveFollowTarget(new URL('http://127.0.0.1:47821/to/169.254.169.254/v1/chat/completions'), null);
    expect(ssrf && 'status' in ssrf ? ssrf.status : null).toBe(400);
  });

  it('runs deterministic text hygiene on non-Gemini models over /v1internal including functionResponse.parts & extra keys', async () => {
    const repeatedBlock = Array.from({ length: 18 }, (_, i) => `log line ${i}: connected worker pool id=42 ok\r`).join('\n');
    const body = new TextEncoder().encode(
      JSON.stringify({
        project: 'demo',
        request: {
          contents: [
            { role: 'user', parts: [{ text: 'Check logs' }] },
            {
              role: 'model',
              parts: [{ functionCall: { name: 'read_log', args: { path: '/tmp/a.log' } } }],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: 'read_log',
                    response: { fileContent: repeatedBlock },
                    parts: [{ text: repeatedBlock }],
                  },
                },
                {
                  functionResponse: {
                    name: 'read_log',
                    response: { fileContent: repeatedBlock },
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    const res = await transformGoogleGenerateContent(body, 'claude-opus-5-5-high', {
      compress: true,
      imageCompress: false,
      textHygiene: 'on',
    });

    expect(res.info.compressed).toBe(true);
    expect(res.info.reason).toBe('text_hygiene');
    expect((res.info.textHygieneSavedChars ?? 0) > 0).toBe(true);
    const outText = new TextDecoder().decode(res.body);
    expect(outText.length).toBeLessThan(body.byteLength);
    expect(outText).not.toContain('thoughtSignature');
  });
});

describe('CLI wrappers & macOS desktop app launcher', () => {
  it('resolves Electron and native .app bundles and builds proxy launch args', () => {
    const appsDir = mkdtempSync(join(tmpdir(), 'fiche-apps-'));
    tempDirs.push(appsDir);

    const electronApp = join(appsDir, 'Cursor.app');
    mkdirSync(join(electronApp, 'Contents/MacOS'), { recursive: true });
    mkdirSync(join(electronApp, 'Contents/Frameworks/Electron Framework.framework'), { recursive: true });
    writeFileSync(
      join(electronApp, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Cursor</string></dict></plist>`,
    );
    const electronExe = join(electronApp, 'Contents/MacOS/Cursor');
    writeFileSync(electronExe, '#!/bin/sh\necho ok\n');
    chmodSync(electronExe, 0o755);

    const nativeApp = join(appsDir, 'Runic.app');
    mkdirSync(join(nativeApp, 'Contents/MacOS'), { recursive: true });
    writeFileSync(
      join(nativeApp, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Runic</string></dict></plist>`,
    );
    const nativeExe = join(nativeApp, 'Contents/MacOS/Runic');
    writeFileSync(nativeExe, '#!/bin/sh\necho ok\n');
    chmodSync(nativeExe, 0o755);

    const resolvedElectron = resolveMacAppBundle('cursor', [appsDir]);
    expect(resolvedElectron).not.toBeNull();
    expect(resolvedElectron!.isElectron).toBe(true);
    expect(buildWarpAppArgs(resolvedElectron!, 'http://127.0.0.1:55555', ['--new-window'])).toEqual([
      electronExe,
      '--proxy-server=http://127.0.0.1:55555',
      '--new-window',
    ]);

    const resolvedNative = resolveMacAppBundle(nativeApp, [appsDir]);
    expect(resolvedNative).not.toBeNull();
    expect(resolvedNative!.isElectron).toBe(false);
    expect(buildWarpAppArgs(resolvedNative!, 'http://127.0.0.1:55555')).toEqual([nativeExe]);

    expect(resolveMacAppBundle('DoesNotExist', [appsDir])).toBeNull();
  });

  it('renders POSIX helpers and optional transparent CLI wrappers with recursion bypass', () => {
    const basic = renderShellInitScript();
    expect(basic).toContain('fclaude()');
    expect(basic).toContain('fiche-app()');
    expect(basic).not.toContain('FICHE_BYPASS');

    const wrapped = renderShellInitScript({ wrap: true, ficheBin: '/opt/fiche/bin/fiche' });
    expect(wrapped).toContain(`export FICHE_BIN='/opt/fiche/bin/fiche'`);
    expect(wrapped).toContain('claude() { [ "${FICHE_BYPASS:-0}" = "1" ]');
    expect(wrapped).toContain('codex()');
    expect(wrapped).toContain('agy()');
  });
});

describe('one-click 3rd-party plugins & extensions toggle', () => {
  it('distinguishes built-in + fiche skill from external extensions and toggles them in one call', async () => {
    const discovered: StagePluginDescriptor[] = [
      { id: 'skill:fiche', name: 'fiche', stage: 'skill', kind: 'skill', description: 'Built-in fiche skill', enabled: true },
      { id: 'skill:azure-ai', name: 'azure-ai', stage: 'skill', kind: 'skill', description: 'Azure AI', enabled: true },
      { id: 'custom:foo', name: 'Foo Plugin', stage: 'hygiene', kind: 'custom', description: 'Custom ext', enabled: true },
    ];
    let overrides: Record<string, boolean> = {};
    const dash = new DashboardState(undefined, undefined, undefined, {
      listPlugins: () => mergeStagePlugins(discovered, overrides),
      setPluginEnabled: (id, enabled) => {
        overrides[id] = enabled;
        const plugins = mergeStagePlugins(discovered, overrides);
        const plugin = plugins.find((p) => p.id === id);
        return plugin ? { plugin, plugins } : null;
      },
      setThirdPartyPluginsEnabled: (enabled) => {
        const current = mergeStagePlugins(discovered, overrides);
        let updatedCount = 0;
        for (const p of current) {
          if (!isThirdPartyPlugin(p)) continue;
          overrides[p.id] = enabled;
          updatedCount += 1;
        }
        return { updatedCount, enabled, plugins: mergeStagePlugins(discovered, overrides) };
      },
    });

    expect(isThirdPartyPlugin(BUILTIN_STAGE_PLUGINS[0]!)).toBe(false);
    expect(isThirdPartyPlugin(discovered[0]!)).toBe(false);
    expect(isThirdPartyPlugin(discovered[1]!)).toBe(true);
    expect(isThirdPartyPlugin(discovered[2]!)).toBe(true);

    expect(isDashboardMutation({ kind: 'fragment', name: 'plugins' }, 'POST')).toBe(true);

    const disableRes = await dispatchDashboard(
      dash,
      { kind: 'fragment', name: 'plugins' },
      'POST',
      new URL('http://127.0.0.1:47821/fragments/plugins'),
      47821,
      async () => JSON.stringify({ scope: 'third-party', enabled: false }),
    );
    expect(disableRes?.status).toBe(200);
    const disabledHtml = await disableRes!.text();
    expect(disabledHtml).toContain('Enable all 3rd-party (2)');

    const afterDisable = mergeStagePlugins(discovered, overrides);
    expect(afterDisable.find((p) => p.id === 'skill:fiche')?.enabled).toBe(true);
    expect(afterDisable.find((p) => p.id === 'skill:azure-ai')?.enabled).toBe(false);
    expect(afterDisable.find((p) => p.id === 'custom:foo')?.enabled).toBe(false);

    const enableHtml = renderPluginsFragment(
      (await (await dash.servePlugins()).json() as { plugins: StagePluginDescriptor[] }).plugins,
    );
    expect(enableHtml).toContain('Enable all 3rd-party (2)');

    const enableRes = dash.handlePluginsApiPost({ scope: 'third-party', enabled: true });
    expect(enableRes.status).toBe(200);
    const body = (await enableRes.json()) as { updatedCount: number; enabled: boolean; plugins: StagePluginDescriptor[] };
    expect(body.updatedCount).toBe(2);
    expect(body.plugins.find((p) => p.id === 'custom:foo')?.enabled).toBe(true);
  });
});
