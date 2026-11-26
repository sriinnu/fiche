import { DEFAULT_UPSTREAM_REGISTRY } from './upstream-hosts.js';
/**
 * Who may talk to the local proxy API.
 *
 * The proxy forwards with the host's configured keys, so a web page that can
 * reach 127.0.0.1 must not be able to spend them. Two browser-only attacks:
 *
 *  - Cross-site request: a page on evil.example POSTs to 127.0.0.1:47821. The
 *    browser sends `Origin: https://evil.example`.
 *  - DNS rebinding: evil.example re-resolves to 127.0.0.1, so the page is
 *    "same-origin" and can read responses. The request carries
 *    `Host: evil.example:47821`.
 *
 * Agents (Claude Code, Codex, curl) send no Origin, and a Host that is loopback,
 * an IP literal, a container name, or the real provider host when `inkling warp`
 * diverts traffic (warp keeps the agent's original Host on purpose).
 *
 * So the rule rejects only what an attacker can actually produce: a dotted
 * public DNS name that is not a known provider host. Single-label names
 * (`inkling`, a compose service) and `*.internal` / `*.localhost` cannot be
 * registered publicly, so they cannot be rebound.
 */

/** Provider hosts an agent under `inkling warp` may name as Host. Derived from
 *  the upstream registry so the guard and the router cannot drift apart. */
const PROVIDER_HOSTS: ReadonlySet<string> = new Set(DEFAULT_UPSTREAM_REGISTRY.keys());

export interface RequestGuardOptions {
  /** Extra Host/Origin names to accept (INKLING_ALLOWED_HOSTS). `*` disables the Host and Origin checks. */
  allowedHosts?: readonly string[];
  /** Provider hosts to trust as Host names; defaults to the built-in registry.
   *  The Node entry passes the registry extended by INKLING_UPSTREAM_HOSTS. */
  providerHosts?: ReadonlySet<string>;
  /** True when the caller presented a verified per-user loopback `x-fiche-warp-auth`
   *  secret from `fiche warp`, allowing warped desktop app Origins / Sec-Fetch-Site. */
  warpAuthenticated?: boolean;
}

export interface RequestGuardDenial {
  status: 403 | 421;
  reason: 'cross_origin' | 'untrusted_host';
  message: string;
}

/** Hostname from a Host header or URL authority, lowercased, without port or brackets. */
export function hostnameOf(authority: string): string {
  const value = authority.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  // A bare IPv6 literal has several colons and no port.
  if ((value.match(/:/g) ?? []).length > 1) return value;
  const colon = value.indexOf(':');
  return (colon >= 0 ? value.slice(0, colon) : value).replace(/\.$/, '');
}

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(':') && /^[0-9a-f:.]+$/.test(host);
}

export function isLoopbackHostname(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** True when no public DNS name can resolve to this hostname on an attacker's say-so. */
export function isTrustedHostname(
  host: string,
  allowed: readonly string[] = [],
  providerHosts: ReadonlySet<string> = PROVIDER_HOSTS,
): boolean {
  if (host === '') return true; // HTTP/1.0 without Host: nothing to rebind
  if (allowed.includes(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIpLiteral(host)) return true;
  if (!host.includes('.')) return true; // single label: container, compose service
  if (host.endsWith('.internal')) return true; // host.docker.internal and friends
  return providerHosts.has(host);
}

export function parseAllowedHosts(spec: string | undefined): string[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => hostnameOf(s.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/, 1)[0] ?? ''))
    .filter((s) => s !== '');
}

/**
 * `null` lets the request through. Applies to the proxy API only; the dashboard
 * keeps its stricter loopback-and-same-origin rule.
 */
export function guardProxyRequest(
  headers: { host?: string | null; origin?: string | null; secFetchSite?: string | null },
  options: RequestGuardOptions = {},
): RequestGuardDenial | null {
  const allowed = options.allowedHosts ?? [];
  if (allowed.includes('*')) return null;
  if (!options.warpAuthenticated) {
    const fetchSite = typeof headers.secFetchSite === 'string'
      ? headers.secFetchSite.trim().toLowerCase()
      : '';
    if (fetchSite === 'cross-site') {
      return {
        status: 403,
        reason: 'cross_origin',
        message: 'fiche: cross-site browser request refused; set FICHE_ALLOWED_HOSTS=* to allow it',
      };
    }
    const origin = headers.origin;
    if (origin !== undefined && origin !== null) {
      let originHost: string | undefined;
      try {
        const parsedOrigin = new URL(origin);
        if (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:') {
          originHost = parsedOrigin.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        }
      } catch {
        originHost = undefined; // `Origin: null` (sandboxed iframe, file://) lands here
      }
      // A page origin must be loopback: an attacker can serve a page from a raw
      // public IP or any name, and a provider is never a page. Non-http(s) desktop
      // origins (e.g. vscode-file://) require warpAuthenticated.
      const ok = originHost !== undefined && (isLoopbackHostname(originHost) || allowed.includes(originHost));
      if (!ok) {
        return {
          status: 403,
          reason: 'cross_origin',
          message: `fiche: browser request from ${origin} refused; set FICHE_ALLOWED_HOSTS to allow it`,
        };
      }
    }
  }
  const host = hostnameOf(headers.host ?? '');
  if (!isTrustedHostname(host, allowed, options.providerHosts)) {
    return {
      status: 421,
      reason: 'untrusted_host',
      message: `fiche: Host ${host} refused (possible DNS rebinding); set FICHE_ALLOWED_HOSTS to allow it`,
    };
  }
  return null;
}
