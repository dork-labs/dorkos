---
number: 145
title: Use _streaming Boolean Flag for Client-ID Dedup
status: accepted
created: 2026-03-19
spec: streaming-message-integrity
superseded-by: null
---

# 0145. Use \_streaming Boolean Flag for Client-ID Dedup

## Status

Accepted

## Context

During streaming, the client creates messages with `crypto.randomUUID()` IDs. The server's JSONL transcript uses different SDK-assigned IDs. Without ID reconciliation, incremental append dedup treats them as duplicates because they have different IDs. The post-stream history replace was added to swap client IDs for server IDs, but this causes messages to flash and error parts to vanish.

## Decision

Add an optional `_streaming: boolean` field to the `ChatMessage` interface following the existing underscore-prefix convention for client-only fields (established in ADR-0114 with `_partId`). Tag user and assistant messages on creation. Use the tagged flag to perform smart dedup in the seed effect: match by content (user) and position (assistant), then clear the flag.

## Consequences

### Positive

- Eliminates the post-stream replace without losing data (no flash, no error part vanishing)
- Enables incremental append path to work correctly during streaming recovery
- Small, bounded set (0-2 messages) makes content/position matching performant
- Follows established underscore-prefix convention for internal fields
- Tags are cleared on match — no unbounded growth

### Negative

- Requires rewriting the seed effect's incremental append logic to handle tagged dedup
- Content matching is an interim solution; server-echo ID (Phase 3) is the long-term fix
- Adds client-side matching heuristic that depends on message ordering
