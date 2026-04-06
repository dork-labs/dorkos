---
description: List all git worktrees with port assignments
allowed-tools: Bash
category: git
---

# Worktree List

Show all worktrees and their assigned development ports.

## Task

### Step 1: List Worktrees

```bash
git worktree list
```

### Step 2: Show Port Assignments

For each worktree directory, compute its port pair using the same algorithm as `.claude/scripts/worktree-setup.sh` (DORKOS_PORT = Express, VITE_PORT = Vite):

```bash
# For each worktree folder, compute the port pair
for dir in $(git worktree list --porcelain | grep '^worktree ' | awk '{print $2}'); do
  folder=$(basename "$dir")
  hash=$(printf '%s' "$folder" | cksum | awk '{print $1}')
  offset=$(( hash % 150 ))
  dorkos=$(( offset + 4250 ))
  vite=$(( offset + 4400 ))
  branch=$(git -C "$dir" branch --show-current 2>/dev/null || echo "detached")
  echo "  $folder → :$dorkos/:$vite ($branch)"
done
```

Note: The main worktree uses ports 6242/6241 (from `.env`), not the hash-derived ports.

## Output Format

```
Worktrees

  webui         → :6242/:6241 (main)     [main worktree]
  webui-feat-x  → :4287/:4437 (feat-x)
  webui-feat-y  → :4312/:4462 (feat-y)
```
