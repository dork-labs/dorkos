---
slug: marketplace-fetch-integrity
number: 260923-163012
created: 2026-09-23
status: specified
linear-issue: DOR-2248
project: Marketplace Package Management
---

# A cached package holds exactly the commit its key names

**Status:** Draft
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
- Encoding the subpath in the cache key. Two different subdirectories of one commit under one package name would share an entry. That needs a package to change its source form without its source repository gaining a commit; recorded as a known limit.
- npm sources (not implemented) and `file://` sources (served in place, commit `local`).

## Technical Dependencies

- git ≥ 2.25 on the host (already the floor: `--end-of-options` needs 2.24, `sparse-checkout` 2.25). No new packages.
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
- `git ls-remote --end-of-options <url> <patterns…>`, `hardenedGitEnv`, 15 s timeout (`LS_REMOTE_TIMEOUT_MS`). The URL is credentialed by the shared GitHub-token rule (§4), so a private GitHub repository resolves.

### 2. The tree fetch (`fetchTree`)

`fetchTree({ cloneUrl, commitSha, refName?, subpath, destDir }): Promise<string>` returns the verified commit.

1. `git init --quiet` in `destDir`.
2. If `subpath` is not empty: `git sparse-checkout set --cone --end-of-options <subpath>`.
3. **By commit:** `git fetch --quiet --no-tags --depth=1 [--filter=blob:none] --end-of-options <url> <commitSha>`. The filter is passed only with a subpath (a whole-repo checkout needs every blob anyway).
4. **Fallback, only when the server refuses an unadvertised commit** (stderr matches `unadvertised object` or `not our ref`):
   - a named ref: fetch `<refName>` at depth 1 (the exact refname from the lookup, never a bare name git would re-interpret);
   - a pinned commit: fetch every branch and tag, blob-filtered, no depth (`+refs/heads/*:refs/remotes/origin/*`, `+refs/tags/*:refs/tags/*`), then require `<commitSha>^{commit}`. Absent → `GitCommitNotFoundError`.
     Any other fetch failure is thrown as it is (redacted).
5. Resolve the arrived commit: `git rev-parse --verify <FETCH_HEAD or commitSha>^{commit}`.
   - A pinned commit must equal `commitSha`, or throw.
   - A named ref fetched by commit must equal `commitSha`, or throw.
   - A named ref fetched through the fallback may differ: the ref moved between the lookup and the fetch. The arrived commit is used (and logged); it is what is on disk.
6. `git -c advice.detachedHead=false checkout --quiet --detach --end-of-options <arrived>`.
7. `git rev-parse --verify HEAD` must equal `<arrived>`, or throw. This is the check the cache relies on.
8. Remove `destDir/.git`. The entry is the tree and nothing else, for both forms (today a `git-subdir` entry keeps its `.git`).

Every spawn: argv array (no shell), `hardenedGitEnv()`, `--end-of-options` before every author-supplied value, a 120 s wall clock (`GIT_FETCH_TIMEOUT_MS`, matching the clone it replaces). Errors carry git's stderr with tokens redacted (`redactAuthTokens`) and never the credentialed URL.

The old `git-subdir` fallback ladder is removed. The "filter unsupported" rung never fires on a fetch (measured: the server warns and serves). The "sparse-checkout unsupported" rung only served git 2.24, below the stated floor.

### 3. Orchestration (`PackageFetcher`)

One private path, `fetchGitTree({ packageName, cloneUrl, ref, subpath, force })`, used by the git resolver and the legacy bare-`gitUrl` path (`fetchFromGit`, ref `HEAD`):

1. `assertRemoteAllowed(cloneUrl)` (`assertSafeGitRemote`, logged).
2. `lookupRemoteRef`. `missing` → `GitRefNotFoundError`; `unreachable` → `GitRemoteUnreachableError`. Nothing is fetched.
3. Unless `force`, a cache hit on `<name>@<commitSha>` returns it.
4. Otherwise `cache.materializePackage(name, commitSha, (tempDir) => git.fetch(...))`. The returned `{ path, commitSha }` is the result: its commit is the verified one.

`PackageFetcher` takes a `GitTreeSource` (`{ lookup, fetch }`, default `gitTreeSource`) in place of the `TemplateDownloader`, so tests replace the network at one seam.

`lookupCommitSha(cloneUrl, ref)` (the update check's API, unchanged signature) uses the same `lookupRemoteRef`, so the update check and an install resolve a ref the same way. It keeps its contract: `found` → the commit; anything else → a `tmp-<ms>` placeholder that `isRealCommitSha` rejects. This is the only place a placeholder remains, and it is never a fetch result or a key.

### 4. The GitHub token

The URL rewrite moves out of `execGitClone` into `withGitHubToken(url, auth)` in `template-downloader.ts`, and `execGitClone` calls it. The marketplace fetch and lookup call it too, resolving the token only for a GitHub host (`isGitHubCredentialHost`). One rewrite, one host gate. `git-subdir` sources on GitHub gain the token, under the same rule every other clone already follows.

### 5. The resolvers

`source-resolvers/github.ts`, `url.ts` and `git-subdir.ts` collapse into `source-resolvers/git.ts`: one `gitResolver` for every `GitSourceDescriptor`. It takes the clone URL, subpath and ref from `sourceKeyOf`, calls `deps.fetchGitTree`, and joins the subpath onto the entry. `FetcherDeps` becomes `{ fetchGitTree }`.

### 6. The cache write path (`MarketplaceCache`)

- Entries live under `${dorkHome}/cache/marketplace/trees/<name>@<sha>/` (was `packages/`).
- `materializePackage(name, expectedSha, fetch)` → `Promise<{ path; commitSha }>`. The key is the commit `fetch` returns, not the one the caller expected. Anything that is not a full commit id is refused (the temp directory is removed, an error names the package). `expectedSha` serves the fast path and the in-flight de-dup only.
- `putPackage` (no production caller; it wrote an unverified empty entry) is removed.
- `removeLegacyPackages()` deletes `packages/`. The server calls it once at startup, best effort, logged on failure. Entries there cannot be told apart from correct ones, so none of them is ever read.

### 7. The default ref

`DEFAULT_REF` in `@dorkos/marketplace` `sourceKeyOf` becomes `'HEAD'`: a source with no ref is fetched at the repository's default branch, as Claude Code does. A sidecar written before this records `ref: 'main'`; its `sourceKey` no longer matches, so the update check stages once instead of short-circuiting, then records the new key on the next install. No migration is needed.

### Code structure

| File                                                                           | Change                                                                                                          |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/services/marketplace/lib/git-tree.ts`                         | new: `isFullCommitSha`, `lookupRemoteRef`, `fetchTree`, `gitTreeSource`, `GitTreeSource`, the three errors      |
| `apps/server/src/services/marketplace/package-fetcher.ts`                      | `fetchGitTree`, `GitTreeSource` seam, `FetcherDeps = { fetchGitTree }`, `lookupCommitSha` via `lookupRemoteRef` |
| `apps/server/src/services/marketplace/source-resolvers/git.ts`                 | new; replaces `github.ts`, `url.ts`, `git-subdir.ts`                                                            |
| `apps/server/src/services/marketplace/marketplace-cache.ts`                    | `trees/`, verified key, `removeLegacyPackages`, no `putPackage`                                                 |
| `apps/server/src/services/core/template-downloader.ts`                         | `withGitHubToken`; `cloneRepository`, `TemplateDownloader`, `defaultTemplateDownloader` removed                 |
| `apps/server/src/index.ts`                                                     | `gitTreeSource`; `removeLegacyPackages()` at startup                                                            |
| `apps/server/src/services/marketplace/marketplace-installer.ts`                | comments only (the DOR-2248 limit is gone)                                                                      |
| `apps/server/src/services/marketplace/flows/update.ts`                         | one comment (`ref: 'main'` → `'HEAD'`)                                                                          |
| `packages/marketplace/src/source-resolver.ts`                                  | `DEFAULT_REF = 'HEAD'`                                                                                          |
| `contributing/marketplace-installs.md`, `contributing/marketplace-registry.md` | fetch + cache sections, known limits                                                                            |

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
- **Cache (`marketplace-cache.test.ts`).** The key is the commit the callback returns; a non-commit return is refused and leaves nothing behind; concurrent materializations share one fetch; `removeLegacyPackages` removes `packages/` only.
- **Fetcher (`package-fetcher.test.ts`)** with a fake `GitTreeSource`: a hit on the looked-up commit skips the fetch; a miss keys by the fetched commit, even when it differs from the lookup; `missing` and `unreachable` throw plain errors and fetch nothing; a refused address runs no git; `lookupCommitSha` returns a placeholder only when not `found`.
- **Resolver (`source-resolvers/__tests__/git.test.ts`)**: all three forms pass `sourceKeyOf`'s URL, ref and subpath; the subpath is joined.
- **Installer suites** (`install-source-matrix`, `install-address-policy`, `failure-paths`, the harness, the MCP integration test) move from the `TemplateDownloader` stub to a fake `GitTreeSource`; their assertions keep their meaning.
- **`@dorkos/marketplace`**: `sourceKeyOf` defaults to `HEAD`.
- **`template-downloader.test.ts`**: `withGitHubToken` gates the token exactly as `execGitClone` did.

Every test states its purpose, and the critical lines are mutation-checked: dropping the HEAD comparison, the exact-name match, the tag peel, the cache's commit check, or the fallback's refname each turns a test red.

## Performance Considerations

- An unchanged, cached package: one `ls-remote`, as before.
- A fetch: `init` + one `fetch --depth=1` of exactly one commit (sparse and blob-filtered for a subpath), no more data than today's shallow clone. On a server that refuses unadvertised commits, a named ref costs one more round trip; a pinned commit costs a blob-filtered fetch of every branch and tag. That is the price of a pin on such a server, and the alternative was refusing it.
- The first run after upgrading re-fetches every package once.

## Security Considerations

- Unchanged: `assertSafeGitRemote` before any git process (now at one door, `fetchGitTree`, plus `lookupCommitSha`); `hardenedGitEnv` on every spawn; `--end-of-options` before every author-supplied value; argv arrays, no shell.
- The GitHub token goes only to a GitHub host, through one function now shared by the clone and the marketplace fetch. `git-subdir` and `ls-remote` gain it for GitHub hosts. Error messages are redacted, and the credentialed URL is never logged. It is written to `FETCH_HEAD` inside the temporary checkout, which is deleted with `.git` before the entry is promoted, or with the temp directory on failure.
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

## References

- DOR-2248; found by the review of DOR-2244 (`specs/marketplace-version-truth`).
- DOR-2249 (pruning) and DOR-2197 (content hash) build on §6.
- DOR-2194 (parallel): overlap limited to one comment in `flows/update.ts`.
