/**
 * `inkling warp -- <agent-command>`
 *
 * Runs the agent behind a CONNECT proxy that decrypts api.anthropic.com and
 * re-points only /v1/messages at the local inkling proxy. The agent never sees a
 * custom ANTHROPIC_BASE_URL, so the client-side "firstParty" checks that hide
 * /remote-control (and disable claude.ai connectors) still pass, while inkling
 * gets the one path it transforms.
 *
 * Compare the manual equivalent, which needs two extra tools and a CA trusted
 * process-wide:
 *
 *   mitmdump --map-remote '|^https://api\.anthropic\.com/v1/messages|http://127.0.0.1:47821/v1/messages'
 *   HTTPS_PROXY=http://127.0.0.1:8080 NODE_EXTRA_CA_CERTS=~/.mitmproxy/mitmproxy-ca-cert.pem claude
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { CertificateAuthority } from './ca.js';
import { buildWarpAppArgs, type ResolvedMacApp } from './app-launch.js';
import { createWarpHandlers } from './connect.js';
import { isRunnable } from './resolve.js';
import { parseRoute, routeDestination, type Route } from './route.js';
import { readBrandEnv } from '../core/env.js';
import {
  buildUpstreamRegistry,
  DEFAULT_UPSTREAM_REGISTRY,
  detectProvidersFromEnv,
  getEnabledProviders,
  parseUpstreamHosts,
  PROVIDER_CATALOG,
  type ProviderId,
} from '../core/upstream-hosts.js';

const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;
const CODEX_NON_SESSION_SUBCOMMANDS = new Set([
  'app-server',
  'remote-control',
  'completion',
  'update',
  'help',
  '--help',
  '-h',
  '--version',
  '-V',
]);

/**
 * Augment wrapped child argv when necessary so clients keep HTTP traffic inside
 * warp's session rather than delegating to an unwrapped background daemon.
 * For `codex` (>= 0.172), inject `-c features.daemon_auto_start=false` unless
 * running daemon-management/meta commands, already overridden, or disabled via
 * `FICHE_CODEX_KEEP_DAEMON=1`.
 */
export function augmentWrappedCommand(
  command: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (command.length === 0) return [];
  const bin = basename(command[0]!).toLowerCase();
  if (bin !== 'codex' && bin !== 'codex.exe') return [...command];
  if (/^(1|true|yes|on)$/i.test((env.FICHE_CODEX_KEEP_DAEMON ?? '').trim())) {
    return [...command];
  }
  const rest = command.slice(1);
  if (rest.some((arg) => arg.includes('daemon_auto_start'))) return [...command];
  if (rest.length > 0 && CODEX_NON_SESSION_SUBCOMMANDS.has(rest[0]!)) {
    return [...command];
  }
  return [command[0]!, '-c', 'features.daemon_auto_start=false', ...rest];
}

const WARP_TOKEN_RE = /^[0-9a-f]{64}$/i;

/**
 * Load or atomically generate the per-user 0600 loopback warp auth secret
 * (`~/.fiche/warp-token`) used to authenticate warped desktop apps to Fiche.
 */
export function loadOrCreateWarpToken(dir: string): string {
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!dirExisted) {
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dir, fsConstants.O_RDONLY);
      fchmodSync(dirFd, 0o700);
    } catch {
      /* best effort */
    } finally {
      if (dirFd !== undefined) {
        try { closeSync(dirFd); } catch { /* ignore */ }
      }
    }
  }
  const tokenPath = join(dir, 'warp-token');
  let readFd: number | undefined;
  try {
    readFd = openSync(tokenPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const st = fstatSync(readFd);
    if (st.isFile() && st.size > 0 && st.size <= 256) {
      const existing = readFileSync(readFd, 'utf8').trim();
      if (WARP_TOKEN_RE.test(existing)) {
        try {
          fchmodSync(readFd, 0o600);
        } catch {
          /* ignore */
        }
        return existing.toLowerCase();
      }
    }
  } catch {
    // Missing or invalid token — generate a fresh one below.
  } finally {
    if (readFd !== undefined) {
      try { closeSync(readFd); } catch { /* ignore */ }
    }
  }

  const token = randomBytes(32).toString('hex');
  const tmpPath = `${tokenPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let writeFd: number | undefined;
  try {
    writeFd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const buf = Buffer.from(`${token}\n`, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      const n = writeSync(writeFd, buf, offset, buf.length - offset);
      if (n <= 0) throw new Error('short write');
      offset += n;
    }
    fchmodSync(writeFd, 0o600);
    fsyncSync(writeFd);
    closeSync(writeFd);
    writeFd = undefined;
    renameSync(tmpPath, tokenPath);
    return token;
  } catch (err) {
    if (writeFd !== undefined) {
      try { closeSync(writeFd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Only strip `ANTHROPIC_BASE_URL` when it points to Fiche's own local loopback
 * proxy (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`). Remote 3rd-party
 * base URLs (DeepSeek, Kimi, GLM, MiniMax, Qwen, OpenRouter, custom gateways)
 * are preserved so warp routes them via `followHosts`.
 */
export function shouldStripAnthropicBaseUrl(
  rawUrl: string | undefined,
  fichePort: number,
): boolean {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
  const effectivePort = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  return effectivePort === fichePort;
}

export function mergeNoProxy(
  existing: string | undefined,
  excludeHosts?: ReadonlySet<string>,
): string {
  const excluded = new Set<string>();
  if (excludeHosts) {
    for (const h of excludeHosts) {
      const lower = h.trim().toLowerCase().replace(/^\[|\]$/g, '');
      if (lower) excluded.add(lower);
    }
  }
  const isExcluded = (entry: string): boolean => {
    const bare = entry.trim().toLowerCase().replace(/^\[|\]$/g, '');
    return excluded.has(bare);
  };
  const entries = (existing ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => Boolean(part) && !isExcluded(part));
  const seen = new Set(entries.map((part) => part.toLowerCase()));
  for (const host of LOOPBACK_NO_PROXY_HOSTS) {
    if (excluded.has(host)) continue;
    const alreadyCovered = host === '::1' ? seen.has('::1') || seen.has('[::1]') : seen.has(host);
    if (!alreadyCovered) {
      seen.add(host);
      entries.push(host);
    }
  }
  return entries.join(',');
}

export interface WarpRuntimeOptions {
  /** Port the inkling proxy is already serving on: where matches are sent. */
  port: number;
  /**
   * Extra PATTERN=TARGET rules, in priority order ahead of the default
   * Anthropic rule. Agents that reach their provider over a base URL rather
   * than api.anthropic.com (codex, opencode) need one rule each.
   */
  routes?: readonly string[];
  /** Explicit provider filter for this warp session; defaults to getEnabledProviders(). */
  providers?: readonly ProviderId[];
  /** Print every expanded warp route pattern on startup instead of the grouped summary. */
  verbose?: boolean;
  /** Optional resolved macOS desktop `.app` bundle launched via `fiche warp --app`. */
  app?: ResolvedMacApp;
}

export interface WarpRuntime {
  /** Bind the child's proxy port, then spawn the child. */
  launch: (command: string[]) => void;
}

/**
 * Only the inference path is diverted for enabled providers. Everything else on
 * the host — OAuth, telemetry, the control plane — is re-originated untouched,
 * which is what keeps the agent's client-side gates satisfied.
 */
export function defaultRoutes(
  port: number,
  enabledProviders: readonly ProviderId[] = getEnabledProviders(),
): Route[] {
  const enabled = new Set<string>(enabledProviders);
  const out: Route[] = [];
  if (enabled.has('anthropic')) {
    out.push(parseRoute(`api.anthropic.com/v1/messages*=http://127.0.0.1:${port}`));
  }
  if (enabled.has('openai')) {
    out.push(
      parseRoute(`api.openai.com/v1/responses*=http://127.0.0.1:${port}`),
      parseRoute(`api.openai.com/v1/chat/completions*=http://127.0.0.1:${port}`),
      parseRoute(`chatgpt.com/backend-api/codex/responses*=http://127.0.0.1:${port}`),
    );
  }
  if (enabled.has('google')) {
    out.push(
      parseRoute(`cloudcode-pa.googleapis.com/v1internal:streamGenerateContent*=http://127.0.0.1:${port}`),
      parseRoute(`cloudcode-pa.googleapis.com/v1internal:generateContent*=http://127.0.0.1:${port}`),
      parseRoute(`daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent*=http://127.0.0.1:${port}`),
      parseRoute(`daily-cloudcode-pa.googleapis.com/v1internal:generateContent*=http://127.0.0.1:${port}`),
      parseRoute(`generativelanguage.googleapis.com/v1beta/models/*:streamGenerateContent*=http://127.0.0.1:${port}`),
      parseRoute(`generativelanguage.googleapis.com/v1beta/models/*:generateContent*=http://127.0.0.1:${port}`),
      parseRoute(`generativelanguage.googleapis.com/v1/models/*:streamGenerateContent*=http://127.0.0.1:${port}`),
      parseRoute(`generativelanguage.googleapis.com/v1/models/*:generateContent*=http://127.0.0.1:${port}`),
      parseRoute(`generativelanguage.googleapis.com/v1beta/openai/chat/completions*=http://127.0.0.1:${port}`),
    );
  }
  out.push(...compatRoutes(port, enabledProviders));
  return out;
}

/** Inference endpoints, relative to a provider's API prefix. */
const COMPAT_INFERENCE_PATHS = ['/v1/messages', '/messages', '/v1/chat/completions', '/chat/completions', '/v1/responses', '/responses'];

/**
 * Third-party providers from the same registry fiche follows, so warp diverts
 * only opted-in built-in providers (or all when `enabledProviders` is omitted
 * for direct callers) plus explicit `FICHE_UPSTREAM_HOSTS` custom entries.
 */
export function compatRoutes(port: number, enabledProviders?: readonly ProviderId[]): Route[] {
  const registry = buildUpstreamRegistry(parseUpstreamHosts(readBrandEnv('UPSTREAM_HOSTS')));
  const enabled = enabledProviders === undefined ? null : new Set<string>(enabledProviders);
  const specs = new Set<string>();
  for (const entry of registry.values()) {
    if (entry.family !== 'compat') continue;
    if (enabled !== null && entry.provider !== undefined && !enabled.has(entry.provider)) continue;
    for (const prefix of entry.prefixes) {
      for (const tail of COMPAT_INFERENCE_PATHS) specs.add(`${entry.host}${prefix}${tail}*`);
    }
  }
  return [...specs].map((pattern) => parseRoute(`${pattern}=http://127.0.0.1:${port}`));
}

/**
 * Probe whether a local fiche daemon is accepting TCP connections on `127.0.0.1:port`.
 * Used by `fiche warp` so wrapped commands fall back to an unwrapped launch
 * whenever the daemon is intentionally stopped.
 */
export function isLocalDaemonReachable(port: number, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = netConnect({ host: '127.0.0.1', port });
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(reachable);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

export function createWarpRuntime(options: WarpRuntimeOptions): WarpRuntime {
  const { port } = options;
  const activeProviders = options.providers ?? getEnabledProviders();
  const explicitRoutes = (options.routes ?? []).map((spec) => parseRoute(spec));
  // Explicit rules first: an operator route for a specific host:port must win
  // over anything built in.
  let currentRoutes: Route[] = [
    ...explicitRoutes,
    ...defaultRoutes(port, activeProviders),
  ];
  const explicitLoopbackHosts = new Set<string>();
  for (const route of explicitRoutes) {
    const hostSpec = route.pattern.split('/', 1)[0]!.toLowerCase();
    const bare = hostSpec.startsWith('[')
      ? hostSpec.slice(1, hostSpec.indexOf(']') > 0 ? hostSpec.indexOf(']') : undefined)
      : (hostSpec.match(/:/g)?.length ?? 0) > 1
        ? hostSpec
        : hostSpec.split(':', 1)[0]!;
    if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') {
      explicitLoopbackHosts.add(bare);
    }
  }

  /** POSIX single-quote: safe for anything except a single quote itself. */
  const shellQuote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

  /**
   * Does the user's interactive shell consider this word an alias? Both zsh
   * ("cc is an alias for ...") and bash ("cc is aliased to ...") answer through
   * `type`, and only an interactive shell has sourced the rc file that defines
   * one. Costs a single shell start at launch.
   */
  const shellAliasTarget = (name: string, shell: string, env: NodeJS.ProcessEnv): string | null => {
    if (name.includes('/')) return null;
    const probe = spawnSync(shell, ['-ic', `type -- ${shellQuote(name)}`], {
      encoding: 'utf8',
      env,
      timeout: 1500,
    });
    const match = /\bis (?:an alias for|aliased to)\s+(.+)$/m.exec(probe.stdout ?? '');
    if (!match) return null;
    // bash wraps the expansion in `backtick quote'; zsh leaves it bare.
    return match[1]!.trim().replace(/^`/, '').replace(/'$/, '');
  };

  /**
   * Run the child, falling back to the user's interactive shell when the
   * command is not an executable on PATH.
   *
   * spawn() is execvp, which only knows files. An alias like `cc` exists solely
   * inside an interactive zsh, and `sh -c` will not find it either: aliases come
   * from ~/.zshrc, which only an *interactive* shell sources. So the fallback is
   * `$SHELL -ic`, which loads the rc file and expands the alias — including any
   * env assignments baked into it, which no PATH lookup could have carried.
   *
   * Direct spawn stays the fast path: the shell is only involved when execvp
   * would have failed outright.
   */
  const spawnResolved = (command: string[], env: NodeJS.ProcessEnv): ChildProcess => {
    const direct = { stdio: 'inherit', env } as const;
    const shell = env.SHELL || '/bin/sh';
    const cmd0 = command[0]!;
    // Only plain command words are valid interactive-shell alias names; anything
    // with spaces, paths, or shell metacharacters must never hit unquoted `shell -ic`.
    const safeAliasWord = /^[A-Za-z0-9._+-]+$/.test(cmd0);
    // Native Windows has no /bin/sh, and Git Bash's SHELL=/usr/bin/bash is not
    // a path Node can spawn. Without a usable shell there are no aliases to
    // consult and no fallback to take.
    const shellUsable = isRunnable(shell, env);
    // An alias can shadow a real binary: `cc` is Apple clang on PATH and a
    // Claude Code alias in the user's zsh, so PATH alone would silently run
    // the wrong program. Ask the interactive shell what the word means first.
    const alias = shellUsable && safeAliasWord ? shellAliasTarget(cmd0, shell, env) : null;
    // But a stale alias must not shadow a working binary either. An alias
    // pointing at an uninstalled path (`claude` -> /opt/homebrew/bin/claude
    // after a move to a node-managed install) would otherwise fail the launch
    // outright, with a real claude sitting on PATH. An env-assignment prefix
    // (`FOO=1 claude`) is unverifiable, so it is taken at its word.
    const aliasWord = alias?.split(/\s+/)[0] ?? '';
    const aliasUsable = alias !== null && (aliasWord.includes('=') || isRunnable(aliasWord, env));
    if (alias !== null && !aliasUsable) {
      console.error(`[fiche] warp: ignoring stale alias ${cmd0} → ${aliasWord} (not executable)`);
    }
    if (!aliasUsable && isRunnable(cmd0, env)) {
      return spawn(cmd0, command.slice(1), direct);
    }
    if (!shellUsable || !safeAliasWord) {
      // Let spawn() report the real ENOENT for the command itself rather
      // than a misleading one for a shell that was never there or unsafe word.
      return spawn(cmd0, command.slice(1), direct);
    }
    console.error(`[fiche] warp: resolving ${cmd0} via interactive shell fallback`);
    // The command word is deliberately left unquoted: a shell only expands
    // aliases on unquoted words, so quoting it would defeat the entire point of
    // this fallback. Arguments are still quoted — they are data, never aliases.
    const script = `unset -f ${shellQuote(cmd0)} 2>/dev/null || true; ${[cmd0, ...command.slice(1).map(shellQuote)].join(' ')}`;
    return spawn(shell, ['-ic', script], direct);
  };

  const wireChildLifecycle = (
    child: ChildProcess,
    binLabel: string,
    onExitCleanup?: () => void,
    appLaunchedAt?: number,
  ): void => {
    let childLive = true;
    child.on('exit', () => {
      childLive = false;
      onExitCleanup?.();
    });
    process.on('exit', () => {
      if (childLive) child.kill('SIGTERM');
    });
    child.on('error', (err) => {
      onExitCleanup?.();
      console.error(`[fiche] warp: cannot run ${binLabel}: ${err.message}`);
      process.exit(127);
    });
    // SIGHUP and SIGQUIT matter as much as the interactive two: closing the
    // terminal sends SIGHUP, and without forwarding it the agent survives with
    // its proxy pointed at a port that is about to close.
    const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
    child.on('exit', (code, signal) => {
      if (options.app && appLaunchedAt !== undefined && code === 0 && !signal && Date.now() - appLaunchedAt < 2500) {
        console.error(
          `[fiche] warp: warning: ${options.app.appName} exited immediately (code 0) — an unwrapped instance is likely already running and handed off to it. Quit ${options.app.appName} completely before launching via \`fiche warp --app ${options.app.appName}\`.`,
        );
      }
      // Reproduce the child's own exit status so warp is transparent to callers.
      // Re-raising means routing the signal back through our own handlers, so
      // drop them first: Ctrl-C kills the child with SIGINT, and without this
      // the re-raise just re-enters the forwarder, kills an already-dead child
      // and leaves warp running forever.
      if (signal) {
        for (const s of forwarded) process.removeAllListeners(s);
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    for (const signal of forwarded) {
      process.on(signal, () => child.kill(signal));
    }
  };

  const startWrappedLaunch = (command: string[]): void => {
    const caDir = join(homedir(), '.fiche');
    const legacyCaDir = join(homedir(), '.inkling');
    // Reuse legacy ~/.inkling CA dir if ~/.fiche doesn't exist yet so installed trust certs keep working.
    const resolvedCaDir = existsSync(caDir) || !existsSync(legacyCaDir) ? caDir : legacyCaDir;
    const ca = CertificateAuthority.loadOrCreate(resolvedCaDir);
    const warpAuthToken = loadOrCreateWarpToken(resolvedCaDir);

    let lastProvidersKey = activeProviders.join(',');
    let providersPollTimer: ReturnType<typeof setInterval> | undefined;
    if (options.providers === undefined) {
      providersPollTimer = setInterval(() => {
        const req = httpGet(
          { host: '127.0.0.1', port, path: '/api/providers', agent: false, timeout: 500 },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { enabled?: unknown };
                if (!Array.isArray(parsed.enabled)) return;
                const next = parsed.enabled.filter((p): p is ProviderId => typeof p === 'string');
                const key = next.join(',');
                if (key !== lastProvidersKey) {
                  lastProvidersKey = key;
                  currentRoutes = [...explicitRoutes, ...defaultRoutes(port, next)];
                }
              } catch {
                // Ignore transient poll errors
              }
            });
          },
        );
        req.on('error', () => {});
        req.on('timeout', () => req.destroy());
      }, 2000);
      providersPollTimer.unref();
    }

    let proxy!: ReturnType<typeof createServer>;
    const handlers = createWarpHandlers({
      routes: () => currentRoutes,
      ca,
      failOpenOnDivertRefused: true,
      warpAuthToken,
      selfPort: () => {
        const addr = proxy?.address();
        return typeof addr === 'object' && addr ? addr.port : undefined;
      },
      // The child inherits this terminal and Claude Code draws a full-screen TUI
      // over it, so anything written after the child starts corrupts the display.
      // Keep the line when stdout is redirected (piping, CI, debugging); stay
      // silent when a human is looking at the agent. events.jsonl records the
      // request either way.
      onDivert: (host, path, target) => {
        if (!process.stdout.isTTY) console.error(`[fiche] warp: ${host}${path} → ${target}`);
      },
    });

    // warp's own listener, and the only reason a port is involved at all: the
    // child is configured through HTTPS_PROXY, which can only name a host:port.
    // The kernel picks it, nothing else needs to know it, so there is nothing to
    // collide with a inkling already running.
    proxy = createServer(handlers.handleAbsoluteForm);
    proxy.requestTimeout = 0;
    proxy.on('connection', (socket) => socket.setNoDelay(true));
    proxy.on('connect', handlers.handleConnect);
    proxy.on('upgrade', handlers.handleUpgrade);
    proxy.once('close', () => handlers.destroy?.());

    const spawnChild = (cmd: string[], proxyUrl: string): void => {
      const env = { ...process.env };
      // Only strip ANTHROPIC_BASE_URL when it targets Fiche's own loopback port;
      // preserve remote 3rd-party base URLs (DeepSeek, Kimi, GLM, OpenRouter, etc.).
      if (shouldStripAnthropicBaseUrl(env.ANTHROPIC_BASE_URL, port)) {
        delete env.ANTHROPIC_BASE_URL;
        delete env.ANTHROPIC_UNIX_SOCKET;
      } else if (!env.ANTHROPIC_BASE_URL?.trim()) {
        delete env.ANTHROPIC_UNIX_SOCKET;
      }
      env.HTTP_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.https_proxy = proxyUrl;
      const rawNoProxy = [env.NO_PROXY, env.no_proxy].filter(Boolean).join(',');
      const mergedNoProxy = mergeNoProxy(rawNoProxy || undefined, explicitLoopbackHosts);
      env.NO_PROXY = mergedNoProxy;
      env.no_proxy = mergedNoProxy;
      // Trust is scoped to this child; nothing is added to the system keychain.
      // Which variable actually works depends on the agent's runtime, and the
      // answer is not stable: the macOS `claude` is a native Mach-O binary, not a
      // Node script, so the Node-only variable alone would silently fail to make
      // it trust us. Set every convention — they are inert for runtimes that
      // ignore them, and one of them is the one that counts.
      // NODE_EXTRA_CA_CERTS appends to Node's built-in roots, so the CA-only
      // file is right there. The other three REPLACE the trust store: handing
      // them a 1-cert file strips the public roots from every other HTTPS client
      // in the session (gcloud, gws, pip all fail verification — #245). They get
      // the bundle: our CA followed by the system roots.
      env.NODE_EXTRA_CA_CERTS = ca.bundlePath; // Node, and Bun-compiled binaries
      env.SSL_CERT_FILE = ca.bundlePath; // OpenSSL: curl, Rust, Go with cgo
      env.CURL_CA_BUNDLE = ca.bundlePath; // libcurl
      env.REQUESTS_CA_BUNDLE = ca.bundlePath; // Python requests / httpx
      // Signal active warp session without setting FICHE_BYPASS=1, so integrated
      // terminals inside warped desktop IDEs stay active and codex still disables daemon_auto_start.
      env.FICHE_WARP_ACTIVE = '1';

      const bypassList = ['localhost', '127.0.0.1', '[::1]']
        .filter((h) => !explicitLoopbackHosts.has(h === '[::1]' ? '::1' : h))
        .join(';');
      const execArgv = options.app
        ? buildWarpAppArgs(options.app, proxyUrl, cmd, {
            spkiPins: ca.spkiPins,
            ...(bypassList ? { proxyBypassList: bypassList } : {}),
          })
        : augmentWrappedCommand(cmd, env);
      const launchedAt = options.app ? Date.now() : undefined;
      const child = spawnResolved(execArgv, env);
      wireChildLifecycle(
        child,
        execArgv[0]!,
        () => {
          if (providersPollTimer) {
            clearInterval(providersPollTimer);
            providersPollTimer = undefined;
          }
          try { proxy.close(); } catch { /* ignore */ }
          handlers.destroy?.();
        },
        launchedAt,
      );
      // A connection dying is not a warp failure. The upstream resets, the proxy
      // gets restarted, a keep-alive socket goes away between requests — all of
      // that arrives here as an errno on a socket nobody was listening to at that
      // instant. Exiting on it would take the agent down with us (see the exit
      // handler above) and lose a whole run to one dropped TCP connection. Log
      // and keep serving; the request that owned the socket fails on its own and
      // the agent retries. Anything without an errno is a real bug in our code,
      // and staying up for that would leave the agent talking to a proxy in an
      // unknown state, so those still exit.
      const NET_ERRNO = new Set([
        'ECONNRESET',
        'ECONNREFUSED',
        'ECONNABORTED',
        'EPIPE',
        'ETIMEDOUT',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'ENETDOWN',
        'ENOTCONN',
        'EAI_AGAIN',
        'ERR_STREAM_DESTROYED',
        'ERR_STREAM_WRITE_AFTER_END',
        'ERR_SOCKET_CONNECTION_TIMEOUT',
      ]);
      const isBenignNetError = (err: unknown): boolean => {
        if (err instanceof AggregateError) {
          return err.errors.length > 0 && err.errors.every((inner) => isBenignNetError(inner));
        }
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        return typeof code === 'string' && NET_ERRNO.has(code);
      };
      const die = (err: unknown): void => {
        if (isBenignNetError(err)) {
          const code = err instanceof AggregateError
            ? err.errors.map((e) => (e as NodeJS.ErrnoException)?.code ?? 'ERR').join(',')
            : (err as NodeJS.ErrnoException).code;
          console.error(`[fiche] warp: connection error ${code} (continuing)`);
          return;
        }
        console.error(`[fiche] warp: ${err instanceof Error ? err.stack : String(err)}`);
        process.exit(1);
      };
      process.on('uncaughtException', die);
      process.on('unhandledRejection', die);
    };

    // Startup banner goes to stderr: stdout belongs to the child, so a caller
    // piping the agent's output gets the agent's bytes and nothing of ours.
    const verboseBanner = Boolean(options.verbose)
      || /^(?:1|true|yes|on)$/i.test((readBrandEnv('WARP_VERBOSE') ?? '').trim());
    if (verboseBanner) {
      for (const route of currentRoutes) {
        console.error(`[fiche] warp route → ${route.pattern} → ${routeDestination(route)}`);
      }
    } else {
      const counts = new Map<string, number>();
      let customCount = explicitRoutes.length;
      for (const route of currentRoutes.slice(explicitRoutes.length)) {
        const routeHost = route.pattern.split('/', 1)[0]!.split(':', 1)[0]!.toLowerCase();
        const provider = DEFAULT_UPSTREAM_REGISTRY.get(routeHost)?.provider;
        if (provider) counts.set(provider, (counts.get(provider) ?? 0) + 1);
        else customCount += 1;
      }
      const parts = activeProviders
        .filter((id) => (counts.get(id) ?? 0) > 0)
        .map((id) => `${id} (${counts.get(id)})`);
      if (customCount > 0) parts.push(`custom (${customCount})`);
      const summary = parts.length > 0 ? parts.join(', ') : 'none (direct passthrough)';
      console.error(`[fiche] warp providers → ${summary} → http://127.0.0.1:${port}`);
    }
    console.error(`[fiche] warp CA → ${ca.certPath}`);
    if (ca.systemRootsPath) {
      console.error(`[fiche] warp CA bundle → ${ca.bundlePath} (+ system roots from ${ca.systemRootsPath})`);
    } else {
      console.error(
        `[fiche] warp CA bundle → ${ca.bundlePath} (no system root bundle found; ` +
          `non-fiche HTTPS in the child may fail verification — set SSL_CERT_FILE to your OS bundle before warp)`,
      );
    }
    if (options.app) {
      const modeLabel = options.app.isElectron
        ? 'Electron (--proxy-server + CA env)'
        : 'native bundle (CA/proxy env — custom base URL still recommended if TLS-pinned)';
      console.error(`[fiche] warp app → ${options.app.appName} [${modeLabel}] → ${options.app.appPath}`);
    } else {
      console.error(`[fiche] warp exec → ${augmentWrappedCommand(command).join(' ')}`);
    }
    if (verboseBanner || Boolean(process.stderr.isTTY)) {
      const activeSet = new Set<ProviderId>(activeProviders);
      const thirdPartyIds = new Set(
        PROVIDER_CATALOG.filter((p) => p.tier === 'third-party').map((p) => p.id),
      );
      const missingThirdParty = detectProvidersFromEnv(process.env).filter(
        (hit) => thirdPartyIds.has(hit.id) && !activeSet.has(hit.id),
      );
      if (missingThirdParty.length > 0) {
        const list = missingThirdParty.map((hit) => `${hit.id} (${hit.matchedEnvKey})`).join(', ');
        console.error(
          `[fiche] warp hint: detected disabled 3rd-party provider key(s): ${list} — run \`fiche providers enable <id>\` or pass \`--all-providers\` to intercept`,
        );
      }
    }

    proxy.on('error', (err) => {
      console.error(`[fiche] warp: proxy listener failed: ${err.message}`);
      process.exit(1);
    });
    proxy.listen(0, '127.0.0.1', () => {
      const address = proxy.address();
      const proxyUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      console.error(`[fiche] warp proxy → ${proxyUrl} (child only)`);
      spawnChild(command, proxyUrl);
    });
  };

  const launch = (command: string[]): void => {
    if (!options.app && command.length === 0) {
      console.error('[fiche] warp: nothing to run — usage: fiche warp -- <command> [args...]');
      process.exit(2);
    }
    void (async () => {
      if (explicitRoutes.length === 0 && !(await isLocalDaemonReachable(port))) {
        const targetLabel = options.app ? options.app.appName : command.join(' ');
        console.error(
          `[fiche] daemon on 127.0.0.1:${port} is not running — launching ${targetLabel} directly (unwrapped)`,
        );
        const directEnv: NodeJS.ProcessEnv = { ...process.env };
        const directCmd = options.app ? [options.app.executablePath, ...command] : command;
        const launchedAt = options.app ? Date.now() : undefined;
        const child = spawnResolved(directCmd, directEnv);
        wireChildLifecycle(child, directCmd[0]!, undefined, launchedAt);
        return;
      }
      startWrappedLaunch(command);
    })().catch((err) => {
      console.error(`[fiche] warp: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    });
  };

  return { launch };
}
