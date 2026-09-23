# Implementation Summary: A cached package holds exactly the commit its key names

**Created:** 2026-09-23
**Last Updated:** 2026-09-23
**Spec:** specs/marketplace-fetch-integrity/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 6 / 6

## Tasks Completed

### Session 1 - 2026-09-23

**Worker:** the DOR-2248 implementer (sequential, TDD); adversarial review by the orchestrator before the PR

- Task #1.1: Share the GitHub token rewrite (`withGitHubToken`)
- Task #1.2: The git tree primitive (`lib/git-tree.ts`), real-git tests first
- Task #1.3: Cache entries keyed by the verified commit (`trees/`, `removeLegacyPackages`, `putPackage` removed)
- Task #1.4: Every git form through one fetch (`source-resolvers/git.ts`, `GitTreeSource` seam, `fetchAtCommit`)
- Task #1.5: A ref-less source is fetched at `HEAD`
- Task #1.6: Guides, installer comments, changelog fragment

**Workspace:** dorkos worktree `~/.dork/workspaces/dorkos/DOR-2248` (branch `DOR-2248`).

## Files Modified/Created

**Source files:**

- `apps/server/src/services/marketplace/lib/git-tree.ts` (new)
- `apps/server/src/services/marketplace/source-resolvers/git.ts` (new; replaces `github.ts`, `url.ts`, `git-subdir.ts`)
- `apps/server/src/services/marketplace/package-fetcher.ts`
- `apps/server/src/services/marketplace/marketplace-cache.ts`
- `apps/server/src/services/marketplace/marketplace-installer.ts` (comments)
- `apps/server/src/services/marketplace/flows/update.ts` (one comment)
- `apps/server/src/services/core/template-downloader.ts` (`withGitHubToken`; `cloneRepository`, `TemplateDownloader`, `defaultTemplateDownloader` removed)
- `apps/server/src/index.ts`
- `packages/marketplace/src/source-resolver.ts`

**Test files:**

- `apps/server/src/services/marketplace/lib/__tests__/git-tree.test.ts` (new, real git)
- `apps/server/src/services/marketplace/lib/__tests__/git-tree-guards.test.ts` (new, scripted git)
- `apps/server/src/services/marketplace/__tests__/package-fetcher-git.test.ts` (new, real git + real cache)
- `apps/server/src/services/marketplace/source-resolvers/__tests__/git.test.ts` (new; replaces the three resolver suites and `git-subdir-concurrency.test.ts`, whose concurrency case moved to `package-fetcher.test.ts`)
- Updated: `package-fetcher`, `marketplace-cache`, `install-address-policy`, `install-source-matrix`, `installer-harness`, `integration`, `failure-paths`, `marketplace-installer` (server marketplace); `marketplace-mcp/__tests__/integration`; `routes/__tests__/marketplace` (cache seeds); `core/__tests__/template-downloader`; `packages/marketplace` `source-resolver`.

## Deviations from the spec

- `GitFetchError` joins the three errors the spec named: every failed fetch step is one plain "Couldn't fetch <remote>: <reason>".
- The fetch uses a temporary named remote rather than a bare URL, because a blob-filtered fetch needs a promisor remote for the checkout to fetch missing blobs.
- `fetchAtCommit` was added at the orchestrator's request so DOR-2245 can rebuild an install recorded at an older commit.
- A whole-repo `file://` address still takes the local-folder path ahead of `fetchGitTree` (`fetchGitSource`), exactly as `fetchFromGit` did; the spec's first draft missed that `url` sources reached it through `cloneRepository`.

## Known limits

- The cache key omits the subpath (spec, Non-Goals).
- The exact-name filter on `ls-remote` output is defence in depth: the qualified patterns (`refs/heads/<ref>`, …) are what keep `x/main` out, and a mutation of the filter alone survives the suite. The pattern mutation does not.
- Sidecars written before this change record `ref: 'main'`; their first update check stages once instead of short-circuiting.
