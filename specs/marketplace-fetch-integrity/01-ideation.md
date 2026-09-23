---
slug: marketplace-fetch-integrity
number: 260923-163012
created: 2026-09-23
status: ideation
linear-issue: DOR-2248
project: Marketplace Package Management
---

# A cached package holds exactly the commit its key names

**Slug:** marketplace-fetch-integrity
**Author:** Claude Code
**Date:** 2026-09-23
**Tracker:** DOR-2248 (project: Marketplace Package Management)

---

## 1) Intent & Assumptions

- **Task brief:** the package cache is keyed `<name>@<sha>` (ADR-0232), and `install-metadata.json` records that SHA as the commit the package was fetched at (DOR-147). Today the tree in an entry can differ from the commit its key names, so the pin can be wrong at the moment it is written. Make the entry and the recorded commit always describe the tree that was actually checked out, for every git source form (a default branch, a non-default branch, a tag, a pinned full SHA), verified before the entry is written, and fail closed with a plain message rather than ever writing a placeholder that looks like a commit. Deferred here by `specs/marketplace-version-truth` §5 "Known limit" and its review log.
- **Assumptions:**
  - The security posture stays: `assertSafeGitRemote` before any git process, `hardenedGitEnv` on every spawn, `--end-of-options` before every author-supplied value, the GitHub token only ever sent to a GitHub host (DOR-1833).
  - git ≥ 2.25 is the floor (it already is for `git-subdir` and `--end-of-options`). Measured locally on 2.53.
  - Hosts DorkOS installs from (GitHub, GitLab, Gitea, Bitbucket) allow fetching a reachable commit by its SHA. Some servers do not (protocol v0 without `uploadpack.allowReachableSHA1InWant`), and they must still install correctly.
- **Out of scope:**
  - DOR-2249: an owner for cache pruning. This item keeps the cache write path single so that one can build on it.
  - DOR-2197: a content hash that verifies an install still matches its pin. Same.
  - DOR-2194: the all-packages update route. Parallel work; this item avoids `routes/marketplace.ts` and touches `flows/update.ts` only if a comment there becomes false.
  - Authenticating `git ls-remote` for private repositories (the update check still reports a private GitHub repo as unreachable). Pre-existing, filed separately if wanted.
  - npm sources (not implemented) and `file://` sources (served in place, no commit).

## 2) Pre-reading Log

- `specs/marketplace-version-truth/02-specification.md` §5 + review log: the defect was found by that spec's adversarial review and deliberately not papered over. `resolveLatest` reports "staging's commit, not the lookup's", so it depends on staging reporting the commit it really fetched.
- `decisions/260923-122615-package-version-resolved-like-an-install.md`: the version chain falls back to the commit; a wrong commit is a wrong version.
- `decisions/0232-content-addressable-marketplace-cache-with-ttl.md`: "once fetched at a specific SHA, immutable forever". That premise is only true if the entry really is that SHA.
- `apps/server/src/services/marketplace/package-fetcher.ts`: `fetchFromGit` looks up the SHA with `ls-remote`, checks the cache, then clones through the injected `TemplateDownloader`. `resolveCommitSha` takes the **first** line of `ls-remote` output and degrades any failure to `tmp-<ms>`.
- `apps/server/src/services/marketplace/source-resolvers/git-subdir.ts`: its own spawn ladder: `clone --filter=blob:none --no-checkout --depth=1` (default branch only) → sparse-checkout → `checkout <ref>`.
- `apps/server/src/services/marketplace/source-resolvers/github.ts`, `url.ts`: both hand `key.ref` to `cloneRepository`, which ignores it.
- `apps/server/src/services/core/template-downloader.ts`: `cloneRepository(gitUrl, destDir, _ref)`, where `_ref` is "currently unused". `execGitClone` owns the GitHub-token URL rewrite and removes `.git` after cloning.
- `apps/server/src/services/marketplace/marketplace-cache.ts`: `materializePackage(name, sha, clone)` decides the key before the clone runs, so it can only trust the caller. `putPackage` reserves an empty entry and has no production caller.
- `packages/marketplace/src/source-resolver.ts`: `sourceKeyOf` owns the effective ref, `sha ?? ref ?? 'main'`.
- `apps/server/src/services/marketplace/marketplace-installer.ts`: `stagePackage` records `fetched.commitSha` only when `isRealCommitSha`; `resolveLatest` compares a lookup against the recorded commit.
- `apps/server/src/services/marketplace/flows/update.ts`: `lookupCommit` treats a full-SHA ref as its own commit and memoizes `fetcher.lookupCommitSha`.

## 3) Codebase Map

- **Primary components/modules:** `package-fetcher.ts` (lookup + cache + fetch orchestration), `source-resolvers/{github,url,git-subdir}.ts` (per-form fetch), `core/template-downloader.ts` (`cloneRepository`, credential rewrite), `marketplace-cache.ts` (entry write path), `packages/marketplace/src/source-resolver.ts` (`sourceKeyOf`).
- **Shared dependencies:** `lib/git-safety.ts` (`hardenedGitEnv`), `source-url-policy.ts` (`assertSafeGitRemote`), `@dorkos/marketplace` (`isRealCommitSha`, `sourceKeyOf`).
- **Data flow:** install/preview/`resolveLatest` → `stagePackage` → `fetcher.fetchPackage` → resolver → `resolveCommitSha` (ls-remote) → `cache.getPackage` hit, or `cache.materializePackage` → clone → `{ path, commitSha }` → `install-metadata.json` `commitSha`.
- **Feature flags/config:** none.
- **Potential blast radius:** every remote marketplace install, preview and update check; the on-disk cache layout; tests that stub `TemplateDownloader`.

## 4) Root Cause Analysis

- **Repro steps (measured against a local bare repo, git 2.53):**
  1. `git ls-remote <url> main` in a repo that also has a branch `x/main` returns both `refs/heads/main` and `refs/heads/x/main`. `ls-remote` matches the pattern against the tail of every ref name, and the fetcher takes the first line, which is whichever sorts first. A branch named `a/main` would win over `main`.
  2. `git ls-remote <url> v1` for an annotated tag returns the **tag object** (`828bfae…`), not the commit (`4dc02fb…`, the `^{}` line). The fetcher records the tag object as "the commit".
  3. A `github`/`url` source with `ref: "develop"` clones the default branch (the ref is dropped) and caches it under `develop`'s SHA.
  4. A `git-subdir` source clones the default branch at depth 1 (single-branch), then runs `git checkout <ref>`. A non-default branch or an older commit is not in that clone, so the checkout fails.
  5. A pinned `sha` asks `ls-remote` for a SHA, which matches no ref name, so the lookup degrades to `tmp-<ms>`: the whole-repo forms clone the default branch into `<name>@tmp-<ms>`, and nothing is recorded.
  6. The lookup and the clone are separate network calls. A push between them caches the new tree under the old SHA.
  7. A source with no ref is fetched at `main` (`sourceKeyOf`'s default), not at the repository's default branch. Today that is hidden because whole-repo clones ignore the ref. Honouring the ref without changing the default would break every repo whose default branch is not `main`.
- **Observed vs Expected:** observed: an entry's key, and the recorded commit, name a commit that the cached tree may not be. Expected: they always name the commit whose tree is on disk.
- **Evidence:** the transcript above; `template-downloader.ts:612` (`_ref` unused); `git-subdir.ts:189-205`; `package-fetcher.ts:630-635` (first line wins).
- **Root-cause hypotheses:**
  - (high) The commit is decided before the fetch and never checked against what was fetched. Every symptom above is a variant of this.
  - (high) Three fetch implementations (`execGitClone`, the `git-subdir` ladder, and the lookup) each interpret a ref differently.
- **Decision:** one git primitive decides the commit **from the checkout itself**, and the cache refuses any key that is not a full commit id returned by that primitive.

## 5) Research

- **Potential solutions:**
  1. **Keep the lookup-first shape, fix each resolver:** give `cloneRepository` a `--branch`, make `git-subdir` fetch the ref. Pros: small diff. Cons: `--branch` cannot take a SHA, the lookup→clone race stays, three implementations stay, and existing poisoned entries keep being served.
  2. **Fetch by the looked-up SHA, verify, key by the verified commit (recommended):** resolve the ref precisely (`refs/heads/<ref>`, then `refs/tags/<ref>` peeled, or a full refname, or `HEAD`); `git init` + `git fetch --depth=1 <url> <sha>` so the looked-up commit is exactly what arrives; if the server refuses an unadvertised object, fall back to fetching the resolved **refname** and use the commit that arrived (for a pinned SHA: fetch branches and tags, then require the commit to be present); check out, read `HEAD`, and hand that commit to the cache as the key. Pros: one implementation for all three forms; no race (the SHA is fetched, or the arrived commit is used); pinned SHAs work; the cache can enforce the invariant. Cons: a larger change; a new cache root so older entries are never trusted.
  3. **Full clone then checkout:** correct but downloads whole histories. Rejected for bandwidth.
- **Recommendation:** option 2.
- **Server behaviour that shapes the fallback (measured):**
  - Protocol v2 (the default since git 2.26, and GitHub/GitLab) serves a reachable commit by SHA; `--depth=1 <sha>` works.
  - Protocol v0 with `uploadpack.allowReachableSHA1InWant=false` refuses: `error: Server does not allow request for unadvertised object <sha>`. v2 reports an unknown commit as `not our ref <sha>`.
  - A server without `uploadpack.allowFilter` prints `warning: filtering not recognized by server, ignoring` and **succeeds**. So the existing "filter unsupported" fallback rung never fires on a fetch. Checked against the same local repo.
  - `git ls-remote <url> refs/tags/v1` does not return the peeled `^{}` line; the peeled pattern has to be asked for by name.

## 6) Decisions

| #   | Decision                                                       | Choice                                                                                                                                                                 | Rationale                                                                                                                                          |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Who decides a cache entry's commit                             | The fetch, from the checkout (`git rev-parse HEAD`), never the lookup                                                                                                  | Only the checkout knows what is on disk. The lookup becomes a cache-hit hint and the fetch target.                                                 |
| 2   | How a named ref resolves                                       | Exact refnames only: a full `refs/…` name as given, else `refs/heads/<ref>`, else `refs/tags/<ref>` peeled to its commit; `HEAD` for no ref                            | Matches `git clone --branch` (branch before tag) and never tail-matches another ref.                                                               |
| 3   | The fetch                                                      | `git init` + `git fetch --depth=1 --no-tags <url> <sha>`; blob-filtered and sparse for a subpath                                                                       | The commit asked for is the commit that arrives: no race.                                                                                          |
| 4   | A server that refuses an unadvertised SHA                      | Named ref: fetch the resolved refname and use the commit that arrived. Pinned SHA: fetch every branch and tag (blob-filtered), then require the commit.                | Correct on every server, never a silent downgrade: a pin that is not there fails.                                                                  |
| 5   | A ref that moved between lookup and fetch (fallback path only) | Use the commit that arrived, key it, record it                                                                                                                         | The entry and the record describe the same tree; `resolveLatest` already reports "staging's commit, not the lookup's".                             |
| 6   | Failure modes                                                  | Throw a plain error; never a placeholder in a fetch result or a cache key                                                                                              | "Fail closed". The `tmp-` placeholder survives only on the update check's lookup API (`lookupCommitSha`), which `isRealCommitSha` already rejects. |
| 7   | The default ref                                                | `HEAD` (the repository's default branch) instead of `main`                                                                                                             | Honouring the ref with a `main` default would break repos whose default branch is not `main`. Claude Code's rule is "the default branch".          |
| 8   | Entries written before this change                             | A new cache root (`trees/`); the old `packages/` directory is removed at startup                                                                                       | Old entries cannot be told apart from correct ones, so none is trusted.                                                                            |
| 9   | Where the invariant lives                                      | `MarketplaceCache.materializePackage` takes the commit from the fetch callback and refuses anything that is not a full commit id; `putPackage` (tests only) is removed | One write path for DOR-2249 and DOR-2197 to build on.                                                                                              |
| 10  | Three fetch implementations                                    | One module, `services/marketplace/lib/git-tree.ts`; one resolver for all three git forms; `cloneRepository`/`TemplateDownloader` removed from `template-downloader.ts` | Single-sourced; no dead seam left behind.                                                                                                          |
| 11  | The GitHub token                                               | The existing rewrite, extracted from `execGitClone` so both callers share one gate                                                                                     | `git-subdir` gains the token for GitHub hosts, under the same host rule.                                                                           |

Recommended next step: SPECIFY.
