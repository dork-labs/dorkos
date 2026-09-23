# Tasks: Know when a marketplace package has a new version

Spec: [`02-specification.md`](./02-specification.md) · Slug: `marketplace-version-truth` · Tracker: DOR-2244 · Generated: 2026-09-23T12:49:16Z · Mode: full

## Summary

17 tasks: Phase 1 (4, one PR in dork-labs/marketplace), Phase 2 (12, one PR in dorkos), Phase 3 (1, live verification).

**Landing order (forced by CI and install behavior):** the Phase 1 marketplace PR merges first. After Phase 2, DorkOS refuses to install a package whose version files disagree, so the marketplace must already be clean and guarded. Phase 2 can be _implemented_ in parallel with Phase 1; only its merge waits.

**Critical path:** 2.1 → 2.2 → 2.4 → 2.5 → 2.7 → 2.8 → 2.12 → 3.1 (Phase 1's chain 1.1 → 1.2 → 1.3 → 1.4 must also finish before 3.1, and must merge before the dorkos PR).

**Dependency graph**

```
Phase 1 (marketplace repo)      1.1 → 1.2 → 1.3 → 1.4 ─────────────────────────────┐
Phase 2 (dorkos)                2.1 ─┬─ 2.2 ─┬─ 2.6 ──────────┐                     │
                                     │       └───────┐        │                     │
                                     └─ 2.3 ──────── 2.4 → 2.5 ┴→ 2.7 ─┬─ 2.8 ─┐    │
                                                                       ├─ 2.9 ─┤    │
                                                                       └─ 2.10 ┤    │
                                2.11 (independent) ─────────────────────────────┴→ 2.12 → 3.1
```

**Same-file constraints (never parallel):** `marketplace-installer.ts` is edited by 2.1, 2.4, 2.5 and 2.12 (stale comment); `package-validator.ts` by 2.1 and 2.2; `packages/marketplace/src/index.ts` by 2.1 and 2.3; `flows/update.ts` only by 2.7; `routes/marketplace.ts` only by 2.8; `tools/schema-check/package.json` and `validate.ts` by 1.2 and 1.3.

**Parallel windows:** 2.11 runs any time. After 2.1: 2.2 ∥ 2.3. After 2.2: 2.6 ∥ 2.3/2.4/2.5. After 2.7: 2.8 ∥ 2.9 ∥ 2.10.

**Corrections to the spec found while verifying code (carried into the task descriptions):**

- The update-flow tests live at `apps/server/src/services/marketplace/__tests__/flows/update.test.ts`, not `flows/update.test.ts` (line refs :254/:441/:565/:702/:715 are right for that file).
- `installed-scanner.ts` does call the validator's gate: `validatedSummary` (:420-445) returns null unless `validated.ok`, for every Claude-Code-only install and every manifest the shallow parse rejects. Task 2.6 removes that gate; otherwise VERSION_MISMATCH would hide installs.
- `RELATIVE_PATH_SENTINEL_SHA` is defined in the server (`source-resolvers/relative-path.ts:20`), so moving `isRealCommitSha` into `@dorkos/marketplace` means moving the constant too.
- `packages/marketplace/src/index.ts` is a browser-safe barrel. `readDeclaredVersion` reads files, so it belongs in `package-validator.ts` (Node subpath); the pure functions go in the barrel.
- The github clone URL with `.git` is built in `packages/marketplace/src/source-resolver.ts:93`, not in `github.ts` (which only reads it).
- `CommitLookup` is used by the spec but never defined; task 2.5 defines it.
- The embedded-mode stub (`embedded-mode-stubs.ts:891`) is not a copy of `UpdateCheckResult`; it only throws. Nothing to mirror there.
- Claude-Code-only packages that declare a version already list that version today (the synthesized manifest copies it). The `0.0.0` masking only affects packages that declare none.
- The spec doesn't say how `apply` reinstalls a direct install (`name@url`, `github:`). `apply` sends `marketplace`, and a direct install has none. The resolver's `name@url` has no ref or subpath syntax, so an apply from a non-default ref reinstalls from the default branch. Task 2.7 flags this as a known limit.
- There is no dedicated user docs page for updates. The update content lives in `docs/marketplace/index.mdx` and `docs/guides/cli-usage.mdx`.

## Task list

| ID   | Title                                                                                               | Size   | Priority | Depends on                     | Parallel with                                                         |
| ---- | --------------------------------------------------------------------------------------------------- | ------ | -------- | ------------------------------ | --------------------------------------------------------------------- |
| 1.1  | Bump flow to 0.7.3 in every version file, with a changelog entry                                    | small  | high     | —                              | 2.1, 2.11                                                             |
| 1.2  | Add the repo version-agreement check to tools/schema-check                                          | medium | high     | 1.1                            | 2.1, 2.11                                                             |
| 1.3  | Add the bump-on-change check to tools/schema-check                                                  | large  | high     | 1.2                            | 2.1, 2.2, 2.3, 2.11                                                   |
| 1.4  | Run both checks in the schemas workflow and point REVIEW.md and CLAUDE.md at them                   | small  | high     | 1.3                            | 2.1, 2.2, 2.3, 2.11                                                   |
| 2.1  | Add the version primitives to @dorkos/marketplace and move isRealCommitSha there                    | medium | high     | —                              | 1.1, 1.2, 1.3, 1.4, 2.11                                              |
| 2.2  | Fail validation when manifest and plugin.json versions disagree, and expose declaredVersion         | medium | high     | 2.1                            | 1.3, 1.4, 2.3, 2.11                                                   |
| 2.3  | Add sourceKeyOf as the one clone-URL/ref normalizer and make the resolvers use it                   | medium | high     | 2.1                            | 1.3, 1.4, 2.2, 2.6, 2.11                                              |
| 2.4  | Record entryVersion and sourceKey at install, and the resolved version in the sidecar               | medium | high     | 2.2, 2.3                       | 1.3, 1.4, 2.6, 2.11                                                   |
| 2.5  | Add PackageFetcher.lookupCommitSha and MarketplaceInstaller.resolveLatest                           | large  | high     | 2.4                            | 1.3, 1.4, 2.6, 2.11                                                   |
| 2.6  | Export one total installed-identity reader from the scanner that reports the declared version       | small  | high     | 2.1, 2.2                       | 2.3, 2.4, 2.5, 2.11                                                   |
| 2.7  | Rewrite UpdateFlow on resolveLatest with an honest three-state result, and mirror the new fields    | xl     | high     | 2.5, 2.6                       | 2.11                                                                  |
| 2.8  | Route: 404 for a name installed nowhere, clear the update memos on refresh, and prove it end to end | medium | high     | 2.7                            | 2.9, 2.10, 2.11                                                       |
| 2.9  | CLI dorkos update: check every scope, isolate failures, and print three honest line kinds           | medium | high     | 2.7                            | 2.8, 2.10, 2.11                                                       |
| 2.10 | App: say when an update check couldn't run instead of 'already up to date'                          | small  | medium   | 2.7                            | 2.8, 2.9, 2.11                                                        |
| 2.11 | dorkos marketplace validate: report an entry version that plugin.json silently overrides            | medium | medium   | —                              | 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10 |
| 2.12 | Docs, changelog fragment and stale comments; open the dorkos PR after the marketplace PR merges     | medium | medium   | 2.5, 2.7, 2.8, 2.9, 2.10, 2.11 | —                                                                     |
| 3.1  | Verify on this machine against the live marketplace and record the output on DOR-2244               | small  | high     | 1.4, 2.12                      | —                                                                     |

## Phase 1: dork-labs/marketplace: data and gates

### Task 1.1: Bump flow to 0.7.3 in every version file, with a changelog entry

**Size:** small · **Priority:** high · **Depends on:** none · **Parallel with:** 2.1, 2.11

Repo: dork-labs/marketplace at /Users/doriancollier/Keep/dork-os/marketplace (main at c01ba54, "fix(flow): only the session that started a /flow auto drain is held by it (#37)"). Work in a worktree/branch of that repo; all four Phase 1 tasks ship as ONE PR in that repo, and that PR must merge before the dorkos PR (Phase 2), because once dorkos refuses mismatched version files, the marketplace has to be clean already.

WHY: flow states its version in three files and they disagree today (verified 2026-09-23):

- plugins/flow/.dork/manifest.json:4 "version": "0.6.0"
- plugins/flow/.claude-plugin/plugin.json:3 "version": "0.7.2"
- plugins/flow/package.json:3 "version": "0.7.2"
  DorkOS reads the manifest and reports flow@0.6.0; Claude Code loads plugin.json and runs 0.7.2. Every install on the current commit has to see a NEW version once the update check is fixed, so all three go to 0.7.3 (not 0.7.2).

CHANGES

1. Set "version" to "0.7.3" in:
   - plugins/flow/.dork/manifest.json (line 4)
   - plugins/flow/.claude-plugin/plugin.json (line 3)
   - plugins/flow/package.json (line 3)
   - plugins/flow/package-lock.json: the root "version" (line 3) and packages[""].version (line 9). Easiest: `cd plugins/flow && npm version 0.7.3 --no-git-tag-version`, which rewrites package.json and the lockfile together; then edit the two JSON manifests by hand.
2. plugins/flow/CHANGELOG.md: add a `## 0.7.3` section directly above `## 0.7.2`, in the file's house style (a bold one-line lead that says whether a reinstall matters, then bullets). Content to convey, in plain words (writing-for-humans skill):
   - DorkOS now shows the right version for this plugin. Its version files disagreed (one said 0.6.0 while the plugin itself was 0.7.2), so DorkOS listed 0.6.0 while Claude Code ran 0.7.2. All three now say 0.7.3.
   - No behavior change. Reinstalling moves you onto a version DorkOS and Claude Code agree on.
     Do not mention DorkOS Cloud or anything from the private repo.
3. Grep for other literal copies: `grep -rn "0\.7\.2\|0\.6\.0" plugins/flow --exclude-dir=node_modules` must list only CHANGELOG.md history afterwards.

ACCEPTANCE

- `jq -r .version plugins/flow/.dork/manifest.json plugins/flow/.claude-plugin/plugin.json plugins/flow/package.json` prints 0.7.3 three times.
- The flow workflow's steps (.github/workflows/flow-tests.yml: schema-sync check, typecheck, tests, format check) pass locally from plugins/flow.
- `cd tools/schema-check && npm run check` still passes.

### Task 1.2: Add the repo version-agreement check to tools/schema-check

**Size:** medium · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 2.1, 2.11

Repo: /Users/doriancollier/Keep/dork-os/marketplace. Same branch/PR as 1.1.

WHY: A package can state its version in `.dork/manifest.json`, `.claude-plugin/plugin.json` and `package.json`, and nothing compares them. REVIEW.md:87 asks humans to keep them in step and flow broke it. This makes the rule executable. It is the gate: the schema-check pin (tools/schema-check/upstream.json, dorkos f187c575) vendors DorkOS SCHEMAS only (see the imports at tools/schema-check/src/validate.ts:38-44), so bumping the pin would NOT bring in DorkOS's new VERSION_MISMATCH validator. Do not bump the pin for this.

CURRENT CODE (verified)

- tools/schema-check/src/validate.ts: `export interface Finding` at :48 ({ file, message }); `readJson(repoRoot, file)` at :411 returns `{ value } | { finding }`; `pluginDirs(repoRoot)` at :426 lists `plugins/*` dirs (not exported); `validateManifests` at :446-492; `validateRepo` at :529-531 returns `[...validateSkills(repoRoot), ...validateManifests(repoRoot)]`.
- tools/schema-check/src/cli.ts:16-27 runs validateRepo, prints `✓ Skills and manifests match DorkOS <repo>@<ref12>` or `✗ <file>: <message>` lines and exits 1.
- Real repo state: 14 plugin dirs. flow is the only package whose files disagree (fixed by 1.1). Packages with no manifest: code-reviewer, discord-adapter, docs-keeper, linear-integration, posthog-monitor, release-pack, security-audit-pack, security-auditor. Only flow has a root package.json.

NEW MODULE tools/schema-check/src/versions.ts (TSDoc on every export, house style of validate.ts):

```ts
/** A version-bearing file inside one package, and the version it declares. */
export interface DeclaredVersionFile {
  /** Repo-relative path, e.g. `plugins/flow/.claude-plugin/plugin.json`. */
  file: string;
  /** The `version` string, or undefined when the file declares none. */
  version: string | undefined;
}
/** Reads a repo-relative file; undefined when it does not exist. */
export type ReadRepoFile = (relPath: string) => string | undefined;
/** The version files of one package directory. Missing files are omitted. */
export interface PackageVersions {
  manifest?: DeclaredVersionFile; // <dir>/.dork/manifest.json
  plugin?: DeclaredVersionFile; // <dir>/.claude-plugin/plugin.json
  packageJson?: DeclaredVersionFile; // <dir>/package.json, ONLY at the package root and only when it has a string `version`
}
export function collectPackageVersions(read: ReadRepoFile, pkgDir: string): PackageVersions;
/** The version a package declares, Claude Code's order: plugin.json, else the manifest. */
export function declaredVersionOf(v: PackageVersions): string | undefined;
export function checkVersionAgreement(repoRoot: string): Finding[];
```

`collectPackageVersions` takes a reader (not a root) so Task 1.3 can reuse it against git revisions (`git show <rev>:<path>`). Provide a working-tree reader (readFileSync with existsSync) used by checkVersionAgreement. A file that exists but is not valid JSON: for plugin.json/package.json report a Finding "<file>: not valid JSON, so its version can't be read"; for the manifest, skip silently (validateManifests already reports it; never report the same file twice).

RULES (checkVersionAgreement, for every `plugins/<name>/`; export pluginDirs from validate.ts or move it into versions.ts and import it back):

1. Collect the declared versions of the files present. A nested package.json (e.g. plugins/flow/engine-tests/package.json) is never read.
2. Fail when any two collected versions differ. Message names each file and value, e.g.
   `plugins/flow: versions disagree: .dork/manifest.json says 0.6.0, .claude-plugin/plugin.json says 0.7.2, package.json says 0.7.2. Set every file to the same version.`
3. Fail when the manifest declares a version and plugin.json EXISTS but declares none (DorkOS's own rule, applied at the source). Message:
   `plugins/<name>: .dork/manifest.json says version <m> but .claude-plugin/plugin.json has no version. Add "version": "<m>" to plugin.json so Claude Code and DorkOS agree.`
4. plugin.json absent entirely: not this check's concern.
5. A package declaring no version anywhere passes.
   Finding.file = the package dir (`plugins/<name>`).

WIRING

- validate.ts:529-531: `validateRepo` returns `[...validateSkills(repoRoot), ...validateManifests(repoRoot), ...checkVersionAgreement(repoRoot)]`; update the module header (validate.ts:1-33, "Two halves") to describe the third check.
- cli.ts:19 success line becomes `✓ Skills, manifests and versions match DorkOS ${pin.repo}@${pin.ref.slice(0, 12)}`.
- tools/schema-check/README.md: add a short "Version agreement" section (what is compared, why, where the rule comes from: DorkOS rejects a manifest/plugin.json mismatch with VERSION_MISMATCH).

TESTS: new tools/schema-check/tests/versions.test.ts, fixtures built with mkdtempSync the way tests/validate.test.ts:26-37 does (never seed fixtures under the real plugins/). Each test has a purpose comment and can fail:

- all three files agree -> no finding;
- manifest 0.6.0 vs plugin.json 0.7.2 -> one finding naming both files and both values;
- manifest has a version, plugin.json has none -> finding with the "Add version to plugin.json" message;
- package.json without a `version` field, and no package.json at all -> agreement of the other two passes;
- plugin.json-only package (no manifest) passes;
- a nested package.json with a different version is ignored;
- unparseable plugin.json -> one finding, no throw.
  The existing "the real repository passes every check" test (tests/validate.test.ts:47-48) now also covers versions and must pass (requires 1.1).

VERIFY: `cd tools/schema-check && npm test && npm run typecheck && npm run format:check && npm run check`.

### Task 1.3: Add the bump-on-change check to tools/schema-check

**Size:** large · **Priority:** high · **Depends on:** 1.2 · **Parallel with:** 2.1, 2.2, 2.3, 2.11

Repo: /Users/doriancollier/Keep/dork-os/marketplace. Same branch/PR as 1.1/1.2. Depends on 1.2's `collectPackageVersions` / `declaredVersionOf` in tools/schema-check/src/versions.ts.

WHY: Under Claude Code's rule, once a package declares a version, commits that don't bump it never reach anyone. A change to a package must therefore raise its declared version. Claude Code's version order: plugin.json `version`, else the marketplace entry's `version`, else the commit SHA.

NEW FILES

- tools/schema-check/src/bump.ts

```ts
/** One package whose change broke the bump rule, or an informational note. */
export interface BumpFinding {
  /** The package's marketplace entry name (its install identity). */
  pkg: string;
  message: string;
  /** `error` fails CI; `note` is printed only (the no-version exemption). */
  level: 'error' | 'note';
}
/** Compare every package changed between `base` and `head` in the git repo at `repoRoot`. */
export function checkVersionBumps(repoRoot: string, base: string, head: string): BumpFinding[];
```

- tools/schema-check/src/bump-cli.ts: `tsx src/bump-cli.ts <base> <head>`; repo root resolved three levels up exactly like cli.ts:13-14. Prints `✓ Every changed package raised its version` when no error; otherwise `✗ <pkg>: <message>` per error and exits 1; notes print as `i <pkg>: <message>` and never fail. If <base> is all zeros (a push that created the branch) print a note and exit 0.
- package.json script: `"check:bump": "tsx src/bump-cli.ts"` (called as `npm run check:bump -- <base> <head>`).

ALGORITHM (all git calls via execFileSync with an argv array, no shell; `-C repoRoot`):

1. Changed paths: `git diff --name-only -z --no-renames <base>...<head>` (three-dot = from the merge base, so unrelated commits on main never count). Keep only paths under `plugins/<dir>/`.
2. Identity through marketplace.json. At each of base and head, read `.claude-plugin/marketplace.json` with `git show <rev>:.claude-plugin/marketplace.json`, and map every entry whose `source` is a string (relative path) to its normalized dir (strip leading `./`, trailing `/`) -> entry name. The entry NAME is the install identity: a directory move whose entry keeps its name is ONE package; a changed entry name is a new package plus a deleted one (that is the truth for anyone who installed it). A changed dir listed at neither rev falls back to its directory name.
3. For each changed package name: baseDir = the dir its entry points at in base; headDir = in head.
   - no baseDir -> new package: pass.
   - no headDir -> deleted package: pass.
   - Read versions at both revs with `collectPackageVersions(readAtRev, dir)` where readAtRev(rel) = `git show <rev>:<rel>` (undefined on non-zero exit), then `declaredVersionOf` (plugin.json first, then the manifest).
   - base none AND head none -> `note`: `<name> declares no version, so Claude Code serves it by commit and every change already reaches people. Declare a version to opt in to version-based updates.`
   - base has v, head none -> error (removing a version fails): `<name>: its version (<v>) was removed. Claude Code and DorkOS only deliver a change to people when the version goes up.`
   - base none, head has -> pass (opting in).
   - both -> must be valid semver on both sides and head strictly greater. Not bumped: `<name> changed but its version stayed <v>. Claude Code and DorkOS only deliver a change to people when the version goes up.` Went down: `<name>: its version went down from <b> to <h>. Claude Code and DorkOS only deliver a change to people when the version goes up.` Not semver: `<name>: version "<x>" is not semver, so the bump can't be checked.`
     Every message that fails must carry the one-sentence reason "Claude Code and DorkOS only deliver a change to people when the version goes up."
4. No exemption for docs-only changes: a README or docs/ edit inside a package ships in the install and still needs a bump.
   Semver: tools/schema-check has no semver dependency. Add `semver` (+ `@types/semver` dev) to tools/schema-check/package.json and refresh package-lock.json with `npm install`; use `semver.valid` and `semver.gt`.

TESTS: new tools/schema-check/tests/bump.test.ts against REAL temporary git repos (mkdtempSync; `git init -b main`; commit with `-c user.name=t -c user.email=t@t`; write a minimal marketplace.json listing each plugin with `"source": "./plugins/<dir>"`; commit base, commit head; call checkVersionBumps(root, baseSha, headSha)). No network. Each with a purpose comment:

- a package changed without a bump fails, and the message carries the one-sentence reason;
- a bump (0.1.0 -> 0.1.1) passes;
- a new package passes; a deleted package passes;
- a package that declares no version at base and head is exempt (a `note`, no error);
- removing the version fails;
- a docs-only change (plugins/x/docs/guide.md) still needs a bump;
- a moved directory (plugins/a -> plugins/a-moved, entry `a` re-pointed) is matched through its marketplace.json entry: reported once, fails without a bump, passes with one;
- a renamed entry (name a -> b) is a new package plus a deleted one and passes;
- a version going down fails;
- changes outside plugins/ (tools/, .github/) are ignored.

VERIFY: `cd tools/schema-check && npm test && npm run typecheck && npm run format:check`, plus a manual smoke on the real repo: `npm run check:bump -- HEAD~1 HEAD` on a scratch commit that edits plugins/code-reviewer/README.md must fail (discard the scratch commit afterwards; never git stash).

### Task 1.4: Run both checks in the schemas workflow and point REVIEW.md and CLAUDE.md at them

**Size:** small · **Priority:** high · **Depends on:** 1.3 · **Parallel with:** 2.1, 2.2, 2.3, 2.11

Repo: /Users/doriancollier/Keep/dork-os/marketplace. Final task of the Phase 1 PR; open the PR after this (one PR for 1.1-1.4).

WORKFLOW .github/workflows/schema-check.yml (verified current content: triggers `pull_request` and `push: branches: [main]`; `permissions: contents: read`; concurrency group `${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`; one job `schemas` named `skills and manifests`, `defaults.run.working-directory: tools/schema-check`; steps checkout@v5, setup-node@v5 (node 22, npm cache), `npm ci`, `npm run check`, `npm test`, `npm run typecheck`, `npm run format:check`).

1. `actions/checkout@v5` gains `with: { fetch-depth: 0 }` so the merge base exists for the bump check.
2. concurrency: `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. Rewrite the comment above it: a new push to a PR branch makes the old run obsolete, but a push to main compares `before..after` and must never be cancelled by a quick second merge, or the first merge's comparison is lost.
3. New step right after "Skills and manifests match the pinned DorkOS schemas":

```yaml
- name: Every changed package raised its version
  env:
    BASE: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
    HEAD: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.event.after }}
  run: npm run check:bump -- "$BASE" "$HEAD"
```

(values go through env, never interpolated into the script body). The push run on main catches two PRs that each bumped to the same version and merged in sequence. 4. Do NOT rename the job or its `name: skills and manifests`: that string is the status-check context, and renaming it would orphan a required check if one is configured. Making the two new checks required in the repository ruleset is the operator's call (spec Open Question 5; recommendation: yes, once green on main, plus "require branches to be up to date") — mention it in the PR body, don't change settings. 5. Update the workflow's header comment to say it also checks version agreement and bump-on-change. The job still needs no secrets and runs on the default read-only token.

REVIEW.md:87-88 (currently: "- A package version bump in `plugin.json` matches `package.json` and the sidecar\n where both carry one."): replace with a bullet saying version agreement and bump-on-change are enforced by `tools/schema-check` (`npm run check` and `npm run check:bump`, run by the `schemas` workflow), so a reviewer does not re-check them by hand.

CLAUDE.md "CI" section (lines 85-97, "two workflows, both on every pull request"): extend the `schema-check.yml (schemas)` bullet: it also fails when a package's `.dork/manifest.json`, `.claude-plugin/plugin.json` and root `package.json` versions disagree (or the manifest has a version and plugin.json has none), and, on every PR and every push to main, when a package's files changed without its declared version going up (a package that declares no version is exempt; declaring one opts in). Note it now runs on push to main too.

ACCEPTANCE

- `actionlint` (if installed) or careful review of the YAML; the PR's `schemas` job is green (the PR bumps flow 0.7.2 -> 0.7.3; tools/ and .github/ are not packages).
- PR body: what changed, why, the landing order (this PR first, then the dorkos PR), the required-check recommendation, and the agent provenance line from the dorkos AGENTS.md rule.

## Phase 2: dorkos: version truth in the app

### Task 2.1: Add the version primitives to @dorkos/marketplace and move isRealCommitSha there

**Size:** medium · **Priority:** high · **Depends on:** none · **Parallel with:** 1.1, 1.2, 1.3, 1.4, 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth (branch spec/marketplace-version-truth). All Phase 2 tasks land as ONE dorkos PR, merged only after the Phase 1 marketplace PR. Rules: TSDoc on every export (lint error otherwise), tests in `__tests__/`, `pnpm vitest run <path>` for single files, `pnpm --filter @dorkos/marketplace typecheck|lint`. After changing @dorkos/marketplace, the server resolves it through dist at runtime: `pnpm --filter @dorkos/marketplace build` before running server tests.

WHY: DorkOS must resolve a package's version the way Claude Code does: (1) plugin.json `version`, which wins silently over the entry; (2) else the marketplace entry's `version`; (3) else, for git sources, the resolved commit SHA (for archives, the sha256 — no archive source is installed today). Every reader (validation, install, the installed list, the update check) uses these functions; none reimplements them.

PLACEMENT (packages/marketplace/src/index.ts is a BROWSER-SAFE barrel — its header says Node-only modules are imported by subpath):

- New browser-safe module packages/marketplace/src/package-version.ts, exported from index.ts:

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

resolvePackageVersion: declaredVersion -> {version, source:'package'}; else entryVersion -> 'index'; else commitSha only when isRealCommitSha(commitSha) -> 'commit'; else undefined. Treat empty strings as absent.
isRealCommitSha: false for undefined, `'local'`, the relative-path sentinel `'relative-path'`, and `/^tmp-\d+$/`; true otherwise. Move the sentinel constant with it: add `export const RELATIVE_PATH_SENTINEL_SHA = 'relative-path';` to package-version.ts (or constants.ts, also exported from the barrel).

- readDeclaredVersion is Node-only (reads files) -> add it to packages/marketplace/src/package-validator.ts (subpath `@dorkos/marketplace/package-validator`), exported:

```ts
/**
 * The version a package tree states about itself: `plugin.json`'s `version`
 * when that file declares one, else `.dork/manifest.json`'s. Reads the two
 * files directly and NEVER gates on validity, so an install whose files
 * disagree (or that fails validation for any other reason) still has a
 * readable version. `undefined` when neither file declares one. Never throws.
 */
export async function readDeclaredVersion(packagePath: string): Promise<string | undefined>;
```

Read `path.join(packagePath, CLAUDE_PLUGIN_MANIFEST_PATH)` ('.claude-plugin/plugin.json') and `PACKAGE_MANIFEST_PATH` ('.dork/manifest.json') from ./constants.js; a missing file, unparseable JSON, non-object, or non-string/empty `version` counts as "declares none". Wrap everything so it never throws.

MOVE isRealCommitSha OUT OF THE SERVER (no duplicate left behind):

- apps/server/src/services/marketplace/marketplace-installer.ts: delete `realCommitSha` (:857-876, including its TSDoc) and the import of RELATIVE_PATH_SENTINEL_SHA at :56; at :659 and :672 replace `realCommitSha(fetched.commitSha)` with `isRealCommitSha(fetched.commitSha) ? fetched.commitSha : undefined`, importing isRealCommitSha from '@dorkos/marketplace' (the file already imports isSafeGitUrl from there at :27-32). Keep the DOR-147 "never fabricate" explanation as a comment at the call site or on the new function's TSDoc.
- apps/server/src/services/marketplace/source-resolvers/relative-path.ts:19-20: stop defining the constant; `export { RELATIVE_PATH_SENTINEL_SHA } from '@dorkos/marketplace';` is NOT allowed as a lingering re-export shim unless something still imports it from here — grep (`grep -rn RELATIVE_PATH_SENTINEL_SHA apps packages`) and point every importer at '@dorkos/marketplace' instead, then import it in relative-path.ts:47 from '@dorkos/marketplace'.

TESTS (packages/marketplace/src/**tests**/package-version.test.ts, and readDeclaredVersion cases in packages/marketplace/src/**tests**/package-validator.test.ts using its tempDir helper at :55-59). Purpose comment on each; each can fail:

- resolvePackageVersion: declared -> 'package'; entry only -> 'index'; declared beats entry; commit only -> 'commit' with the full SHA; a placeholder commit (`tmp-123`) alone -> undefined; all absent -> undefined.
- isRealCommitSha: rejects undefined, `tmp-1737000000000`, `local`, `relative-path`; accepts a 40-hex SHA.
- readDeclaredVersion: plugin.json over the manifest when both present and when they DISAGREE (manifest 0.6.0, plugin.json 0.7.2 -> 0.7.2); plugin.json without `version` falls through to the manifest; only the manifest; neither file -> undefined; an unparseable plugin.json falls through to the manifest and never throws; both unparseable -> undefined.
- Existing installer provenance tests (apps/server/src/services/marketplace/**tests**/marketplace-installer.test.ts, describe 'install() provenance (DOR-147)' at :894) still pass unchanged.

VERIFY: `pnpm vitest run packages/marketplace/src/__tests__/package-version.test.ts packages/marketplace/src/__tests__/package-validator.test.ts apps/server/src/services/marketplace/__tests__/marketplace-installer.test.ts`; `pnpm --filter @dorkos/marketplace typecheck && pnpm --filter @dorkos/marketplace lint && pnpm --filter @dorkos/server typecheck`.

### Task 2.2: Fail validation when manifest and plugin.json versions disagree, and expose declaredVersion

**Size:** medium · **Priority:** high · **Depends on:** 2.1 · **Parallel with:** 1.3, 1.4, 2.3, 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. File: packages/marketplace/src/package-validator.ts (same file as 2.1's readDeclaredVersion, so after 2.1).

CURRENT CODE (verified)

- `ValidatePackageResult` at :59-72 = { ok, issues, manifest? }.
- validatePackage (:139-269): step 1 reads `.dork/manifest.json`, else synthesizes from plugin.json via `synthesizeFromCcManifest` (:630-659, which writes `version: cc.version ?? '0.0.0'` at :651). Early returns `{ ok: false, issues }` at the MANIFEST_INVALID_JSON, MANIFEST_MISSING and MANIFEST_SCHEMA_INVALID branches. Step 4 (plugin.json presence, only when `requiresClaudePlugin(manifest.type)`) at :219-232. Final return at :268 `{ ok: !hasErrors, issues, manifest }` — note the manifest IS returned even when errors exist.

CHANGE 1: `declaredVersion` on EVERY result, ok or not.
Add to ValidatePackageResult (with TSDoc):

```ts
  /**
   * The version the package declares about itself, from {@link readDeclaredVersion}:
   * plugin.json's `version`, else the manifest's. Present on every result,
   * `ok` or not. `undefined` when neither file declares one — a Claude-Code-only
   * package with no `version` is NOT reported as `'0.0.0'`, even though the
   * synthesized manifest still carries `'0.0.0'` because the schema requires one.
   */
  declaredVersion?: string;
```

Compute it once at the top (`const declaredVersion = await readDeclaredVersion(packagePath)`) and include it in every return, the early `{ ok: false, issues }` returns included. `synthesizeFromCcManifest` keeps writing `'0.0.0'` into the synthesized manifest.

CHANGE 2: VERSION_MISMATCH check, right after step 4, only when BOTH `.dork/manifest.json` and `.claude-plugin/plugin.json` exist (i.e. manifestSource === PACKAGE_MANIFEST_PATH and plugin.json is present), for every package type:

- Read plugin.json raw. If it cannot be parsed, do nothing here (keep today's behavior; not this check's concern).
- Let m = manifest.version (schema-validated semver), p = plugin.json `version` (string or absent).
- p present and p !== m -> error:

```ts
{
  level: 'error',
  code: 'VERSION_MISMATCH',
  message:
    `.dork/manifest.json says version ${m} but .claude-plugin/plugin.json says ${p}. ` +
    `Set both to the same version: Claude Code loads ${p}, DorkOS would report ${m}.`,
  path: CLAUDE_PLUGIN_MANIFEST_PATH,
}
```

- p absent -> error:

```ts
{
  level: 'error',
  code: 'VERSION_MISMATCH',
  message:
    `.dork/manifest.json says version ${m} but .claude-plugin/plugin.json has no version. ` +
    `Add "version": "${m}" to plugin.json so Claude Code and DorkOS agree.`,
  path: CLAUDE_PLUGIN_MANIFEST_PATH,
}
```

- package.json is NOT checked (DorkOS doesn't interpret it; dork-labs/marketplace enforces it as repo policy).
  Update the validatePackage TSDoc step list (:124-136) to include the new step. This is an error wherever validation gates something: `dorkos package validate` (packages/cli/src/package-validate-command.ts:40), install (`resolveAndValidate`, marketplace-installer.ts:605-630) and the update check's staging of a NEW version. It must never gate an installed tree — the installed-side readers use readDeclaredVersion and the scanner (task 2.6), not `ok`.

FIXTURE SWEEP: a repo-wide scan (2026-09-23) found no on-disk fixture with a manifest and a disagreeing or version-less plugin.json. Inline test fixtures may still write a plugin.json with no `version` beside a manifest: run the suites listed under VERIFY and fix any fixture that now trips VERSION_MISMATCH by giving its plugin.json the manifest's version (never by weakening the check). The scaffolder already writes '0.0.1' to both (packages/marketplace/src/scaffolder.ts:104, :138) — confirm with its test.

TESTS (packages/marketplace/src/**tests**/package-validator.test.ts; purpose comment each):

- manifest 0.6.0 + plugin.json 0.7.2 -> ok:false with one VERSION_MISMATCH carrying the first message text exactly;
- manifest 1.0.0 + plugin.json with no version -> VERSION_MISMATCH with the second message text;
- agreeing files -> no VERSION_MISMATCH;
- a manifest-only agent package (type 'agent', no plugin.json) -> no VERSION_MISMATCH;
- an unparseable plugin.json beside a manifest -> no VERSION_MISMATCH (today's behavior kept);
- `declaredVersion` is present on an ok:false result (e.g. the mismatch case -> '0.7.2', and a MANIFEST_SCHEMA_INVALID case);
- a Claude-Code-only package whose plugin.json has no `version` -> ok, `manifest.version === '0.0.0'`, `declaredVersion === undefined`; and one whose plugin.json says "0.0.0" -> `declaredVersion === '0.0.0'`.

VERIFY: `pnpm --filter @dorkos/marketplace build`, then `pnpm vitest run packages/marketplace` and `pnpm vitest run apps/server/src/services/marketplace packages/cli/src/__tests__/package-validate.test.ts packages/cli/src/__tests__/package-init.test.ts`; `pnpm --filter @dorkos/marketplace typecheck && pnpm --filter @dorkos/marketplace lint`.

### Task 2.3: Add sourceKeyOf as the one clone-URL/ref normalizer and make the resolvers use it

**Size:** medium · **Priority:** high · **Depends on:** 2.1 · **Parallel with:** 1.3, 1.4, 2.2, 2.6, 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth.

WHY: The commit short-circuit (task 2.5) is only sound if the commit recorded at install and the commit looked up later were read from the SAME place. Today three server resolvers default the ref to 'main' independently (apps/server/src/services/marketplace/source-resolvers/git-subdir.ts:67, github.ts:28, url.ts:27 — each `const ref = resolved.sha ?? resolved.ref ?? 'main'`), while `PackageFetcher.resolveCommitSha` defaults an absent ref to 'HEAD' (package-fetcher.ts:595). The github form's clone URL (`https://github.com/${repo}.git`) is built in packages/marketplace/src/source-resolver.ts:93 by resolvePluginSource; github.ts only reads it. (The `github:user/repo` shorthand in package-resolver.ts:342-352 builds a url-form source WITHOUT `.git`; that is a different source form and keeps its own URL.)

ADD to packages/marketplace/src/source-resolver.ts (browser-safe, pure) and export both from packages/marketplace/src/index.ts next to resolvePluginSource (:64-65):

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

Mapping over `ResolvedSourceDescriptor` (source-resolver.ts:23-28):

- 'github' -> { cloneUrl: source.cloneUrl, subpath: '', ref: source.sha ?? source.ref ?? 'main' }
- 'url' -> { cloneUrl: source.url, subpath: '', ref: same rule }
- 'git-subdir' -> { cloneUrl: source.cloneUrl, subpath: source.subpath, ref: same rule }
- 'relative-path', 'npm' -> undefined
  Define the default once (e.g. `const DEFAULT_REF = 'main'`) and nowhere else.

MAKE THE RESOLVERS USE IT (they take cloneUrl and ref from the key, never recompute):

- git-subdir.ts:67 `const ref = ...` -> `const key = sourceKeyOf(resolved)!` (non-null is guaranteed for this variant; prefer a small assert helper that throws a clear Error rather than a bare `!`), then use key.cloneUrl / key.ref for `deps.resolveCommitSha(key.cloneUrl, key.ref)` and pass `key.ref` to cloneSubdirWithFallback. The `assertSafeGitRemote(resolved.cloneUrl)` check at the top stays.
- github.ts:28-33 and url.ts:27-32: `cloneRepository({ cloneUrl: key.cloneUrl, ref: key.ref, ... })`.
- Update each file's TSDoc "Pin precedence: sha > ref > 'main'" to say the key owns it.

TESTS

- packages/marketplace/src/**tests**/source-resolver.test.ts: sourceKeyOf for each variant; github gets the `.git` URL from resolvePluginSource and ref 'main' when neither ref nor sha is set; sha beats ref; relative-path and npm -> undefined.
- apps/server/src/services/marketplace/source-resolvers/**tests**/{git-subdir,github,url}.test.ts: the ref/cloneUrl each resolver hands to its dep equal `sourceKeyOf(descriptor)` for the same descriptor (the "same descriptor yields the same key in the resolver and in resolveLatest" property; resolveLatest's side is tested in 2.5).

VERIFY: `pnpm --filter @dorkos/marketplace build`; `pnpm vitest run packages/marketplace/src/__tests__/source-resolver.test.ts apps/server/src/services/marketplace/source-resolvers`; `pnpm --filter @dorkos/marketplace typecheck && pnpm --filter @dorkos/server typecheck && pnpm --filter @dorkos/server lint`.

### Task 2.4: Record entryVersion and sourceKey at install, and the resolved version in the sidecar

**Size:** medium · **Priority:** high · **Depends on:** 2.2, 2.3 · **Parallel with:** 1.3, 1.4, 2.6, 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. Touches apps/server/src/services/marketplace/{package-resolver.ts, installed-metadata.ts, marketplace-installer.ts}. marketplace-installer.ts is also edited by 2.1 and 2.5 — strictly sequential with them.

1. ResolvedPackageSource gains the entry's version (package-resolver.ts:35-79):

```ts
  /** The marketplace entry's own `version`, when the entry sets one (Claude Code's step 2). */
  entryVersion?: string;
```

Set it where the resolver reads the entry: `resolveExplicitMarketplace` return at :220-228 (`entryVersion: entry.version`) and `resolveBareName` return at :279-287 (`entryVersion: hit.entry.version`). Git/local inputs leave it undefined.

2. InstallMetadata gains two fields (installed-metadata.ts:30-103), with TSDoc:

```ts
  /** The marketplace entry's `version` at install time; absent when the entry set none, and for sidecars written before this field existed. */
  entryVersion?: string;
  /** Where the package was fetched from, normalized by `sourceKeyOf` (`@dorkos/marketplace`). Absent for local and `file://` installs and for sidecars written before this field existed. */
  sourceKey?: SourceKey;
```

`readInstallMetadata` (:113 onward) parses them defensively like its neighbours: entryVersion only when a string; sourceKey only when an object whose cloneUrl, subpath and ref are all strings, else undefined. Also update the `version` field's TSDoc (:33-34): it records the resolved package version (see 4), not the synthesized manifest's.

3. Staging reports the key. In marketplace-installer.ts `stagePackage` (:638-673) return `{ path, commitSha?, sourceKey? }`: on the modern path compute `sourceKey = sourceKeyOf(resolvePluginSource(source, { marketplaceRoot: resolved.marketplaceRoot, pluginRoot: resolved.pluginRoot }))` from the SAME `source` that `buildFetchableSource` returned (for a file:// relative-path source this is undefined); the local branch and the legacy bare-gitUrl branch record no sourceKey. `resolveAndValidate` (:605-630) passes `sourceKey` through and also returns `declaredVersion: validation.declaredVersion` (from task 2.2).

4. writeInstallMetadata call in `install()` (marketplace-installer.ts:337-369; the function itself lives in installed-metadata.ts): add `entryVersion: resolved.entryVersion` and `sourceKey: staged.sourceKey` (both only when defined), and set `version` to
   `const v = resolvePackageVersion({ declaredVersion: staged.declaredVersion, entryVersion: resolved.entryVersion }); version: v?.version ?? result.version`
   i.e. the resolved version whenever the source is 'package' or 'index', instead of the synthesized manifest's '0.0.0'. (No commitSha is passed here on purpose: the sidecar's `version` stays a version string; the commit is its own field.)

TESTS (apps/server/src/services/marketplace/**tests**/):

- package-resolver.test.ts: bare-name and explicit-marketplace resolutions carry `entryVersion` when the entry sets `version`, and none when it doesn't.
- installed-metadata.test.ts: round-trips entryVersion and sourceKey; a malformed sourceKey (missing ref, non-string cloneUrl) reads back as undefined; an old sidecar without either still reads.
- marketplace-installer.test.ts (describe 'install() provenance (DOR-147)' at :894): a git-subdir install from a remote marketplace records sourceKey { cloneUrl: <marketplace url>, subpath: 'plugins/x', ref: 'main' } and entryVersion; a Claude-Code-only package whose plugin.json says 1.2.0 records version '1.2.0'; one with no plugin.json version but an entry version '3.0.0' records '3.0.0'; a local install records no sourceKey.

VERIFY: `pnpm vitest run apps/server/src/services/marketplace/__tests__/package-resolver.test.ts apps/server/src/services/marketplace/__tests__/installed-metadata.test.ts apps/server/src/services/marketplace/__tests__/marketplace-installer.test.ts apps/server/src/services/marketplace/__tests__/integration.test.ts`; `pnpm --filter @dorkos/server typecheck && pnpm --filter @dorkos/server lint`.

### Task 2.5: Add PackageFetcher.lookupCommitSha and MarketplaceInstaller.resolveLatest

**Size:** large · **Priority:** high · **Depends on:** 2.4 · **Parallel with:** 1.3, 1.4, 2.6, 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. Files: apps/server/src/services/marketplace/package-fetcher.ts, marketplace-installer.ts (after 2.4, same file).

A. FETCHER. `resolveCommitSha` is private (package-fetcher.ts:587-626): it asserts the address (`assertRemoteAllowed`, refusal PROPAGATES — DOR-1799), runs `git ls-remote --end-of-options <url> <ref ?? 'HEAD'>` with LS_REMOTE_TIMEOUT_MS = 15_000 (:63), and returns `tmp-${Date.now()}` on any lookup failure. Add a public method that callers must give an explicit ref (so nobody reaches the 'HEAD' default by accident):

```ts
  /**
   * Look up the commit `ref` points at in `cloneUrl`, for comparison against an
   * installed commit. Same rules as the fetch path: a refused address throws
   * `UnsupportedSourceUrlError`; a failed lookup returns a `tmp-<ms>` placeholder
   * (test with `isRealCommitSha`), never a real-looking SHA.
   */
  async lookupCommitSha(cloneUrl: string, ref: string): Promise<string> {
    return this.resolveCommitSha(cloneUrl, ref);
  }
```

B. INSTALLER. Add to marketplace-installer.ts (exported types with TSDoc) and to the `InstallerLike` interface at :204-208:

```ts
/** Looks up the commit a ref points at. Throws on a refused address; may return a placeholder. */
export type CommitLookup = (cloneUrl: string, ref: string) => Promise<string>;

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

(The spec names `CommitLookup` without defining it; the shape above is the one the UpdateFlow memo in 2.7 implements.)

Steps, reusing resolveAndValidate's pipeline pieces (`this.deps.resolver.resolve(buildResolverInput(req))`, `buildFetchableSource` :699-732, `stagePackage` :638-673, `validatePackage`):

1. Resolve -> ResolvedPackageSource (now carrying entryVersion from 2.4). DIRECT INSTALL with a recorded key (`req.source` set, no `req.marketplace`, `opts.installed.sourceKey` present): skip the resolver's URL parsing and build the fetchable source from the key, because `name@url` has no ref syntax: subpath '' -> `{ source: 'url', url: key.cloneUrl, ref: key.ref }`, else `{ source: 'git-subdir', url: key.cloneUrl, path: key.subpath, ref: key.ref }` (resolved = { kind: 'git', packageName: req.name, pluginSource: that }). Then `buildFetchableSource(resolved)` -> concrete PluginSource -> `sourceKeyOf(resolvePluginSource(source, { marketplaceRoot, pluginRoot }))`.
2. SHORT-CIRCUIT. Only when ALL THREE match the install: (a) key and opts.installed.sourceKey both present and equal field by field (cloneUrl, subpath, ref); (b) resolved.entryVersion === opts.installed.entryVersion (both undefined counts as equal); (c) the commit: if isRealCommitSha(opts.installed.commitSha), `const looked = await opts.commitLookup(key.cloneUrl, key.ref)`; if !isRealCommitSha(looked) -> return `{ kind: 'unresolved', reason: "couldn't reach " + hostOf(key.cloneUrl) }`; if looked === installed.commitSha -> return `{ kind: 'unchanged' }` — no staging, no clone. A missing installed sourceKey (sidecars written before this change) never short-circuits. hostOf: `new URL(url).host`, or the host of an scp-style `git@host:owner/repo`, else the URL itself.
3. Otherwise stage through the existing `stagePackage(resolved, req)` (cached as `<name>@<sha>`, the same fetch an install does). `resolved.commitSha` in the result is the commit STAGING reports (already filtered by isRealCommitSha), not the lookup's, so a push between the two is reported as what an install would actually fetch.
4. `validatePackage(staged.path)`; on `!ok` return `{ kind: 'unresolved', reason: "the new version can't be installed: " + <error-level messages joined with '; '> }`. A version DorkOS would refuse to install is never offered. On success return `{ kind: 'resolved', declaredVersion: validation.declaredVersion, entryVersion: resolved.entryVersion, commitSha: staged.commitSha, sourceKey: key }`.
5. A local `file://` source has no key and no commit: stage in place and ALWAYS validate (costs nothing remote).
6. ERRORS NEVER ESCAPE: wrap the whole method; any thrown resolver/fetch/stage error, including a refused address (UnsupportedSourceUrlError, DOR-1799), returns `{ kind: 'unresolved', reason: err.message }`.
   `preview` and `install` are untouched and keep calling resolveAndValidate. resolveLatest runs no package code: stage + validate only, exactly as preview does.

KNOWN LIMIT (inherited, filed as DOR-2248; do not fix here): the SHA-keyed cache can hold a different tree than its key names (git-subdir clones the default branch at --depth=1 then checks out the ref, git-subdir.ts:186-201; github/url sources ignore the ref, template-downloader.ts:614-620; a push between lookup and clone lands under the looked-up key). Leave a one-line comment pointing at DOR-2248.

TESTS (apps/server/src/services/marketplace/**tests**/marketplace-installer.test.ts, new describe('resolveLatest()'); commit lookup and staging injected via the installer's existing deps seams — mock `fetcher.fetchPackage`, pass a vi.fn() commitLookup; no network):

- same key + same entryVersion + same commit -> 'unchanged' and fetchPackage NOT called (spy on staging);
- entry version changed, commit same -> stages (no short-circuit);
- sourceKey changed (different ref) -> stages;
- installed sidecar has no sourceKey -> stages;
- lookup returns `tmp-123` -> unresolved "couldn't reach github.com";
- staged tree fails validation (VERSION_MISMATCH fixture) -> unresolved starting "the new version can't be installed: " and containing the validator's message;
- resolver throws / UnsupportedSourceUrlError -> unresolved with that message, nothing thrown;
- resolved.commitSha is staging's commit when it differs from the lookup's;
- a direct install with a recorded non-default ref (sourceKey.ref 'release') stages with that ref, not 'main';
- a file:// marketplace package always stages and validates, and commitLookup is never called;
- the key resolveLatest computes for a remote relative-path entry equals the one recorded at install (2.4) for the same entry.
- package-fetcher.test.ts: lookupCommitSha forwards the explicit ref to ls-remote and propagates a refused address.

VERIFY: `pnpm vitest run apps/server/src/services/marketplace/__tests__/marketplace-installer.test.ts apps/server/src/services/marketplace/__tests__/package-fetcher.test.ts`; `pnpm --filter @dorkos/server typecheck && pnpm --filter @dorkos/server lint`.

### Task 2.6: Export one total installed-identity reader from the scanner that reports the declared version

**Size:** small · **Priority:** high · **Depends on:** 2.1, 2.2 · **Parallel with:** 2.3, 2.4, 2.5, 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. File: apps/server/src/services/marketplace/installed-scanner.ts. (The spec orders this after UpdateFlow, but UpdateFlow (2.7) imports the reader this task exports, so it lands first.)

CURRENT CODE (verified)

- `readInstalledPackage` (:334) calls private `readManifestSummary` (:357-407): reads `.dork/manifest.json`; missing -> `validatedSummary` (Claude-Code-only packages, DOR-264); shallow parse of name/version/type succeeds -> returns manifest version (:385-401); shallow rejects -> `validatedSummary`.
- `validatedSummary` (:420-445) returns null when `!validated.ok || !validated.manifest` — it GATES ON VALIDITY. Correction to the spec's claim that the scanner never calls the validator's gate: this path does, for every Claude-Code-only install and every manifest the shallow parse rejects. After 2.2 a VERSION_MISMATCH would hide such an install. The installed side must never gate on `ok`.
- `InstalledPackage.version` TSDoc (:42-43) says "from .dork/manifest.json".

CHANGE

1. Rename `readManifestSummary` -> exported `readInstalledIdentity(installRoot: string): Promise<InstalledIdentity | null>` with TSDoc, where

```ts
/** A package's identity as read off disk, never gated on validity. */
export type InstalledIdentity = Omit<InstalledPackage, 'installedFrom' | 'installedAt'> & {
  /** From `readDeclaredVersion`: plugin.json's version, else the manifest's; undefined when neither declares one. */
  declaredVersion?: string;
};
```

It is TOTAL: wrap the body so any throw returns null (it sits on the path of GET /api/marketplace/installed and the update check). 2. `version` = `(await readDeclaredVersion(installRoot)) ?? <manifest or synthesized version>` so the Installed view shows what the update check compares and what Claude Code runs: a flow with manifest 0.6.0 and plugin.json 0.7.2 lists as 0.7.2. (A Claude-Code-only package that declares a version already listed that version via the synthesized manifest; the fix there is that `declaredVersion` is undefined, not '0.0.0', when it declares none.) 3. `validatedSummary` uses `validated.manifest` whenever it is present, regardless of `ok` (validatePackage returns the manifest even with errors, package-validator.ts:268). It still returns null when there is no manifest at all (e.g. plugin.json missing a name). An install that fails today's rules stays listed, updatable and uninstallable. 4. Update `readInstalledPackage` to call the new name; update the `version` TSDoc on InstalledPackage (:42-43). 5. If an existing test expects an invalid-but-parseable install to be hidden, change it only with a purpose comment explaining why visibility is now intended.

TESTS (apps/server/src/services/marketplace/**tests**/installed-scanner.test.ts; the CC-native case is at :294):

- a tree with manifest 0.6.0 and plugin.json 0.7.2 is listed, with version '0.7.2';
- the same tree whose manifest the shallow parse rejects (e.g. `type` missing but valid otherwise per the validator) still lists (no `ok` gate);
- a Claude-Code-only package: listed version equals its plugin.json version; readInstalledIdentity returns declaredVersion undefined when plugin.json has no version;
- readInstalledIdentity never throws on an unreadable directory (returns null).

VERIFY: `pnpm vitest run apps/server/src/services/marketplace/__tests__/installed-scanner.test.ts apps/server/src/routes/__tests__/marketplace.test.ts`; `pnpm --filter @dorkos/server typecheck && pnpm --filter @dorkos/server lint`.

### Task 2.7: Rewrite UpdateFlow on resolveLatest with an honest three-state result, and mirror the new fields

**Size:** xl · **Priority:** high · **Depends on:** 2.5, 2.6 · **Parallel with:** 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. Files: apps/server/src/services/marketplace/flows/update.ts (393 lines today), apps/server/src/services/marketplace/**tests**/flows/update.test.ts (note: the spec cites `flows/update.test.ts`; the file is under `__tests__/flows/`), packages/shared/src/marketplace-schemas.ts, apps/server/src/services/core/openapi-registry.ts, apps/server/src/index.ts (wiring at :4032-4038).

TODAY (verified): `checkOne` computes `latest = match.entry.version ?? pkg.version` (update.ts:283) — the entry version is unset on all 15 dork-labs/marketplace entries, so latest always equals installed; `readInstalledManifest` (:381-393) reads only `.dork/manifest.json`, hiding the 8 Claude-Code-only packages; `checkOne` returns null (dropped) when no source lists the package (:276-282) and `fetchAndFindEntry` swallows fetch errors (:335-341); `filterInstalled` throws PackageNotInstalledForUpdateError (:181-191); the walk covers dorkHome and the request's projectPath only (:225-228).

1. ONE IDENTITY READER. Delete `readInstalledManifest` (:376-393). `listInstalled` reads each install through `readInstalledIdentity(installPath)` from '../installed-scanner.js' (task 2.6; total, never gates on validity). Keep the backup-dir skip (:238), the PackageNameSchema name fallback (:243-250) and the installKey dedupe. Internal InstalledPackage gains `declaredVersion?: string` and `metadata: InstallMetadata | null` (from readInstallMetadata).

2. DEPS. `InstallerLike` here (:37-44) gains `resolveLatest(req: InstallRequest, opts: { installed: { commitSha?: string; entryVersion?: string; sourceKey?: SourceKey }; commitLookup: CommitLookup }): Promise<LatestResolution>` (types from ../marketplace-installer.js — type-only import, no cycle). `UpdateFetcherLike` (:60-62) gains `lookupCommitSha(cloneUrl: string, ref: string): Promise<string>`. `UpdateFlowDeps` gains `now?: () => number` (default Date.now) for TTL tests. index.ts:4032 already passes the concrete installer and fetcher, which satisfy the widened interfaces.

3. THE RESULT (update.ts:65-71 and every mirror). Additive:

```ts
export interface UpdateCheckResult {
  packageName: string;
  installedVersion: string;
  /** `''` when `status === 'unknown'`. */
  latestVersion: string;
  /** Always `status === 'update-available'`. */
  hasUpdate: boolean;
  marketplace: string;
  status: 'current' | 'update-available' | 'unknown';
  installedVersionSource?: VersionSource;
  latestVersionSource?: VersionSource;
  note?: string;
}
```

A commit-identified version is reported as the FULL SHA with source 'commit' (surfaces shorten it). Mirrors to update in the same task:

- packages/shared/src/marketplace-schemas.ts:523-534 (`UpdateCheckResult`; define `VersionSource` there or import the type from @dorkos/marketplace if shared already depends on it — check packages/shared/package.json; otherwise declare the literal union with a comment naming its twin);
- apps/server/src/services/core/openapi-registry.ts:392-399 (`LocalUpdateCheckResultSchema`: add `status: z.enum(['current','update-available','unknown'])`, `installedVersionSource`/`latestVersionSource: z.enum(['package','index','commit']).optional()`, `note: z.string().optional()`);
- the CLI's local mirror is updated in 2.9; apps/client/src/layers/shared/lib/embedded-mode-stubs.ts:891 only throws and imports UpdateResult from shared — nothing to mirror there (spec lists it as a copy; it is not), just confirm it typechecks.

4. WHICH MARKETPLACE. `findMarketplaceEntry` keeps its order: installedFrom if enabled, then every enabled source. The MATCHED source's name is what resolveLatest receives as `req.marketplace`, never installedFrom blindly (avoids AmbiguousPackageError on bare-name resolution when two sources list the package, package-resolver.ts:271-276, and a disabled source being used anyway, :203-208). A DIRECT install (no installedFrom, metadata.sourceRepo present — `name@url`, `github:`) skips the marketplace search: `req = { name, source: metadata.sourceKey?.cloneUrl ?? metadata.sourceRepo }` and resolveLatest rebuilds it from the recorded sourceKey. A direct install from before sourceKey existed falls back to sourceRepo at the default ref and sets a note, proposed wording: "checked against the default branch: this package was installed before DorkOS recorded which branch it came from". A package with neither installedFrom nor sourceRepo (local-directory installs, pre-DOR-147 sidecars) searches enabled sources as today.

5. MEMOS on the UpdateFlow INSTANCE (one per server, index.ts:4032), TTL `UPDATE_MEMO_TTL_MS = 60_000`: the commit lookup per (cloneUrl, ref) and the index fetch (`fetchMarketplaceJson`) per source name. The CLI makes one request per package, so a per-run() memo would never span packages. Rules:
   - store the IN-FLIGHT PROMISE, so concurrent requests (CLI and app together) share one ls-remote;
   - never keep a failure or a placeholder: on rejection, or when the value fails isRealCommitSha, delete the entry so a retry looks again;
   - a ref that is a full 40-hex SHA (`/^[0-9a-f]{40}$/i`) IS the commit: the memoized lookup returns it WITHOUT calling fetcher.lookupCommitSha (ls-remote matches ref names only and would report a pinned package unreachable);
   - public `clearMemos(): void` (TSDoc), called at the end of every `run()` with `apply: true`, and by the marketplace refresh route (task 2.8);
   - honest claim for TSDoc/docs: "shared within one CLI run or UI burst"; without a refresh, a push made within the last 60 seconds can still read as current.
     The memoized lookup is the `commitLookup` passed to resolveLatest.

6. THE INSTALLED SIDE: `installed = resolvePackageVersion({ declaredVersion: pkg.declaredVersion, entryVersion: metadata?.entryVersion, commitSha: isRealCommitSha(metadata?.commitSha) ? metadata.commitSha : undefined })`; pass `{ commitSha (real only), entryVersion, sourceKey }` from the sidecar to resolveLatest.

7. THE COMPARISON — private `compareVersions(installed, latest)`, in order:
   1. `unchanged` -> current (latestVersion = installedVersion, same source).
   2. `unresolved` -> unknown, note = the reason.
   3. installed side unknown (no declared version, no entry version, no real commit) -> unknown, note "reinstall this package to enable update checks" (file:// marketplaces, pre-DOR-147 sidecars, placeholder SHAs).
   4. latest identity = resolvePackageVersion(resolved fields); if undefined -> unknown, proposed note "couldn't tell which version the marketplace has".
   5. both sources 'package' or 'index' and both valid semver (semver `valid`, no coerce) -> update when latest > installed strictly (semver gt); equal -> current; LOWER -> current with a rollback note, proposed wording "rollback: the marketplace has <latest>, older than the installed <installed>; a downgrade is never offered as an update".
   6. both versions but at least one not semver -> update when the strings differ.
   7. either source 'commit' -> update when the commits differ (Claude Code does the same for a package that declares no version). Accepted edge: a pre-entryVersion sidecar for an entry-versioned package compares commit with index and reports one spurious update; applying it rewrites the sidecar.
      Delete `isNewerVersion` (:351-358) — its coerce fallback is superseded by rules 5-6.

8. NOTHING IS DROPPED. No enabled source lists the package -> unknown "no enabled marketplace lists this package". A named package not installed in the requested scope -> ONE unknown result `{ packageName: name, installedVersion: '', latestVersion: '', hasUpdate: false, marketplace: '', status: 'unknown', note: 'not installed in this scope' }` instead of throwing (the route decides 404 vs this, task 2.8). Keep exporting PackageNotInstalledForUpdateError (the route throws it). Update the class and run() TSDoc (:130-149).

9. APPLY reinstalls only `update-available` checks; never an `unknown` one. Marketplace installs: `installer.update({ name, marketplace: check.marketplace, projectPath })` as today (:163-167). Direct installs (check.marketplace === ''): `installer.update({ name, source: <cloneUrl or sourceRepo>, projectPath })` — keep the request built in checkOne alongside the check rather than re-deriving it. GAP to flag in the PR (spec is silent): the resolver's `name@url` input has no ref or subpath syntax, so applying a direct install from a non-default ref reinstalls from the default branch; record it as a known limit, don't invent syntax. After the loop call clearMemos().

10. Update the module header (update.ts:1-18) and method TSDoc to describe the new behavior.

TESTS — rewrite **tests**/flows/update.test.ts so the DEFAULT entry has NO `version` (our real marketplace's shape; today every fixture sets one, e.g. :254, :308, :702). buildDeps (:196-240) gains a fake `installer.resolveLatest` (vi.fn) and `fetcher.lookupCommitSha` (vi.fn); memo tests make the fake resolveLatest call `opts.commitLookup(url, ref)`. Each test has a purpose comment and can fail:

- update detected from the package with no entry version (installed 0.7.2, resolved declaredVersion 0.7.3 -> update-available, sources 'package');
- an installed tree with MISMATCHED files (manifest 0.6.0, plugin.json 0.7.2) is listed, reads as 0.7.2, and is checked;
- 'unchanged' -> current, and installer.update is not called on apply;
- Claude-Code-only installs (no manifest) are visible and checked;
- an unreachable source (fetchMarketplaceJson rejects) and a source that lists nothing both give `unknown` with the right note, never a drop;
- resolveLatest 'unresolved' (new version fails validation) -> unknown with the validator's message in `note`;
- a rollback is not offered (installed 1.2.0, latest 1.1.0 -> current + rollback note);
- commit-identified packages compare by commit (full SHA, sources 'commit');
- apply skips `unknown` and `current`; applies `update-available`;
- a direct install resolves through its sourceKey/sourceRepo (resolveLatest receives `source`, no `marketplace`), and a pre-sourceKey direct install carries the default-branch note;
- two enabled sources listing the same name: the matched source name is passed as req.marketplace, and no AmbiguousPackageError;
- a full-SHA ref: the memoized lookup returns it and fetcher.lookupCommitSha is never called;
- the commit lookup is memoized across two run() calls within the TTL (one fetcher call) and repeated after it (advance the injected `now` past 60_000);
- two concurrent run() calls share one in-flight lookup; a rejected lookup is not kept (next run calls again); a placeholder `tmp-1` is not kept; apply and clearMemos() both clear it;
- a named package missing from the scope returns one `unknown` "not installed in this scope" result (rewrites the throw expectations at :441, :565 and :715);
- `hasUpdate === (status === 'update-available')` on every result.

VERIFY: `pnpm --filter @dorkos/shared build`; `pnpm vitest run apps/server/src/services/marketplace/__tests__/flows/update.test.ts`; `pnpm --filter @dorkos/server typecheck && pnpm --filter @dorkos/server lint && pnpm --filter @dorkos/shared typecheck && pnpm --filter @dorkos/client typecheck`.

### Task 2.8: Route: 404 for a name installed nowhere, clear the update memos on refresh, and prove it end to end

**Size:** medium · **Priority:** high · **Depends on:** 2.7 · **Parallel with:** 2.9, 2.10, 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. Files: apps/server/src/routes/marketplace.ts, apps/server/src/routes/**tests**/marketplace.test.ts, apps/server/src/services/marketplace/**tests**/integration.test.ts.

CURRENT CODE (verified): `mapErrorToStatus` at routes/marketplace.ts:186-231 has no case for PackageNotInstalledForUpdateError, so it falls through to a 500 today. The update route is at :846-895 (`POST /packages/:name/update`; parses UpdateRequestBodySchema, `confineProjectPath`, authorizes `marketplace.install` only when `apply` (ADR-0233), calls `updateFlow.run`, fires `onPluginsChanged` per applied result). `UpdateFlow` is imported type-only at :42. `listAgentScopes` is an optional dep (:130); `scanInstallationsAcrossScopes` and `scanInstalledPackages` are already used by GET /installed (:549-567). Refresh route at :522-537 (`POST /sources/:name/refresh`, used by `dorkos marketplace refresh`).

CHANGES

1. Import PackageNotInstalledForUpdateError as a value from '../services/marketplace/flows/update.js' and add to mapErrorToStatus, beside PackageNotInstalledError (:212-214): `if (err instanceof PackageNotInstalledForUpdateError) return { status: 404, body: { error: err.message } };`
2. In the update handler, BEFORE `updateFlow.run`: decide "installed nowhere". UpdateFlow can't tell "not in this scope" from "installed nowhere", so the route does:

```ts
const everywhere = await scanInstallationsAcrossScopes(dorkHome, listAgentScopes?.() ?? []);
const inProject = confined.projectPath
  ? await scanInstalledPackages(dorkHome, confined.projectPath)
  : [];
if (![...everywhere, ...inProject].some((p) => p.name === req.params.name)) {
  throw new PackageNotInstalledForUpdateError(req.params.name);
}
```

(inside the existing try so the mapping applies). A name installed only in another scope reaches run() and comes back as one `unknown` result "not installed in this scope" (task 2.7). Response shape unchanged plus the new fields; authorization unchanged (advisory is a read; apply authorizes as `marketplace.install`). 3. Refresh route: after a successful `fetcher.fetchMarketplaceJson(source)`, call `updateFlow.clearMemos()` so "I just pushed; check again" is answered fresh after a refresh. `updateFlow` is already destructured from deps (:266).

TESTS

- apps/server/src/routes/**tests**/marketplace.test.ts (the FakeUpdateFlow stub at :130-131 gains `clearMemos: vi.fn()`): the route returns 404 with the error message for a name installed in no scope; returns 200 with an `unknown` "not installed in this scope" result for a name installed only under an agent scope when a different projectPath is given; POST /sources/:name/refresh calls updateFlow.clearMemos(); apply still requires marketplace.install.
- INTEGRATION (apps/server/src/services/marketplace/**tests**/integration.test.ts, real installer via installer-harness.ts, a local `file://` marketplace fixture, no network): install a plugin at 1.0.0 whose marketplace entry sets NO version; rewrite the fixture package to 1.1.0 in both `.dork/manifest.json` and `.claude-plugin/plugin.json`, entry version still unset; construct a real UpdateFlow over the real installer/fetcher/source manager; run() reports update-available 1.0.0 -> 1.1.0 (sources 'package'); run({ apply: true }) reinstalls; a rerun reports current (1.1.0). This is the original DOR-2244 repro end to end. Add a second case: the fixture's new version has mismatched files -> the check is `unknown` with the VERSION_MISMATCH message, and the installed 1.0.0 stays listed.

VERIFY: `pnpm vitest run apps/server/src/routes/__tests__/marketplace.test.ts apps/server/src/services/marketplace/__tests__/integration.test.ts`; `pnpm --filter @dorkos/server typecheck && pnpm --filter @dorkos/server lint`.

### Task 2.9: CLI dorkos update: check every scope, isolate failures, and print three honest line kinds

**Size:** medium · **Priority:** high · **Depends on:** 2.7 · **Parallel with:** 2.8, 2.10, 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. Files: packages/cli/src/commands/update.ts (174 lines), packages/cli/src/**tests**/update.test.ts.

TODAY (verified): `runUpdate` (:95-139) builds targets from `listInstalledPackageNames()` (:145-148: GET /api/marketplace/installed with NO projectPath, names only), then sends one POST per name with the command's --project; an agent-scope install therefore throws PackageNotInstalledForUpdateError server-side and the single outer catch exits 1, aborting the run. `renderUpdateChecks` (:155-174) prints "All N package(s) up to date." whenever nothing has hasUpdate. The local mirror `UpdateCheckResult` is at :29-36; `InstalledListBody` at :51-54. `apiCall` throws `ApiError` for an HTTP error status and a plain Error "Cannot reach DorkOS server at <url>: …" when the server is unreachable (packages/cli/src/lib/api-client.ts:300-320).

CHANGES

1. Mirror (:29-36) gains `status: 'current' | 'update-available' | 'unknown'`, `installedVersionSource?`, `latestVersionSource?` ('package' | 'index' | 'commit'), `note?: string`. `InstalledListBody.packages` becomes `{ name: string; agentPath?: string; scope?: string }[]`.
2. NAME-LESS RUNS: targets come from GET /api/marketplace/installed, forwarding `--project` as `?projectPath=<encoded>` when given. Without --project the across-scopes listing includes agent installs; each target is checked with that install's own `agentPath` as `projectPath` (global installs send none), so UpdateFlow walks the same scope the listing found the package in. With --project every target uses args.projectPath. De-duplicate targets on (name, projectPath). A named run keeps one target `{ name, projectPath: args.projectPath }`.
3. PER-TARGET ISOLATION: catch ApiError per target, print `<name>  could not check: <message>` and continue. The single outer catch remains only for failing to reach the server at all (the plain Error from apiCall), which prints `Error: <message>` and returns 1.
4. OUTPUT, one line per check (use `formatVersion(v, source)`: a `commit` source prints `commit <first 7 chars>`):
   - update available: `<name>  <installed> → <latest>  (<marketplace>)` e.g. `flow  0.7.2 → 0.7.3  (dorkos-community)` (omit the parenthesis when marketplace is '');
   - current: `<name>  up to date (<installed>)`;
   - unknown: `<name>  could not check: <note>`.
     Summary counts all three and NEVER says "All N up to date" while any result is unknown. Required example (spec UX): with one update and advisory mode, `1 update available. Run again with --apply to install it.`; with the network off, the line is `flow  could not check: couldn't reach github.com` and the summary says one package could not be checked. Proposed summary grammar: join the non-zero parts of `<u> update(s) available`, `<c> up to date`, `<k> could not be checked`; append ` Run again with --apply to install it/them.` only in advisory mode with u > 0. Delete "All N package(s) up to date." entirely.
     Keep the `Applied:` block (:122-128) for --apply.
5. EXIT CODE: 0 on success; 1 when the server was unreachable OR any requested apply failed (with --apply, a per-target ApiError counts as a failed apply). Unknown results alone exit 0 (a non-zero "stale" exit belongs to DOR-2193's `outdated`).
6. Update the module header (:1-14) and TSDoc.

TESTS (packages/cli/src/**tests**/update.test.ts; it mocks fetch with `mockResponse(status, body)` at :8-15; ADVISORY_RESULT at :17-28 gains `status`):

- the three line kinds, including `commit abc1234` rendering for a commit source;
- a three-way summary, and no "All N up to date" text while any result is unknown;
- per-target error isolation: the second of three targets returns 500, the other two still print and the exit code is 0 in advisory mode;
- a failed apply exits 1;
- agent installs are checked with their own agentPath as projectPath (assert the POST bodies);
- `--project` is forwarded to GET /installed;
- de-duplication on (name, projectPath);
- server unreachable -> exit 1 with the "Cannot reach" message.

VERIFY: `pnpm vitest run packages/cli/src/__tests__/update.test.ts`; `pnpm --filter dorkos typecheck && pnpm --filter dorkos lint` (the CLI package is named `dorkos`).

### Task 2.10: App: say when an update check couldn't run instead of 'already up to date'

**Size:** small · **Priority:** medium · **Depends on:** 2.7 · **Parallel with:** 2.8, 2.9, 2.11

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. Files: apps/client/src/layers/features/marketplace/model/use-update-with-toast.ts, apps/client/src/layers/features/marketplace/**tests**/use-update-with-toast.test.tsx.

TODAY (verified): `formatUpdateSuccess(label, result)` (use-update-with-toast.ts:35-41) returns `Updated ${label} to v${applied.version}` when something was applied, else `${label} is already up to date` — including when the check could not run.

CHANGE: when `result.applied` is empty, find the check for this package (`result.checks.find(c => c.packageName === args.name) ?? result.checks[0]`; pass the raw name into formatUpdateSuccess). If its `status === 'unknown'`, show `Couldn't check ${label} for updates: ${check.note}` (exact text; fall back to `Couldn't check ${label} for updates` when note is absent) — as `toast.error` or `toast.warning` rather than success, since nothing was confirmed (pick whichever sonner variant the codebase uses for non-fatal problems; grep `toast.warning` in apps/client/src). A `current` result keeps `${label} is already up to date`. Applied results keep `Updated ${label} to v${version}`. Both `mutate` (:67-81) and `mutateAsync` (:83-97) go through the same formatter. Update the module header (:1-18) and TSDoc. FSD: the hook stays in features/marketplace/model; the type comes from '@dorkos/shared/marketplace-schemas' (already imported at :24).

TESTS (use-update-with-toast.test.tsx): unknown check with a note -> the exact "Couldn't check <Label> for updates: <note>" text and not the success text; current -> "is already up to date"; applied -> "Updated … to v…". Each with a purpose comment.

VERIFY: `pnpm vitest run apps/client/src/layers/features/marketplace/__tests__/use-update-with-toast.test.tsx`; `pnpm --filter @dorkos/client typecheck && pnpm --filter @dorkos/client lint`. UI copy follows the writing-for-humans skill.

### Task 2.11: dorkos marketplace validate: report an entry version that plugin.json silently overrides

**Size:** medium · **Priority:** medium · **Depends on:** none · **Parallel with:** 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. Files: packages/cli/src/commands/validate-source-paths.ts (208 lines), its callers packages/cli/src/commands/package-validate-marketplace.ts (:151-163) and package-validate-remote.ts (:153-160), and packages/cli/src/commands/**tests**/validate-source-paths.test.ts. `dorkos marketplace validate <path-or-url>` (commands/marketplace-validate.ts) delegates to those two. Independent of every other Phase 2 task.

TODAY (verified): `checkSourcePaths(marketplace, probe, buildCandidate, marketplaceRoot)` (:77-107) already reaches each relative-path entry's `.claude-plugin/plugin.json`, locally (`localProbe`, :130-138, fs.stat) or remotely (`remoteProbe`, :145-152, a GET on a raw URL), but only confirms it exists (`SourcePathProbe = (candidate) => Promise<boolean>`, :52). Object-form entries are `skipped-object-source` (:84-86).

CHANGE

1. Widen the probe to also return the parsed version:

```ts
/** What a probe learned about one candidate plugin.json. */
export interface ProbeResult {
  reachable: boolean;
  /** plugin.json's `version`, when it parses and declares one. */ version?: string;
}
export type SourcePathProbe = (candidate: string) => Promise<ProbeResult>;
```

localProbe: stat + readFile + JSON.parse (a parse failure is still reachable, just no version). remoteProbe: `res.ok` then `await res.json()` guarded (a body that is not JSON is reachable, no version). 2. New result variant `{ name: string; status: 'version-mismatch'; candidate: string; entryVersion: string; pluginVersion: string }`. For each relative-path entry that sets `version` where the probed plugin.json also declares one and the two DIFFER, record it and make `report.ok` false. Error code in output: ENTRY_VERSION_MISMATCH. Message (names the entry, both values, and Claude Code's rule), proposed wording:
`  - <name>: ENTRY_VERSION_MISMATCH: marketplace.json says version <e> but plugins/<...>/.claude-plugin/plugin.json says <p>. Claude Code silently uses plugin.json's version, so the entry's is never seen. Remove "version" from the entry, or make them match.`

- An entry version on a package whose plugin.json declares none is legitimate (Claude Code's step 2): no error.
- Comparing against plugin.json is sufficient: it is the only file that masks the entry, and the validator (task 2.2) holds the manifest equal to it.
- Object-form entries stay skipped (checking them would clone foreign repos during validation).

3. renderSourcePathResults (:166-208): the fail block lists not-found lines and ENTRY_VERSION_MISMATCH lines; the ok line is unchanged. Callers keep their exit code for a failed report (2 today in package-validate-marketplace.ts:158-160; keep consistent in the remote handler).
4. Update the module header (:1-23) to say the check also compares entry and plugin.json versions.

TESTS (commands/**tests**/validate-source-paths.test.ts; existing probe mocks return booleans and must be updated to ProbeResult): ENTRY_VERSION_MISMATCH is reported (entry 1.0.0, plugin.json 1.1.0) and makes ok false; an entry version on a package whose plugin.json has no version is accepted; equal versions pass; object-form entries are skipped; localProbe returns the version from a real temp plugin.json and `{ reachable: true }` for unparseable JSON; remoteProbe returns the version from a mocked JSON body. Also run commands/**tests**/package-validate-marketplace.test.ts, package-validate-remote.test.ts and marketplace-validate.test.ts.

VERIFY: `pnpm vitest run packages/cli/src/commands/__tests__/validate-source-paths.test.ts packages/cli/src/commands/__tests__/package-validate-marketplace.test.ts packages/cli/src/commands/__tests__/package-validate-remote.test.ts packages/cli/src/commands/__tests__/marketplace-validate.test.ts`; `pnpm --filter dorkos typecheck && pnpm --filter dorkos lint`.

### Task 2.12: Docs, changelog fragment and stale comments; open the dorkos PR after the marketplace PR merges

**Size:** medium · **Priority:** medium · **Depends on:** 2.5, 2.7, 2.8, 2.9, 2.10, 2.11 · **Parallel with:** none

Worktree: /Users/doriancollier/.dork/workspaces/dorkos/marketplace-version-truth. Last Phase 2 task: everything else in the PR is done. User-facing prose follows the writing-for-humans skill; none of the retired words AGENTS.md bans in user-facing prose, and none of the four technical nouns ADR 260804-021140 retired (scripts/check-banned-words.sh, scripts/check-vocab-gate.ts).

DEVELOPER GUIDES

- contributing/marketplace-installs.md, "Update flow (`flows/update.ts`)" (:168-177): rewrite the numbered list to describe: one identity reader (readInstalledIdentity); Claude Code's resolution chain (plugin.json version, else entry version, else commit SHA); resolveLatest (resolve -> stage -> validate) and the short-circuit's THREE conditions (same sourceKey, same entryVersion, same commit via the memoized ls-remote; a full-SHA ref is its own commit); the three statuses current / update-available / unknown and that nothing is dropped; the 60s instance memo and when it is cleared; the known cache-integrity limit (DOR-2248) and the missing prune owner (DOR-2249). Fix the misstatement at :175: apply delegates to `InstallerLike.update()` (not `install()`). Also correct :582 ("iterates the installed list client-side") to say each install is checked in its own scope and one failure no longer stops the run.
- contributing/marketplace-packages.md: new "Versioning" section: one version, stated identically in `.claude-plugin/plugin.json` and `.dork/manifest.json` (VERSION_MISMATCH otherwise); bump on every change, because Claude Code and DorkOS deliver only a changed version; a package that declares no version is identified by commit, so every commit is an update.
- contributing/marketplace-registry.md:157 (the entry `version` row, "Optional"): say when an entry version is used (only when plugin.json declares none) and warn against setting it beside a package version; `dorkos marketplace validate` reports ENTRY_VERSION_MISMATCH.

USER DOCS (there is no dedicated update page; the update content lives in docs/marketplace/index.mdx:69-70 and docs/guides/cli-usage.mdx:152-154): describe the three outcomes in plain words — a newer version is available (and how to install it), it's up to date, or it couldn't be checked and why (for example, no network) — and that `dorkos update` with no name checks every package where it is installed.

CHANGELOG FRAGMENT: `changelog/unreleased/<id>-update-check-sees-new-versions.md` with id from `.claude/scripts/id.ts` (format YYMMDD-HHMMSS), under `### Fixed`, bullet: "`dorkos update` and the Update button now notice new versions of marketplace packages. Before, they always said everything was up to date. (DOR-2244)". Optionally a `### Changed` bullet: a package whose `.dork/manifest.json` and `.claude-plugin/plugin.json` versions disagree can no longer be installed; packages you already have stay installed. Validate with `.claude/scripts/changelog_backfill.py --validate` if present.

STALE COMMENTS

- apps/server/src/services/marketplace/marketplace-installer.ts:487 says "Uninstall WITH purge" but the call passes `purge: false` (:497): rewrite the comment to say what the code does (uninstall WITHOUT purge; the install root is removed while `.dork/data/` and `.dork/secrets.json` are preserved around the call).
- ADR-0233's "same permission preview on apply" claim is not what the code does: do NOT edit decisions/0233 (accepted ADR). Put it in the PR body and a DOR-2244 comment as an item for `/adr:audit`. The two draft ADRs (decisions/260923-122615-package-version-resolved-like-an-install.md, decisions/260923-122616-package-version-files-must-agree.md) exist already; leave their status to /adr:review.

GATE AND PR

- `pnpm verify` (affected typecheck + lint + test) green; `scripts/check-banned-words.sh` clean.
- LANDING ORDER: do not open (or at least do not arm) the dorkos PR until the Phase 1 dork-labs/marketplace PR has merged — after this PR, DorkOS refuses to install a package whose version files disagree, so the marketplace must already be clean and guarded.
- PR from the worktree branch based on origin/main (pin BASE=$(git rev-parse origin/main) once); body covers the fix, the new statuses, the direct-install apply limit, the ADR-0233 audit item, follow-ups DOR-2248/DOR-2249, and ends with the provenance line (public repo: sessionId truncated to 8 chars, no resumeUrl). Nothing from dorkos-cloud.

## Phase 3: Live verification

### Task 3.1: Verify on this machine against the live marketplace and record the output on DOR-2244

**Size:** small · **Priority:** high · **Depends on:** 1.4, 2.12 · **Parallel with:** none

After BOTH PRs have merged: the dork-labs/marketplace PR (flow 0.7.3 + the two checks, tasks 1.1-1.4) and the dorkos PR (tasks 2.1-2.12). Run the built DorkOS app that contains the dorkos change (`pnpm dev:dogfood` serves the built CLI app on :4242; or a released `dorkos` that includes it). Do NOT reinstall anything by hand before the check — the point is that existing installs (flow at 0.7.2, with a 0.6.0 manifest on disk) are seen correctly.

STEPS

1. `dorkos marketplace refresh dorkos-community` (clears the 60s update memo too).
2. For each project that has flow installed — dorkos (/Users/doriancollier/Keep/dork-os/dorkos), dorkos-cloud (/Users/doriancollier/Keep/dork-os/dorkos-cloud) and blintz — run `dorkos update --project <path>`. Expected: `flow  0.7.2 → 0.7.3  (dorkos-community)` — the installed side reads plugin.json's 0.7.2 despite the 0.6.0 manifest — and `1 update available. Run again with --apply to install it.` No line may say "All N up to date" if anything is `could not check`. (Output from the dorkos-cloud project is local only; paste nothing from that repo's paths or config into DOR-2244 beyond the flow line.)
3. `dorkos update flow --apply --project <path>` in one project, then rerun without --apply: `flow  up to date (0.7.3)`.
4. Run a name-less `dorkos update` (no --project): every install in every scope (global + each agent) is checked in its own scope, one line each, and the run does not abort on any single package; exit code 0.
5. Offline sanity (optional): with the network off, `dorkos update flow --project <path>` prints `flow  could not check: couldn't reach github.com` and the summary says one package could not be checked.
6. In the app (browser, Installed view), flow shows 0.7.3 after the apply; clicking Update on a package whose check can't run shows "Couldn't check <name> for updates: …" rather than "already up to date".
7. Record the exact terminal output (steps 2-5) and a screenshot for step 6 as a comment on DOR-2244 via the linear-adapter skill (Linear team DOR, account per flow config — never the artblocks work account), ending with the provenance line.

ACCEPTANCE: every expected line above observed verbatim, or a filed follow-up for each deviation.
