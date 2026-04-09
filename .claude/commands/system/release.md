---
description: Create a new release with version bump, changelog update, git tag, npm publish, and optional GitHub Release
argument-hint: [patch|minor|major|X.Y.Z] [--dry-run]
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, Task
---

# System Release Command (Orchestrator)

Create a new release by bumping the version, updating the changelog, creating a git tag, publishing to npm, and optionally creating a GitHub Release.

This command operates as an **orchestrator** that:

- Runs quick pre-flight checks in main context
- Delegates context-heavy analysis to a subagent (keeps main context clean)
- Handles user interaction and git operations in main context

## Arguments

- `$ARGUMENTS` - Optional bump type or explicit version, plus optional flags:
  - _(no argument)_ - **Auto-detect** version bump from changelog and commits
  - `patch` - Force patch version (0.1.0 -> 0.1.1)
  - `minor` - Force minor version (0.1.0 -> 0.2.0)
  - `major` - Force major version (0.1.0 -> 1.0.0)
  - `X.Y.Z` - Explicit version number (e.g., `0.2.0`)
  - `--dry-run` - Show what would happen without making changes

## Semantic Versioning

| Bump Type | When to Use                                  | Example        |
| --------- | -------------------------------------------- | -------------- |
| **MAJOR** | Breaking changes to user config or workflows | 0.1.0 -> 1.0.0 |
| **MINOR** | New features, backward compatible            | 0.1.0 -> 0.2.0 |
| **PATCH** | Bug fixes, documentation updates             | 0.1.0 -> 0.1.1 |

## Architecture

```
+-------------------------------------------------------------+
|                    MAIN CONTEXT (Orchestrator)                |
|                                                               |
|  Phase 1: Parse arguments                                     |
|  Phase 2: Pre-flight checks (git status, branch, VERSION)     |
|           |                                                   |
|  Phase 3: If auto-detect needed -> spawn analysis agent       |
|           |                                                   |
|  Phase 4: Present recommendation, get user confirmation       |
|  Phase 5: Execute release (VERSION, package.json, changelog,  |
|           git, npm publish)                                   |
|  Phase 6: Report results                                      |
+-------------------------------------------------------------+
                           |
                           v (only if auto-detect)
+-------------------------------------------------------------+
|              SUBAGENT: Release Analyzer                       |
|              (context-isolator, model: haiku)                 |
|                                                               |
|  - Read changelog [Unreleased] section                        |
|  - Get commits since last tag                                 |
|  - Analyze patterns (feat:, fix:, BREAKING, etc.)             |
|  - Return structured recommendation                           |
+-------------------------------------------------------------+
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
# Check 3: Read current version from VERSION file (single source of truth)
cat VERSION
```

```bash
# Check 4: Get latest tag for comparison
git describe --tags --abbrev=0 2>/dev/null || echo "none"
```

```bash
# Check 5: Analyze commits since last tag for changelog completeness
git log $(git describe --tags --abbrev=0 2>/dev/null || echo "")..HEAD --oneline
```

Parse the git log output to identify commits not represented in the [Unreleased] section of CHANGELOG.md:

- Read the current [Unreleased] section from CHANGELOG.md
- Compare commit messages against existing entries
- Categorize missing commits by conventional commit type:
  - feat: / feat(...) -> Added
  - fix: / fix(...) -> Fixed
  - refactor: / chore: / docs: -> Changed
  - BREAKING CHANGE or "!" after type -> Breaking

### If missing entries exist (changelog is incomplete)

Report and ask:

```markdown
## Changelog Review

**Since tag**: [last_tag]
**Commits analyzed**: [count]
**Current entries**: [count from Unreleased section]
**Missing entries**: [count]

### Missing from Changelog

The following commits are not represented in the [Unreleased] section:

#### Added

- [user-friendly description] ([short sha])
  _From_: `[original commit message]`

#### Fixed

- [user-friendly description] ([short sha])
  _From_: `[original commit message]`
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

If user selects "Yes, add all": Use the Edit tool to add the missing entries to the appropriate sections in the [Unreleased] block of CHANGELOG.md. Rewrite entries to be user-friendly using the `/writing-changelogs` skill guidelines:

- Focus on what users can DO, not what files changed
- Use imperative verbs (Add, Fix, Change, Remove)
- Explain benefits, not just mechanisms

Then continue to Phase 3.

### If no entries exist at all (completely empty)

If both the [Unreleased] section and commit history are empty since the last release:

```
## Cannot Release: No Changes

Both the [Unreleased] section and commit history are empty since the last release.
There's nothing to release.

**Tip**: Use conventional commit format (feat:, fix:, etc.) so changes are easy to track.
```

**STOP** the release process.

### Check 6: Config schema migration drift

After the changelog check, verify that any changes to the user-config schema since the last release have a paired `conf` migration. Missing migrations silently break upgrades for existing users, so catch it here before the tag is cut.

**Do this check inline in the main context (no subagent).** The diff is small (usually <500 lines) and the judgment calls ("is this an added field with a default? a rename? a type change?") benefit from full project knowledge.

**Ordering with auto-detect mode:** Steps 1 and 2 below (detect drift, classify changes) can run in Phase 2 regardless of whether the version bump is explicit or auto-detected. Steps 3 and 4 (check for matching migration at target version, present findings, scaffold) require `NEXT_VERSION`, which is computed in Phase 1 for explicit bumps and in Phase 3 for auto-detect. **If auto-detect is in play, run Steps 1-2 here in Phase 2 and defer Steps 3-4 until immediately after Phase 3 version analysis, before Phase 4 confirmation.** For explicit bumps, run all four steps sequentially here.

#### Step 1: Detect drift

```bash
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
SCHEMA_DIFF=$(git diff "$LAST_TAG"..HEAD -- \
  packages/shared/src/config-schema.ts \
  apps/server/src/services/core/config-manager.ts)
```

If `SCHEMA_DIFF` is empty → skip the rest of this sub-phase, go to Phase 3.

#### Step 2: Analyze the diff

Read `apps/server/src/services/core/config-manager.ts` and extract:

- The current `migrations` block keys (array of semver strings).
- The current `projectVersion` string.

Parse `SCHEMA_DIFF` and classify each hunk:

- **Added field with a `.default(...)`** — `conf`'s defaults-merge handles this automatically on next instantiation. Usually no migration needed.
- **Added field without a default** — will crash `USER_CONFIG_DEFAULTS` import. Block the release and tell the user to add a default.
- **Removed field** — migration needed (clean up stale user data).
- **Renamed field** (paired add + remove with similar name/type) — migration needed (move user's value from old key to new key).
- **Type change** (e.g., `z.number()` → `z.string()`) — migration needed (transform stored values).
- **Default value change** — **sometimes** needs a migration. If users can have set an explicit value, leave theirs alone. If the default was never user-settable, no migration needed.
- **TSDoc-only / comment-only changes** — no migration needed.

#### Step 3: Check for existing migration at the target version

The target version is `NEXT_VERSION` (computed in Phase 1 for explicit bump type, or in Phase 3 for auto-detect — see the "Ordering with auto-detect mode" note at the top of this check).

Check the `migrations` block for an entry keyed to `NEXT_VERSION`. If present, display its body verbatim so the user can confirm it's correct.

#### Step 4: Present findings

```markdown
## Config Schema Migration Check

**Since tag:** [last_tag]
**Target version:** [next_version]
**Schema files changed:**

- packages/shared/src/config-schema.ts: [summary of hunks]
- apps/server/src/services/core/config-manager.ts: [summary of hunks]

**Detected changes:**

- [classification]: [field name] ([reason])
- ...

**Migration required:** [yes/no]
**Existing migration for v[next_version]:** [yes/no + body summary if yes]
```

Then follow one of three flows.

#### Flow A — migration needed, none exists

Draft a scaffolded migration based on the detected changes. Keep it idempotent (always guard with `store.has()`). Present it for user review:

```typescript
// Proposed migration (append to migrations block in apps/server/src/services/core/config-manager.ts)
'[next_version]': (store) => {
  // Auto-scaffolded during /system:release for v[next_version]
  // Review carefully before accepting.
  if (store.has('mesh.legacyMode')) {
    store.delete('mesh.legacyMode');
  }
  // `server.timeout` added with a default — conf's defaults merge handles
  // the new-key case automatically; no explicit migration needed for it.
},
```

Use `AskUserQuestion` (mirror the changelog backfill style in Phase 2):

```
header: "Config Migration"
question: "Schema changes detected without a matching migration. What would you like to do?"
options:
  - label: "Yes, add the scaffolded migration (Recommended)"
    description: "Appends to CONFIG_MIGRATIONS in config-manager.ts and stages for the release commit"
  - label: "Let me write it myself"
    description: "Pauses the release so you can edit config-manager.ts manually, then re-run"
  - label: "No migration needed (I know what I'm doing)"
    description: "Skip. Use only for type-only or no-op schema changes"
  - label: "Cancel release"
    description: "Abort without making changes"
```

**On "Yes, add the scaffolded migration":**

1. Use the Edit tool to append the migration entry to the module-level `CONFIG_MIGRATIONS` constant in `apps/server/src/services/core/config-manager.ts`, keyed to `[next_version]`. Do NOT touch `projectVersion` — it's sourced from `SERVER_VERSION` (see `lib/version.ts`) and updates automatically when `VERSION` and `package.json` are bumped in Phase 5.2 / 5.3 below.
2. Add `apps/server/src/services/core/config-manager.ts` to the Phase 5.6 `git add` list (see below — it must be staged alongside VERSION/CHANGELOG/package.json).
3. Log the scaffold action in the Phase 6 report: `✓ Auto-scaffolded config migration for v[next_version]`.
4. Continue to Phase 3.

**On "Let me write it myself":** exit cleanly with this message:

```
## Release Paused: Manual Migration Required

Config schema changed since [last_tag] and a migration is needed. Exiting so you can edit:

  apps/server/src/services/core/config-manager.ts

Add a new migration entry keyed to '[next_version]' to the CONFIG_MIGRATIONS
constant. You do not need to touch projectVersion — it's sourced from
SERVER_VERSION automatically. See .claude/skills/adding-config-fields/SKILL.md
for the full process.

When finished, re-run /system:release.
```

**On "No migration needed (I know what I'm doing)":** log the acknowledgment and continue to Phase 3. Include in the Phase 6 report: `⚠ Config schema changed but user declined migration (acknowledged)`.

**On "Cancel release":** exit with no changes.

#### Flow B — migration needed, matching entry exists

Show:

```
✓ Config schema changed since [last_tag] and migration for v[next_version] already exists in config-manager.ts.

  Existing migration body:
  [one-line summary of the existing migration's first 3 lines]

Continuing.
```

Continue to Phase 3. No user interaction needed.

#### Flow C — changes are safe (no migration needed)

Applies when: all detected changes are "added field with default" or "TSDoc-only" or "comment-only".

Show:

```
ℹ Config schema changed since [last_tag], but detected changes do not require a migration:

  - [classification]: [field name] ([reason])

Continuing.
```

Ask for a single confirmation before proceeding (in case the user's intent is different from the classifier's reading):

```
header: "Confirm"
question: "Proceed without a migration?"
options:
  - label: "Yes, no migration needed (Recommended)"
    description: "Continue to Phase 3"
  - label: "No, I want to add one manually"
    description: "Pause so you can edit config-manager.ts"
```

#### Known limitations

- **Cross-file renames** (a field is moved from one nested object to another) surface as paired add + remove with different paths. The classifier may miss the connection. Use "Let me write it myself" if you spot this.
- **Schemas imported from outside the watch list** won't show up in the diff. Today all DorkOS user-config sub-schemas (e.g., `LoggingConfigSchema`, `OnboardingStateSchema`) live inline in `packages/shared/src/config-schema.ts`, so this is a theoretical concern. If a future refactor moves a sub-schema into a separate file (e.g., `packages/shared/src/logging-config-schema.ts`), add that file to Step 1's `git diff` path list.
- **The `context-isolator` subagent referenced in Phase 3 is missing from `.claude/agents/`.** This Check 6 intentionally avoids subagents for exactly that reason — do not add a Migration Analyzer subagent without first verifying the agent type exists.

---

## Phase 3: Version Analysis

### If explicit bump type provided (patch/minor/major/X.Y.Z)

Skip analysis, calculate next version directly:

| Current | Bump Type | Next  |
| ------- | --------- | ----- |
| 0.1.0   | patch     | 0.1.1 |
| 0.1.0   | minor     | 0.2.0 |
| 0.1.0   | major     | 1.0.0 |

Proceed to Phase 4.

### If auto-detect needed (no bump type)

**Spawn a context-isolator agent** to analyze changes and recommend version bump.

This keeps the main context clean by offloading the changelog parsing and commit analysis.

````
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
````

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

**Current Version**: v0.1.0
**New Version**: v0.2.0
**Bump Type**: MINOR (auto-detected)

### Reasoning

[Agent's reasoning from Phase 3]

### Analysis Summary

**Changelog signals:**

- [check] "### Added" section has 3 items
- [x] No breaking changes detected
- [check] "### Fixed" section has 2 items

**Commit signals (12 commits):**

- 4 feat: commits
- 6 fix: commits
- 2 docs: commits

### Changes to be Released

[Changelog content from agent]

### Files to be Modified

1. `VERSION` - 0.1.0 -> 0.2.0
2. `packages/cli/package.json` - 0.1.0 -> 0.2.0
3. `package.json` - 0.1.0 -> 0.2.0
4. `CHANGELOG.md` - [Unreleased] -> [0.2.0] - YYYY-MM-DD

### Git Operations

1. Commit: "chore(release): v0.2.0"
2. Tag: v0.2.0 (annotated)
3. Push: origin main + tag

### npm Publish

4. `pnpm run publish:cli` (publishes `dorkos` to npm)
```

If `--dry-run` flag is present, **STOP** here.

Otherwise, use AskUserQuestion:

```
header: "Confirm Release"
question: "Create release v0.2.0?"
options:
  - label: "Yes, MINOR is correct (Recommended)"
    description: "New features added, backward compatible"
  - label: "No, make it PATCH"
    description: "These are just bug fixes (0.1.0 -> 0.1.1)"
  - label: "No, make it MAJOR"
    description: "There are breaking changes (0.1.0 -> 1.0.0)"
  - label: "Cancel"
    description: "Abort without making changes"
```

If user overrides the bump type, recalculate version.

---

## Phase 5: Execute Release

### 5.1: Check tag doesn't exist

```bash
git tag -l "v0.2.0"
```

If tag exists, **STOP**:

```
## Cannot Release: Tag Already Exists

Tag v0.2.0 already exists. Choose a different version or delete:
- `git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0`
```

### 5.2: Update VERSION File

```bash
printf "0.2.0" > VERSION
```

### 5.3: Sync Version to package.json Files

```bash
# Update packages/cli/package.json (the published npm package)
cd packages/cli && npm version 0.2.0 --no-git-tag-version && cd ../..

# Update root package.json
npm version 0.2.0 --no-git-tag-version
```

This updates `packages/cli/package.json` and root `package.json`.

### 5.4: Update Changelog

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

## [0.2.0] - 2026-02-16

[Previous [Unreleased] content here]
```

### 5.5: Sync Changelog to Docs

Update `docs/changelog.mdx` to match `CHANGELOG.md`. Use the Edit tool to replace the content of `docs/changelog.mdx`, keeping the frontmatter and intro line but replacing all version sections.

The sync should:

1. Read the updated `CHANGELOG.md`
2. Extract everything after the `## [Unreleased]` empty section (skip the Unreleased heading and its empty subsections)
3. Strip the link reference definitions at the bottom (lines like `[Unreleased]: https://...`)
4. Write to `docs/changelog.mdx` preserving this structure:

```markdown
---
title: Changelog
description: All notable changes to DorkOS, following Keep a Changelog format and Semantic Versioning.
---

All notable changes to DorkOS are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-02-17

[released content here...]

## [0.1.0] - 2025-02-08

[previous releases...]
```

### 5.5b: Scaffold Blog Post

Create a blog post for this release at `blog/dorkos-X-Y-Z.mdx` (replace dots with hyphens in the version). Use the changelog content and release theme to populate it:

```markdown
---
title: DorkOS X.Y.Z
description: [Theme sentence from CHANGELOG.md blockquote, or generated 1-sentence summary]
date: [today's date YYYY-MM-DD]
author: DorkOS Team
category: release
tags: [release, plus 2-3 relevant tags from the changes]
---

[Theme paragraph — 1-2 sentences describing the release focus]

## Highlights

[2-3 most significant changes with brief explanations]

## All Changes

[Copy from CHANGELOG.md version section — same content as GitHub Release]

## Install / Update

\`\`\`
npm install -g dorkos@X.Y.Z
\`\`\`
```

The user can edit this post before the release commit. Add the blog post file to the git staging in Phase 5.6.

### 5.6: Commit and Tag

```bash
# Stage all version-related changes.
#
# If Phase 2 Check 6 scaffolded a config migration (Flow A "Yes, add the
# scaffolded migration"), also stage the modified config files so they land
# in the release commit. Check 6 tracks whether it modified these files;
# include them conditionally:
#
#   apps/server/src/services/core/config-manager.ts
#   packages/shared/src/config-schema.ts  (if its diff was part of the drift check)
git add VERSION CHANGELOG.md docs/changelog.mdx packages/cli/package.json package.json blog/

# Commit (use HEREDOC for message)
git commit -m "$(cat <<'EOF'
chore(release): v0.2.0

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"

# Create annotated tag
git tag -a v0.2.0 -m "Release v0.2.0"
```

### 5.7: Publish to npm

Ask using AskUserQuestion:

```
header: "npm Publish"
question: "Publish dorkos v0.2.0 to npm?"
options:
  - label: "Yes, publish to npm (Recommended)"
    description: "Runs pnpm run publish:cli to publish the dorkos package"
  - label: "No, skip npm publish"
    description: "Package is not published to npm. Docker image will not be available."
```

If yes:

```bash
pnpm run publish:cli
```

The `prepublishOnly` hook in `packages/cli/package.json` will automatically build before publishing.

### 5.8: Push to Origin

```bash
# Push commit and tag
git push origin main && git push origin v0.2.0
```

If push fails, report error and provide recovery commands.

### 5.9: GitHub Release Notes

**Reference**: Use the `writing-changelogs` skill for guidance on writing user-friendly release notes.

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

If yes, generate **narrative release notes** with a fresh theme and highlights, but copy "All Changes" verbatim from CHANGELOG.md:

#### Source for "All Changes"

Read the released version section from `CHANGELOG.md` (the `## [0.2.0]` section just created in Phase 5.4). Copy the bullet entries under each subsection (`### Added`, `### Changed`, `### Fixed`, etc.) **exactly as written** — do NOT rewrite, regenerate, or summarize them. The changelog entries were already reviewed and approved earlier in this process.

#### Release Notes Template

```markdown
## What's New in v0.2.0

[1-2 sentence theme describing the focus of this release — generate fresh]

### Highlights

[emoji] **[Feature Name]** - [One sentence explaining the benefit and how to use it — generate fresh, 2-3 highlights for most significant changes]

[emoji] **[Feature Name]** - [One sentence explaining the benefit and how to use it — generate fresh]

### All Changes

[COPY verbatim from CHANGELOG.md — do NOT regenerate or rewrite these entries]

### Install / Update
```

npm update -g dorkos

```

**Full Changelog**: https://github.com/dork-labs/dorkos/compare/v[prev]...v[new]
```

**Important**: The Theme and Highlights sections above are written fresh (narrative, engaging). The "All Changes" section is copied directly from CHANGELOG.md without modification.

#### Pre-Release Checklist

For the overall release:

- [ ] Has a theme sentence summarizing the release focus
- [ ] 2-3 highlights for significant changes
- [ ] "All Changes" is copied verbatim from CHANGELOG.md (not regenerated)
- [ ] Link to full changelog
- [ ] Install/update instructions included

#### Emoji Reference

| Emoji  | Use For             |
| ------ | ------------------- |
| star   | Major new feature   |
| art    | UI/UX, themes       |
| folder | File handling       |
| wrench | Fixes, improvements |
| zap    | Performance         |
| lock   | Security            |

#### Create the Release

```bash
gh release create v0.2.0 --title "v0.2.0" --notes "[narrative release notes]"
```

---

## Phase 6: Report

```markdown
## Release Complete

**Version**: v0.2.0
**Tag**: v0.2.0
**Commit**: [short sha from `git rev-parse --short HEAD`]
**npm**: dorkos@0.2.0

### Links

- npm: https://www.npmjs.com/package/dorkos
- Tag: https://github.com/dork-labs/dorkos/releases/tag/v0.2.0
- Compare: https://github.com/dork-labs/dorkos/compare/v0.1.0...v0.2.0

### What's Next

- Package is available on npm: `npm install -g dorkos@0.2.0`
- Tag is available on GitHub
- Users can update with `npm update -g dorkos`

### Docker Image

- Image will be published automatically to `ghcr.io/dork-labs/dorkos:{version}`
- Triggered by the tag push above
- Monitor progress: https://github.com/dork-labs/dorkos/actions/workflows/publish-docker.yml

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
- `git push origin v0.2.0`

To undo local changes:
- `git reset --hard HEAD~1`
- `git tag -d v0.2.0`
```

### npm Publish Fails

```
## npm Publish Failed

The git tag was pushed but npm publish failed.
Error: [error message]

To retry:
- `pnpm run publish:cli`

Common fixes:
- `npm login` (if auth expired)
- Check npm token: `npm whoami`
```

### No GitHub CLI

```
## GitHub CLI Not Available

Install GitHub CLI to create releases:
- macOS: `brew install gh`
- Then: `gh auth login`

Or create the release manually at:
https://github.com/dork-labs/dorkos/releases/new?tag=v0.2.0
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
