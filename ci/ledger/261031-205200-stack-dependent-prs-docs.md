---
id: 261031-205200
title: The PR guides say when to stack a PR with gh stack, and that a stack merges only from its top
kind: hygiene
status: proposed
actor: agent
gates: []
prs: [3358]
ratchet-release: []
field-changes: []
---

The `creating-pull-requests` skill and `contributing/ci.md` now say when to stack a
dependent PR with `gh stack` (gh 2.90+) and when to branch from `origin/main`. They
also say that a stack merges only with `gh stack merge` run on its top PR, which sends
every layer through the merge queue together.

Why: `gh pr merge --auto` on a layer whose base is not `main` merges it into the branch
below and skips the queue, so nothing tested it on top of `main`. The guides now say
never to do that.

This is a hygiene change: it changes no gate, job, retry, shard or timeout, and it
claims no speed or flake improvement. It is documentation only.
