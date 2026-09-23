# Tasks: marketplace-package-file-ownership

Spec: [`02-specification.md`](./02-specification.md). Generated 2026-09-23T16:39:24Z. Canonical source: `03-tasks.json`.

All tasks land in the **dorkos** repo, in one PR with the spec docs. No dork-labs/marketplace change is part of this item.

## Critical path

1.1 → 2.1 → 2.2 → 2.3 → 2.5 → 2.6 → 4.1 → 4.2 (2.8 needs DOR-2248 merged; 2.4, 1.2, 1.3 and 3.1 run in parallel).

## Phase 1: The contract (@dorkos/marketplace, @dorkos/shared)

### Task 1.1: Add userEditable, its matcher, agent defaults and the reserved-path list to @dorkos/marketplace

- **Size:** medium · **Priority:** high · **Depends on:** none · **Parallel with:** 1.3, 2.4, 3.1

WHY: a package needs one way to say 'this shipped file is meant to be edited' (ADR 260923-163514), and DorkOS needs one list of paths a package may never ship (spec §2, §3).

CHANGES (packages/marketplace/src):

1. constants.ts: export `INSTALLED_FILES_PATH = '.dork/installed-files.json'`, `INSTALL_METADATA_PATH_POSIX = '.dork/install-metadata.json'` (or reuse an existing constant if one exists; the server has `INSTALL_METADATA_PATH` in installed-metadata.ts built with path.join; keep the server one and add a POSIX one here only if needed by the validator), `PACKAGE_DATA_DIR = '.dork/data'`, `PACKAGE_SECRETS_PATH = '.dork/secrets.json'`, `KEPT_COPY_SUFFIXES = ['.dork-old', '.dork-new'] as const`, and `AGENT_USER_EDITABLE_DEFAULTS = ['.dork/agent.json', '.dork/SOUL.md', '.dork/NOPE.md', '.dork/MEMORY.md'] as const`.
2. New module `user-editable.ts` (browser-safe, no node imports), exported from index.ts:
   - `isReservedPackagePath(posixPath: string): boolean` — true for `.dork/data` and anything under `.dork/data/`, `.dork/secrets.json`, `.dork/install-metadata.json`, `.dork/installed-files.json`, and any path whose basename ends `.dork-old` / `.dork-new` optionally followed by `.<digits>`.
   - `UserEditablePathSchema` (zod string): accepts a POSIX relative path (`config/defaults.json`) or a directory prefix ending `/**` (`prompts/**`). Rejects: empty, absolute (`/x`), any `..` segment, backslashes, any other `*` or `?`, a leading `./`, and any pattern that covers a reserved path (for `dir/**` check `isReservedPackagePath(dir)` or dir being `.dork` itself). Each rejection has a specific message.
   - `matchesUserEditable(posixPath, patterns): boolean` — `p === pattern` or, for `dir/**`, `p.startsWith(dir + '/')`.
   - `resolveUserEditable(manifest: { type: PackageType; userEditable?: string[] }): string[]` — the manifest's list, plus AGENT_USER_EDITABLE_DEFAULTS when type === 'agent', de-duplicated, stable order.
3. manifest-schema.ts: on the shared base manifest (every type) add
   `userEditable: z.array(UserEditablePathSchema).max(100).default([])` with the TSDoc from spec §3 ("Shipped files a person is expected to edit. On update, an edited copy is kept and the new default is written beside it as `<file>.dork-new`. Every other shipped file is replaced, and an edited copy is saved as `<file>.dork-old`. Exact root-relative paths, or a directory prefix ending in `/**`."). The schema is not .strict(), so older DorkOS strips it (document that in the TSDoc: packages relying on it set minDorkosVersion).
   Check that the CC-plugin synthesized manifest path (cc-validator.ts / validatePackage) yields `userEditable: []`.
4. If a JSON schema for the manifest is generated for the marketplace repo's tools/schema-check (grep for a generator of manifest JSON schema), regenerate it.

TESTS (packages/marketplace/src/**tests**/user-editable.test.ts, and manifest-schema tests): accepts `a/b.json`, `dir/**`; rejects `../x`, `/x`, `*.json`, `a\\b`, `dir/*`, `./a`, `.dork/data/**`, `.dork/secrets.json`, `.dork/**`; matcher true/false cases incl. `dir/**` not matching `dirx/a`; resolveUserEditable adds the four agent defaults only for agents and de-dupes; isReservedPackagePath true for `.dork/data`, `.dork/data/x/y`, `x/SKILL.md.dork-old`, `x.dork-new.3`, false for `.dork/database.json`, `x.dork-older`. A manifest with userEditable round-trips; one without defaults to [].

VERIFY: pnpm vitest run packages/marketplace/src/**tests**/user-editable.test.ts packages/marketplace/src/**tests**/manifest-schema.test.ts; pnpm --filter @dorkos/marketplace typecheck && lint; rebuild the package.

### Task 1.2: Refuse a package that ships a reserved path (RESERVED_PATH_SHIPPED)

- **Size:** small · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 1.3, 2.4, 3.1

WHY: `.dork/data/**`, `.dork/secrets.json`, the two installer files and `*.dork-old`/`*.dork-new` always belong to the person or the installer (spec §2, §11). If a package could ship one, the next update would treat a person's secret as the package's file.

CHANGE: packages/marketplace/src/package-validator.ts `validatePackage`: walk the package tree (reuse the walker the validator already uses for SKILL.md discovery if there is one; skip `node_modules` and `.git`) and for every regular file whose POSIX root-relative path satisfies `isReservedPackagePath` (task 1.1) push
`{ level: 'error', code: 'RESERVED_PATH_SHIPPED', message: `${p} is a path DorkOS keeps for the person or the installer (.dork/data/, .dork/secrets.json, .dork/install-metadata.json, .dork/installed-files.json, *.dork-old, *.dork-new). Remove it from the package.`, path?: p }` (match the ValidationIssue shape at package-validator.ts:40).
Note: an INSTALLED root legitimately contains `.dork/install-metadata.json`; validatePackage is also used on staged/cached trees and possibly installed roots (the installed scanner falls back to validatePackage for CC-only packages: installed-scanner.ts readManifestSummary -> validatedSummary). Grep every validatePackage caller. If any caller validates an INSTALLED root, gate the new check behind an option (`{ source: 'package' | 'installed' }`, default 'package') or run it only from the install pipeline's validation of the staged/cached tree, so an installed package never reports its own installer files as an error. Record the choice in the TSDoc.
Confirmed 2026-09-23: no package in dork-labs/marketplace ships a reserved path (git ls-files at ee1c8eb).

TESTS (package-validator.test.ts): one fixture per reserved kind yields exactly one RESERVED_PATH_SHIPPED naming the path; `.dork/database.json` and `x.dork-older` do not; a file under node_modules is ignored; the installed-root caller (if any) does not report its own `.dork/install-metadata.json`.

VERIFY: pnpm vitest run packages/marketplace/src/**tests**/package-validator.test.ts; typecheck + lint @dorkos/marketplace.

### Task 1.3: Add PackageFileNotice and InstallResult.fileNotices to the shared and server result types

- **Size:** small · **Priority:** medium · **Depends on:** none · **Parallel with:** 1.1, 1.2, 2.4, 3.1

WHY: an install that replaced or kept a person's edited file must say which file and where the other copy is (spec §12).

CHANGES:

1. packages/shared/src/marketplace-schemas.ts near `export interface InstallResult` (~L465): add

```ts
/** What an install did with a file the person may have changed. */
export interface PackageFileNotice {
  /** Root-relative POSIX path of the file. */
  path: string;
  /**
   * `replaced-edit`: the package's copy is in place; yours is at `savedAs`.
   * `kept-edit`: your copy is in place; the package's new default is at `savedAs`.
   * `kept-no-longer-shipped`: your copy is in place; the package no longer ships this file.
   */
  outcome: 'replaced-edit' | 'kept-edit' | 'kept-no-longer-shipped';
  /** Root-relative POSIX path of the saved copy, when one was written. */
  savedAs?: string;
}
```

and on InstallResult `fileNotices?: PackageFileNotice[];` with TSDoc (each notice is ALSO one plain sentence on `warnings`). If InstallResult has a zod schema twin anywhere (grep `InstallResultSchema`), add the field there too. 2. UninstallResult (~L500) `preservedData` TSDoc: "Absolute paths kept on disk because `purge` was false: every file you and your agents added or changed, collapsed to the highest directory whose whole contents were kept." Same edit on the server's UninstallResult in apps/server/src/services/marketplace/flows/uninstall.ts, and on the purge field TSDoc (~L489): "Also remove the files you and your agents added or changed." 3. apps/server/src/services/marketplace/types.ts: mirror `fileNotices?: PackageFileNotice[]` on the server InstallResult (import the type from @dorkos/shared/marketplace-schemas if the file already imports from there; otherwise mirror the interface as the file's header says it does).

TESTS: type-level only; covered by later flow tests. Run the typechecks.
VERIFY: rebuild @dorkos/shared; pnpm --filter @dorkos/shared typecheck; pnpm --filter @dorkos/server typecheck.

## Phase 2: Ownership in the installer (apps/server)

### Task 2.1: Build lib/installed-files.ts: the record, its defensive reader, and the carry-over classifier

- **Size:** large · **Priority:** high · **Depends on:** 1.1, 1.3 · **Parallel with:** 2.4, 3.1

WHY: the root cause of DOR-2245 is that the installer has no record of which files it installed (spec §1, §2). This module is that record plus the pure decision table every later task uses.

NEW FILE apps/server/src/services/marketplace/lib/installed-files.ts (TSDoc every export; module header explaining the ownership rule: DorkOS removes or replaces only files it can prove the install put there, unchanged).

1. Schema (zod):

```ts
{ version: 1,
  package: { name: string; type: PackageType; source?: string },
  ownedTrees: string[],               // today only 'node_modules'
  files: Record<string, string>,      // POSIX root-relative path -> 'sha256:<hex>'
  userEditable: string[] }
```

2. `computeInstalledFiles(root, { identity, userEditable, ownedTrees }): Promise<InstalledFiles>` — walk `root` with lstat; record every REGULAR file except: anything under an ownedTree that exists at the root (include 'node_modules' in ownedTrees only if `<root>/node_modules` exists), `.dork/installed-files.json`, `.dork/install-metadata.json`, symlinks (skip, never follow). Paths POSIX (`split(path.sep).join('/')`). Hash with a streamed `crypto.createHash('sha256')`. Deterministic key order (sorted).
3. `writeInstalledFiles(root, record)` (atomic write: write tmp + rename, or the repo's atomic-write helper from @dorkos/shared/atomic-write if suitable) and `readInstalledFiles(root): Promise<InstalledFiles | null>` — returns null (and logs via an optional logger) when missing, unparseable, schema-invalid, OR when any `files` key / ownedTree is absolute, contains a `..` segment, contains a backslash, or resolves outside `root`. A record only decides what DorkOS KEEPS, so a tampered one can never cause writes outside the root.
4. `hashFile(absPath)` helper (exported for tests / uninstall).
5. PURE classifier `planCarryOver(input): CarryOverPlan` where input = { rOld: InstalledFiles | null, oldHasIdentity: boolean, rNew: InstalledFiles, backupFiles: Map<posixPath, { kind: 'file'; hash } | { kind: 'symlink' }>, stagedPaths: Set<string> } and the plan lists per-path actions: `carry` (copy backup P -> staged P, overwriting the staged copy), `carryAs` (copy backup P -> staged <savedName>), `saveNewAs` (move staged P -> <savedName> then carry backup P -> P), `drop`, plus the `PackageFileNotice[]` and the list of `.dork-new` paths to add to the new record. It also returns `carryDirs`: directories in the backup that contain NO R_old file and NO R_new file anywhere beneath them, to be carried as one unit (spec §4, performance) — their files are not listed individually.
   If rOld is null and oldHasIdentity is false -> treat every backup file as 'not in R_old' (rows 9-11). If rOld is null and oldHasIdentity is true -> throw a typed `LegacyInstallError` (callers rebuild first, task 2.8).
   Name allocation `allocateSavedName(p, suffix, taken: Set<string>)` -> `p.dork-old`, else `p.dork-old.2`, `.3`, ... first not in `taken` (taken = staged paths ∪ carried paths ∪ already allocated).

THE RULE TABLE (spec §4). Inputs: R_old = the backup's record (old install, or the root an uninstall left); R_new = the staged record just written; U = R_new.userEditable for paths the new version ships, else R_old.userEditable. 'edited' = present in backup with hash != R_old hash. 'default changed' = R_new hash != R_old hash. Iterate over R_old.files ∪ files present in the backup ∪ R_new.files, skipping R_old.ownedTrees and the installer paths (.dork/installed-files.json, .dork/install-metadata.json).
1 in R_old, unchanged, new ships -> new copy, no notice
2 in R_old, unchanged, new doesn't ship -> gone
3 in R_old, missing, new ships -> new copy
4 in R_old, missing, new doesn't ship -> gone
5 in R_old, edited, new ships, not U -> new copy; person's saved as P.dork-old; notice replaced-edit
6 in R_old, edited, new ships, U -> person's copy; if default changed, new copy saved as P.dork-new; notice kept-edit only when .dork-new written
7 in R_old, edited, new doesn't ship, not U -> person's copy saved as P.dork-old (NOT left at P); notice replaced-edit
8 in R_old, edited, new doesn't ship, U -> person's copy in place; notice kept-no-longer-shipped
9 not in R_old, present, new doesn't ship -> person's copy in place, no notice
10 not in R_old, present, new ships, not U -> new copy; person's saved as P.dork-old; notice replaced-edit
11 not in R_old, present, new ships, U -> person's copy; new copy saved as P.dork-new if bytes differ; notice kept-edit if written
Saved names never overwrite: P.dork-old, else P.dork-old.2, .3 ... (same for .dork-new), first free in the FINAL tree. A written .dork-new is added to the new record (it is the package's copy). A .dork-old is not.
A backup with no R_old AND no package identity (a root a legacy uninstall left): every file is rows 9-11. A backup WITH identity but no valid R_old: legacy, rebuild first (task 2.8).

TESTS apps/server/src/services/marketplace/**tests**/installed-files.test.ts (real temp dirs for compute/read/write; plain objects for planCarryOver):

- compute excludes node_modules/**, both installer files, symlinks; paths are POSIX; sorted; flipping one byte changes the hash.
- read returns null for: missing file, bad JSON, schema-invalid, a key `../x`, an absolute key, a backslash key.
- planCarryOver: ONE TEST PER ROW 1..11 asserting action, saved name and notice; a collision case (`P.dork-old` already present -> `P.dork-old.2`); a `.dork-new` path appears in the new-record additions; a dir with no recorded file beneath it appears in carryDirs and its files are not listed individually; a symlink in the backup is carried as a symlink (row 9); rOld null + no identity -> rows 9-11; rOld null + identity -> LegacyInstallError.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/**tests**/installed-files.test.ts; pnpm --filter @dorkos/server typecheck && lint.

### Task 2.2: Teach runTransaction to write the record and carry the person's files over (step 3b)

- **Size:** large · **Priority:** high · **Depends on:** 2.1 · **Parallel with:** 2.4, 3.1

WHY: every install flow lands files through runTransaction (transaction.ts), so the record and the carry-over live there and no flow can forget them, the lesson of §5.1 npm dependencies (spec §2, §4).

CHANGES apps/server/src/services/marketplace/transaction.ts:

1. `TransactionOptions<T>` gains

```ts
/** Record which files this install put in the target and keep everything else. Omit for the Shape fork (a person's own copy). */
ownership?: { identity: { name: string; type: PackageType; source?: string }; userEditable: string[] };
```

and `activate`'s argument becomes `{ path: string; fileNotices: PackageFileNotice[] }` (empty array when ownership is unset or the target was absent). Update every caller's type (the five flows + services/shapes/fork.ts), no behaviour change for the fork. 2. In runTransactionUnlocked: after `opts.stage` resolves and BEFORE `moveTargetAside`, when `ownership` is set: `computeInstalledFiles(stagingDir, …)` and `writeInstalledFiles(stagingDir, record)`. A failure here is a stage failure (staging removed, target untouched). 3. After the backup is taken (step 3) and before activate, when ownership is set AND a backup exists: step 3b `carryPersonFiles(backupPath, stagingDir, rNew)`:

- read rOld = readInstalledFiles(backupPath); oldHasIdentity = hasPackageIdentity(backupPath) (task 2.4; until 2.4 lands, inline check for `.dork/manifest.json` or `.claude-plugin/plugin.json`);
- if rOld null and identity present -> call the legacy rebuild hook `opts.ownership.rebuildLegacy?.(backupPath)` (added in task 2.8; until then treat as no-identity so nothing is lost);
- walk the backup (lstat, hashing regular files that are in rOld or in rNew; others need no hash), build `planCarryOver` input, apply the plan to the STAGING dir with COPIES from the backup (`fs.cp(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, force: true })`; carry `carryDirs` as one cp each); never move or modify anything in the backup;
- add the plan's `.dork-new` paths (with their hashes) to the staged record and rewrite it;
- pass the plan's notices to `activate({ path, fileNotices })`.
  Any error in 3b is treated like an activate failure (existing rollback: remove partial target, restore the untouched backup, remove staging, rethrow). The backup is complete, so the rollback restores it byte-for-byte.

4. Update the module header (lifecycle list) with step 3b and why copy, not move: the backup must stay whole until the install commits (crash safety; backup-janitor sweeps backups older than 24h).

TESTS apps/server/src/services/marketplace/**tests**/transaction.test.ts (real temp dirs):

- with ownership: the activated target contains `.dork/installed-files.json` listing the staged files; node_modules excluded.
- reinstall over a target that has `config/mine.json` (not in R_old) -> present after; a recorded unchanged file removed by the new version -> gone; a recorded edited file -> row 5 outcome + notice reaches activate.
- activate throws after carry-over -> the target equals the original byte-for-byte (compare a hash of every file incl. person files) and no staging/backup dirs remain.
- without ownership (fork path) behaviour unchanged (existing tests stay green).
- purpose comments; each assertion can fail (mutation-check: drop the carry call and see the person-file test fail).

VERIFY: pnpm vitest run apps/server/src/services/marketplace/**tests**/transaction.test.ts apps/server/src/services/marketplace/**tests**/transaction-concurrency.test.ts; typecheck + lint server.

### Task 2.3: Pass ownership from all five install flows, create .dork/data, and surface notices

- **Size:** large · **Priority:** high · **Depends on:** 2.2, 1.3 · **Parallel with:** 2.4, 2.5, 3.1

WHY: the transaction only records and carries when a flow passes `ownership` (spec §2, §4, §10, §12).

CHANGES:

1. marketplace-installer.ts `install()`: compute the record identity once from the resolved source: `{ name: manifest.name, type: manifest.type, source }` where source = the staged `sourceKey` rendered `<cloneUrl>#<subpath>@<ref>` (use `sourceKeyOf` from @dorkos/marketplace source-resolver.ts:70), else the canonical local path for a local-directory install. Pass it to the flow via its `opts` (extend each flow's opts type from `Pick<InstallRequest,'projectPath'>` to also carry `recordIdentity`).
2. Each flow (flows/install-plugin.ts, install-agent.ts, install-skill-pack.ts, install-adapter.ts, install-shape.ts) passes `ownership: { identity: opts.recordIdentity, userEditable: resolveUserEditable(manifest) }` to runTransaction.
3. Each flow's activate, right after its atomicMove: `mkdir(path.join(target, '.dork', 'data'), { recursive: true })` (the package's ${CLAUDE_PLUGIN_DATA}, spec §10). Put this in ONE shared helper in lib/installed-files.ts (`ensurePackageDataDir(root)`) so no flow can drift.
4. Each flow copies `fileNotices` from activate's argument onto its InstallResult (`fileNotices`) and appends one plain sentence per notice to `warnings`, via ONE shared formatter `describeFileNotices(notices): string[]` in lib/installed-files.ts. Wording (writing-for-humans skill, plain, no jargon): replaced-edit -> "You had changed <path>. The new version replaced it; your copy is at <savedAs>." kept-edit -> "Kept your changes to <path>. The new version's default is at <savedAs>." kept-no-longer-shipped -> "Kept your <path>. The new version no longer includes it." Five or more notices -> ONE sentence: "<n> files you had changed were kept or saved beside the new version's copies. See the list in the install result." (fileNotices still carries all).
5. Source-changed warning (spec §12): in the transaction step 3b (or returned from it with the notices), when rOld.package.source exists and differs from the incoming identity.source, add the warning "Files kept from the earlier <name> (from <old source>) are now available to this one (from <new source>)." Thread it the same way as notices (e.g. a `warnings` array alongside fileNotices on activate's argument).

TESTS: in each flows/**tests**/install-<type>.test.ts: install, write `config/mine.json` and `.dork/data/state.json` into the install root, reinstall the same package -> both intact, `.dork/installed-files.json` present and not listing them; `.dork/data` exists after a fresh install. One flow test (plugin) asserts a row-5 notice reaches result.fileNotices AND result.warnings with the exact sentence. Source-change warning test in marketplace-installer.test.ts.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/flows/**tests**/ apps/server/src/services/marketplace/**tests**/marketplace-installer.test.ts; typecheck + lint server.

### Task 2.4: One predicate for 'installed': a root needs a package identity

- **Size:** medium · **Priority:** medium · **Depends on:** none · **Parallel with:** 1.1, 1.2, 1.3, 2.1, 2.2, 3.1

WHY: after an uninstall keeps a person's files (task 2.5), the install root still exists but holds no package. Today `UninstallFlow.locate` and `locateInstallRoot` accept any existing directory (uninstall.ts locate() uses pathExists), so `dorkos update flow` on such a root would 'update' nothing (spec §7).

CHANGES:

1. apps/server/src/services/marketplace/lib/locate-install.ts: export `hasPackageIdentity(root): Promise<boolean>` — true iff `<root>/.dork/manifest.json` (PACKAGE_MANIFEST_PATH) or `<root>/.claude-plugin/plugin.json` (CLAUDE_PLUGIN_MANIFEST_PATH) exists as a file. Same predicate Harness Sync uses (packages/harness/src/sources/installed.ts ~L312-350) and the installed scanner effectively uses.
2. `locateInstallRoot` and `UninstallFlow.locate` (flows/uninstall.ts) skip candidates without an identity (continue probing; none left -> PackageNotInstalledError as today).
3. conflict-detector.ts `package-name` rule: count a same-named directory only when it has an identity, so installing into a kept root is a plain install, not a 'same name exists' warning.
4. Confirm (test, no code change expected) that flows/update.ts enumeration (readInstalledIdentity) and installed-scanner.ts `scanInstalledPackages` / `scanInstallationsAcrossScopes` ignore a root with no identity.

TESTS: a temp root holding only `config/config.json` + `.dork/installed-files.json` is: not found by locateInstallRoot; uninstall throws PackageNotInstalledError; not listed by either scanner; not enumerated by the update check; no package-name conflict. A root with only plugin.json IS found.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/**tests**/conflict-detector.test.ts apps/server/src/services/marketplace/**tests**/installed-scanner.test.ts apps/server/src/services/marketplace/flows/**tests**/uninstall.test.ts apps/server/src/services/marketplace/flows/**tests**/update.test.ts plus the locate-install test file; typecheck + lint server.

### Task 2.5: Uninstall keeps every file the person added or changed, and the record

- **Size:** medium · **Priority:** high · **Depends on:** 2.1, 2.4 · **Parallel with:** 2.3, 3.1

WHY: today uninstall keeps only `.dork/data/` and `.dork/secrets.json` (flows/uninstall.ts DATA_SUBPATH, SECRETS_SUBPATH, restorePreservedData). Under the new rule it keeps everything the record does not prove is the package's (spec §5).

CHANGES flows/uninstall.ts:

1. DELETE `DATA_SUBPATH`, `SECRETS_SUBPATH`, `restorePreservedData`.
2. Add `restorePersonFiles(stagingPath, installRoot): Promise<string[]>` run where restorePreservedData ran (after side effects, only when `purge` is false):
   - rOld = readInstalledFiles(stagingPath). If null and the staged copy has an identity -> legacy: call the rebuild (task 2.8; until it lands, fall back to keeping everything except identity files, `.dork/install-metadata.json` and `node_modules/`).
   - Keep = every entry in the staged copy EXCEPT: files in rOld whose current hash equals the recorded one; anything under rOld.ownedTrees; `.dork/install-metadata.json`. `.dork/installed-files.json` IS kept.
   - If Keep contains nothing but the record, copy nothing back (no empty shell for an untouched package).
   - Copy kept entries back into installRoot with fs.cp (verbatimSymlinks, preserveTimestamps), carrying a directory with no recorded file beneath it as one unit.
   - Return `preservedData`: absolute paths collapsed to the highest directory whose whole contents were kept, excluding the record itself.
3. Module header + TSDoc updated: 'Data preservation' paragraph now states the ownership rule.
4. purge: true unchanged (nothing copied back). Rollback path unchanged.

TESTS flows/**tests**/uninstall.test.ts: install via the real flow (so a record exists), add `config/mine.json`, `.dork/data/x`, edit one shipped file, leave another untouched; uninstall -> kept: mine.json, data/x, the edited file, the record; gone: the untouched shipped file, install-metadata, node_modules; preservedData collapsed (a fully-kept `config/` dir appears once). Untouched package -> install root no longer exists. purge -> nothing kept. Existing side-effect/rollback tests stay green. Mutation-check: invert the hash comparison and see tests fail.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/flows/**tests**/uninstall.test.ts apps/server/src/services/marketplace/**tests**/failure-paths.test.ts; typecheck + lint server.

### Task 2.6: Simplify MarketplaceInstaller.applyUpdate to uninstall then install

- **Size:** medium · **Priority:** high · **Depends on:** 2.3, 2.5 · **Parallel with:** 2.7, 3.1

WHY: the scratch-dir snapshot (applyUpdate steps 3 and 5), the install-failure restore and findInstallRootFromPreservedPath existed only to carry two paths across; the transaction now carries everything (spec §6).

CHANGES apps/server/src/services/marketplace/marketplace-installer.ts:

1. applyUpdate becomes: capture wasActiveShape; `uninstallFlow.uninstall({ name, purge: false, projectPath, deactivateShape: false })` (leaves the person's files + old record at the root); `this.install({ ...req, force: true })` (its transaction backs that root up, carries, activates, and restores it exactly on failure); re-apply the active Shape (unchanged block).
2. DELETE: the mkdtemp/scratch copy, the `rm(installRoot)`, the catch-block restore, the copy-back, `findInstallRootFromPreservedPath`, and the local `pathExists` if it has no other user. Remove now-unused imports (cp, mkdtemp, tmpdir, etc.).
3. Rewrite update()'s TSDoc (the five steps; cite ADR 260923-163513 and that it amends ADR-0233). Keep the DOR-1722 lock paragraph (the one withInstallTargetLock hold around both halves; re-entrant for the transaction's own take).
4. flows/update.ts header lines ~9 and ~82: replace "preserves `.dork/data/` and `.dork/secrets.json`" with "keeps the files you and your agents added or changed".

TESTS marketplace-installer.test.ts / flows/**tests**/update.test.ts: update keeps `config/mine.json` and `.dork/data/x`; a recorded edited shipped file gets row 5 (.dork-old) and a notice; the scratch-dir test is deleted with the code; an install failure mid-update leaves the root holding exactly the person's files (the kept root), not the old package and not nothing; assert no `dorkos-update-preserve-` dir is ever created (spy mkdtemp or scan tmpdir).

VERIFY: pnpm vitest run apps/server/src/services/marketplace/**tests**/marketplace-installer.test.ts apps/server/src/services/marketplace/flows/**tests**/update.test.ts apps/server/src/services/marketplace/**tests**/integration.test.ts; typecheck + lint server.

### Task 2.7: A marketplace agent adopts its existing workspace and keeps its id

- **Size:** medium · **Priority:** high · **Depends on:** 2.3 · **Parallel with:** 2.6, 2.8, 3.1

WHY: every agent install, the reinstall half of an update included, calls createAgentWorkspace({ skipTemplateDownload: true }), which mints a new ulid() (agent-creator.ts ~L382) and rewrites .dork/agent.json, .dork/SOUL.md, .dork/NOPE.md (~L424-440). Mesh then sees a new id at the old path (branch swap) and drops the old row without the unregister cascade (DOR-1791 F1). ADR 260923-163516; same rule as ADR 260903-023414 (registration adopts, the id on disk wins).

CHANGES:

1. apps/server/src/services/core/agent-creator.ts: `createAgentWorkspace(opts, internal?: { adoptExisting?: boolean })`. The second parameter is server-internal and MUST NOT be added to `CreateAgentOptionsSchema` (packages/shared/src/mesh-schemas.ts:950), which is the public createAgent transport contract. `adoptExisting` requires `opts.skipTemplateDownload === true` (throw otherwise). In adopt mode, when `<dir>/.dork/agent.json` exists and parses: reuse its `id` (and the rest of that manifest as-is), do not call writeManifest, and write `.dork/SOUL.md` / `.dork/NOPE.md` only if absent; run the rest of the pipeline (mesh sync etc.) exactly as a fresh scaffold would. If agent.json is present but unreadable -> throw naming the file (never overwrite the only copy; same discipline as ADR 260903-023414). If absent -> fresh scaffold as today.
2. apps/server/src/services/marketplace/flows/install-agent.ts activate: pass `{ adoptExisting: true }`. When adopting and the new manifest's agentDefaults (traits, icon) differ from the adopted agent.json, add ONE warning: "Kept this agent's own settings. The new version suggests different traits; change them in the agent's settings if you want them." (writing-for-humans pass on the wording).
3. The four persona files are user-editable for agent packages via resolveUserEditable (task 1.1), so a package-shipped SOUL.md the person edited is kept (row 6).

TESTS: agent-creator.test.ts — adopt reuses id, does not rewrite an edited SOUL.md, writes a missing NOPE.md; adoptExisting without skipTemplateDownload throws; unreadable agent.json throws; fresh install still mints an id; CreateAgentOptionsSchema.parse strips an `adoptExisting` key from a body. install-agent.test.ts / update test — update an installed agent package: agent.json id unchanged, edited .dork/SOUL.md intact, .dork/MEMORY.md intact. Mesh integration (the DOR-1791 U1 evidence bar): after update, meshCore.getProjectPath(oldId) still resolves (use the existing mesh test harness the agent flow tests use).

VERIFY: pnpm vitest run apps/server/src/services/core/**tests**/agent-creator.test.ts apps/server/src/services/marketplace/flows/**tests**/install-agent.test.ts; typecheck + lint server; rebuild shared if touched.

### Task 2.8: Rebuild a legacy install's record from its recorded commit, with a no-loss fallback

- **Size:** large · **Priority:** high · **Depends on:** 2.2, 2.5 · **Parallel with:** 2.7, 3.1

WHY: every install made before this ships has no record. The four real flow installs (dorkos, dorkos-cloud, blintz at 0.7.3/ee1c8eb with sourceKey; trame-algo-playground at 0.1.1) must update with their config intact (spec §9).

DEPENDS ON DOR-2248 having landed (exact fetch by SHA). Read its merged change first and use its API.

CHANGES lib/installed-files.ts: `rebuildInstalledFiles(installRoot, deps: { cache, fetcher, logger }): Promise<InstalledFiles | 'unavailable'>`:

1. Read `.dork/install-metadata.json` (readInstallMetadata). Need name + commitSha + sourceKey; absent -> 'unavailable'.
2. Obtain the original tree WITHOUT trusting the live root: the package cache entry `<name>@<commitSha>` if present, else the fetcher pinned to sourceKey + commitSha.
3. stagePackageContents(tree, tmpDir) (strips symlinks + root .npmrc, as installs do), computeInstalledFiles(tmpDir, { identity from metadata, userEditable: resolveUserEditable(manifest of that tree), ownedTrees: ['node_modules'] }), write it to `<installRoot>/.dork/installed-files.json`, log info, remove tmpDir.
4. Wire it: the transaction's step 3b `rebuildLegacy` hook (task 2.2) and uninstall's legacy branch (task 2.5) call it. The installer supplies deps (it already holds the cache/fetcher).
5. FALLBACK when 'unavailable' (spec §9 step 4): step 3b treats EVERY backup file as an edited shipped file: where the new version ships the path, the new copy wins and the live copy is saved as .dork-old ONLY if bytes differ; everything the new version does not ship stays in place; add ONE grouped warning listing the kept-but-not-shipped paths ("Kept <n> files this package's new version doesn't include, because DorkOS couldn't tell whether you added them: <list>. Delete any you don't need."). Uninstall fallback: keep everything except `.dork/manifest.json`, `.claude-plugin/plugin.json`, `.dork/install-metadata.json`, node_modules/, and say so in the result. Implement the fallback inside planCarryOver as an explicit mode, not a special case at the call site.

TESTS: a root with manifest, no record, whose commit is in a fake cache -> exact record written; then update keeps config/config.json (row 9) and replaces shipped files silently. Cache miss + fetcher success -> same. Both fail -> fallback: shipped paths replaced (.dork-old only when bytes differed), unshipped kept, one warning. Local-path install (no commitSha) -> fallback. A tampered record (key `../x`) -> treated as absent -> rebuilt.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/**tests**/installed-files.test.ts apps/server/src/services/marketplace/flows/**tests**/update.test.ts apps/server/src/services/marketplace/flows/**tests**/uninstall.test.ts; typecheck + lint server.

### Task 2.9: Rewrite every sentence that names the old preserved set

- **Size:** small · **Priority:** medium · **Depends on:** 2.5 · **Parallel with:** 2.6, 2.7, 2.8, 3.1

WHY: surfaces still tell people and agents that uninstall keeps `.dork/data/` and `.dork/secrets.json` (spec §12).

CHANGE each to "the files you and your agents added or changed" (plain words, writing-for-humans skill; keep each sentence's existing structure):

- apps/server/src/services/marketplace-mcp/tool-uninstall.ts:43 (purge describe)
- apps/server/src/services/marketplace-mcp/marketplace-capabilities.ts:237
- apps/server/src/services/marketplace-mcp/confirmation-provider.ts:225 (TSDoc)
- packages/shared/src/marketplace-schemas.ts:489 (done in 1.3 if not already)
- packages/cli/src/commands/uninstall.ts:5-6 header + any help text; its 'Preserved:' listing stays (prints preservedData)
- packages/operating-skills/src/skills/using-the-marketplace.ts:88 — the pack is version-stamped: bump it per the seeder's rule (read packages/operating-skills README / the seeder for the exact bump)
- apps/server/src/services/core-extensions/ensure-core-extensions.ts:107 (comment: '.dork/data survives' stays true; reword to the general rule)
  Then `grep -rn "secrets.json" apps packages --include=*.ts` (excluding tests and the reserved-path constants) must list nothing that describes the preserved set.

TESTS: update any snapshot/string assertions these touch (grep **tests** for the old sentences); an operating-skills seeder test must still pass with the bumped version.

VERIFY: pnpm vitest run on the touched test files; typecheck + lint for server, cli, operating-skills, shared.

## Phase 3: ${CLAUDE_PLUGIN_DATA} (@dorkos/harness)

### Task 3.1: Rewrite ${CLAUDE_PLUGIN_DATA} to the install root's .dork/data in projected commands and hooks

- **Size:** medium · **Priority:** medium · **Depends on:** none · **Parallel with:** 1.1, 1.2, 1.3, 2.1, 2.2, 2.4

WHY: Claude Code tells plugin authors to keep state in ${CLAUDE_PLUGIN_DATA}. Harness Sync rewrites only ${CLAUDE_PLUGIN_ROOT}; a projected hook using the data token runs as a project hook where the variable is unset, so "${CLAUDE_PLUGIN_DATA}/x" becomes "/x" (spec §10, ADR 260923-163515).

CHANGES packages/harness/src:

1. scan/scanner.ts: `export const CLAUDE_PLUGIN_DATA_TOKEN = '${CLAUDE_PLUGIN_DATA}';` beside CLAUDE_PLUGIN_ROOT_TOKEN (L75), TSDoc.
2. plan/installed-projector.ts: at EVERY site that rewrites the root token (command wrappers ~L235 and ~L280, hook commands ~L304-335, and wherever else `.split(CLAUDE_PLUGIN_ROOT_TOKEN)` appears) also rewrite the data token to `join(installDir, '.dork', 'data')` with the same separator handling the root rewrite uses (read the comment at ~L208 about join() and Windows separators and follow it). Prefer one helper `rewritePluginTokens(text, installDir)` used by all sites so they cannot drift.
3. generate/hooks.ts: add the data token to CLAUDE_ONLY_HOOK_TOKENS (~L219) and to the Codex/OpenCode hook path (~L361) the same way the root token is handled.
4. Projected skills (symlinks, cannot be rewritten): sources/installed.ts computes `usesPluginRoot` (~L554); add `usesPluginData` and a warning sibling of PLUGIN_ROOT_SKILL_WARNING_REASON (installed-projector.ts ~L466) naming ${CLAUDE_PLUGIN_DATA}.
5. adopt/refusals.ts (~L47, L104, L182): name both tokens in the refusal copy.

TESTS (packages/harness **tests** beside each file): a command wrapper and a hook command containing ${CLAUDE_PLUGIN_DATA} come out as `<installDir>/.dork/data` (POSIX and win32 path fixtures, as the root-token tests do); a string with both tokens rewrites both; a skill using the data token yields the new warning; the Codex hook path rewrites it; refusal copy names both tokens.

VERIFY: pnpm vitest run packages/harness/src; pnpm --filter @dorkos/harness typecheck && lint.

## Phase 4: Documentation and proof

### Task 4.1: Document the ownership rule for developers, users and package authors, plus the changelog

- **Size:** medium · **Priority:** medium · **Depends on:** 2.6, 2.7, 2.8, 2.9, 3.1 · **Parallel with:** 4.2

CHANGES:

1. contributing/marketplace-installs.md: §1 key invariants gains the ownership rule ("DorkOS removes or replaces only files it can prove the install put there, unchanged"); §4 Uninstall 'Data preservation' and §4 Update step 5 rewritten (no more two-path set); §5 lifecycle gains the record write (after stage) and step 3b (carry-over: copy not move, why); §5.1 notes node_modules is an owned tree; §7 line ~353: replace "DOR-1791 tracks restoring it properly" with the true state (DOR-1791 closed with only its ideation built; a file under a package agent now survives an update; creating one there is still refused pending the follow-up item named by the orchestrator); §16 'What is deliberately not solved here' gains the SDK-delivered global plugin ${CLAUDE_PLUGIN_DATA} limit owned by DOR-174. Follow writing-developer-guides.
2. docs/marketplace/index.mdx (users; writing-for-humans, 9th-grade plain): what update, reinstall and uninstall keep; what `.dork-old` and `.dork-new` files are and what to do with them; `--purge`.
3. docs/marketplace/publishing.mdx: new section "Where your package keeps its settings": write state to ${CLAUDE_PLUGIN_DATA} (DorkOS: the install's .dork/data folder, kept across updates, removed only by uninstall --purge); `userEditable` for shipped defaults meant to be edited (exact paths or dir/**) with a JSON example; the reserved paths; set minDorkosVersion when relying on userEditable. Do not claim Claude-Code-superset compatibility is verified (demo-claim gate).
4. .claude/skills/marketplace-dev/SKILL.md: the same authoring rules, concise, for agents. If .agents/skills mirrors it, keep them in sync (syncing-agent-skills skill).
5. ADRs: add an 'Amended by 260923-163513 (spec marketplace-package-file-ownership)' line under Status in decisions/0233-_.md and decisions/0304-_.md, and correct 0233's five-step update prose to point at the new flow. Leave the four new ADRs at status draft (acceptance happens at /adr:from-spec/review time).
6. ONE changelog fragment: `changelog/unreleased/<id>-keep-package-settings-on-update.md` (id from .claude/scripts/id.ts; follow changelog/README.md format + writing-for-humans): Updating or reinstalling a marketplace package now keeps the settings and files you and your agents added to it. If you had changed one of the package's own files, your copy is saved beside the new one. Marketplace agents keep their identity and memory across updates. Fold any hook-seeded stub fragments' covers: lines into it and delete the stubs.
7. Run `bash scripts/check-banned-words.sh` and `node --experimental-strip-types scripts/check-vocab-gate.ts` (or the documented invocations) on the changed prose.

VERIFY: the docs build for touched MDX if a targeted check exists (pnpm --filter @dorkos/site typecheck is heavy; at minimum run prettier --check on the files); banned-word and vocab gates green.

### Task 4.2: Prove it on a real flow install and measure carry-over cost

- **Size:** medium · **Priority:** high · **Depends on:** 4.1 · **Parallel with:** none

1. REAL-INSTALL PROOF (spec Testing Strategy): copy /Users/doriancollier/Keep/dork-os/blintz/.dork/plugins/flow into a temp project's .dork/plugins/flow (do NOT touch the real installs). Drive the server's MarketplaceInstaller.update() (a small vitest integration test or a script under the worktree's .temp/, never committed if it is a script) against the next flow commit available on dork-labs/marketplace main (or a local fixture built from it). Assert and record: a legacy record was rebuilt from ee1c8eb; config/config.json and config/config.local.json are byte-identical before and after; no .dork-old files were written for flow's shipped files; the new record exists. Paste the before/after hashes into specs/marketplace-package-file-ownership/04-implementation.md.
2. PERFORMANCE: build a synthetic agent package install whose root holds a ~1 GB person-owned working tree (e.g. 2,000 files of 512 KB in nested dirs) and time an update's carry-over (step 3b) on this machine. Record the number and the file count in 04-implementation.md. If a carry-over takes longer than ~30 s, record it as a follow-up (sibling same-filesystem staging with renames and rename-back rollback), do not weaken copy-not-move.
3. Write specs/marketplace-package-file-ownership/04-implementation.md (house style of specs/marketplace-version-truth/04-implementation.md): what shipped per task, deviations from the spec with reasons, verification summary lines, the proof and the measurement.
4. Final targeted verification for every touched package: vitest on all touched test files, typecheck + lint for @dorkos/marketplace, @dorkos/shared, @dorkos/harness, @dorkos/server, dorkos (cli), @dorkos/operating-skills. Update the spec manifest status to implemented via spec-manifest-ops.ts only after all pass.
