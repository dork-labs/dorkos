---
number: 149
title: Three-Phase Implementation for Streaming Message Integrity
status: archived
created: 2026-03-19
spec: streaming-message-integrity
superseded-by: null
---

# 0149. Three-Phase Implementation for Streaming Message Integrity

## Status

Draft (auto-extracted from spec: streaming-message-integrity)

## Context

The streaming message integrity problem involves three overlapping concerns: message flash on stream completion (Bug 1), disappearing error messages (Bug 2), and data loss when loading past sessions from disk. These can be fixed with three independent phases, but they build on each other.

## Decision

Implement a three-phase approach: Phase 1 (client-only, fixes both bugs immediately) with tagged-dedup; Phase 2 (server-side, independent) to extend the transcript parser; Phase 3 (client + server, depends on Phase 1) to implement server-echo ID. This allows shipping fixes incrementally without blocking on any single phase.

## Consequences

### Positive

- Phase 1 can ship immediately without server changes
- Phase 2 is independent — can be shipped in parallel with Phase 1
- Phase 3 depends only on Phase 1 infrastructure — not blocked by Phase 2
- Fixes both user-visible bugs (flash, error vanishing) in Phase 1
- Fixes data loss bug in Phase 2
- Provides long-term solution (exact ID dedup) in Phase 3
- Allows iterative shipping and testing

### Negative

- Developers must understand three separate phases and their dependencies
- Phase 1 uses interim content/position matching (not the final solution)
- Phase 3 requires both client and server coordination
- Adds complexity to the implementation timeline
- Risk of shipping Phase 1 without intending to complete Phases 2 and 3
