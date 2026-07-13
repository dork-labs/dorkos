---
id: 260711-153307
title: Opt-in error reporting is a separate consent to a third party, sent by a minimal allowlist reporter
status: accepted
created: 2026-07-11
spec: null
superseded-by: null
---

# 260711-153307. Opt-in error reporting is a separate consent to a third party, sent by a minimal allowlist reporter

## Status

Accepted (DOR-293 PR-B, implemented: server + CLI error reporting).

**Amended 2026-07-13 (DOR-318, ADR 260713-143958 Phase 6):** the crash-report
**destination** consolidated from direct-to-Sentry into DorkOS's own ingest
(`https://dorkos.ai/api/telemetry/events` → PostHog Error Tracking as a
`$exception` event), removing the third-party egress and the `SENTRY_DSN`
requirement. Reports now also cover cockpit (browser) crashes via
`POST /api/errors`, which rebuilds and re-scrubs the untrusted client payload
server-side. The **scrubbing allowlist and consent posture are unchanged**: the
raw message is still omitted, stacks are still scrubbed to repo-relative
filenames with home dirs / absolute paths / tokens stripped (decision 3 below
stands verbatim), and `telemetry.errorReporting` remains a separate explicit
Tier 2 opt-in. Decisions 1 and 5 stand; decisions 2 (Sentry envelope) and 4
(`SENTRY_DSN` in env) are superseded by the owned-ingest wire format and the
removal of the DSN.

## Context

PR-A shipped the shared opt-in telemetry consent namespace (ADR 260711-141639) with a reserved
`telemetry.errorReporting` flag. PR-B implements the sender. Error reporting differs from the
heartbeat in a way that drives every decision below: crash data goes to a **third party** (Sentry,
or a self-hosted GlitchTip that speaks the same protocol), and crash data is inherently high-risk —
an error message or stack can carry file paths, home directories, tokens, or session content.
GTM plan §3.4 says "behind the same consent", but third-party egress of potentially sensitive data
deserves a more careful posture than a first-party anonymous ping.

## Decision

1. **A separate, explicit opt-in — not bundled into the first-run banner.** The first-run
   "share anonymous data" choice turns on only the first-party anonymous channels (heartbeat +
   install). Error reporting fires only when BOTH `config.telemetry.errorReporting === true`
   (default false, never set by the banner) AND a `SENTRY_DSN` is configured. Turning it on is a
   deliberate two-part act, and the recipient (Sentry/GlitchTip) is named verbatim on the
   `/telemetry` page and in docs. Bundling third-party egress into a one-tap "yes" would be
   dishonest.

2. **A minimal, dependency-free reporter — not the full Sentry SDK.** We speak the Sentry
   **envelope** ingest protocol directly (`@dorkos/shared/error-report`), which is DSN-compatible
   with both Sentry and self-hosted GlitchTip. Rationale: (a) the event is built by an
   **allowlist** — only the fields we choose can ever be sent — rather than adopting the SDK's large
   auto-captured surface (breadcrumbs, request data, local variables, env, modules) and then
   denylisting it; for a privacy-first tool, allowlist-by-construction is the safer default. (b) the
   CLI is a published esbuild bundle (`npx dorkos`); the full SDK would bloat it. One shared,
   exhaustively tested scrubber serves both the server and the CLI.

3. **The raw error message is never sent.** A message is free-form and can contain session content,
   prompts, or user input that no pattern scrubber can reliably catch. We send the error **type**
   and a **stack scrubbed to repo-relative filenames** (function + file + line), and nothing else.
   That still pinpoints the failing line in first-party source — what a bug report needs — while
   making message-borne leakage structurally impossible. Additional scrubbing: home directories and
   absolute paths are stripped from every filename (no username leaks; never an absolute path),
   secret-shaped tokens are redacted from any remaining text, and source lines, local variables,
   `server_name`, `user`, `request`, `contexts`, `breadcrumbs`, and `modules` are never included. A
   single no-leak test poisons an error with a home path, cwd, tokens, a JWT, and session content in
   the message and asserts none survive.

4. **The DSN lives in env (`SENTRY_DSN`), not config.** A DSN carries a public ingest key, not a
   secret at rest, and is deployment-specific (each self-hoster has their own). Env is the correct,
   migration-free home; no config schema change and no config credential-ref were needed.

5. **Wiring avoids double-reporting.** The server initializes the reporter at startup and its
   existing `uncaughtException` / `unhandledRejection` handlers report through it. The CLI runs the
   server **in-process** for the cockpit path, so the CLI installs its own handlers only to cover
   standalone commands (`doctor`, `feedback`, `package`, …) and **uninstalls them just before
   importing the server**, leaving the server's handlers as the sole reporters on the cockpit path.

## Consequences

- **Positive.** A hard, tested privacy guarantee (no message, no PII, allowlisted fields). Works
  identically with self-hosted GlitchTip, so a privacy-strict operator keeps crash data on their own
  infrastructure. No new dependency; the CLI bundle stays small. No config migration.
- **Trade-offs.** Omitting the message loses free-form detail; triage relies on the error type plus
  the exact file/line/function, which is enough for first-party code we own. The minimal reporter
  implements a slice of the Sentry protocol by hand (envelope + DSN parsing) rather than tracking the
  SDK; the protocol is stable and covered by tests.
- **Residual risk.** Reporting is best-effort and fire-and-forget (failures swallowed). Frames from
  code outside `cwd` and outside `node_modules` collapse to a basename, losing some path context —
  an accepted cost of the "never an absolute path" rule.
- **Follow-ups.** A future settings-UI toggle could expose `errorReporting` alongside a DSN field; a
  remote OpenTelemetry exporter, when built, hangs off the same consent namespace under the same
  rules.
