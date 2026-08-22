---
id: 260821-190444
title: A proposed schedule carries its own case — required reason, stamped provenance, and a test run that commits nothing
status: accepted
created: 2026-08-21
spec: schedule-approval-experience
superseded-by: null
amends: null
---

# 260821-190444. A proposed schedule carries its own case — required reason, stamped provenance, and a test run that commits nothing

## Status

Accepted 2026-08-22 — implemented in DOR-1394/DOR-1398 (PRs #1160, #1168).
`tasks_create` refuses a blank reason
(`apps/server/src/services/runtimes/claude-code/mcp-tools/task-tools.ts`),
provenance is stamped by `task-store.ts`, and the test run is
`POST /api/tasks/:id/trigger` (`services/tasks/__tests__/trigger-pending-schedule.test.ts`).

## Context

An agent proposes a scheduled run through the `tasks_create` MCP tool, and
the proposal parks as `pending_approval` until the operator decides. The
approval surfaces (Inbox, home triage) could only show a name and a cron
sentence: the tool captured no reason, no proposing session, and no
proposing identity — the notification hardcoded `proposedBy: 'An agent'`.
The operator reported having "no info to either approve or reject." The
invoking session id was already resolved at the same MCP-server
construction site for the capability tools; it was simply never handed to
the task tools. The alternatives were to keep approval as a blind gate, or
to show only what happened to be stored.

## Decision

A proposal must make its own case, captured at creation time:

- `tasks_create` requires a `reason` — the agent's own words for why the
  schedule should exist. A proposal without one is refused.
- The proposing session id and the session's working directory (the
  agent-identity key) are stamped on the schedule row
  (`proposed_by_session_id`, `proposed_by_agent_path`); display names are
  resolved at read time from the agent-identity service, never denormalized.
- The `schedule.parked` notification is titled by the resolved proposer,
  falling back to "An agent" only when nothing resolves (including the
  sessionless external `/mcp` path, where provenance is null by nature).
- The existing manual-trigger path (`POST /api/tasks/:id/trigger`) is the
  approval surface's **test run**: it may execute a `pending_approval`
  schedule as a single supervised run, and doing so arms no cron, changes
  no status, and resolves no standing condition. Approving remains the
  only action that makes a schedule run on its own.

## Consequences

### Positive

- Approval becomes informed consent: who, why, what, and exactly when are
  on the card, with a deep link back to the conversation that proposed it.
- "Run it once" turns approval into a decision backed by observed
  behavior rather than imagination, using run machinery that already
  exists (isolated per-run session, unattended mode, run history).
- Identity stays honest: names resolve live from the identity service, so
  a renamed or revoked agent identity is never frozen into old rows.

### Negative

- `reason` is a breaking change to the `tasks_create` contract: existing
  agent flows that omit it will be refused until they comply.
- Provenance is best-effort by construction: external `/mcp` proposals and
  sessions whose directory holds no minted identity still render as
  "An agent" — the field's presence cannot be treated as a guarantee.
- A test run of an unreviewed prompt executes real work under the task's
  stored permission mode; the operator is trusted to read the card (the
  prompt is one disclosure away) before running it.
