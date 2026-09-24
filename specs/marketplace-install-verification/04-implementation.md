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
| 3.1 Proof, docs, changelog                   | (this commit)            | The OpenAPI document and its API pages were regenerated. The seven changelog stubs were folded into one fragment.                                                                                                                                                                                                                                                                                                                                                             |

## Proof

A throwaway harness, deleted, ran on four copies of blintz's real legacy flow 0.7.3 install (commit `ee1c8eb`, no record). It used the real `PackageFetcher` against GitHub.

- **Background sweep:** it rebuilt 1 install in 1.6 s. The record has **137 files**, is not inferred, and verifies as `clean`. It is identical, file for file, to the one the tolerant `rebuildInstalledFiles` computes from the same commit.
- **One shipped file edited** (`README.md`): `mismatch` naming `README.md`, with the folder byte-identical afterwards.
- **Offline** (a fetcher that throws `ENOTFOUND`): `fetch-failed`, with the folder byte-identical afterwards.
- **After the rebuild**, a hand-edited `commands/done.md`: `verifyInstall` reports `modified`, changed `commands/done.md`.

**Screenshots** (Dev Playground, real components, seeded queries) cover:

- a row with changed files and an update waiting;
- an older install with **Prepare**;
- the same at 390 px wide, and in dark mode;
- the update-all confirm naming the changed files.

## Follow-ups (to file)

- The update and uninstall paths should try `rebuildRecordStrict` first, and fall back to inference only when a fetched tree exists (the offline mis-assignment).
- DOR-2306's `hashTree` should digest each file through `hashFile`, whichever of the two lands second.
- `added` should also walk the effect-bearing locations plugin.json declares.
- DOR-2272's edit refusal should point at Prepare.
