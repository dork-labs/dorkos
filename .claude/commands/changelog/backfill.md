---
description: Populate [Unreleased] changelog section from commits since last tag
argument-hint: [--since TAG]
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

# Changelog Backfill Command

Analyze commits since the last release and populate the [Unreleased] section with any missing entries. Use this before `/system:release` to ensure all changes are captured.

## Arguments

- `$ARGUMENTS` - Optional flags:
  - `--since TAG` - Compare against a specific tag (default: most recent tag)
  - `--dry-run` - Preview without making changes

## When to Use

- Before running `/system:release` to ensure complete release notes
- After pushing commits that didn't use conventional commit format
- To catch up changelog after merging branches or rebasing
- When changelog-populator hook wasn't installed for some commits

## Process

### Step 1: Run Analysis

```bash
python3 .claude/scripts/changelog_backfill.py --json $ARGUMENTS
```

Parse the JSON output to get:
- `since_tag` - The tag being compared against
- `commits_analyzed` - Total commits examined
- `existing_entries` - Entries already in [Unreleased]
- `missing_entries` - Proposed new entries
- `already_covered` - Commits already represented
- `skipped_commits` - Non-conventional commits

### Step 2: Present Analysis

If there are missing entries, present them to the user:

```markdown
## Changelog Backfill Analysis

**Since**: v0.8.0
**Commits analyzed**: 12
**Already in changelog**: 5
**Missing entries**: 4

### Proposed Additions

#### Added
- Add CSS snippet to hide system files (eff351f)
  *Original*: `feat: Add CSS snippet to hide system files from Obsidian file explorer`

#### Fixed
- Fix theme commands failing from different directories (9e92fbe)
  *Original*: `fix: Use relative paths in theme commands instead of $CLAUDE_PROJECT_DIR`

---

**Note**: Entries are derived from conventional commits. The "Original" shows the raw commit message for context.
```

### Step 3: Get User Approval

Use AskUserQuestion:

```
header: "Backfill"
question: "How would you like to proceed with these changelog entries?"
options:
  - label: "Apply all entries (Recommended)"
    description: "Add all proposed entries to [Unreleased] section"
  - label: "Review and edit individually"
    description: "I'll present each entry for approval/editing"
  - label: "Skip backfill"
    description: "Don't add any entries"
```

### Step 4: Apply or Edit

**If "Apply all":**
```bash
python3 .claude/scripts/changelog_backfill.py --apply
```

**If "Review individually":**
For each missing entry, use AskUserQuestion:

```
header: "Entry"
question: "Add this entry to ### [Section]?"
options:
  - label: "Yes, add as-is"
    description: "[entry text]"
  - label: "Yes, but let me edit"
    description: "I'll provide an edited version"
  - label: "Skip this entry"
    description: "Don't add to changelog"
```

If user wants to edit, prompt for the new entry text, then add it manually using Edit tool.

### Step 5: Report Results

```markdown
## Backfill Complete

**Added to [Unreleased]:**
- 3 entries in ### Added
- 2 entries in ### Fixed

**Run `/system:release` when ready to create a release.**

Or continue developing - the changelog-populator hook will add future commits automatically.
```

## Edge Cases

### No Missing Entries

```markdown
## Changelog is Up-to-Date

All commits since v0.8.0 are already represented in [Unreleased].

Nothing to backfill.
```

### No Tags Exist

```markdown
## No Previous Release Found

This appears to be the first release. Analyzing all commits...

[continue with full history]
```

### Non-Conventional Commits

Inform the user about commits that weren't captured:

```markdown
## Note: Skipped Commits

The following commits don't use conventional format and weren't added:
- `abc1234`: Update README
- `def5678`: Various fixes

If these should be in the changelog, add them manually to `CHANGELOG.md`.
```

## User-Friendly Transformation

The script transforms commit messages to be more user-friendly, but the transformation is basic. For important releases, consider manually improving entries:

| Commit Message | Auto-Generated | Better |
|---------------|----------------|--------|
| `feat: Add obsidian_manager.py` | Add obsidian_manager.py | Open files in Obsidian without manual vault setup |
| `fix: Use relative paths` | Use relative paths | Fix commands failing when run from different directories |

Review entries in `CHANGELOG.md` before releasing and apply the "You can now..." test from the `changelog-writing` skill.

## Related Commands

- `/system:release` - Create a release (will include backfill in Phase 3)
- `/system:review changelog` - Review changelog for quality

## Related Files

- `.claude/scripts/changelog_backfill.py` - Core backfill logic
- `.claude/hooks/changelog-populator.py` - Auto-populates on new commits
- `.claude/skills/changelog-writing/SKILL.md` - Style guide for entries
