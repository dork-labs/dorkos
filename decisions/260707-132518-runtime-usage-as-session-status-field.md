---
id: 260707-132518
title: Runtime usage/cost as a session-status field, not a runtime method
status: accepted
created: 2026-07-07
spec: runtime-usage-status
superseded-by: null
---

# 260707-132518. Runtime usage/cost as a session-status field, not a runtime method

## Status

Accepted (implemented in spec: runtime-usage-status, DOR-100)

## Context

The usage-status UI was Claude-Code-specific: it read the Claude SDK `rate_limit_event` and
rendered subscription utilization in a dedicated Usage item, beside a separate Cost item. As
DorkOS adds Codex and OpenCode, that shape does not generalize — OpenCode has no single
subscription quota, Codex exposes neither dollar cost nor utilization, and three per-runtime UI
code paths would accrete.

Two forces shaped the decision:

1. **Where does usage live in the contract?** The obvious candidate was a synchronous
   `getUsageStatus(): UsageStatus | null` on the universal `AgentRuntime` interface. But usage is
   push-derived live data that changes per turn: subscription utilization arrives opportunistically
   on a `rate_limit_event`, session cost on `result`. DorkOS already has a push channel for exactly
   this — the `session_status` StreamEvent that the normalizer folds into a `status_change`
   SessionEvent, the projector merges into a held status, and the client reads off the durable
   `/events` snapshot. Cost already rides it. A synchronous getter would need its own polling loop,
   duplicate that stream, and return stale-or-null before the first turn, and non-subscription
   runtimes would implement it as `return null` — the no-op-method anti-pattern ADR-0258 rejects.

2. **A live regression to repair.** The old Usage item was already dead on the durable path: the
   claude-code mapper emitted a standalone `usage_info` StreamEvent that `session-event-normalizer`
   had no case for, so it was dropped after the spec-255 stream-reconnection migration. The client
   `usageInfo` store field was never written, and two rate-limit store actions were never called.

The related question — whether Usage and Cost stay two items — folds in here because the carrier
choice makes one merged item natural: both numbers are projected onto the same status.

## Decision

**Usage is data on the existing `session_status` projection, not a method on `AgentRuntime`.** A
runtime-neutral `UsageStatus` (`kind: 'subscription' | 'pay-as-you-go'` plus optional
`utilization`/`windowLabel`/`resetsAt`/`costUsd`/`state`/`detail`) is carried as an optional
`usage` field on `SessionStatusEventSchema` and on the `status_change` status payload. Each runtime
**produces** `usage` in its event mapper exactly as it already produces `costUsd`: claude-code maps
`rate_limit_event` to subscription utilization and re-attaches it onto the cost-bearing `result`;
opencode reports pay-as-you-go cost; codex omits it. "Nothing meaningful" is expressed by omitting
`usage`, never a `kind: 'none'` placeholder — the item self-gates (shows iff `usage` is present and
renders a metric).

No new `AgentRuntime` method, no new SessionEvent type, and therefore **no new client allowlist
entry** — usage rides the carrier that already delivers cost. `RuntimeCapabilities` is unchanged:
`supportsCostTracking` stays as the guard that keeps a stray cost off a runtime with no cost concept
(Codex); ADR-0256's `features` hatch is deliberately not used because the data self-gates.

**Usage and Cost merge into one kind-driven `UsageStatusItem`.** Legibility survives because the two
numbers are never both primary: a subscription renders utilization primary with cost in the tooltip;
pay-as-you-go renders cost primary. The `cost` and `usage` registry keys collapse to one toggle; the
dead `UsageInfo` type, `usageInfo` store field, and the two never-called rate-limit actions are
removed.

## Consequences

- One abstraction spans every runtime and subscription state; adding a runtime means populating
  `usage` in its mapper, not touching the client.
- The dead Usage item and mid-turn rate-limit strip regression are fixed as a side effect: the
  source event now reaches the client on the durable path.
- Usage inherits the projection's snapshot-then-replay semantics for free (cold-mount population,
  gap-free replay, cross-client sync) with no new plumbing.
- The merge trades a user's ability to hide Cost independently of Usage for a simpler, single toggle
  — acceptable for a pre-launch alpha (client Zustand pref, no `conf` migration).
- A first-class `usage_update` SessionEvent was rejected: it would add an allowlist entry, a
  projector case, and snapshot handling for a value that is conceptually part of session status. If
  a future consumer needs usage decoupled from status, that variant can be revisited.
- `.default(null)` on the snapshot `usage` field keeps pre-usage snapshots parsing (version skew),
  matching the `lastError` precedent.
