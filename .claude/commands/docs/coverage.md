---
description: Verify every MDX file in docs/ is tracked in contributing/INDEX.md
argument-hint: ''
allowed-tools: Read, Edit, Grep, Glob, Bash(find:*), AskUserQuestion
category: documentation
---

# Documentation Coverage Check

Verify that every MDX file in `docs/` is tracked in `contributing/INDEX.md`. Untracked files are invisible to the docs reconciliation system and will drift without warning.

## Task

### 1. Inventory all MDX files

List every `.mdx` file under `docs/`:

```bash
find docs/ -name '*.mdx' | sort
```

### 2. Parse INDEX.md coverage

Read `contributing/INDEX.md` and extract all MDX file paths from the **External Docs Coverage** table (the `| MDX File |` column). Also extract from the **External Docs Maintenance** table to catch any that appear in tracking but not in the coverage map.

### 3. Compare and report

For each MDX file found on disk, check if it appears in the INDEX.md coverage table.

**Skip these from the comparison** (auto-generated, not hand-authored):

- Files under `docs/api/` (auto-generated from OpenAPI spec)

**Report format:**

```markdown
## Documentation Coverage Report

### Summary

- Total MDX files on disk: N
- Tracked in INDEX.md: N
- Auto-generated (skipped): N
- **Untracked: N**

### Untracked Files (need adding to INDEX.md)

| File                    | Suggested Source Patterns |
| ----------------------- | ------------------------- | --------- |
| `docs/path/to/file.mdx` | `suggested                | patterns` |

### Coverage Map Entries for Missing Files

No action needed — INDEX.md already tracks all hand-authored docs.
```

### 4. Offer to fix

If untracked files are found, ask:

```
Would you like me to add the missing files to contributing/INDEX.md?
- Yes, add them now
- No, just report
```

If yes, add each missing file to both the External Docs Coverage table and the External Docs Maintenance table in INDEX.md. For source patterns, inspect the file content to determine which source code areas it documents.

### 5. Also check for stale entries

Check if any files listed in INDEX.md no longer exist on disk (deleted or renamed). Report those as well so they can be cleaned up.

## When to Run

- After creating or renaming docs files
- Periodically as a health check
- Before a release to ensure nothing drifted
