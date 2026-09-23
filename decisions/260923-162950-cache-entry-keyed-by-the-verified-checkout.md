---
id: 260923-162950
title: A marketplace cache entry is keyed by the commit its checkout verifiably holds
status: draft
created: 2026-09-23
spec: marketplace-fetch-integrity
superseded-by: null
---

# 260923-162950. A marketplace cache entry is keyed by the commit its checkout verifiably holds

## Status

Draft (extracted from spec: marketplace-fetch-integrity)

## Context

ADR-0232 keys the package cache `<name>@<sha>` and treats an entry as immutable, and DOR-147 records that SHA as the commit a package was fetched at. The SHA came from a `git ls-remote` made before the clone, and nothing compared it with what the clone brought back. Three fetch implementations each read a ref differently: whole-repo clones ignored it, `git-subdir` cloned the default branch and then checked the ref out, and `ls-remote` tail-matched names and returned tag objects. So an entry, and the recorded pin, could name a commit its tree was not (DOR-2248).

## Decision

One git primitive fetches every git source form. It resolves a ref to an exact refname and commit (branch before tag, tags peeled, a full SHA as itself), fetches that commit by SHA at depth 1, and, only when a server refuses an unadvertised commit, falls back to the exact refname (or, for a pinned commit, to every branch and tag, then requires the commit). It then checks out the commit and reads `HEAD`. The cache takes its key from that verified commit, and refuses any key that is not a full commit id. A sparse (`git-subdir`) checkout is a different tree from the whole repository at the same commit, so its key also carries a digest of the subfolder: `<name>@<sha>~<digest>`. The git floor is measured, not assumed: git 2.26 through 2.49 run the exact command sequence in Docker (`scripts/git-floor-probe.sh`). A source with no ref is fetched at the repository's default branch (`HEAD`), not `main`. Entries written before this decision live under the old `packages/` root, are never read, and are removed at startup; verified entries live under `trees/`.

## Consequences

### Positive

- An entry and the recorded pin always describe the tree on disk, for branches, tags, and pinned commits, and without a lookup-to-fetch race on servers that serve commits by SHA.
- One fetch implementation and one cache write path for pruning (DOR-2249) and content hashing (DOR-2197) to build on.
- Pinned commits and non-default branches install at all; before, they failed or installed the default branch.
- The update check's lookup and the install resolve a ref the same way.

### Negative

- Every package is fetched again once after upgrading.
- On a server that refuses unadvertised commits, a pinned commit costs a blob-filtered fetch of every branch and tag.
- Git older than 2.26 cannot install from a git source, and git older than 2.31 cannot send the GitHub token for a private repository.
- Sidecars that recorded `ref: 'main'` need a tolerant comparison (`HEAD` now against `main` then), because an update check never rewrites them.
