#!/usr/bin/env node
/**
 * Antigravity PostInvocation lifecycle hook for Fiche.
 * Reads events JSONL directly (<5ms) and injects a `metadata.user_markdown`
 * notice with `systemMessage: ""` so the user sees per-turn token/$ savings
 * inline while sending ZERO extra tokens to the LLM. Always fails open `{}`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTurnReportModule, resolveEventsFile, spawnFicheTurnReport } from './resolve-turn-report.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function failOpen() {
  process.stdout.write('{}');
}

function sanitizeConversationId(raw) {
  if (typeof raw !== 'string') return 'default';
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return clean || 'default';
}

async function runWithDistModule(eventsFile, cursorPath) {
  const mod = await loadTurnReportModule(SCRIPTS_DIR);
  if (!mod) return null;
  const payload = mod.readTurnReport(eventsFile, { cursorFile: cursorPath, updateCursor: true });
  return JSON.stringify(mod.formatAgyHookJson(payload));
}

function readStdinBounded(timeoutMs = 400) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onEnd);
      process.stdin.pause();
      process.stdin.unref?.();
      resolve(data);
    };
    const onData = (chunk) => {
      data += chunk;
      if (data.length > 65536) {
        finish();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    };
    const onEnd = () => finish();
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onEnd);
    process.stdin.resume();
  });
}

async function main() {
  const stdinText = await readStdinBounded(400);

  let conversationId = 'default';
  try {
    const input = JSON.parse(stdinText || '{}');
    conversationId = sanitizeConversationId(input?.conversationId);
  } catch {
    conversationId = 'default';
  }

  const eventsFile = resolveEventsFile();
  let cursorPath =
    process.env.FICHE_COMPANION_CURSOR?.trim() || process.env.FICHE_TELEMETRY_CURSOR?.trim();
  if (!cursorPath) {
    const dataDir =
      process.env.PLUGIN_DATA?.trim() || path.join(os.homedir(), '.fiche', 'cursors');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    cursorPath = path.join(dataDir, `cursor-${conversationId}.json`);
  } else {
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true, mode: 0o700 });
  }

  const fromDist = await runWithDistModule(eventsFile, cursorPath);
  if (fromDist !== null) {
    process.stdout.write(fromDist);
    return;
  }

  if (!fs.existsSync(eventsFile)) {
    failOpen();
    return;
  }

  const res = spawnFicheTurnReport(
    ['turn-report', '--format=agy', '--file', eventsFile, '--cursor', cursorPath],
    SCRIPTS_DIR,
  );
  if (res && typeof res.stdout === 'string' && res.stdout.trim().startsWith('{')) {
    process.stdout.write(res.stdout.trim());
    return;
  }
  failOpen();
}

main().catch(() => {
  failOpen();
});
