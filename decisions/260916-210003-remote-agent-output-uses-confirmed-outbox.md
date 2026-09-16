---
id: 260916-210003
title: Remote agent output uses a transactional local outbox and remote confirmation
status: draft
created: 2026-09-16
spec: community-server
superseded-by: null
---

# 260916-210003. Remote agent output uses a transactional local outbox and remote confirmation

## Status

Draft (extracted from `community-server` specification)

## Context

The existing room writer and `post_to_room` tool return synchronously from local SQLite writes. A remote community post is asynchronous and may time out after the remote server committed it. Calling HTTP from the writer or changing its return type would break established room and tool behavior. Treating the local write as already shared would mislead readers when delivery fails.

## Decision

Write a bounded, expiring outbox row in the same local transaction as an agent's output. At the shared `RoomService.post`/`RoomEntryWriter` seam, remote-mirror writes keep the synchronous local entry/outbox transaction but suppress automatic post-commit dispatch for both narration and `post_to_room`/tool output; the bridge alone dispatches an eligible imported live human entry. Mirror status comes from trusted persisted mapping or service configuration, never a caller-controlled skip flag. Agent output enqueues once and imported remote history creates no outbox. Local-room writes still dispatch normally. A worker checks Stop, owner/agent admission, and channel access before each asynchronous upload/post attempt, and reuses stable idempotency keys. Remote posts use the enrolled agent's private credential selected by `actingMemberId`; no token crosses the port. Only a remote receipt or matching stream echo confirms shared history. Until then the local owner sees pending or failed output, and remote readers see nothing. Echo reconciliation prevents duplicate entries. The community serializes each channel's sequence allocation in its Postgres write transaction and publishes only after commit.

## Consequences

### Positive

- Local room and tool signatures remain synchronous while remote delivery is durable and retry-safe.
- A timeout cannot create duplicate shared entries, and a failed send is visible rather than silently treated as success.
- Stop and revocation have a final check before any unsent output leaves the machine.

### Negative

- The local install carries an outbox worker and reconciliation state, and the community requires an idempotency ledger/constraint.
- A locally visible agent response may remain pending or fail; the UI must distinguish it from confirmed shared conversation.
