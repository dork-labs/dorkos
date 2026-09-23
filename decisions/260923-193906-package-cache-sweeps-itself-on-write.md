---
id: 260923-193906
title: The marketplace package cache keeps what installs need and sweeps itself on write
status: draft
created: 2026-09-23
spec: marketplace-cache-retention
superseded-by: null
---

# 260923-193906. The marketplace package cache keeps what installs need and sweeps itself on write

## Status

Draft (extracted from spec: marketplace-cache-retention)

## Context

ADR-0232 made the package cache content-addressable and immutable, and nothing ever removed an entry: `MarketplaceCache.prune({ keepLastN })` had no automatic caller and, grouping by name, would have deleted the commit an install records as soon as a newer one was staged. The update check (DOR-2244) stages every new commit it sees, and polling (DOR-2194, DOR-2196) would turn that into unbounded growth. A reader (install, preview, update check) holds an entry's path only for the seconds it takes to validate or copy the tree, but two DorkOS processes can share one data directory.

## Decision

An entry is kept when it was used in the last 15 minutes (every cache call that hands out a path stamps the entry's mtime), when an installation's sidecar records its commit (matched by commit and subfolder digest, not by name), or when it is the most recently used entry of a package that is installed. Everything else is removed. The cache's write path notifies a retention owner after each new entry lands, and the owner runs one coalesced sweep; it also sweeps once at startup and on `dorkos cache prune`, which loses its `--keep-last-n` option. Within the process, "check and stamp" and "re-check and rename aside" share one lock; a removed entry is renamed to `.tmp-prune-*` before it is deleted.

## Consequences

### Positive

- The cache is bounded by what is installed (about two entries per installed package), however often anything polls.
- The commit an install records stays available offline for rebuilding its file record (DOR-2245), and a staged update is applied from the tree the check validated.
- One door for growth and one owner for collection: no timer, no daemon, no disk-budget setting, and no edits to the installer or update flows.
- The in-use grace works across processes because it lives on disk.

### Negative

- Uninstalling frees disk only at the next write or restart.
- An agent project the server cannot read protects none of its installs' entries; they are fetched again by commit if needed.
- Across processes, a window of a few system calls between another process's existence check and its stamp remains unguarded.
- `POST /api/marketplace/cache/prune` no longer accepts `keepLastN`, and its response field `cachedAt` is now `lastUsedAt`.
