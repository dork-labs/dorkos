---
number: 84
title: Pending Buffer with TTL for Late Relay Subscribers
status: draft
created: 2026-03-06
spec: fix-relay-sse-delivery-pipeline
superseded-by: null
---

# 84. Pending Buffer with TTL for Late Relay Subscribers

## Status

Draft (auto-extracted from spec: fix-relay-sse-delivery-pipeline)

## Context

Even with subscribe-first handshake, edge cases like reconnects and slow subscribers can cause messages to be published to subjects with no active subscriber. The existing Maildir stores these messages but has no drain mechanism to replay them when a subscriber registers. Messages sit unread forever. A full relay-level message buffering system (option 3 from ideation) was considered but rejected as too complex.

## Decision

Add a lightweight 5-second pending buffer in `SubscriptionRegistry`. When `dispatchToSubscribers()` finds zero subscribers for a subject that has a registered endpoint, buffer the message. When a subscriber registers for that subject, drain buffered messages via `queueMicrotask()`. A 10-second periodic cleanup purges expired entries. This follows Mercure's dual-buffer design pattern — short-lived in-memory buffer for the hot path, persistent Maildir for durability.

## Consequences

### Positive

- Defense-in-depth: catches events during reconnects, slow subscribers, and edge cases
- Bounded memory: 5-second TTL, per-subject scope, ~1KB per event
- Non-blocking: drain uses `queueMicrotask()`, cleanup is periodic

### Negative

- New state in SubscriptionRegistry that must be cleaned up on shutdown
- 5-second window is arbitrary — too short for long reconnects, too long wastes memory (acceptable tradeoff)
