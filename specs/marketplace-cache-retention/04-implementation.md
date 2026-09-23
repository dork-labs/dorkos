# Implementation summary: marketplace-cache-retention (DOR-2249)

**Base:** `2f901e390` (origin/main, includes DOR-2248). **Branch:** `DOR-2249`.

## What shipped

- `apps/server/src/services/marketplace/marketplace-cache.ts`: entries are stamped as used (mtime) by `getPackage`, the `materializePackage` fast path and the landing of a fetch, under an in-process lock. New `removeUnused(keep)` (re-checks the 15-minute `IN_USE_GRACE_MS` under the lock, renames aside to `.tmp-prune-*`, then deletes and measures), `onEntryWritten(listener)`, exported `subpathDigest`. `CachedPackage.cachedAt` became `lastUsedAt` and gained `subpathDigest`. `prune({ keepLastN })` removed. `removeLeftovers` also deletes `.tmp-prune-*`.
- `apps/server/src/services/marketplace/package-cache-retention.ts` (new): `listRecordedTrees`, the pure `keepRule`, and `PackageCacheRetention` (`start()`, coalesced `sweep()`).
- `apps/server/src/services/marketplace/lib/directory-size.ts` (new): moved from the route.
- `apps/server/src/index.ts`: owner constructed and started beside the cache; passed to the router.
- `apps/server/src/routes/marketplace.ts`: `POST /cache/prune` runs the owner's sweep, takes no options (strict), returns `lastUsedAt`.
- `apps/server/src/services/core/openapi-registry.ts`, `docs/api/openapi.json`: the new contract.
- `packages/cli/src/commands/cache-commands.ts`, `cache-dispatcher.ts`: `dorkos cache prune` takes no options.
- Docs: `contributing/marketplace-installs.md` (section 8 retention, update-flow known limits, API table, CLI notes), `contributing/api-reference.md`, `docs/guides/cli-usage.mdx`. Changelog fragment `260923-200604-package-cache-tidies-itself.md`. Draft ADR `260923-193906`.

## Deviations from the spec

- `removeUnused` takes a function of the whole listing that returns paths to keep (rule 3 compares entries within a group), and reports per-entry failures in `failed` for the owner to log; the cache stays logger-free.

## Review round 1 (all adopted)

1. Strict read of what installs record (`listRecordedTrees` in `package-cache-retention.ts`, `readInstallMetadataStrict` in `installed-metadata.ts`, sharing the lenient reader's parser): unreadable roots, unreadable or unparseable sidecars, a missing registered-agent project, a corrupt project-install record, or no agent registry stop the sweep (`UnreadableInstallsError`; `POST /cache/prune` answers 503).
2. `lib/directory-size.ts` never follows symlinks (withFileTypes, depth-bounded); the status endpoint shares it.
3. Stamping is best-effort (`stampUsed` keeps the old time on EPERM/EROFS/EACCES).
4. Rule 3 picks the newest among entries rule 2 does not keep.
5. New `lib/project-install-index.ts` (`<dorkHome>/marketplace/project-installs.json`): `MarketplaceInstaller.install` calls `recordProjectInstall` after the sidecar for any install inside a project; the sweep drops a record only when its project exists and its install root does not.
6. `cli.ts` comment; cross-process reasoning replaced by the instance lock in the ADR, spec, guide and code.

## Review round 2 (all adopted)

- A: `forgetProjectInstalls` takes the records the sweep read and is a compare-and-delete inside the write chain (install folder still missing, project present, same install root and commit). The review's repro (record b, sweep marks it gone, a reinstall records c, then the drop) is a test.
- B: index writes are fsynced before the rename; an unparseable index is moved aside to `.corrupt-<time>` by the next `recordProjectInstall` (never by a sweep); sweep-level test for a corrupt index.
- E: `PackageCacheRetention.status()`; `GET /cache` returns `cleanup: { paused, reason, since }`; `dorkos cache list` prints the pause; the pause is logged once per reason.
- ADR: deleted-project records leak one tree each; the 24-hour mesh removal ends a missing-agent pause.
- Not unit-testable: the fsync (a mutation removing it survives; crash durability needs a power-cut test).

## Coordination

- Touched in shared files: `marketplace-installer.ts` (one import, the `recordProjectInstall` block after the sidecar's try/catch in `install()`, and the `isInsideDir` helper at the end of the file), `installed-metadata.ts` (reader split into `parseInstallMetadata` + new `readInstallMetadataStrict`), `routes/marketplace.ts` (the `cacheRetention` dep and the prune handler), `index.ts` (construction beside `listAgentScopes`). `flows/update.ts` and `flows/uninstall.ts` are untouched (DOR-2194 / DOR-2273).

## Notes for dependent work

- DOR-2245: the recorded commit's entry is kept whatever name it was cached under, but `getPackage`/`fetchAtCommit` only hit it when called with the name the cache used (`resolved.packageName` at install time, normally the manifest name).
