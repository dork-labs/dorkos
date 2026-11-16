# Implementation Summary: Tasks System Redesign

**Created:** 2026-03-29
**Last Updated:** 2026-03-29
**Spec:** specs/tasks-system-redesign/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 29 / 29

## Tasks Completed

### Session 1 - 2026-03-29

- Task #1: [P1] Rename shared types and schemas from Pulse to Tasks
- Task #2: [P1] Rename DB schema file from pulse.ts to tasks.ts
- Tasks #3-#10: [P1] Complete Pulse→Tasks rename across ~260 files

### Session 2 - 2026-03-29

- Task #11: [P2] Add filePath and tags_json columns to pulse_schedules schema
- Task #12: [P2] Add isSystem column to agents schema + AgentManifest type
- Route paths updated from /schedules to / (flattened API)
- Client transport paths updated to match new server routes
- Migration 0011_tasks_system_redesign.sql created (drops existing data per alpha policy)
- drizzle.config.ts fixed to include activity.ts schema

## Files Modified/Created

**Source files:**

- `packages/db/src/schema/tasks.ts` — Added filePath, tags columns
- `packages/db/src/schema/mesh.ts` — Added isSystem column
- `packages/db/drizzle.config.ts` — Added activity.ts to schema list
- `packages/db/drizzle/0011_tasks_system_redesign.sql` — Migration
- `packages/shared/src/schemas.ts` — Added filePath, tags to TaskSchema + CreateTask/UpdateTask
- `packages/shared/src/mesh-schemas.ts` — Added isSystem to AgentManifestSchema
- `apps/server/src/services/tasks/task-store.ts` — Updated mapTaskRow, createTask for new fields
- `apps/server/src/routes/tasks.ts` — Flattened route paths, /templates endpoint
- `apps/server/src/routes/mesh.ts` — System agent delete protection
- `apps/client/src/layers/shared/lib/transport/task-methods.ts` — Updated API paths
- `packages/test-utils/src/mock-factories.ts` — Added filePath, tags to mock Task

**Test files:**

- `apps/server/src/services/tasks/__tests__/task-store.test.ts` — Fixed import
- `apps/server/src/routes/__tests__/tasks.test.ts` — Fixed stale method names
- `apps/client/src/layers/features/dashboard-status/__tests__/use-subsystem-status.test.ts` — Added filePath, tags
- `apps/client/src/layers/features/session-list/__tests__/TasksView.test.tsx` — Added filePath, tags

## Known Issues

_(None yet)_

## Implementation Notes

### Session 2

- Phase 2 DB changes done. ensureDamon() being implemented by background agent.
- Phase 3 file infrastructure (parser, writer, watcher, reconciler, templates) being implemented by background agent.
- Phase 4 UI (TaskRow variants, TasksList, TasksPage, /tasks route) being implemented by background agent.
