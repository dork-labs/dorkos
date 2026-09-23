---
slug: marketplace-version-truth
number: 260923-122229
created: 2026-09-23
status: specified
linear-issue: DOR-2244
project: Marketplace Package Management
---

# Know when a marketplace package has a new version

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-09-23
**Input:** [`01-ideation.md`](./01-ideation.md) (decisions 1–11 carried forward and refined below)

## Overview

DorkOS's update check reads a package's "latest version" from a field that no DorkOS-published marketplace entry sets, so it reports every package as up to date forever. This spec makes the check answer the honest question instead ("what would installing this package right now give me?") using the installer's existing resolve → stage → validate pipeline, and Claude Code's own rule for what a plugin's version is. It also makes the version files inside a package agree, both in DorkOS's validator and in `dork-labs/marketplace` CI, so that the answer can be trusted.

## Background / Problem Statement

Measured on 2026-09-23. Flow was installed at 0.5.0, and `dork-labs/marketplace` `main` held 0.7.2 (#37). Running `dorkos update flow` answered `All 1 package(s) up to date`, with `installedVersion: "0.5.0", latestVersion: "0.5.0"`.

- **Wrong source.** `UpdateFlow.checkOne` (`apps/server/src/services/marketplace/flows/update.ts:283`) computes `latest = match.entry.version ?? pkg.version`. `version` on a marketplace entry is optional in both schemas (`marketplace-json-schema.ts:211`, `cc-validator.ts:98`), and it is unset on all 15 entries in `dork-labs/marketplace`. Claude Code's docs tell authors not to set it alongside `plugin.json`. So `latest` always falls back to the installed version.
- **Disagreeing sources.** One package can state its version in `.dork/manifest.json`, `.claude-plugin/plugin.json` and `package.json`. Nothing compares them. flow today has manifest 0.6.0, `plugin.json` 0.7.2 and `package.json` 0.7.2. DorkOS reports `flow@0.6.0` (it reads the manifest), while Claude Code, which actually loads the plugin, reports 0.7.2.
- **A narrower second reader.** The update flow reads installs with its own `readInstalledManifest` (`update.ts:381-393`), which reads the manifest file only. The installed list (`installed-scanner.ts:357-440`) falls back to `plugin.json`. So 8 of the 14 `dork-labs/marketplace` packages, which ship no manifest, are listed but invisible to updates.
- **Masked identity.** `synthesizeFromCcManifest` (`package-validator.ts:651`) writes `version: cc.version ?? '0.0.0'`, so "declares no version" looks exactly like a real `0.0.0`.
- **Silent drops.** A package whose marketplace cannot be reached is dropped from the results (`update.ts:276-282`, `:337-341`). The CLI then says "All N package(s) up to date" about a set that silently excludes it.
- **Name-less runs abort.** `dorkos update` with no name lists installs across every agent scope, then sends one named request per package. `UpdateFlow` walks only dorkHome and the request's `projectPath` (`update.ts:225-228`), so an agent-scope install throws `PackageNotInstalledForUpdateError`, and the CLI's single catch exits 1 (`packages/cli/src/commands/update.ts:96-139`).
- **Two ways to spell the same source.** The resolvers default the ref to `'main'`, while the commit lookup defaults an absent ref to `'HEAD'` (`package-fetcher.ts:595`). An installed commit and a looked-up commit are therefore not guaranteed to describe the same place.
- **Untested reality.** Every fixture in `flows/update.test.ts` sets an entry `version` (`:254` … `:702`). The suite passes against a shape our own marketplace never publishes.

**Claude Code's rule** (docs, 2026-09-23). A plugin's version is:

1. the `version` in `plugin.json`, which wins silently over the entry;
2. else the marketplace entry's `version`;
3. else, for git sources, the resolved commit SHA (for archives, the sha256).

An update exists when that resolved value changes. Once a version is declared, commits that don't bump it never reach users.

## Goals

- `dorkos update`, `POST /api/marketplace/packages/:name/update`, and the app's Update action report an update exactly when installing now would give a different, newer package, for every marketplace, including third-party ones that never set an entry `version`.
- DorkOS and Claude Code agree on what version an installed plugin is.
- A package whose version files disagree cannot be published to `dork-labs/marketplace`, and fails `dorkos package validate` / `dorkos marketplace validate` anywhere.
- A change to a `dork-labs/marketplace` package cannot merge without a version bump.
- A check that cannot reach a package says so; it never reports that package as current.
- An unchanged package costs one `git ls-remote` per repository and ref, and no clone.

## Non-Goals

- Keeping a person's settings inside a package across an update: **DOR-2245**.
- flow's validator rejecting configs that lack only defaulted fields: **DOR-2246**.
- An all-packages update route (**DOR-2194**), MCP `marketplace_update` (**DOR-2195**), an "updates available" UI (**DOR-2196**), and install content-hash verification (**DOR-2197**). This spec makes `hasUpdate` true; those items consume it.
- Changing ADR-0232's cache key or ADR-0233's advisory-by-default contract.
- npm-source and archive-source packages. The installer does not install them today; the resolution chain below names the sha256 step so a later archive source fits without redesign.

## Technical Dependencies

- `semver` (already a server dependency; used by `isNewerVersion`).
- `git` ≥ 2.25 (already the documented minimum, `git-subdir.ts:24`).
- Claude Code plugin docs, the source of the resolution chain:
  - https://code.claude.com/docs/en/plugins-reference.md (version management)
  - https://code.claude.com/docs/en/plugin-marketplaces.md
- No new packages.

## Detailed Design

### 1. What version a package has (`@dorkos/marketplace`)

Two pure, exported functions beside the validator. Every reader (validation, install, the installed list, the update check) uses them, and none reimplements them.

```ts
/** Where a package's version came from, in Claude Code's order. */
export type VersionSource = 'package' | 'index' | 'commit';

/** A package's resolved identity for update comparison. */
export interface ResolvedPackageVersion {
  /** The version string, or the full commit SHA when `source` is `'commit'`. */
  version: string;
  source: VersionSource;
}

/**
 * The version a package tree states about itself: `plugin.json`'s `version`
 * when that file declares one, else `.dork/manifest.json`'s. Reads the two
 * files directly and NEVER gates on validity, so an install whose files
 * disagree (or that fails validation for any other reason) still has a
 * readable version. `undefined` when neither file declares one. Never throws.
 */
export async function readDeclaredVersion(packagePath: string): Promise<string | undefined>;

/**
 * Resolve a package's version the way Claude Code does: the version the
 * package declares, else its marketplace entry's version, else the commit it
 * was fetched at. `undefined` when none of the three is known.
 */
export function resolvePackageVersion(input: {
  declaredVersion?: string;
  entryVersion?: string;
  commitSha?: string;
}): ResolvedPackageVersion | undefined;

/** False for every placeholder the fetchers write in place of a real commit. */
export function isRealCommitSha(sha: string | undefined): sha is string;
```

- **`plugin.json` comes first** because Claude Code loads the plugin by it. §2 makes the order moot for any package that validates. For an install that predates §2, whose files disagree (flow on today's `main`: manifest 0.6.0, `plugin.json` 0.7.2), it makes DorkOS report what Claude Code actually runs.
- **`validatePackage` also exposes `declaredVersion`,** on every result, `ok` or not, computed by `readDeclaredVersion`. `synthesizeFromCcManifest` keeps writing `'0.0.0'` into the synthesized manifest, because the schema requires one. But `declaredVersion` stays `undefined` when `plugin.json` has no `version`. That keeps "declares none" separate from a real `0.0.0`.
- **`isRealCommitSha` moves from the installer's `realCommitSha`** (`marketplace-installer.ts:871-876`) together with every sentinel it filters: `tmp-*`, `'local'`, and `RELATIVE_PATH_SENTINEL_SHA` (`source-resolvers/relative-path.ts:20`). The installer then imports it.

### 2. Version files must agree (`validatePackage`)

A new check runs after step 4 (the `plugin.json` presence check), when both `.dork/manifest.json` and `.claude-plugin/plugin.json` exist.

- If `plugin.json` declares a `version` that differs from the manifest's, fail.
- If `plugin.json` declares no `version`, fail too. Claude Code would then fall back to the entry or the commit while DorkOS reports the manifest's version, so the two programs disagree. Every `dork-labs/marketplace` package and the scaffolder already declare one.

```ts
{
  level: 'error',
  code: 'VERSION_MISMATCH',
  message: // one of:
    `.dork/manifest.json says version ${m} but .claude-plugin/plugin.json says ${p}. ` +
      `Set both to the same version: Claude Code loads ${p}, DorkOS would report ${m}.`,
    `.dork/manifest.json says version ${m} but .claude-plugin/plugin.json has no version. ` +
      `Add "version": "${m}" to plugin.json so Claude Code and DorkOS agree.`,
  path: CLAUDE_PLUGIN_MANIFEST_PATH,
}
```

- **An error wherever validation gates something:** authoring (`dorkos package validate`), install, and the update check's staging of a _new_ version.
- **Never on an installed tree.** No installed-side reader gates on `ok`. The installed list, uninstall, harness sync and the update check's installed side read identity through `readDeclaredVersion` and the scanner's manifest-first path (`installed-scanner.ts:385-401`), neither of which calls the validator's gate. An install that fails today's rules stays visible, updatable and uninstallable. A test pins it.
- A `plugin.json` that cannot be parsed is not this check's concern. It keeps today's behavior.
- `package.json` is not checked here. DorkOS does not interpret it; `dork-labs/marketplace` enforces it as repo policy (§8).

### 3. Marketplace entry agreement (`dorkos marketplace validate`)

`checkSourcePaths` (`packages/cli/src/commands/validate-source-paths.ts:77`) already reaches every relative-path entry's `.claude-plugin/plugin.json`, locally (`localProbe`) and remotely (`remoteProbe`, a raw fetch). But it only confirms the file exists. Widen the probe to return the parsed `version` too. Then, for each entry that sets `version` where that `plugin.json` also declares one and the two differ, report an **error** (`ENTRY_VERSION_MISMATCH`). The message names the entry, both values, and Claude Code's rule that `plugin.json` silently wins.

- Comparing against `plugin.json` is sufficient: it is the only file that masks the entry, and §2 already holds the manifest equal to it.
- An entry `version` on a package that declares none is legitimate: Claude Code uses it (step 2 of the chain).
- **Object-form entries** (`github`, `url`, `git-subdir` pointing at another repo) are skipped today (`skipped-object-source`) and stay skipped. Checking them would clone foreign repos during validation. The update check still reports the version it actually used.

### 4. One source identity (`@dorkos/marketplace` + resolvers)

The commit short-circuit (§5) is only sound if the installed commit and the looked-up commit were read from the same place. Today three resolvers default the ref to `'main'` (`git-subdir.ts:67`, `github.ts:28`, `url.ts:27`), while `resolveCommitSha` defaults an absent ref to `'HEAD'` (`package-fetcher.ts:595`). The github form also builds its clone URL separately (adding `.git`).

Add one exported function, used by every resolver **and** by `resolveLatest`:

```ts
/** The exact place a package is fetched from, normalized so two can be compared. */
export interface SourceKey {
  cloneUrl: string; // the URL git is actually given
  subpath: string; // '' for a whole-repo source
  ref: string; // the effective ref: sha ?? ref ?? 'main'
}
/** `undefined` for sources with no clone URL (`relative-path` over file://, `npm`). */
export function sourceKeyOf(source: ResolvedSourceDescriptor): SourceKey | undefined;
```

The resolvers take `cloneUrl` and `ref` from it rather than recomputing them. `InstallMetadata` gains `sourceKey?: SourceKey` (§6) so the next check can compare like with like.

### 5. Resolving "latest" (`MarketplaceInstaller.resolveLatest`)

Add one public method. It reuses `resolveAndValidate`'s resolve → stage → validate pipeline and adds a commit short-circuit.

```ts
export type LatestResolution =
  | { kind: 'unchanged' }
  | {
      kind: 'resolved';
      declaredVersion?: string;
      entryVersion?: string;
      commitSha?: string;
      sourceKey?: SourceKey;
    }
  | { kind: 'unresolved'; reason: string };

async resolveLatest(
  req: InstallRequest, // `marketplace` = the source the update flow matched; or `source` for direct installs
  opts: {
    installed: { commitSha?: string; entryVersion?: string; sourceKey?: SourceKey };
    commitLookup: CommitLookup;
  }
): Promise<LatestResolution>;
```

1. `resolver.resolve(req)` → `ResolvedPackageSource`, which gains `entryVersion` (the entry's `version`, read where the resolver reads the entry). `buildFetchableSource` → the concrete source → `sourceKeyOf`.
2. **The short-circuit.** It needs all three to match the install: the same `sourceKey`, the same `entryVersion` (both absent counts as the same), and the same commit, looked up through `opts.commitLookup(key.cloneUrl, key.ref)`. A `key.ref` that is a full 40-hex SHA **is** the commit: `commitLookup` returns it without calling `ls-remote`, which matches ref names only and would otherwise report a pinned package as unreachable. On a match it returns `unchanged`, with no staging and no clone. A missing `sourceKey` (sidecars written before this change) never short-circuits. The entry `version` and the entry's source can move while the source repo's commit does not (a foreign-repo entry re-pointed or re-versioned in the index), and checking all three catches that.
3. **Otherwise it stages through the existing path** (`stagePackage`, cached as `<name>@<sha>`, the same fetch an install does) and computes `readDeclaredVersion` on the staged tree. `resolved.commitSha` is the commit staging reports, not the lookup's, so a push that lands between the two is reported as what an install would actually fetch.
4. It runs `validatePackage` on the staged tree. A failure (`VERSION_MISMATCH` or any other error) returns `unresolved`, naming the validator's messages: "the new version can't be installed: …". A version DorkOS would refuse to install is never offered.
5. **A local `file://` source** has no commit. It is staged in place and always validated, which costs nothing remote.
6. **Errors never escape.** Any thrown resolver or fetch error, including a refused address (DOR-1799), becomes `unresolved`, and one bad package never sinks the check. A placeholder commit from a failed `ls-remote` is `unresolved` too ("couldn't reach <host>"), never a comparison.

`preview` and `install` are untouched. They keep calling `resolveAndValidate`.

**Known limit, filed separately rather than papered over:** the SHA-keyed cache can hold a different tree than its key names. `git-subdir` clones the default branch at `--depth=1` and then checks out the ref (`git-subdir.ts:186-201`). `github`/`url` sources ignore the ref entirely (`template-downloader.ts:614-620`). And a push between the lookup and the clone lands under the looked-up key. This is an install-integrity defect that predates this spec, and `resolveLatest` inherits it exactly as install does. It is filed as its own item (see References), because fixing it means changing how every install fetches, not how updates are checked.

### 6. The update flow (`flows/update.ts`)

- **One identity reader.** Delete `readInstalledManifest`. `listInstalled` reads each install through the installed scanner's reader, exported as `readInstalledIdentity(installRoot)`. It is total, and it never gates on validity (§2). Claude-Code-only installs become visible.
- **The installed side of the chain.** `resolvePackageVersion({ declaredVersion: readDeclaredVersion(installRoot), entryVersion: metadata.entryVersion, commitSha: metadata.commitSha })`.
- **Which marketplace.** `findMarketplaceEntry` keeps its order: `installedFrom` if enabled, then every enabled source. The **matched** source's name is what `resolveLatest` receives, never `installedFrom` blindly. That avoids an `AmbiguousPackageError` on bare-name resolution when two sources list the package (`package-resolver.ts:271-276`), and a disabled source being used anyway (`:203-208`). A direct install (`name@url`, `github:`; no `installedFrom`) is rebuilt from its recorded `sourceKey` (URL, subpath, ref). The resolver's `name@url` input has no ref syntax, so `sourceRepo` alone could not carry a non-default ref. A direct install from before `sourceKey` existed falls back to `sourceRepo` at the default ref, and a `note` says so.
- **Memos live on the `UpdateFlow` instance** (one per server, `index.ts:4032`), with a 60s TTL: the commit lookup per (`cloneUrl`, `ref`), and the index fetch per source. The CLI makes one request per package (below), so a per-`run()` memo would never span packages. The rules:
  - It stores the **in-flight promise**, so concurrent requests (the CLI and the app together) share one `ls-remote`.
  - It never stores a failure or a placeholder, so a retry after the network returns looks again.
  - It is cleared on every `apply` and on `marketplace refresh`, so "I just pushed; check again" is answered fresh after a refresh.
  - The honest claim is "shared within one CLI run or UI burst". Without a refresh, a push made within the last 60 seconds can still read as current.
- **The comparison** (`compareVersions(installed, latest)`), in order:
  1. `unchanged` → current.
  2. `unresolved` → `unknown`, with the reason.
  3. Installed side unknown (no declared version, no entry version, no real commit): `unknown`, note "reinstall this package to enable update checks". This happens with file:// marketplaces, pre-DOR-147 sidecars and placeholder SHAs.
  4. Both sources are `package` or `index`, and both are valid semver → update when `latest > installed` (strictly). A lower latest is `current`, with a `rollback` note: never offer a downgrade as an "update".
  5. Both are versions but at least one is not semver → update when the strings differ.
  6. Either source is `commit` → update when the commits differ. Claude Code behaves the same for a package that declares no version, and one that wants fewer updates should declare one. Accepted edge: a sidecar from before `entryVersion` existed, for a package identified by its entry version, compares `commit` with `index` and reports one spurious update. Applying it rewrites the sidecar, and the edge disappears.
- **`UpdateCheckResult` is additive.** It gains `status: 'current' | 'update-available' | 'unknown'` (`hasUpdate === (status === 'update-available')`), `installedVersionSource?` and `latestVersionSource?` (`VersionSource`), and `note?`. When `status === 'unknown'`, `latestVersion` is `''`.
  - These are mirrored in every copy of the type:
    - `@dorkos/shared/marketplace-schemas` (`:525-533`);
    - the OpenAPI `LocalUpdateCheckResultSchema` (`services/core/openapi-registry.ts:393-399`);
    - the CLI's local mirror (`packages/cli/src/commands/update.ts:30-35`);
    - the embedded-mode stub (`apps/client/src/layers/shared/lib/embedded-mode-stubs.ts:891`).
- **Nothing is dropped.**
  - A package no enabled source lists is returned as `unknown`: "no enabled marketplace lists this package".
  - A named package that is not installed in the requested scope is returned as one `unknown` result ("not installed in this scope"), not thrown. `UpdateFlow` cannot tell that from "installed nowhere" on its own, so the **route** decides first. It already holds `listAgentScopes`; when the name appears in no scope at all, it answers **404** via an explicit `PackageNotInstalledForUpdateError` mapping in `mapErrorToStatus` (`routes/marketplace.ts:187-231`). Today that error falls through to a 500. The flow tests that expect a throw (`flows/update.test.ts:441`, `:565`, `:715`) are rewritten to the `unknown` result.
- **The index can be stale.** `fetchMarketplaceJson` serves the cached index when the network fails (`package-fetcher.ts:323-333`). That is accepted: the commit lookup then fails too, so a remote package comes back `unknown` rather than falsely current. The index only feeds `entryVersion` and the source.
- **`apply`** reinstalls only `update-available` entries. An apply never runs on `unknown`.
- **Recorded at install.** `InstallMetadata` gains `entryVersion?` and `sourceKey?`, filled by `writeInstallMetadata` (`marketplace-installer.ts:337-367`) from the resolved source. Its `version` now records `resolvePackageVersion(...).version` whenever the source is `package` or `index`, instead of the synthesized manifest's `'0.0.0'`.
- **The installed list agrees with the check.** `readInstalledIdentity`'s `version` is `readDeclaredVersion ?? manifest version`, so the Installed view shows what the update check compares (and what Claude Code runs). It no longer shows `0.6.0` for a flow that runs 0.7.2, or `0.0.0` for a Claude-Code-only package that declares a version.

### 7. Surfaces

- **CLI** (`packages/cli/src/commands/update.ts`).
  - **Name-less runs finally work.** Targets come from `GET /installed`, forwarding `--project`. Without `--project`, the across-scopes listing includes agent installs, and each target is checked with that install's own `agentPath` as `projectPath`, so `UpdateFlow` walks the same scope the listing found the package in. Targets are de-duplicated on (`name`, `projectPath`).
  - **One failure no longer aborts the run.** A per-target API error prints as `could not check` and the run continues. The single outer catch stays only for failure to reach the server at all.
  - **Output**, one line per check:
    - `name  0.7.2 → 0.7.3  (dorkos-community)` for an available update;
    - `name  up to date (0.7.3)` for a current package;
    - `name  could not check: <note>` for an unknown one.

    A commit version prints as `commit abc1234`. The summary counts all three, and never says "All N up to date" while any result is unknown.

  - Exit code: 0 on success; 1 when the server was unreachable **or any requested apply failed**, so a script can tell. A non-zero "stale" exit belongs to DOR-2193's `outdated`.
- **App** (`use-update-with-toast.ts`). An applied-nothing response whose check was `unknown` shows "Couldn't check <name> for updates: <note>" in place of "already up to date". A `current` one keeps today's text.
- **Route.** Unchanged shape plus the new fields, and unchanged authorization (ADR-0233): advisory is a read, apply authorizes as `marketplace.install`.

### 8. `dork-labs/marketplace`

- **Data.** flow's `.dork/manifest.json`, `.claude-plugin/plugin.json` and `package.json` all go to **0.7.3**, so every install on the current commit sees a new version. A CHANGELOG entry says installs now report the right version.
- **Repo version check** (a new module in `tools/schema-check`, run by `npm run check`). For every `plugins/<name>/`, collect the versions declared by `.dork/manifest.json`, `.claude-plugin/plugin.json`, and `package.json` (when it has a `version` and sits at the package root). Fail when two differ, or when a manifest declares one and `plugin.json` does not (§2's rule, applied at the source). The failure names each file and value. This is the gate; `REVIEW.md:87` is rewritten to point at it. The schema-check pin vendors schemas only (`validate.ts:34-45`), so a pin bump would _not_ bring in DorkOS's validator.
- **Bump-on-change check** (`tools/schema-check`, a new CI step). Take the diff between the PR's base and head, and group changed paths by `plugins/<name>/`. A package whose files changed must have its declared version (the same collector, `plugin.json` first) go strictly up (semver).
  - A new package passes, and so does a deleted one.
  - A package that declares no version at base _and_ head is exempt: Claude Code serves it by commit, so every change already reaches users. The message says that declaring a version opts in.
  - **Removing a version fails.**
  - Renames are matched through `marketplace.json`: the entry whose relative `source` points at the directory, at base and at head. The entry name is the install identity, so a directory move stays one package, and a changed entry name is a new package plus a deleted one, which is the truth for anyone who installed it.
  - The failure message explains why in one sentence: "Claude Code and DorkOS only deliver a change to people when the version goes up."
  - **CI mechanics:** `actions/checkout` with `fetch-depth: 0`, so the merge base exists. The step runs on `pull_request`, and also on `push` to `main` comparing `github.event.before..github.event.after`, which catches two PRs that each bumped to the same version and merged in sequence. The `schemas` job's `concurrency` becomes `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`, so a quick second merge can't cancel the first `push` run.
  - Making both checks **required** in the repository ruleset is the operator's call (§Open Questions 5).
- **Workflow.** Both checks run inside the existing `schemas` job (`.github/workflows/schema-check.yml`). The repo's `CLAUDE.md` CI section lists them.

## User Experience

**Operator:** Kai runs `dorkos update --project .` in a repo with flow installed at 0.7.2 after 0.7.3 merges.

```
flow   0.7.2 → 0.7.3   (dorkos-community)
1 update available. Run again with --apply to install it.
```

`--apply` reinstalls it, and a rerun says `flow  up to date (0.7.3)`. With the network off, the line says `flow  could not check: couldn't reach github.com`, and the summary says one package could not be checked. It never claims everything is current. With no `--project`, every install in every scope is checked in its own scope, and one broken install doesn't stop the rest.

**Package author:** Priya bumps `plugin.json` but forgets `.dork/manifest.json`. `dorkos package validate` fails with `VERSION_MISMATCH`, naming both files and both values, before she can publish. In `dork-labs/marketplace`, a PR that edits `plugins/flow/` without a bump fails with a one-sentence reason.

**Person installing a third-party package with mismatched files:** the install is refused with the same plain message, which says the package's author has to make the two files agree. If they installed it before this change, it stays listed, usable and removable; its update check says the new version can't be installed and why.

## Testing Strategy

Each test carries a purpose comment and can fail.

- **Unit: `readDeclaredVersion` / `resolvePackageVersion` / `isRealCommitSha`** (`packages/marketplace`). Covers:
  - every step of the chain;
  - `plugin.json` over the manifest when both are present (and when they disagree);
  - no version in `plugin.json` falls through to the manifest;
  - an unparseable file never throws;
  - every sentinel (`tmp-*`, `local`, the relative-path sentinel) is rejected;
  - all-absent → `undefined`.
- **Unit: `validatePackage`.** Covers:
  - both `VERSION_MISMATCH` forms;
  - agreeing files produce no issue;
  - a manifest-only type (agent) with no `plugin.json` produces no issue;
  - `declaredVersion` is present on an `ok:false` result;
  - `declaredVersion` is `undefined` for a Claude-Code-only package with no `version`, and `'0.0.0'` when `plugin.json` really says so.
- **Unit: `sourceKeyOf` + resolvers.** The same descriptor yields the same key in the resolver and in `resolveLatest`. The github form's `.git` URL and the default `'main'` ref are identical on both paths.
- **Unit: `UpdateFlow`** (`flows/update.test.ts`). The fixtures are rewritten so the default entry has **no** `version`, which is our real marketplace's shape. Add:
  - an update detected from the package with no entry version (0.7.2 → 0.7.3);
  - an installed tree with **mismatched** files (manifest 0.6.0, `plugin.json` 0.7.2) is listed, reads as 0.7.2, and is checked;
  - `unchanged` short-circuit: nothing stages (a spy on staging);
  - no short-circuit when the entry `version` changed but the commit did not, when the `sourceKey` changed, or when the sidecar has no `sourceKey`;
  - the commit lookup is memoized across two `run()` calls within the TTL, and repeated after it;
  - Claude-Code-only installs are visible;
  - an unreachable source, and a source that lists nothing, both give `unknown`, never a drop;
  - a new version failing validation → `unknown` with the validator's message;
  - a rollback is not offered;
  - commit-identified packages compare by commit;
  - `apply` skips `unknown`;
  - a direct install resolves through its `sourceRepo`;
  - two enabled sources listing the same name use the matched source, with no `AmbiguousPackageError`;
  - a full-SHA ref short-circuits with no `ls-remote`;
  - the memo shares one in-flight lookup between concurrent runs, does not keep a failure, and clears on apply and refresh;
  - the route returns 404 for a name installed nowhere, and an `unknown` result for a name installed only in another scope.
- **Unit: `checkSourcePaths`.** `ENTRY_VERSION_MISMATCH` is reported; an entry version on a package that declares none is accepted; object-form entries are skipped.
- **Unit: CLI `update`.**
  - three line kinds, and a three-way summary with no "All N up to date" while any result is unknown;
  - per-target error isolation;
  - a failed apply exits 1;
  - agent installs checked with their own `agentPath`;
  - de-duplication.
- **Unit: installed scanner.** The listed version matches the declared version for a mismatched tree and for a Claude-Code-only package.
- **Integration** (`marketplace/__tests__/integration.test.ts`, local `file://` fixture). Install at 1.0.0, then rewrite the fixture to 1.1.0 with the entry version unset. Update reports it; apply; a rerun reports current. This is the original repro, end to end.
- **`dork-labs/marketplace`.**
  - The repo version check: agree / disagree / manifest without a `plugin.json` version / no `package.json` version.
  - The bump check against real temporary git repos:
    - changed without a bump fails;
    - a bump passes;
    - a new package passes, and so does a deleted one;
    - a no-version package is exempt;
    - removing the version fails;
    - a docs-only change inside a package still needs a bump;
    - a moved directory is matched through its `marketplace.json` entry;
    - a quick second merge does not cancel the first `push` run's comparison (workflow review, not a unit test).
- **Mocking.** The commit lookup and staging are injected on the installer's existing deps seams. No test touches the network.

## Performance Considerations

- **An unchanged package costs one `git ls-remote`** (15s timeout, `LS_REMOTE_TIMEOUT_MS`), shared across packages from the same repository and ref for 60 seconds. For `dork-labs/marketplace` that is one lookup for its same-repo packages, plus one per foreign-repo entry (lifeos-starter today).
- **A changed package costs one sparse, blob-filtered clone of its subdirectory**, cached as `<name>@<sha>`. For same-repo packages, a commit to the marketplace repo re-stages every installed package from it on the next check. That is bounded by the number of installed packages and cached afterwards.
- **The cache grows by one entry per package per marketplace commit that a check observes.** `MarketplaceCache.prune` has no automatic caller today (`marketplace-cache.ts:354`). Manual `dorkos update` checks add little, but DOR-2194/DOR-2196's polling would. A follow-up item gives prune an owner before either polls; it is linked from both (see References).
- The check stays sequential, as today. Parallelism belongs to DOR-2194's all-packages route, which owns the cost model for a whole-install scan.

## Security Considerations

- `resolveLatest` runs no package code. It stages and validates only, exactly as `preview` does. Nothing is installed without `apply`, which keeps its `marketplace.install` authorization (ADR-0233, DOR-492).
- Every git address still passes `assertSafeGitRemote` / `isSafeGitUrl` before `git` sees it. The commit lookup keeps `resolveCommitSha`'s refusal-propagates rule (DOR-1799): a refused address is `unresolved` with the refusal as its reason, never swallowed.
- The CI checks read only the PR's own diff and files, need no secrets, and run with the default read-only token.

## Documentation

- `contributing/marketplace-installs.md`:
  - the update-flow section: the resolution chain, the short-circuit's three conditions, the three statuses, the known cache-integrity limit;
  - fix the `install()` → `update()` misstatement (`:175`).
- `contributing/marketplace-packages.md`: a "Versioning" section.
  - One version, stated in `plugin.json` and `.dork/manifest.json` identically.
  - Bump on every change, because Claude Code and DorkOS deliver only a changed version.
  - What happens when a package declares none.
- `contributing/marketplace-registry.md:157`: say when an entry `version` is used, and warn against setting it beside a package version.
- `docs/` (user-facing): the update page describes the three outcomes in plain words (`writing-for-humans`).
- `marketplace-installer.ts:487`: correct "Uninstall WITH purge" to what the code does.
- Changelog fragment: "`dorkos update` and the Update button now notice new versions of marketplace packages. Before, they always said everything was up to date."
- ADR-0233's "same permission preview on apply" claim: route it to `/adr:audit`, not a silent edit to an accepted ADR.
- `dork-labs/marketplace`: `REVIEW.md:87` points at the executable check, and `CLAUDE.md`'s CI section lists both checks.

## Implementation Phases

Order is forced by CI and by install behavior. After Phase 2, DorkOS refuses to install a package whose version files disagree, so the marketplace must be clean and guarded first.

- **Phase 1: `dork-labs/marketplace`, data and gates.**
  - flow → 0.7.3 in all three files, with a CHANGELOG entry.
  - The repo version check and the bump-on-change check (neither depends on DorkOS), including `fetch-depth: 0` and the `push: main` trigger.
  - One PR. From here on no new mismatch can merge.
- **Phase 2: dorkos.** §1–§7, with tests, docs and the changelog fragment. One PR.
- **Phase 3: verify for real.** On this machine, without reinstalling anything by hand:
  - run `dorkos update --project <dorkos|dorkos-cloud|blintz>` against the live marketplace;
  - see `flow 0.7.2 → 0.7.3` (the installed side reads `plugin.json`'s 0.7.2 despite the 0.6.0 manifest);
  - apply, and see current;
  - run a name-less `dorkos update` and see every scope checked without aborting;
  - record the output on DOR-2244.

## Open Questions

1. ~~Should a `plugin.json`/manifest mismatch block an install of a third-party package, or only warn?~~ (RESOLVED)
   **Answer:** Block, with a plain message naming both files, both values, and that the author must fix it.
   **Rationale:** Installing it means DorkOS and Claude Code disagree about the installed version for its whole life, which is the defect this spec exists to end. Already-installed trees are never gated (§2), so nobody loses a package they already have. A person can't fix someone else's package locally in any supported way, and a warning would train people to ignore the one signal that the package is misdescribed.
2. ~~Should "update available" mean newer, or merely different?~~ (RESOLVED)
   **Answer:** Newer when both sides are semver versions; different otherwise.
   **Rationale:** Claude Code's `update` re-resolves and takes whatever it finds, so a rollback reaches Claude Code users silently. DorkOS reports a lower version as `current`, with a `rollback` note, so it never presents a downgrade as an improvement.
3. ~~Does the bump-on-change check exempt documentation-only changes?~~ (RESOLVED)
   **Answer:** No.
   **Rationale:** A package's README and docs ship inside the install (flow's guides are charter G15), and a change that doesn't bump never reaches anyone. An exemption list would be a second rule to keep true.
4. ~~Should the check report the commit-identified version as a SHA in `installedVersion` / `latestVersion`, or leave them as `0.0.0`?~~ (RESOLVED)
   **Answer:** The full SHA, with `*VersionSource: 'commit'`. Surfaces shorten it.
   **Rationale:** `0.0.0` is the masked-identity bug. The SHA is what Claude Code itself uses as the version for such a plugin.
5. **Should the two new `dork-labs/marketplace` checks be required status checks in that repo's ruleset?** (OPEN, operator's call: repository settings)
   **Recommendation:** Yes, once Phase 1 has run green on `main`. Also turn on "require branches to be up to date", which closes the two-PRs-bump-to-the-same-version race at merge time, rather than only after it on `push`.

### Review log

**Round 1 (adversarial, 2026-09-23):** 3 blockers, 9 should-fix and 6 nits against the first draft. All were adopted; the design's direction held. The main changes:

- **Installed trees are never gated.** `readDeclaredVersion` reads files directly; the first draft would have hidden every install that disagrees today, flow included.
- **The short-circuit also requires the same `sourceKey` and `entryVersion`,** not just the same commit. An index-only change would otherwise have read as current.
- **`sourceKeyOf` is the one normalizer** for clone URL and ref across install and lookup.
- **A name-less CLI run** checks each install in its own scope and isolates failures per target.
- **Memos live on the instance with a TTL,** because the CLI makes one request per package.
- **The matched marketplace is passed on,** never a blind `installedFrom`. Direct installs go through `sourceRepo`.
- **A manifest version with no `plugin.json` version is also a mismatch.**
- **The pin bump is not a gate** (the pin vendors schemas only). The repo check is the gate, and it moves into Phase 1.
- **The bump check gains** `fetch-depth: 0`, a `push: main` run, a removed-version failure, and matching renames by name.
- **Every mirror of `UpdateCheckResult` is listed,** and the installed list shows the same version the check compares.
- **"Stage at the exact SHA" is dropped.** Clones don't honour it; that defect is filed as DOR-2248 instead of being assumed away. Cache pruning got an owner item, DOR-2249.

**Round 2 (delta-verify, 2026-09-23):** 16 of 18 resolved, 2 partial, 0 blockers; 3 new should-fix and 4 nits. All adopted:

- **A full-SHA ref is its own commit,** with no `ls-remote`.
- **The memo** stores in-flight promises, never failures, clears on apply and refresh, and its claim is reworded.
- **The route decides 404 vs a scoped `unknown`,** with an explicit error mapping (today it is a 500).
- **The bump check's `push` run can't be cancelled** by a second merge.
- **A failed apply exits 1.**
- **`sourceKeyOf` is optional,** and a direct install is rebuilt from its `sourceKey`.
- **Moves are matched through `marketplace.json` entries.**

## Related ADRs

- ADR-0228: the manifest declares the version. Refined, not replaced: the manifest and `plugin.json` must now agree.
- ADR-0232: SHA-keyed cache. Unchanged, and relied on for the short-circuit.
- ADR-0233: update is advisory by default. Unchanged contract; the check becomes truthful.
- ADR-0237: same-repo monorepo seed. Its shared history is why a repo commit re-stages every package; accepted.
- ADR-0238: the Claude Code format superset. This spec adopts Claude Code's version resolution as part of that superset.
- **New (draft):** ADR 260923-122615, a package's latest version is what an install would resolve, by Claude Code's chain (`decisions/260923-122615-package-version-resolved-like-an-install.md`).
- **New (draft):** ADR 260923-122616, a package's version files must agree, and a mismatch fails validation (`decisions/260923-122616-package-version-files-must-agree.md`).

## References

- DOR-2244 (this), DOR-2245, DOR-2246, DOR-2193, DOR-2194, DOR-2195, DOR-2196, DOR-2197.
- Filed from review round 1: DOR-2248 (a cached tree can differ from its commit key), DOR-2249 (the package cache has no pruning owner).
- `dork-labs/marketplace#37` (flow 0.7.2, where this was found).
- Claude Code docs: `plugins-reference.md` (version management), `plugin-marketplaces.md`, `plugins.md`.
- `research/20260323_claude_code_plugin_marketplace_schema.md` (entry fields), `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/impact-assessment.md:169` (runtime plugin version).
