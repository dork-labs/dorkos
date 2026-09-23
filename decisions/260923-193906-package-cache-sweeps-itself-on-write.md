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

ADR-0232 made the package cache content-addressable and immutable, and nothing ever removed an entry: `MarketplaceCache.prune({ keepLastN })` had no automatic caller and, grouping by name, would have deleted the commit an install records as soon as a newer one was staged. The update check (DOR-2244) stages every new commit it sees, and polling (DOR-2194, DOR-2196) would turn that into unbounded growth. A reader (install, preview, update check) holds an entry's path only for the seconds it takes to validate or copy the tree, and every reader is in the one server process that holds the data directory (`lib/instance-lock.ts`). Project installs live in project folders the server only knows through the agent registry, which misses unregistered folders.

## Decision

An entry is kept when it was used in the last 15 minutes (every cache call that hands out a path stamps the entry's mtime, best-effort), when an installation records its commit (matched by commit and subfolder digest, not by name), or when it is the most recently used entry, among those not already kept for being recorded, of a package that is installed. Everything else is removed. The cache's write path notifies a retention owner after each new entry lands, and the owner runs one coalesced sweep; it also sweeps once at startup and on `dorkos cache prune`, which loses its `--keep-last-n` option. What installs record is read strictly — global roots, registered agents' projects, and a record of every project install that the installer writes under dorkHome — and anything unreadable stops the sweep rather than shrinking what it keeps. In the process, "check and stamp" and "re-check and rename aside" share one lock; a removed entry is renamed to `.tmp-prune-*` before it is deleted.

## Consequences

### Positive

- The cache is bounded by what is installed (about two entries per installed package), however often anything polls.
- The commit an install records stays available offline for rebuilding its file record (DOR-2245), and a staged update is applied from the tree the check validated.
- One door for growth and one owner for collection: no timer, no daemon, no disk-budget setting. The installer gains one best-effort call; the update and uninstall flows are untouched.
- A failed read, an unplugged drive or a mesh outage stops a sweep instead of deleting what an install needs.

### Negative

- Uninstalling frees disk only at the next sweep.
- A registered agent whose project folder is missing stops every sweep until the folder returns or the registry drops the agent. The mesh reconciler removes an unreachable agent after 24 hours, so this pause normally ends within a day. A corrupt sidecar stops sweeps until it is fixed. Every pause is logged once per reason and shown by `dorkos cache list` (`GET /api/marketplace/cache` → `cleanup`).
- A project-install record that does not parse stops sweeps until the next project install, which moves it aside (`project-installs.json.corrupt-<time>`) and starts a fresh record. That keeps installs recordable, at the price of forgetting what the bad file held; those installs fall back to the agent registry. Writes are fsynced before their atomic rename, so a crash should not produce one.
- The record of a project whose folder was deleted stays, because it cannot be told apart from a drive that is not plugged in, and it keeps its commit's tree: a small leak, bounded by one tree per such install.
- Project installs made before the project-install record existed, in folders that are not registered agents, are not protected.
- After an update is applied, the superseded tree may stay until the next update is staged.
- `POST /api/marketplace/cache/prune` no longer accepts `keepLastN`, answers 503 when it cannot read every install, and its response field `cachedAt` is now `lastUsedAt`.
