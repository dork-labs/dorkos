---
slug: tasks-system-redesign
number: 211
created: 2026-03-29
status: ideation
linear-issue: DOR-63
---

# Tasks System Redesign

**Slug:** tasks-system-redesign
**Author:** Claude Code
**Date:** 2026-03-29
**Branch:** preflight/tasks-system-redesign

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the DorkOS task system from scheduled-only ("Pulse") to a general-purpose task model backed by markdown files with YAML frontmatter. Introduce Damon, a singleton system agent for global tasks. Rename "Pulse" to "Tasks" throughout. Add a dedicated `/tasks` page.
- **Assumptions:**
  - Alpha project — existing schedules can be dropped (no backfill migration)
  - The existing Pulse infrastructure (scheduler, croner, run history) is solid and reusable
  - `gray-matter` (already a dependency) handles YAML frontmatter parsing
  - The ADR-0043 file-first pattern is proven and can be reused for tasks
  - FSD architecture patterns from `/agents` page can be mirrored for `/tasks`
- **Out of scope:**
  - Task dependencies / chaining
  - Task template marketplace / community templates
  - Visual cron builder (future enhancement)
  - DB table rename (`pulse_schedules` → `tasks` — cosmetic cleanup later)
  - Tab title badge / Sonner notifications for task completion (polish item)

## Source Brief

File: `.temp/2026-03029-scheduled-tasks.md`

Key directives from the brief:

- "Pulse is just the 'Tasks' feature in DorkOS" — rename everything
- Tasks can be scheduled or not. Scheduling is optional. All tasks can be run manually.
- Standard component for displaying tasks, with variants/sizes, used everywhere
- `/tasks` dedicated page with filters (keyword, agent, status)
- Tasks as markdown files with YAML frontmatter, editable by agents or humans
- Per-project tasks at `/.dork/tasks/`, global tasks at `{DORK_HOME}/tasks/`
- Background agent (now named "Damon") runs global tasks

## 2) Pre-reading Log

### Research Reports (Primary Sources)

- `research/20260329_file_based_task_definitions.md` (DOR-59): Complete file-based task architecture — frontmatter schema, file locations, sync model, performance analysis, 8 reusable codebase patterns. Files are source of truth; DB is derived cache.
- `research/20260329_background_agent_concept.md` (DOR-60): Damon concept — singleton system agent, fixed ID `damon`, namespace `system`, `isSystem: true` column, auto-registered on startup, not deletable, first-class UI citizen.
- `research/20260329_tasks_system_redesign_synthesis.md`: Gap analysis synthesizing all research. 6 gaps identified with recommended approaches. Implementation sequencing in 4 phases.

### Earlier Research

- `research/20260221_pulse_implementation_gaps.md`: Gap analysis for current Pulse system
- `research/20260221_pulse_scheduler_ux_redesign.md`: UX patterns for scheduler
- `research/20260221_pulse_v2_enhancements.md`: V2 enhancement ideas
- `research/20260311_pulse_template_gallery_ux.md`: Template/preset gallery patterns

### Developer Guides

- `contributing/architecture.md`: Hexagonal architecture, Transport interface
- `contributing/data-fetching.md`: TanStack Query patterns
- `contributing/state-management.md`: Zustand vs TanStack Query decision guide
- `contributing/design-system.md`: Color palette, typography, spacing

### Codebase Files

- `packages/db/src/schema/pulse.ts`: Current DB schema — `pulseSchedules` (no `filePath` column), `pulseRuns`
- `packages/db/src/schema/mesh.ts`: Agent schema — no `isSystem` column
- `apps/server/src/services/pulse/`: PulseStore, SchedulerService, pulse-presets, pulse-state
- `apps/server/src/routes/pulse.ts`: Express routes for schedule CRUD
- `apps/client/src/layers/features/pulse/`: PulsePanel, ScheduleFormInner, ScheduleRow, CreateScheduleDialog, RunHistoryPanel
- `apps/client/src/layers/entities/pulse/`: 13 model hooks (useSchedules, useRuns, etc.)
- `apps/client/src/layers/features/agents-list/lib/agent-filter-schema.ts`: Filter pattern to mirror for tasks

## 3) Codebase Map

**Primary Components/Modules (Server):**

- `apps/server/src/services/pulse/pulse-store.ts` (125 lines) — Drizzle-backed schedule CRUD → becomes TaskStore
- `apps/server/src/services/pulse/scheduler-service.ts` (350+ lines) — Cron orchestration with croner → reusable as-is
- `apps/server/src/services/pulse/pulse-presets.ts` (100+ lines) — JSON presets → replace with `.md` template files
- `apps/server/src/routes/pulse.ts` (200+ lines) — Express routes → rewrite to write files, rename to `/api/tasks/*`
- `apps/server/src/services/runtimes/claude-code/mcp-tools/pulse-tools.ts` (350+ lines) — MCP tools → rename

**Primary Components/Modules (Client):**

- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx` (120 lines) → remove from session sidebar
- `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx` (80 lines) → evolve into TaskRow with size variants
- `apps/client/src/layers/features/pulse/ui/ScheduleFormInner.tsx` (150+ lines) → TaskFormInner
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx` → CreateTaskDialog
- `apps/client/src/layers/entities/pulse/model/` (13 files) → rename all hooks

**New Infrastructure Needed:**

- `TaskFileParser` — `gray-matter` + Zod (`TaskFrontmatterSchema` from DOR-59)
- `TaskFileWatcher` — Chokidar for `.dork/tasks/` directories (reuse session-broadcaster pattern)
- `TaskFileWriter` — Atomic writes (reuse `manifest.ts` pattern)
- `TaskReconciler` — 5-minute file → DB sync (reuse agent reconciler pattern)
- `ensureDamon()` — Auto-register Damon on server startup
- `/tasks` route — TanStack Router, mirrors `/agents`
- `TasksPage` widget — FSD widget layer
- `TasksList` feature — with FilterBar
- `TaskRow` component — standard component with `default`/`compact`/`minimal` variants
- `TasksDialog` — agent-scoped task dialog for agent detail pages

**Shared Dependencies:**

- `packages/shared/src/schemas.ts` — PulseSchedule/PulseRun types → Task/TaskRun
- `packages/shared/src/relay-envelope-schemas.ts` — PulseDispatchPayload → TaskDispatchPayload
- `packages/db/src/schema/pulse.ts` — DB schema (add `filePath`, add `isSystem` to agents)
- `apps/client/src/layers/shared/model/app-store.ts` — pulseBadgeCount → tasksBadgeCount

**Data Flow:**

```
File edit (.dork/tasks/*.md)
  → Chokidar detects change
    → gray-matter parse + Zod validate
      → TaskStore upsert (DB cache)
        → SchedulerService re-register cron (if cron changed)
          → croner fires at scheduled time
            → SchedulerService.dispatch()
              → AgentRuntime.sendMessage() (direct or via Relay)
                → TaskRun recorded in DB
```

**Potential Blast Radius:**

- Direct: ~70 files to rename (pulse → tasks)
- New files: 10-12 (file infrastructure + UI components + route)
- Modify: 15-20 (schema, routes, store, startup)
- Tests: ~23 files to update
- Config: router.tsx, openapi-registry, AGENTS.md, contributing guides

## 4) Root Cause Analysis

N/A — this is a feature redesign, not a bug fix.

## 5) Research

### Architecture: File-First Task Definitions (DOR-59)

Files are the sole source of truth. DB is a derived cache. The architecture:

```
.dork/tasks/*.md files (source of truth)
    ↕ Chokidar watcher (real-time) + Reconciler (5-min safety net)
pulse_schedules table (derived cache for fast queries)
    ↕ SchedulerService
croner (cron execution)
```

**Frontmatter schema:** `name` (required), `description`, `cron`, `timezone`, `agent`, `enabled`, `maxRuntime`, `permissions`, `tags`, `cwd` (global only). Body = prompt. ID = filename slug.

**Sync:** File-first write-through. API writes `.md` file → watcher/reconciler syncs DB. File always wins on conflict. 24h grace period on deletion. Project-scoped overrides global for same slug.

**8 reusable patterns:** ADR-0043 write-through, atomic temp+rename, Zod safeParse, chokidar awaitWriteFinish, local-overrides-global, reconciler grace period, gray-matter, kebab-case IDs.

### Architecture: Damon System Agent (DOR-60)

Singleton system agent for global tasks:

- Fixed ID `damon`, display name `Damon`, namespace `system`
- `isSystem: true` boolean column on `agents` table — not deletable, not discoverable
- Auto-registered via `ensureDamon()` on server startup (idempotent)
- projectPath = `{dorkHome}`, capabilities = `['tasks', 'summaries']`
- behavior.responseMode = `silent`, budget.maxCallsPerHour = 20
- First-class agent in UI — navigable, viewable, "System" badge, no delete option
- Global tasks at `{dorkHome}/tasks/*.md` associated with Damon by default

### Gap Analysis (Synthesis Report)

| Gap                      | Recommended Approach                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| DB migration             | Drop existing schedules (alpha). Add `filePath` NOT NULL + `isSystem` boolean.                                            |
| Rename scope             | Rename TypeScript identifiers + API routes + UI. Keep DB table names as `pulse_schedules`/`pulse_runs` (internal detail). |
| `/tasks` page            | Mirror `/agents`: TasksPage widget, TasksList feature, task-filter-schema with keyword/agent/status/type filters          |
| Standard TaskRow         | Evolve ScheduleRow: add `size` variant (default/compact/minimal), `showAgent` prop, file path indicator, tags             |
| File watcher integration | TaskFileWatcher as separate service, callback pattern into SchedulerService, MeshCore lifecycle hookup                    |
| Templates                | `.md` files in `{dorkHome}/tasks/templates/`. Seeded on first run. Users can edit/add/delete.                             |

### Risk Areas

| Risk                                       | Severity | Mitigation                                                                                   |
| ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------- |
| Partial rename leaving inconsistent naming | High     | Execute as single dedicated commit. Verify with `pnpm typecheck && pnpm build && pnpm test`. |
| Watcher lifecycle leaks                    | Medium   | `stopAll()` in shutdown handler. Assert no duplicate watchers in dev mode.                   |
| Croner + watcher race on rapid edits       | Low      | Existing `registerSchedule` unregisters before re-registering. Chokidar 100ms debounce.      |

## 6) Decisions

| #   | Decision                         | Choice                                              | Rationale                                                                                          |
| --- | -------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Feature flag                     | Remove `PULSE_ENABLED` / `--pulse` entirely         | Tasks are always-on core infrastructure. Brief: "Pulse is not a separate product."                 |
| 2   | Session sidebar vs `/tasks` page | Dedicated `/tasks` page + agent-scoped task dialog  | Same components in both. Dialog on agent page filtered by agentId. Remove PulsePanel from sidebar. |
| 3   | Damon's tasks visibility         | Mixed with all tasks, filterable by agent           | Damon is first-class. System badge distinguishes. Standard agent filter.                           |
| 4   | Nav icon                         | `Zap` (Lucide)                                      | Suggests automation/speed. Replaces `HeartPulse`.                                                  |
| 5   | Existing data migration          | Drop existing schedules — no backfill               | Alpha project. Clean slate.                                                                        |
| 6   | Template system                  | `.md` files in `{dorkHome}/tasks/templates/`        | Everything is a file. Seeded on first run. Users can edit/add/delete.                              |
| 7   | DB table names                   | Keep `pulse_schedules` / `pulse_runs`               | Internal detail. Avoids data migration. Rename TypeScript types + API routes only.                 |
| 8   | Data model                       | Files are sole source of truth, DB is derived cache | ADR-0043 pattern. One source of truth. No dual code paths.                                         |
| 9   | Background agent name            | Damon                                               | Greek myth (loyalty), daemon near-homophone, human name gives character.                           |
| 10  | Damon deletability               | Not deletable (`isSystem: true`)                    | System agents are infrastructure. Every installation gets Damon automatically.                     |

## On Completion

- [ ] Run `/ideate-to-spec specs/tasks-system-redesign/01-ideation.md` to create the specification
- [ ] Link spec to DOR-63 in manifest
- [ ] Post breadcrumb comment to DOR-63
