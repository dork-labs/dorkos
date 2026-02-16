---
description: Create an isolated git worktree for parallel feature work
argument-hint: '<branch-name> [--from-current]'
allowed-tools: Bash, Read
category: git
---

# Worktree Create

Create an isolated git worktree with automatic dependency installation and port allocation.

## Arguments

Parse `$ARGUMENTS` for:

| Argument         | Effect                                              |
| ---------------- | --------------------------------------------------- |
| `<branch-name>`  | **Required.** Name of the branch/worktree to create |
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
# Verify we're not already in a worktree
git rev-parse --is-inside-work-tree
git worktree list
```

Check the output — if the current directory is a secondary worktree (not the main one), warn the user and stop.

```bash
# Verify no existing worktree for this branch
git worktree list | grep -w "<branch-name>" || true
```

If a worktree already exists for this branch, report it and stop.

### Step 2: Create Worktree

```bash
# From main (default)
git gtr new <branch-name> --yes

# OR from current branch (if --from-current)
git gtr new <branch-name> --from-current --yes
```

This will:
1. Create a sibling directory `../<repo>-<branch-name>/`
2. Copy `.env.example` (from `.gtrconfig`)
3. Run `npm install` (from `.gtrconfig` postCreate hook)
4. Run `.claude/scripts/worktree-setup.sh` (assigns unique port)

### Step 3: Report Results

```bash
# Show the new worktree
git worktree list
```

## Output Format

```
Worktree Created

Location: ../<directory-name>/
Branch:   <branch-name>
Port:     <assigned-port>

Next steps:
  cd ../<directory-name>/
  npm run dev
```

## Edge Cases

- **gtr not installed**: Report "git-worktree-runner (gtr) is not installed. Install via: brew install nicholasgasior/gtr/gtr"
- **Already in a worktree**: Report "You're already in a worktree. Switch to the main working tree first."
- **Branch already exists as worktree**: Report the existing worktree location
- **Branch name invalid**: Let git report the error naturally
- **npm install fails**: Report the error but note the worktree was created (user can fix manually)
