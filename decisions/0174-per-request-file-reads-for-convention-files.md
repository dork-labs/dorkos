---
number: 174
title: Per-Request File Reads for Convention Files
status: draft
created: 2026-03-22
spec: agent-personality-convention-files
superseded-by: null
---

# 174. Per-Request File Reads for Convention Files

## Status

Draft (auto-extracted from spec: agent-personality-convention-files)

## Context

Convention files (SOUL.md, NOPE.md) need to be read from disk and injected into the system prompt for each agent message. Three caching strategies were evaluated:

1. **Per-request reads** — Read from disk every time sendMessage is called
2. **Cache with invalidation** — Cache in memory with file-system watcher for invalidation
3. **Reconciler-based sync** — Periodic file-to-memory sync via dedicated reconciler task

The goal is to ensure convention file content is always fresh, while keeping implementation simple and avoiding cache bugs.

## Decision

Read convention files from disk **on every sendMessage call**. No caching, no watcher, no reconciler involvement.

### Rationale

**Performance is acceptable:**

- Convention files are small (<6KB total per agent)
- Local disk reads are fast (~1-2ms on modern systems)
- Negligible overhead compared to LLM API latency (>10s per response)

**Simplicity wins:**

- Eliminates cache invalidation bugs entirely
- No watcher-related race conditions
- No stale-content risk
- Easier to reason about and debug

**Aligns with DorkOS philosophy:**

- Direct I/O from canonical source (filesystem) matches ADR-0043 (Agent Storage)
- Consistent with "files as source of truth" pattern

## Consequences

### Positive

- **Always fresh** — Convention files never become stale in memory
- **No stale content risk** — Users can edit files between messages and changes are immediately visible
- **Simple implementation** — Straightforward synchronous or async file reads
- **No cache invalidation bugs** — Eliminates an entire class of concurrency issues
- **Testable** — Easy to mock file reads or use temp files in tests
- **Resilient** — Works correctly even if file permissions or ownership change between calls

### Negative

- **Slightly more I/O** — One additional disk read per message (negligible for local disk)
- **Slower on network storage** — Would be problematic if ~/.dork/ is on a slow NFS mount (but single-user local storage is the design assumption)
- **No performance optimization** — Could cache across multiple calls to the same agent within a single message burst (not implemented)
- **File not found handling** — Must gracefully handle missing SOUL.md or NOPE.md (fallback to empty defaults)
