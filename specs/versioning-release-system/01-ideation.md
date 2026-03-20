---
slug: versioning-release-system
number: 33
created: 2026-02-16
status: ideation
---

# Versioning, Release & Update System

**Slug:** versioning-release-system
**Author:** Claude Code
**Date:** 2026-02-16
**Related:** [Research: Versioning & Release System](../../research/versioning-and-release-system.md)

---

## 1) Intent & Assumptions

- **Task brief:** Create a world-class, semi-autonomous versioning, release, and update/upgrade system for DorkOS. This includes establishing a single source of truth for the version, displaying it properly in CLI and web UI, automating changelogs and release notes, notifying users of updates, and building a Claude Code harness that handles most of the release process autonomously.
- **Assumptions:**
  - DorkOS is distributed via npm (`npm install -g dorkos`) — this is the primary distribution channel
  - Only one package is published (the CLI at `packages/cli`), so we use "fixed" single-version strategy for the monorepo
  - We want the release process to be orchestrated by Claude Code commands/skills (not GitHub Actions for now)
  - The existing `/system:release` command and `/writing-changelogs` skill are the starting points to build on
  - Conventional commits are desired but not strictly enforced (backfill handles gaps)
- **Out of scope:**
  - GitHub Actions CI/CD pipeline (future work)
  - Changesets library (designed for multi-package publishing, overkill for us)
  - Auto-publish on merge (we want human-in-the-loop via `/system:release`)
  - Obsidian plugin versioning (separate release cycle, different distribution)

---

## 2) Pre-reading Log

- `packages/cli/package.json`: Version 0.1.0, has `prepublishOnly` build hook
- `packages/cli/scripts/build.ts:13-14,64`: Reads version from package.json, injects as `__CLI_VERSION__` via esbuild define
- `packages/cli/src/cli.ts`: CLI entry point — currently uses `__CLI_VERSION__` but no `--version` flag handling visible
- `package.json` (root): Version 0.1.0, workspace config
- `apps/server/src/routes/health.ts`: Health endpoint returns `version` field
- `apps/server/src/routes/config.ts`: Config endpoint returns `ServerConfig` with `version` field
- `packages/shared/src/schemas.ts`: `HealthResponseSchema` and `ServerConfigSchema` both have `version: z.string()` fields
- `apps/client/src/layers/features/status/`: StatusLine component with multiple items (GitStatusItem, ModelItem, etc.)
- `apps/client/src/layers/features/settings/`: SettingsDialog with config display (shows version in ConfigRow)
- `.claude/commands/system/release.md`: Existing release command — references `VERSION` file and `CHANGELOG.md` that don't exist; has wrong GitHub URLs (`doriancollier/dorkian-next-stack`)
- `.claude/skills/changelog-writing/`: Existing skill for writing user-friendly changelog entries (writing-changelogs)
- `research/versioning-and-release-system.md`: Detailed comparison with life-os-starter system

---

## 3) Codebase Map

**Primary Components/Modules:**

| File                                        | Role                                           | Needs Changes                           |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------------- |
| `packages/cli/package.json`                 | Published package version (0.1.0)              | Version sync during release             |
| `packages/cli/scripts/build.ts`             | Injects `__CLI_VERSION__` at build time        | May need to read VERSION file instead   |
| `packages/cli/src/cli.ts`                   | CLI entry point (already has `--version`/`-v`) | Add startup banner, update notification |
| `package.json` (root)                       | Workspace root version                         | Sync during release                     |
| `apps/server/src/routes/health.ts`          | Returns version in health check                | Already works (reads from package.json) |
| `apps/server/src/routes/config.ts`          | Returns ServerConfig with version              | Already works                           |
| `apps/client/src/layers/features/settings/` | Shows version in settings                      | Already shows version from config       |
| `apps/client/src/layers/features/status/`   | Status bar items                               | Add version/update indicator            |
| `.claude/commands/system/release.md`        | Release orchestrator                           | Major overhaul needed                   |

**Shared Dependencies:**

- `packages/shared/src/schemas.ts` — `HealthResponseSchema`, `ServerConfigSchema` (both have version field)
- `packages/shared/src/config-schema.ts` — `UserConfigSchema` for `~/.dork/config.json`
- `apps/client/src/layers/shared/lib/http-transport.ts` — `HttpTransport` (fetches config/health)

**Data Flow (Version):**

```
VERSION file (source of truth)
  → packages/cli/package.json (synced at release time)
  → esbuild define __CLI_VERSION__ (injected at build time)
  → CLI startup banner (terminal output)
  → Express server package.json read (runtime)
  → /api/health + /api/config endpoints (HTTP)
  → Client SettingsDialog + StatusLine (React UI)
```

**Potential Blast Radius:**

- Direct: 8-10 files (new + modified)
- New files: `VERSION`, `CHANGELOG.md`, update-check module
- Modified: CLI entry, release command, possibly StatusLine
- Tests: health route tests, CLI tests (if any)

---

## 4) Answers to Open Questions

### Q: What version are we currently on?

**A: 0.1.0** — specified in `package.json` (root) and `packages/cli/package.json`.

### Q: Where and how is that specified? Is it handled correctly? Is it DRY?

**A:** Version lives in two package.json files. The build script reads from `packages/cli/package.json` and injects via esbuild `define`. It works but is **not DRY** — root and CLI versions can drift with no sync mechanism. See Section 5 for the fix.

### Q: How does our system currently handle versioning?

**A:** Manual `npm version patch` in `packages/cli/`, then `npm publish -w packages/cli`. No changelog, no git tags, no release notes, no update notifications. The `/system:release` command exists but references files that don't exist (`VERSION`, `CHANGELOG.md`).

### Q: Are we following best practices?

**A:** Not yet. Missing: git tags, changelog, single version source of truth, `--version` CLI flag, update notifications, release automation. The esbuild injection pattern is solid though.

### Q: Best practices for displaying version numbers?

**A:**

- **CLI `--version` flag**: Universal standard. `dorkos --version` → `0.1.0`. Every CLI tool supports this.
- **Startup banner**: Show version + port on server start. Pattern: `DorkOS v0.1.0 ready on http://localhost:4242`
- **Web UI**: Version in Settings dialog (already done via ServerConfig). Optionally in status bar as a subtle item.
- **Examples**: Vite shows `vite v6.1.2` on dev start. Next.js shows `ready - started server on 0.0.0.0:3000`. npm shows version on `npm --version`.

### Q: Where should the version number be kept?

**A:** Root `VERSION` file as single source of truth. The `/system:release` command syncs it to `packages/cli/package.json` and root `package.json` during release. The build script reads from `packages/cli/package.json` (already injected by release). This is the pattern used by life-os-starter and many non-npm projects.

### Q: Should it be displayed in the terminal when people start the app?

**A:** Yes. Standard pattern:

```
  DorkOS v0.1.0
  Server:  http://localhost:4242
  Network: http://192.168.1.5:4242
```

### Q: Should we have -v --version commands in the CLI? Do we?

**A:** Yes, and **we already do.** `packages/cli/src/cli.ts` has `parseArgs` with `version: { type: 'boolean', short: 'v' }`. Running `dorkos --version` or `dorkos -v` prints `__CLI_VERSION__` and exits. This is already implemented correctly.

### Q: Should we display the version in the client? If so, where?

**A:** Yes — already visible in Settings dialog. Additionally:

- Status bar: subtle version badge (leftmost or rightmost item)
- When an update is available: status bar item turns into an update indicator

### Q: How do we make it so that people who install the package are notified of new versions automatically?

**A:** Use the `update-notifier` pattern (npm's own approach):

1. On CLI startup, check npm registry in background (non-blocking)
2. Cache result for 24 hours (in `~/.dork/cache/`)
3. If newer version exists, display a boxed message:
   ```
   ┌─────────────────────────────────────────┐
   │   Update available: 0.1.0 → 0.2.0      │
   │   Run npm update -g dorkos to update    │
   └─────────────────────────────────────────┘
   ```

### Q: What are the normal patterns for update notification?

**A:**

- **CLI**: `update-notifier` or `simple-update-notifier` — used by npm, Yeoman, Gatsby, Angular CLI. Checks npm registry, caches for configurable interval, shows boxed message.
- **Web UI**: Banner/toast pattern — subtle, non-intrusive. Grafana shows "New version available" in the footer. Home Assistant shows an update badge on the settings icon.

### Q: How do we show update availability in the UI?

**A:** Two-tier approach:

1. **Status bar**: Add "Update available" badge item when server reports newer version
2. **Settings dialog**: Show current version vs latest, with update instructions

The server already has a `/api/health` endpoint that includes version. We could add a `latestVersion` field (fetched from npm registry, cached) to `ServerConfig` or a new `/api/update-check` endpoint.

### Q: Do we show this in the console during startup?

**A:** Yes, after the startup banner if an update is available. Non-blocking — the check happens in background, result shown from cache if available.

---

## 5) Research Summary

### From life-os-starter Analysis

The life-os-starter repo has a mature system with:

- `VERSION` file as source of truth
- Post-commit changelog auto-population (conventional commits)
- `/system:release` orchestrator with subagent analysis
- Version check on SessionStart (git tags, cached 24h)
- Upgrade notes per version

**What to adopt:** VERSION file, changelog format, release orchestrator pattern, subagent analysis, user-friendly changelog rewriting.

**What to skip:** Post-commit amend hook (too aggressive for OSS PRs), Python scripts (we're Node.js), upgrade notes system (npm handles upgrades), git-based version check (npm registry is better for us).

### From Industry Research

- **update-notifier** is the de facto standard for CLI update notifications (used by npm itself)
- **Keep a Changelog** format is widely understood and machine-parseable
- **npm version** command handles version bumps + git tags in one step
- **GitHub Release notes** should be narrative, not just changelog copy
- **Web UI update indicators** should be non-intrusive (banner or badge, not modal)

---

## 6) Proposed System Architecture

### Version Source of Truth

```
VERSION (root file, e.g. "0.2.0")
    │
    ├─→ packages/cli/package.json  (synced by /system:release)
    ├─→ package.json (root)        (synced by /system:release)
    └─→ esbuild define             (reads cli/package.json at build time)
           └─→ __CLI_VERSION__     (available at runtime in CLI + server)
```

### Release Flow

```
Developer runs /system:release [patch|minor|major]
    │
    ├─ Phase 1: Pre-flight checks (clean git, on main, etc.)
    ├─ Phase 2: Changelog backfill (analyze commits since last tag)
    ├─ Phase 3: Version analysis (subagent: auto-detect bump type)
    ├─ Phase 4: User confirmation (show preview, allow override)
    ├─ Phase 5: Execute
    │   ├─ Update VERSION file
    │   ├─ Sync to package.json files
    │   ├─ Finalize CHANGELOG.md ([Unreleased] → [X.Y.Z])
    │   ├─ Git commit + annotated tag
    │   ├─ Git push + tag push
    │   ├─ npm publish -w packages/cli
    │   └─ GitHub Release (narrative notes via /writing-changelogs skill)
    └─ Phase 6: Report (links, summary)
```

### Update Notification Flow

```
User runs `dorkos` CLI
    │
    ├─ Check ~/.dork/cache/update-check.json (is cache fresh?)
    │   ├─ Yes: use cached result
    │   └─ No: background fetch npm registry (non-blocking, 3s timeout)
    │         └─ Save to cache (24h TTL)
    │
    ├─ If newer version: display boxed update message in terminal
    │
    └─ Server starts, includes version in /api/config
        └─ Client fetches config
            ├─ Shows version in Settings + Status Bar
            └─ If latestVersion > currentVersion: show update badge
```

### Files to Create

| File                               | Purpose                                         |
| ---------------------------------- | ----------------------------------------------- |
| `VERSION`                          | Single source of truth for version (plain text) |
| `packages/cli/src/update-check.ts` | npm registry check with caching                 |

> **Note:** `CHANGELOG.md` already exists with a `[0.1.0]` release and empty `[Unreleased]` section. No need to create it.

### Files to Modify

| File                                      | Changes                                                   |
| ----------------------------------------- | --------------------------------------------------------- |
| `packages/cli/src/cli.ts`                 | Add `--version` flag, startup banner, update notification |
| `packages/cli/scripts/build.ts`           | Optional: read from VERSION instead of package.json       |
| `.claude/commands/system/release.md`      | Major overhaul: fix file refs, add npm publish, fix URLs  |
| `apps/server/src/routes/health.ts`        | Optionally add `latestVersion` field                      |
| `apps/client/src/layers/features/status/` | Add version/update status bar item                        |
| `specs/manifest.json`                     | Add this spec                                             |

### Claude Code Harness Components

| Component               | Type         | Purpose                                                                              |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------ |
| `/system:release`       | Command      | Orchestrates full release (existing, needs overhaul)                                 |
| `/writing-changelogs`   | Skill        | Guides user-friendly changelog entry writing (existing)                              |
| `CHANGELOG.md` backfill | Script logic | Analyze commits since last tag, generate missing entries (new, in release command)   |
| Release analyzer        | Subagent     | Auto-detect bump type from changelog + commits (existing pattern in release command) |

---

## 7) Decisions (Resolved)

1. **VERSION file as source of truth** — Root `VERSION` file (plain text), synced to package.json files by `/system:release`.
2. **npm publish in release command** — Yes, included in `/system:release` with an AskUserQuestion confirmation prompt before publishing.
3. **Custom update check** — ~30 lines, fetch npm registry, cache in `~/.dork/cache/update-check.json` (24h TTL, 3s timeout). No new dependencies.
4. **Update indicator in status bar + settings** — Status bar badge changes to "Update available" when outdated. Settings > Server tab shows current vs latest with update instructions.
5. **Pre-release versions deferred** — No alpha/beta/rc support now. Bolt on when approaching 1.0.
6. **Retroactive v0.1.0 tag** — Yes, tag the commit that was published to npm.
