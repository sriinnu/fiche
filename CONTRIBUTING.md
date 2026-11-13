# Contributing to inkling

Small PRs with receipts merge fast.

## Rules

- One root cause per PR. Split unrelated fixes.
- Rebase on current `main` before opening.
- Redaction: no raw prompts, credentials, session files, API keys, or machine
  identifiers (hostnames, usernames, absolute home paths) in PR descriptions,
  issues, test fixtures, or committed logs. Use made-up repro data instead.
- CI green. `pnpm test` and `pnpm typecheck` pass locally.

## Required only when applicable

- Claims about model behaviour (readability, savings, guard flags, refusals)
  include: model id, date, client version, render geometry, sample size, and
  failure categories. The README is held to the same standard.
- Provider pricing carries a source URL and a date.
- Changes to the PAKT stage include a test through `createProxy`, not only
  `hybridTransform`. The proxy has its own wiring, and a unit test alone has
  passed against a broken proxy before.
- Security reports go through [SECURITY.md](SECURITY.md), not the public
  issue tracker.

## Nice to have

- A failing test first, then the fix.
- Exact commands and their output in the description, so a reviewer can
  re-run instead of re-derive.

A three-line fix with a clear repro is a good PR. Do not bulk it up to look
more serious.

## What tends to stall

- Claims about model behaviour that would need testing on every model to
  verify. Ship what a test can check.
- PRs that touch files unrelated to the stated root cause.
- New opt-in flags with no caller.
