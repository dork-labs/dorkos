---
number: 12
title: Use ULID for Relay Message IDs
status: proposed
created: 2026-02-24
spec: relay-core-library
superseded-by: null
---

# 0012. Use ULID for Relay Message IDs

## Status

Proposed (auto-extracted from spec: relay-core-library)

## Context

Relay message IDs need to be unique, sortable, and usable as Maildir filenames. Three options were evaluated: UUIDv4 (random, no ordering), UUIDv7 (timestamp-ordered, RFC 9562, 36 chars), and ULID (timestamp-ordered, 26-char Crockford Base32). The IDs are used as SQLite primary keys, Maildir filenames, and sort keys.

## Decision

Use ULID via the `ulidx` library with `monotonicFactory()` for guaranteed monotonic ordering within the same millisecond. ULID serves triple duty as message ID, Maildir filename, and chronological sort key.

## Consequences

### Positive

- Lexicographic ordering = chronological ordering (free sort in `ls`, SQLite, readdir)
- Sequential B-tree inserts improve SQLite INSERT throughput 2-5x over random UUIDs
- 26-char format is compact (vs 36-char UUID with hyphens)
- Monotonic factory prevents sub-millisecond collisions
- `ulidx` is actively maintained with TypeScript + ESM support

### Negative

- Adds an external dependency (`ulidx`) — though small and well-maintained
- Not an RFC standard (unlike UUIDv7) — less interoperable outside DorkOS
