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

For each worktree directory, compute its port assignment using the same algorithm as `.claude/scripts/worktree-setup.sh`:

```bash
# For each worktree folder, compute the port
for dir in $(git worktree list --porcelain | grep '^worktree ' | awk '{print $2}'); do
  folder=$(basename "$dir")
  hash=$(printf '%s' "$folder" | cksum | awk '{print $1}')
  port=$(( (hash % 150) + 4250 ))
  branch=$(git -C "$dir" branch --show-current 2>/dev/null || echo "detached")
  echo "  $folder → :$port ($branch)"
done
```

Note: The main worktree uses port 4242 (from `.env`), not the hash-derived port.

## Output Format

```
Worktrees

  webui         → :4242 (main)           [main worktree]
  webui-feat-x  → :4287 (feat-x)
  webui-feat-y  → :4312 (feat-y)
```
