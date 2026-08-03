---
description: Remove worktrees and local branches whose work has landed
argument-hint: '[--fix]'
allowed-tools: Bash(scripts/worktree-janitor.sh:*), Bash(bash scripts/worktree-janitor.sh:*)
category: git
---

# Worktree Prune

Delete the worktrees and local branches that finished work left behind. Reports
by default and writes only when asked.

## Arguments

| Argument | Effect                                              |
| -------- | --------------------------------------------------- |
| _(none)_ | Show what would be removed and why. Writes nothing. |
| `--fix`  | Actually remove them.                               |

## Task

### Step 1: Report

Run the janitor from the repo root:

```bash
bash scripts/worktree-janitor.sh
```

It prints one line per worktree and local branch: `REAP` for the ones it can
prove are safe to delete, or `KEEP <reason>` with a machine-readable slug for
everything else.

### Step 2: Show the user the plan

Present the plan as-is. Do not re-derive it, argue with it, or delete anything
the script listed as `KEEP` — the decision lives in
`scripts/should-reap-worktree.sh`, every refusal it makes is pinned by fixtures,
and the slugs mean what they say:

| Slug                  | Meaning                                                       |
| --------------------- | ------------------------------------------------------------- |
| `protected-branch`    | The default branch.                                           |
| `current-worktree`    | The one this session is standing in.                          |
| `uncommitted-changes` | Work exists only in that working tree.                        |
| `pr-open`             | Someone is still reviewing it.                                |
| `pr-closed-unmerged`  | A human stopped this work; the branch is its only record.     |
| `commits-after-merge` | Pushed after the merge, so main has never seen those commits. |
| `pushed-no-pr`        | On origin but never proposed — work in flight.                |
| `unpushed-commits`    | Commits that exist nowhere else.                              |
| `pr-state-unknown`    | GitHub could not be asked. Not the same as "no PR".           |

### Step 3: Remove, if asked

Only when `$ARGUMENTS` contains `--fix`:

```bash
bash scripts/worktree-janitor.sh --fix
```

Report what was removed and what failed. If anything failed, say so plainly and
name it — a failed removal usually means the worktree gained changes between the
report and the write.

## Notes

- **Branches on origin are not this command's job.** GitHub deletes merged head
  branches on its own (the repo's "automatically delete head branches" setting).
  This command cleans what GitHub cannot see: local worktrees and local refs.
- Safe to run any time without `--fix`; it fetches, then only reads.
- If `gh` is not authenticated, every branch reports `pr-state-unknown` and
  nothing is reaped. That is the intended failure direction.
