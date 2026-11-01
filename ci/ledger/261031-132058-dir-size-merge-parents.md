---
id: 261031-132058
title: The dir-size pre-commit gate does not count a merged parent's files as growth
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-3520. `scripts/check-dir-size.sh` found growth with `git diff --cached
--diff-filter=ACR`, which compares the index to HEAD only. On a merge commit every
file the other parent brought in reads as an add, so merging `main` into a branch
blocked on folders `main` itself had grown (`main` lands by squash on GitHub, where no
hook runs). Reproduced on 2026-10-31: a `--no-commit` merge of `origin/main` into a
branch cut before #3185 failed on `features/canvas/ui` (25), `server/src/lib` (29) and
`core/auth` (27), and lanes had been committing such merges with `LEFTHOOK=0`.

The growth tier now drops any added path that already exists in a `MERGE_HEAD`
parent. A file that is in neither parent (written while resolving the merge) still
counts and still blocks, and the 25-file limit is unchanged. Fixtures (f) and (g) in
`scripts/test-check-dir-size.sh` cover both; (f) fails on the old script.

This is a hygiene change to a local pre-commit gate: it moves no CI job and claims
no CI speed or flake improvement.
