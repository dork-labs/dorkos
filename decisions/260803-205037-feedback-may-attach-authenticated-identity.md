---
id: 260803-205037
title: Feedback submissions may attach the authenticated user's identity, shown plainly and resolved server-side
status: accepted
created: 2026-08-03
spec: feedback-pipeline
superseded-by: null
---

# 260803-205037. Feedback submissions may attach the authenticated user's identity, shown plainly and resolved server-side

## Status

Accepted

## Context

ADR 260711-143626 built the original feedback rails around DorkOS's
"nothing phones home" posture: its shared sanitizer (`redactSecrets`)
treats emails as a leak risk and actively strips them from anything routed
through it. DorkOS now embeds Better Auth locally (ADR 0311) with a real
`user.email` field, and the feedback pipeline (spec `feedback-pipeline`)
wants submitters to be trackable and, optionally, reachable by email for
status updates — which means an authenticated user's identity is worth
attaching when it exists, reversing that specific redaction default for
this one flow. The session gate that verifies every authenticated request
(`session-gate.ts`) resolves only `{ userId, credential }` today and
discards email, so nothing currently plumbs identity as far as a route
handler; auth is also off by default in local single-user mode, so an
authenticated identity frequently doesn't exist at all.

## Decision

The feedback route resolves the requester's email/name **server-side**,
from the verified session's `userId` (one extra lookup against the `user`
table, or a fresh `auth.api.getSession()` call) — never from a
client-supplied field, so it can't be spoofed by editing the request body.
When identity resolves, it rides the submission as new, separate
`reporterEmail`/`reporterName` properties, distinct from the existing
free-text `contact` field (which stays "typed by the user" rather than
"resolved from their account," so downstream consumers can tell the two
apart). The dialog shows this plainly ("Sending as {email}") whenever it
attaches — pressing Send stays the consent boundary (per ADR
260713-143958's data-collection posture), and the boundary now includes
"an account is attached to this," visibly, not silently. When auth is off
or no session exists, behavior is unchanged: the existing pseudonymous
`instanceId` plus an optional typed `contact` field.

This decision is scoped to feedback submissions only. It does not change
the no-phone-home posture for telemetry generally, and it does not change
`redactSecrets`'/`sanitizeFlags`' behavior for the GitHub-issue path, which
keeps redacting emails as before — a feedback submission is a message the
user chose to send to the team, not an automatically-collected report.

## Consequences

### Positive

- Reporters who are logged in stop having to retype an email they've
  already given the product, and the team gets a verified identity instead
  of a free-text field a bot or a typo can corrupt.
- Server-side resolution from a verified session is spoof-resistant in a
  way a client-supplied email field never can be.
- Keeping `reporterEmail` separate from `contact` preserves a real
  distinction (verified account vs. self-reported) that downstream triage
  and any future analytics can rely on.

### Negative

- Deliberately narrows the "nothing phones home" guarantee ADR
  260711-143626 leaned on, for this one flow — a future contributor
  reading that ADR without this one could reasonably assume feedback never
  carries identity; both files should be discoverable from each other.
- Adds one more server-side lookup (or a second `getSession` call) to the
  feedback route's request path, and a small amount of durable PII
  (`reporterEmail`/`reporterName`) to the new Neon `feedback_submission`
  table — which is why that table's schema explicitly documents these as
  plain text, never FKs, so a GDPR erasure of the `user` row can't
  cascade-delete or orphan a feedback record tied to it.
