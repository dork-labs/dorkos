---
description: Remove a git worktree safely
argument-hint: '<branch-name> [--delete-branch]'
allowed-tools: Bash, Read
category: git
---

# Worktree Remove

Remove a git worktree after checking for uncommitted changes.

## Arguments

Parse `$ARGUMENTS` for:

| Argument          | Effect                                              |
| ----------------- | --------------------------------------------------- |
| `<branch-name>`   | **Required.** Branch name of the worktree to remove |
| `--delete-branch` | Also delete the branch after removing the worktree  |

**Examples:**

- `/worktree:remove feat-auth` — Remove worktree, keep branch
- `/worktree:remove feat-auth --delete-branch` — Remove worktree and branch

## Task

### Step 0: Parse Arguments

Extract the branch name and `--delete-branch` flag from `$ARGUMENTS`. If no branch name is provided, report the error and stop.

### Step 1: Safety Checks

**Refuse to remove main/master:**

If branch name is `main` or `master`, report "Cannot remove the main worktree" and stop.

**Check for uncommitted changes:**

```bash
# Find the worktree path
git worktree list | grep "<branch-name>"
```

If the worktree doesn't exist, report and stop.

```bash
# Check for uncommitted changes in the worktree
git -C <worktree-path> status --porcelain
```

If there are uncommitted changes, warn the user and ask for confirmation before proceeding.

### Step 2: Remove Worktree

```bash
git gtr rm <branch-name> --yes
```

If `--delete-branch` was specified:

```bash
git branch -d <branch-name>
```

If the branch hasn't been merged, `git branch -d` will fail safely. Report this and suggest `git branch -D` if the user is certain.

### Step 3: Verify

```bash
git worktree list
```

## Output Format

```
Worktree Removed

Removed: ../<directory-name>/
Branch:  <branch-name> [deleted | kept]

Remaining worktrees:
  <worktree list>
```

## Edge Cases

- **main/master**: Refuse unconditionally
- **Uncommitted changes**: Warn and ask for confirmation
- **Worktree not found**: Report "No worktree found for branch '<name>'"
- **Unmerged branch with --delete-branch**: Report that `-d` failed, suggest `-D` if intentional
- **Currently inside the worktree**: Warn that removal may fail — switch to main worktree first
