---
number: 28
title: Store Message Traces in Existing Relay SQLite Index
status: proposed
created: 2026-02-25
spec: relay-convergence
superseded-by: null
---

# 0028. Store Message Traces in Existing Relay SQLite Index

## Status

Proposed (auto-extracted from spec: relay-convergence)

## Context

End-to-end message tracing requires persistent storage for trace spans (message lifecycle from send through delivery to processing). DorkOS already has a SQLite database at `~/.dork/relay/index.db` used by the Relay subsystem for message indexing. A separate trace database would add operational complexity and make it harder to correlate traces with message data.

## Decision

Add a `message_traces` table to the existing `~/.dork/relay/index.db` SQLite database with OpenTelemetry-inspired fields (traceId, spanId, parentSpanId, status, timing). Trace writes are wired into RelayCore's publish/delivery lifecycle via a TraceStore service that subscribes to delivery events. Live SQL aggregates provide delivery metrics (latency, DLQ depth, throughput) — no pre-computed counters needed at DorkOS single-user scale.

## Consequences

### Positive

- No additional database files — reuses existing SQLite infrastructure
- Trace queries can join with message index data if needed
- Schema migration uses the same `PRAGMA user_version` pattern as PulseStore
- WAL mode provides concurrent read/write without blocking

### Negative

- Trace writes add ~0.1-0.5ms per message (negligible vs LLM latency)
- Single database grows faster — may need retention pruning for traces
- Tightly couples trace storage to Relay's storage lifecycle
