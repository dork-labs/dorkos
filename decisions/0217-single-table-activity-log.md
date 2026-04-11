---
number: 217
title: Single-Table Activity Log Over Hybrid Derivation
status: proposed
created: 2026-03-29
spec: activity-feed
superseded-by: null
---

# 0217. Single-Table Activity Log Over Hybrid Derivation

## Status

Proposed

## Context

The activity feed needs to aggregate events from multiple subsystems (Pulse, Relay, Mesh, Extensions, System). We evaluated four approaches: full event sourcing, a single derived activity table, file-based JSONL, and a hybrid that derives some events from existing tables (pulse_runs, relay_traces) while storing config/system events in a new table. The hybrid approach avoids data duplication but requires multi-source merge-sort queries and complex cursor pagination across heterogeneous sources.

## Decision

All activity-producing code paths write a lightweight summary row to a single `activity_events` SQLite table at point of mutation. The activity feed queries this one table with standard cursor-based pagination. Session events are excluded from v1 since they live in SDK-managed JSONL files outside SQLite.

## Consequences

### Positive

- Single table to query — simple pagination, filtering, and indexing
- No multi-source merge-sort complexity in the API endpoint
- Cursor pagination just works (one table, one index on `occurred_at`)
- Incremental rollout — instrument one subsystem at a time

### Negative

- Slight data duplication with `pulse_runs` and `relay_traces` (activity rows store summaries of data that also exists in source tables)
- Must instrument every write path — if a path is missed, the event is invisible in the feed
- Session events require a v2 follow-up since JSONL data can't be written to SQLite at the SDK level
