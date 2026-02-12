---
description: Validate and push commits with lint, type, and build checks
argument-hint: "(no arguments)"
allowed-tools: Bash, Read, Grep
category: git
---

# Git Push

Push commits to remote after validating that there are no lint, type, or build errors.

## Task

### Step 1: Check Current State

Verify there are commits to push:

```bash
# Check if branch has upstream
git status

# Show unpushed commits
git log @{u}..HEAD --oneline 2>/dev/null || git log --oneline -5
```

If there are no commits to push, report this and stop.

### Step 2: Run Validation Checks

Run all validation checks. All must pass before pushing.

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm build
```

**If any check fails**: Stop and report the errors. Do not push.

### Step 3: Review What Will Be Pushed

Show the commits that will be pushed:

```bash
# Show commits ahead of remote
git log @{u}..HEAD --oneline 2>/dev/null || echo "No upstream branch set"

# Show current branch
git branch --show-current
```

### Step 4: Push to Remote

Push the current branch:

```bash
git push
```

If no upstream is set, push with `-u` flag:

```bash
git push -u origin $(git branch --show-current)
```

### Step 5: Verify

Confirm the push was successful:

```bash
git status
```

## Output Format

```
Git Push

Validation:
  [x] Lint passed
  [x] Typecheck passed
  [x] Build passed

Pushed:
  Branch: [branch-name]
  Commits: X commit(s)
  - [hash] [message]
  - [hash] [message]

Status: Successfully pushed to origin
```

## Edge Cases

- **Lint fails**: Report errors, suggest fixes, do not push
- **Typecheck fails**: Report errors with file locations, do not push
- **Build fails**: Report build errors, do not push
- **No upstream**: Set upstream with `-u origin <branch>`
- **Remote rejected**: Report rejection reason (likely needs pull/rebase)
- **No commits to push**: Report "Already up to date with remote"
- **Uncommitted changes**: Warn user about uncommitted changes (but still push existing commits)
