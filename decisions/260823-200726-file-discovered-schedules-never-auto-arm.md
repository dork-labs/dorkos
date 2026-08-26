---
id: 260823-200726
title: File-discovered schedules never auto-arm
status: accepted
created: 2026-08-23
spec: universal-scheduled-tasks
superseded-by: null
amends: null
---

# 260823-200726. File-discovered schedules never auto-arm

## Status

Proposed — extracted from spec `universal-scheduled-tasks`.

## Context

Opening discovery to every scanned skills root (ADR 260823-200724) means a `git pull`, a
plugin install, or an agent-authored skill can now plant a cron anywhere a skills root is
watched — previously only two blessed directories could ever arm a schedule. DorkOS already
solved a structurally identical problem for permissions: the `bypassPermissions` clamp
(`schedule-permission-clamp.ts`) ensures file content can never introduce that mode, keyed
on the schedule's prompt+cron content, and drops the grant the moment content changes.

## Decision

**First sighting of new schedule content always parks `pending_approval`, regardless of
`schedule.enabled`.** `upsertFromFile` gains an arming gate parallel to the existing
permission clamp: a row created from a file whose schedule content (prompt+cron — the same
key the bypass grant uses) has no stored approval grant lands `pending_approval` with
provenance `origin: file` (spec §3). Operator approval (the existing PATCH
`status: 'active'` transition) stores an arm grant keyed on that content; re-syncs of
identical content stay approved, and content changes drop the grant and re-park. This
reuses the bypass grant's keying helper rather than inventing a second one, so the two
safety gates cannot drift apart. Operator-created schedules via the cockpit/API still arm
immediately — the route write is itself the approval.

## Consequences

### Positive

- Opening discovery to every skills root cannot itself arm anything; a planted cron always
  requires a human look before it can run unattended.
- One shared content-keying helper covers both the bypass clamp and arm-approval, so the
  two gates evolve together instead of drifting into two ad hoc implementations.
- `schedule.enabled: true` in a file is honestly just author intent — it can never bypass
  the operator's approval.

### Negative

- Every legitimate marketplace-shipped schedule parks on first sync too, with no allowlist
  for trusted package origins — a well-known package's schedule gets the same friction as
  an unknown one.
- Two independent axes (`schedule.enabled`, approval status) now describe every schedule
  row, which is one more state a person or a docs page has to explain correctly.
- Re-syncs of literally identical content stay armed by design; the grant's safety is
  entirely a function of the content having been reviewed once, not of freshness.
