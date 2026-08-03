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

| Slug                  | Meaning                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `protected-branch`    | The default branch, or the primary checkout.                                                                                     |
| `current-worktree`    | The one this session is standing in.                                                                                             |
| `uncommitted-changes` | Tracked or untracked work exists only in that working tree.                                                                      |
| `ignored-content`     | Ignored files git would delete that are not regenerable — a `.temp/` handoff, the dev database under `apps/server/.temp/.dork/`. |
| `pr-open`             | Someone is still reviewing it.                                                                                                   |
| `pr-closed-unmerged`  | A human stopped this work; the branch is its only record.                                                                        |
| `commits-after-merge` | Pushed after the merge, so main has never seen those commits.                                                                    |
| `pushed-no-pr`        | On origin but never proposed — work in flight.                                                                                   |
| `unpushed-commits`    | Commits that exist nowhere else.                                                                                                 |
| `pr-state-unknown`    | GitHub could not be asked, or the PR listing may have been truncated. Not the same as "no PR".                                   |
| `unreadable-payload`  | A field the gate needs was missing, mistyped, or unmeasurable.                                                                   |

### Step 3: Remove, if asked

Only when `$ARGUMENTS` contains `--fix`:

```bash
bash scripts/worktree-janitor.sh --fix
```

Report what was removed and what failed. If anything failed, say so plainly and
name it: the janitor does not pass `--force`, so git's own refusal is a second
opinion on anything that changed between the report and the write. A locked
worktree and a permission error look the same way.

Each removal is appended to `~/.dork/worktree-janitor.log` with the deleted SHA.
That line is the only recovery handle — `git branch -D` deletes the branch's
reflog too — so point the user at it if something went that should not have:
`git branch <name> <sha>`.

## Notes

- **Branches on origin are not this command's job.** GitHub deletes merged head
  branches on its own — the repo's "automatically delete head branches" setting,
  enabled 2026-08-03, which covers everything merged from that date on. It did
  not clear the earlier backlog; that was deleted by hand on 2026-08-01
  (`research/20260801_worktree-and-branch-sweep.md`). This command cleans what
  GitHub cannot see: local worktrees and local refs.
- Safe to run any time without `--fix`; it fetches, then only reads.
- If `gh` cannot be reached, or the pull request listing may have been truncated,
  every branch reports `pr-state-unknown` and nothing is reaped. Verified with a
  failing `gh` stub, because an earlier version claimed this and did the
  opposite: it told the gate `NONE`, which means "nobody ever proposed this
  branch" rather than "I could not ask."
