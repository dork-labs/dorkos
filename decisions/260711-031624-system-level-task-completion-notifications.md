---
id: 260711-031624
title: System-level task-completion notifications originate from a store terminal hook
status: accepted
created: 2026-07-10
spec: task-completion-notifications
superseded-by: null
---

# 260711-031624. System-level task-completion notifications originate from a store terminal hook

## Status

Accepted

## Context

The launch demo and homepage promise an automatic, unprompted notification when an unattended
agent task finishes ("your phone buzzes at 2:47 AM"). The only proactive path today is the
agent voluntarily calling the `relay_notify_user` MCP tool, which requires an established chat and
(since DOR-239) `canInitiate=true` + `enabled=true` — so completion notifications are neither
automatic nor guaranteed. A Task run reaches a terminal status through three disjoint code paths:
the `packages/relay` claude-code task-handler (default relay path), the scheduler's
`executeRunDirect` (relay-off path), and various failure writes. All three funnel through one
method — `TaskStore.updateRun`, which already owns the DOR-248 terminal-status guard.

## Decision

Originate completion notifications **server-side** from a single store-level terminal hook, not
from the agent. `TaskStore.updateRun` fires an optional injected `onRunTerminal(run, task)`
callback exactly once, on the write that transitions a run to a terminal status. A new
`TaskCompletionNotifier` service consumes it, applies the opt-in/status policy, resolves the
linked agent's bound channel via a resolver **extracted and shared** with `relay_notify_user`
(honoring `enabled` and `canInitiate`), and delivers through `RelayCore.publish` with a bounded
budget. Rejected alternatives: subscribing a notifier to relay task-response subjects (the
relay-off path publishes no response — inconsistent coverage) and duplicating notify logic at each
terminal call site (DRY violation; would push notification/binding logic into `packages/relay`).

## Consequences

### Positive

- One path-agnostic seam catches every completion (relay, direct, failure) and fires exactly once.
- Reuses the proven `relay_notify_user` resolution → budgets (PR #210), dead-lettering,
  rate-limiting, access control, and the DOR-239 consent gates are inherited, not re-implemented.
- Zero agent cooperation, zero tokens, no `NO_ACTIVE_SESSIONS` tool failure.
- Keeps notification/binding logic in the server, out of `packages/relay`.

### Negative

- `TaskStore` gains one outward callback (kept a pure, injected, fire-and-forget side-effect with
  no notification logic in the store).
- Bootstrap limit persists: a Telegram bot cannot DM a user who never messaged it, so a chat
  session must pre-exist; surfaced honestly in UI, treated as a silent no-op otherwise.
