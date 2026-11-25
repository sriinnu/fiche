/**
 * Shared zero-spawn resolution helpers for Fiche companion scripts
 * (Antigravity PostInvocation hook & Claude Code statusLine).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function resolveEventsFile() {
  const ficheLog = process.env.FICHE_LOG?.trim() || undefined;
  const inklingLog = process.env.INKLING_LOG?.trim() || undefined;
  const configured = ficheLog ?? inklingLog;
  if (configured) return configured;
  const preferred = path.join(os.homedir(), '.fiche', 'events.jsonl');
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(os.homedir(), '.inkling', 'events.jsonl');
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

export function resolveFicheBins(scriptsDir = SCRIPTS_DIR) {
  const home = os.homedir();
  const binName = process.platform === 'win32' ? 'fiche.cmd' : 'fiche';
  const pathBins = (process.env.PATH || '')
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => path.join(dir, binName))
    .filter((candidate) => fs.existsSync(candidate));
  const repoCli = path.resolve(scriptsDir, '../../../bin/cli.js');
  const candidates = [
    process.env.FICHE_BIN?.trim() || undefined,
    process.env.INKLING_BIN?.trim() || undefined,
    path.join(home, '.local', 'bin', binName),
    ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin/fiche', '/usr/local/bin/fiche']),
    ...pathBins,
    ...(fs.existsSync(repoCli) ? [repoCli] : []),
    binName,
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function packageRootsForBin(binPath) {
  const roots = [];
  if (!path.isAbsolute(binPath)) return roots;
  const binDir = path.dirname(binPath);
  // Global npm / pnpm layout (e.g. %APPDATA%\npm\node_modules\@sriinnu\fiche or ~/.local/share/pnpm/global/5/node_modules/@sriinnu/fiche)
  roots.push(path.resolve(binDir, 'node_modules/@sriinnu/fiche'));
  roots.push(path.resolve(binDir, '../node_modules/@sriinnu/fiche'));
  roots.push(path.resolve(binDir, '../lib/node_modules/@sriinnu/fiche'));
  try {
    const real = fs.realpathSync(binPath);
    const realDir = path.dirname(real);
    roots.push(path.resolve(realDir, '..'));
    roots.push(path.resolve(realDir, '../lib/node_modules/@sriinnu/fiche'));
  } catch {
    // ignore broken/missing symlink
  }
  return [...new Set(roots)];
}

/**
 * Resolve `dist/turn-report.js` in <1ms without spawning a subprocess.
 * Works inside a repo checkout, symlinked `~/.local/bin/fiche`, or global npm/pnpm installs.
 */
export async function loadTurnReportModule(scriptsDir = SCRIPTS_DIR) {
  const envModule =
    process.env.FICHE_TURN_REPORT_MODULE?.trim() ||
    process.env.INKLING_TURN_REPORT_MODULE?.trim() ||
    undefined;
  const candidates = [
    envModule,
    path.resolve(scriptsDir, '../../../dist/turn-report.js'),
  ].filter(Boolean);

  for (const binPath of resolveFicheBins(scriptsDir)) {
    for (const pkgRoot of packageRootsForBin(binPath)) {
      candidates.push(path.join(pkgRoot, 'dist/turn-report.js'));
    }
  }

  for (const modPath of [...new Set(candidates)]) {
    if (!fs.existsSync(modPath)) continue;
    try {
      return await import(pathToFileURL(modPath).href);
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Fallback CLI invocation that avoids Node >= 20.12.2 Windows `.cmd` `EINVAL`
 * by preferring the underlying `.js` entrypoint via `process.execPath` when available.
 */
export function spawnFicheTurnReport(args, scriptsDir = SCRIPTS_DIR) {
  const jsEntries = [path.resolve(scriptsDir, '../../../bin/cli.js')];
  for (const binPath of resolveFicheBins(scriptsDir)) {
    if (/\.(?:m?js|cjs)$/i.test(binPath)) jsEntries.push(binPath);
    for (const pkgRoot of packageRootsForBin(binPath)) {
      jsEntries.push(path.join(pkgRoot, 'bin/cli.js'));
    }
  }
  for (const entry of [...new Set(jsEntries)]) {
    if (!fs.existsSync(entry)) continue;
    const res = spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim()) {
      return res;
    }
  }

  for (const bin of resolveFicheBins(scriptsDir)) {
    const needsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(bin);
    const res = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: 3000,
      ...(needsShell ? { shell: true } : {}),
    });
    if (res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim()) {
      return res;
    }
  }
  return null;
}
