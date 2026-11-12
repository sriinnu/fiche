# Security Policy

This fork is not maintained by Steven or teamchong. Do not file fork-specific
vulnerabilities on https://github.com/teamchong/pxpipe. Issues that exist in
the imported pxpipe v0.16.0 code can still be reported upstream. This fork
does not yet have a separate private tracker: keep secrets, prompts, and
exploit details out of public issues either way.

The MCP server and the proxy do not store request bodies. `health` and
`stats` return counters and version strings only. L4 (lossy) PAKT is off
unless a tool call sets `lossy: true` and a positive `semanticBudget`.

## Supported versions

Security fixes are applied to the latest released version of pxpipe. Users
should upgrade to the newest release before reporting a problem that may
already have been fixed.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include
secrets, prompts, logs, request bodies, or proof-of-concept exploits in a
public discussion.

Use GitHub's private vulnerability reporting form:

https://github.com/teamchong/pxpipe/security/advisories/new

Include, where possible:

- the affected version and runtime (Node or Cloudflare Workers);
- the deployment configuration needed to reproduce the issue, with secrets
  removed;
- the security impact and who can trigger it;
- minimal reproduction steps or a proof of concept; and
- any suggested mitigation.

The maintainers will acknowledge the report, assess its severity, coordinate
a fix and release, and credit the reporter unless anonymity is requested.
Please allow time for a patch before publishing details.

## Deployment security

pxpipe handles API credentials and may process confidential prompts and tool
results. Keep the Node server on its default loopback interface unless it is
placed behind an authenticated, encrypted reverse proxy. Non-loopback bindings
expose the proxy API, while dashboard routes remain loopback-only.

For Cloudflare Workers deployments that inject provider credentials, configure
`PXPIPE_WORKER_SECRET`. The Worker fails closed when a provider credential is
configured without this shared secret. Do not enable
`PXPIPE_DEBUG_CAPTURE_4XX` in production: captured request bodies can contain
prompts and credentials.

Telemetry, diagnostic captures, rendered PNG dumps, configuration files, and
export artifacts are protected with owner-only permissions on POSIX systems.

See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for trust boundaries,
assumptions, and operator guidance.
