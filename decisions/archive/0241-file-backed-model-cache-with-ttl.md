---
number: 241
title: File-Backed Model Cache with TTL at ~/.dork/cache/runtimes/
status: draft
created: 2026-04-10
spec: runtime-model-discovery
superseded-by: null
---

# 0241. File-Backed Model Cache with TTL at ~/.dork/cache/runtimes/

## Status

Draft (auto-extracted from spec: runtime-model-discovery)

## Context

Model lists from the Claude Agent SDK are fetched via subprocess and only cached in-memory. Every server restart resets to hardcoded defaults, and the first user request sees stale data. We need persistence across restarts with a staleness mechanism. The existing marketplace cache at `~/.dork/cache/marketplace/` establishes a file-based caching convention.

## Decision

Cache model data to `${dorkHome}/cache/runtimes/{runtime-type}/models.json` with a 24-hour TTL. The lookup chain is: memory cache → disk cache (if fresh) → SDK warm-up query → empty array. Each runtime manages its own cache directory, making the pattern ready for future multi-runtime support.

## Consequences

### Positive

- Most server starts load models from disk in <10ms (no subprocess needed)
- Self-documenting path convention (`cache/runtimes/claude-code/`) makes the data discoverable
- Follows the established `~/.dork/cache/` pattern from marketplace caching
- Runtime-scoped directories prepare for multi-runtime future without current over-engineering

### Negative

- Adds filesystem I/O to the model lookup path (mitigated by memory-first check)
- 24-hour TTL means newly released models could take up to a day to appear (mitigated by message-send refresh)
- Cache files could accumulate if runtime types are removed without cleanup
