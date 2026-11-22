/**
 * Resolve macOS `.app` bundles for `fiche warp --app` and generate POSIX shell
 * helpers (`fiche shell-init`) so both CLIs and GUI provider apps route cleanly
 * through the local Fiche proxy.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface ResolvedMacApp {
  readonly appPath: string;
  readonly executablePath: string;
  readonly appName: string;
  readonly isElectron: boolean;
}

const DEFAULT_APP_SEARCH_DIRS = ['/Applications', join(homedir(), 'Applications')] as const;

function sanitizeExecutableName(raw: string): string | null {
  const exe = raw.trim();
  if (!exe || exe === '.' || exe === '..' || exe.includes('/') || exe.includes('\\') || exe.includes('\0')) {
    return null;
  }
  return exe;
}

/** Parse CFBundleExecutable from an XML Info.plist without requiring macOS `plutil`. */
export function parseXmlBundleExecutable(infoPlistPath: string): string | null {
  let xml: string;
  try {
    xml = readFileSync(infoPlistPath, 'utf8');
  } catch {
    return null;
  }
  if (xml.startsWith('bplist')) return null;
  const match = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/i.exec(xml);
  if (!match?.[1]) return null;
  const decoded = match[1]
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
  return sanitizeExecutableName(decoded);
}

function readBundleExecutable(infoPlistPath: string): string | null {
  const pl = spawnSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', infoPlistPath], {
    encoding: 'utf8',
  });
  if (pl.status === 0) {
    const exe = sanitizeExecutableName(pl.stdout ?? '');
    if (exe) return exe;
  }
  return parseXmlBundleExecutable(infoPlistPath);
}

function findAppBundlePath(spec: string, searchDirs: readonly string[]): string | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  const direct = trimmed.endsWith('.app') ? trimmed : `${trimmed}.app`;
  if (trimmed.includes('/') || trimmed.startsWith('~')) {
    const expanded = trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed;
    const candidate = expanded.endsWith('.app') ? expanded : `${expanded}.app`;
    return existsSync(join(candidate, 'Contents/Info.plist')) ? candidate : null;
  }

  const targetLower = direct.toLowerCase();
  const bareLower = trimmed.toLowerCase();

  for (const dir of searchDirs) {
    try {
      const entries = readdirSync(dir);
      const matched = entries.find((entry) => {
        if (!entry.toLowerCase().endsWith('.app')) return false;
        const lower = entry.toLowerCase();
        return lower === targetLower || lower.slice(0, -4) === bareLower;
      });
      if (matched) {
        const resolved = join(dir, matched);
        if (existsSync(join(resolved, 'Contents/Info.plist'))) return resolved;
      }
    } catch {
      const exact = join(dir, direct);
      if (existsSync(join(exact, 'Contents/Info.plist'))) return exact;
    }
  }
  return null;
}

/** Resolve an installed macOS `.app` bundle by app name or `.app` path. */
export function resolveMacAppBundle(
  spec: string,
  searchDirs: readonly string[] = DEFAULT_APP_SEARCH_DIRS,
): ResolvedMacApp | null {
  const appPath = findAppBundlePath(spec, searchDirs);
  if (!appPath) return null;

  const infoPlistPath = join(appPath, 'Contents/Info.plist');
  const exeName = readBundleExecutable(infoPlistPath);
  if (!exeName) return null;

  const executablePath = join(appPath, 'Contents/MacOS', exeName);
  if (!existsSync(executablePath)) return null;

  const isElectron =
    existsSync(join(appPath, 'Contents/Frameworks/Electron Framework.framework')) ||
    existsSync(join(appPath, 'Contents/Resources/app.asar')) ||
    existsSync(join(appPath, 'Contents/Resources/app.asar.unpacked')) ||
    existsSync(join(appPath, 'Contents/Frameworks/Codex Framework.framework'));
  const appName = basename(appPath).replace(/\.app$/i, '');

  return { appPath, executablePath, appName, isElectron };
}

/** Build argv to launch a resolved macOS desktop app behind `fiche warp`. */
export function buildWarpAppArgs(
  app: ResolvedMacApp,
  proxyUrl: string,
  extraArgs: readonly string[] = [],
  opts?: { spkiPins?: readonly string[]; proxyBypassList?: string },
): string[] {
  if (app.isElectron) {
    const args = [app.executablePath, `--proxy-server=${proxyUrl}`];
    if (opts?.proxyBypassList) {
      args.push(`--proxy-bypass-list=${opts.proxyBypassList}`);
    }
    if (opts?.spkiPins && opts.spkiPins.length > 0) {
      args.push(`--ignore-certificate-errors-spki-list=${opts.spkiPins.join(',')}`);
    }
    args.push(...extraArgs);
    return args;
  }
  return [app.executablePath, ...extraArgs];
}

const CLI_WRAPPERS = ['claude', 'codex', 'agy', 'gemini', 'opencode', 'cursor-agent', 'amp', 'pi', 'aider'] as const;

/** Render POSIX zsh/bash shell helpers (or transparent wrappers when `--wrap` is set). */
export function renderShellInitScript(opts: { wrap?: boolean; ficheBin?: string } = {}): string {
  const bin = opts.ficheBin?.trim() || 'fiche';
  const safeBin = `'${bin.replaceAll("'", `'\\''`)}'`;
  const lines: string[] = [
    '# Added by `fiche shell-init` — route coding agent CLIs & macOS apps via local Fiche proxy.',
    `export FICHE_BIN=${safeBin}`,
    'fiche-app() { if [ "$#" -eq 0 ]; then "$FICHE_BIN" warp --app; else local app="$1"; shift; "$FICHE_BIN" warp --app "$app" -- "$@"; fi; }',
    'fclaude() { "$FICHE_BIN" warp -- claude "$@"; }',
    'fcodex() { "$FICHE_BIN" warp -- codex "$@"; }',
    'fagy() { "$FICHE_BIN" warp -- agy "$@"; }',
    'fgemini() { "$FICHE_BIN" warp -- gemini "$@"; }',
    'fopencode() { "$FICHE_BIN" warp -- opencode "$@"; }',
    'fcursor() { "$FICHE_BIN" warp -- cursor-agent "$@"; }',
    'famp() { "$FICHE_BIN" warp -- amp "$@"; }',
    'fpi() { "$FICHE_BIN" warp -- pi "$@"; }',
    'faider() { "$FICHE_BIN" warp -- aider "$@"; }',
  ];

  if (opts.wrap) {
    lines.push('');
    lines.push('# Transparent CLI wrappers (set FICHE_BYPASS=1 to skip proxy for one invocation)');
    for (const cli of CLI_WRAPPERS) {
      lines.push(
        `${cli}() { if [ "\${FICHE_BYPASS:-0}" = "1" ]; then command ${cli} "$@"; else "$FICHE_BIN" warp -- ${cli} "$@"; fi; }`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
