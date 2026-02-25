---
number: 10
title: Use Maildir for Relay Message Storage
status: proposed
created: 2026-02-24
spec: relay-core-library
superseded-by: null
---

# 0010. Use Maildir for Relay Message Storage

## Status

Proposed (auto-extracted from spec: relay-core-library)

## Context

Relay needs persistent message storage with crash-safe delivery guarantees. Two main approaches were evaluated: Maildir (one file per message with atomic POSIX rename) and append-only log (single file with sequential writes, like Kafka/NATS JetStream). The system runs on a single machine as an embedded library, not a distributed broker.

## Decision

Use Maildir protocol (tmp/ -> new/ -> cur/ -> failed/) for message persistence. Each message is one JSON file named by ULID. Delivery atomicity is guaranteed by POSIX `rename()` within the same filesystem. SQLite serves as a derived index (rebuildable from Maildir files).

## Consequences

### Positive

- Crash-safe delivery via atomic rename — no partial writes
- Messages are inspectable with standard tools (`ls`, `cat`, `Glob`, `Read`)
- Aligns with DorkOS's existing pattern: files as truth, programmatic reading on top
- Per-endpoint directories provide natural isolation and access control
- Simple implementation (~150 lines)

### Negative

- Many small files degrade filesystem performance past ~100K per directory
- No built-in compaction — old messages accumulate until explicitly purged
- Slower than append-only log for very high throughput (not a concern for agent messaging)
