import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tracker, TrackEvent } from './core/tracker.js';
import {
  registerEventsFileCoordinator,
  type EventsFileCoordinator,
} from './sessions.js';

/**
 * Append-only JSONL tracker with size-based rotation and prune coordination.
 * One line per request.
 *
 * Rotation: when the current file exceeds MAX_FILE_BYTES (100 MB by default),
 * it's renamed to `<path>.1` (overwriting any previous .1) and a fresh file
 * is opened.
 *
 * Failures here NEVER propagate — the proxy must keep serving requests even
 * if the disk is full or the path is unwritable.
 */
export class FileTracker implements Tracker, EventsFileCoordinator {
  private fd: number | null = null;
  private fdIno: number | null = null;
  private fdDev: number | null = null;
  private bytesWritten = 0;
  private brokenLogged = false;
  private rewriting = false;
  private closed = false;
  private pendingDuringRewrite: string[] = [];
  private readonly unregisterCoordinator: () => void;
  private static readonly MAX_FILE_BYTES = 100 * 1024 * 1024;

  constructor(private readonly filePath: string) {
    this.unregisterCoordinator = registerEventsFileCoordinator(this.filePath, this);
  }

  private closeFd(): void {
    if (this.fd != null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
      this.fdIno = null;
      this.fdDev = null;
      this.bytesWritten = 0;
    }
  }

  private ensureOpen(): boolean {
    if (this.fd != null) {
      let needsReopen = false;
      try {
        const st = fs.statSync(this.filePath);
        if (this.fdIno !== null && (st.ino !== this.fdIno || st.dev !== this.fdDev)) {
          needsReopen = true;
        }
      } catch {
        // File unlinked or rotated externally — reopen the fresh path.
        needsReopen = true;
      }
      if (!needsReopen) return true;
      this.closeFd();
    }
    try {
      const parent = path.dirname(this.filePath);
      const parentExists = fs.existsSync(parent);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (!parentExists) fs.chmodSync(parent, 0o700);
    } catch {
      /* dir may already exist or be unmkable; openSync below will surface */
    }
    try {
      this.fd = fs.openSync(this.filePath, 'a', 0o600);
      const fst = fs.fstatSync(this.fd);
      this.fdIno = fst.ino;
      this.fdDev = fst.dev;
      this.bytesWritten = fst.size;
      fs.chmodSync(this.filePath, 0o600);
      return true;
    } catch (err) {
      if (!this.brokenLogged) {
        // eslint-disable-next-line no-console -- FileTracker error logging
        console.error(
          `[fiche] FileTracker disabled — cannot open ${this.filePath}: ${(err as Error).message}`,
        );
        this.brokenLogged = true;
      }
      return false;
    }
  }

  private rotate(): void {
    this.closeFd();
    try {
      fs.renameSync(this.filePath, this.filePath + '.1');
    } catch {
      /* if rename fails (e.g. .1 locked) we'll just keep growing — better
         than dropping events */
    }
    this.bytesWritten = 0;
  }

  private writeSerializedLine(line: string): void {
    if (!this.ensureOpen()) return;
    try {
      const buf = Buffer.from(line, 'utf8');
      fs.writeSync(this.fd!, buf);
      this.bytesWritten += buf.length;
      if (this.bytesWritten > FileTracker.MAX_FILE_BYTES) this.rotate();
    } catch (err) {
      if (!this.brokenLogged) {
        console.error(
          `[fiche] FileTracker write failed: ${(err as Error).message}`,
        );
        this.brokenLogged = true;
      }
    }
  }

  emit(ev: TrackEvent): void {
    if (this.closed) return;
    let line: string;
    try {
      line = JSON.stringify(ev) + '\n';
    } catch {
      return;
    }
    if (this.rewriting) {
      this.pendingDuringRewrite.push(line);
      return;
    }
    this.writeSerializedLine(line);
  }

  async runDuringRewrite<T>(
    fn: (flushPending: (outFd: number, writeLine?: (outFd: number, line: string) => void) => void) => Promise<T>,
  ): Promise<T> {
    this.rewriting = true;
    this.flush();
    let flushedCount = 0;
    try {
      const result = await fn((outFd, writeLine) => {
        if (this.pendingDuringRewrite.length <= flushedCount) return;
        const batch = this.pendingDuringRewrite.slice(flushedCount);
        flushedCount += batch.length;
        for (const line of batch) {
          if (writeLine) writeLine(outFd, line);
          else fs.writeSync(outFd, line);
        }
      });
      if (flushedCount > 0) {
        this.pendingDuringRewrite.splice(0, flushedCount);
      }
      return result;
    } finally {
      this.closeFd();
      this.rewriting = false;
      if (this.pendingDuringRewrite.length > 0 && !this.closed) {
        const remaining = this.pendingDuringRewrite.splice(0, this.pendingDuringRewrite.length);
        for (const line of remaining) {
          this.writeSerializedLine(line);
        }
      }
      if (this.closed) {
        this.pendingDuringRewrite.length = 0;
        this.closeFd();
      }
    }
  }

  flush(): void {
    if (this.fd != null) {
      try {
        fs.fsyncSync(this.fd);
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    this.closed = true;
    this.unregisterCoordinator();
    if (this.fd != null) {
      try {
        fs.fsyncSync(this.fd);
      } catch {
        /* ignore */
      }
      this.closeFd();
    }
  }
}
