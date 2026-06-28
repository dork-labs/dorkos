---
description: Create an isolated git worktree for parallel feature work
argument-hint: '<branch-name> [--from-current]'
allowed-tools: Bash(git gtr:*), Bash(git rev-parse:*), Bash(git worktree list:*), Read, EnterWorktree, AskUserQuestion
category: git
---

# Worktree Create

Create an isolated git worktree with automatic dependency installation and port allocation.

## Arguments

Parse `$ARGUMENTS` for:

| Argument         | Effect                                               |
| ---------------- | ---------------------------------------------------- |
| `<branch-name>`  | **Required.** Name of the branch/worktree to create  |
| `--from-current` | Base the new branch on the current branch (not main) |

**Examples:**

- `/worktree:create feat-auth` — New worktree from main
- `/worktree:create feat-auth --from-current` — New worktree from current branch

## Task

### Step 0: Parse Arguments

Extract the branch name and `--from-current` flag from `$ARGUMENTS`. If no branch name is provided, report the error and stop.

### Step 1: Validate Prerequisites

Run these checks. Stop on any failure:

```bash
# Verify gtr is installed
git gtr --version
```

```bash
# Verify we're in the main worktree: the two paths below are equal only
# there — in a secondary worktree --git-dir points into .git/worktrees/
git rev-parse --git-dir --git-common-dir
```

If the two paths differ, the current directory is a secondary worktree — warn the user and stop.

```bash
# Check existing worktrees
git worktree list
```

Scan the output — if a worktree already exists for `<branch-name>`, report its location and stop.

### Step 2: Create Worktree

```bash
# From main (default)
git gtr new <branch-name> --yes

# OR from current branch (if --from-current)
git gtr new <branch-name> --from-current --yes
```

This will:

1. Create a sibling directory `../<repo>-<branch-name>/`
2. Copy gitignored files from the main repo (`.env`, `.mcp.json`, `.vercel/`) per `.gtrconfig`
3. Run `pnpm install` (from `.gtrconfig` postCreate hook)
4. Run `.claude/scripts/worktree-setup.sh` (patches `.env` with unique `DORKOS_PORT` + `VITE_PORT`)

### Step 3: Report Results

```bash
# Show the new worktree
git worktree list
```

### Step 4: Offer to Switch the Session

Offer to move the current session into the new worktree using the EnterWorktree tool, passing `path` = the new worktree's location from Step 3. EnterWorktree accepts a gtr worktree this way — the `path` only needs to appear in `git worktree list` (it does not need to live under `.claude/worktrees/`). If accepted, all subsequent work happens inside the worktree — no CLI restart needed; ExitWorktree returns later. If declined, the user can `cd` there themselves or start a fresh session in that directory.

## Output Format

```
Worktree Created

Location: <worktree-path>
Branch:   <branch-name>
Ports:    <DORKOS_PORT>/<VITE_PORT>

Next steps:
  - I can switch this session into it (EnterWorktree), or
  - cd <worktree-path> && pnpm dev
```

## Edge Cases

- **gtr not installed**: Report "git-worktree-runner (gtr) is not installed. Install via: brew install coderabbitai/tap/git-gtr"
- **Already in a worktree**: Report "You're already in a worktree. Switch to the main working tree first."
- **Branch already exists as worktree**: Report the existing worktree location
- **Branch name invalid**: Let git report the error naturally
- **pnpm install fails**: Report the error but note the worktree was created (user can fix manually)
