/**
 * Node persistence adapter for Context-MMU (`MmuPersistenceAdapter`).
 *
 * Uses atomic write-then-rename with restrictive file modes (`0o600` file,
 * `0o700` newly-created directory) and strict fail-open semantics (never throws).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MmuPersistenceAdapter } from './core/context-mmu.js';

const warnedUnsafeMmuDirs = new Set<string>();

export type MmuCliParseResult =
  | { readonly ok: true; readonly help: true }
  | {
      readonly ok: true;
      readonly help: false;
      readonly sub: 'stats' | 'pages' | 'page';
      readonly asJson: boolean;
      readonly port: number;
      readonly query?: string;
      readonly pageId?: string;
      readonly sessionKey?: string;
    }
  | { readonly ok: false; readonly exitCode: 2; readonly error: string };

export const MMU_CLI_USAGE =
  'Usage: fiche mmu [stats | pages | page <pageId>] [--query <text>] [--session <key>] [--port <P>] [--json]';

export function parseMmuCliArgs(argv: readonly string[], envPort?: string): MmuCliParseResult {
  for (const a of argv) {
    if (a === '-h' || a === '--help') return { ok: true, help: true };
  }

  let sub: 'stats' | 'pages' | 'page' = 'stats';
  let idx = 0;
  if (argv[0] && !argv[0].startsWith('-')) {
    if (argv[0] === 'stats' || argv[0] === 'pages' || argv[0] === 'page') {
      sub = argv[0];
      idx = 1;
    } else {
      return {
        ok: false,
        exitCode: 2,
        error: `[fiche] unknown mmu subcommand: ${argv[0]}\n${MMU_CLI_USAGE}`,
      };
    }
  }

  const parsedEnvPort = envPort !== undefined && envPort.trim() !== '' ? Number(envPort) : NaN;
  let port = Number.isSafeInteger(parsedEnvPort) && parsedEnvPort > 0 && parsedEnvPort <= 65535
    ? parsedEnvPort
    : 47821;
  let asJson = false;
  let query: string | undefined;
  let pageId: string | undefined;
  let sessionKey: string | undefined;

  const parsePortVal = (raw: string): number | null => {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };

  for (let i = idx; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') {
      asJson = true;
    } else if (a === '--port' || a.startsWith('--port=')) {
      const val = a.startsWith('--port=') ? a.slice('--port='.length) : argv[++i];
      if (!val) return { ok: false, exitCode: 2, error: `[fiche] --port requires a value (1..65535)` };
      const p = parsePortVal(val);
      if (p === null) return { ok: false, exitCode: 2, error: `[fiche] invalid --port: ${val}` };
      port = p;
    } else if (a === '--query' || a.startsWith('--query=')) {
      const val = a.startsWith('--query=') ? a.slice('--query='.length) : argv[++i];
      if (!val || !val.trim()) return { ok: false, exitCode: 2, error: `[fiche] --query requires a non-empty value` };
      query = val.trim();
    } else if (a === '--session' || a.startsWith('--session=') || a === '--session-key' || a.startsWith('--session-key=')) {
      const eq = a.indexOf('=');
      const val = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (!val || !val.trim()) return { ok: false, exitCode: 2, error: `[fiche] --session requires a non-empty value` };
      sessionKey = val.trim();
    } else if (a.startsWith('-')) {
      return { ok: false, exitCode: 2, error: `[fiche] unknown mmu flag: ${a}\n${MMU_CLI_USAGE}` };
    } else if (sub === 'page' && !pageId) {
      pageId = a;
    } else {
      return { ok: false, exitCode: 2, error: `[fiche] unexpected argument: ${a}\n${MMU_CLI_USAGE}` };
    }
  }

  if (sub === 'page' && !pageId && !query) {
    return {
      ok: false,
      exitCode: 2,
      error: `[fiche] mmu page requires <pageId> or --query <text>\n${MMU_CLI_USAGE}`,
    };
  }
  return { ok: true, help: false, sub, asJson, port, query, pageId, sessionKey };
}

const DEFAULT_MAX_MMU_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MMU_FILE_BYTES_CAP = 512 * 1024 * 1024;

export interface FileMmuPersistenceOptions {
  readonly maxFileBytes?: number;
}

export function fileMmuPersistenceStore(
  filePath: string,
  opts: FileMmuPersistenceOptions = {},
): MmuPersistenceAdapter {
  const maxFileBytes =
    opts.maxFileBytes !== undefined && Number.isFinite(opts.maxFileBytes) && opts.maxFileBytes > 0
      ? Math.min(MAX_MMU_FILE_BYTES_CAP, Math.max(1024 * 1024, Math.floor(opts.maxFileBytes)))
      : DEFAULT_MAX_MMU_FILE_BYTES;
  return {
    load(): string | undefined {
      if (!filePath || typeof filePath !== 'string') return undefined;
      let fd: number | undefined;
      try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > maxFileBytes) return undefined;
        return fs.readFileSync(fd, 'utf8');
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore fd close errors (fail-open).
          }
        }
      }
    },
    save(json: string): void {
      if (!filePath || typeof filePath !== 'string') return;
      let tmpPath: string | undefined;
      let fd: number | undefined;
      try {
        const dir = path.dirname(filePath);
        const parentExists = fs.existsSync(dir);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (!parentExists) {
          fs.chmodSync(dir, 0o700);
        } else {
          const st = fs.lstatSync(dir);
          if (!st.isDirectory() || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)) {
            const resolvedDir = path.resolve(dir);
            if (!warnedUnsafeMmuDirs.has(resolvedDir)) {
              warnedUnsafeMmuDirs.add(resolvedDir);
              console.error(
                `[fiche] error: refusing to persist MMU pages to ${filePath}; directory ${dir} has unsafe mode ${(st.mode & 0o777).toString(8)} (expected 700)`,
              );
            }
            return;
          }
        }
        tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        fd = fs.openSync(
          tmpPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        const buf = Buffer.from(json, 'utf8');
        let offset = 0;
        while (offset < buf.length) {
          const written = fs.writeSync(fd, buf, offset, buf.length - offset);
          if (written <= 0) throw new Error('short write');
          offset += written;
        }
        fs.fchmodSync(fd, 0o600);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmpPath, filePath);
        tmpPath = undefined;
      } catch {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore fd close errors (fail-open).
          }
        }
        if (tmpPath) {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            // Ignore temp cleanup failures (fail-open).
          }
        }
      }
    },
  };
}
