---
slug: marketplace-install-verification
number: 260924-175336
created: 2026-09-24
status: implemented
linear-issue: DOR-2197
project: Marketplace Package Management
---

# Say whether an installed package still matches what was installed, and give older installs a record

**Linear:** DOR-2197, with DOR-2320 folded in (§8). **Builds on:** DOR-2245's installed-files record (`specs/marketplace-package-file-ownership/`), DOR-2248's `fetchAtCommit`, DOR-2318's staged `skillRef` injection.

## 1. The problem

`install-metadata.json` records the commit a package was installed at, and nothing checks it. A hand-edited install still claims that commit. DOR-2245 now writes `.dork/installed-files.json`, which lists every shipped file with its SHA-256. That record already answers "is this still what was installed?", but nothing asks it.

Installs made before DOR-2245 have no record. Today, a record is rebuilt only in the middle of an update or uninstall (`lib/legacy-record.ts`). When the installed commit can't be fetched, that rebuild falls back to byte-matching. Offline, a shipped file that differs between versions then counts as the person's, and it is carried forward as theirs. The review of DOR-2272 showed this, and it asked for a **safe** rebuild that runs before any update needs one.

## 2. Goals

1. **Verify:** for any install, report `clean`, `modified` or `unknown`, with the files behind a `modified`.
2. **Surface it** in the installed list (HTTP, MCP), the CLI's `marketplace installed`, `dorkos doctor --deep`, and the Installed view. Where an update would replace a changed file, say so before the update.
3. **Safe rebuild:** give a legacy install (identity but no record) a record from its installed commit, in the background after boot and on demand (DOR-2320). Write it only when the fetched commit matches the live files exactly. There is no byte-matching fallback: offline or on a mismatch, write nothing.

**Non-goals:**

- Changing the update and uninstall paths' own rebuild. It keeps its fallback here, because at update time the person asked for a change. The fallback only keeps files and never deletes them, and it warns. It is tracked as a follow-up (§11).
- Verifying `node_modules`.
- Verifying linked installs (they are a developer's working copy).

## 3. One hashing primitive

Verification compares the live files with the record using `hashFile` in `lib/installed-files.ts`, the per-file SHA-256 that DOR-2245 records with. This item adds no new hash.

**DOR-2306 dependency (resolved: DOR-2306 landed first, and its `hashTree` now digests through `fileSha256Hex`, the primitive under `hashFile`):** its unmerged `lib/content-hash.ts` (`hashTree`, `packageContentHash`) digests each file itself. Whichever of the two lands second makes `hashTree` digest files through `hashFile`, so the repo has one per-file primitive. A whole-tree hash would add nothing here: verification needs to know _which_ files changed, and the record already has per-file hashes.

**Hash cache:** `hashFile` streams the file. To keep repeated list calls cheap, `lib/integrity/file-hash-cache.ts` memoizes `hashFile` by absolute path. An entry is reused only while the file's `lstat` `size`, `mtimeMs`, `ctimeMs` and `ino` are unchanged, so a rename-over or an `mtime` restored with `utimes` still misses. It holds at most 20,000 entries (least recently used first) and is in memory only. The same `hashFile` still produces every hash.

## 4. Verify: `lib/integrity/verify-install.ts`

```ts
type InstallIntegrity =
  | { status: 'clean'; customized: string[] }
  | { status: 'modified'; changed: string[]; missing: string[]; added: string[]; customized: string[] }
  | { status: 'unknown'; reason: 'no-record' | 'unreadable-record' | 'linked' };
verifyInstall(root: string): Promise<InstallIntegrity>
```

- **`linked`:** the root is a symlink (DOR-2194).
- **`no-record` / `unreadable-record`:** `readInstalledFiles` returns `null`. The two are told apart by whether the file exists.
- **For each recorded file** (the path went through `RecordPathSchema` when the record was read):
  - `missing` if the file is absent, or is not a regular file reached through real directories (`lstatChain`).
  - `changed` if the bytes differ.
  - A path that matches the record's `userEditable` goes to `customized` instead. Editing it is expected, and DOR-2245 already refuses `userEditable` on anything effect-bearing.
  - An editable file that is missing is not a change either (DOR-2245 row 3a).
- **`added`:** regular files that are not in the record but sit at or under an `EFFECT_BEARING_PATHS` entry, for example a person's new skill in `skills/`. Such a file changes what runs, because Harness Sync projects it. Skipped: reserved paths, owned paths (`node_modules`), the installer's files, an agent package's identity files, and pending `.dork-new` copies. Custom locations named in plugin.json are not walked (defaults only). This is recorded as a known limit.
- **Status:** `modified` if `changed`, `missing` or `added` is non-empty; otherwise `clean`. Every list is sorted, and each carries at most 50 paths, plus a `truncated: true` flag when there were more.
- **Read-only:** verification writes nothing and takes no lock. A concurrent install can make one answer stale, and the next call corrects it.

## 5. Strict rebuild: `rebuildRecordStrict` (`lib/integrity/strict-record.ts`)

```ts
rebuildRecordStrict(root, { fetcher, logger }): Promise<StrictRebuildResult>
type StrictRebuildResult =
  | { outcome: 'rebuilt'; files: number }
  | { outcome: 'not-needed'; why: 'has-record' | 'not-installed' | 'linked' }
  | { outcome: 'no-source' }        // no sidecar, no sourceKey, or no full commit (a local-path install)
  | { outcome: 'fetch-failed'; message: string }
  | { outcome: 'mismatch'; differing: string[] }
```

1. Everything runs inside `withInstallTargetLock(root)`. The lock is re-entrant, and it serializes with every install, update, uninstall and recovery on that root.
2. Inside the lock, re-check the root: it must still be legacy (a directory, `hasPackageIdentity`, no record file). An update that ran meanwhile wrote a record, which gives `not-needed`.
3. `readInstallMetadataStrict`. Without a `sourceKey` and a full `commitSha`, the result is `no-source`. An unreadable sidecar is also `no-source`, logged.
4. `fetchAtCommit({ packageName: metadata.name, sourceKey, commitSha })`. Any throw gives `fetch-failed`.
5. Stage the fetched tree with `stagePackageContents` into a scratch directory, and inject its `skillRef` schedules (`injectInstalledSchedules`, DOR-2318). Then `computeInstalledFiles` with the fetched manifest's `userEditable`, and `npmRan` = whether the live root has `node_modules`.
6. **The match rule.** Every file in that record must be a regular file in the live root, reached through real directories (`lstatChain`), with the same `hashFile`. The only exemption is paths the fetched manifest marks `userEditable`: those are recorded with the package's hash and verify as `customized`. Anything else gives `mismatch`, listing up to 50 paths.
7. On a match, write the record (`writeInstalledFiles`, atomic), with the fetched manifest's `userEditable`. The result is `rebuilt`.
8. **Nothing else writes.** The scratch directory is always removed. `fetch-failed`, `mismatch` and `no-source` leave the root byte-for-byte as it was.

**Why exact:** with the tolerant rule, a commit that is not what was installed, or a person's edits to shipped files, turn into package hashes, or turn into the person's files under the fallback. The exact rule never guesses.

**Measured on a real legacy install:** blintz's flow 0.7.3 at `ee1c8eb` matched 137/137 files exactly, so the rule is practical. A legacy install whose person edited a shipped file stays `unknown`. Its next update still works through the update path's own rebuild, and the Installed view says why (§7).

`rebuildInstalledFiles`, the update and uninstall path, keeps its behaviour. Its fetched-tree trust check and its fallback are unchanged. Both functions share one private helper that fetches, stages and injects the old tree, so the two can't drift.

## 6. Background rebuild after boot: `lib/integrity/legacy-record-sweep.ts`

- `rebuildLegacyRecords(dirs, deps) → { rebuilt, mismatch, noSource, fetchFailed, skipped }`.
  - It lists each directory's children (never recursing), and keeps a child that is a directory, not a symlink, not an install sibling (`isInstallSiblingName`), has a package identity, and has no record.
  - It runs `rebuildRecordStrict` on those children one at a time: one fetch at a time, and never two at once for one root.
  - A throw from one root is logged, and the sweep moves on.
- It is started from `index.ts`, fire-and-forget and chained after the project install-recovery sweep, so recovery settles a root before the rebuild looks at it. The directories are `globalSweepDirs(dorkHome)` plus each project's `projectSweepDirs`, filtered to install roots (the skills roots never hold packages).
- It logs one summary line, and one line per install it could not rebuild, with the reason in words. It never throws into startup.
- **No new config.** It reads the network only for commits the person already installed from, and writes only the record file. It retries at the next boot, and the manual action (§8) retries on demand.

## 7. Surfacing

- **Shared schema:** `InstallIntegrity` in `packages/shared/src/marketplace-schemas.ts`. `InstalledPackage.integrity?: InstallIntegrity` is present only when verification was asked for.
- **HTTP:** `GET /api/marketplace/installed?verify=true` and `GET /api/marketplace/installed/:name?verify=true` add `integrity` to every entry. Entries are verified in sequence, with a concurrency of 4 like update checks. Without `verify`, nothing changes.
- **MCP:** `marketplace_list_installed { verify?: boolean }`. An agent can then tell a person which of their plugins was hand-edited.
- **CLI:** `dorkos marketplace installed --verify` adds a **Files** column: `as installed`, `changed (3)`, `unknown`. `--json` passes `integrity` through.
- **Doctor:** `dorkos doctor --deep` gets a new deep check, `checkInstalledPackages`:
  - `pass`: "Installed packages match what was installed".
  - `warn`: names the packages with changed files, and separately the ones installed by an older DorkOS. The fix line for those is `dorkos marketplace prepare <name>`.
- **Installed view:**
  - Rows are verified by one `listInstalledPackages(projectPath, { verify: true })` query that runs beside the update check. It is never one request per row.
  - A `modified` row shows "N files changed since install", with the paths in a tooltip.
  - A legacy row (`unknown` / `no-record`) shows "Installed by an older DorkOS" and a **Prepare** button (§8).
  - `linked` and `unreadable-record` show nothing new.
- **Update confirm:** `ConfirmUpdatesDialog` lists each installation it will touch. A `modified` installation there gets one extra sentence: "Your changes to N files will be replaced; your copies are saved beside them (.dork-old)." That sentence is the "warn before discarding" the issue asked for. DOR-2245 already keeps the copies, so the warning is honest and there is no extra blocking step.

## 8. DOR-2320 in the same change

**Decision: yes, in the same change.**

1. **One engine.** The prepare action is `rebuildRecordStrict` on one root, with its result put into words. The route, transport method, button and CLI command are thin.
2. **Not a dead end.** The background rebuild writes nothing offline or on a mismatch. Verification then reports `unknown` for a legacy install, and the only useful thing to point at is "prepare it". Shipping `unknown` without the action would leave a status the person can do nothing about. Shipping the action without the status would leave a button nobody can see a reason to press.
3. **One review.** Its safety rules (lock, exact match, no fallback, write nothing on failure) are the engine's rules. Reviewing them twice, across two PRs, invites drift.

**Surface:**

- **Route:** `POST /api/marketplace/packages/:name/prepare`, body `{ projectPath?, installRoot? }`.
  - The name is checked with `assertPackageName`, and **not tier-gated** (a change from the first draft): it writes only a record that must match the live files byte for byte, so it cannot change what runs or claim a person's file. Gating it as `marketplace.install` would also have bound its approval hash to an install of the same name, a token replayable as an install.
  - It finds the root with `locateInstallRoot`, as update and uninstall do, and returns 404 `PackageNotInstalledError` when there is none.
  - Response: `{ outcome, message }`, where `message` is one sentence per outcome:
    - `rebuilt`: "DorkOS now knows which of {name}'s files are yours."
    - `not-needed`: "{name} doesn't need preparing."
    - `no-source`: "{name} was installed from a folder on this computer, so DorkOS can't fetch the version it came from. Reinstall it to start tracking its files."
    - `fetch-failed`: "Couldn't fetch the version {name} was installed from ({detail}). Try again when you're online."
    - `mismatch`: "Some of {name}'s files differ from the version it was installed from, so DorkOS can't tell yours from the package's. Its next update sorts this out, keeping your copies."
- **Transport:** `prepareMarketplacePackage(name, opts)`, in `HttpTransport` and `DirectTransport`.
- **CLI:** `dorkos marketplace prepare <name> [--project <path>] [--json]`.
- **Not in MCP.** An agent has no reason to prepare a package, and it can already update one.

**DOR-2272 follow-through:** its edit refusal, "this will work after the package's next update", should also name Prepare. That text lives on DOR-2272's branch (in progress), so this item only posts the pointer on DOR-2272.

## 9. Tests (all test-first, with the assertion that must fail named in each purpose comment)

- **verify-install:**
  - clean, changed, missing, added (a skill under `skills/`)
  - customized (`userEditable`), and a missing editable file that is not a change
  - no-record, unreadable-record, linked
  - symlinked parent dir counts as missing
  - list truncation
  - the hash cache misses on a same-size rename-over and on a restored `mtime`
- **rebuildRecordStrict:**
  - rebuilt, exact, including a `skillRef`-injected `SKILL.md`
  - mismatch on one edited file, and on one missing file, writing nothing
  - fetch-failed (fetcher throws) writing nothing
  - no-source (a local install, no commit)
  - not-needed when a record appears while waiting for the lock
  - the lock is held: a concurrent `runTransaction` on the root waits
  - a `userEditable` edit still gives rebuilt
  - FIFO and symlink at a recorded path give mismatch without being read
- **Sweep:** rebuilds only legacy roots, skips siblings, symlinks and recorded roots, and carries on after one throws.
- **Route:**
  - prepare's five outcomes with their messages
  - 404
  - installRoot narrows and never widens
  - name guard before the gate
  - `installed?verify=true` adds `integrity`, and without the flag the response is unchanged
- **MCP:** the `verify` flag.
- **CLI:** the Files column, `prepare`, `--json`.
- **Doctor:** the check's pass/warn wording.
- **Client:** changed and legacy rows, Prepare calling the transport and refreshing, and the confirm-dialog sentence. There will be screenshots of each.
- **Mutation checks:** the match rule, the exemption, the lock, the re-check inside the lock, the no-write-on-failure guarantee, the `added` rule, and the cache key.

## 10. Proof

- A copy of blintz's real legacy flow install: the background sweep writes a record with 137 files, and the record is identical to the one `rebuildInstalledFiles` computes from the same commit.
- The same copy with one shipped file edited: `mismatch`, and nothing written.
- The same copy with the network off (a fetcher that throws): `fetch-failed`, and nothing written.
- The same copy after the rebuild, with one file edited: `?verify=true` reports `modified`, with that path.

## 11. Follow-ups (filed when this lands)

- The update and uninstall paths' own rebuild should use `rebuildRecordStrict` first, and fall back to inference only when a fetched tree exists. This removes the offline mis-assignment the DOR-2272 review found.
- DOR-2306's `hashTree` should digest files through `hashFile` (whichever of the two lands second).
- Walking plugin.json's custom effect-bearing locations for `added`.
