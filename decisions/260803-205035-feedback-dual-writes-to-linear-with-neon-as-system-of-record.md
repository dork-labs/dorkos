---
id: 260803-205035
title: Feedback submissions dual-write to Linear with Neon as system of record, not PostHog alone
status: proposed
created: 2026-08-03
spec: feedback-pipeline
superseded-by: null
---

# 260803-205035. Feedback submissions dual-write to Linear with Neon as system of record, not PostHog alone

## Status

Proposed

## Context

The in-app feedback dialog (DOR-317) sends every submission to
`/api/telemetry/events`, which is explicitly documented as having "no Neon
table — Neon stays system-of-record only for install + heartbeat sinks."
Feedback becomes a PostHog event and nothing else: no triage state, no
notification, no way to mark something handled, and a volunteered contact
email is only visible by querying events by hand. There is no durable record
anywhere that a given submission exists, and no way for either the team or
the reporter to know what happened to it. The product owner dogfoods this
pipeline daily and wants reports to reach the same `/flow` triage machinery
every other piece of work goes through, with a way to check status
afterward.

## Decision

Feedback submissions of kind `bug`/`feedback`/`idea` dual-write from a new
site route (`POST /api/feedback`, `apps/site`) to two destinations: a new
Neon table (`feedback_submission`) as the durable system of record, and a
Linear issue (via a new minimal, server-key-authenticated GraphQL client,
`apps/site/src/lib/linear.ts`, following the existing dependency-free
`fetch`-over-GraphQL style already used for read-only Linear access
elsewhere in the repo — no `@linear/sdk`). The existing PostHog event keeps
being sent unchanged, for aggregate metrics continuity. A Linear webhook
mirrors status changes back onto the Neon row, which a public,
`instanceId`-scoped read endpoint and a small cockpit view expose to the
reporter — no login required, matching the pipeline's existing pseudonymous
posture. Neon insert success is the caller-visible "received" guarantee;
Linear issue creation is best-effort on top of it, so a transient Linear
failure never turns an honest "received" toast into a lie.

## Consequences

### Positive

- Feedback becomes durable and triageable by default, closing the
  "reports disappear into an analytics table" gap that made the prior
  pipeline hard to trust for anything beyond aggregate counts.
- Reporters (including the team, dogfooding) get a real answer to "what
  happened to my report" without either party querying PostHog or Linear
  by hand.
- The Neon table stays small and isolation-safe (no FK into `user` or
  Linear) by holding only enough to answer status queries — heavier
  content (logs, screenshots, transcripts) lives in Linear as attachments,
  not as a second blob store this repo would have to maintain.
- Establishes the first server-key-authenticated Linear write client and
  the first webhook-signature-verification code in this repo, both
  reusable by future integrations that want to create or track Linear
  work items programmatically.

### Negative

- Two new pieces of infrastructure land in `apps/site` with no prior
  precedent: a write-capable Linear client (previously only a read-only,
  user-supplied-key client existed) and a webhook receiver with HMAC
  verification. Both carry real implementation and operational risk
  (webhook secret provisioning, signature-scheme correctness) that a
  PostHog-only pipeline never had.
- The Neon table and the Linear issue can drift (e.g., Linear creation
  fails after the Neon row is written, or a webhook delivery is missed) —
  mitigated by treating Linear as best-effort with a documented follow-up
  (a reconciliation sweep for stuck `received` rows), but the gap is real
  until that sweep exists.
- Adds a second site route (`/api/feedback`) alongside the existing
  `/api/telemetry/events` rather than extending it, because the existing
  route is architecturally committed to "no Neon table, PostHog only" —
  two feedback-adjacent routes now exist with different persistence
  models, which needs to stay documented or it will read as duplication.
