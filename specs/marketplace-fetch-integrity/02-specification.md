---
slug: marketplace-fetch-integrity
number: 260923-163012
created: 2026-09-23
status: implemented
linear-issue: DOR-2248
project: Marketplace Package Management
---

# A cached package holds exactly the commit its key names

**Status:** Implemented
**Author:** Claude Code
**Date:** 2026-09-23
**Input:** [`01-ideation.md`](./01-ideation.md) (decisions 1–11 carried forward)

## Overview

Every remote marketplace install, preview and update check fetches a package into a cache entry keyed `<name>@<sha>` and records that SHA in `install-metadata.json`. Today the SHA comes from a `git ls-remote` made before the fetch, and nothing checks it against what the fetch brought back, so the entry and the record can name a commit the tree is not. This spec replaces the three git fetch implementations with one primitive that fetches the looked-up commit itself, reads the commit from the checkout, and hands only that verified commit to the cache, which refuses any other kind of key.

## Background / Problem Statement

Deferred from `specs/marketplace-version-truth` (§5 "Known limit", review log round 1). Measured on 2026-09-23 against a local bare repository with git 2.53 (transcript in the ideation, §4):

1. `ls-remote <url> main` tail-matches: it also returns `refs/heads/x/main`, and the fetcher takes the first line, whichever sorts first.
2. `ls-remote <url> v1` on an annotated tag returns the tag object, not the commit. The fetcher records the tag object as the commit.
3. `github` and `url` sources drop the ref (`template-downloader.ts`, `cloneRepository(_ref)`): the default branch is cached under the ref's SHA.
4. `git-subdir` clones the default branch at depth 1 and then checks out the ref. A non-default branch or an older commit is not in that clone.
5. A pinned `sha` matches no ref name, so the lookup degrades to `tmp-<ms>` and the whole-repo forms cache the default branch under `<name>@tmp-<ms>`.
6. A push between the lookup and the clone caches the new tree under the old SHA.
7. A source with no ref resolves to `main` (`sourceKeyOf`), not the repository's default branch. Hidden today only because whole-repo clones ignore the ref.

The pin exists to answer "which code is running here?" (DOR-2197), and `resolveLatest` reports "staging's commit, not the lookup's". Both are only as true as the commit the fetch reports.

## Goals

- A cache entry `<name>@<sha>` holds exactly the tree of commit `<sha>` (restricted to the package's subdirectory for a `git-subdir` source), for every git source form: no ref, a branch (default or not), a tag (lightweight or annotated), a full refname, a pinned full SHA.
- The commit recorded in `install-metadata.json` (and returned by `resolveLatest`) is the commit that was checked out.
- The check happens before the entry is written: `git rev-parse HEAD` of the checkout, compared with what was asked for.
- Every failure fails closed with a plain message. No fetch result and no cache key is ever a placeholder.
- Servers that refuse to serve an unadvertised commit still install correctly, or fail plainly. Never a silent downgrade to a different commit than a pin names.
- Entries written before this change are never served.
- One git fetch implementation and one cache write path, for DOR-2249 (pruning) and DOR-2197 (content hash) to build on.

## Non-Goals

- Cache pruning (DOR-2249) and content hashing (DOR-2197).
- The all-packages update route (DOR-2194, built in parallel). This spec does not touch `routes/marketplace.ts`, and changes one comment in `flows/update.ts`.
- HTTP status codes for the new errors: they reach the route's default branch (500, message verbatim), exactly as a failed clone does today.
- npm sources (not implemented) and `file://` sources (served in place, commit `local`).

## Technical Dependencies

- git ≥ 2.26 on the host, **measured in Docker** with `scripts/git-floor-probe.sh` against the exact command sequence: 2.26.2, 2.30.0, 2.34.2, 2.36.3, 2.40.1, 2.43.0 (alpine and Ubuntu 24.04), 2.45.2 and 2.49.1 pass; 2.24.1 has no `sparse-checkout`; 2.25 was not available to measure. The GitHub token reaches private repositories on every version in that range: by environment header from 2.31, by URL before (§4), measured against a private repository on 2.26.2, 2.30.0 and 2.49.1. No new packages.
- Server capabilities, measured: protocol v2 (default since git 2.26; GitHub, GitLab) serves a reachable commit by SHA. Protocol v0 without `uploadpack.allowReachableSHA1InWant` answers `Server does not allow request for unadvertised object <sha>`; v2 answers `not our ref <sha>` for a commit it will not serve. A server without `uploadpack.allowFilter` warns `filtering not recognized by server, ignoring` and serves the fetch anyway.

## Detailed Design

### 1. Ref resolution (`lookupRemoteRef`)

`lookupRemoteRef(cloneUrl, ref): Promise<RemoteRef>`, where

```ts
type RemoteRef =
  | { kind: 'found'; commitSha: string; refName?: string } // refName absent = a pinned commit
  | { kind: 'missing' } // the remote answered and has no such ref
  | { kind: 'unreachable'; reason: string }; // git failed: network, auth, no git
```

- A full commit id (40 or 64 lowercase hex) is its own commit: `found` with no `refName`, no network.
- `HEAD`: ask for `HEAD`, use its line.
- A name starting with `refs/`: ask for it and its peeled form `<name>^{}`; exact-match the name.
- Any other name: ask for `refs/heads/<ref>`, `refs/tags/<ref>` and `refs/tags/<ref>^{}`. Branch wins over tag, the order `git clone --branch` uses. A tag resolves to its peeled commit when the remote reports one (annotated), else the tag's own line (lightweight).
- Only lines whose name equals a candidate **exactly** count. `ls-remote`'s tail match can return `refs/heads/x/main` for `main`, and it is ignored.
- `git ls-remote --end-of-options <url> <patterns…>`, `hardenedGitEnv`, 15 s timeout (`LS_REMOTE_TIMEOUT_MS`), with the GitHub token header of §4, so a private GitHub repository resolves.

### 2. The tree fetch (`fetchTree`)

`fetchTree({ cloneUrl, commitSha, refName?, subpath, destDir }): Promise<string>` returns the verified commit.

Each attempt runs in an empty `destDir`:

1. `git init --quiet`, then `git remote add --end-of-options origin <url>` (a named remote: a partial clone records its promisor settings under it, and the checkout needs them).
2. If `subpath` is not empty: `git sparse-checkout init --cone`, then `git sparse-checkout set --end-of-options <subpath>`. (`set --cone` alone leaves cone mode off before git 2.35.)
3. **Filtered attempt, subpath only:** write the partial-clone settings by hand (`core.repositoryformatversion 1`, `extensions.partialClone origin`, `remote.origin.promisor true`, `remote.origin.partialclonefilter blob:none`; git 2.26 refuses a filtered fetch into a fresh repository without them), then `git fetch --quiet --no-tags --depth=1 --filter=blob:none --end-of-options origin <commitSha>`. Only the package's own blobs download, lazily, at checkout. If any step reports a refusal (`unadvertised object`, `not our ref`, or `could not fetch … from promisor remote`), empty `destDir` and make the unfiltered attempt: a server that refuses unadvertised commits refuses a partial checkout's lazy blob requests too.
4. **Unfiltered attempt** (every whole-repository fetch, and the retry): `git fetch --quiet --no-tags --depth=1 --end-of-options origin <commitSha>`. On a refusal:
   - a named ref: fetch `<refName>` at depth 1 (the exact refname from the lookup, never a bare name git would resolve tag-first);
   - a pinned commit: fetch every branch and tag, unfiltered, no depth (`+refs/heads/*:refs/remotes/origin/*`, `+refs/tags/*:refs/tags/*`), then require `<commitSha>^{commit}`. Absent → `GitCommitNotFoundError`.
     Any other failure is thrown as it is (redacted).
5. Resolve the arrived commit: `git rev-parse --verify --quiet <FETCH_HEAD or commitSha>^{commit}`.
   - A pinned commit must equal `commitSha`, or throw.
   - A named ref fetched by commit must equal `commitSha`, or throw.
   - A named ref fetched through the fallback may differ: the ref moved between the lookup and the fetch. The arrived commit is used (and logged); it is what is on disk.
6. `git -c advice.detachedHead=false checkout --quiet --detach <arrived>`, with no `--end-of-options`: `checkout --detach` rejects it up to git 2.43 ("--detach does not take a path argument"), and `<arrived>` is a verified full commit id, never author text.
7. `git rev-parse --verify --quiet HEAD^{commit}` must equal `<arrived>`, or throw. This is the check the cache relies on.
8. Remove `destDir/.git`. The entry is the tree and nothing else, for both forms (today a `git-subdir` entry keeps its `.git`).

Any failure other than `GitCommitNotFoundError` is thrown as `GitFetchError` ("Couldn't fetch <remote>: <git's reason>").

Every spawn: argv array (no shell), `hardenedGitEnv()`, `--end-of-options` before every author-supplied value, a 120 s wall clock (`GIT_FETCH_TIMEOUT_MS`, matching the clone it replaces), and the §4 token header on every step (the checkout fetches lazily too). Errors carry git's stderr with tokens redacted (`redactAuthTokens`). `git-tree-guards.test.ts` pins the exact argv sequence the probe measured.

The old `git-subdir` fallback ladder is removed. Its "filter unsupported" rung never fires on a fetch (measured: the server warns and serves); its "sparse-checkout unsupported" rung only served git 2.24, below the floor.

### 3. Orchestration (`PackageFetcher`)

One private path, `fetchGitTree({ packageName, cloneUrl, ref, subpath, force })`, used by the git resolver, the legacy bare-`gitUrl` path (`fetchFromGit`, ref `HEAD`) and `fetchAtCommit`. A whole-repo `file://` address is served in place before it (commit `local`), exactly as `fetchFromGit` always did, so a `url` source naming a local folder still installs:

1. `assertRemoteAllowed(cloneUrl)` (`assertSafeGitRemote`, logged).
2. `lookupRemoteRef`. `missing` → `GitRefNotFoundError`; `unreachable` → `GitRemoteUnreachableError`. Nothing is fetched.
3. Unless `force`, a cache hit on the entry for `(name, commitSha, subpath)` returns it.
4. Otherwise `cache.materializePackage(name, commitSha, subpath, (tempDir) => git.fetch(...))`. The returned `{ path, commitSha }` is the result: its commit is the verified one.

`PackageFetcher` takes a `GitTreeSource` (`{ lookup, fetch }`, default `gitTreeSource`) in place of the `TemplateDownloader`, so tests replace the network at one seam.

`fetchAtCommit({ packageName, sourceKey, commitSha })` fetches one exact commit whatever ref the source names, for every git form (a `SourceKey` is what all three reduce to), returning the package directory below `sourceKey.subpath`. It refuses anything but a full commit id. This is the API for rebuilding an install recorded at a commit its branch has moved past (DOR-2245): the pinned path of §2, with its branches-and-tags fallback.

`lookupCommitSha(cloneUrl, ref)` (the update check's API, unchanged signature) uses the same `lookupRemoteRef`, so the update check and an install resolve a ref the same way. It keeps its contract: `found` → the commit; anything else → a `tmp-<ms>` placeholder that `isRealCommitSha` rejects. This is the only place a placeholder remains, and it is never a fetch result or a key.

### 4. The GitHub token

`gitHubAuthConfig(url, auth)` in `template-downloader.ts` returns `http.<origin>/.extraHeader` = `Authorization: Basic base64(x-access-token:<token>)`, or nothing when `url` is not a GitHub host (`isGitHubCredentialHost`, the same gate `execGitClone`'s URL rewrite asks). The marketplace fetch and lookup append it to git's environment config (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`, after any entries the environment already has), so the token is in no argv (`ps` shows every process's argv), in no `.git/config`, and sent to that origin only, redirects included. The token is resolved only for a GitHub host and reused for 60 s (`AUTH_TTL_MS`), because `resolveGitAuth` may run `gh auth token` synchronously. `git-subdir` sources on GitHub gain the token, under the same rule every other clone already follows. `GIT_CONFIG_COUNT` needs git 2.31. On git older than 2.31, which cannot read config from the environment, the token is embedded in the remote URL instead, exactly as `execGitClone` does (`withGitHubToken`); the installed git's version is read once per process (`git --version`, vendor suffixes such as Apple Git's tolerated), and an unreadable version takes the URL form, which works on every git. That URL lives only in the temporary repository's `.git`, which is removed before the tree is cached, with the temp directory on failure, and by the startup sweep after a crash; git's messages are redacted. `git-tree-guards.test.ts` stubs the version to cover both branches.

### 5. The resolvers

`source-resolvers/github.ts`, `url.ts` and `git-subdir.ts` collapse into `source-resolvers/git.ts`: one `gitResolver` for every `GitSourceDescriptor`. It takes the clone URL, subpath and ref from `sourceKeyOf`, calls `deps.fetchGitTree`, and joins the subpath onto the entry. `FetcherDeps` becomes `{ fetchGitTree }`.

### 6. The cache write path (`MarketplaceCache`)

- Entries live under `${dorkHome}/cache/marketplace/trees/` (was `packages/`): `<name>@<sha>` for a whole repository, `<name>@<sha>~<digest>` for a sparse subfolder, the digest being the first 12 hex digits of the subfolder's SHA-256. A sparse checkout is a different tree from the whole repository at the same commit, and keyed by name and commit alone it was served to a whole-repository request with everything else missing. `getPackage(name, sha, subpath)` and `listPackages` (which reports the package and commit of either form) follow.
- `materializePackage(name, expectedSha, subpath, fetch)` → `Promise<{ path; commitSha }>`. The key is the commit `fetch` returns, not the one the caller expected. Anything that is not a full commit id is refused (the temp directory is removed, an error names the package). `expectedSha` serves the fast path and the in-flight de-dup only.
- `putPackage` (no production caller; it wrote an unverified empty entry) is removed.
- `removeLeftovers()` deletes `packages/` (entries there cannot be told apart from correct ones, so none of them is ever read) and any `trees/.tmp-fetch-*` a crash left behind. The server awaits it once at startup, before the routes exist, so it cannot race a fetch; a failure is logged.

### 7. The default ref

`DEFAULT_REF` in `@dorkos/marketplace` `sourceKeyOf` becomes `'HEAD'`: a source with no ref is fetched at the repository's default branch, as Claude Code does. A sidecar written before this records `ref: 'main'`, and an update check never rewrites a sidecar. So `matchesRecordedKey` (`lib/source-provenance.ts`) accepts `HEAD` now against a recorded `main`; that is sound because the short-circuit compares commits next, and an explicit `main` that is not the default branch resolves to a different commit and is staged. A direct install cannot name a ref, so `resolvedFromSourceKey` rebuilds its recorded `main` as `HEAD`. No migration is needed.

### Code structure

| File                                                                           | Change                                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/marketplace/lib/git-tree.ts`                         | new: `isFullCommitSha`, `lookupRemoteRef`, `fetchTree`, `gitTreeSource`, `GitTreeSource`, the four errors                        |
| `apps/server/src/services/marketplace/package-fetcher.ts`                      | `fetchGitTree`, `fetchAtCommit`, `GitTreeSource` seam, `FetcherDeps = { fetchGitTree }`, `lookupCommitSha` via `lookupRemoteRef` |
| `apps/server/src/services/marketplace/source-resolvers/git.ts`                 | new; replaces `github.ts`, `url.ts`, `git-subdir.ts`                                                                             |
| `apps/server/src/services/marketplace/marketplace-cache.ts`                    | `trees/`, verified key with subfolder digest, `removeLeftovers`, no `putPackage`                                                 |
| `apps/server/src/services/core/template-downloader.ts`                         | `gitHubAuthConfig`; `cloneRepository`, `TemplateDownloader`, `defaultTemplateDownloader` removed                                 |
| `apps/server/src/index.ts`                                                     | `gitTreeSource`; `removeLeftovers()` awaited at startup                                                                          |
| `apps/server/src/services/marketplace/marketplace-installer.ts`                | comments only (the DOR-2248 limit is gone)                                                                                       |
| `apps/server/src/services/marketplace/flows/update.ts`                         | one comment (`ref: 'main'` → `'HEAD'`)                                                                                           |
| `packages/marketplace/src/source-resolver.ts`                                  | `DEFAULT_REF = 'HEAD'`                                                                                                           |
| `contributing/marketplace-installs.md`, `contributing/marketplace-registry.md` | fetch + cache sections, known limits                                                                                             |

### API / data model changes

No HTTP or schema change. On disk: the cache root moves from `packages/` to `trees/`; `install-metadata.json` keeps its shape and now always records the checked-out commit.

## User Experience

Nothing new to learn. What changes for a person:

- A package whose marketplace entry names a branch, a tag or a commit now installs that branch, tag or commit. Before, whole-repo sources installed the default branch, and `git-subdir` sources failed.
- A package from a repository whose default branch is not `main` installs from its default branch.
- A bad ref fails with a plain message, before anything is downloaded: `There's no branch or tag named "develop" in github.com/owner/repo.`
- A pinned commit that is not in the repository: `Commit 1234567… isn't in github.com/owner/repo.`
- An unreachable repository: `Couldn't reach github.com/owner/repo: <git's reason>.`
- The first install or update check after upgrading re-downloads each package once (the old cache is not trusted).

## Testing Strategy

- **Real git (`lib/__tests__/git-tree.test.ts`).** Local bare repositories over `file://`, with `hardenedGitEnv` mocked to also allow `file` (the only change to the production environment). Each case asserts the checked-out files AND the returned commit:
  - no ref → the default branch, including a repository whose default branch is not `main`;
  - a non-default branch; a branch whose name is the tail of another (`main` vs `x/main`);
  - an annotated tag → its commit, never the tag object; a lightweight tag;
  - a pinned commit that is not any ref's tip;
  - a subpath: only that directory is checked out, and `.git` is gone;
  - a protocol-v0 server with `uploadpack.allowReachableSHA1InWant=false`: a named ref falls back to its refname; a pinned commit falls back to branches + tags; a pinned commit that is absent fails with `GitCommitNotFoundError`;
  - a push between the lookup and the fetch: on the by-commit path the looked-up commit is what arrives; on the fallback path the arrived commit is returned and is what is on disk;
  - a missing ref → `missing`; an unreachable remote → `unreachable`.
- **Cache (`marketplace-cache.test.ts`).** The key is the commit the callback returns; a non-commit return is refused and leaves nothing behind; concurrent materializations share one fetch; `removeLeftovers` removes `packages/` and crashed temp fetches only; a sparse entry is keyed apart from the whole repository.
- **Fetcher (`package-fetcher.test.ts`)** with a fake `GitTreeSource`: a hit on the looked-up commit skips the fetch; a miss keys by the fetched commit, even when it differs from the lookup; `missing` and `unreachable` throw plain errors and fetch nothing; a refused address runs no git; `lookupCommitSha` returns a placeholder only when not `found`.
- **Resolver (`source-resolvers/__tests__/git.test.ts`)**: all three forms pass `sourceKeyOf`'s URL, ref and subpath; the subpath is joined.
- **Installer suites** (`install-source-matrix`, `install-address-policy`, `failure-paths`, the harness, the MCP integration test) move from the `TemplateDownloader` stub to a fake `GitTreeSource`; their assertions keep their meaning.
- **`@dorkos/marketplace`**: `sourceKeyOf` defaults to `HEAD`.
- **`template-downloader.test.ts`**: `gitHubAuthConfig` scopes the header to a GitHub origin and refuses every other host, exactly as `execGitClone`'s gate does.
- **`git-tree-guards.test.ts`** (git scripted): the exact argv sequence; the token only in the environment, on every step, never in argv; existing `GIT_CONFIG_*` entries kept; the token resolved once a minute; a refused lazy blob fetch restarts unfiltered.

- **End to end (`package-fetcher-git.test.ts`)**: `PackageFetcher` + real `gitTreeSource` + real cache against a bare repository addressed by path (the address policy is opened for that path only): `fetchAtCommit` at a commit `main` has moved past, for a git-subdir key and a whole-repo key, from cache the second time, through the protocol-v0 fallback, and refused for an absent or abbreviated commit; `fetchPackage` at a named branch and at the default branch.

Every test states its purpose, and the critical lines are mutation-checked: the tag peel, the branch-before-tag order, the qualified `ls-remote` patterns, the HEAD comparison, the by-id commit check, the refname fallback, the pinned-commit check, the cache's commit gate and key, the `missing` refusal, the token host gate, the `trees/` root, and `fetchAtCommit`'s use of the commit as the ref each turn a test red.

## Performance Considerations

- An unchanged, cached package: one `ls-remote`, as before.
- A fetch: `init` + one `fetch --depth=1` of exactly one commit (sparse and blob-filtered for a subpath), no more data than today's shallow clone. On a server that refuses unadvertised commits, a named ref costs one more round trip; a pinned commit costs a blob-filtered fetch of every branch and tag. That is the price of a pin on such a server, and the alternative was refusing it.
- The first run after upgrading re-fetches every package once.

## Security Considerations

- Unchanged: `assertSafeGitRemote` before any git process (now at one door, `fetchGitTree`, plus `lookupCommitSha`); `hardenedGitEnv` on every spawn; `--end-of-options` before every author-supplied value; argv arrays, no shell.
- The GitHub token goes only to a GitHub origin. On git 2.31+ it is an environment-borne header (§4): not in argv, not in `.git/config`, not in a URL git could echo. On older git it is embedded in the remote URL, as `execGitClone` has always done, and lives only in the temporary `.git`, which is removed before caching, on failure, or by the startup sweep. `git-subdir` and `ls-remote` gain it for GitHub hosts. Error messages are still redacted. A temp fetch a crash left behind is swept at startup.
- The cache refuses a key that is not a full commit id, so a malicious remote cannot name a directory (`assertContainedIn` still guards the path).

## Documentation

- `contributing/marketplace-installs.md`: the fetch pipeline, the cache layout (`trees/`, verified keys, legacy removal), the known-limits list (DOR-2248's limit removed, the subpath-key limit added), `ref: 'HEAD'`.
- `contributing/marketplace-registry.md`: the `git-subdir` description (no fallback ladder).
- Changelog fragment: packages install the branch, tag or commit their listing names.

## Implementation Phases

One phase, in the order of `03-tasks.json`: the git primitive (real-git tests first), the cache write path, the fetcher and resolver, the default ref, the removals and test-seam moves, docs.

## Open Questions

None. All decisions are in the ideation's table.

## Related ADRs

- ADR-0232 (content-addressable cache): the key's meaning is now enforced; the root directory moves.
- ADR 260923-122615 (a package's version resolved like an install): its commit fallback now reads a verified commit.
- Draft ADR 260923-162950 (this spec): a cache entry is keyed by the commit its checkout verifiably holds.

## Review log

**Round 1 (independent review, 2026-09-23).** 18 of 19 mutants killed; the integrity model held. Adopted:

- BLOCKER: `checkout --detach --end-of-options` fails on git ≤ 2.43 (Ubuntu 22.04/24.04, Debian 12, Apple Git 2.39). The checkout names the verified commit bare; the floor is now measured in Docker (`scripts/git-floor-probe.sh`), and the argv is pinned by a test.
- `sparse-checkout set --cone` is not cone mode before 2.35, and a filtered fetch into a fresh repository fails on 2.26: `init --cone` then `set`; partial-clone settings written by hand.
- The cache key omitted the subfolder, which was a real integrity hole (a sparse `flow@<sha>` was served to a whole-repository request). Sparse entries are keyed `<name>@<sha>~<digest>`.
- The fallbacks were blob-filtered, and a server that refuses unadvertised commits refuses the lazy blob fetches too. A refused partial clone now restarts unfiltered, and both fallbacks are unfiltered. Test repositories serve filters, so the partial path really runs.
- A surviving mutant (the refname fallback fetching the bare name) is killed by a protocol-v0 test where a branch and a tag share a name.
- Legacy `main` records no longer restage on every check (`matchesRecordedKey`).
- Crashed temp fetches are swept at startup; the token moved from argv to the environment and is resolved once a minute; stale comments fixed; an empty repository says "has no commits yet".

**Round 2 (delta review).** Private GitHub repositories on git 2.26–2.30 were a regression: the header path is invisible to git before 2.31, and the old clone's URL rewrite worked there. Closed: the installed git's version is read once per process, and before 2.31 (or when unreadable) the token is embedded in the remote URL as `execGitClone` does. Both branches are tested with a stubbed version, and both were measured in Docker against a private repository.

## References

- DOR-2248; found by the review of DOR-2244 (`specs/marketplace-version-truth`).
- DOR-2249 (pruning) and DOR-2197 (content hash) build on §6.
- DOR-2194 (parallel): overlap limited to one comment in `flows/update.ts`.
