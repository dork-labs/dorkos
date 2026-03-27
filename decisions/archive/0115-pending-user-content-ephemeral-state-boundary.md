---
number: 115
title: Separate pendingUserContent Ephemeral State from JSONL-Sourced Messages Array
status: proposed
created: 2026-03-11
spec: fix-chat-ui-reliability-bugs
superseded-by: null
---

# 115. Separate pendingUserContent Ephemeral State from JSONL-Sourced Messages Array

## Status

Proposed

## Context

ADR-0003 establishes that SDK JSONL transcripts are the single source of truth for session message history. However, `use-chat-session.ts` was adding an optimistic user message to the `messages` array (with a client-generated `crypto.randomUUID()` id) before Relay confirmed delivery. This had two failure modes: (A) if delivery failed post-202, the bubble vanished on page reload since no JSONL entry exists, and (B) the client-generated id never matched the SDK-assigned JSONL id, so the existing deduplication logic could not reconcile them — causing transient duplicate user bubbles when `sync_update` triggered a history refetch near the streaming `done` event.

Two alternatives were considered: content-hash deduplication (fragile — fails when `transformContent` modifies message text, fails for consecutive identical messages) and React 19 `useOptimistic` (settles on 202 ACK before streaming begins, known bugs #31967/#30637 cause unexpected rollbacks).

## Decision

The `messages` array contains only JSONL-sourced entries — no optimistic entries ever. Immediate user feedback is provided via a separate `pendingUserContent: string | null` state in `useChatSession`. It is set to the submitted content on submit and cleared on the first streaming `text_delta` event (delivery confirmed) or on error. `pendingUserContent` is threaded through `ChatPanel` → `MessageList` as a prop and rendered as a visually distinct "pending" bubble below JSONL-sourced messages. The empty-state guard accounts for the case where `messages.length === 0` but `pendingUserContent !== null`.

## Consequences

### Positive

- Full compliance with ADR-0003: `messages` array is always JSONL-authoritative
- Eliminates transient duplicate user bubbles during multi-tool streaming (no optimistic entry to dedup)
- User message visibility is consistent between live streaming and page reload
- No fragile heuristics (content hash matching, id reconciliation)
- Immediate visual feedback preserved (pending bubble appears on submit)

### Negative

- `pendingUserContent` must be threaded as a prop through the component tree (`useChatSession` → `ChatPanel` → `MessageList`)
- The pending bubble requires distinct styling to signal in-flight state; this styling must be maintained alongside the confirmed-message styling
- The clearing logic (on `text_delta`) requires either a ref to avoid closure staleness or clearing at `done` (slightly less responsive)
- The pattern does not generalize to multi-file or rich-content user messages — those would need `pendingUserParts` rather than `pendingUserContent: string | null`
