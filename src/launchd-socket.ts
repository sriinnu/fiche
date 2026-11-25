import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** First file descriptor assigned by systemd / launchd-exec socket activation. */
export const SD_LISTEN_FDS_START = 3;

export const LAUNCHD_SOCKET_EXEC_C = `#include <errno.h>
#include <fcntl.h>
#include <launch.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "fiche-launchd-exec: expected target binary argument\\n");
    return 64;
  }

  int *fds = NULL;
  size_t cnt = 0;
  int rc = launch_activate_socket("Listeners", &fds, &cnt);
  if (rc == 0 && cnt > 0 && fds != NULL) {
    int primary = fds[0];
    if (primary != ${SD_LISTEN_FDS_START}) {
      if (dup2(primary, ${SD_LISTEN_FDS_START}) < 0) {
        perror("fiche-launchd-exec: dup2");
        for (size_t i = 0; i < cnt; i++) {
          if (fds[i] >= 0) close(fds[i]);
        }
        free(fds);
        return 1;
      }
    }
    for (size_t i = 0; i < cnt; i++) {
      if (fds[i] >= 0 && fds[i] != ${SD_LISTEN_FDS_START}) {
        close(fds[i]);
      }
    }
    free(fds);

    int flags = fcntl(${SD_LISTEN_FDS_START}, F_GETFD);
    if (flags < 0 || fcntl(${SD_LISTEN_FDS_START}, F_SETFD, flags & ~FD_CLOEXEC) < 0) {
      perror("fiche-launchd-exec: fcntl");
      return 1;
    }

    char pidbuf[32];
    snprintf(pidbuf, sizeof(pidbuf), "%ld", (long)getpid());
    if (setenv("LISTEN_FDS", "1", 1) != 0 || setenv("LISTEN_PID", pidbuf, 1) != 0) {
      perror("fiche-launchd-exec: setenv");
      return 1;
    }
  } else {
    if (fds != NULL) {
      for (size_t i = 0; i < cnt; i++) {
        if (fds[i] >= 0) close(fds[i]);
      }
      free(fds);
    }
    unsetenv("LISTEN_FDS");
    unsetenv("LISTEN_PID");
    if (rc != 0 && rc != ENOENT && rc != ESRCH) {
      fprintf(stderr, "fiche-launchd-exec: launch_activate_socket: %s\\n", strerror(rc));
    }
  }

  execv(argv[1], &argv[1]);
  perror("fiche-launchd-exec: execv");
  return 127;
}
`;

/**
 * Parse systemd / fiche-launchd-exec socket activation environment variables.
 * Returns the primary listening fd (always 3) only when LISTEN_PID matches
 * `pid` and LISTEN_FDS >= 1.
 */
export function resolveInheritedListenFd(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): number | null {
  const rawPid = env.LISTEN_PID?.trim() ?? '';
  const rawFds = env.LISTEN_FDS?.trim() ?? '';
  if (!/^\d+$/.test(rawPid) || !/^\d+$/.test(rawFds)) {
    return null;
  }
  const listenPid = Number(rawPid);
  const listenFds = Number(rawFds);
  if (!Number.isSafeInteger(listenPid) || listenPid !== pid) {
    return null;
  }
  if (!Number.isSafeInteger(listenFds) || listenFds < 1) {
    return null;
  }
  return SD_LISTEN_FDS_START;
}

export interface LaunchdShimResult {
  supported: boolean;
  shimPath: string | null;
  rebuilt: boolean;
  reason?: string;
}

const MACOS_CC = '/usr/bin/cc';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup failures
  }
}

/**
 * Compile (if missing or stale) the tiny macOS <launch.h> exec trampoline that
 * acquires launchd's listening socket via launch_activate_socket("Listeners")
 * and execv()s Node with LISTEN_FDS=1 / LISTEN_PID=<pid>.
 */
export function ensureLaunchdSocketShim(
  ficheDir: string,
  dryRun = false,
): LaunchdShimResult {
  if (process.platform !== 'darwin') {
    return { supported: false, shimPath: null, rebuilt: false, reason: 'non-darwin' };
  }
  const ccExists = fs.existsSync(MACOS_CC);
  const binDir = path.join(ficheDir, 'bin');
  const shimPath = path.join(binDir, 'fiche-launchd-exec');
  const stampPath = path.join(binDir, 'fiche-launchd-exec.sha256');
  const expectedHash = sha256Hex(LAUNCHD_SOCKET_EXEC_C);

  let cachedValid = false;
  if (fs.existsSync(shimPath) && fs.existsSync(stampPath)) {
    try {
      const currentHash = fs.readFileSync(stampPath, 'utf8').trim();
      cachedValid = currentHash === expectedHash;
    } catch {
      cachedValid = false;
    }
  }

  if (cachedValid) {
    return { supported: true, shimPath, rebuilt: false };
  }
  if (!ccExists) {
    return {
      supported: false,
      shimPath: null,
      rebuilt: false,
      reason: `missing ${MACOS_CC}`,
    };
  }
  if (dryRun) {
    return { supported: true, shimPath, rebuilt: true };
  }

  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${Date.now()}`;
  const srcTmp = path.join(binDir, `fiche-launchd-exec.${suffix}.c`);
  const binTmp = path.join(binDir, `fiche-launchd-exec.${suffix}.bin`);
  const stampTmp = path.join(binDir, `fiche-launchd-exec.${suffix}.sha256`);

  try {
    fs.writeFileSync(srcTmp, LAUNCHD_SOCKET_EXEC_C, { mode: 0o600 });
    execFileSync(
      MACOS_CC,
      ['-O2', '-Wall', '-Wextra', '-Werror', '-x', 'c', srcTmp, '-o', binTmp],
      { stdio: 'pipe' },
    );
    fs.chmodSync(binTmp, 0o755);
    fs.renameSync(binTmp, shimPath);
    fs.writeFileSync(stampTmp, `${expectedHash}\n`, { mode: 0o600 });
    fs.renameSync(stampTmp, stampPath);
    return { supported: true, shimPath, rebuilt: true };
  } catch (err) {
    safeUnlink(binTmp);
    safeUnlink(stampTmp);
    const detail = err instanceof Error ? err.message : String(err);
    return {
      supported: false,
      shimPath: null,
      rebuilt: false,
      reason: `compile failed: ${detail}`,
    };
  } finally {
    safeUnlink(srcTmp);
  }
}
