---
number: 148
title: Server-Echo Message ID for Client-Server ID Reconciliation
status: superseded
created: 2026-03-19
spec: streaming-message-integrity
superseded-by: 264
---

# 0148. Server-Echo Message ID for Client-Server ID Reconciliation

## Status

Superseded by ADR-0264 (Server-Owned Durable, Resumable Per-Session Stream (Turn Decoupled from POST)) — turn delivery was decoupled from the POST response, making the done-event id echo obsolete; ADR-0145's tagged reconciliation became the permanent mechanism.

## Context

The client creates streaming messages with UUID IDs, while the server's JSONL uses SDK-assigned IDs. Content/position-based matching (ADR-0145) is an interim bridge, but Slack and other chat systems use the industry-standard "client-ID propagation" pattern: include `clientMessageId` in the request, have the server echo the JSONL-assigned `messageIds` in the `done` event, then remap client IDs to server IDs.

## Decision

Implement the three-phase client-ID propagation approach. Phase 3: Add optional `clientMessageId` field to the streaming request body. After streaming, extract the JSONL-assigned IDs from `getLastMessageIds()` and include them in the `done` SSE event payload. On the client, update message IDs when the done event provides them. This replaces content/position matching with exact ID-based dedup.

## Consequences

### Positive

- Industry-standard pattern used by Slack, RTK Query, and others
- Provides exact ID mapping via server-generated `messageIds` in done event
- Backward compatible — falls back to tagged-dedup when `messageIds` absent
- Eliminates need for content/position matching heuristics
- Enables precise client-server synchronization

### Negative

- Requires extending the `AgentRuntime` interface with `getLastMessageIds()` method
- Adds server-side transcript parsing after streaming completes (minor performance cost)
- Both client and server changes needed — can't ship independently
- Depends on Phase 1 (\_streaming flag infrastructure) already being in place
- Requires Transport interface extension for `clientMessageId` parameter
