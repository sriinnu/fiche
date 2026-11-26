#!/usr/bin/env node
/**
 * Claude Code statusLine reporter for Fiche.
 * Prints a compact single-line summary of the latest turn + active session
 * from `~/.fiche/events.jsonl` (or legacy `~/.inkling/events.jsonl`) in <5ms.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTurnReportModule, resolveEventsFile, spawnFicheTurnReport } from './resolve-turn-report.mjs';

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

  const res = spawnFicheTurnReport(['turn-report', '--format=claude-statusline', '--file', eventsFile], SCRIPTS_DIR);
  if (res && typeof res.stdout === 'string' && res.stdout.trim()) {
    process.stdout.write(res.stdout.trim());
  }
}

main().catch(() => {
  // Never break status bar rendering on error.
});
