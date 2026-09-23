# Tasks — marketplace-fetch-integrity

Canonical: `03-tasks.json`. One phase.

## Phase 1 — Verified fetch and cache

### Task 1.1: Share the GitHub token rewrite

Extract `withGitHubToken(url, auth)` from `execGitClone` in `services/core/template-downloader.ts`; `execGitClone` calls it. Tests: the token reaches only an https GitHub host on the default port with no userinfo, exactly the old gate.

- Size: small
- Depends on: none

### Task 1.2: Build the git tree primitive

New `services/marketplace/lib/git-tree.ts`: `isFullCommitSha`, `lookupRemoteRef` (exact refnames, branch before tag, tags peeled, full SHA as itself, found/missing/unreachable), `fetchTree` (init, sparse for a subpath, fetch by SHA at depth 1, refname fallback on an unadvertised-object refusal, branches+tags fallback for a pin, checkout, HEAD verified, .git removed), `gitTreeSource`, `GitRefNotFoundError`, `GitCommitNotFoundError`, `GitRemoteUnreachableError`. Real-git tests over file:// (hardenedGitEnv mocked to allow file) for every case in spec Testing Strategy, written first.

- Size: large
- Depends on: 1.1

### Task 1.3: Key cache entries by the verified commit

`MarketplaceCache`: root `trees/`; `materializePackage(name, expectedSha, fetch)` returns `{ path, commitSha }` keyed by the commit the fetch returns and refuses a non-commit; `putPackage` removed; `removeLegacyPackages()`. Tests updated (incl. route test seeds).

- Size: medium
- Depends on: 1.2

### Task 1.4: Route every git form through one fetch

`PackageFetcher` takes a `GitTreeSource`; `fetchGitTree` (assert, lookup, hit, materialize); `lookupCommitSha` via `lookupRemoteRef`; `FetcherDeps = { fetchGitTree }`; `source-resolvers/git.ts` replaces github/url/git-subdir; index.ts wiring + startup legacy removal; `cloneRepository`/`TemplateDownloader` removed. All stubbing suites moved to a fake `GitTreeSource`.

- Size: large
- Depends on: 1.2, 1.3

### Task 1.5: Fetch a ref-less source at the default branch

`DEFAULT_REF = 'HEAD'` in `packages/marketplace/src/source-resolver.ts`; tests; the `flows/update.ts` comment.

- Size: small
- Depends on: 1.4

### Task 1.6: Document the verified fetch

`contributing/marketplace-installs.md`, `contributing/marketplace-registry.md`, installer comments (the DOR-2248 limit is gone), changelog fragment, spec 04-implementation.

- Size: small
- Depends on: 1.4, 1.5
