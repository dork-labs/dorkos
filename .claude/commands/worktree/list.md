---
description: List all git worktrees with port assignments
allowed-tools: Bash(git worktree list:*), Bash(.claude/scripts/worktree-ports.sh:*), Bash(bash .claude/scripts/worktree-ports.sh:*)
category: git
---

# Worktree List

Show all worktrees and their assigned development ports.

## Task

### Step 1: List Worktrees

```bash
git worktree list
```

This gives each worktree's path, HEAD, and checked-out branch.

### Step 2: Read Port Assignments

Ports live in each worktree's `.env` (`DORKOS_PORT` = Express, `VITE_PORT` = Vite), written at creation by `.claude/scripts/worktree-setup.sh`. You cannot read `.env` files directly (the file-guard hook denies them), and recomputing the hash would lie when the setup script has probed past a collision. Use the helper, which extracts only the two port values:

```bash
.claude/scripts/worktree-ports.sh
```

Output is one tab-separated line per worktree: `<folder> <DORKOS_PORT> <VITE_PORT>`. A `?` means that worktree has no `.env` or the key is missing — report its ports as unknown (its setup hook didn't run).

## Output Format

```
Worktrees

  core          → :6242/:6241 (main)     [main worktree]
  core-feat-x   → :4287/:4437 (feat-x)
  core-feat-y   → :4312/:4462 (feat-y)
```
