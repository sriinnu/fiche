/**
 * Shared zero-spawn resolution helpers for Fiche telemetry scripts
 * (Antigravity PostInvocation hook & Claude Code statusLine).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/**
 * Resolve `dist/turn-report.js` in <1ms without spawning a subprocess.
 * Works both inside the repo (`../../../dist/turn-report.js`) and when the
 * plugin is copied externally (follows symlinks on ~/.local/bin/fiche -> bin/cli.js).
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
    if (!path.isAbsolute(binPath)) continue;
    try {
      const real = fs.realpathSync(binPath);
      candidates.push(path.resolve(path.dirname(real), '../dist/turn-report.js'));
    } catch {
      // ignore missing bin symlink
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
