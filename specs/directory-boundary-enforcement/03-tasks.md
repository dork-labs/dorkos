# Task Breakdown: Centralized Directory Boundary Enforcement
Generated: 2026-02-16
Source: specs/directory-boundary-enforcement/02-specification.md
Last Decompose: 2026-02-16

## Overview

Break the directory boundary enforcement spec into 8 tasks across 5 phases. The spec centralizes directory boundary validation into a shared utility, enforces it across all API endpoints and services, makes the boundary configurable, and fixes a prefix collision security bug.

## Phase 1: Core Infrastructure

### Task 1.1: Create Boundary Utility Module
**Description**: Create `apps/server/src/lib/boundary.ts` with `BoundaryError`, `initBoundary()`, `getBoundary()`, `validateBoundary()`, and `isWithinBoundary()`. Includes comprehensive unit tests at `apps/server/src/lib/__tests__/boundary.test.ts`.
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

### Task 1.2: Update Config Schema and CLI
**Description**: Add `server.boundary` to `UserConfigSchema` in `packages/shared/src/config-schema.ts`. Add `--boundary` CLI flag, `DORKOS_BOUNDARY` env var handling, and startup CWD validation to `packages/cli/src/cli.ts`. Update config schema tests.
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

## Phase 2: Server Initialization

### Task 2.1: Server Startup Boundary Init
**Description**: Update `apps/server/src/index.ts` to call `initBoundary()` at server startup, before `createApp()`.
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1

## Phase 3: Route-Level Enforcement

### Task 3.1: Refactor Directory Route and Add Validation to Sessions Route
**Description**: Refactor `routes/directory.ts` to replace hardcoded HOME with shared boundary utility. Add `validateBoundary()` to all cwd-accepting endpoints in `routes/sessions.ts`. Update existing directory route tests.
**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Task 3.2

### Task 3.2: Add Validation to Files, Commands, and Git Routes
**Description**: Add `validateBoundary()` boundary checks to `routes/files.ts`, `routes/commands.ts`, and `routes/git.ts`.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Task 3.1

## Phase 4: Service-Level Enforcement

### Task 4.1: Add Defense-in-Depth to Services
**Description**: Add `validateBoundary()` calls to `agent-manager.ts` (sendMessage), `transcript-reader.ts` (all public methods), `file-lister.ts` (listFiles), and `git-status.ts` (getGitStatus). Command registry validates at the route/helper level since its constructor cannot be async.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1

## Phase 5: Tests & Documentation

### Task 5.1: Route Boundary Rejection Tests
**Description**: Add 403 boundary rejection tests for sessions, files, commands, and git routes. These verify that each route properly rejects requests with `cwd`/`dir`/`path` outside the configured boundary.
**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1, Task 3.2

### Task 5.2: Documentation Updates
**Description**: Update `guides/configuration.md`, `CLAUDE.md`, and `docs/getting-started/configuration.mdx` with `server.boundary` config reference, `DORKOS_BOUNDARY` env var, and `--boundary` CLI flag.
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.2

## Dependency Graph

```
Task 1.1 ──> Task 2.1 ──┬──> Task 3.1 ──┐
                         ├──> Task 3.2 ──┼──> Task 5.1
                         └──> Task 4.1 ──┘
Task 1.2 ──> Task 5.2
```

## Task IDs (for /spec:execute)

| Task | ID |
|------|----|
| 1.1 Create Boundary Utility Module | #1 |
| 1.2 Update Config Schema and CLI | #2 |
| 2.1 Server Startup Boundary Init | #3 |
| 3.1 Refactor Directory + Sessions Routes | #4 |
| 3.2 Validate Files, Commands, Git Routes | #5 |
| 4.1 Defense-in-Depth Services | #6 |
| 5.1 Route Boundary Rejection Tests | #7 |
| 5.2 Documentation Updates | #8 |

## Parallel Execution Opportunities

- **Phase 1**: Tasks 1.1 and 1.2 can run in parallel (no shared dependencies)
- **Phase 3**: Tasks 3.1 and 3.2 can run in parallel (both depend on 2.1, touch different files)
- **Phase 3/4**: Task 4.1 can run in parallel with 3.1/3.2 (only depends on 2.1)
- **Phase 5**: Task 5.2 can run in parallel with Phase 3/4 (only depends on 1.2)
