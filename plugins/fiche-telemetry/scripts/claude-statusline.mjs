#!/usr/bin/env node
/**
 * Claude Code statusLine reporter for Fiche.
 * Prints a compact single-line summary of the latest turn + active session
 * from `~/.fiche/events.jsonl` (or legacy `~/.inkling/events.jsonl`) in <5ms.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTurnReportModule, resolveEventsFile, resolveFicheBins } from './resolve-turn-report.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const eventsFile = resolveEventsFile();
  if (!fs.existsSync(eventsFile)) return;

  const mod = await loadTurnReportModule(SCRIPTS_DIR);
  if (mod) {
    const payload = mod.readTurnReport(eventsFile);
    const line = mod.formatClaudeStatusLine(payload);
    if (line) process.stdout.write(line);
    return;
  }

  for (const bin of resolveFicheBins(SCRIPTS_DIR)) {
    const res = spawnSync(bin, ['turn-report', '--format=claude-statusline', '--file', eventsFile], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim()) {
      process.stdout.write(res.stdout.trim());
      return;
    }
  }
}

main().catch(() => {
  // Never break status bar rendering on error.
});
