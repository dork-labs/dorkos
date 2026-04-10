# Tasks System Redesign — Task Breakdown

**Spec:** `specs/tasks-system-redesign/02-specification.md`
**Generated:** 2026-03-29
**Mode:** Full decomposition

---

## Phase 1: Rename (Pulse to Tasks)

Mechanical rename with no new functionality. Each task can be verified independently, but the full phase must pass the verification gate before proceeding.

### 1.1 — Rename shared types and schemas from Pulse to Tasks

**Size:** Medium | **Priority:** High | **Dependencies:** None

Rename all Pulse-related types, schemas, and interfaces in three shared package files:

- `packages/shared/src/schemas.ts` — Rename `PulseScheduleSchema` -> `TaskSchema`, `PulseRunSchema` -> `TaskRunSchema`, `PulsePresetSchema` -> `TaskTemplateSchema`, all status/trigger schemas, all input types (`CreateScheduleInput` -> `CreateTaskInput`, etc.), and OpenAPI display names. **Important:** The existing `TaskStatus` type (for session tasks) collides — rename it to `SessionTaskStatus` first.
- `packages/shared/src/relay-envelope-schemas.ts` — Rename `PulseDispatchPayloadSchema` -> `TaskDispatchPayloadSchema`, rename internal fields `scheduleId` -> `taskId`, `scheduleName` -> `taskName`, type literal `'pulse_dispatch'` -> `'task_dispatch'`.
- `packages/shared/src/transport.ts` — Rename all Transport interface methods: `listSchedules` -> `listTasks`, `createSchedule` -> `createTask`, etc. Update TSDoc and section comment.

### 1.2 — Rename DB schema file and Drizzle exports from Pulse to Tasks

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Rename `packages/db/src/schema/pulse.ts` to `packages/db/src/schema/tasks.ts`. Keep `sqliteTable()` string names as `'pulse_schedules'` and `'pulse_runs'`. Update barrel imports and all cross-package references.

### 1.3 — Rename server service directory and classes from Pulse to Tasks

**Size:** Large | **Priority:** High | **Dependencies:** 1.1, 1.2

Rename `apps/server/src/services/pulse/` to `apps/server/src/services/tasks/`. Rename files (`pulse-store.ts` -> `task-store.ts`, `scheduler-service.ts` -> `task-scheduler-service.ts`, etc.) and classes (`PulseStore` -> `TaskStore`, `SchedulerService` -> `TaskSchedulerService`). Update all internal imports across the server and rename test files.

### 1.4 — Rename server route file and API paths from Pulse to Tasks

**Size:** Large | **Priority:** High | **Dependencies:** 1.1, 1.3

Rename `apps/server/src/routes/pulse.ts` to `tasks.ts`. Update all API paths from `/api/pulse/schedules` to `/api/tasks`. Flatten: schedules are now the top-level resource. Update route registration in `index.ts`, OpenAPI tags, client `HttpTransport` paths, `pulse-methods.ts` -> `task-methods.ts`, and `DirectTransport` stubs.

### 1.5 — Rename MCP tools file and tool identifiers from Pulse to Tasks

**Size:** Medium | **Priority:** High | **Dependencies:** 1.3 | **Parallel with:** 1.4

Rename `pulse-tools.ts` to `task-tools.ts`. Update all MCP tool names and descriptions. Update config schema `pulseTools` -> `taskTools`.

### 1.6 — Rename client entity layer from Pulse to Tasks

**Size:** Large | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2, 1.3

Rename `apps/client/src/layers/entities/pulse/` to `entities/tasks/`. Rename all hook files and exports (`useSchedules` -> `useTasks`, `useRuns` -> `useTaskRuns`, etc.). Update TanStack Query keys, Transport method calls, barrel exports, and all consumer imports.

### 1.7 — Rename client feature layer from Pulse to Tasks

**Size:** Large | **Priority:** High | **Dependencies:** 1.6

Rename `apps/client/src/layers/features/pulse/` to `features/tasks/`. Rename all component files (`PulsePanel` -> `TaskPanel`, `ScheduleRow` -> `TaskRow`, `CreateScheduleDialog` -> `CreateTaskDialog`, etc.). Update barrel exports and all consumers. Also rename associated files: `PulseDialogWrapper`, `PulsePresetsStep`, `SchedulesDialog`, `PulseShowcases`.

### 1.8 — Remove PULSE_ENABLED feature flag and update UI labels

**Size:** Medium | **Priority:** High | **Dependencies:** 1.6, 1.7

Remove `DORKOS_PULSE_ENABLED` from server env, `--pulse` from CLI, feature gates from client. Update all UI labels to "Tasks". Rename `pulseBadgeCount` -> `tasksBadgeCount` in app store. Replace `HeartPulse` icon with `Zap` in sidebar. Update onboarding steps from `'pulse'` to `'tasks'`.

### 1.9 — Update documentation, AGENTS.md, and OpenAPI references

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.4, 1.5, 1.7, 1.8

Update AGENTS.md, contributing guides, OpenAPI docs, and dev playground references to reflect the rename.

### 1.10 — Run verification gate for Phase 1

**Size:** Small | **Priority:** High | **Dependencies:** 1.9

Run `pnpm typecheck && pnpm build && pnpm test -- --run`. Grep for residual "Pulse" references. All must pass before Phase 2.

---

## Phase 2: DB Schema + Damon

Prepare the data layer for file-backed tasks and the Damon system agent.

### 2.1 — Add filePath and tags columns to pulse_schedules schema

**Size:** Medium | **Priority:** High | **Dependencies:** 1.10 | **Parallel with:** 2.2

Add `filePath TEXT NOT NULL` and `tags_json TEXT NOT NULL DEFAULT '[]'` to `pulse_schedules` Drizzle schema. Drop existing schedule and run data (alpha clean slate). Update `TaskSchema` and `Task` type in shared package. Update `TaskStore` CRUD to handle filePath and tags (JSON serialization).

### 2.2 — Add isSystem column to agents schema

**Size:** Medium | **Priority:** High | **Dependencies:** 1.10 | **Parallel with:** 2.1

Add `isSystem INTEGER NOT NULL DEFAULT 0` to agents table in `packages/db/src/schema/mesh.ts`. Update agent types in shared package. Update MeshCore to handle `isSystem` in CRUD and prevent unregistration of system agents.

### 2.3 — Implement ensureDamon() and system agent delete protection

**Size:** Medium | **Priority:** High | **Dependencies:** 2.2

Create `ensureDamon()` function that auto-registers the Damon system agent on startup (id: `'damon'`, namespace: `'system'`, isSystem: true, projectPath: dorkHome). Wire into server startup. Add 403 rejection for deleting system agents in API and MeshCore. Add tests for registration, idempotency, and delete protection.

### 2.4 — Run verification gate for Phase 2

**Size:** Small | **Priority:** High | **Dependencies:** 2.1, 2.2, 2.3

Run `pnpm typecheck && pnpm build && pnpm test -- --run`. Manually verify Damon appears in agent list, cannot be deleted, and DB schema has new columns.

---

## Phase 3: File Infrastructure

Files become the sole source of truth for task definitions.

### 3.1 — Implement TaskFileParser with frontmatter schema and validation

**Size:** Medium | **Priority:** High | **Dependencies:** 2.4 | **Parallel with:** 3.2

Create `task-file-parser.ts` with `TaskFrontmatterSchema` (Zod), `TaskDefinition` interface, `parseTaskFile()` function (gray-matter + Zod + kebab-case validation), and `isParseError()` type guard. Add comprehensive tests.

### 3.2 — Implement TaskFileWriter with atomic writes

**Size:** Small | **Priority:** High | **Dependencies:** 2.4 | **Parallel with:** 3.1

Create `task-file-writer.ts` with `writeTaskFile()` (atomic temp+rename pattern) and `deleteTaskFile()`. Add tests including round-trip verification with `parseTaskFile()`.

### 3.3 — Add upsertFromFile, markRemovedBySlug, and getBySlug to TaskStore

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1, 3.1 | **Parallel with:** 3.2

Extend `TaskStore` with three new methods for file-first CRUD. Implement `parseDuration()` helper for converting duration strings to milliseconds. Add `rowToTask()` for consistent JSON tag parsing. Add tests.

### 3.4 — Implement TaskFileWatcher with chokidar

**Size:** Medium | **Priority:** High | **Dependencies:** 3.1, 3.3

Create `TaskFileWatcher` class using chokidar with `awaitWriteFinish` (50ms stability, 25ms poll). Watches directories for .md file changes, parses them, and syncs to DB via `TaskStore`. Includes `watch()`, `stopWatching()`, `stopAll()`, `isWatching()`. Add tests with real files.

### 3.5 — Implement TaskReconciler as safety net

**Size:** Medium | **Priority:** High | **Dependencies:** 3.1, 3.3 | **Parallel with:** 3.4

Create `TaskReconciler` with 5-minute interval and 24-hour grace period for orphan cleanup. Scans global + per-agent task directories. Follows agent reconciler pattern. Add tests.

### 3.6 — Implement template system and ensureDefaultTemplates()

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.2 | **Parallel with:** 3.3, 3.4, 3.5

Replace old `pulse-presets.ts` with markdown template files. Define 4 default templates (daily-health-check, weekly-dependency-audit, activity-summary, code-review-digest). Implement `ensureDefaultTemplates()` (idempotent seeding) and `loadTemplates()` (for GET endpoint). Wire into server startup. Remove old presets code.

### 3.7 — Rewrite API routes to file-first CRUD

**Size:** Large | **Priority:** High | **Dependencies:** 3.1, 3.2, 3.3, 3.6

Update all routes in `tasks.ts` to write `.md` files as primary operation. POST creates file then syncs DB. PATCH reads file, merges, rewrites. DELETE removes file. GET includes computed nextRun and parsed tags. Add GET /api/tasks/templates endpoint. Add `toKebabCase()` and `formatDuration()` helpers.

### 3.8 — Wire TaskFileWatcher into MeshCore lifecycle and server startup

**Size:** Medium | **Priority:** High | **Dependencies:** 3.4, 3.5, 3.7

Wire everything together in `index.ts`: start global watcher, start per-agent watchers for registered agents, hook into MeshCore register/unregister events for dynamic watcher management, start reconciler, add shutdown cleanup. Pass file-writing dependencies to route handlers.

### 3.9 — Run verification gate for Phase 3

**Size:** Small | **Priority:** High | **Dependencies:** 3.8

Run `pnpm typecheck && pnpm build && pnpm test -- --run`. Manually verify end-to-end file-first CRUD, watcher sync, template seeding.

---

## Phase 4: UI

Ship the `/tasks` page and standard task component.

### 4.1 — Create TaskRow component with size variants

**Size:** Medium | **Priority:** High | **Dependencies:** 3.9 | **Parallel with:** 4.2

Evolve TaskRow with `size` prop (`default`/`compact`/`minimal`) and `showAgent` prop. Add file path indicator, tags display, system badge, status dot, next run display. Add comprehensive tests for all variants.

### 4.2 — Create task-filter-schema and TasksList feature component

**Size:** Medium | **Priority:** High | **Dependencies:** 3.9 | **Parallel with:** 4.1

Create `taskFilterSchema` with keyword, agent, status, and type filters (mirroring agent-filter-schema pattern). Create `TasksList` component with FilterBar integration, loading skeleton, empty state, sorting, and optional `agentId` pre-filter prop. Add tests.

### 4.3 — Create TasksPage widget and /tasks route

**Size:** Medium | **Priority:** High | **Dependencies:** 4.1, 4.2

Create `TasksPage` widget in `widgets/tasks/` with header (Zap icon, "New Task" button), FilterBar, and TasksList. Create barrel export. Register `/tasks` route in TanStack Router with search param validation. Add tests.

### 4.4 — Create TasksDialog and add Tasks button to agent detail page

**Size:** Medium | **Priority:** Medium | **Dependencies:** 4.2 | **Parallel with:** 4.3

Create `TasksDialog` with agent-scoped `TasksList` filtered by `agentId`. Add "Tasks" button with count badge to agent detail page. Works for both regular agents and Damon. Add tests.

### 4.5 — Update sidebar navigation and remove PulsePanel

**Size:** Medium | **Priority:** High | **Dependencies:** 4.3 | **Parallel with:** 4.4

Replace sidebar nav item with Tasks/Zap. Remove PulsePanel/TaskPanel from session sidebar. Remove SchedulesView from sidebar tabs. Update command palette contributions. Rename `use-pulse-notifications.ts`. Add tests.

### 4.6 — Update all remaining client references and run final verification

**Size:** Large | **Priority:** High | **Dependencies:** 4.3, 4.4, 4.5

Comprehensive sweep of all remaining Pulse/Schedule references in: dashboard components, activity feed, agent settings, onboarding, relay, settings, shared utilities, CSS, dev/showcase files. Update all tests. Run final `pnpm typecheck && pnpm build && pnpm test -- --run`. Final grep confirms zero Pulse references outside DB table name strings.

---

## Summary

| Phase                  | Tasks        | Estimated Effort             |
| ---------------------- | ------------ | ---------------------------- |
| 1. Rename              | 10 tasks     | Large (mechanical but broad) |
| 2. Schema + Damon      | 4 tasks      | Medium                       |
| 3. File Infrastructure | 9 tasks      | Large (core architecture)    |
| 4. UI                  | 6 tasks      | Large (many components)      |
| **Total**              | **29 tasks** |                              |

### Critical Path

1.1 -> 1.6 -> 1.7 -> 1.8 -> 1.9 -> 1.10 -> 2.1/2.2 -> 2.3 -> 2.4 -> 3.1/3.2 -> 3.3 -> 3.4 -> 3.7 -> 3.8 -> 3.9 -> 4.1/4.2 -> 4.3 -> 4.5 -> 4.6

### Parallelization Opportunities

- Phase 1: Tasks 1.1 and 1.2 can run in parallel. Tasks 1.4 and 1.5 can run in parallel.
- Phase 2: Tasks 2.1 and 2.2 can run in parallel.
- Phase 3: Tasks 3.1 and 3.2 can run in parallel. Tasks 3.4 and 3.5 can run in parallel. Task 3.6 can run in parallel with 3.3-3.5.
- Phase 4: Tasks 4.1 and 4.2 can run in parallel. Tasks 4.4 and 4.5 can run in parallel with 4.3.
