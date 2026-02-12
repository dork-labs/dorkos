---
description: Create a new release with version bump, changelog update, git tag, and optional GitHub Release
argument-hint: [patch|minor|major|X.Y.Z] [--dry-run]
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, Task
---

# System Release Command (Orchestrator)

Create a new release by bumping the version, updating the changelog, creating a git tag, and optionally publishing a GitHub Release.

This command operates as an **orchestrator** that:
- Runs quick pre-flight checks in main context
- Delegates context-heavy analysis to a subagent (keeps main context clean)
- Handles user interaction and git operations in main context

## Arguments

- `$ARGUMENTS` - Optional bump type or explicit version, plus optional flags:
  - *(no argument)* - **Auto-detect** version bump from changelog and commits
  - `patch` - Force patch version (0.5.0 → 0.5.1)
  - `minor` - Force minor version (0.5.0 → 0.6.0)
  - `major` - Force major version (0.5.0 → 1.0.0)
  - `X.Y.Z` - Explicit version number (e.g., `0.7.0`)
  - `--dry-run` - Show what would happen without making changes

## Semantic Versioning

| Bump Type | When to Use | Example |
|-----------|-------------|---------|
| **MAJOR** | Breaking changes to user config or workflows | 0.5.0 → 1.0.0 |
| **MINOR** | New features, backward compatible | 0.5.0 → 0.6.0 |
| **PATCH** | Bug fixes, documentation updates | 0.5.0 → 0.5.1 |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MAIN CONTEXT (Orchestrator)              │
│                                                             │
│  Phase 1: Parse arguments                                   │
│  Phase 2: Pre-flight checks (git status, branch, VERSION)   │
│           ↓                                                 │
│  Phase 3: If auto-detect needed → spawn analysis agent      │
│           ↓                                                 │
│  Phase 4: Present recommendation, get user confirmation     │
│  Phase 5: Execute release (VERSION, changelog, git)         │
│  Phase 6: Report results                                    │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼ (only if auto-detect)
┌─────────────────────────────────────────────────────────────┐
│              SUBAGENT: Release Analyzer                     │
│              (context-isolator, model: haiku)               │
│                                                             │
│  - Read changelog [Unreleased] section                      │
│  - Get commits since last tag                               │
│  - Analyze patterns (feat:, fix:, BREAKING, etc.)           │
│  - Return structured recommendation                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Parse Arguments

Parse `$ARGUMENTS` to determine:
- **Bump type**: `patch`, `minor`, `major`, explicit version, or **auto** (default)
- **Dry run**: Whether `--dry-run` flag is present

---

## Phase 2: Pre-flight Checks

Run these quick validation checks in main context:

```bash
# Check 1: Working directory is clean
git status --porcelain
```

If output is not empty, **STOP** and report:
```
## Cannot Release: Uncommitted Changes

You have uncommitted changes in the working directory:
[list files]

Please commit or stash your changes before releasing:
- `git add . && git commit -m "your message"`
- Or: `git stash`
```

```bash
# Check 2: On main branch
git branch --show-current
```

If not `main`, **STOP** and report:
```
## Cannot Release: Not on Main Branch

You are on branch `[branch]`. Releases must be created from `main`.

Switch to main: `git checkout main`
```

```bash
# Check 3: Read current version
cat VERSION
```

```bash
# Check 4: Get latest tag for comparison
git describe --tags --abbrev=0 2>/dev/null || echo "none"
```

```bash
# Check 5: Run changelog backfill analysis to check for missing entries
python3 .claude/scripts/changelog_backfill.py --json
```

Parse the JSON output:
- `existing_entries` - Current entries in [Unreleased]
- `missing_entries` - Commits not yet in changelog
- `commits_analyzed` - Total commits since last tag

### If missing entries exist (changelog is incomplete)

This is the most important check. Even if [Unreleased] has some entries, commits may be missing.

Report and ask:
```markdown
## Changelog Review

**Since tag**: [since_tag]
**Commits analyzed**: [commits_analyzed]
**Current entries**: [existing_entries]
**Missing entries**: [count of missing_entries]

### Missing from Changelog

The following commits are not represented in the [Unreleased] section:

#### Added
- [entry] ([commit])
  *From*: `[original message]`

#### Fixed
- [entry] ([commit])
  *From*: `[original message]`
```

Use AskUserQuestion:
```
header: "Backfill"
question: "Add missing entries to changelog before releasing?"
options:
  - label: "Yes, add all missing entries (Recommended)"
    description: "Ensures release notes capture all changes since last release"
  - label: "No, release with current changelog"
    description: "Use only entries already in [Unreleased]"
  - label: "Cancel and edit manually"
    description: "Exit so you can edit the changelog yourself"
```

If user selects "Yes, add all":
```bash
python3 .claude/scripts/changelog_backfill.py --apply
```

Then continue to Phase 3.

### If no entries exist at all (completely empty)

If both `existing_entries` and `missing_entries` are 0:

```
## Cannot Release: No Changes

Both the [Unreleased] section and commit history are empty since the last release.
There's nothing to release.

**Tip**: Use conventional commit format (feat:, fix:, etc.) so the changelog-populator hook can track changes automatically.
```

**STOP** the release process.

---

## Phase 3: Version Analysis

### If explicit bump type provided (patch/minor/major/X.Y.Z)

Skip analysis, calculate next version directly:

| Current | Bump Type | Next |
|---------|-----------|------|
| 0.5.0 | patch | 0.5.1 |
| 0.5.0 | minor | 0.6.0 |
| 0.5.0 | major | 1.0.0 |

Proceed to Phase 4.

### If auto-detect needed (no bump type)

**Spawn a context-isolator agent** to analyze changes and recommend version bump.

This keeps the main context clean by offloading the changelog parsing and commit analysis.

```
Task tool:
  subagent_type: context-isolator
  model: haiku
  description: "Analyze changes for release"
  prompt: |
    ## Release Analysis Task

    Analyze the changes since the last release and recommend a version bump.

    **Current version:** [from VERSION file]
    **Last tag:** [from git describe]

    ### Step 1: Read Changelog

    Read the [Unreleased] section from `CHANGELOG.md`:
    - Extract content between `## [Unreleased]` and the next `## [` heading
    - Note which sections have content: Added, Changed, Fixed, Removed, Deprecated

    ### Step 2: Get Commits

    Run: `git log [last_tag]..HEAD --oneline`
    - Count commits by type (feat:, fix:, docs:, chore:, etc.)
    - Look for BREAKING CHANGE or ! markers

    ### Step 3: Apply Detection Rules

    **MAJOR signals (any of these):**
    - Changelog contains "BREAKING" or "Breaking"
    - "### Removed" section has content
    - Commits contain "BREAKING CHANGE:" or "!" after type (e.g., "feat!:")

    **MINOR signals (any of these):**
    - "### Added" section has content
    - Commits contain "feat:" or "feat("

    **PATCH (default):**
    - Only "### Fixed" or "### Changed" with minor changes
    - Only "fix:", "docs:", "chore:" commits

    ### Step 4: Transform Entries to User-Friendly Language

    For each changelog entry, rewrite to be user-focused:
    - Focus on what users can DO, not what files changed
    - Use imperative verbs (Add, Fix, Change, Remove)
    - Explain benefits, not just mechanisms

    **Examples:**
    - Bad: "Add obsidian_manager.py for auto vault registration"
    - Good: "Open files in Obsidian without manual vault setup"
    - Bad: "fix: Use relative paths in theme commands"
    - Good: "Fix theme commands failing when run from different directories"

    ### Step 5: Return Structured Result

    Return your analysis in this EXACT format:

    ```
    RECOMMENDED_BUMP: [MAJOR|MINOR|PATCH]
    NEXT_VERSION: [X.Y.Z]

    CHANGELOG_SIGNALS:
    - Added: [count] items
    - Changed: [count] items
    - Fixed: [count] items
    - Removed: [count] items
    - Breaking: [yes/no]

    COMMIT_SIGNALS:
    - Total commits: [N]
    - feat: [count]
    - fix: [count]
    - docs: [count]
    - other: [count]
    - Breaking markers: [yes/no]

    REASONING:
    [1-2 sentence explanation of why this bump type]

    CHANGELOG_CONTENT_RAW:
    [The original [Unreleased] section content]

    CHANGELOG_CONTENT_IMPROVED:
    [User-friendly rewritten version of the changelog entries]

    RELEASE_THEME:
    [1 sentence describing the focus/theme of this release for GitHub release notes]

    RELEASE_HIGHLIGHTS:
    [2-3 most significant changes with emoji and benefit explanation]
    ```
```

**Parse the agent's response** to extract:
- `RECOMMENDED_BUMP`
- `NEXT_VERSION`
- Signals for display
- Reasoning
- Raw and improved changelog content
- Release theme and highlights for GitHub release notes

---

## Phase 4: Present and Confirm

Present the release plan to the user:

```markdown
## Release Preview

**Current Version**: v0.5.0
**New Version**: v0.6.0
**Bump Type**: MINOR (auto-detected)

### Reasoning

[Agent's reasoning from Phase 3]

### Analysis Summary

**Changelog signals:**
- ✓ "### Added" section has 3 items
- ✗ No breaking changes detected
- ✓ "### Fixed" section has 2 items

**Commit signals (12 commits):**
- 4 feat: commits
- 6 fix: commits
- 2 docs: commits

### Changes to be Released

[Changelog content from agent]

### Files to be Modified

1. `VERSION` — 0.5.0 → 0.6.0
2. `CHANGELOG.md` — [Unreleased] → [0.6.0] - YYYY-MM-DD

### Git Operations

1. Commit: "Release v0.6.0"
2. Tag: v0.6.0 (annotated)
3. Push: origin main + tag
```

If `--dry-run` flag is present, **STOP** here.

Otherwise, use AskUserQuestion:
```
header: "Confirm Release"
question: "Create release v0.6.0?"
options:
  - label: "Yes, MINOR is correct (Recommended)"
    description: "New features added, backward compatible"
  - label: "No, make it PATCH"
    description: "These are just bug fixes (0.5.0 → 0.5.1)"
  - label: "No, make it MAJOR"
    description: "There are breaking changes (0.5.0 → 1.0.0)"
  - label: "Cancel"
    description: "Abort without making changes"
```

If user overrides the bump type, recalculate version.

---

## Phase 5: Execute Release

### 5.1: Check tag doesn't exist

```bash
git tag -l "v0.6.0"
```

If tag exists, **STOP**:
```
## Cannot Release: Tag Already Exists

Tag v0.6.0 already exists. Choose a different version or delete:
- `git tag -d v0.6.0 && git push origin :refs/tags/v0.6.0`
```

### 5.2: Update VERSION File

```bash
echo "0.6.0" > VERSION
```

### 5.3: Update Changelog

Edit `CHANGELOG.md` using the Edit tool:

1. Replace the `## [Unreleased]` section with a fresh empty one
2. Insert the new version section with today's date
3. Move all previous [Unreleased] content under the new version

**Target structure:**
```markdown
## [Unreleased]

### Added

### Changed

### Fixed

---

## [0.6.0] - 2026-01-31

[Previous [Unreleased] content here]
```

### 5.4: Commit and Tag

```bash
# Stage changes
git add VERSION CHANGELOG.md

# Commit (use HEREDOC for message)
git commit -m "$(cat <<'EOF'
Release v0.6.0

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"

# Create annotated tag
git tag -a v0.6.0 -m "Version 0.6.0"
```

### 5.5: Push to Origin

```bash
# Push commit and tag
git push origin main && git push origin v0.6.0
```

If push fails, report error and provide recovery commands.

### 5.6: GitHub Release Notes

**Reference**: Use the `changelog-writing` skill for guidance on writing user-friendly release notes.

Ask using AskUserQuestion:
```
header: "GitHub Release"
question: "Create a GitHub Release?"
options:
  - label: "Yes, create GitHub Release (Recommended)"
    description: "Creates a release on GitHub with narrative release notes"
  - label: "No, skip"
    description: "Tag is pushed, but no GitHub Release created"
```

If yes, generate **narrative release notes** (not just a copy of the changelog):

#### Release Notes Template

```markdown
## What's New in v0.6.0

[1-2 sentence theme describing the focus of this release]

### Highlights

[emoji] **[Feature Name]** - [One sentence explaining the benefit and how to use it]

[emoji] **[Feature Name]** - [One sentence explaining the benefit and how to use it]

### All Changes

- [User-friendly bullet list]
- [Include references when available: (#123) or (abc1234)]

**Full Changelog**: https://github.com/doriancollier/dorkian-next-stack/compare/v[prev]...v[new]
```

#### Pre-Release Checklist

Before publishing, verify each entry:

- [ ] Starts with imperative verb (Add, Fix, Change, Remove, Improve)
- [ ] Describes user benefit, not just implementation detail
- [ ] Uses plain language (no unexplained jargon)
- [ ] Includes reference link when applicable

For the overall release:

- [ ] Has a theme sentence summarizing the release focus
- [ ] 2-3 highlights for significant changes
- [ ] Link to full changelog

#### Emoji Reference

| Emoji | Use For |
|-------|---------|
| ✨ | Major new feature |
| 🎨 | UI/UX, themes |
| 📂 | File handling |
| 🔧 | Fixes, improvements |
| ⚡ | Performance |
| 🔒 | Security |

#### Create the Release

```bash
gh release create v0.6.0 --title "v0.6.0" --notes "[narrative release notes]"
```

---

## Phase 6: Report

```markdown
## Release Complete

**Version**: v0.6.0
**Tag**: v0.6.0
**Commit**: [short sha from `git rev-parse --short HEAD`]

### Links

- Tag: https://github.com/doriancollier/dorkian-next-stack/releases/tag/v0.6.0
- Compare: https://github.com/doriancollier/dorkian-next-stack/compare/v0.5.0...v0.6.0

### What's Next

- Tag is available on GitHub
- Users can pull latest changes with `git pull`

### Release Notes

[Summary of what was released]
```

---

## Edge Cases

### Push Fails

```
## Push Failed

The commit and tag were created locally but could not be pushed.
Error: [error message]

To retry:
- `git push origin main`
- `git push origin v0.6.0`

To undo local changes:
- `git reset --hard HEAD~1`
- `git tag -d v0.6.0`
```

### No GitHub CLI

```
## GitHub CLI Not Available

Install GitHub CLI to create releases:
- macOS: `brew install gh`
- Then: `gh auth login`

Or create the release manually at:
https://github.com/doriancollier/dorkian-next-stack/releases/new?tag=v0.6.0
```

---

## Related Commands

- `/changelog:backfill` - Populate [Unreleased] from commits since last tag

## When to Use

- After completing a set of features (minor release)
- After fixing bugs (patch release)
- Before breaking changes (major release)
- At natural milestones (sprint end, before sharing)

**Do NOT release on every commit** - releases represent meaningful milestones.
