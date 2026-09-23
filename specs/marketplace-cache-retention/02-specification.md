---
slug: marketplace-cache-retention
number: 260923-193637
created: 2026-09-23
status: implemented
---

# Keep the marketplace package cache small without losing what installs need

**Status:** Draft
**Author:** Claude Code (DOR-2249)
**Date:** 2026-09-23

## Overview

The marketplace package cache (`<dorkHome>/cache/marketplace/trees/`) only ever grows. This spec gives it a retention rule and an owner: the cache sweeps itself after every new entry lands, once at startup, and when a person runs `dorkos cache prune`. A sweep keeps what an install records, the newest entry of every installed package, and anything used in the last 15 minutes, and removes the rest.

## Background / Problem Statement

- Every fetch of a new commit adds one entry, `<name>@<sha>` or `<name>@<sha>~<digest12>` (DOR-2248). Nothing removes entries: `MarketplaceCache.prune` (`marketplace-cache.ts`) has no automatic caller.
- The update check (DOR-2244) stages the new commit of every package whose source moved. With polling (DOR-2194's all-packages check, DOR-2196's schedule), each commit to a marketplace repository adds one entry per installed package from it, for ever.
- The existing `prune({ keepLastN = 1 })` is not safe to automate. It groups by name only and keeps the newest by mtime, so as soon as a check stages a newer commit it deletes the commit the install records, which DOR-2245 needs to rebuild an install's file record, and which may no longer exist upstream after a force-push. It also groups a whole-repository entry with a subfolder entry of the same name, and it can delete a tree a request is reading.

## Goals

- The cache is bounded by what is installed, not by time or by how often anything checks for updates.
- A tree an install records stays on disk while that install exists (when the install is visible to the server).
- A staged update stays on disk until it is applied or superseded, so applying reuses the tree the check validated.
- No request ever loses the tree it is reading, in this process or another one sharing the data directory.
- One rule, one owner, one code path for automatic and manual pruning.

## Non-Goals

- No timer, daemon or disk budget (Decisions 4 and 5 in the ideation).
- No edits to `marketplace-installer.ts`, `flows/update.ts` or `flows/uninstall.ts` (DOR-2194 and DOR-2273 are landing there).
- The `marketplaces/` half of the cache is unchanged.
- Not changing `removeLeftovers()`'s startup deletion of `.tmp-fetch-*` directories.

## Technical Dependencies

- Node `fs/promises` (`utimes`, `rename`, `rm`, `stat`), `node:crypto` `randomUUID`. No new packages.

## Detailed Design

### The rule

An entry is **kept** when any of these holds; otherwise a sweep removes it.

1. **In use.** Its last use was less than `IN_USE_GRACE_MS` (15 minutes) ago. Every cache call that hands out an entry's path stamps the entry's mtime with the current time: `getPackage` on a hit, `materializePackage`'s fast path, and the promote at the end of a fetch. A reader copies or validates the tree within seconds, so 15 minutes is a wide margin. Because the stamp is on disk, a second DorkOS process sharing the data directory is covered too. This part of the rule lives in `MarketplaceCache` and cannot be switched off: it is the cache's promise to whoever it handed a path.
2. **Recorded.** Some installation's `install-metadata.json` records its commit: `commitSha` equals the entry's commit and, when the sidecar has a `sourceKey`, `subpathDigest(sourceKey.subpath)` equals the entry's digest. A sidecar with a commit but no `sourceKey` (written before DOR-2244) protects every entry at that commit. Matching ignores the package name on purpose: a direct git install keys the cache by the name a person typed, while the sidecar records the manifest's name. A commit id is content-addressed, so this keeps the right tree and at most a same-commit sibling.
3. **Newest of an installed package.** Group entries by `(packageName, subpathDigest)`. In each group that an installation belongs to (`name` equals the group's name, and the subfolder digest matches when the sidecar has a `sourceKey`), keep the most recently used entry. That is the staged update when one is pending, and the installed commit otherwise. Groups no installation belongs to (packages previewed but never installed, packages since uninstalled) keep nothing beyond rule 1.

So the cache holds at most two entries per installed package, plus whatever was used in the last 15 minutes.

### Who sweeps, and when

- **After every new entry.** `MarketplaceCache` notifies its write listener after a fetch renames a new entry into place (not on a cache hit, and not when another process had already landed the same entry). The retention owner requests a sweep. The cache grows through this one door, so the sweep runs exactly as often as growth happens, whoever wrote: an update check, a poll, an install, a preview, or DOR-2245's `fetchAtCommit`.
- **Once at startup,** in the background, after `removeLeftovers()` has run.
- **On demand:** `POST /api/marketplace/cache/prune` and `dorkos cache prune` run the same sweep and report what it removed.
- **Coalesced:** at most one sweep runs and at most one waits. A request made while a sweep runs joins the waiting one; an on-demand caller gets that sweep's result. A 20-package update check therefore costs one or two sweeps, not twenty.
- Uninstalling frees nothing until the next sweep. Uninstall does not add entries, so the lag costs disk only.

### Safety against concurrent readers and writers

- `MarketplaceCache` holds an in-process lock (a promise chain) around two short critical sections: "check the entry exists and stamp it" (both read paths and the promote) and "re-check the stamp, then rename the entry aside" (the sweep). A sweep can therefore never remove an entry between a reader's existence check and its stamp. Once stamped, rule 1 protects it for 15 minutes.
- A sweep removes an entry by renaming it to `trees/.tmp-prune-<uuid>` (atomic) and then deleting that directory outside the lock. `removeLeftovers()` also deletes `.tmp-prune-*` directories a crash left behind.
- A sweep only considers directories that parse as entries; `.tmp-fetch-*` and `.tmp-prune-*` are never candidates.
- Across processes the stamp is the only guard; the remaining window is between another process's existence check and its stamp (a few system calls). Accepted and documented.

### Failure handling

- If listing installations throws, the sweep removes nothing and logs a warning. A background sweep never throws; its errors are logged.
- An agent project the server cannot read (an unmounted drive, say) is skipped by the installation scan, so its installs protect nothing. Accepted: every entry can be fetched again by commit, which is what DOR-2245 does.
- A failure removing one entry is logged and the sweep continues.

### Code structure

- `apps/server/src/services/marketplace/marketplace-cache.ts`
  - `CachedPackage.cachedAt` is renamed `lastUsedAt` (the mtime now means last use) and gains `subpathDigest` (`''` for a whole-repository entry).
  - New exported `IN_USE_GRACE_MS` and exported `subpathDigest(subpath)` (returns `''` for `''`, used by `packageDir` and the policy).
  - `getPackage` and `materializePackage` stamp under the lock; `fetchAndPromote`'s land step runs under the lock and stamps, then notifies.
  - New `onEntryWritten(listener): () => void`.
  - New `removeUnused(keep: (entries) => ReadonlySet<string>): Promise<{ removed; freedBytes; failed }>`: lists entries once, asks `keep` for the paths to keep, and for each other entry, under the lock, re-stats and renames it aside only if its stamp is older than `IN_USE_GRACE_MS`; then measures and deletes it. An entry that cannot be removed is reported in `failed` (the owner logs it) and the rest continue.
  - `prune({ keepLastN })` is removed (superseded; its only caller was the route).
  - `removeLeftovers()` also removes `.tmp-prune-*`.
- `apps/server/src/services/marketplace/lib/directory-size.ts` (new): `directorySize(root)`, moved from the route's private `sumDirectorySize` so the cache can report freed bytes; the route's status endpoint imports it.
- `apps/server/src/services/marketplace/package-cache-retention.ts` (new)
  - `RecordedTree { name; commitSha; subpath?: string }`.
  - `listRecordedTrees(dorkHome, agents)`: every installation across scopes (`scanInstallationsAcrossScopes`), its sidecar read with `readInstallMetadata`; installs without a real `commitSha` contribute nothing.
  - `keepRule(entries, recorded): ReadonlySet<string>` (paths to keep): rules 2 and 3, pure.
  - `PackageCacheRetention` with `start()` (subscribe to writes, sweep once in the background) and `sweep()` (coalesced; returns `{ removed, freedBytes }`).
- `apps/server/src/index.ts`: construct `PackageCacheRetention` beside the cache (after `listAgentScopes` exists), `start()` it, pass it to the router.
- `apps/server/src/routes/marketplace.ts`: new required dep `cacheRetention`; `POST /cache/prune` calls `cacheRetention.sweep()`; its body takes no options.

### API changes

- `POST /api/marketplace/cache/prune`: body must be empty or `{}`; any key (including the old `keepLastN`) is a 400. Response `{ removed: [{ packageName, commitSha, path, lastUsedAt }], freedBytes }` (`cachedAt` renamed `lastUsedAt`). OpenAPI registry and `docs/api/openapi.json` updated.
- CLI: `dorkos cache prune` takes no options; `--keep-last-n` is gone (an unknown-option error names the usage).

### Data model changes

None on disk beyond the new meaning of an entry directory's mtime (last use rather than fetch time).

## User Experience

- Nothing to do: the cache stays small by itself. A person who checks disk use sees roughly two copies per installed package at most.
- `dorkos cache prune` prints `Removed 3 cached packages, freed 4.2 MB.`, or `Nothing to remove. Everything cached belongs to an installed package or was used in the last 15 minutes.`
- `dorkos cache clear` is unchanged and remains the way to empty the cache entirely.

## Testing Strategy

Each test carries a purpose comment.

- **Unit, `marketplace-cache.test.ts`:** `getPackage` and the fast path stamp mtime; `removeUnused` removes what `keep` rejects and reports freed bytes; spares an entry stamped inside the grace even when `keep` rejects it; never touches `.tmp-fetch-*`; a concurrent `getPackage` and `removeUnused` on a stale entry never leave `getPackage` holding a deleted path; `onEntryWritten` fires on a promote and not on a hit; `removeLeftovers` deletes `.tmp-prune-*`; `listPackages` reports `subpathDigest`.
- **Unit, `package-cache-retention.test.ts`:** `keepRule` keeps a recorded commit whatever the entry's name, matches the subfolder digest when recorded and every digest when not, keeps the newest entry of an installed group and not of an uninstalled one, and treats a whole-repository and a subfolder entry of one name as separate groups. `listRecordedTrees` reads global and agent-scope sidecars and skips installs without a commit. `PackageCacheRetention`: a sweep removes an unneeded entry and keeps a recorded one end to end on disk; two concurrent `sweep()` calls while one runs share one extra sweep; a write triggers a sweep; a failing installation scan removes nothing and warns.
- **Route, `routes/__tests__/marketplace.test.ts`:** `POST /cache/prune` returns the sweep's result with `lastUsedAt`, and rejects `{ keepLastN: 1 }`.
- **CLI, `cache-commands.test.ts`:** `prune` posts an empty body, rejects `--keep-last-n`, and prints both messages.
- **Mocking:** real temp directories for the cache and scopes (the existing pattern); no git.

## Performance Considerations

A sweep lists `trees/`, scans installations (a few directory reads per scope) and reads one small JSON per install. It runs after a network fetch, which costs far more, and coalescing caps it at two per burst.

## Security Considerations

Sweeps only delete directories that parse as entries directly under `trees/`, or the `.tmp-prune-*` directories they renamed there. Sidecar values only ever cause an entry to be KEPT; they never name a path to delete.

## Documentation

- `contributing/marketplace-installs.md`: cache section (retention rule, owner, grace), API table row, the `--keep-last-n` note.
- `contributing/api-reference.md`: the prune row.
- `docs/guides/cli-usage.mdx`: the `dorkos cache prune` line.
- `docs/api/openapi.json`: regenerated.
- Changelog fragment under `changelog/unreleased/`.
- Draft ADR: "The marketplace package cache keeps what installs need and sweeps itself on write".

## Implementation Phases

- **Phase 1:** cache mechanism (stamp, lock, `removeUnused`, write listener, leftovers), the retention module, wiring, route, CLI, docs.

## Open Questions

- ~~Should a pending update survive by being "newest unrecorded" rather than "most recently used"?~~ (RESOLVED) **Answer:** most recently used. **Rationale:** "newest unrecorded" keeps an old superseded entry for ever once the update is applied; the cost of "most recently used" is only a refetch in the rare case the recorded commit was used after the update was staged.
- ~~Should uninstall trigger a sweep?~~ (RESOLVED) **Answer:** no. **Rationale:** it would edit `flows/uninstall.ts` (DOR-2273's area) to reclaim disk a few minutes sooner; the next write or restart does it.

## Related ADRs

- ADR-0232 (content-addressable package cache), amended by `260923-162950` (entries keyed by the verified checkout, DOR-2248).
- `260923-193906` (draft, this spec): the package cache keeps what installs need and sweeps itself on write.

## References

- DOR-2249 (this), DOR-2244 (update check stages new commits), DOR-2248 (cache layout), DOR-2245 (`fetchAtCommit` of the recorded commit), DOR-2194 / DOR-2196 (polling), DOR-2273 (crash-recovery janitor).
- git gc's `gc.pruneExpire` grace period: the prior art for "spare anything touched recently" as the guard against concurrent readers.
