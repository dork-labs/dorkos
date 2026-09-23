---
slug: marketplace-package-file-ownership
number: 260923-163619
created: 2026-09-23
status: specified
linear-issue: DOR-2245
project: Marketplace Package Management
---

# Keep a package's settings when it is updated or reinstalled

**Status:** Draft
**Author:** Claude Code (prog-DOR-2245)
**Date:** 2026-09-23
**Input:** [`01-ideation.md`](./01-ideation.md) (decisions 1–11 carried forward and made concrete below)
**Baseline:** `origin/main` `3b36e3876`. Implementation starts after DOR-2248 and the DOR-2244 dorkos PR land, and rebases onto both.

## Overview

A marketplace install records every file it puts in the install root, with a content hash. From then on, **DorkOS removes or replaces only the files it can prove the install put there, unchanged**. Every other file in an install root belongs to the person (or their agent) and survives update, reinstall and a plain uninstall. Only `--purge` removes it. A package may mark shipped files as meant to be edited (`userEditable`). Every package gets a conventional place for its own state, `${CLAUDE_PLUGIN_DATA}`, which DorkOS resolves to `<installRoot>/.dork/data/`. That is the name Claude Code already taught plugin authors. The same rule covers all five package types, so flow's settings, an agent package's identity and persona, and a Claude-Code-format plugin's data all survive for one reason.

## Background / Problem Statement

`MarketplaceInstaller.update` is uninstall then install. Across it, only `<installRoot>/.dork/data/` and `<installRoot>/.dork/secrets.json` survive (`flows/uninstall.ts` `DATA_SUBPATH`/`SECRETS_SUBPATH`; `marketplace-installer.ts` `applyUpdate` steps 3 and 5). A plain reinstall is worse: `runTransaction` moves the existing root aside and deletes it on success, so it keeps nothing at all. Measured consequences:

1. **flow's settings reset on every update.** flow ships `config/config.example.json`; `/flow:init` writes `config/config.json` and `config/config.local.json` beside it (tracker account, team, dials). The operator restored them by hand on 2026-08-07 and three times on 2026-09-23. Four installs on this machine carry hand-restored copies (`dorkos`, `dorkos-cloud`, `blintz` at 0.7.3 / `ee1c8eb`; `trame-algo-playground` at 0.1.1). `/flow:init` can also generate `skills/<tracker>-adapter/` for a non-Linear tracker, which an update deletes too.
2. **An agent package loses its identity and persona on every update.** The reinstall half calls `createAgentWorkspace({ skipTemplateDownload: true })`, which mints a new `ulid()` and rewrites `.dork/agent.json`, `.dork/SOUL.md` and `.dork/NOPE.md` (`agent-creator.ts` ~L382-440). Mesh reads the new id at the old path as a branch swap and drops the old row without the unregister cascade (DOR-1791 F1). `.dork/MEMORY.md` and anything else the agent wrote in its own working directory are deleted.
3. **A person's schedule under a package agent cannot survive** (DOR-1789's refusal, DOR-1791). DOR-1791 is Done in Linear, but only its ideation shipped (`a8a72a96a`). Its T1–T4 were never built.
4. **Claude-Code-format plugins have no data directory in DorkOS.** Claude Code's reference says: "Don't write state [to the install dir]… Configuration files your plugin owns" go in `${CLAUDE_PLUGIN_DATA}`. Harness Sync rewrites `${CLAUDE_PLUGIN_ROOT}` in projected commands and hooks, but `${CLAUDE_PLUGIN_DATA}` appears nowhere in this repo. A projected hook that uses it runs as a project hook, where Claude Code does not export the variable, so `"${CLAUDE_PLUGIN_DATA}/x"` expands to `/x`.

Root cause: the installer has no record of which files it installed, so it treats the whole directory as the package's and hard-codes two exceptions.

## Goals

- A file a person or agent creates inside any install root survives update, reinstall, and uninstall without `--purge`, for all five package types.
- A shipped file the person edited is never silently lost: it is replaced with the person's copy saved beside it, or kept if the package declared it editable. Either way the result says which files and where.
- An agent package keeps its id, persona and memory across an update.
- `${CLAUDE_PLUGIN_DATA}` works in projected commands and hooks, per install scope.
- The four real flow installs update cleanly with their settings intact, with no action from the person and no change to flow.
- The two hard-coded preserve constants, the update's scratch-dir dance and `findInstallRootFromPreservedPath` are deleted, not extended.

## Non-Goals

- Migrating a package's settings between versions. A package must read its own older settings (DOR-2246 fixes flow's validator).
- Hiding one package's files from another. Packages are not sandboxed (see Security).
- A task root for person-made schedules under a package agent, and `isPackageOwned` reading the new record (DOR-1791 T3/T4, a follow-up).
- Moving flow's config into the project, or any flow change (follow-up in dork-labs/marketplace).
- Restoring a crash-left backup instead of sweeping it (`backup-janitor.ts`; a follow-up. The hazard predates this work.)
- Global plugins delivered through the SDK: Claude Code sets its own `${CLAUDE_PLUGIN_DATA}` for them until DOR-174 moves global scope to projection.
- An install-preview disclosure of which files will be kept or replaced. The result reports it after the fact.

## Technical Dependencies

- Node `node:crypto` (`createHash('sha256')`, streamed) and `node:fs/promises`. No new npm dependency; the `userEditable` pattern subset (below) needs no glob library.
- DOR-2248: the staged tree must be exactly the commit its cache key names, both for the hashes recorded here and for rebuilding a legacy record from a recorded commit.
- Claude Code plugins reference (`https://code.claude.com/docs/en/plugins-reference`, read 2026-09-23): `${CLAUDE_PLUGIN_DATA}` lives at `~/.claude/plugins/data/{id}/`, survives updates, is deleted on uninstall unless `--keep-data`, and is substituted inline in skill/agent content, hook/monitor commands, and MCP/LSP config.

## Detailed Design

### 1. The rule

For every regular file under an install root, exactly one of these holds:

| Owner             | How DorkOS knows                                                                                                                              | Update / reinstall                                                                 | Uninstall                                        | `--purge` |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ | --------- |
| **The package**   | Listed in the root's installed-files record, and its bytes still hash to the recorded value; or under a recorded owned tree (`node_modules/`) | Replaced by the new version's copy, or removed if the new version does not ship it | Removed                                          | Removed   |
| **The person**    | Anything else, including a recorded file whose bytes changed                                                                                  | Kept (§4 says exactly how an edited shipped file is kept)                          | Kept, in place                                   | Removed   |
| **The installer** | The reserved paths `.dork/installed-files.json` and `.dork/install-metadata.json`                                                             | Rewritten                                                                          | The record is kept (§5); the metadata is removed | Removed   |

Directories are not owned; they exist while something under them does. Symlinks are never shipped (`stage-package.ts` strips them), so any symlink in a root is the person's. It is carried as a link and never followed.

### 2. The installed-files record

**File:** `<installRoot>/.dork/installed-files.json`. **Module:** new `apps/server/src/services/marketplace/lib/installed-files.ts` (Zod schema, compute, read, write, classify). TSDoc on every export.

```jsonc
{
  "version": 1,
  // Who put these files here. Compared on the next install to warn when a
  // same-named package from a different source inherits the kept files (§12).
  "package": {
    "name": "flow",
    "type": "plugin",
    "source": "https://github.com/dork-labs/marketplace#plugins/flow",
  },
  // Installer-generated trees; every file under them is the package's, with no
  // per-file hashes (a vendored dependency tree can hold tens of thousands).
  "ownedTrees": ["node_modules"],
  // POSIX-separated paths relative to the install root → "sha256:<hex>".
  "files": { ".claude-plugin/plugin.json": "sha256:…", "skills/flow/SKILL.md": "sha256:…" },
  // Resolved at install time from the manifest + type defaults (§3), so a
  // later reinstall can apply the rules without re-reading an older manifest.
  "userEditable": ["config/defaults.json"],
}
```

- **Computed by `runTransaction`, not by each flow.** `TransactionOptions` gains `ownership?: { identity: RecordIdentity; userEditable: string[] }`. When present, after `stage` resolves and before the backup is taken, the engine walks the staged tree and writes the record into it. The record therefore activates in the same `atomicMove` as the package and can never be missing from a successful install. This is also the lesson of §5.1 npm dependencies: "a new flow gets none of this for free". All five marketplace flows pass `ownership`; `services/shapes/fork.ts` does not, because a fork is the person's own copy.
- **The walk** records every regular file except: anything under `ownedTrees` (today only a root-level `node_modules`, present when `installStagedNpmDependencies` ran); the two installer paths; symlinks. `source` is `sourceKeyOf(staged.sourceKey)` rendered as `<cloneUrl>#<subpath>@<ref>` when the fetch recorded one, else the canonical local path for a local install.
- **Reading is defensive.** A record that fails the schema, or lists a path that is absolute, contains `..`, or resolves outside the root, is treated as **absent** (the legacy path, §9) and logged. A record only ever decides what DorkOS _keeps_ (§4, §5), so a tampered record can make DorkOS keep less of a person's file set, never delete outside the root.

**Reserved paths a package may not ship** (enforced by `validatePackage`, §11): `.dork/data/**`, `.dork/secrets.json`, `.dork/install-metadata.json`, `.dork/installed-files.json`, and any path ending `.dork-old` or `.dork-new` (with or without a numeric suffix). These always belong to the person or the installer, so ownership is never ambiguous.

### 3. `userEditable`: how a package says a shipped file is meant to be edited

`@dorkos/marketplace` `manifest-schema.ts`, on the shared base manifest (every type):

```ts
/**
 * Shipped files a person is expected to edit. On update, an edited copy is kept
 * and the new default is written beside it as `<file>.dork-new`. Every other
 * shipped file is replaced, and an edited copy is saved as `<file>.dork-old`.
 * Exact root-relative paths, or a directory prefix ending in `/**`.
 */
userEditable: z.array(UserEditablePathSchema).max(100).default([]),
```

- **Pattern subset:** a POSIX relative path (`config/defaults.json`) or a prefix `dir/**` (`prompts/**`). Refused: absolute paths, `..`, backslashes, any other `*` or `?`, and any pattern that covers a reserved path (§2). Matching is `p === pattern` or `p.startsWith(prefix + '/')`. A new pure helper `matchesUserEditable(path, patterns)` lives in `@dorkos/marketplace` (browser-safe), with tests.
- **Type defaults** (`resolveUserEditable(manifest)` in `@dorkos/marketplace`): an **agent** package always adds `.dork/agent.json`, `.dork/SOUL.md`, `.dork/NOPE.md`, `.dork/MEMORY.md`. They are the agent's identity, persona and memory, and are the agent's whether or not the package shipped a starting copy. No other type has defaults.
- The schema strips unknown keys, so an older DorkOS ignores the field (it just keeps today's behaviour for those files). A package that relies on it should set `minDorkosVersion` to the first release that ships this.
- A Claude-Code-format package with no `.dork/manifest.json` gets the empty list. Claude Code's own contract tells those authors not to edit shipped files at all.

### 4. Carry-over: installing over an existing root

When `ownership` is set and the target already exists, `runTransaction` gains one step between the backup (step 3) and `activate` (step 4):

**3b. Carry the person's files into the staged tree.** Read the _backup's_ record (the old one, "R_old") and the _staged_ record ("R_new", just written). The backup is either a full previous install (reinstall) or the root that an uninstall left behind (update, §6). Then apply the table below to every path in `R_old.files ∪ files present in the backup ∪ R_new.files`, skipping `R_old.ownedTrees` and the installer paths. "Edited" means that the file is present in the backup and its hash differs from `R_old`. "Default changed" means that the `R_new` hash differs from the `R_old` hash. `U` = `R_new.userEditable` (the new version's declaration wins; for a path the new version does not ship, `R_old.userEditable`).

| #   | In R_old? | State in backup | New version ships it? | In U? | Result in the new install                                                                                                                | Notice                                        |
| --- | --------- | --------------- | --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | yes       | unchanged       | yes                   | –     | new copy                                                                                                                                 | –                                             |
| 2   | yes       | unchanged       | no                    | –     | gone                                                                                                                                     | –                                             |
| 3   | yes       | missing         | yes                   | –     | new copy                                                                                                                                 | –                                             |
| 4   | yes       | missing         | no                    | –     | gone                                                                                                                                     | –                                             |
| 5   | yes       | edited          | yes                   | no    | new copy; the person's copy saved as `P.dork-old`                                                                                        | `replaced-edit`                               |
| 6   | yes       | edited          | yes                   | yes   | the person's copy; if the default changed, the new copy saved as `P.dork-new`                                                            | `kept-edit` (only if `.dork-new` was written) |
| 7   | yes       | edited          | no                    | no    | the person's copy saved as `P.dork-old` (not left at `P`, so an edited skill the package dropped stops being projected as the package's) | `replaced-edit`                               |
| 8   | yes       | edited          | no                    | yes   | the person's copy, in place                                                                                                              | `kept-no-longer-shipped`                      |
| 9   | no        | present         | no                    | –     | the person's copy, in place                                                                                                              | –                                             |
| 10  | no        | present         | yes                   | no    | new copy; the person's copy saved as `P.dork-old`                                                                                        | `replaced-edit`                               |
| 11  | no        | present         | yes                   | yes   | the person's copy; the new copy saved as `P.dork-new` if its bytes differ                                                                | `kept-edit` (if written)                      |

- **Backup names never overwrite.** `P.dork-old` / `P.dork-new`, else `P.dork-old.2`, `.3`, … whichever is first free _in the final tree_. A `.dork-new` the carry-over writes is added to the new record (it is the package's copy, so the next update replaces or removes it). A `.dork-old` is not added: it is the person's.
- **Copy, never move.** Carried entries are copied from the backup into staging (`fs.cp`, `recursive`, `verbatimSymlinks: true`, `preserveTimestamps: true`). The backup stays complete until step 5 deletes it, so a crash or a failed `activate` loses nothing: rollback (step 6) restores the untouched backup exactly as today. To keep the walk and the copy proportional, a directory in the backup with **no** `R_old` file and no `R_new` file anywhere beneath it is carried as one unit, not per file. That covers an agent's working tree or a `.git`.
- **Notices.** Step 3b produces `PackageFileNotice[]` (§12). The engine hands them to `activate` as a second field on its argument (`activate({ path, fileNotices })`), which is the one place every flow already assembles its `InstallResult`; each flow copies them onto the result (and their sentences onto `warnings`), and each flow's test asserts it. The engine does not know the result's shape, so it does not merge anything itself.
- **A root with no `R_old` and no package identity** (the root a legacy uninstall left, holding only `.dork/data` and `.dork/secrets.json`) has every file treated as rows 9–11.
- **A root with a package identity but no `R_old`** is a legacy install: §9 rebuilds `R_old` first.

### 5. Uninstall

`flows/uninstall.ts`:

- `DATA_SUBPATH`, `SECRETS_SUBPATH` and `restorePreservedData` are deleted. They are replaced by `restorePersonFiles(stagingPath, installRoot)`, which, after the side effects succeed and when `purge` is false, copies back into the (now empty) install root every entry the record does not prove is the package's (§1), plus `.dork/installed-files.json` itself. The record stays so a later reinstall knows which kept files were edited shipped files (rows 5–8) rather than the person's own (rows 9–11). `.dork/install-metadata.json` is not copied back.
- If nothing but the record would be copied back, nothing is: no empty shell is left behind for an untouched package.
- `UninstallResult.preservedData` keeps its name and type (`string[]` of absolute paths). Its meaning becomes "every kept entry, collapsed to the highest directory whose whole contents were kept", so an agent's working tree reports as one path, not thousands. The record itself is not listed.
- `purge: true` keeps today's behaviour: nothing is copied back.
- The rollback path is unchanged.

### 6. Update

`MarketplaceInstaller.applyUpdate` keeps uninstall-then-install (the uninstall half is what runs the side-effect teardown: extensions off and their run approvals forgotten, DOR-516; the adapter entry removed; generated schedules removed). Steps 3 and 5 are deleted: the snapshot to a scratch dir, `rm -rf` of the data-only root, the copy-back, and the install-failure restore of the scratch dir. So are `findInstallRootFromPreservedPath` and the local `pathExists`. What remains:

1. resolve; 2. `uninstall({ purge: false, deactivateShape: false })`, which leaves the person's files and the old record at the root; 3. `install({ …req, force: true })`, whose transaction backs that root up, carries (§4) and activates, restoring the root exactly on failure; 4. re-apply an active Shape (unchanged).

The whole round trip stays inside the one `withInstallTargetLock` (DOR-1722). The re-entrant grant covers the transaction's own lock take.

### 7. What counts as installed

A root counts as an installed package only if it has `.dork/manifest.json` or `.claude-plugin/plugin.json`: the predicate Harness Sync (`sources/installed.ts`) and the installed scanner already use. A root left by an uninstall has neither.

- New `hasPackageIdentity(root)` in `lib/locate-install.ts` (exported, tested). `locateInstallRoot` and `UninstallFlow.locate` skip a candidate without an identity, so `dorkos uninstall flow` or `dorkos update flow` on an uninstalled-but-kept root answers `PackageNotInstalledError` instead of "removing" the kept files. Today `locate()` accepts any existing directory.
- The update check's enumeration (`flows/update.ts`, via `readInstalledIdentity`) and `scanInstallationsAcrossScopes` already require an identity. A test pins that a kept root is invisible to all three.
- `ConflictDetector`'s `package-name` rule keys on a directory existing under an install root. It must use the same predicate, so installing into a kept root is a plain install, not a "same name exists" warning.

### 8. Agent packages adopt their existing workspace

`flows/install-agent.ts` `activate`, after the atomic move: when `<targetDir>/.dork/agent.json` exists and parses (carried by §4, row 6 or 9), call `createAgentWorkspace` in **adopt** mode:

- `createAgentWorkspace` gains a second, server-internal parameter, `createAgentWorkspace(opts, { adoptExisting: true })`. It is deliberately **not** a field on `CreateAgentOptionsSchema` (`@dorkos/shared/mesh-schemas.ts:950`): that schema is the public `createAgent` transport contract, and "reuse whatever `agent.json` sits in this directory" must not be reachable from an HTTP body. It is accepted only together with `skipTemplateDownload: true`, and the marketplace agent flow is the only caller.
- In adopt mode the creator reads the existing manifest and **reuses its `id`**. It writes `.dork/agent.json` only if absent, and `.dork/SOUL.md` / `.dork/NOPE.md` only if absent. It runs the rest of its pipeline (mesh sync, harness, etc.) as for a fresh scaffold.
- The package's new `agentDefaults` (traits, icon) apply to a fresh install only. On adoption the person's `agent.json` is theirs (it is user-editable by the type default). The install result says so in a warning only when the new version's `agentDefaults` differ from the adopted values, e.g. "Kept this agent's own settings. The new version suggests different traits; change them in the agent's settings if you want them."
- Result: same id, same path. Mesh's `upsertAutoImported` sees an unchanged agent, no branch swap, rows and schedules keyed to the id keep resolving. This is DOR-1791's T1, delivered here because an agent package's `agent.json` is that package's settings.

### 9. Legacy installs (no record)

A root with a package identity and no valid record gets one rebuilt immediately before it is needed: at step 3b of a reinstall, and at the start of every uninstall, an update's uninstall half included, so §5 keeps the right files. New `rebuildInstalledFiles(installRoot, deps)` in `lib/installed-files.ts`:

1. Read `.dork/install-metadata.json`. Need `name`, `commitSha` and `sourceKey`; a local-path install has neither.
2. Get the tree the install came from, **without trusting the live root**: the package cache entry `<name>@<commitSha>` if present, else `PackageFetcher` at `sourceKey` pinned to `commitSha` (DOR-2248 makes this exact).
3. Run the same copy the flows use (`stagePackageContents`, which strips symlinks and the root `.npmrc`) into a temp dir, compute the record from it with `ownedTrees: ["node_modules"]` and `userEditable` from that tree's manifest plus the type defaults, and write it to `<installRoot>/.dork/installed-files.json`. Log at `info`.
4. **If the tree cannot be obtained** (a local install, a commit gone from the remote, offline), fall back to a no-loss record: **every file currently in the root is treated as the person's edit of a shipped file** (rows 5, 7, 10). The new version's copy wins where it ships one. The live copy is saved as `.dork-old` only when its bytes differ. Everything the new version does not ship stays in place (rows 8/9 behaviour), with one grouped warning listing those paths so a stale leftover can be deleted. Nothing is deleted on a guess. In an uninstall the same fallback keeps every file except the identity files (`.dork/manifest.json`, `.claude-plugin/plugin.json`), `.dork/install-metadata.json` and `node_modules/`, and says so in the result. This happens at most once per install, because the next install writes a real record.

For the four flow installs on this machine, step 2 succeeds (`commitSha` `ee1c8eb`, `sourceKey` recorded, commit on GitHub). flow does not ship `config/config.json`, `config/config.local.json` or `skills/<tracker>-adapter/` (except `linear-adapter`, which it does ship), so they are rows 9 and survive untouched.

### 10. `${CLAUDE_PLUGIN_DATA}`

- **Resolution:** `<installRoot>/.dork/data`, one per install. So a project install has its own, which Claude Code's per-user directory cannot offer.
- **Created** empty by every flow's `activate` after the move (`mkdir -p`; `.dork/data` is reserved, so it can never collide with a shipped file). It is the person's by §1, so it survives update and uninstall and is removed only by `--purge`. This matches DorkOS's keep-by-default contract rather than Claude Code's delete-by-default one; the uninstall copy already says `--purge` removes data.
- **Harness Sync** (`@dorkos/harness`): add `CLAUDE_PLUGIN_DATA_TOKEN = '${CLAUDE_PLUGIN_DATA}'` beside `CLAUDE_PLUGIN_ROOT_TOKEN` (`scan/scanner.ts`). Every place `installed-projector.ts` rewrites the root token (command wrappers ~L235/L280, hook commands ~L304-335, and the Codex/OpenCode hook paths in `generate/hooks.ts`) also rewrites the data token to `join(installDir, '.dork', 'data')`, using the same separator handling the root rewrite already has. `CLAUDE_ONLY_HOOK_TOKENS` and `PLUGIN_ROOT_SKILL_WARNING_REASON`'s sibling cover the data token for projected **skills**, which cannot be rewritten because they are symlinks: the same warning shape, naming `${CLAUDE_PLUGIN_DATA}`. The adopt-refusals copy (`adopt/refusals.ts`) names both tokens.
- **Global plugins delivered through the SDK** (`buildClaudeAgentSdkPluginsArray`): Claude Code sets its own `${CLAUDE_PLUGIN_DATA}` for these. Recorded as a known limit in `contributing/marketplace-installs.md` §16 with DOR-174 as the owner, including that DOR-174 must move that data when global scope switches to projection.

### 11. Validation

`packages/marketplace/src/package-validator.ts`: new error `RESERVED_PATH_SHIPPED`, "`<path>` is a path DorkOS keeps for the person or the installer (`.dork/data/`, `.dork/secrets.json`, `.dork/install-metadata.json`, `.dork/installed-files.json`, `*.dork-old`, `*.dork-new`). Remove it from the package." It is raised for any shipped file under a reserved path. `userEditable` schema errors come through `MANIFEST_SCHEMA_INVALID` with a message per bad pattern. No package in dork-labs/marketplace ships a reserved path today (checked `git ls-files` at `ee1c8eb`).

### 12. Results and surfaces

`@dorkos/shared` `marketplace-schemas.ts` and `apps/server/src/services/marketplace/types.ts`:

```ts
/** What an install did with a file the person may have changed. */
export interface PackageFileNotice {
  /** Root-relative path of the file. */
  path: string;
  /** `replaced-edit`: the package's copy is in place; yours is at `savedAs`.
   *  `kept-edit`: your copy is in place; the package's new default is at `savedAs`.
   *  `kept-no-longer-shipped`: your copy is in place; the package no longer ships this file. */
  outcome: 'replaced-edit' | 'kept-edit' | 'kept-no-longer-shipped';
  /** Root-relative path of the saved copy, when one was written. */
  savedAs?: string;
}
// InstallResult gains:
fileNotices?: PackageFileNotice[];
```

- Each notice also becomes one plain sentence on `InstallResult.warnings`, so the CLI (`install.ts` prints warnings), the app's install and update toasts, and MCP callers show it with no new UI. Wording follows `writing-for-humans`. For example: "You had changed skills/x/SKILL.md. The new version replaced it; your copy is at skills/x/SKILL.md.dork-old." Five or more notices collapse into one sentence with a count and the list on `fileNotices`.
- **Source changed:** when `R_old.package.source` exists and differs from the incoming source, add a warning: "Files kept from the earlier <name> (from <old source>) are now available to this one (from <new source>)." No refusal (see Security).
- **Uninstall copy.** Every sentence that names the preserved set changes from "`.dork/data/` and `.dork/secrets.json`" to "the files you and your agents added or changed". That covers `tool-uninstall.ts:43`, `marketplace-capabilities.ts:237`, `confirmation-provider.ts:225`, `shared/marketplace-schemas.ts:489`, `cli/commands/uninstall.ts:5-6` (help text; its "Preserved:" listing already prints `preservedData`), `operating-skills/…/using-the-marketplace.ts:88`, `flows/update.ts:9,82`, `ensure-core-extensions.ts:107`. The operating skill is version-stamped, so its pack version must bump per the seeder's rule.

### 13. dork-labs/marketplace and flow

No change is required, and none is part of this spec. flow's settings are rows 9 under the new rule. Contract-first is satisfied because `@dorkos/marketplace` ships `userEditable` before any package uses it, and no package needs to. The follow-up (not in scope) is for flow to document where its settings live and to consider the project as their home, for bare-Claude-Code installs.

## User Experience

- **Updating a package you configured** (`dorkos update flow --apply`, or **Update** in the app): the new version installs and your settings are exactly where they were. Nothing extra is shown unless you had edited a file the package itself ships.
- **You edited a file the package ships:** the result says, in one sentence per file, which file, what happened, and where the other copy is (`.dork-old` for yours, `.dork-new` for the package's new default). Nothing is lost in either direction.
- **Reinstalling** (installing a package that is already installed) behaves like an update. Today it silently wipes `.dork/data/` too.
- **Uninstalling** keeps the files you and your agents added or changed, and lists them. `--purge` removes them. Installing the package again later picks them up. An uninstalled package with kept files does not show as installed anywhere, and `dorkos update <name>` says it is not installed.
- **An agent from the marketplace** keeps its name in rooms, its memory, its persona edits and its schedules across an update.
- **Package authors** keep state in `${CLAUDE_PLUGIN_DATA}` as they would for Claude Code, and mark shipped defaults meant for editing with `userEditable`.

## Testing Strategy

Every test carries a purpose comment and must be able to fail. Red-before for each behaviour change: the test is written and seen failing on the baseline first.

- **`lib/installed-files.ts` unit** (`__tests__/installed-files.test.ts`, real temp dirs): record excludes `node_modules/**`, installer paths, symlinks; paths are POSIX; a hash changes when one byte changes; a record with `../x`, an absolute path, or a bad schema reads as absent. **The classification table:** one test per row 1–11, each building a backup + staged tree and asserting the final tree, the saved-as name and the notice. Name collision: `P.dork-old` already present yields `P.dork-old.2`. A directory with no recorded file beneath it is carried as a unit (spy on the copy calls).
- **`transaction.test.ts`:** with `ownership`, the record is inside the activated target. A person file in the old target survives. An `activate` failure after carry-over restores the old target byte-for-byte, person files included, and leaves no staging behind. Without `ownership` (the Shape fork), behaviour is unchanged.
- **Flows** (`flows/__tests__/install-*.test.ts`, `uninstall.test.ts`, `update.test.ts`, `marketplace-installer.test.ts`): for each of plugin, agent, skill-pack, adapter, shape: install, add `config/mine.json` and `.dork/data/state.json`, reinstall, and both are intact. Update: both survive and a recorded edited shipped file follows row 5. Uninstall without purge keeps them plus the record, drops the metadata, and returns the collapsed `preservedData`. Purge removes all. An untouched package's uninstall leaves no directory. `applyUpdate` no longer calls `mkdtemp` (the scratch-dir test is deleted with the code).
- **Agent adoption** (`install-agent.test.ts` + `agent-creator.test.ts`): update keeps `.dork/agent.json`'s `id` and an edited `.dork/SOUL.md`. A fresh install still mints an id. `adoptExisting` without `skipTemplateDownload` throws, and `CreateAgentOptionsSchema` still rejects/strips any adopt-like key from a transport body. **Mesh integration:** after update, `meshCore.getProjectPath(oldId)` still resolves (the DOR-1791 U1 evidence bar).
- **Installed predicate:** a kept root is invisible to `locateInstallRoot`, `UninstallFlow`, the update enumeration, `scanInstallationsAcrossScopes` and the conflict detector's `package-name` rule.
- **Legacy rebuild:** a root with a manifest and no record, whose recorded commit is in the fake cache, gets the exact record; a person file survives the next update. With the cache and the fetch both failing, the fallback keeps every unshipped file, writes `.dork-old` only for differing shipped paths, and warns once.
- **Validator** (`packages/marketplace/src/__tests__/package-validator.test.ts`): each reserved path yields `RESERVED_PATH_SHIPPED`. `userEditable` accepts `a/b.json` and `dir/**` and rejects `../x`, `/x`, `*.json`, `a\\b`, `.dork/data/**`. `matchesUserEditable` and `resolveUserEditable` (agent defaults) have unit tests.
- **Harness** (`packages/harness/src/**/__tests__`): a command wrapper and a hook using `${CLAUDE_PLUGIN_DATA}` are rewritten to `<installDir>/.dork/data` (POSIX and win32 separators). A skill using it produces the warning. The Codex hook path rewrites it too.
- **Real-install proof (VERIFY):** copy one real flow install root (e.g. `blintz/.dork/plugins/flow`) into a temp project, run the server's `update()` against a fixture of the next flow commit, and diff `config/` before and after (identical), plus the notices.
- **Mocking:** filesystem tests use real temp dirs (no `fs` mocks: the bugs live in real paths). The fetcher and cache are fakes at their existing injection seams.

## Performance Considerations

- Hashing the staged tree is one streamed SHA-256 per shipped file, excluding `node_modules`. flow is a few hundred files, so the cost is milliseconds, on a path that already runs `npm install` (bounded at 120 s).
- Carry-over copies person files once per update and reinstall. Typical packages (flow: two config files) cost nothing. An agent package whose working tree is large pays one recursive copy of that tree per update; whole-directory units keep it to one `fs.cp` per top-level directory. Copy, not move, is deliberate: the backup must stay complete until the install commits (crash safety, rollback). Measure on a 1 GB agent tree during EXECUTE and record the number in `04-implementation.md`. If it is unacceptable, the follow-up is a same-filesystem sibling staging dir with renames and rename-back rollback, not weaker guarantees.
- Uninstall's classification hashes the root's recorded files once.

## Security Considerations

- **Packages are not sandboxed.** A plugin's hooks and scripts run as the person and can read any file they can. So kept files being "available" to a later same-named package from another source is not a new exposure. The warning in §12 makes the hand-over visible, which is the honest level of protection.
- **Records are untrusted input** (a person or agent can edit them). Every path is validated relative and contained (§2). A record only decides what is _kept_, and every write lands inside the install root, so a tampered record cannot delete or write outside it.
- **Carry-over never follows symlinks** (`verbatimSymlinks`), and never dereferences a person's symlink into staging.
- **Reserved paths** stop a package from shipping over `.dork/secrets.json` or `.dork/data/` and thereby "owning" a person's secret on the next update.
- **Nothing here widens what an agent can do.** An agent that can write into an install root today still can, and its writes now survive. `plugins/` and `shapes/` stay `INSTALL_ROOT_HOLDS_PACKAGES_ONLY` for task-ownership purposes until DOR-1791's follow-up re-reads that rule against the record.
- `.dork/plugins/` is in `EPHEMERAL_GITIGNORE_PATTERNS`, so kept `config.local.json` secrets stay out of commits as before.

## Documentation

- `contributing/marketplace-installs.md`: §1 key invariants (the ownership rule); §4 uninstall "Data preservation" and update steps rewritten; §5 transaction lifecycle gains step 3b and the record; §5.1 note that `node_modules` is an owned tree; §7's DOR-1791 sentence (`:353`) corrected to point at the new follow-up; §16 known limit for SDK-delivered global plugins.
- `docs/marketplace/index.mdx`: what update, reinstall and uninstall keep, in plain words, plus the `.dork-old`/`.dork-new` explanation.
- `docs/marketplace/publishing.mdx`: "Where your package keeps its settings": use `${CLAUDE_PLUGIN_DATA}`, declare `userEditable` for defaults meant to be edited, the reserved paths, and `minDorkosVersion`.
- `.claude/skills/marketplace-dev/SKILL.md`: the same authoring rules, for agents building packages.
- ADR-0233 and ADR-0304 get an "Amended by" line pointing at the new ADRs; ADR-0233's five-step update prose is corrected.
- Changelog fragment (one, `changelog/unreleased/`): "Updating or reinstalling a marketplace package now keeps the settings and files you added to it."

## Implementation Phases

- **Phase 1 — The contract (`@dorkos/marketplace`, `@dorkos/shared`).** `userEditable` schema + helpers, reserved-path validation, `PackageFileNotice` / `fileNotices` types.
- **Phase 2 — Ownership in the installer (server).** `lib/installed-files.ts`; the transaction's record + carry-over step; all five flows pass `ownership`; uninstall keeps person files; `applyUpdate` simplified; the installed predicate; agent adoption; legacy rebuild; notices and copy.
- **Phase 3 — `${CLAUDE_PLUGIN_DATA}` (`@dorkos/harness` + server).** Token rewrite, `.dork/data` creation, skill warning.
- **Phase 4 — Documentation and proof.** Guides, user docs, authoring docs, ADR amendments, changelog, the real-install proof.

All four phases ship as **one dorkos PR** (spec docs included). No dork-labs/marketplace PR is part of this item.

## Open Questions

1. ~~Should edited shipped files default to the person's copy winning?~~ (RESOLVED)
   **Answer:** No. The package wins and the person's copy is saved as `.dork-old`, unless the path is `userEditable`.
   **Rationale:** a package whose code, prompts and hooks silently stop updating is half one version and half another; dpkg and rpm both overwrite non-config files. Nothing is lost, and the declaration exists for the files meant to be edited.
2. ~~Move instead of copy during carry-over?~~ (RESOLVED)
   **Answer:** Copy.
   **Rationale:** the backup must stay whole until the install commits; a crash mid-move would split the person's files between a tmp dir and a backup the janitor sweeps after 24 h. Performance is measured, with a named fallback design.
3. ~~Keep the record in a root after uninstall?~~ (RESOLVED)
   **Answer:** Yes.
   **Rationale:** without it, a later reinstall cannot tell an edited shipped file (rows 5–8) from the person's own file (rows 9–11). It costs one small JSON file, and only when other files were kept.
4. ~~Refuse a reinstall from a different source over kept files?~~ (RESOLVED)
   **Answer:** Warn, do not refuse.
   **Rationale:** packages are not sandboxed, so a refusal would imply an isolation that does not exist; the warning names both sources.
5. ~~Rebuild legacy records eagerly at boot?~~ (RESOLVED)
   **Answer:** Lazily, at the moment one is needed.
   **Rationale:** no boot-time network, no config migration, and an install that is never updated never pays.
6. ~~Should DorkOS delete `${CLAUDE_PLUGIN_DATA}` on uninstall like Claude Code?~~ (RESOLVED)
   **Answer:** No; `--purge` does.
   **Rationale:** DorkOS's existing, documented contract is keep-by-default (ADR-0233, `dorkos uninstall --purge`); changing it would be a silent data-loss change for current users.

## Related ADRs

- Draft `260923-163513` Installed files are owned by provenance (amends 0233, 0304)
- Draft `260923-163514` A shipped file a person edited: the package wins unless it is declared `userEditable`
- Draft `260923-163515` `${CLAUDE_PLUGIN_DATA}` resolves to the install root's `.dork/data/`
- Draft `260923-163516` A package agent keeps its identity across an update
- ADR-0233 (update is advisory; the five-step reinstall, amended), ADR-0304 (file-scoped transaction, amended), ADR-0201 (extension data outside the code dir; consistent), ADR `260706-192819` (harness-native plugin delivery), ADR-0043 (agent file-first storage)

## References

- DOR-2245 (this item); DOR-2244 (split from); DOR-2246 (flow validator); DOR-2248 (exact staging, prerequisite); DOR-1789, DOR-1791 (`specs/marketplace-agent-schedules/01-ideation.md`); DOR-516 (update forgets run approvals); DOR-1722 (update lock); DOR-174 (global projection)
- Claude Code plugins reference, "Persistent data directory", "Environment variables", "userConfig", "Plugin caching": https://code.claude.com/docs/en/plugins-reference
- dpkg conffiles: Debian Policy §10.7.3; rpm `%config(noreplace)`; VS Code `ExtensionContext.globalStorageUri`
- `research/20260329_claude_code_plugin_marketplace_extensibility.md`
