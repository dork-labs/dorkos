---
id: 260711-143626
title: Feedback rails open prefilled GitHub issues from a shared, sanitized URL builder
status: accepted
created: 2026-07-11
spec: null
superseded-by: null
---

# 260711-143626. Feedback rails open prefilled GitHub issues from a shared, sanitized URL builder

## Status

Accepted

## Context

The alpha's most valuable output is feedback, and the GTM plan (`meta/positioning-202607/09-gtm-plan.md` §3.7) sets hard constraints on how a self-hosted, privacy-first dev tool collects it: GitHub is the canonical bug tracker, the app helps you report but never surveils you, and the site's "nothing phones home" claim must stay true. We need an in-app "Report an issue" (command palette + help menu) and a `dorkos feedback` CLI command that both remove the "gather my environment info" friction that kills alpha bug reports, without any third-party widget, tracking, or server round-trip.

The security-critical risk is a report leaking a secret. DorkOS config holds tokens (`tunnel.authtoken`, `mcp.apiKey`, `cloud.instanceToken`), credential references, absolute paths, hostnames, and timezones. Any of these in a URL, in front of the user or not, is a leak.

## Decision

Both surfaces gather the same details, sanitize them, and open a **prefilled GitHub issue** in a new tab (`github.com/dork-labs/dorkos/issues/new?title=&body=&labels=`). Nothing is sent by DorkOS; the user reviews and edits everything in GitHub before submitting.

1. **The URL builder is one pure, isomorphic module** in `@dorkos/shared/feedback` (`buildIssueUrl`, `sanitizeFlags`, `redactSecrets`). It imports no Node builtins so it runs in the browser and the CLI alike. Each caller gathers its own environment (the CLI from the config manager and `os`; the client from the server config it already fetches) and passes primitives in; the shared module assembles and sanitizes.

2. **Sanitization is a positive allowlist, and the allowlist is the guarantee.** `FEEDBACK_FLAG_ALLOWLIST` names only booleans, bounded numbers, and enums; each enum is bounded to a known finite value set (`FEEDBACK_ENUM_VALUES`: log levels, themes, runtime ids), so a user-customized value is dropped rather than echoed. Secrets, paths, hostnames, and timezones are never named, so they cannot be reported. `redactSecrets` is a best-effort second net (emails, prefixed/high-entropy tokens, AWS key ids, Unix/Windows/UNC paths, IP addresses), explicitly not a guarantee: an unprefixed key id or an internal hostname can survive it, which is exactly why free-form text must never be routed through it. A unit test poisons a report with a home path, a token, and an email and asserts none survive into the URL; other tests document the redactor's known limits.

3. **The client learns host `platform` and configured `runtimes` from the existing `GET /api/config` response**, not from the browser. A bug report should carry the host's OS and runtimes (the machine running DorkOS), not the viewing device's, which may be a phone over a tunnel. Two fields (`platform`, `runtimes`) were added to `ServerConfigSchema`; the config route is not in the OpenAPI registry, so the exported spec is unchanged.

4. **DorkBot triage ships as a capability, turned off.** A `dorkbot-triage` skill (`.github/dorkbot-triage/`) plus GitHub issue-form templates (`bug`/`feature`/`runtime` + `needs-triage` label) are delivered, but no live auto-commenting bot or GitHub Action is wired up. Enabling it needs a scoped bot token and an owner decision; the enablement doc documents the steps and the guardrails, and the default stays human-in-the-loop.

## Consequences

### Positive

- No third-party widget, no tracking, no server round-trip: the "nothing phones home" claim holds, and reporting works fully offline up to opening the browser.
- One tested sanitizer guards both surfaces; the leak test is the single security gate.
- Reports arrive pre-filled with version, OS/arch, runtimes, active surface, and safe flags, which is the friction the GTM plan targets.
- Feedback converges on GitHub, the public queue whose visible fix velocity is itself alpha retention.

### Negative

- Prefilled classic-issue URLs and the YAML issue-form templates are two separate prefill mechanisms (the app uses the classic `?body=` form; web filers use the templates). They are kept consistent by hand.
- The allowlist must be extended deliberately as config grows; a new safe flag is invisible to reports until named. This is the intended trade (safe by default) but is a small ongoing maintenance cost.
- The client depends on the server for host platform/runtimes, so a report built before the config query resolves shows `unknown`. Acceptable; the user still edits in GitHub.

## Implementation notes

- Shared: `packages/shared/src/feedback.ts` (+ `./feedback` export). CLI: `packages/cli/src/commands/feedback.ts`. Client: `useReportIssue` (`shared/model`) + `buildClientReport` (`shared/lib`), surfaced by the `report-issue` feature's `HelpMenu` and the command palette. Templates: `.github/ISSUE_TEMPLATE/`. Triage: `.github/dorkbot-triage/`.
- Labels: the templates use the existing GitHub defaults `bug`/`enhancement` plus `needs-triage` (created on triage enablement). There is no GitHub↔Linear label sync in this repo today, so template labels do not auto-map to Linear's `type/*` families.
