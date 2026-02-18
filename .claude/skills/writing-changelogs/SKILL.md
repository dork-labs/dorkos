---
name: writing-changelogs
description: Writes human-friendly changelog entries and release notes. Use when populating changelog, preparing releases, or reviewing release notes quality.
---

# Writing Changelogs

Write changelog entries and release notes that humans actually want to read. This skill activates when writing changelog entries, preparing GitHub releases, or reviewing release notes quality.

**Sources**: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), [Common Changelog](https://github.com/vweevers/common-changelog)

## When to Use

- Writing entries for `CHANGELOG.md`
- Preparing GitHub release notes via `/system:release`
- Reviewing changelog entries before release
- Transforming commit messages into user-friendly descriptions

## Core Principles

1. **Changelogs are for humans, not machines** - Write for users, not developers
2. **Communicate impact, not implementation** - Focus on what users can DO, not what files changed
3. **Use imperative verbs** - "Add", "Fix", "Remove" not "Added", "Fixed", "Removed"
4. **Include references** - Link to commits, PRs, or issues when available
5. **Plain language over jargon** - Explain, don't assume knowledge

## Entry Format

### Basic Template

```markdown
- [Imperative verb] [user benefit/what changed] ([reference])
```

### With Sub-details (for significant changes)

```markdown
- **[Feature Name]** - [User benefit explanation]
  - [Technical detail 1]
  - [Technical detail 2]
```

## Good vs Bad Examples

| Bad (Developer-focused)                             | Good (User-focused)                                            |
| --------------------------------------------------- | -------------------------------------------------------------- |
| Add obsidian_manager.py for auto vault registration | Open files in Obsidian without manual vault setup              |
| fix: Use relative paths in theme commands           | Fix theme commands failing when run from different directories |
| Accept 'default' as theme alias                     | Use 'default' to quickly apply the standard theme              |
| Add changelog-populator.py hook                     | Changelog entries are now auto-generated from commits          |
| Update CLAUDE.md with new patterns                  | (Skip - internal documentation, not user-facing)               |
| refactor: Extract helper function                   | (Skip - internal refactoring, no user impact)                  |

## Imperative Verbs Reference

| Verb          | Use For                            | Example                                 |
| ------------- | ---------------------------------- | --------------------------------------- |
| **Add**       | New features, capabilities         | Add dark mode support                   |
| **Fix**       | Bug corrections                    | Fix login failing on Safari             |
| **Change**    | Modifications to existing behavior | Change default timeout to 30 seconds    |
| **Remove**    | Deleted features                   | Remove deprecated v1 API                |
| **Improve**   | Performance, UX enhancements       | Improve search speed by 50%             |
| **Update**    | Dependencies, configurations       | Update to React 18                      |
| **Deprecate** | Scheduled for removal              | Deprecate XML export (use JSON instead) |

## What to Skip

Not everything belongs in the changelog. Skip:

- Internal refactoring with no user impact
- Documentation typo fixes
- Development-only changes (CI, tests, linting)
- Dependency updates (unless security-related)
- Code style changes

**Exception**: Include if it affects how users interact with the system.

## Theme Blockquote (Optional)

Add a single-line blockquote below version headings to provide a theme/summary for the release:

```markdown
## [0.3.0] - 2026-02-20

> DorkOS 0.3.0 adds a scheduler and dynamic MCP tools.

### Added
- ...
```

This theme line feeds:
- Blog post descriptions
- GitHub Release "What's New" opening paragraph
- Quick reference for users scanning the changelog

The blockquote is optional and backward-compatible. Older versions without it work fine.

## Changelog Categories

Use these standard categories in order:

1. **Added** - New features
2. **Changed** - Modifications to existing features
3. **Deprecated** - Soon-to-be removed features
4. **Removed** - Removed features
5. **Fixed** - Bug fixes
6. **Security** - Vulnerability fixes

## GitHub Release Notes Template

When creating GitHub releases, use this narrative format (different from the changelog):

```markdown
## What's New in vX.Y.Z

[1-2 sentence theme describing the focus of this release]

### Highlights

🎨 **[Feature Name]** - [One sentence explaining the benefit and how to use it]

📂 **[Feature Name]** - [One sentence explaining the benefit and how to use it]

🔧 **[Fix/Improvement]** - [One sentence explaining what's better now]

### All Changes

- [Bullet list of all changes - can be slightly more technical]
- [Include references: (#123) or (abc1234)]

**Full Changelog**: https://github.com/[owner]/[repo]/compare/v[prev]...v[new]
```

### Emoji Reference for Highlights

| Emoji | Use For                     |
| ----- | --------------------------- |
| ✨    | Major new feature           |
| 🎨    | UI/UX improvements, themes  |
| 📂    | File handling, organization |
| 🔧    | Fixes, improvements         |
| ⚡    | Performance                 |
| 🔒    | Security                    |
| 📝    | Documentation               |
| 🗑️    | Removals, deprecations      |

## Pre-Release Checklist

Before publishing release notes, verify each entry:

- [ ] Starts with imperative verb (Add, Fix, Change, Remove, Improve)
- [ ] Describes user benefit, not just implementation detail
- [ ] Uses plain language (no unexplained jargon)
- [ ] Includes reference link when applicable
- [ ] Appropriate for someone who doesn't know the codebase

For the overall release:

- [ ] Has a theme sentence summarizing the release focus
- [ ] 2-3 highlights with context for significant changes
- [ ] Link to full changelog for details

## Transforming Commit Messages

When converting conventional commits to changelog entries:

| Commit Message                   | Changelog Entry                                                 |
| -------------------------------- | --------------------------------------------------------------- |
| `feat: Add obsidian_manager.py`  | Add automatic Obsidian vault registration                       |
| `fix(theme): Use relative paths` | Fix theme commands failing outside project root                 |
| `feat!: Change config format`    | **BREAKING**: Change configuration format (see migration guide) |
| `chore: Update deps`             | (skip)                                                          |
| `docs: Fix typo`                 | (skip)                                                          |

### Breaking Changes

Always make breaking changes prominent:

```markdown
### Changed

- **BREAKING**: [Description of breaking change]
  - Migration: [How to update]
```

## Integration with /system:release

During release preparation:

1. **Analysis phase**: Transform raw changelog entries to user-friendly language
2. **Preview phase**: Show transformed entries for approval
3. **GitHub release**: Generate narrative release notes using the template
4. **Quality check**: Apply the pre-release checklist

## Writing Tips

### The "You Can Now" Test

For each entry, mentally prepend "You can now..." - if it doesn't make sense, rewrite it.

- ❌ "Add obsidian_manager.py" → "You can now add obsidian_manager.py" (nonsense)
- ✅ "Open files in Obsidian automatically" → "You can now open files in Obsidian automatically" (makes sense)

### The "So What?" Test

If someone asks "so what?" after reading your entry, you need more context.

- ❌ "Fix path handling" → So what?
- ✅ "Fix theme commands failing when run from different directories" → Clear impact

### Avoid These Patterns

- Starting with "This release..." (the heading already says the version)
- Using passive voice ("was added" vs "Add")
- Listing file names without explaining benefit
- Technical jargon without explanation
- Commit hash references without descriptions
