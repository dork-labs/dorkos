# Tasks: marketplace-package-file-ownership

Spec: [`02-specification.md`](./02-specification.md). Generated 2026-09-23T17:07:21Z. Canonical source: `03-tasks.json`.

All tasks land in the **dorkos** repo, in one PR with the spec docs. No dork-labs/marketplace change is part of this item.

## Critical path

1.1 → 2.1 → 2.2 → 2.3 → 2.5 → 2.11 → 2.6 → 4.1 → 4.2. 2.8 and 4.2 need DOR-2248 merged, including its fetch of a named past commit; 2.11 needs DOR-2273's per-kind janitor policy seam. 1.2, 1.3, 1.4, 2.4, 2.10 and 3.1 run in parallel.

## Phase 1: The contract (@dorkos/marketplace, @dorkos/shared)

### Task 1.1: Add userEditable, its matcher, and the reserved-path list to @dorkos/marketplace

- **Size:** medium · **Priority:** high · **Depends on:** none · **Parallel with:** 1.3, 1.4, 2.4, 3.1

WHY: a package needs one way to say 'this shipped file is meant to be edited' (ADR 260923-163514), and DorkOS needs one list of paths a package may never ship (spec §3, §11).

CHANGES (packages/marketplace/src):

1. constants.ts: export `INSTALLED_FILES_PATH = '.dork/installed-files.json'`, `UNINSTALLED_AGENT_PATH = '.dork/uninstalled-agent.json'`, `PACKAGE_DATA_DIR = '.dork/data'`, `PACKAGE_SECRETS_PATH = '.dork/secrets.json'`, `KEPT_COPY_SUFFIXES = ['.dork-old', '.dork-new'] as const`, `AGENT_IDENTITY_FILES = ['.dork/agent.json', '.dork/SOUL.md', '.dork/NOPE.md', '.dork/MEMORY.md'] as const` (TSDoc: never recorded as package files; a package's copy only seeds an install where absent, ADR 260923-163516). Reuse PACKAGE_MANIFEST_PATH / CLAUDE_PLUGIN_MANIFEST_PATH / AGENT_MANIFEST_PATH where they already exist.
2. New module `user-editable.ts` (browser-safe; no node imports), exported from index.ts:
   - `isReservedPackagePath(posixPath)`: true for `.dork/data` and anything under it, `.dork/secrets.json`, `.dork/install-metadata.json`, `.dork/installed-files.json`, `.dork/uninstalled-agent.json`, and any path whose basename ends `.dork-old`/`.dork-new` optionally followed by `.<digits>`.
   - `UserEditablePathSchema`: accepts a POSIX relative path or `dir/**`. Rejects: empty, absolute, any `..` segment, backslash, leading `./`, any other `*`/`?`, a pattern covering a reserved path, and a pattern covering `.dork/manifest.json` or `.claude-plugin/plugin.json` (package identity is never the person's). Specific message per rejection.
   - `matchesUserEditable(posixPath, patterns)`: `p === pattern` or, for `dir/**`, `p.startsWith(dir + '/')`.
     NOTE (revision 2): agent identity files are NOT added to userEditable; they are handled by never being recorded (tasks 2.1, 2.7).
3. manifest-schema.ts, shared base manifest (every type): `userEditable: z.array(UserEditablePathSchema).max(100).default([])` with the TSDoc from spec §3; note that older DorkOS strips it, so packages relying on it set minDorkosVersion. The CC-only synthesized manifest yields [].
4. Regenerate any generated JSON schema of the manifest if a generator exists (grep).

TESTS (**tests**/user-editable.test.ts + manifest-schema tests): accepts `a/b.json`, `dir/**`; rejects `../x`, `/x`, `*.json`, `a\\b`, `dir/*`, `./a`, `.dork/data/**`, `.dork/secrets.json`, `.dork/**`, `.dork/manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/**`; matcher cases incl. `dir/**` not matching `dirx/a`; isReservedPackagePath true for `.dork/data`, `.dork/data/x/y`, `.dork/uninstalled-agent.json`, `x/SKILL.md.dork-old`, `x.dork-new.3`; false for `.dork/database.json`, `x.dork-older`.

VERIFY: pnpm vitest run packages/marketplace/src/**tests**/user-editable.test.ts packages/marketplace/src/**tests**/manifest-schema.test.ts; typecheck + lint @dorkos/marketplace; rebuild it.

### Task 1.2: Refuse a package that ships a reserved path (RESERVED_PATH_SHIPPED)

- **Size:** small · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 1.3, 1.4, 2.4, 3.1

WHY: spec §11, third layer (publishing and `dorkos marketplace validate`). Layers one and two are task 2.10 (strip at copy) and 2.1 (exclude from the record).

CHANGE packages/marketplace/src/package-validator.ts `validatePackage`: walk the package tree (skip node_modules and .git) and for every regular file whose POSIX path satisfies isReservedPackagePath push `{ level: 'error', code: 'RESERVED_PATH_SHIPPED', message: `${p} is a path DorkOS keeps for the person or the installer (.dork/data/, .dork/secrets.json, .dork/install-metadata.json, .dork/installed-files.json, .dork/uninstalled-agent.json, *.dork-old, *.dork-new). Remove it from the package.` }` (ValidationIssue shape, package-validator.ts:40).
An INSTALLED root legitimately holds installer files, and validatePackage is also called on installed roots (installed-scanner.ts readManifestSummary -> validatedSummary for CC-only packages). Grep every caller; gate the check behind an option (`{ tree: 'package' | 'installed' }`, default 'package') and pass 'installed' from those callers. Document it in TSDoc. Confirmed: no dork-labs/marketplace package ships a reserved path (git ls-files at ee1c8eb).

TESTS: one fixture per reserved kind -> exactly one RESERVED_PATH_SHIPPED naming the path; near-misses do not; node_modules ignored; 'installed' mode reports nothing for its own .dork/install-metadata.json and .dork/installed-files.json.

VERIFY: pnpm vitest run packages/marketplace/src/**tests**/package-validator.test.ts; typecheck + lint @dorkos/marketplace.

### Task 1.3: Add PackageFileNotice, InstallResult.fileNotices and the new sibling markers to @dorkos/shared

- **Size:** small · **Priority:** medium · **Depends on:** none · **Parallel with:** 1.1, 1.2, 1.4, 2.4, 3.1

CHANGES:

1. packages/shared/src/marketplace-schemas.ts near InstallResult (~L465):

```ts
/** What an install did with a file the person may have changed. */
export interface PackageFileNotice {
  /** Root-relative POSIX path of the file. */
  path: string;
  /** `replaced-edit`: the package's copy is in place; yours is at `savedAs`.
   *  `kept-edit`: your copy is in place; the package's new default is at `savedAs`.
   *  `kept-no-longer-shipped`: your copy is in place; the package no longer ships this file.
   *  `late-write`: this changed while the update ran; the newest copy is in place (yours at `savedAs` if it collided).
   *  `skipped-special`: a socket, pipe or device file was not copied. */
  outcome:
    'replaced-edit' | 'kept-edit' | 'kept-no-longer-shipped' | 'late-write' | 'skipped-special';
  /** Root-relative POSIX path of the saved copy, when one was written. */
  savedAs?: string;
}
```

`InstallResult.fileNotices?: PackageFileNotice[]` (TSDoc: each is also one plain sentence on `warnings`). Mirror in any InstallResult zod twin (grep InstallResultSchema) and on the server InstallResult (apps/server/src/services/marketplace/types.ts). 2. UninstallResult (~L500) and the server copy in flows/uninstall.ts: `preservedData` TSDoc -> "Absolute paths kept on disk because `purge` was false: the files you and your agents added or changed, collapsed to the highest directory whose whole contents were kept." Add `agentRemoved?: { id: string; directoryDenied: boolean; removed: AgentRemovalEffect[] }` where `AgentRemovalEffect = 'relay-endpoint' | 'rooms' | 'schedules-paused' | 'task-roots' | 'mcp-sign-ins' | 'identity-tokens' | 'community-enrollments' | 'connection-access'` (TSDoc: set when uninstalling an agent package removed it from the team; a reinstall restores none of these, spec §5). Also add `warnings?: string[]` to UninstallResult if absent (step-4 failure and side-effect notes). Purge field TSDoc (~L489): "Also remove the files you and your agents added or changed." 3. Next to `MARKETPLACE_BACKUP_DIR_MARKER = '.dorkos-bak-'` (L677) add `MARKETPLACE_STAGE_DIR_MARKER = '.dorkos-stage-'` and `MARKETPLACE_UNINSTALL_DIR_MARKER = '.dorkos-uninstall-'`, TSDoc in the same style (same-filesystem siblings of an install target; never agents or packages), and `export function isInstallSiblingName(name: string): boolean` — true when the name contains any of the three markers. It is THE predicate every reader of an install root uses (spec §14, review N1); unit-test it.

VERIFY: rebuild @dorkos/shared; typecheck @dorkos/shared and @dorkos/server.

### Task 1.4: Add writeConventionFileIfAbsent to @dorkos/shared

- **Size:** small · **Priority:** high · **Depends on:** none · **Parallel with:** 1.1, 1.2, 1.3, 2.4, 3.1

WHY (review blocker 2): `writeConventionFile` always overwrites (packages/shared/src/convention-files-io.ts:67-74), so every agent scaffold rewrites `.dork/MEMORY.md`, SOUL.md and NOPE.md. Marketplace installs must write them only when absent (spec §8).

CHANGE convention-files-io.ts: export `writeConventionFileIfAbsent(projectPath, filename, content): Promise<boolean>` — under the same `withFileLock(filePath, …)` as writeConventionFile, create the file exclusively (open with flag 'wx' or equivalent atomic create; an existing file, including an empty one, is left untouched) and return whether it wrote. TSDoc explains why it exists (marketplace agents' identity files are the agent's, ADR 260923-163516). Do not change writeConventionFile's behaviour.

TESTS (**tests** beside it): writes when absent; leaves an existing file byte-identical and returns false; an existing EMPTY file is left alone; two concurrent calls write once.

VERIFY: pnpm vitest run packages/shared/src/**tests**/convention-files-io.test.ts (or its actual path); rebuild + typecheck @dorkos/shared.

## Phase 2: Ownership in the installer (apps/server)

### Task 2.1: Build lib/installed-files.ts: the record, its defensive reader, and the carry-over classifier

- **Size:** large · **Priority:** high · **Depends on:** 1.1, 1.3 · **Parallel with:** 2.4, 2.10, 3.1

WHY: the root cause of DOR-2245 is that the installer has no record of which files it installed (spec §1, §2). This module is that record plus the pure decision table every later task uses.

NEW FILE apps/server/src/services/marketplace/lib/installed-files.ts (TSDoc every export; module header states the rule: DorkOS removes or replaces only files it can prove the install put there, unchanged, reached through real directories).

1. Schema (zod): `{ version: 1, package: { name, type, source?: { cloneUrl, subpath, ref } | { localPath } }, ownedPaths: string[], files: Record<posixPath, 'sha256:<hex>'>, pendingDefaults: Record<dorkNewPath, shadowedPath>, userEditable: string[], uninstalledAt?: string, inferred?: true }`.
2. `computeInstalledFiles(root, { identity, userEditable, npmRan })`: walk with lstat; record every REGULAR file except: anything at/under ownedPaths (ownedPaths = ['node_modules', 'package-lock.json'] when npmRan, else []), installer paths (.dork/installed-files.json, .dork/install-metadata.json, .dork/uninstalled-agent.json), reserved paths (isReservedPackagePath), symlinks and special files, and for identity.type === 'agent' the four AGENT_IDENTITY_FILES (review 9: DorkOS writes them itself). Streamed sha256; POSIX keys; sorted.
3. `writeInstalledFiles` (atomic) / `readInstalledFiles(root)` -> null (logged) when missing, unparseable, schema-invalid, or any key/ownedPath is absolute, has a `..` segment, a backslash, or resolves outside root.
   3b. `sameSource(a, b)`: true when both are `{cloneUrl, subpath}` and those two match (normalised as sourceKeyOf does), IGNORING `ref`; or both `{localPath}` and equal. Used by the adoption check (2.7) and the source-changed warning (2.3) — round-3 N8: @main -> @v0.8.0 or a pinned SHA is the same package. Tests for each case.
4. `lstatChain(root, relPath)`: lstat every component; returns { kind: 'file'|'dir'|'symlink'|'special'|'missing', throughSymlink: boolean }. Used by every hash/move/delete in this programme (review 12): a recorded path with throughSymlink=true is 'edited', never read or moved through the link.
5. `isProvenPackageFile(root, relPath, record)`: lstatChain says regular file, not throughSymlink, and hash matches.
6. PURE classifier `planCarryOver(input): CarryOverPlan` over { rOld, oldHasIdentity, rNew, liveEntries: Map<posixPath, {kind, hash?, throughSymlink}>, stagedKinds (lstat facts of the staged tree), caseInsensitive: boolean, mode: 'exact' | 'fallback' }. Output: per-path actions (carry P->P overwriting staged; carryAs P->savedName; saveNewAs staged P->savedName then carry P; drop; skipSpecial), `carryDirs` (live dirs with no R_old and no R_new file beneath: carried as one unit), notices, and the new record's pendingDefaults. Name allocation `allocateSavedName(p, suffix, isTaken: (p)=>boolean)` where isTaken is backed by lstat of the staged tree (plus names allocated in this plan); case-insensitive comparison when caseInsensitive.
   rOld null + no identity -> rows 9-11. rOld null + identity -> throw LegacyInstallError (task 2.8 rebuilds first).

THE RULE TABLE (spec §4, revision 2). R_old = the LIVE root's record (a full install, or the pruned record an uninstall left, which has `uninstalledAt`). R_new = the staged record. U = R_new.userEditable for paths the new version ships, else R_old.userEditable. 'edited' = present with hash != R_old's, OR reached through a symlinked directory (lstat every path component). 'default changed' = R_new hash != R_old hash. 'same bytes' = live hash == R_new hash. Iterate over R_old.files ∪ live files ∪ R_new.files, skipping ownedPaths, installer paths (.dork/installed-files.json, .dork/install-metadata.json, .dork/uninstalled-agent.json), agent identity files (always carried as-is) and pendingDefaults (handled after).
0 not in R_old, absent, new ships -> new copy
1 in R_old, unchanged, new ships -> new copy
2 in R_old, unchanged, new doesn't ship -> gone
3a in R_old, missing, new ships, in U -> stays deleted (person removed an editable default)
3b in R_old, missing, new ships, not U -> new copy
4 in R_old, missing, new doesn't ship -> gone
5 in R_old, edited, new ships, not U -> new copy; person's saved as P.dork-old unless same bytes; notice replaced-edit if saved
6 in R_old, edited, new ships, U -> person's copy; if default changed AND bytes differ, new copy saved as P.dork-new (recorded in pendingDefaults); notice kept-edit if written
7 in R_old, edited, new doesn't ship, not U -> person's copy saved as P.dork-old (NOT left at P); notice replaced-edit
8 in R_old, edited, new doesn't ship, U -> person's copy in place; notice kept-no-longer-shipped
9 not in R_old, present, new doesn't ship -> person's copy in place
10 not in R_old, present, new ships, not U -> new copy; person's saved as P.dork-old unless same bytes; notice replaced-edit if saved
11 not in R_old, present, new ships, U -> person's copy; new copy saved as P.dork-new if bytes differ; notice kept-edit if written
pendingDefaults lifecycle: an existing `.dork-new` (listed in R_old.pendingDefaults -> shadowed path) stays while the shadowed file is still shipped, still in U, and still differs from the default; refreshed when the default changes again; removed once the person's file matches the default or the file is no longer shipped/editable.
Collisions are FILESYSTEM facts: before writing a carried entry or a saved copy, lstat the destination in the staged tree. File<->directory mismatch, or a case-only clash on a case-insensitive volume (probe once per root: lstat a case-flipped existing path), is a collision -> the person's entry is saved under a free .dork-old name. Free names (P.dork-old, P.dork-old.2, .3 ...) are chosen by lstat in the staged tree, never by string compare.
Special files (sockets, FIFOs, devices) are never copied, read or deleted: they produce a `skipped-special` notice.
A live root with no R_old AND no package identity (left by a pre-change uninstall): every entry is rows 9-11. A live root WITH identity but no valid R_old: legacy, rebuild first (task 2.8).

TESTS apps/server/src/services/marketplace/**tests**/installed-files.test.ts (real temp dirs for compute/read/write/lstatChain; plain objects for planCarryOver): compute exclusions (owned paths only when npmRan, installer + reserved paths, symlinks, the four identity files for agents but NOT for plugins); read -> null cases; lstatChain through a symlinked dir; ONE TEST PER ROW 0,1,2,3a,3b,4..11; same-bytes rows 5/10 write no .dork-old; pendingDefaults kept / refreshed / removed; file<->dir collision; case-only collision (caseInsensitive=true input); free name when P.dork-old exists; recorded path through symlinked dir counts as edited; special file -> skipped-special; carryDirs; LegacyInstallError.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/**tests**/installed-files.test.ts; typecheck + lint server.

### Task 2.2: runTransaction: sibling staging, the record, carry from the live root, late-write pass

- **Size:** xl · **Priority:** high · **Depends on:** 2.1, 1.3 · **Parallel with:** 2.4, 2.10, 3.1

WHY: every install flow lands files through runTransaction (transaction.ts), so ownership lives there. Revision 2 adopts review blockers/should-fix 3, 4, 5, 6, 14 (spec §4).

CHANGES:

1. apps/server/src/services/marketplace/lib/atomic-move.ts:45 EXDEV fallback: `cp(source, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })` (review 4; a relative link was being rewritten absolute into a deleted staging dir). Test with an injected EXDEV rename.
2. transaction.ts `TransactionOptions<T>` gains `ownership?: { identity: { name; type; source? }; userEditable: string[]; rebuildLegacy?: (liveRoot) => Promise<InstalledFiles | 'unavailable'> }`; activate's argument becomes `{ path; fileNotices: PackageFileNotice[]; warnings: string[] }` (empty arrays when ownership is unset). Update all callers' types (five flows + services/shapes/fork.ts; fork unchanged in behaviour).
3. When ownership is set, runTransactionUnlocked (lock already held) does, in order:
   a. stage into a SIBLING `<target>${MARKETPLACE_STAGE_DIR_MARKER}<Date.now()>-<uuid>` (mkdir parent -p) instead of mkdtemp(tmpdir()) — same filesystem, no RAM-backed /tmp, activation is a true rename. Immediately write the owner stamp `.dorkos-owner.json` = { pid: process.pid, dataDir: dorkHome, processStartedAt, createdAt } into it (helper from task 2.11's module; the stamp is excluded from the record walk and removed before activation). The BACKUP is the renamed target, so a stamp written inside it would land in the person's tree; its stamp goes in a sidecar FILE next to it, `<backupDirName>.owner.json` (the name carries the `.dorkos-bak-` marker, so isInstallSiblingName hides it), written right after moveTargetAside and removed with the backup; 2.11 reads it as that backup's stamp;
   b. after opts.stage: computeInstalledFiles(staging, { npmRan: <node_modules present in staging> }) and write it;
   c. if the target exists: read R_old from the LIVE target; if null and hasPackageIdentity(target) -> rebuildLegacy (network allowed here, before anything moves; review 6); build planCarryOver input from the live root with lstatChain; apply it to STAGING by cloning from the live root (`copyFile(src, dst, fs.constants.COPYFILE_FICLONE)` per file, mkdir for dirs, symlinks recreated verbatim with readlink/symlink, special files skipped + noticed; carryDirs cloned recursively the same way). The live root is only read. After each file clone apply the source's atime/mtime with `utimes` (copyFile does not preserve them). Hard links become separate clones/copies (documented). SNAPSHOT EVERY LIVE ENTRY while walking the live root (round-3 N6) — carried or not, shipped files included, every file inside unit-carried dirs: source (size, mtimeMs, ino). And every clone's own (size, mtimeMs, ino) taken AFTER its utimes (utimes changes the clone's mtime). Add pendingDefaults to the staged record and rewrite it;
   d. moveTargetAside (unchanged) -> activate({ path, fileNotices, warnings });
   e. LATE-WRITE PASS before runSuccessCleanup deletes the backup (review 14 + round-2 B): walk EVERY backup entry except ownedPaths — shipped files included. ONLY an entry whose stat differs from its source snapshot, or that has none, is a late write; an unchanged shipped file produces nothing. Changed-or-new: if the target's entry at that path still equals the CLONE snapshot (untouched), replace it with a clone of the backup entry (+utimes); otherwise save the backup entry under a free .dork-old name (lstat). Deleted since the snapshot (in snapshot, not in backup): if the target's clone is untouched, remove it; otherwise leave it. Notice `late-write` for each. Then delete the backup. Residuals documented in the module header: absolute-path writes between the two renames get ENOENT; a process whose cwd is the backup keeps writing there after the pass and those writes are lost with the backup.
   Any error in a–c is a stage failure (staging removed, target untouched). Errors in d–e follow today's activate-failure rollback (remove partial target, rename backup back, remove staging) — the person's files were only read, so nothing of theirs is lost.
4. Without ownership, behaviour is exactly today's (tmpdir staging) — the Shape fork.
5. Sibling recognition and crash recovery are task 2.11 (one predicate, one janitor) — do not add ad-hoc marker checks here.
6. Module header lifecycle rewritten; why clone-from-live and why the late-write pass (refusing would block unattended updates; a writer's cwd follows the renamed backup inode so the pass sees its writes; absolute-path writes in the ms between the two renames get ENOENT — documented residual).

TESTS transaction.test.ts (+ backup-janitor, unified-scanner tests): staging dir is a sibling (assert its parent); record activates with the package; reinstall keeps `config/mine.json`; rebuildLegacy is called BEFORE the target moves (fake records call order); activate failure leaves target byte-for-byte original incl. person files and no stage/backup siblings; a file written into the backup after the carry snapshot appears in the new target with a late-write notice; a relative symlink in the live root stays relative; a socket (net.createServer().listen(path)) is skipped with a notice and never read; Mutation-check: remove the carry call -> person-file test fails; remove the late pass -> late-write test fails.

Round-3 tests (N6): an update over an untouched root writes no .dork-old and no late-write notice; a clone's snapshot matches after utimes. Extra round-2 tests: an edit to a file INSIDE a unit-carried directory after the snapshot reaches the target; an edit to a SHIPPED file in the backup reaches the target (or .dork-old when the target now holds a different package file); a file deleted from the backup after the snapshot is removed from the target when its clone is untouched; carried files keep mtimes.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/**tests**/transaction.test.ts apps/server/src/services/marketplace/**tests**/transaction-concurrency.test.ts apps/server/src/services/marketplace/lib/**tests**/atomic-move.test.ts (adjust to the real paths); typecheck + lint server.

### Task 2.3: Pass ownership from all five install flows, create .dork/data, and surface notices

- **Size:** large · **Priority:** high · **Depends on:** 2.2 · **Parallel with:** 2.4, 2.5, 2.10, 3.1

WHY: the transaction only records and carries when a flow passes `ownership` (spec §2, §4, §10, §12).

CHANGES:

1. marketplace-installer.ts install(): compute the record identity once `{ name, type, source }` with source = `{ cloneUrl, subpath, ref }` from sourceKeyOf(staged.sourceKey) (source-resolver.ts:70), else `{ localPath }` (canonical). Pass it through each flow's opts (extend `Pick<InstallRequest,'projectPath'>` with `recordIdentity`), plus the rebuildLegacy function (task 2.8; until then undefined).
2. Each flow (install-plugin/-agent/-skill-pack/-adapter/-shape) passes `ownership: { identity, userEditable: manifest.userEditable ?? [], rebuildLegacy }`.
3. Each flow's activate, after its rename: `ensurePackageDataDir(target)` (one shared helper in lib/installed-files.ts; mkdir -p `.dork/data`).
4. Each flow copies `fileNotices` onto InstallResult and appends `describeFileNotices(notices)` sentences + transaction warnings to `warnings` (one shared formatter). Wording (writing-for-humans): replaced-edit "You had changed <path>. The new version replaced it; your copy is at <savedAs>."; kept-edit "Kept your changes to <path>. The new version's default is at <savedAs>."; kept-no-longer-shipped "Kept your <path>. The new version no longer includes it."; late-write "<path> changed while the update ran; kept the newest copy." (+ "yours is at <savedAs>" if collided); skipped-special "Skipped <path>: it is a special file (a socket or pipe), so it was not copied." Five or more notices -> one sentence with a count; fileNotices carries all.
5. Source-changed warning (§12) produced in the transaction when R_old.package.source exists and `!sameSource(old, new)` (ref ignored): "Files kept from the earlier <name> (from <old>) are now available to this one (from <new>)."

TESTS: each flows/**tests**/install-<type>.test.ts: install, add `config/mine.json` and `.dork/data/state.json`, reinstall -> both intact and absent from the record; `.dork/data` exists after a fresh install. Plugin test: a row-5 notice reaches fileNotices AND warnings with the exact sentence. Installer test: source-changed warning.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/flows/**tests**/ apps/server/src/services/marketplace/**tests**/marketplace-installer.test.ts; typecheck + lint server.

### Task 2.4: One predicate for 'installed': a root needs a package identity

- **Size:** medium · **Priority:** medium · **Depends on:** none · **Parallel with:** 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.10, 3.1

WHY: a root an uninstall leaves holds the person's files but no package. Today UninstallFlow.locate() and locateInstallRoot accept any existing directory (spec §7).

CHANGES:

1. lib/locate-install.ts: export `hasPackageIdentity(root)` — lstat says regular file at `.dork/manifest.json` or `.claude-plugin/plugin.json` (same predicate as packages/harness/src/sources/installed.ts ~L312-350).
2. locateInstallRoot and UninstallFlow.locate skip candidates without it. Probe ORDER unchanged (project roots, then global). Add a TSDoc paragraph stating that a kept project root is treated as if the project never installed the package, so a project-scoped command then resolves to the global install, the existing precedence for a package installed only globally (review 21). Record the same in contributing/marketplace-installs.md in task 4.1.
3. conflict-detector.ts package-name rule counts a same-named directory only when it has an identity.
4. Tests pin that flows/update.ts enumeration and both installed scanners ignore a kept root (no code change expected).

TESTS: a root holding only `config/config.json` + a pruned `.dork/installed-files.json` is invisible to locateInstallRoot, uninstall (PackageNotInstalledError), both scanners, the update enumeration, and the package-name rule; a root with only plugin.json IS found; a project kept root + a global install -> locate returns the global root.

VERIFY: targeted vitest on conflict-detector, installed-scanner, uninstall, update and locate-install tests; typecheck + lint server.

### Task 2.5: Uninstall in place, and unregister an uninstalled agent package

- **Size:** xl · **Priority:** high · **Depends on:** 2.1, 2.4, 1.3 · **Parallel with:** 2.3, 2.10, 3.1

WHY (review blockers 1 and 3): today removeLocated moves the WHOLE root to os.tmpdir() (flows/uninstall.ts, mkdtemp(tmpdir()) + atomicMove) and restores kept data only after side effects — a crash strands the person's files where the OS cleans up, and on tmpfs a big agent tree goes through RAM. And uninstall never unregisters an agent; with agent.json now the person's, mesh would keep a running agent whose package is gone (spec §5).

CHANGES flows/uninstall.ts:

1. DELETE DATA_SUBPATH, SECRETS_SUBPATH, restorePreservedData, the tmpdir staging and rollbackFromStaging.
2. New in-place, JOURNALED algorithm inside withInstallTargetLock (round-2 N2):
   a. read the record (legacy: rebuild via the injected rebuildLegacy, task 2.8). CAPTURE SIDE-EFFECT INPUTS from the record + LIVE root before anything moves: bundled extension ids (`.dork/extensions/*` dirs in the live root ∪ record paths under `.dork/extensions/`), adapter name, Shape, generated schedule paths from `.dork/install-metadata.json`. Side effects use these, never "whatever moved" (so an edited extension is still disabled + approval forgotten, DOR-516);
   b. create sibling `<root>${MARKETPLACE_UNINSTALL_DIR_MARKER}<Date.now()>-<uuid>`, write its owner stamp `.dorkos-owner.json` (task 2.11 helper), and write `<sibling>/.dorkos-journal.json` = { version: 1, root, package, sideEffects: <captured inputs>, moves: [], phase: 'moving' } (atomic write + fsync). Rename into the sibling every PACKAGE-OWNED entry (isProvenPackageFile via lstatChain, ownedPaths, `.dork/install-metadata.json`); whole-package-owned dirs as one unit; the identity files `.dork/manifest.json` / `.claude-plugin/plugin.json` LAST. Append each move to the journal (fsync) BEFORE performing it. Person files NEVER move;
   c. phase 'side-effects' (fsync); run side effects from the captured inputs (extension disable + forgetRunApproval; adapter removal; Shape teardown unless `replacing`; removeGeneratedSchedules), and for type 'agent' and not `replacing`, LAST: copy `.dork/agent.json` to `.dork/uninstalled-agent.json`, then `deps.agentRegistry?.unregisterAtPath(root)`;
   c2. STRAY SWEEP (round-3 N9): walk the sibling; any entry not record-proven (e.g. a file written into a unit-moved dir while it sat there) moves back to the root (free .dork-old name if the path is occupied again), journaled;
   d. phase 'committed' (fsync). Then prune the record to entries still present (edited), set uninstalledAt, atomic write; delete the sibling; prune empty dirs bottom-up (no directory, incl. empty `.dork/data`, is ever a kept entry); if only the record remains, remove it and the root. A failure in d does NOT roll back: log, add a result warning, leave the committed sibling for the janitor (task 2.11) to finish;
   e. failure in b or c (not committed): replay the journal in reverse, identity files FIRST, rename everything back — TOLERATING an entry logged but never moved (source still in place, absent from the sibling: skip); if agent unregistration already ran, rename `.dork/uninstalled-agent.json` back to `.dork/agent.json` (when absent) and call meshCore.syncFromDisk(root) so the agent is registered again (the cascade is not undone; say so in the error/result); remove the sibling; rethrow; the result/error says which side effects already ran (they stay run, as today);
   f. purge: after d's commit remove the whole root.
   Export the journal schema + `recoverUninstallSibling(siblingPath, deps)` (rollback if not committed, finish if committed, leave + report if the journal is unreadable) for task 2.11's janitor policy.
3. UninstallFlowDeps gains `agentRegistry?: { unregisterAtPath(projectPath: string): Promise<{ id: string; directoryDenied: boolean } | null> }` — implement in index.ts over meshCore (look up the agent id registered at that path, then meshCore.unregister(id); `directoryDenied` from the UnregisterResult's manifest-kept flag). Result `agentRemoved` set accordingly, with the fixed `removed` list (relay-endpoint, rooms, schedules-paused, task-roots, mcp-sign-ins, identity-tokens, community-enrollments, connection-access — the cascade wired in index.ts:2968 forgetAgent, index.ts:3163 task roots, core/agent-identity/unregister-cascade.ts:41, communities/remote/mesh-unregister-cascade.ts:31, connectors/agent-access-cleanup.ts:55, room memberships).
4. UninstallRequest: replace internal `deactivateShape?: boolean` with `replacing?: boolean` (keeps ui.shapes.active AND skips agent unregistration); update the one caller (applyUpdate, task 2.6) and the HTTP body schema stays without it.
5. preservedData: kept entries collapsed to the highest fully-kept directory, excluding the record and empty dirs.
6. Module header and TSDoc rewritten (the ownership rule; why in place).

TESTS flows/**tests**/uninstall.test.ts (real temp dirs, real flows to create records): Round-3: a racing write into a unit-moved dir is moved back before commit; replay skips a logged-but-unmoved entry; rollback after unregistration re-registers the agent. CRASH MATRIX — inject a throw after the k-th move for every k and during side effects: the root is restored with identity files first and every inode intact; a crash simulated after 'committed' is finished by recoverUninstallSibling with no side effect run twice; the journal is written before each move (a crash between journal append and rename is recoverable); side-effect inputs come from record+live root (an extension whose file the person edited is still disabled and its approval forgotten); person files keep their inode numbers after uninstall; only proven files land in the sibling; an edited shipped file stays; a symlinked dir inside the root is never traversed; side-effect failure -> every moved entry back with the same inode, no sibling left; pruned record has uninstalledAt and only edited entries; untouched package -> no root left; `.dork/data` empty -> no shell; purge removes all. Agent: uninstall calls agentRegistry.unregisterAtPath last, uninstalled-agent.json holds the id, result.agentRemoved set; `replacing: true` does not unregister. Mesh integration (with the real meshCore test harness): the agent is gone from the registry; git-tracked manifest -> directoryDenied true.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/flows/**tests**/uninstall.test.ts apps/server/src/services/marketplace/**tests**/failure-paths.test.ts; typecheck + lint server.

### Task 2.6: Simplify MarketplaceInstaller.applyUpdate to uninstall(replacing) then install

- **Size:** medium · **Priority:** high · **Depends on:** 2.3, 2.5 · **Parallel with:** 2.7, 2.10, 3.1

WHY: the scratch-dir snapshot (applyUpdate steps 3 and 5), its install-failure restore and findInstallRootFromPreservedPath existed only to carry two paths across (spec §6).

CHANGES marketplace-installer.ts:

1. applyUpdate: capture wasActiveShape; `uninstallFlow.uninstall({ name, purge: false, projectPath, replacing: true })`; `this.install({ ...req, force: true })`; re-apply the active Shape (unchanged).
2. DELETE the mkdtemp scratch copy, rm(installRoot), the catch-block restore, the copy-back, findInstallRootFromPreservedPath, the local pathExists if unused, and dead imports.
3. update() TSDoc: the new steps; ADR 260923-163513 amends ADR-0233; keep the DOR-1722 lock paragraph. State the pre-existing residual (review 23): a failed install half leaves the package uninstalled, with the person's files and record in place so a retry picks them up.
4. flows/update.ts header lines ~9 and ~82: "keeps the files you and your agents added or changed".

TESTS: update keeps `config/mine.json` and `.dork/data/x`; a recorded edited shipped file follows row 5; an update of an agent package keeps the id and does NOT unregister; no `dorkos-update-preserve-` dir is ever created; install failure mid-update leaves exactly the person's files + pruned record at the root.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/**tests**/marketplace-installer.test.ts apps/server/src/services/marketplace/flows/**tests**/update.test.ts apps/server/src/services/marketplace/**tests**/integration.test.ts; typecheck + lint server.

### Task 2.7: Agent identity files are the agent's: adopt, restore a parked id, write-if-absent

- **Size:** large · **Priority:** high · **Depends on:** 2.3, 1.4 · **Parallel with:** 2.6, 2.8, 2.10, 3.1

WHY (review blocker 2, 16, 17): createAgentWorkspace(input, meshCore?) (agent-creator.ts:257) mints `ulid()` (~L382) and always writes agent.json, SOUL.md, NOPE.md and MEMORY.md (~L424-446; writeConventionFile always overwrites). A person's unregister deletes agent.json (mesh-agent-management.ts:421-437 releaseManifest), so a later reinstall ran fresh over carried files. ADR 260923-163516.

CHANGES:

1. agent-creator.ts: `createAgentWorkspace(input, meshCore?, internal?: { marketplace?: true })` — a THIRD parameter, server-internal, never on CreateAgentOptionsSchema (packages/shared/src/mesh-schemas.ts:950). Requires `skipTemplateDownload: true` (throw otherwise). In marketplace mode, for EVERY marketplace install:
   a. if `.dork/agent.json` absent and `.dork/uninstalled-agent.json` present -> rename it to agent.json;
   b. if agent.json exists and parses -> ADOPT: reuse id and contents, do not write it, do not apply agentDefaults; if they differ, return a flag so the flow adds ONE warning ("Kept this agent's own settings. The new version suggests different traits; change them in the agent's settings if you want them."); if it exists and does not parse -> throw naming the file;
   c. else mint + write as today;
   d. SOUL.md / NOPE.md / MEMORY.md via writeConventionFileIfAbsent (task 1.4) — never overwrite, adopt or fresh;
   e. notifyAgentCreated: when minted -> `'created'`; when adopted -> `'registered'` (existing AgentArrival value, moment-detectors.ts:254) ONLY IF the id is not already registered at that path in mesh (a reinstall after uninstall); during an update the agent never left, so no notification (round-2 A);
   g. SOURCE CHECK (round-2 N4, round-3 N8): the flow passes the live root's record `package.source` and the incoming source; if `!sameSource(old, new)` (clone URL + subpath; the REF IS IGNORED), adopt NOTHING: save agent.json, uninstalled-agent.json, SOUL.md, NOPE.md, MEMORY.md under free `.dork-old` names, mint a fresh id, and return a flag -> warning "An earlier agent named <name> came from a different source, so its files were set aside (.dork-old) and this one starts fresh.";
   h. on EVERY adoption delete any remaining `.dork/uninstalled-agent.json` (the git-tracked case keeps agent.json in place, so the parked copy would go stale);
   f. if mesh denies the directory, clear the denial (a marketplace install is an explicit act, as registration is: mesh-discovery.ts:318/557 clearDenial); return a flag so the flow warns "This agent's folder was blocked from your team; installing it lifted that."
   The rollback ledger must not claim files it did not create (claim only what it wrote).
2. flows/install-agent.ts activate passes `{ marketplace: true }` and turns the flags into warnings.

TESTS agent-creator.test.ts: fresh marketplace install with a shipped `.dork/SOUL.md` keeps it byte-for-byte; MEMORY.md never overwritten (adopt and fresh); adopt reuses id, origin 'registered', agentDefaults not applied; parked uninstalled-agent.json restored with its id; unreadable agent.json throws; marketplace mode without skipTemplateDownload throws; CreateAgentOptionsSchema strips an injected `marketplace` key; a failed creation does not delete a carried SOUL.md (ledger). install-agent/update tests: after update the agent.json id is unchanged and meshCore.getProjectPath(oldId) still resolves (DOR-1791 U1 bar); uninstall -> reinstall restores the same id and notifies 'registered' exactly once; an update notifies nothing; a reinstall from a DIFFERENT source mints a fresh id and sets the old identity files aside; a reinstall moving @main -> @v0.8.0 (same clone URL + subpath) adopts with no warning; the parked copy is deleted on adoption (git-tracked case); denied directory cleared with the warning.

VERIFY: pnpm vitest run apps/server/src/services/core/**tests**/agent-creator.test.ts apps/server/src/services/marketplace/flows/**tests**/install-agent.test.ts; typecheck + lint server.

### Task 2.8: Rebuild a legacy install's record from its recorded commit, with an any-tree fallback

- **Size:** large · **Priority:** high · **Depends on:** 2.2, 2.5, 2.10 · **Parallel with:** 2.7, 3.1

WHY: every install made before this has no record; the four real flow installs must update with their config intact (spec §9).

HARD DEPENDENCY: DOR-2248 merged INCLUDING fetching a named past commit exactly (today package-fetcher.ts:215 and git-subdir.ts:195/216/233 clone the default branch shallowly; there is no cache entry for flow@ee1c8eb85d… on this machine). Read DOR-2248's merged API first. If it does not provide a pinned past-commit fetch, STOP and report BLOCKED — do not improvise one here.

CHANGES lib/installed-files.ts: `rebuildInstalledFiles(installRoot, deps: { cache, fetcher, logger })`:

1. read `.dork/install-metadata.json` (name, commitSha, sourceKey); absent -> fallback;
2. original tree from the cache `<name>@<commitSha>`, else the fetcher pinned to sourceKey + commitSha;
3. stagePackageContents(tree, tmp) (strips symlinks, root .npmrc, reserved paths — task 2.10), computeInstalledFiles(tmp, { identity from metadata, userEditable from that tree's manifest, npmRan: <root has node_modules> });
   3a. TRUST CHECK (round-2 N5): the pre-DOR-2248 fetcher ignored the ref on github/url sources, so the recorded SHA may never have been installed. Of the recorded paths PRESENT in the live root, if more than 10% AND at least 3 differ in bytes, discard the rebuild and use the fallback (4); otherwise mismatches are ordinary edits. Log the share. Export the threshold as a named constant with TSDoc;
   3b. write the record to the root, log info, remove tmp;
4. FALLBACK (no trustworthy tree: local-path install, commit gone, offline, or 3a rejected): build a record marked `inferred: true` listing exactly the live files whose bytes equal the file at the same path in an obtainable tree — the new version's staged tree (passed in when called from the transaction), the tree step 2 fetched (even when 3a rejected it as a whole), and the recorded local source path if it still exists. Do NOT consult older cache entries: DOR-2248 deletes superseded cache entries at startup (round-2 finding 8). Everything else is the person's. One grouped warning names the kept files the new version does not ship. This removes an old version's unchanged skills (Harness Sync stops projecting them) without deleting a byte no tree vouches for.
5. Wire: the transaction's rebuildLegacy (runs on the LIVE root before the backup, task 2.2) and uninstall's step a (task 2.5). The installer supplies deps.

TESTS: manifest + no record + commit in a fake cache -> exact record; cache miss + fake pinned fetch -> same; then update keeps config/config.json (row 9) and replaces shipped files silently. Trust check: 11% differing -> fallback; 10% -> accepted (and 2 of 5 differing -> accepted, the 'at least 3' floor). Fallback: an old skill identical to the new staged tree's file (or the fetched tree's) and dropped by the new version is removed; a file no tree has is kept and warned; a local-path install uses the fallback; a tampered record (`../x`) -> treated absent -> rebuilt.

VERIFY: pnpm vitest run apps/server/src/services/marketplace/**tests**/installed-files.test.ts apps/server/src/services/marketplace/flows/**tests**/update.test.ts apps/server/src/services/marketplace/flows/**tests**/uninstall.test.ts; typecheck + lint server.

### Task 2.9: Rewrite every sentence that names the old preserved set

- **Size:** small · **Priority:** medium · **Depends on:** 2.5 · **Parallel with:** 2.6, 2.7, 2.8, 3.1

CHANGE each to "the files you and your agents added or changed" (writing-for-humans; keep sentence structure):

- apps/server/src/services/marketplace-mcp/tool-uninstall.ts:43; marketplace-capabilities.ts:237 (also: uninstalling an agent package removes it from the team); confirmation-provider.ts:225 — AND the uninstall confirmation for an AGENT package must list, before confirmation, everything removal takes away (rooms, schedules paused, task roots, MCP sign-ins, identity tokens, community enrollments, connection access) and must NOT promise a reinstall restores it (round-2 N3)
- packages/shared/src/marketplace-schemas.ts:489 (if not done in 1.3)
- packages/cli/src/commands/uninstall.ts:5-6 + help text; print `agentRemoved` ("Removed <name> from your team. That also took away: <plain list from agentRemoved.removed>." + "Its folder is blocked from your team because git tracks its settings file." when denied); the CLI's pre-confirmation prompt for an agent package lists the same
- packages/operating-skills/src/skills/using-the-marketplace.ts:88 — bump the pack version per the seeder's rule
- apps/server/src/services/core-extensions/ensure-core-extensions.ts:107
  Then grep for "secrets.json" in apps/ and packages/ source (excluding tests and the reserved-path constants): nothing may still describe the preserved set.

TESTS: update string assertions these touch; operating-skills seeder test passes with the bump; CLI uninstall output test covers agentRemoved.
VERIFY: targeted vitest; typecheck + lint server, cli, operating-skills, shared.

### Task 2.10: Strip reserved paths in stagePackageContents

- **Size:** small · **Priority:** medium · **Depends on:** 1.1 · **Parallel with:** 2.1, 2.2, 2.4, 3.1

WHY (review 13): the single copy step every flow AND the legacy rebuild use must drop reserved paths, the same doctrine it applies to symlinks and the root .npmrc (spec §11, first layer).

CHANGE apps/server/src/services/marketplace/lib/stage-package.ts: in the cp filter, skip any entry whose POSIX path relative to the package root satisfies isReservedPackagePath (task 1.1), logging `warn` "[marketplace/stage] Stripped reserved path from package: <p>" like the symlink strip; for `.dork/data` skip the whole subtree. Update the module header's doctrine paragraph.

TESTS (lib/**tests**/stage-package.test.ts): each reserved kind is absent from the staged tree and logged once; `.dork/database.json` and `x.dork-older` are kept.
VERIFY: pnpm vitest run apps/server/src/services/marketplace/lib/**tests**/stage-package.test.ts; typecheck + lint server.

### Task 2.11: One install-sibling name rule for every reader, and one janitor with three recovery policies

- **Size:** large · **Priority:** high · **Depends on:** 1.3, 2.5, 2.2 · **Parallel with:** 2.6, 2.7, 2.8, 3.1

WHY (round-2 N1, N2): the installer now creates three sibling kinds (.dorkos-bak-, .dorkos-stage-, .dorkos-uninstall-). Verified: installed-scanner.ts:521 and conflict-detector.ts:449 filter only MARKETPLACE_BACKUP_DIR_MARKER; packages/harness/src/sources/installed.ts:676 scanPluginsRoot filters nothing (a sync during an install's npm step would project `flow.dorkos-stage-…` as a second flow); backup-janitor.ts:83 sweeps only dorkHome roots, so project-scope crash leftovers linger; and an uninstall sibling must be recovered by its journal, never swept (spec §14).

COORDINATION: DOR-2273 (worker prog-DOR-2273) is rebuilding the janitor ("restore when live missing/incomplete, delete only when verified whole") and exposing a PER-KIND POLICY SEAM. Read its merged change first and plug into that seam. Do NOT build a second janitor. If DOR-2273 has not landed or exposes no seam, STOP and report BLOCKED.

CHANGES:

1. Replace every marker check with `isInstallSiblingName` (task 1.3): installed-scanner.ts listPackageDirEntries (:521), conflict-detector.ts listInstalledPackageNames (:449), packages/harness/src/sources/installed.ts scanPluginsRoot (:676) and every other readdir of plugins/agents/shapes in @dorkos/harness, packages/mesh/src/discovery/unified-scanner.ts (~:112), the update enumeration (flows/update.ts), and the janitor.
2. A guard test (e.g. apps/server/src/services/marketplace/**tests**/install-sibling-readers.test.ts plus one in harness) that greps the source of those packages for readdir calls over an install root and fails if one does not route through isInstallSiblingName (model it on existing census-style tests in scripts/**tests**).
3. Janitor policies via DOR-2273's seam: `.dorkos-bak-` -> DOR-2273's restore-or-delete, supplying "whole" = every file in the live root's installed-files record present with matching bytes (export a `isInstallWhole(root)` helper from lib/installed-files.ts); `.dorkos-stage-` -> always delete; `.dorkos-uninstall-` -> `recoverUninstallSibling` from task 2.5 (not committed -> roll back, identity files first, occupied paths get free .dork-old names; committed -> finish; unreadable journal -> leave in place + warn, never delete).
   3b. OWNER STAMP (round-3 N7): the target lock is per process (transaction.ts:70-88 names the two-servers-one-project residual; this machine runs :6242 and :4242). Export `writeSiblingOwner(siblingPath)` / `readSiblingOwner` and `isOwnerProvablyGone(stamp)`: gone = no process with that pid (process.kill(pid, 0) -> ESRCH), or a process whose start time differs from processStartedAt (pid reuse; read start time via `ps -o lstart= -p <pid>` on POSIX / the platform equivalent on win32, and treat an unreadable start time as NOT provably gone). Recovery rule for EVERY sweep: recover a sibling only if its owner is provably gone, or it is older than the age floor (10 minutes from createdAt; longer than any transaction — npm is bounded at 120 s). A sibling with no readable stamp gets only the floor. The startup sweep additionally keeps its 24h threshold for deletions of `.dorkos-bak-` per DOR-2273's policy.
4. Where it looks: at server startup, dorkHome's install roots AND the plugins/, agents/, shapes/ under every registered agent's project `.dork/` (reuse listAgentScopes(), the input scanInstallationsAcrossScopes already gets in index.ts), with the 24h age threshold; and under withInstallTargetLock at the start of every install/update/uninstall, that target's own siblings, under the owner-stamp rule (3b) — never 'immediately because we hold the lock'. Document both in the janitor module header.

TESTS: isInstallSiblingName-driven: a staged sibling next to `flow` is not listed by the installed scanner, the conflict detector, harness scanPluginsRoot, the mesh scanner or the update enumeration; the guard test fails when a new raw readdir is added (prove by a fixture). Janitor: project-scope stage sibling deleted at startup for a registered project; uninstall sibling not committed -> rolled back (identity files first, inodes intact); committed -> finished; unreadable journal -> left + warned; a backup whose live root is whole -> deleted, missing/incomplete -> restored (DOR-2273's policy with our proof); under-lock recovery: a sibling stamped with the test's own live pid is NOT recovered before 10 minutes; a dead pid, or a live pid with a different start time, is recovered at once; an unstamped sibling waits for the floor.

VERIFY: targeted vitest on the touched scanner/detector/harness/mesh/janitor tests; typecheck + lint server, harness, mesh, shared.

## Phase 3: ${CLAUDE_PLUGIN_DATA} (@dorkos/harness)

### Task 3.1: Rewrite and export ${CLAUDE_PLUGIN_DATA} in projected commands and hooks

- **Size:** medium · **Priority:** medium · **Depends on:** none · **Parallel with:** 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.4, 2.10

WHY: Claude Code tells plugin authors to keep state in ${CLAUDE_PLUGIN_DATA}; Harness Sync rewrites only ${CLAUDE_PLUGIN_ROOT}, and Claude Code also exports both as env vars to hook/MCP/LSP processes (spec §10, ADR 260923-163515, review 15).

CHANGES packages/harness/src:

1. scan/scanner.ts: `export const CLAUDE_PLUGIN_DATA_TOKEN = '${CLAUDE_PLUGIN_DATA}';` beside CLAUDE_PLUGIN_ROOT_TOKEN (L75).
2. One helper `rewritePluginTokens(text, installDir)` replacing BOTH tokens (data -> join(installDir, '.dork', 'data')) with the separator handling the root rewrite already uses (installed-projector.ts ~L208 comment); use it at every site that splits on the root token today (installed-projector.ts ~L235, ~L280, ~L304-335; generate/hooks.ts Codex/OpenCode path ~L361).
3. Projected HOOK commands (Claude Code and Codex) get the prefix `export CLAUDE_PLUGIN_ROOT='<root>' CLAUDE_PLUGIN_DATA='<data>'; ` — single-quoted, with `'` escaped as `'\''` — so scripts reading process.env get the same paths. (Both harnesses run hook commands through a POSIX shell; Git Bash on Windows — confirm against the harness's own Windows notes and record the result.)
4. CLAUDE_ONLY_HOOK_TOKENS (generate/hooks.ts ~L219) gains the data token; skills: sources/installed.ts adds `usesPluginData` beside usesPluginRoot (~L554) and a warning sibling of PLUGIN_ROOT_SKILL_WARNING_REASON (installed-projector.ts ~L466); adopt/refusals.ts names both tokens.
5. Known limit (documented in task 4.1): plugin MCP/LSP servers are not projected, so their env is not set.
6. MIGRATION OF EXISTING PROJECTIONS (round-2 C): the prefix changes hook command strings already written to `.claude/settings.local.json` (and Codex equivalents). The next sync must recognise an old unprefixed entry as DorkOS's own through the existing managed-hook ownership marker and REPLACE it, never add a second. Test: sync over a fixture holding the old string -> exactly one hook, prefixed.

TESTS: command wrapper + hook containing both tokens rewritten (POSIX and win32 fixtures); hook command carries the export prefix; a path containing `'` is escaped correctly (execute the resulting command with /bin/sh in the test and assert `printenv CLAUDE_PLUGIN_DATA`); skill warning; Codex path rewritten; refusal copy names both.
VERIFY: pnpm vitest run packages/harness/src; typecheck + lint @dorkos/harness.

## Phase 4: Documentation and proof

### Task 4.1: Document the ownership rule for developers, users and package authors, plus the changelog

- **Size:** medium · **Priority:** medium · **Depends on:** 2.6, 2.7, 2.8, 2.9, 2.11, 3.1 · **Parallel with:** 4.2

CHANGES:

1. contributing/marketplace-installs.md: §1 invariants (the ownership rule; a person's file never leaves its directory); §4 uninstall (in place; agent unregistration and parked id) and update; §5 lifecycle (sibling staging, record, legacy rebuild before backup, clone carry, late-write pass and its residuals, the uninstall journal, isInstallSiblingName, one janitor with three policies and where it looks); §5.1 owned paths (node_modules, package-lock.json); §7 ~L353: replace "DOR-1791 tracks restoring it properly" with the true state (DOR-1791 closed with only its ideation built; a file under a package agent now survives update; creating one is still refused pending the follow-up item the orchestrator names); §16 known limits (SDK-delivered global plugins' data dir, DOR-174; project-then-global probe order and what a kept project root means).
2. contributing/harness-sync.md: the data token, the hook export prefix, the MCP/LSP env limit.
3. docs/marketplace/index.mdx (users, plain words): what update, reinstall and uninstall keep; `.dork-old`/`.dork-new`; uninstalling a marketplace agent removes it from the team and takes away its rooms, schedules (paused), sign-ins, tokens, community enrollments and connection access — reinstalling reuses its identity files but restores none of those; `--purge`.
4. docs/marketplace/publishing.mdx: "Where your package keeps its settings" (${CLAUDE_PLUGIN_DATA}, one per install; userEditable + JSON example; reserved paths; minDorkosVersion; declared dependencies already go into the package's own node_modules). No claim that Claude-Code-superset compatibility is verified.
5. .claude/skills/marketplace-dev/SKILL.md (+ .agents mirror if any, per syncing-agent-skills).
6. decisions/0233-_.md and 0304-_.md: "Amended by 260923-163513" under Status; correct 0233's five-step update prose. New ADRs stay draft.
7. ONE changelog fragment `changelog/unreleased/<id>-keep-package-settings-on-update.md` (id via .claude/scripts/id.ts; changelog/README.md format; writing-for-humans): updating or reinstalling a marketplace package keeps the settings and files you and your agents added; your copy of a package file you changed is saved beside the new one; marketplace agents keep their identity and memory across updates, and uninstalling one removes it from your team. Fold any hook-seeded stub fragments' covers: lines in and delete the stubs.
8. Run scripts/check-banned-words.sh and the vocab gate on changed prose.
   VERIFY: prettier --check on touched files; both gates clean.

### Task 4.2: Prove it on a copy of a real flow install and measure carry-over cost

- **Size:** medium · **Priority:** high · **Depends on:** 4.1 · **Parallel with:** none

1. REAL-INSTALL PROOF (needs DOR-2248's pinned past-commit fetch): copy /Users/doriancollier/Keep/dork-os/blintz/.dork/plugins/flow into a temp project's .dork/plugins/flow (NEVER touch the real installs). Drive MarketplaceInstaller.update() against the current dork-labs/marketplace main. Assert and record: the legacy record was rebuilt by FETCHING ee1c8eb (not the cache, which has no entry for it; assert via the fetcher call), config/config.json and config/config.local.json are byte-identical before/after, no .dork-old was written for flow's own files, the new record exists, and the person files' inode numbers are unchanged through the uninstall half. Paste hashes into 04-implementation.md.
2. AGENT PROOF: install a fixture agent package into a temp dorkHome with a real meshCore; write MEMORY.md and edit SOUL.md; update -> same id, both intact; uninstall -> agent gone from the registry, uninstalled-agent.json present; reinstall -> same id.
   2b. CRASH PROOF: on a copy of a flow root, kill an uninstall (SIGKILL a child process running it) mid-moves and mid-side-effects; restart the janitor path; assert the root is whole again (isInstallWhole) or the uninstall finished, per the journal phase.
3. PERFORMANCE: a synthetic agent install whose root holds ~1 GB of person files (≈2,000 × 512 KB, nested); time update's carry (clone) and the uninstall half on this machine (APFS). Record numbers and file counts. Note that ext4 would pay a real copy; if a measurement is unacceptable, record the follow-up (hard links + rename-back rollback), do not weaken guarantees.
4. Write specs/marketplace-package-file-ownership/04-implementation.md (house style of specs/marketplace-version-truth/04-implementation.md): per-task outcome, deviations with reasons, verification lines, proofs, measurements.
5. Final targeted verification for every touched package (vitest on touched files; typecheck + lint @dorkos/marketplace, @dorkos/shared, @dorkos/mesh, @dorkos/harness, @dorkos/server, dorkos cli, @dorkos/operating-skills). Then set the spec manifest status to implemented via spec-manifest-ops.ts.
