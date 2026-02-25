---
number: 14
title: Use Sliding Window Log for Relay Rate Limiting
status: proposed
created: 2026-02-24
spec: relay-advanced-reliability
superseded-by: null
---

# 14. Use Sliding Window Log for Relay Rate Limiting

## Status

Proposed (auto-extracted from spec: relay-advanced-reliability)

## Context

The Relay module needs per-sender rate limiting to prevent message flooding. Four algorithms were evaluated: fixed window counter, token bucket, sliding window log, and sliding window counter (hybrid). The key constraint is that the existing SQLite `messages` table already stores `sender` and `created_at` columns — rate limit state can potentially be derived from this existing data rather than requiring an auxiliary state table.

## Decision

Use a sliding window log algorithm derived from the existing `messages` SQLite table. Rate limit checks are a single prepared statement (`SELECT COUNT(*) FROM messages WHERE sender = ? AND created_at > ?`) with a new composite index on `(sender, created_at DESC)`. No auxiliary tables are created.

## Consequences

### Positive

- Zero additional state — rate limit data is derived from the source of truth (messages table)
- Automatically recovers after restart with no in-memory warmup needed
- Implementation is ~15 lines of TypeScript plus one prepared SQL statement
- Perfect accuracy — the sliding window always represents exactly the configured time period

### Negative

- Index scan touches more rows for high-frequency senders (negligible for a local system with dozens of agents)
- Requires a new composite index in the SQLite migration (minor schema addition)
- Cannot model burst capacity separately from sustained rate (unlike token bucket)
