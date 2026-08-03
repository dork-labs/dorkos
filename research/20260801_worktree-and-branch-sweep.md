---
title: 'Worktree and branch sweep — what had accumulated, and why'
date: 2026-08-01
type: audit
status: current
tags: [worktrees, git, harness, cleanup, tooling]
feature_slug: worktree-branch-janitor
---

# Worktree and branch sweep, 2026-08-01

This exists so the numbers quoted in `scripts/should-reap-worktree.sh`,
`scripts/worktree-janitor.sh`, and three skills are checkable instead of
restated. A code review pointed out that the figures appeared in five files with
no source, which reads as corroboration when it is one assertion — and one of
them turned out to be wrong (see [Correction](#correction)).

Raw per-item record, with every deleted ref and SHA:
`~/.dork/branch-cleanup-20260801.md` (local to the machine that ran the sweep,
outside the repo because it contains no project content and is a recovery aid,
not documentation).

## What was there

Measured immediately before the sweep, 2026-08-01:

| Thing                               | Before | Removed | After |
| ----------------------------------- | ------ | ------- | ----- |
| Local branches                      | 193    | 180     | 13    |
| Branches on origin                  | 414    | 402     | 12\*  |
| Stray `refs/remotes` leftovers      | 3      | 3       | 0     |
| Worktrees (excluding main checkout) | 116    | 107     | 9     |

\* 12 at sweep time; two more merged the following day and were removed by the
janitor itself.

Against that: **710 pull requests in the repo's history, 5 of them open.**

Disk: a provisioned worktree measures **3.5 GB** (`du -sh` on
`~/.dork/workspaces/dorkos/fix-config-transient-io`, 2026-08-03). Most of the 107
were provisioned, so the sweep reclaimed on the order of a few hundred GB. The
exact total was not captured before deletion and is not reconstructible — treat
"~3.5 GB each" as measured and any total as an estimate.

## What the worktrees were

Classified by directory name over the 107 removed:

| Shape                                                                   | Count | Share |
| ----------------------------------------------------------------------- | ----- | ----- |
| Review checkouts (`rv*`, `review-*`, `pr*`)                             | 47    | 44%   |
| Everything else (`feat-`, `fix-`, `spec-`, `chore-`, `ci-`, `test-`, …) | 60    | 56%   |

Review checkouts are the largest single category. They are also the only
category whose workflow had **no** cleanup step of any kind, which is why the
janitor work targeted `requesting-code-review` first.

## Why nothing collected them

Three causes, in order of how much each contributed:

1. **`delete_branch_on_merge` was `false`** on `dork-labs/dorkos`. Every merged
   pull request since the repo began left its branch on origin. That single
   setting accounts for essentially all 402 remote branches. Enabled 2026-08-03.
2. **The review workflow said nothing about cleanup.**
   `.claude/skills/requesting-code-review/SKILL.md` contained no mention of a
   worktree, a branch, or cleanup. 47 worktrees.
3. **`/flow:done`'s cleanup could not fire.** It offers removal only when the
   work ran through `/flow`, the worktree was recorded in `04-implementation.md`,
   and the branch is already merged. `main` merges through a queue and
   `merge-tail.yml` arms auto-merge on a 10-minute tick, so the merge lands after
   the session that opened the PR has ended — there is nobody there to accept an
   offer, and an agent in an autonomous loop reads "offer" as optional.

No hook, cron, or CI job pruned anything. `session-maintenance.sh` does not
mention worktrees.

## What was deliberately kept

13 local branches: the 5 open PRs, 3 closed-but-unmerged PRs (stopped work, and
the branch is its only record), the 2 worktrees holding uncommitted changes, and
two branches whose work exists nowhere else —

- `investigate-site-dev-cpu`: one commit, never pushed, no PR. A documented fix
  for a Turbopack dev-cache defect that pinned the marketing-site dev server at
  200-260% CPU for 14 hours while idle.
- `ci-browser-suite-gate` (DOR-656): pushed, no PR, and the browser/migration
  gate it adds is not in `main`.

Both shapes are now refusals in the janitor's gate (`unpushed-commits`,
`pushed-no-pr`), with a fixture each.

## Correction

An earlier draft of this work claimed **"87 of 116 worktrees (82%) were review
checkouts"** and repeated it in five files. That number was wrong. It came from
grepping the recovery record with a pattern loose enough to match commit
subjects as well as worktree names, so any entry whose subject contained
"review" was counted.

Counting the worktree name field alone gives **47 of 107 (44%)**. The conclusion
it supported — that review checkouts are the largest single category and the one
with no cleanup path — survives; the magnitude does not. Corrected everywhere
2026-08-03.

The generalisable bit: a number restated in five places looks corroborated and
is still one measurement. Cite the source, or write the number down once.
