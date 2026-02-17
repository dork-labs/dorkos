---
description: Comprehensive code cleanup using Knip and best practices for codebase maintenance
argument-hint: '[check|fix|deep] [--deps] [--exports] [--files] [--no-commit]'
allowed-tools: Bash, Read, Grep, Glob, Edit, AskUserQuestion, TodoWrite
category: application
---

# Application Cleanup

Comprehensive codebase maintenance using Knip for dead code detection, combined with linting, type checking, and security auditing.

## Arguments

Parse `$ARGUMENTS` for these options:

### Modes (mutually exclusive, default: check)

| Mode    | Description                                    |
| ------- | ---------------------------------------------- |
| `check` | Report issues only, no changes (default)       |
| `fix`   | Auto-fix safe issues (unused imports, exports) |
| `deep`  | Full cleanup with manual review prompts        |

### Filters (combine with any mode)

| Flag          | Effect                            |
| ------------- | --------------------------------- |
| `--deps`      | Focus on unused dependencies only |
| `--exports`   | Focus on unused exports only      |
| `--files`     | Focus on unused files only        |
| `--no-commit` | Skip creating cleanup commit      |

### Examples

```bash
/app:cleanup                    # Check mode - report all issues
/app:cleanup fix                # Auto-fix safe issues
/app:cleanup deep               # Full cleanup with prompts
/app:cleanup check --deps       # Only check unused dependencies
/app:cleanup fix --exports      # Auto-fix unused exports only
```

## Task

Execute phases based on the selected mode.

---

## Phase 1: Pre-Cleanup Validation

### Step 1.1: Verify Clean Git State

```bash
git status --porcelain
```

If there are uncommitted changes:

```
⚠️  You have uncommitted changes. Cleanup works best with a clean working directory.
```

Use AskUserQuestion:

- Proceed anyway (changes will be mixed with cleanup)
- Stop and let me commit first

### Step 1.2: Run Baseline Checks

Ensure the codebase is in a working state before cleanup:

```bash
pnpm typecheck
```

If typecheck fails, stop and report. The codebase must compile before cleanup.

---

## Phase 2: Dead Code Analysis (Knip)

### Step 2.1: Run Knip Analysis

```bash
pnpm knip 2>&1
```

### Step 2.2: Categorize Issues

Parse Knip output and categorize:

| Category                  | Risk   | Auto-fixable                         |
| ------------------------- | ------ | ------------------------------------ |
| **Unused files**          | High   | No (manual review required)          |
| **Unused dependencies**   | Medium | Yes (with `knip --fix`)              |
| **Unused exports**        | Low    | Yes (with `knip --fix`)              |
| **Unused types**          | Low    | Yes (with `knip --fix`)              |
| **Duplicate exports**     | Info   | Manual                               |
| **Unlisted dependencies** | Medium | Manual (need to add to package.json) |

### Step 2.3: Present Analysis

```markdown
## Dead Code Analysis

### Summary

| Category              | Count | Action         |
| --------------------- | ----- | -------------- |
| Unused files          | X     | Manual review  |
| Unused dependencies   | X     | Auto-removable |
| Unused exports        | X     | Auto-removable |
| Unlisted dependencies | X     | Need to add    |

### Unused Files

Files that are not imported anywhere:

- `path/to/file.ts` — [brief context if possible]

### Unused Dependencies

Packages in package.json not used in code:

- `package-name` — [what it's for]

### Unused Exports

Exported symbols not imported anywhere:

- `functionName` in `path/to/file.ts:line`

### Unlisted Dependencies

Used in code but not in package.json:

- `package-name` — used in `path/to/file.ts`
```

**For `check` mode with no filters**: Continue to Phase 3.
**For `check` mode with filters**: Show only filtered categories, then stop.

---

## Phase 3: Lint Analysis

### Step 3.1: Run ESLint with Report

```bash
pnpm lint 2>&1
```

### Step 3.2: Identify Fixable Issues

Note which issues are auto-fixable vs require manual intervention.

### Step 3.3: Present Lint Summary

```markdown
## Lint Analysis

| Category | Count | Auto-fixable |
| -------- | ----- | ------------ |
| Errors   | X     | Y            |
| Warnings | X     | Y            |

### Top Issues

- [issue-type]: X occurrences
- [issue-type]: X occurrences
```

**For `check` mode**: Stop here and display full report.

---

## Phase 4: Auto-Fix (fix and deep modes)

### Step 4.1: Create Cleanup Branch (if not on feature branch)

Check current branch:

```bash
git branch --show-current
```

If on `main`:

```bash
git checkout -b chore/cleanup-$(date +%Y%m%d)
```

### Step 4.2: Run Knip Auto-Fix

```bash
pnpm knip --fix 2>&1
```

This will:

- Remove unused dependencies from package.json
- Remove `export` keyword from unused exports
- NOT delete files (requires `--allow-remove-files`)

### Step 4.3: Run ESLint Auto-Fix

```bash
pnpm lint --fix 2>&1
```

### Step 4.4: Reinstall Dependencies

If dependencies were removed:

```bash
pnpm install
```

### Step 4.5: Validate After Fix

```bash
pnpm typecheck
pnpm lint
```

If validation fails:

- Report which fix caused the issue
- Suggest rollback: `git checkout -- .`
- Stop and let user decide

**For `fix` mode**: Continue to Phase 6 (commit).

---

## Phase 5: Deep Cleanup (deep mode only)

### Step 5.1: Review Unused Files

For each unused file, present:

````markdown
### Unused File: `path/to/file.ts`

**Contents preview:**

```typescript
[first 20 lines of file]
```
````

**Analysis:**

- File purpose: [inferred from name/contents]
- Last modified: [git log date]
- Similar files exist: [yes/no]

**Recommendation:** [Keep as template | Safe to delete | Needs investigation]

````

Use AskUserQuestion for each file:
- Delete this file
- Keep this file (add to knip.config.ts ignore)
- Skip for now

### Step 5.2: Review Unlisted Dependencies

For each unlisted dependency:

```markdown
### Unlisted Dependency: `package-name`

**Used in:**
- `path/to/file.ts:line` — [usage context]

**Package info:**
- Purpose: [from npm description]
- Is it a peer dependency? [check if required by another package]
````

Use AskUserQuestion:

- Add to dependencies
- Add to devDependencies
- Remove usage (it's probably dead code)

### Step 5.3: Handle Configuration Hints

If Knip reports configuration hints:

```markdown
### Configuration Optimization

Knip suggests these config improvements:

| Item           | Location       | Suggestion                        |
| -------------- | -------------- | --------------------------------- |
| `package-name` | knip.config.ts | Remove from ignoreDependencies    |
| `pattern`      | knip.config.ts | Refine entry pattern (no matches) |
```

Offer to apply these optimizations.

---

## Phase 6: Commit Changes (unless --no-commit)

### Step 6.1: Stage Changes

```bash
git add -A
git status
```

### Step 6.2: Create Cleanup Commit

```bash
git commit -m "$(cat <<'EOF'
chore: codebase cleanup

- Removed X unused dependencies
- Removed X unused exports
- Fixed X lint issues
- [other changes]

Generated with Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7: Post-Cleanup Report

### Step 7.1: Summary

```markdown
## Cleanup Complete

### Changes Made

| Category     | Before | After | Removed |
| ------------ | ------ | ----- | ------- |
| Dependencies | X      | Y     | Z       |
| Exports      | X      | Y     | Z       |
| Lint issues  | X      | Y     | Z fixed |

### Files Deleted

- `path/to/file.ts`

### Configuration Updated

- Updated `knip.config.ts` ignore patterns

### Validation

✅ Typecheck passed
✅ Lint passed
✅ Build... [run if major changes]

### Next Steps

- Review changes with `git diff HEAD~1`
- Run `pnpm dev` to verify app works
- Merge to main when ready
```

---

## Knip Configuration Reference

The project uses `knip.config.ts` for configuration. Key patterns:

### Adding Exceptions

To keep intentionally unused code, add to `ignore`:

```typescript
ignore: [
  'src/components/ui/**', // Component library
  'src/path/to/file.ts', // Specific file
];
```

To keep intentionally unused dependencies, add to `ignoreDependencies`:

```typescript
ignoreDependencies: [
  'package-name', // Reason why it's kept
];
```

### Boilerplate Pattern

This project uses an "add-on-demand" pattern for Shadcn UI components:

- All Shadcn components are in `knip.config.ts` ignore list
- As components are used, remove them from the ignore list
- This allows Knip to catch genuinely unused components

---

## Rollback Strategy

If cleanup breaks something:

```bash
# Undo all changes
git checkout -- .

# Or revert the commit
git revert HEAD
pnpm install
```

---

## Best Practices

1. **Run cleanup regularly** — Monthly or before major releases
2. **Start with check mode** — Review before making changes
3. **Small batches** — Don't clean everything at once
4. **Test after cleanup** — Run the app to verify nothing broke
5. **Review unused files carefully** — They might be needed for future features
6. **Keep scaffold templates** — Example files help new developers

---

## Integration with Other Commands

| Command        | Relationship                              |
| -------------- | ----------------------------------------- |
| `/app:upgrade` | Run cleanup BEFORE upgrading dependencies |
| `/git:commit`  | Cleanup commits follow same validation    |
| `/git:push`    | Full validation before push               |

---

## Notes

- Knip is configured in `knip.config.ts`
- The boilerplate intentionally keeps Shadcn UI components as a library
- FSD layer structure (shared, entities, features, widgets) documented in `contributing/project-structure.md`
