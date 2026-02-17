# Research: Versioning & Release System

## Source

Studied the `life-os-starter` repository at `/Users/doriancollier/Keep/life-os-starter`, which has a mature, integrated versioning/release system built around Claude Code skills, hooks, and scripts.

## What life-os-starter Does

### Components

| Component | File | Purpose |
|---|---|---|
| **VERSION file** | `VERSION` | Single source of truth for current version (plain text, e.g. `0.13.0`) |
| **Changelog** | `workspace/0-System/changelog.md` | Keep-a-Changelog format with `[Unreleased]` section |
| **Auto-changelog hook** | `.claude/hooks/changelog-populator.py` | Post-commit git hook: parses conventional commits, auto-populates `[Unreleased]` section, amends commit to include changelog update |
| **Backfill script** | `.claude/scripts/changelog_backfill.py` | Catches missed changelog entries from non-conventional commits; uses Jaccard similarity matching |
| **Release command** | `.claude/commands/system/release.md` | Orchestrator: version bump, changelog finalization, git tag, GitHub Release, upgrade notes |
| **Changelog skill** | `.claude/skills/changelog-writing/SKILL.md` | Model-invoked guidance for writing user-friendly changelog entries |
| **Version check hook** | `.claude/hooks/version-check.py` | SessionStart hook: checks for newer tags on remote, notifies user of updates |
| **Upgrade notes** | `.claude/upgrade-notes/` | Per-version migration instructions for users |
| **Upgrade command** | `.claude/commands/system/upgrade.md` | Consumer-side: fetch updates, run migrations, create task list |

### Flow

```
Conventional Commits
       │
       ▼
changelog-populator.py (post-commit hook)
       │ auto-populates [Unreleased]
       ▼
/system:release
       │
       ├─ changelog backfill (catch missed entries)
       ├─ version analysis (subagent: haiku)
       ├─ user confirmation
       ├─ VERSION file update
       ├─ changelog: [Unreleased] → [X.Y.Z]
       ├─ git commit + annotated tag
       ├─ git push + GitHub Release
       └─ upgrade notes generation
              │
              ▼
version-check.py (SessionStart hook)
       │ notifies users of new version
       ▼
/system:upgrade (consumer applies update)
```

### Key Design Decisions

1. **VERSION file (not package.json)** as single source of truth - decoupled from npm, works for non-Node projects
2. **Conventional commits** drive automatic changelog - `feat:` → Added, `fix:` → Fixed, `chore:` → skipped
3. **Post-commit hook amends** the commit to include changelog update (uses lock file to prevent re-entry)
4. **Subagent analysis** for auto-detecting bump type - keeps main context clean
5. **Backfill before release** catches entries from non-conventional commits
6. **User-friendly rewriting** transforms developer commit messages into user-facing language
7. **Upgrade notes per version** - structured migration docs for breaking changes
8. **Version check on session start** - cached (24h), 3-second timeout, non-blocking

---

## Current DorkOS State

### Version Locations

| Location | Version | Purpose |
|---|---|---|
| `package.json` (root) | `0.1.0` | Workspace root |
| `packages/cli/package.json` | `0.1.0` | Published npm package (source of truth for CLI) |
| `apps/client/package.json` | `0.0.0` | Not published |
| `apps/server/package.json` | `0.0.0` | Not published |
| `apps/obsidian-plugin/package.json` | `0.0.0` | Not published |
| `packages/shared/package.json` | `0.0.0` | Not published |

### How Version Is Used

- `packages/cli/scripts/build.ts` reads version from `packages/cli/package.json` and injects it via esbuild `define` as `__CLI_VERSION__`
- CLI displays this version at runtime
- `npm version patch` in `packages/cli` bumps the version
- `npm publish -w packages/cli` publishes to npm (prepublishOnly auto-builds)

### What Exists Already

- `/system:release` command exists (adapted from life-os-starter) - references `VERSION` file and `CHANGELOG.md` that don't exist yet
- `/writing-changelogs` skill exists for changelog writing guidance
- No `CHANGELOG.md` file
- No `VERSION` file
- No git tags
- No auto-changelog hook
- No version check on startup
- No backfill script

### Gaps

1. **No changelog** - no way to track changes between versions
2. **No git tags** - no release markers in git history
3. **Release command references non-existent files** - `VERSION` file, `CHANGELOG.md`, `changelog_backfill.py`
4. **Version scattered** - root package.json and CLI package.json both have version, but they serve different purposes
5. **No update notification** - users don't know when new versions are available
6. **No conventional commit enforcement** - no hook or CI check

---

## Recommendations for DorkOS

### What to Adopt (with modifications)

#### 1. CHANGELOG.md at Project Root

Create `CHANGELOG.md` (not nested in a subdirectory like life-os does). Standard location for open-source npm packages.

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

---
```

#### 2. VERSION File (Optional — Debatable)

**For life-os:** VERSION makes sense because it's a git-distributed template, not an npm package. The version isn't tied to npm at all.

**For DorkOS:** The publishable artifact is `packages/cli/package.json`. Using `npm version` is the standard npm workflow. A separate VERSION file would be redundant unless we want a single place that represents "the DorkOS version" independent of npm.

**Recommendation:** Use a root `VERSION` file as the single source of truth for the project version. The release command should sync it to `packages/cli/package.json` and `package.json` (root). Rationale:
- DorkOS is more than just the CLI package — it's also the Obsidian plugin and dev server
- A VERSION file is simpler to read/parse in hooks and scripts
- The release command can handle the sync to package.json files

#### 3. Changelog Auto-Population (Modified)

The life-os post-commit hook that amends commits is clever but aggressive. For a collaborative open-source project, amending commits can cause issues with PRs and CI.

**Recommendation:** Instead of a post-commit amend hook, use the `/writing-changelogs` skill that already exists. The `/system:release` command should run a backfill step (analyze commits since last tag) and present entries for approval before release. This is a manual-with-automation-assist approach that's safer for open-source.

#### 4. Release Command Updates

The existing `/system:release` command needs updates:
- Reference `CHANGELOG.md` (root) instead of `workspace/0-System/changelog.md`
- Update VERSION + sync to `packages/cli/package.json`
- Add npm publish step after git tag
- Update GitHub URLs from `doriancollier/dorkian-next-stack` to `dork-labs/dorkos`
- Add monorepo-specific considerations (only CLI is published)

#### 5. Version Check (npm-based, not git-based)

Life-os checks git tags because it's distributed via git. DorkOS is distributed via npm.

**Recommendation:** Use the standard npm pattern: `npm outdated -g dorkos` or check the npm registry API. Libraries like `update-notifier` handle this elegantly with caching and non-blocking checks. This is the standard pattern for CLI tools (used by npm itself, create-react-app, etc.).

The check should run on CLI startup (`packages/cli/src/cli.ts`) and display a message like:
```
Update available: 0.1.0 → 0.2.0
Run `npm update -g dorkos` to update
```

#### 6. Git Tags

Start tagging releases with `v` prefix (e.g., `v0.1.0`). The `/system:release` command should create annotated tags. Retroactively tag current HEAD as `v0.1.0` (the first published version).

### What NOT to Adopt

1. **Upgrade notes system** - DorkOS is an npm package, not a git template. Users upgrade via `npm update`, not by merging upstream. Migration guides can go in GitHub Release notes or CHANGELOG.md when needed.

2. **Post-commit changelog amend** - Too aggressive for collaborative open-source. Risk of conflicts in PRs.

3. **Python scripts for backfill** - DorkOS is a Node.js project. Any automation scripts should be in TypeScript/JavaScript for consistency.

4. **`.user/upgrade.yaml` config** - DorkOS uses `~/.dork/config.json` (via `conf` library). Any upgrade preferences should go there.

---

## Implementation Priority

1. **Create `CHANGELOG.md`** — Immediate, easy win
2. **Create `VERSION` file** — Sync with current 0.1.0
3. **Tag v0.1.0** — Retroactive first tag
4. **Update `/system:release`** — Fix file references, add npm publish, fix GitHub URLs
5. **Add update notification** — `update-notifier` or similar in CLI startup
6. **Add `-v`/`--version` flag** — Standard CLI practice (may already exist via esbuild define)

---

## Monorepo-Specific Considerations

### Single Version vs. Independent Versions

**Current:** Root + CLI both at 0.1.0, other packages at 0.0.0.

**Recommendation:** Single version for the whole project ("fixed" versioning, like Turborepo itself uses). Rationale:
- Only one publishable package (CLI)
- Client, server, shared are internal — their versions don't matter to consumers
- Simpler mental model: "DorkOS 0.2.0" not "CLI 0.2.0, server 0.1.3, client 0.1.5"

### npm Publish in Release

The release command should include:
```bash
# After git tag + push
cd packages/cli && npm publish
```

This is already documented in CLAUDE.md memory: `npm publish -w packages/cli` with `prepublishOnly` auto-build.

### What Gets Versioned

Only these files need version updates during release:
- `VERSION` (source of truth)
- `packages/cli/package.json` (for npm publish)
- `package.json` (root, for consistency)
- `CHANGELOG.md` (release notes)
