# Task Breakdown: Marketplace Install

Generated: 2026-04-06
Source: `specs/marketplace-02-install/02-specification.md`
Last Decompose: 2026-04-06 (full)
Total tasks: 31

## Overview

Spec 2 of 5 for the DorkOS Marketplace project. Builds the install machinery: the `dorkos install/uninstall/update/marketplace/cache` CLI commands, four install flows (plugin/agent/skill-pack/adapter), atomic transactions with rollback, permission preview, conflict detection, local cache, marketplace source management, HTTP API endpoints under `/api/marketplace/*`, and a telemetry hook (no-op until spec 04). Foundation spec (01) is consumed but not modified. UI (spec 03) and registry (spec 04) build on top of this.

After this ships, `dorkos install code-review-suite@dorkos-community` works end-to-end via CLI and via HTTP.

---

## Phase 1: Foundation

Core services that everything else depends on. Tasks 1.2/1.3/1.4 can run in parallel after 1.1.

### Task 1.1: Create marketplace service module skeleton and shared types

**Size**: Small | **Priority**: High | **Dependencies**: None

Create `apps/server/src/services/marketplace/` directory tree (including `__tests__/`, `__tests__/flows/`, `flows/`, `fixtures/`). Add `types.ts` with the verbatim spec types: `MarketplaceSource`, `InstallRequest`, `PermissionPreview`, `ConflictReport`, `InstallResult`.

**Acceptance**: directories exist; `types.ts` exports all 5 interfaces; typecheck passes.

### Task 1.2: Implement marketplace-source-manager with marketplaces.json CRUD

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: 1.3, 1.4

`MarketplaceSourceManager` class managing `${dorkHome}/marketplaces.json`. CRUD methods: `list`, `get`, `add`, `remove`, `setEnabled`. Seeds `dorkos-community` and `claude-plugins-official` on first read. Atomic writes via tmp + rename. Constructor takes `dorkHome: string` (no `os.homedir()` fallback per `.claude/rules/dork-home.md`).

**Acceptance**: defaults seeded on first call; duplicate add throws; atomic write tested; full vitest coverage.

### Task 1.3: Implement marketplace-cache with TTL and content-addressable storage

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: 1.2, 1.4

`MarketplaceCache` class managing `${dorkHome}/cache/marketplace/` with `marketplaces/` (1h TTL) and `packages/` (content-addressable by commit SHA). Methods: `readMarketplace`, `writeMarketplace`, `getPackage`, `putPackage`, `listPackages`, `prune({ keepLastN })`, `clear`. TTL serves stale on failure. Tests use `vi.useFakeTimers()` for expiry.

### Task 1.4: Implement package-resolver for name@source resolution

**Size**: Medium | **Priority**: High | **Dependencies**: 1.2, 1.3

`PackageResolver.resolve(input)` handles 5 input formats: bare name, `name@marketplace`, `name@<git url>`, `github:user/repo` shorthand, local path. Throws typed errors `MarketplaceNotFoundError`, `PackageNotFoundError`, `AmbiguousPackageError`. Constructor takes `sourceManager` and `cache`.

### Task 1.5: Wire template-downloader integration for marketplace clones

**Size**: Medium | **Priority**: High | **Dependencies**: 1.3 | **Parallel with**: 1.4

`PackageFetcher` wraps existing `template-downloader.ts` (consumed via public API only — additive `cloneRepository` method allowed if existing API insufficient). Methods: `fetchFromGit` (resolves SHA via `git ls-remote`, caches by SHA, supports `force`) and `fetchMarketplaceJson` (TTL-aware, serves stale on network failure).

---

## Phase 2: Permission Preview & Conflict Detection

Tasks 2.1 and 2.2 are independent and can run in parallel; 2.3 wires them together.

### Task 2.1: Implement permission-preview builder

**Size**: Large | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: 2.2

`PermissionPreviewBuilder.build(packagePath, manifest, opts)` walks the package directory, reads `.claude-plugin/plugin.json`, `.dork/extensions/*/extension.json`, `.dork/tasks/*/SKILL.md`, `.dork/adapters/*/manifest.json`, and resolves `requires` against installed packages. Populates all 7 fields: `fileChanges`, `extensions`, `tasks`, `secrets`, `externalHosts`, `requires`, `conflicts`. Conflict detector is constructor-injected (initially stubbed; wired in 2.3).

### Task 2.2: Implement conflict-detector for slot/skill/task/cron/adapter collisions

**Size**: Large | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: 2.1

`ConflictDetector.detect(ctx)` reports 6 collision types with severity:

- Package name collision → error
- Slot collision (same priority) → warning
- Skill name collision → error
- Task name collision → error
- Cron collision (same minute, same agent) → warning
- Adapter ID collision (via mocked `adapterManager.list()`) → error

Errors block install unless `--force`; warnings don't block.

### Task 2.3: Wire conflict-detector into permission-preview builder

**Size**: Small | **Priority**: High | **Dependencies**: 2.1, 2.2

Replace TODO in `permission-preview.ts` with real `conflictDetector.detect()` call. Add at least one preview test that uses a real detector.

---

## Phase 3: Transaction Engine

### Task 3.1: Implement transaction engine with stage/activate/rollback

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: 2.1, 2.2

`runTransaction<T>(opts)` per spec contract: temp staging dir → optional backup branch → `stage` → `activate` → cleanup or rollback. Backup branch helpers shell out to git, no-op when CWD is not a git repo. Failure-path tests assert zero residual files on every error path: stage throws, activate throws, cleanup throws (logs but returns result).

---

## Phase 4: Install Flows

Tasks 4.1, 4.2, 4.3, 4.4, 4.5 are all parallel after Phase 3 lands. 4.6 (update) depends on 4.5 (uninstall).

### Task 4.1: Implement plugin install flow

**Size**: Medium | **Priority**: High | **Dependencies**: 3.1 | **Parallel with**: 4.2, 4.3, 4.4, 4.5

`PluginInstallFlow.install()` per spec: copy to staging, compile extensions via `extensionCompiler`, atomic rename to install root, register extensions via `extensionManager.enable`. Returns full `InstallResult`. EXDEV fallback for cross-filesystem rename.

### Task 4.2: Implement agent install flow

**Size**: Medium | **Priority**: High | **Dependencies**: 3.1 | **Parallel with**: 4.1, 4.3, 4.4, 4.5

`AgentInstallFlow.install()` per spec: copy to staging, atomic rename, call existing `agentCreator.createAgentWorkspace({ skipTemplateDownload: true, traits: manifest.agentDefaults?.traits })`. Mesh registration handled by `mesh-core` reconciler.

### Task 4.3: Implement skill-pack install flow

**Size**: Small | **Priority**: High | **Dependencies**: 3.1 | **Parallel with**: 4.1, 4.2, 4.4, 4.5

`SkillPackInstallFlow.install()` per spec: copy to staging, re-validate every SKILL.md via `@dorkos/skills`, atomic rename. Skills auto-discovered by Claude Code; tasks by `task-file-watcher`.

### Task 4.4: Implement adapter install flow

**Size**: Medium | **Priority**: High | **Dependencies**: 3.1 | **Parallel with**: 4.1, 4.2, 4.3, 4.5

`AdapterInstallFlow.install()` per spec: copy to staging, atomic rename, call `adapterManager.addAdapter({...})`. `rollbackBranch: false` — compensating `removeAdapter` on post-add failure. Returns warnings array including a "configure secrets" hint.

### Task 4.5: Implement uninstall flow with --purge support

**Size**: Medium | **Priority**: High | **Dependencies**: 3.1 | **Parallel with**: 4.1, 4.2, 4.3, 4.4

`UninstallFlow.uninstall(req)` locates the installed package, disables extensions, removes adapter entries, moves to staging for safety, preserves `.dork/data/` and `.dork/secrets.json` unless `--purge`. Throws `PackageNotInstalledError` when missing. Idempotency tested.

### Task 4.6: Implement update flow with advisory + apply modes

**Size**: Medium | **Priority**: High | **Dependencies**: 4.5

`UpdateFlow.run(req)` lists installed packages, fetches `marketplace.json` for each source, semver-compares versions. Advisory by default (returns checks, no side effects). `apply: true` triggers uninstall-without-purge → install pattern (preserves data).

---

## Phase 5: Orchestrator & Telemetry

### Task 5.1: Implement MarketplaceInstaller orchestrator

**Size**: Large | **Priority**: High | **Dependencies**: 1.4, 1.5, 2.3, 4.1, 4.2, 4.3, 4.4, 4.5 | **Parallel with**: 5.2

`MarketplaceInstaller.preview()` and `.install()`. Algorithm: resolve → fetch → validate → preview → conflict gate (with `--force` override) → dispatch to type-specific flow → telemetry. Throws `InvalidPackageError` and `ConflictError`. Telemetry hook called on every terminal state.

### Task 5.2: Implement telemetry hook with no-op default reporter

**Size**: Small | **Priority**: Medium | **Dependencies**: 1.1 | **Parallel with**: 5.1

`telemetry-hook.ts` per spec verbatim: `InstallEvent`, `TelemetryReporter`, `registerTelemetryReporter`, `reportInstallEvent`, plus `_resetTelemetryReporter` (`@internal`). No-op default; reporter errors swallowed.

---

## Phase 6: HTTP API

Tasks 6.1 and 6.2 are parallel; 6.3 wires both into the server.

### Task 6.1: Implement marketplace HTTP routes (sources + cache + installed)

**Size**: Large | **Priority**: High | **Dependencies**: 1.2, 1.3, 1.5 | **Parallel with**: 6.2

8 endpoints: `GET/POST /sources`, `DELETE /sources/:name`, `POST /sources/:name/refresh`, `GET /installed`, `GET /installed/:name`, `GET /cache`, `DELETE /cache`. Exports `createMarketplaceRouter(deps)` factory. Zod validation + OpenAPI registration on every endpoint.

### Task 6.2: Implement marketplace HTTP routes (packages + install + uninstall + update)

**Size**: Large | **Priority**: High | **Dependencies**: 5.1, 4.6 | **Parallel with**: 6.1

6 endpoints: `GET /packages`, `GET /packages/:name`, `POST /packages/:name/preview`, `POST /packages/:name/install`, `POST /packages/:name/uninstall`, `POST /packages/:name/update`. Centralized error → status mapping (400/404/409/500). SSE clone progress is optional polish — either complete or omit with TODO link.

### Task 6.3: Wire marketplace router into apps/server/src/index.ts

**Size**: Small | **Priority**: High | **Dependencies**: 6.1, 6.2

Construct all marketplace services in `index.ts` with shared instances of existing services (`extensionManager`, `extensionCompiler`, `adapterManager`, `agentCreator`, `templateDownloader`). Mount router at `/api/marketplace`. Smoke test: `curl /api/marketplace/sources` returns 200.

---

## Phase 7: CLI

All three tasks are parallel after 6.3 lands.

### Task 7.1: Implement install/uninstall/update CLI subcommands

**Size**: Large | **Priority**: High | **Dependencies**: 6.3 | **Parallel with**: 7.2, 7.3

Top-level interception in `cli.ts` (mirrors existing `package` block) for `install`, `uninstall`, `update`. Install command flow: preview → render → confirm (`--yes` bypass) → install → print result. CLI calls HTTP API. Brand voice: confident, minimal, technical. Exit codes 0/1.

### Task 7.2: Implement marketplace add/remove/list/refresh CLI subcommands

**Size**: Medium | **Priority**: High | **Dependencies**: 6.3 | **Parallel with**: 7.1, 7.3

Top-level `marketplace` interception block. Four subcommand files. `list` renders a table. `refresh` without name refreshes all sources in parallel. Help text for parent and each subcommand.

### Task 7.3: Implement cache CLI subcommands (list/prune/clear)

**Size**: Small | **Priority**: Medium | **Dependencies**: 6.3 | **Parallel with**: 7.1, 7.2

`cache list/prune/clear`. Adds `POST /api/marketplace/cache/prune` endpoint (extends task 6.1). `clear` confirms with prompt unless `--yes`.

---

## Phase 8: Integration & Failure-Path Tests

8.1 is independent and can start in Phase 1. 8.2/8.3 run after 5.1 and 8.1. 8.4 is the final cross-platform sweep.

### Task 8.1: Build fixture packages for end-to-end install tests

**Size**: Medium | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: 2.1, 2.2, 3.1

Fixtures under `services/marketplace/fixtures/`: `valid-plugin`, `valid-agent`, `valid-skill-pack`, `valid-adapter`, plus `broken/invalid-manifest`, `broken/missing-extension-code`, `broken/conflicting-skill`. Each ≤ 5 KB. Sanity test confirms valid fixtures pass and broken ones fail `validatePackage`. README documents each fixture.

### Task 8.2: Write end-to-end integration tests for all four flows

**Size**: Large | **Priority**: High | **Dependencies**: 5.1, 8.1 | **Parallel with**: 8.3

One install test per package type using real install flows (no mocking marketplace internals). Mock only the network boundary. Helper `buildInstallerForTests(dorkHome)` extracted at top of file. Each test cleans up its temp dorkHome.

### Task 8.3: Write failure-path tests for atomic rollback

**Size**: Large | **Priority**: High | **Dependencies**: 5.1, 8.1 | **Parallel with**: 8.2

5 scenarios from spec: network failure during clone, validation failure after stage, activation failure with backup branch restore, conflict detection failure (no force), force override of conflicts. Each test asserts disk state — zero residual files on failure.

### Task 8.4: Verify cross-platform path handling on Windows in CI

**Size**: Small | **Priority**: Medium | **Dependencies**: 8.2, 8.3

Audit for hard-coded `/` paths. Extract `atomicMove` helper with EXDEV fallback, use in all four install flows. Add Windows to CI matrix for marketplace tests. Confirm green.

---

## Phase 9: Documentation

All four tasks are parallel after 8.4.

### Task 9.1: Write contributing/marketplace-installs.md developer guide

**Size**: Medium | **Priority**: Medium | **Dependencies**: 7.3, 8.4 | **Parallel with**: 9.2, 9.3, 9.4

14-section developer guide covering architecture, service module map, four flows, transaction lifecycle, preview semantics, conflict types, cache layout, recipe for adding a new flow, HTTP API reference, CLI reference, telemetry, cross-platform, testing strategy. Brand voice. Cross-references to spec and ADRs.

### Task 9.2: Update AGENTS.md to document marketplace service domain

**Size**: Small | **Priority**: Medium | **Dependencies**: 9.1 | **Parallel with**: 9.3, 9.4

Add `services/marketplace/` to Service domains list. Add row for `contributing/marketplace-installs.md` in the guides table.

### Task 9.3: Add CHANGELOG entry for marketplace install machinery

**Size**: Small | **Priority**: Medium | **Dependencies**: 7.3 | **Parallel with**: 9.1, 9.2, 9.4

Unreleased entry summarizing user-visible changes: install/uninstall/update commands, marketplace source management, cache management, HTTP API. Tone matches existing CHANGELOG. Use writing-changelogs skill.

### Task 9.4: Extract ADRs from spec via /adr:from-spec

**Size**: Small | **Priority**: Low | **Dependencies**: 8.4 | **Parallel with**: 9.1, 9.2, 9.3

At most 3 significant ADRs: atomic transaction strategy, cache TTL + content-addressable storage, advisory-only update strategy. Optionally: telemetry hook pattern. Update `decisions/manifest.json`. Cross-reference from developer guide.

---

## Critical Path

```
1.1 → 1.3 → 1.5 ─┐
       └→ 1.2 → 1.4 ┤
                    ├→ 2.3 → 5.1 → 6.2 → 6.3 → 7.1/7.2/7.3 → 9.1
1.1 → 2.1, 2.2 ────┘                                            └→ 9.2
1.1 → 3.1 → 4.1/4.2/4.3/4.4/4.5 → 4.6
                                  └→ (5.1) ──┘
1.1 → 8.1 → 8.2/8.3 → 8.4 → 9.4
```

Longest chain: 1.1 → 1.3 → 1.5 → 5.1 → 6.2 → 6.3 → 7.1 → 9.1 → 9.2 (9 tasks).

## Parallelism Highlights

- **Phase 1 fan-out**: 1.2, 1.3, 1.4 (after 1.1) and 1.5 (after 1.3) are mostly parallel.
- **Phase 2/3 cross-phase parallel**: 2.1, 2.2, 3.1, 8.1 can all run after 1.1 with no shared dependencies.
- **Phase 4 fan-out**: 4.1, 4.2, 4.3, 4.4, 4.5 are 5-way parallel after 3.1.
- **Phase 6 parallel**: 6.1 and 6.2 run side by side.
- **Phase 7 parallel**: 7.1, 7.2, 7.3 all parallel after 6.3.
- **Phase 8 parallel**: 8.2 and 8.3 parallel after 5.1 + 8.1.
- **Phase 9 parallel**: 9.1, 9.2, 9.3, 9.4 mostly parallel after 8.4.

## Acceptance Criteria Coverage

The 16 acceptance criteria from the spec map to tasks as follows:

| Spec criterion                            | Tasks                             |
| ----------------------------------------- | --------------------------------- |
| `dorkos install` works for all 4 types    | 4.1, 4.2, 4.3, 4.4, 5.1, 7.1, 8.2 |
| Permission preview accurate               | 2.1, 2.3, 8.2                     |
| Failed installs leave zero residual files | 3.1, 8.3                          |
| Backup branches respected                 | 3.1, 8.3                          |
| 5 conflict types detected                 | 2.2, 8.3                          |
| Cache hit rate observable + > 80%         | 1.3, 1.5                          |
| OpenAPI documentation                     | 6.1, 6.2                          |
| `dorkos uninstall` works                  | 4.5, 7.1                          |
| `--purge` works                           | 4.5, 7.1                          |
| `dorkos update` notifies                  | 4.6, 7.1                          |
| `dorkos update --apply` runs install      | 4.6, 7.1                          |
| Marketplace source commands               | 1.2, 7.2                          |
| Cross-platform CI passes                  | 8.4                               |
| Unit + integration + failure-path tests   | (every task) + 8.2 + 8.3          |
| Telemetry hook in place                   | 5.2, 5.1                          |
| Zero changes to existing services         | 1.5, 4.1, 4.2, 4.4                |
