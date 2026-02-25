---
number: 23
title: Use Custom Async BFS for Agent Discovery
status: proposed
created: 2026-02-24
spec: mesh-core-library
superseded-by: null
---

# 23. Use Custom Async BFS for Agent Discovery

## Status

Proposed (auto-extracted from spec: mesh-core-library)

## Context

The Mesh discovery engine needs to scan developer home directories (5,000-50,000 dirs) to find agent projects by filesystem markers. We evaluated fast-glob, Node.js glob, and custom BFS approaches. fast-glob has a documented symlink cycle bug that can cause out-of-memory crashes. Node.js glob lacks the ability to yield candidates as they're found (streaming) and to filter by registry/denial state mid-scan.

## Decision

Use a custom async BFS implementation with an explicit queue, `Set<realpath>` for symlink cycle detection, and `AsyncGenerator` for streaming results. The engine supports pluggable `DiscoveryStrategy` implementations, depth limiting (default 5), excluded directory sets, and mid-scan filtering against the agent registry and denial list.

## Consequences

### Positive

- Explicit cycle detection via `fs.realpathSync()` prevents infinite loops and OOM from symlink cycles
- AsyncGenerator allows callers to process candidates incrementally without buffering all results
- Mid-scan filtering (denied paths, already-registered paths) avoids unnecessary work
- Full control over traversal behavior (depth, exclusions, error handling)

### Negative

- More code to maintain than using an existing glob library
- Must handle EACCES/EPERM errors manually (silently skip)
- No built-in glob pattern matching — strategies must implement their own detection logic
