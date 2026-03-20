---
description: Find missing changelog entries from git commits since last tag
argument-hint: '[tag] [--dry-run]'
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion
---

# Changelog Backfill

Find commits since the last tag (or a specified tag) that are not represented in the [Unreleased] section of CHANGELOG.md, and propose entries for them.

## Arguments

- `$ARGUMENTS` - Optional: specific tag to compare from, or `--dry-run`
  - _(no argument)_ - Compare from latest tag
  - `v0.2.0` - Compare from specified tag
  - `--dry-run` - Show proposed entries without applying

## Process

### Step 1: Determine Base Tag

```bash
# Use argument if provided, otherwise latest tag
TAG="${1:-$(git describe --tags --abbrev=0 2>/dev/null)}"
echo "Comparing from: $TAG"
```

If no tags exist, report and stop.

### Step 2: Get Commits Since Tag

```bash
git log $TAG..HEAD --oneline --no-merges
```

### Step 3: Filter and Categorize

Process each commit line:

**Include** (conventional commit types):

- `feat:` / `feat(scope):` -> **Added**
- `fix:` / `fix(scope):` -> **Fixed**
- `refactor:` / `refactor(scope):` -> **Changed**
- `perf:` / `perf(scope):` -> **Changed**

**Skip** (not user-facing):

- `chore:` / `ci:` / `test:` / `docs:` / `build:` / `style:`

### Step 4: Compare with Existing Entries

Read the [Unreleased] section of CHANGELOG.md. For each categorized commit, check if a similar entry already exists (fuzzy match on key terms). Only propose genuinely missing entries.

### Step 5: Present Proposals

Show proposed entries grouped by category:

```markdown
## Proposed Changelog Entries

**Tag**: [tag]
**Commits analyzed**: [count]
**Already covered**: [count]
**New entries proposed**: [count]

### Added

- [user-friendly description] ([sha])

### Changed

- [user-friendly description] ([sha])

### Fixed

- [user-friendly description] ([sha])
```

Rewrite each entry following the writing-changelogs skill:

- Focus on what users can DO
- Use imperative verbs
- Explain benefits, not mechanisms

### Step 6: User Approval

Use AskUserQuestion:

```
header: "Backfill Entries"
question: "Add these entries to [Unreleased]?"
options:
  - label: "Yes, add all"
    description: "Add all proposed entries to CHANGELOG.md"
  - label: "Review individually"
    description: "Approve each entry one by one"
  - label: "Skip"
    description: "Don't add any entries"
```

If "Yes, add all": Use Edit tool to add entries to appropriate sections in [Unreleased].
If "Review individually": Present each entry with accept/reject options.
If "Skip" or `--dry-run`: Report and exit.
