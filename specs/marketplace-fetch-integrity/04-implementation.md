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

- Task #1.1: Share the GitHub token rule (first as `withGitHubToken`; after review, `gitHubAuthConfig`, an environment-borne header)
- Task #1.2: The git tree primitive (`lib/git-tree.ts`), real-git tests first
- Task #1.3: Cache entries keyed by the verified commit (`trees/`, subfolder digest in sparse keys, `removeLeftovers`, `putPackage` removed)
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
- `apps/server/src/services/core/template-downloader.ts` (`gitHubAuthConfig`; `cloneRepository`, `TemplateDownloader`, `defaultTemplateDownloader` removed)
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

### Session 2 - 2026-09-23 (review round 1)

All nine findings adopted, TDD; see the spec's Review log. The git floor was measured in Docker with `scripts/git-floor-probe.sh` (new): 2.26–2.49 pass and 2.24 fails. New files: `scripts/git-floor-probe.sh`. Also changed: `lib/source-provenance.ts` (`matchesRecordedKey` replaces `sameSourceKey`; `resolvedFromSourceKey` reads a legacy `main` as `HEAD`), `lib/git-safety.ts` and `package-resolver.ts` (stale comments).

### Session 3 - 2026-09-23 (delta review)

Closed the git 2.26–2.30 private-repository regression: `gitAuth` reads `git --version` once per process (`parseGitVersion` tolerates Apple and Windows suffixes); from 2.31 the environment header, before (or unreadable) the URL rewrite `withGitHubToken`, re-extracted from `execGitClone`. Tested with a stubbed version; measured with `scripts/git-floor-probe.sh` against a private repository on 2.26.2, 2.30.0 (URL) and 2.49.1 (header), including that the token is in `.git/config` on the URL path and gone once `.git` is removed.

### Session 4 - 2026-09-23 (delta review, round 3)

Closed a silent broken-checkout path: git 2.30–2.36 exit 0 from a partial checkout whose lazy blob fetch was refused, with `HEAD` right and the file missing (reproduced in Docker by the probe). The checkout now fails on an `error:` line or a non-empty `git ls-files --deleted`, any failure of the filtered attempt restarts once unfiltered, and `getPackage` serves only a non-empty entry.

## Known limits

- The exact-name filter on `ls-remote` output is defence in depth: the qualified patterns (`refs/heads/<ref>`, …) are what keep `x/main` out, and a mutation of the filter alone survives the suite. The pattern mutation does not.
- On git older than 2.31 the token is on the fetch's argv while it runs (URL form, as `execGitClone` has always done); from 2.31 it is not.
- Sidecars written before this change keep `ref: 'main'` forever (a check never rewrites them); `matchesRecordedKey` treats that as `HEAD`, so they short-circuit like any other install.
