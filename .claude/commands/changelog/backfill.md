---
description: Find missing changelog entries from git commits since last tag
argument-hint: '[tag] [--dry-run]'
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion
---

# Changelog Backfill

Find commits since the last tag (or a specified tag) that have no fragment yet in `changelog/unreleased/`, and propose one fragment per missing change. Never edits `CHANGELOG.md` — only `/system:release` compiles fragments into it (see `changelog/README.md`).

Backed by `.claude/scripts/changelog_backfill.py` (`--dry-run` / `--json` / `--apply`); `--apply` writes the fragment files.

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

### Step 4: Compare with Existing Fragments

Read every fragment in `changelog/unreleased/`. For each categorized commit, check if a similar entry already exists (fuzzy match on key terms). Only propose genuinely missing entries.

### Step 5: Present Proposals

Show proposed entries grouped by category:

```markdown
## Proposed Changelog Fragments

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
question: "Write these as fragments in changelog/unreleased/?"
options:
  - label: "Yes, write all"
    description: "Write one fragment file per proposed entry (changelog_backfill.py --apply)"
  - label: "Review individually"
    description: "Approve each entry one by one"
  - label: "Skip"
    description: "Don't write any fragments"
```

If "Yes, write all": run `changelog_backfill.py --apply` (or write the fragments directly), one file per entry.
If "Review individually": Present each entry with accept/reject options, then write the accepted ones as fragments.
If "Skip" or `--dry-run`: Report and exit.
