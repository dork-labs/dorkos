---
slug: marketplace-cache-retention
number: 260923-193637
created: 2026-09-23
status: ideation
---

# Keep the marketplace package cache small without losing what installs need

**Slug:** marketplace-cache-retention
**Author:** Claude Code (DOR-2249)
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief (DOR-2249):** nothing ever prunes the marketplace package cache. `MarketplaceCache.prune` exists but has no automatic caller. Once the update check stages new versions (DOR-2244), every marketplace commit a check observes adds one entry per installed package from that repository; the polling that DOR-2194 and DOR-2196 introduce would add a lot. Give prune an owner before anything polls: keep what installs reference plus the latest staged entry per package, and prune the rest, on a schedule or after a check.
- **Assumptions:**
  - DOR-2248 has landed: entries live in `<dorkHome>/cache/marketplace/trees/` as `<name>@<sha>` (whole repository) or `<name>@<sha>~<digest12>` (a sparse subfolder), and `MarketplaceCache.materializePackage` is the only writer.
  - Every reader of an entry is in the server process and gets the entry's path from one of three cache calls: `getPackage` (the fetcher's cache hit), `materializePackage`'s fast path, or a fresh promote. It then reads the tree for seconds (validate, copy into a staging directory) and never again; installs copy, they never point at the cache.
  - DOR-2245 (designed, not built) will call `PackageFetcher.fetchAtCommit` for an install's recorded commit, to rebuild its installed-files record. That commit must stay cheap to get back.
  - One server holds a data directory at a time (`lib/instance-lock.ts`), so every reader of the cache is in this process. (An earlier draft assumed two servers could share one; the review corrected it.)
- **Out of scope:**
  - The crash-recovery janitor for install backups (DOR-2273) and the update route (DOR-2194). This work does not edit `marketplace-installer.ts`, `flows/update.ts` or `flows/uninstall.ts`.
  - The `marketplaces/` half of the cache (one small JSON document per configured marketplace, already bounded).
  - `removeLeftovers()` deleting another live process's `.tmp-fetch-*` at startup (a DOR-2248 behaviour); noted, not changed.

## 2) Pre-reading Log

- `apps/server/src/services/marketplace/marketplace-cache.ts`: layout, `materializePackage` (in-flight de-dup, temp dir + atomic rename), `getPackage`, `removeLeftovers`, `listPackages`, and `prune({ keepLastN = 1 })`. The existing prune groups by package NAME only and keeps the newest N by mtime. That deletes the entry an install records the moment a newer one is staged, and it treats a whole-repository entry and a subfolder entry of the same name as one group.
- `routes/marketplace.ts`: `GET /cache` (counts and size), `DELETE /cache` (clear), `POST /cache/prune` (`{ keepLastN? }`, reports `removed` and `freedBytes` from a size snapshot it takes itself).
- `packages/cli/src/commands/cache-commands.ts`, `cache-dispatcher.ts`: `dorkos cache list | prune [--keep-last-n <N>] | clear`.
- `package-fetcher.ts`: `fetchGitTree` calls `getPackage`, then `materializePackage`; `fetchAtCommit` goes through the same path. `file://` sources never touch the cache.
- `marketplace-installer.ts`: `stagePackage` passes `resolved.packageName` as the cache name; `resolveLatest` stages and validates for the update check; `update()` re-installs with `force: true`, which skips `getPackage` but still hits `materializePackage`'s fast path, so a staged entry is reused.
- `lib/stage-package.ts` + every `flows/install-*.ts`: the cache tree is COPIED into a staging directory; nothing keeps a path into the cache after the request.
- `installed-metadata.ts`: `commitSha` and `sourceKey { cloneUrl, subpath, ref }` are what an install records; both are absent for local and `file://` installs and old sidecars. `name` is the manifest name, which can differ from the cache name for a direct git install (`name@url` keys the cache by what the person typed).
- `installed-scanner.ts`: `scanInstallationsAcrossScopes(dorkHome, agents)` walks global roots plus every registered agent's project; unreadable directories are skipped silently.
- `lib/git-tree.ts`: `.git` is removed after checkout, so an entry is a plain tree (a sparse entry is one package folder).
- `services/tasks/run-retention.ts`: the repo's other retention owner, a timer; the prior art for "prune on a schedule".

## 3) Codebase Map

- **Primary components:** `marketplace-cache.ts` (mechanism), a new retention module (policy + owner), `routes/marketplace.ts` (manual prune), `index.ts` (wiring), `packages/cli/src/commands/cache-*.ts` (CLI).
- **Shared dependencies:** `installed-scanner.ts`, `installed-metadata.ts`, `meshCore.listWithPaths()`.
- **Data flow:** fetch → `materializePackage` writes an entry → retention sweeps → install scan says what is recorded → entries nobody needs are moved aside and deleted.
- **Feature flags/config:** none.
- **Potential blast radius:** anything that reads a cache path (installs, previews, the update check). The in-use rule below is what keeps them safe.

## 5) Research

**What must be kept, from first principles.** The cache is a cache: every entry can be fetched again, as long as the commit still exists upstream. So "keep" is a cost and availability question, not a correctness one, with one exception, the reader in flight.

1. **An entry some request is reading right now.** Deleting it breaks that request. Must keep.
2. **The entry for a commit an install records.** DOR-2245 fetches it to rebuild the installed-files record; after a force-push it may be gone upstream for good. Cheap to keep (one entry per install). Keep.
3. **The newest entry of each installed package.** After a check stages an update, applying it reuses the staged tree instead of fetching again, and the tree the check validated is the tree that installs. Keep, but only for packages that are installed: a person browsing the marketplace stages one entry per package they open, and keeping the newest of those forever would grow without bound.
4. **Everything else** (superseded staged versions, packages previewed but never installed, packages since uninstalled) goes.

With that rule the cache holds at most two entries per installed package plus whatever was used in the last few minutes, so it is bounded by what is installed, not by time or by how often anything polls.

**Potential solutions for WHEN:**

1. **A timer** (like `run-retention.ts`). Pros: familiar. Cons: a new background schedule for something that only grows when a fetch writes; it runs when nothing changed and lags when a poll writes many.
2. **After each update check** (`flows/update.ts`). Pros: matches the issue's wording. Cons: misses the other writers (install, preview, DOR-2245's fetch), and it lands in a file DOR-2194 and DOR-2273 are editing now.
3. **After each write, in the cache's own write path, coalesced; plus once at startup; plus on demand.** Pros: the cache grows in exactly one place, so collecting there is exactly as frequent as growth, whoever the writer is (a check, a poll, an install, a preview, DOR-2245). No daemon, no timer, no edits to installer or update files. Coalescing (one sweep running, at most one queued) keeps a 20-package check to one or two sweeps. Cons: uninstalling frees nothing until the next write or restart; uninstall does not grow the cache, so the lag costs disk, never correctness.
4. **On size pressure** (a disk budget). Cons: with the rule above, everything a budget could evict beyond it is something the rule protects. A budget adds a setting that could only do harm.

**Potential solutions for the reader race:**

1. **Leases** (a reader holds a handle until done). Precise, but every reader (installer, preview, update check) would have to release it, which means editing the installer; and leases in memory do nothing for a second process.
2. **Mark on use, spare anything used recently** (git gc's grace period, `gc.pruneExpire`). Every cache call that hands out a path stamps the entry's mtime; a sweep never removes an entry stamped in the last 15 minutes. A reader finishes in seconds. Works across processes because the stamp is on disk. Within this process, "check and stamp" and "re-check and remove" take one lock, so a sweep can never remove an entry between a reader's check and its stamp. A sweep removes an entry by renaming it aside first (atomic), then deleting the renamed copy.

- **Recommendation:** rule 1–4 above, swept after every write (coalesced), at startup, and on `dorkos cache prune`, with mark-on-use plus a 15-minute grace.

## 6) Decisions

| #   | Decision                                   | Choice                                                                                                                                                                                  | Rationale                                                                                                                                                                                                            |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What an install protects                   | Every entry at the install's recorded commit, matched by commit plus subfolder digest, NOT by name. An old sidecar with a commit but no `sourceKey` protects every entry at that commit | The cache name and the recorded name can differ (a direct git install keys the cache by what was typed); commit ids are content-addressed, so matching by commit keeps exactly the right tree and at worst one extra |
| 2   | The pending update                         | Keep the most recently used entry of each (name, subfolder) group that an installed package belongs to                                                                                  | Applying reuses the tree the check validated; limited to installed packages so browsing never pins entries forever                                                                                                   |
| 3   | Grace                                      | 15 minutes since last use, stamped as the entry's mtime by `getPackage`, the fast path and the promote                                                                                  | Readers finish in seconds; on-disk so a second process is covered                                                                                                                                                    |
| 4   | Owner and timing                           | The cache's write path requests a coalesced sweep; the server sweeps once at startup; `POST /cache/prune` runs the same sweep                                                           | Growth has one door, so collection sits beside it; no timer, no installer edits                                                                                                                                      |
| 5   | Disk budget                                | None                                                                                                                                                                                    | The rule already bounds the cache by what is installed; a budget could only evict protected entries                                                                                                                  |
| 6   | When the install scan fails                | Skip the sweep and log                                                                                                                                                                  | Deleting what installs might record because we could not read them is the wrong way to fail                                                                                                                          |
| 7   | Unreadable agent project (unmounted drive) | Its installs protect nothing; accepted                                                                                                                                                  | The scanner already skips it; the entries can be fetched again by commit                                                                                                                                             |
| 8   | `dorkos cache prune --keep-last-n`         | Removed; `prune` runs the rule. `POST /cache/prune` takes no options and rejects any                                                                                                    | A per-name "keep N" deletes the commits installs record, the thing this work exists to keep                                                                                                                          |
| 9   | `removed[].cachedAt` in the prune response | Renamed `lastUsedAt`                                                                                                                                                                    | The mtime now means "last used", and the field should say so                                                                                                                                                         |
| 10  | Reporting                                  | `dorkos cache prune` prints what it removed and freed; a background sweep logs at info when it removes anything; `dorkos cache list` unchanged; no doctor check                         | Nothing a person has to act on; a cache that manages itself should be quiet                                                                                                                                          |
| 11  | `file://` marketplaces                     | Nothing to do                                                                                                                                                                           | They are served in place and never write the cache                                                                                                                                                                   |

Next step: SPECIFY.

## 7) Review amendments (2026-09-23)

The independent review found two blocking gaps, both reproduced, and four smaller ones. Adopted:

1. The installation scan must be strict. `scanInstallationsAcrossScopes` never throws (unreadable roots read as empty, a missing agent project as no installs, an unreadable sidecar as none), so "if the scan fails, remove nothing" could not hold. The sweep now reads installs itself and stops on any doubt (Decision 6 is superseded by this).
2. Sizing a removed tree followed symlinks, and git keeps them: `a -> .` hung the sweep forever. Sizes now never follow links.
3. Stamping is best-effort, so a readable but unstampable tree still installs.
4. Rule 3 now picks the newest among entries rule 2 does not keep, so re-reading the installed commit cannot cost the staged update its place (the resolved open question in the spec is reversed).
5. Project installs in folders that are not registered agents are recorded by the installer in `<dorkHome>/marketplace/project-installs.json` (Decision 7 is superseded).
6. The cross-process reasoning is replaced by the instance lock.
