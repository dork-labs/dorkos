---
number: 13
title: Use Hybrid Maildir + SQLite for Relay Storage
status: proposed
created: 2026-02-24
spec: relay-core-library
superseded-by: null
---

# 0013. Use Hybrid Maildir + SQLite for Relay Storage

## Status

Proposed (auto-extracted from spec: relay-core-library)

## Context

Relay needs both durable message storage and efficient querying (by subject, status, expiry). A single storage system would compromise one concern: pure Maildir lacks query capability, pure SQLite lacks atomic delivery guarantees and file inspectability. DorkOS already uses this dual pattern: JSONL transcript files as truth with programmatic reading on top.

## Decision

Use Maildir as the source of truth for message persistence and SQLite (better-sqlite3, WAL mode) as a derived index for queries. The SQLite index is fully rebuildable from Maildir files — if the database corrupts, `rebuildIndex()` reconstructs it by scanning all mailbox directories.

## Consequences

### Positive

- Single source of truth (files) with fast querying (SQLite) — best of both
- Index corruption is recoverable without data loss
- Follows existing DorkOS pattern (JSONL files + programmatic reading)
- SQLite WAL mode enables concurrent reads during writes
- Messages remain inspectable with filesystem tools

### Negative

- Two storage systems to keep in sync — potential for drift if writes fail mid-pipeline
- More disk I/O than a single-store approach (write file + write index)
- Rebuild operation scans entire Maildir — slow for large message volumes
