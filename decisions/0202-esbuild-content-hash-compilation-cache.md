---
number: 202
title: Content-Hash-Based esbuild Compilation Cache for Extensions
status: draft
created: 2026-03-26
spec: ext-platform-03-extension-system
superseded-by: null
---

# 202. Content-Hash-Based esbuild Compilation Cache for Extensions

## Status

Draft (auto-extracted from spec: ext-platform-03-extension-system)

## Context

TypeScript extensions are compiled with esbuild at enable time. esbuild has no built-in persistent file-based cache between process runs. The server needs a caching strategy that avoids recompiling unchanged extensions on every startup. Options: mtime-based invalidation, content hash, or no cache (always recompile). mtime is unreliable across filesystem copies and git operations.

## Decision

Use SHA-256 content hash (first 16 hex chars) of the source file as the cache key. Compiled bundles are stored at `{dorkHome}/cache/extensions/{ext-id}.{content-hash}.js`. Compilation errors are cached as `{ext-id}.{hash}.error.json` to avoid recompiling known-broken extensions. Stale cache entries (not accessed in 7+ days) are pruned on server startup.

## Consequences

### Positive

- Robust against filesystem copies, git checkouts, and timestamp changes
- Automatic invalidation when source changes (different hash = cache miss)
- Compilation errors cached — broken extensions don't waste CPU on every startup
- Central cache directory is easy to wipe for a clean slate

### Negative

- Old cached versions accumulate (mitigated by 7-day stale pruning)
- Content hash doesn't capture changes in extension's local `node_modules/` (acceptable for v1 where most extensions are self-contained)
