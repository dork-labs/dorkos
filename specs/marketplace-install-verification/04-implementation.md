# Implementation log: marketplace-install-verification (DOR-2197, DOR-2320)

This log implements `02-specification.md`. The base is `e0befda5b`.

## Tasks

| Task                                         | Commit                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 Hash cache and `verifyInstall`           | `28d3bab76`              | **Moved from the spec:** the new modules live in `lib/integrity/`, because `lib/` was at the directory-size limit. **Mutation checks:** eight run. `ino` in the cache key first survived because ctime covered the case, so a test now injects `lstat` to pin it. An identity-file guard in `added` also survived; it was unreachable, since identity files sit outside every effect-bearing path, so it was removed.                                                         |
| 1.2 `rebuildRecordStrict`                    | `b18f366bf`              | `stageInstalledCommit`, `fetchableSourceOf`, `recordIdentityOf` and `userEditableOf` are now exported from `legacy-record.ts` and shared with the tolerant rebuild. **Mutation checks:** nine run. `npmRan` first survived; a lockfile test (npm rewrote `package-lock.json`, so it is owned rather than shipped) now kills it.                                                                                                                                               |
| 1.3 Background sweep                         | `ea3bf2f70`              | It is started after `marketplaceFetcher` exists and chained on the project install-recovery promise. The recovery block runs earlier in `start()`, so the promise and the project list are held in module state. **Mutation checks:** five run.                                                                                                                                                                                                                               |
| 2.1 `?verify=true` and the MCP `verify` flag | `54e8c27a6`              | OpenAPI documents the query and the `integrity` union.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2.2 Prepare route, transport and CLI         | `6c4fa0cb7`              | **Deviation: the route is not tier-gated.** Reasoning: it writes only a record that must match the live files byte for byte. A `marketplace.install` gate would also bind its approval hash to an install of the same name. `installRoot` narrows `locateInstallRoot` and never widens it; mutation-checked, as is the name guard. `listInstalledPackages` now builds its query with `buildQueryString`, so a space is encoded as `+`, which the server decodes the same way. |
| 2.3 Doctor deep check                        | `6e42e761b`              | Package names only, never paths (the deep-health response is content-free). The deep-check count went from 5 to 6 in the existing tests.                                                                                                                                                                                                                                                                                                                                      |
| 2.4 Installed view and update confirm        | `82053baf6`, `11439538d` | A row's own Update applies without a dialog, so the row note is the warning ahead of it. The update-all confirm repeats it per installation. **Mutation checks:** five run. Prepare being offered for linked installs first survived; it is now killed. The Dev Playground gained a verified state for both components.                                                                                                                                                       |
| Rebase onto DOR-2306                         | (after 3.1)              | DOR-2306 (#2088) landed first, so its `hashTree` now digests each file through `fileSha256Hex`, the primitive `hashFile` is built on: one per-file digest in the repo. A pinned test keeps the tree hash an approval binds byte-identical. Conflicts were unions (the `heldBack` and `integrity` fields, the update confirm's disclosure and changed-files line, the row notices).                                                                                            |
| 3.1 Proof, docs, changelog                   | (this commit)            | The OpenAPI document and its API pages were regenerated. The seven changelog stubs were folded into one fragment.                                                                                                                                                                                                                                                                                                                                                             |

## Proof

A throwaway harness, deleted, ran on four copies of blintz's real legacy flow 0.7.3 install (commit `ee1c8eb`, no record). It used the real `PackageFetcher` against GitHub.

- **Background sweep:** it rebuilt 1 install in 1.6 s. The record has **137 files**, is not inferred, and verifies as `clean`. It is identical, file for file, to the one the tolerant `rebuildInstalledFiles` computes from the same commit.
- **One shipped file edited** (`README.md`): `mismatch` naming `README.md`, with the folder byte-identical afterwards.
- **Offline** (a fetcher that throws `ENOTFOUND`): `fetch-failed`, with the folder byte-identical afterwards.
- **After the rebuild**, a hand-edited `commands/done.md`: `verifyInstall` reports `modified`, changed `commands/done.md`.

**Screenshots** (Dev Playground, real components, seeded queries) cover:

- a row with changed files and an update waiting;
- an older install with **Check files**, and one whose files were found to differ;
- the same at 390 px wide, and in dark mode;
- the update-all confirm naming the changed files.

## Review round 1

The first adversarial review returned CHANGES_REQUIRED on the engine's exactness and on the copy. Every item was fixed with a test that failed first, and mutation-checked:

- **Engine:** 7 mutants, all caught after one added test (the record's own `userEditable` filter).
- **Sweep:** cancellation and leftover cleanup, each mutation-checked.
- **UI:** 6 mutants, all caught.

The reviewer's attack script (`attack.mts`) now gives:

| Scenario                             | Result                              |
| ------------------------------------ | ----------------------------------- |
| S1 (an extra skill)                  | mismatch                            |
| S2 (`skills/**` userEditable)        | mismatch                            |
| S3 (an editable file turned symlink) | rebuilt, and verifies as customized |
| S4 (`**`)                            | mismatch                            |
| S5 (a case-only rename)              | mismatch                            |
| S6 (an edited manifest)              | mismatch                            |

Follow-up (1) is filed as DOR-2322. Follow-up (2), plugin.json locations, is done. DOR-2272 (#2091) merged first; the branch is rebased onto it, and its older-install messages point at Check files.

## Follow-ups (to file)

- DOR-2322: the update and uninstall paths should try `rebuildRecordStrict` first (filed; an offline product decision).

## DOR-2322: update and uninstall of an older install (spec §13)

Commits on branch `DOR-2322`, from main `7e3d66c25`:

1. **Rebuild tries strict first.** `strictDifferences` moved to `lib/integrity/strict-differences.ts` (with `addedEffectFiles`), shared by `rebuildRecordStrict` and `rebuildInstalledFiles`. The fallback record carries `unproven { why, from?, files }`.
2. **Update.** `placeUnproven` in `transaction.ts` maps each unproven file through the carry plan, replaces its notices with one `kept-unproven` notice, writes the list onto the new record, and adds one warning (`describeUnproven`, `lib/integrity/unproven.ts`).
3. **Uninstall.** `UninstallResult.unproven` (absolute paths) plus the warning. MCP `marketplace_uninstall` passes on `unprovenPaths` and `warnings`.
4. **Check files.**
   - An `inferred` record counts as legacy: verify reports `unknown`/`inferred`, and the sweep and Check files rebuild it strictly.
   - `sortUnprovenFiles` runs only when the route asks (`sortUnproven: true`). It removes byte-identical leftovers that the current version does not ship, keeps the rest, and drops the list.
   - New outcome `sorted`; `unproven: true` on `no-source` / `fetch-failed` changes the wording.
5. **Surfaces.**
   - Verify gains `unproven { files, check }`, never counted in `added`.
   - The app gets a kept-files disclosure with Check files, a guessed record reads as an older install, and the update and uninstall toasts carry their warnings.
   - The CLI FILES column reads `as installed, 2 kept` with a footnote. `update --apply` prints each update's warnings. `uninstall` uses a neutral heading. `check-files` exits 0 on `sorted`.
   - `doctor --deep` names guessed and kept.
6. Docs, playground, changelog fragment `260925-013340-offline-updates-keep-files-they-cannot-sort.md`.

**Mutation checks:** 31 mutants across the server, CLI and client. After adding two tests, every one is killed: strict-first with 3 edited editable files, the sort's under-lock re-read, a shipped file never removed, and no empty notice sentence.

**Screenshots:** `dor2322-01-kept-note-desktop.png` and `dor2322-02-kept-note-phone.png` (the Dev Playground InstalledPackagesView, disclosure open; 390px has no horizontal scroll).

**For review:** Check files now removes files, but only files byte-identical to what the earlier version shipped at that path, which the current version does not ship. The route stays ungated; the rationale is in `contributing/marketplace-installs.md` §5.3.

### DOR-2322 review round 1

1. **The list lasts.**
   - The transaction and the uninstall read `unproven` from any record, not only a guessed one.
   - `placeUnproven` carries each entry to where it now sits and keeps its path in the version the list was made against.
   - An entry leaves only when the new version ships that file byte for byte.
   - A carried list gets its own wording ("An earlier update of X kept N files…").
2. **Check files never deletes.**
   - `unproven-sort.ts` renames each leftover to the first free `<path>.dork-old[.n]` and clears its execute bits. A leftover already under a set-aside name stays put.
   - The outcome is `sorted { setAside: {path, savedAs}[], kept }`, and the sentence names where each went.
   - The wording is now "sets aside" in the app, the CLI help, the docs and the changelog.
   - Because the file is renamed, not deleted, an edit racing the comparison survives in the moved file. The route stays ungated.
3. **Kept files that run.**
   - `runningUnproven` is the list intersected with `addedEffectFiles`.
   - It is named on the update warning, in `integrity.unproven.running`, and in the amber row-note summary ("1 of them still runs", listed under "Still runs").
   - The CLI FILES column says `(1 still runs)`, and doctor says "(some still run)". There is a new Playground state.
4. **DOR-2306 interaction (checked).**
   - The approved `contentHash` is `packageContentHash` of the staged package, taken before the carry, so kept files are not in it.
   - `globalConsentRecorder.settle` recorded the live declarations, so a running kept file rode an approval of a disclosure that never showed it. Later changes then held the package back as "changed what it runs" with no pointer.
   - Now `settle` records nothing while a kept file runs.
   - `partitionGlobalPlugins` adds `keptRunning` to the withheld entry, and the held-back note names the files and points at Check files.
5. Minor: the misplaced TSDoc in `uninstall.ts` is fixed.

**Mutation checks:** 20 new mutants. After one extra assertion (each file listed once), every one is killed.

**Screenshots:** `dor2322-03-kept-runs-desktop.png` and `dor2322-04-kept-runs-phone.png`.
