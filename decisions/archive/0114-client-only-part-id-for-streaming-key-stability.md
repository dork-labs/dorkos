---
number: 114
title: Client-Only _partId Field for Stable React Keys in Streaming Text Parts
status: proposed
created: 2026-03-11
spec: fix-chat-ui-reliability-bugs
superseded-by: null
---

# 114. Client-Only \_partId Field for Stable React Keys in Streaming Text Parts

## Status

Proposed

## Context

During streaming, the `parts` array in `AssistantMessageContent` is rebuilt on every `text_delta` SSE event (~300 per response). When the array's shape changes (text → tool_call → text), index-based React keys (`key={text-${i}}`) cause collisions. The `TextPartSchema` in `packages/shared/src/schemas.ts` has no `id` field — it is a shared wire protocol schema used by both server transcript parsing and client rendering.

Two alternatives were considered: adding an `id` field to `TextPartSchema` (schema change), or assigning a client-only positional counter string to new text parts at creation time (client-only convention).

## Decision

Assign a `_partId` string (`text-part-${parts.length}`) to new text parts in `stream-event-handler.ts` at the moment of creation. This field is never serialized, never sent over the wire, and never added to `TextPartSchema`. It exists only in the in-memory streaming state. Object spread (`{ ...lastPart, text }`) preserves `_partId` automatically across subsequent delta appends to the same part. `AssistantMessageContent` uses `part._partId ?? text-${i}` as the React key, with the index fallback covering history-loaded messages that bypass the streaming handler.

## Consequences

### Positive

- Zero React reconciliation key collisions during streaming regardless of parts array shape changes
- No wire protocol changes — `TextPartSchema` and server transcript parser remain untouched
- Positional counter string is deterministic and cheap (no `crypto.randomUUID()` overhead)
- Fallback to index key preserves backward compatibility with history-loaded messages

### Negative

- `_partId` is a developer convention, not schema-enforced — requires a comment at the assignment site to explain why it exists
- TypeScript consumers of `TextPart` will not see `_partId` in the type unless they use an intersection type or local extension at the usage site
- The `text-${i}` fallback for history messages is safe only because history arrays don't change shape after load — this assumption must hold
