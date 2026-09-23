---
slug: marketplace-version-truth
number: 260923-122229
created: 2026-09-23
status: ideation
linear-issue: DOR-2244
project: Marketplace Package Management
---

# Know when a marketplace package has a new version

**Slug:** marketplace-version-truth
**Author:** Claude Code
**Date:** 2026-09-23
**Tracker:** DOR-2244 (project: Marketplace Package Management)

---

## 1) Intent & Assumptions

- **Task brief:** `dorkos update` (and the app's Update button, and the update route under both) can never tell that a marketplace package has a newer version. Every package reports "up to date" forever. Fix the cause, not the symptom: decide where a package's version is true, make the update check read it from there, and stop the version files inside a package from drifting apart. The operator asked for a proper fix with drift prevention and no bandaids.
- **Assumptions:**
  - DorkOS marketplaces are a superset of the Claude Code plugin marketplace format (ADR-0238, `specs/marketplace-05-claude-code-format-superset`). Where Claude Code has settled a rule, DorkOS follows it rather than inventing a second one.
  - The update check may use the network. It already fetches `marketplace.json` for every package it checks.
  - Every package install already records `commitSha` in `.dork/install-metadata.json` (DOR-147), and the package cache is keyed by `<name>@<sha>` (ADR-0232).
- **Out of scope (split out at triage, each its own item):**
  - DOR-2245: keep a package's settings when it is updated. An update is uninstall-then-install, and only `.dork/data/` and `.dork/secrets.json` survive it.
  - DOR-2246: flow's config validator rejects configs that are missing only defaulted fields.
  - DOR-2194 (an all-packages update route), DOR-2195 (MCP `marketplace_update` + staleness), DOR-2196 (the Installed view says what is stale). All three read `hasUpdate`, so this item blocks them. None of them is built here.
  - DOR-2197 (verify an install still matches its pinned commit, via a content hash).

## 2) Pre-reading Log

- `apps/server/src/services/marketplace/flows/update.ts`: `checkOne()` sets `latest = match.entry.version ?? pkg.version` (`:283`). `readInstalledManifest` (`:381-393`) reads only `.dork/manifest.json`. `isNewerVersion` (`:351-358`) does a semver compare, and falls back to string inequality when the input is not semver.
- `apps/server/src/services/marketplace/marketplace-installer.ts`: `resolveAndValidate` (`:605-630`) resolves the source, stages the package (sparse clone into the SHA-keyed cache), runs `validatePackage`, and returns `{ manifest, packagePath, commitSha }`. `install` and `preview` both go through it. The update check never does.
- `apps/server/src/services/marketplace/source-resolvers/git-subdir.ts:67-77`: runs `git ls-remote` for the ref's SHA, then looks in the cache for `<name>@<sha>`, and clones only on a miss. So re-resolving an unchanged package costs one `ls-remote`.
- `apps/server/src/services/marketplace/installed-scanner.ts:357-440`: reads `.dork/manifest.json`, and falls back to `validatePackage`, which builds the identity from `.claude-plugin/plugin.json` for a Claude-Code-only package (DOR-264). The update flow has its own reader that lacks this fallback.
- `packages/marketplace/src/package-validator.ts:148-233, 630-661`: prefers `.dork/manifest.json`, and uses `plugin.json` only when there is no manifest. When both exist, `plugin.json` is only checked for existence; its `version` is never read.
- `packages/marketplace/src/manifest-schema.ts:25-29, 77-78`: the manifest's `version` is required semver. `marketplace-json-schema.ts:211` and `cc-validator.ts:98`: the index entry's `version` is optional. `dorkos-sidecar-schema.ts`: the sidecar has no `version`.
- `marketplace/tools/schema-check/src/validate.ts:446-492`: validates the index, the sidecar, each `.dork/manifest.json` and skill frontmatter against the pinned upstream schemas (`tools/schema-check/upstream.json`, dorkos `f187c575`, 2026-09-02). Nothing compares versions. `marketplace/REVIEW.md:87` asks human reviewers to keep `plugin.json` and `package.json` in step, and flow breaks it today.
- `decisions/0233-marketplace-update-is-advisory-by-default.md`, `0228` (the manifest declares the version), `0232` (the cache is keyed by SHA, "versions are mutable"), `0236` (the sidecar), `0237` (same-repo monorepo seed: shared git history), `0238` (the Claude Code validator ported to Zod).
- Claude Code docs, fetched 2026-09-23:
  - `plugins-reference.md`: "If also set in the marketplace entry, `plugin.json` wins."
  - `plugin-marketplaces.md`: "Avoid setting `version` in both `plugin.json` and the marketplace entry. Claude Code always uses the `plugin.json` value without warning." Also: "For git-based sources, if you omit `version`, Claude Code uses the source's resolved commit SHA."
  - Also from `plugin-marketplaces.md`: if the version is declared and commits land without a bump, "existing users … keep the cached copy."

## 3) Codebase Map

- **Primary components:**
  - `UpdateFlow` (`flows/update.ts`): the advisory check and the apply loop.
  - `MarketplaceInstaller` (`marketplace-installer.ts`): resolve, stage, validate, install, update.
  - `validatePackage` (`packages/marketplace`): package identity.
  - `installed-scanner.ts`: the installed list.
- **Callers of the check:**
  - `POST /api/marketplace/packages/:name/update` (`routes/marketplace.ts:847-895`)
  - `dorkos update` (`packages/cli/src/commands/update.ts`)
  - the app's `InstalledPackagesView` / `use-update-with-toast.ts`
  - the MCP surface, once DOR-2195 lands
- **Data flow today:** installed `.dork/manifest.json` version → compared to the index entry's `version` (always absent) → `hasUpdate: false`.
- **Blast radius:**
  - the update check's cost: from one index fetch per source, to one `ls-remote` per package plus a clone only when the commit moved;
  - every package whose `plugin.json` and `.dork/manifest.json` disagree now fails validation;
  - the marketplace repo's CI gains a version gate;
  - the `UpdateCheckResult` wire type in `@dorkos/shared/marketplace-schemas` (`:525-533`) gains fields.

## 4) Root Cause Analysis

- **Repro:**
  1. Install flow at 0.5.0.
  2. Merge 0.7.2 to `dork-labs/marketplace`.
  3. Run `dorkos marketplace refresh dorkos-community`.
  4. Run `dorkos update flow --project <p>`.
- **Observed:** "All 1 package(s) up to date". The raw check says `installedVersion 0.5.0, latestVersion 0.5.0`.
- **Expected:** `0.5.0 → 0.7.2`, update available.
- **Root causes:** two defects, plus a third that hides the first two.
  1. **The check asks the wrong place.** "Is there a newer version?" is answered from the index entry, an optional field that no DorkOS-published entry sets, and that Claude Code itself tells authors not to set alongside `plugin.json`. It never looks at the package. The honest question is "what would an install give me right now?", and the installer already answers that (`resolveAndValidate`). The update check just never asks it.
  2. **A package states its version in several files, and nothing makes them agree.** flow: `plugin.json` 0.7.2, `package.json` 0.7.2, `.dork/manifest.json` 0.6.0. DorkOS reads the manifest and reports `flow@0.6.0`. Claude Code reads `plugin.json` and reports 0.7.2. The two programs disagree about the same install.
  3. **Nothing tests the realistic case.** Every fixture in `flows/update.test.ts` sets an index entry `version`, so the suite passes against a shape our own marketplace never publishes.
- **Collateral, same cause:**
  - `readInstalledManifest` reads only `.dork/manifest.json`. So a Claude-Code-only package (9 of 14 in `dork-labs/marketplace` have no manifest) is invisible to the update check, even though the installed list shows it.
  - A name-less `dorkos update` then fails on it with `PackageNotInstalledForUpdateError` and exits 1.

## 5) Research

**How Claude Code resolves a plugin's version (the rule we inherit):** the `version` in `plugin.json`; else the marketplace entry's `version`; else, for git sources, the resolved commit SHA (for archives, the sha256). An update is available when that resolved value changes. A declared version pins users: new commits without a bump do not reach them.

**Potential solutions:**

1. **Fill in `version` on every index entry and keep reading the index.** A script generates the entries, and CI checks them.
   - Pros: cheap check, one fetch per source.
   - Cons: fixes only our own marketplace. Every third-party Claude Code marketplace stays blind, because most follow Claude Code's advice and leave the entry `version` unset. It adds a fourth copy of the version to keep in step. And it contradicts Claude Code's own guidance. This is a bandaid.
2. **Resolve "latest" the way an install would, and read the version the package itself declares.** Follow Claude Code's resolution chain, and short-circuit on the commit.
   - Pros: true for every marketplace, including ones we don't control. No new copy of the version. Reuses the installer's existing, cached, security-checked pipeline. Matches what Claude Code will report at runtime.
   - Cons: an `ls-remote` per package per check, and a sparse clone when the commit has moved. The SHA-keyed cache absorbs repeats.
3. **Compare commit SHAs only.**
   - Pros: cheapest possible "changed" signal.
   - Cons: for same-repo packages (ADR-0237) every commit to the marketplace repo moves every package's SHA, so this reports false updates constantly. It also can't say which version you would get.

**Recommendation:** Solution 2, plus drift prevention at both ends: DorkOS's validator refuses a package whose version files disagree, and the marketplace repo's CI refuses a change that moves a package without bumping its version.

## 6) Decisions

No question needed the operator. The brief ("proper root-cause fix, drift prevention, no bandaids") and Claude Code's published rule settle each choice below. Each is recorded so SPECIFY can challenge it.

| #   | Decision                                                            | Choice                                                                                                                                                                                                                                                                                                                         | Rationale                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where "latest" comes from                                           | The package itself, resolved the way an install would (`resolveAndValidate`'s resolve → stage → validate), never the index alone                                                                                                                                                                                               | "What would an install give me now?" is the only honest question. It works for every marketplace, and the installer already answers it.                                                                                                |
| 2   | Which version a package _has_                                       | Claude Code's chain, unchanged: the package's declared version; else the index entry's `version`; else the resolved commit SHA                                                                                                                                                                                                 | We are a superset of Claude Code's format. Diverging would make DorkOS and Claude Code disagree about the same install, which is the bug we are fixing.                                                                                |
| 3   | When `.dork/manifest.json` and `plugin.json` both declare a version | They must be equal. A mismatch is a validation **error**, and the message names both files and both values.                                                                                                                                                                                                                    | Two sources that may disagree are not a source of truth. Refusing to guess is honest. Claude Code would silently use `plugin.json`, and DorkOS would silently use the manifest, so any tie-break rule just picks which program lies.   |
| 4   | When an index entry's `version` disagrees with the package's        | A validation error in `dorkos marketplace validate` and the marketplace repo's CI; a logged warning in the update check, which follows the chain (package wins)                                                                                                                                                                | This is exactly the silent mask Claude Code's docs warn about. At check time we can't fix someone else's catalog, but we can say which value we used.                                                                                  |
| 5   | When "update available" is true                                     | Both sides semver: latest is strictly newer. Otherwise (a SHA-identified package, or non-semver strings): the resolved identity differs.                                                                                                                                                                                       | Semver-newer keeps a yanked or rolled-back version from being offered as an "update". Identity-differs matches Claude Code for packages that declare no version.                                                                       |
| 6   | Cost control                                                        | Short-circuit on the commit. If `ls-remote` returns the installed `commitSha`, the package is current, with no clone. Memoize `ls-remote` per (repo, ref) within one check run.                                                                                                                                                | Most checks hit an unchanged commit. For same-repo packages, one `ls-remote` serves them all.                                                                                                                                          |
| 7   | One identity reader                                                 | The update flow reads an installed package's identity through the same validator-backed reader as the installed list (manifest, else `plugin.json`)                                                                                                                                                                            | Removes the second, narrower reader that hides Claude-Code-only packages and crashes a name-less `dorkos update`.                                                                                                                      |
| 8   | What the check reports                                              | `UpdateCheckResult` gains `installedCommitSha?`, `latestCommitSha?` and `versionSource` (`package` \| `index` \| `commit`), beside the existing fields                                                                                                                                                                         | Lets every surface (CLI, app, MCP) say _why_ something is or isn't stale without re-deriving it. The fields are additive.                                                                                                              |
| 9   | Drift prevention in `dork-labs/marketplace`                         | (a) Bump the schema-check pin so CI runs the new version-agreement validator. (b) Add a repo check: every version-bearing file in a package root (`.dork/manifest.json`, `.claude-plugin/plugin.json`, a `package.json` that has a `version`) agrees. (c) Add a PR check: a package whose files changed must bump its version. | (a) and (b) stop disagreement. (c) stops the "code shipped, version didn't" case, which under Claude Code's rule never reaches a user. `package.json` is repo policy (`REVIEW.md:87` made executable), not a DorkOS validator concern. |
| 10  | Fix the data                                                        | flow's `.dork/manifest.json` goes to 0.7.2 in the same marketplace change that turns the gate on                                                                                                                                                                                                                               | The gate must land green, and flow is the one package that violates it today.                                                                                                                                                          |
| 11  | Landing order                                                       | Contract-first, three steps. (1) dorkos: validator, update flow, tests. (2) marketplace: fix flow's manifest, bump the pin, add the repo and PR checks. (3) Bump flow's version so installs pick up the corrected manifest.                                                                                                    | The marketplace's CI validates against dorkos's published schemas, so dorkos has to land first. Same shape as every earlier marketplace/dorkos change.                                                                                 |

**Doc drift to correct while in these files** (found during research; each is a false statement in a file this work edits):

- `marketplace-installer.ts:487` says "Uninstall WITH purge", but the code passes `purge: false`.
- `contributing/marketplace-installs.md:175` names `install()` where the code calls `update()`.
- ADR-0233's "same permission preview on apply" claim: note that it is not what the code does, and route it to `/adr:audit` rather than silently rewriting an accepted ADR.

**Recommended next step:** SPECIFY. The direction is settled and the open questions are implementation-level: the resolver seam the update flow calls, the exact `UpdateCheckResult` shape, and how the PR bump check computes "this package changed".
