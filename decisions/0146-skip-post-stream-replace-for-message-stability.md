---
number: 146
title: Skip Post-Stream Replace for Message Stability
status: superseded
created: 2026-03-19
spec: streaming-message-integrity
superseded-by: 264
---

# 0146. Skip Post-Stream Replace for Message Stability

## Status

Superseded by ADR-0264 (Server-Owned Durable, Resumable Per-Session Stream (Turn Decoupled from POST)) — the post-stream seed/replace path no longer exists; turn delivery and eventual consistency ride the durable snapshot+replay session stream.

## Context

After streaming completes, `executeSubmission` resets `historySeededRef.current = false` and calls `queryClient.invalidateQueries({ queryKey: ['messages'] })`. This invalidation triggers a background refetch with stale data (the refetch hasn't returned yet), causing the seed effect to run `setMessages(history.map(mapHistoryMessage))` — a full replace. Messages visibly flash because they briefly vanish, then reappear when fresh data arrives.

The replace was added to handle ID mismatch, but it's the wrong solution.

## Decision

Remove the post-stream reset sequence. Stop resetting `historySeededRef.current = false` after streaming. Let the incremental append path handle eventual consistency via the existing polling interval. Use tagged-dedup (ADR-0145) to reconcile IDs without replacing the message list.

## Consequences

### Positive

- Eliminates message flash on stream completion (no stale-data replace)
- Removes unnecessary background query invalidation (one fewer network request)
- Allows error/subagent/hook parts to persist (no data loss on replace)
- Aligns with TanStack Query best practices (avoid invalidation mid-mutation)
- Makes the incremental append path the default behavior

### Negative

- Breaks the current "seed effect Branch 1" (full replace) flow — must rewrite Branch 2 (incremental) with tagged dedup
- Session ID remap now requires careful handling to avoid showing duplicate messages during the transition
- Polling interval becomes responsible for eventual consistency (not immediate)
