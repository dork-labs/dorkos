---
slug: tasks-system-redesign
number: 211
created: 2026-03-29
status: specified
linear-issue: DOR-63
---

# Tasks System Redesign — Technical Specification

**Slug:** tasks-system-redesign
**Author:** Claude Code
**Date:** 2026-03-29
**Source brief:** `specs/tasks-system-redesign/01-ideation.md`
**Research:** DOR-59, DOR-60, synthesis report

---

## Overview

This specification redesigns the DorkOS task system from a scheduled-only model ("Pulse") into a general-purpose task platform backed by markdown files with YAML frontmatter. The work introduces four changes:

1. **Rename Pulse to Tasks** — eliminate the "Pulse" brand everywhere in code, types, routes, and UI.
2. **Evolve the DB schema** — add `filePath` to schedules, add `isSystem` to agents, register Damon as the singleton system agent.
3. **Build file-based task infrastructure** — markdown files are the sole source of truth for task definitions; the DB is a derived cache. Includes parsing, writing, watching, and reconciliation.
4. **Ship a `/tasks` page** — dedicated top-level route with filtering, a standard `TaskRow` component used everywhere, and a `TasksDialog` for agent-scoped viewing.

Tasks can be scheduled (cron) or on-demand. All tasks can be run manually. The existing Pulse infrastructure (croner, run history, concurrency control) is reused — only the data model and surface area change.

### Source Documents

- `research/20260329_file_based_task_definitions.md` — File-based architecture (DOR-59)
- `research/20260329_background_agent_concept.md` — Damon concept (DOR-60)
- `research/20260329_tasks_system_redesign_synthesis.md` — Gap analysis and sequencing

---

## Technical Design

### Phase 1: Pulse to Tasks Rename

A mechanical rename with no new functionality. Executed as a single dedicated commit to avoid partial renames.

#### Rename Inventory

| Area                    | Current                                                                                                                                                                                                                          | New                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Shared types**        | `PulseSchedule`, `PulseRun`, `PulseRunStatus`, `PulseRunTrigger`, `PulseScheduleStatus`, `PulsePreset`                                                                                                                           | `Task`, `TaskRun`, `TaskRunStatus`, `TaskRunTrigger`, `TaskStatus`, `TaskTemplate`                                                                                                                                                   |
| **Shared schemas**      | `PulseScheduleSchema`, `PulseRunSchema`, `PulseScheduleStatusSchema`, `PulseRunStatusSchema`, `PulseRunTriggerSchema`, `PulsePresetSchema`                                                                                       | `TaskSchema`, `TaskRunSchema`, `TaskStatusSchema`, `TaskRunStatusSchema`, `TaskRunTriggerSchema`, `TaskTemplateSchema`                                                                                                               |
| **Shared schemas**      | `CreateScheduleRequestSchema`, `UpdateScheduleRequestSchema`, `ListRunsQuerySchema`                                                                                                                                              | `CreateTaskRequestSchema`, `UpdateTaskRequestSchema`, `ListTaskRunsQuerySchema`                                                                                                                                                      |
| **Shared input types**  | `CreateScheduleInput`, `CreateScheduleRequest`, `UpdateScheduleRequest`                                                                                                                                                          | `CreateTaskInput`, `CreateTaskRequest`, `UpdateTaskRequest`                                                                                                                                                                          |
| **Relay schemas**       | `PulseDispatchPayload`, `PulseDispatchPayloadSchema`                                                                                                                                                                             | `TaskDispatchPayload`, `TaskDispatchPayloadSchema`                                                                                                                                                                                   |
| **Transport interface** | `listSchedules()`, `createSchedule()`, `updateSchedule()`, `deleteSchedule()`, `triggerSchedule()`, `listRuns()`, `getRun()`, `cancelRun()`, `getPulsePresets()`                                                                 | `listTasks()`, `createTask()`, `updateTask()`, `deleteTask()`, `triggerTask()`, `listTaskRuns()`, `getTaskRun()`, `cancelTaskRun()`, `getTaskTemplates()`                                                                            |
| **API routes**          | `GET/POST /api/pulse/schedules`, `PATCH/DELETE /api/pulse/schedules/:id`, `POST /api/pulse/schedules/:id/trigger`, `GET /api/pulse/runs`, `GET /api/pulse/runs/:id`, `POST /api/pulse/runs/:id/cancel`, `GET /api/pulse/presets` | `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`, `POST /api/tasks/:id/trigger`, `GET /api/tasks/runs`, `GET /api/tasks/runs/:id`, `POST /api/tasks/runs/:id/cancel`, `GET /api/tasks/templates` |
| **Server service dir**  | `apps/server/src/services/pulse/`                                                                                                                                                                                                | `apps/server/src/services/tasks/`                                                                                                                                                                                                    |
| **Server classes**      | `PulseStore`, `SchedulerService`, `buildPulseAppend()`                                                                                                                                                                           | `TaskStore`, `TaskSchedulerService`, `buildTaskContext()`                                                                                                                                                                            |
| **Server route file**   | `apps/server/src/routes/pulse.ts` → `createPulseRouter()`                                                                                                                                                                        | `apps/server/src/routes/tasks.ts` → `createTasksRouter()`                                                                                                                                                                            |
| **MCP tools file**      | `services/runtimes/claude-code/mcp-tools/pulse-tools.ts`                                                                                                                                                                         | `services/runtimes/claude-code/mcp-tools/task-tools.ts`                                                                                                                                                                              |
| **Client feature dir**  | `apps/client/src/layers/features/pulse/`                                                                                                                                                                                         | `apps/client/src/layers/features/tasks/`                                                                                                                                                                                             |
| **Client entity dir**   | `apps/client/src/layers/entities/pulse/`                                                                                                                                                                                         | `apps/client/src/layers/entities/tasks/`                                                                                                                                                                                             |
| **Client components**   | `PulsePanel`, `ScheduleRow`, `ScheduleFormInner`, `CreateScheduleDialog`, `RunHistoryPanel`, `ScheduleBuilder`, `PresetGallery`                                                                                                  | `TaskPanel` (temporary, removed in Phase 4), `TaskRow`, `TaskFormInner`, `CreateTaskDialog`, `TaskRunHistoryPanel`, `TaskScheduleBuilder`, `TaskTemplateGallery`                                                                     |
| **Client hooks**        | `useSchedules`, `useCreateSchedule`, `useUpdateSchedule`, `useDeleteSchedule`, `useTriggerSchedule`, `useRuns`, `usePulsePresets`, etc. (13 files)                                                                               | `useTasks`, `useCreateTask`, `useUpdateTask`, `useDeleteTask`, `useTriggerTask`, `useTaskRuns`, `useTaskTemplates`, etc.                                                                                                             |
| **App store**           | `pulseBadgeCount`                                                                                                                                                                                                                | `tasksBadgeCount`                                                                                                                                                                                                                    |
| **UI labels**           | "Pulse", "Schedules", "New Schedule", `HeartPulse` icon                                                                                                                                                                          | "Tasks", "Tasks", "New Task", `Zap` icon                                                                                                                                                                                             |

#### Config/Feature Flag Removal

Remove `PULSE_ENABLED` env var and `--pulse` CLI flag entirely. Tasks are always-on core infrastructure. Remove all conditional checks gating Pulse features behind the flag. Files affected:

- `apps/server/src/env.ts` — remove `PULSE_ENABLED`
- `apps/server/src/index.ts` — remove conditional scheduler initialization
- `packages/cli/src/cli.ts` — remove `--pulse` option
- `packages/shared/src/config-schema.ts` — remove pulse config section if present
- `apps/client/` — remove any `pulseEnabled` checks in feature gates

#### DB Table Names

**Keep `pulse_schedules` and `pulse_runs` as the DB table names.** These are internal implementation details not visible to users. Renaming TypeScript types and API routes is sufficient. The table names will be cleaned up in a future migration.

The Drizzle schema file renames from `packages/db/src/schema/pulse.ts` to `packages/db/src/schema/tasks.ts`, but the `sqliteTable()` calls retain `'pulse_schedules'` and `'pulse_runs'` as table name strings.

#### Verification Gate

After the rename commit:

```bash
pnpm typecheck && pnpm build && pnpm test -- --run
```

All three must pass. If any fail, the rename is incomplete.

---

### Phase 2: DB Schema + Damon

#### Schema Changes

**`packages/db/src/schema/tasks.ts`** (renamed from `pulse.ts`):

Add `filePath` column to `pulseSchedules`:

```typescript
export const pulseSchedules = sqliteTable('pulse_schedules', {
  // ... existing columns ...
  filePath: text('file_path').notNull(), // absolute path to .md file
});
```

**`packages/db/src/schema/mesh.ts`**:

Add `isSystem` column to `agents`:

```typescript
export const agents = sqliteTable('agents', {
  // ... existing columns ...
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
});
```

#### Migration Strategy

This is an alpha project. **Drop existing schedule data** rather than backfilling. The migration:

1. Drop all rows from `pulse_schedules` and `pulse_runs`.
2. Recreate `pulse_schedules` with the new `filePath NOT NULL` column.
3. Add `is_system` column to `agents` with default `false`.

No data backfill is needed. Users with existing schedules (alpha testers) start fresh. Run history is also dropped — it references schedule IDs that no longer exist.

#### Damon System Agent

**`ensureDamon()` implementation** — called in `apps/server/src/index.ts` during startup, after MeshCore initialization and before the scheduler starts:

```typescript
import type { MeshCore } from '@dorkos/mesh';

/**
 * Ensure the Damon system agent is registered.
 *
 * Damon is a singleton agent for global tasks. Every DorkOS installation
 * gets one automatically. Idempotent — no-op if already registered.
 *
 * @param meshCore - The MeshCore instance for agent registration
 * @param dorkHome - Resolved data directory path (Damon's "project")
 */
async function ensureDamon(meshCore: MeshCore, dorkHome: string): Promise<void> {
  const existing = meshCore.get('damon');
  if (existing) return;

  await meshCore.registerByPath(dorkHome, {
    id: 'damon',
    name: 'Damon',
    runtime: 'claude-code',
    namespace: 'system',
    isSystem: true,
    capabilities: ['tasks', 'summaries'],
    behavior: {
      responseMode: 'silent',
    },
    budget: {
      maxHopsPerMessage: 1,
      maxCallsPerHour: 20,
    },
  });
}
```

**Key properties:**

| Property                 | Value                       | Rationale                                         |
| ------------------------ | --------------------------- | ------------------------------------------------- |
| `id`                     | `'damon'` (fixed, not ULID) | Singleton — survives restarts, always addressable |
| `name`                   | `'Damon'`                   | Display name                                      |
| `namespace`              | `'system'`                  | Separate from user agents                         |
| `isSystem`               | `true`                      | Not deletable, auto-managed                       |
| `projectPath`            | `{dorkHome}`                | The dork home directory is its "project"          |
| `capabilities`           | `['tasks', 'summaries']`    | Describes what it does                            |
| `behavior.responseMode`  | `'silent'`                  | No interactive responses                          |
| `budget.maxCallsPerHour` | `20`                        | Prevents runaway consumption                      |

#### Delete Protection

In the agent unregister/delete API handler (Mesh routes):

```typescript
if (agent.isSystem) {
  return res.status(403).json({ error: 'System agents cannot be removed' });
}
```

The UI should not render a delete option for agents where `isSystem === true`. The API rejection is a safety net.

---

### Phase 3: File-Based Task Infrastructure

This phase implements the core file-first architecture. All task CRUD flows through markdown files.

#### File Locations

```
Project-scoped: {projectPath}/.dork/tasks/*.md
Global (Damon): {dorkHome}/tasks/*.md
Templates:      {dorkHome}/tasks/templates/*.md
```

- **Project-scoped tasks** belong to the agent registered at `{projectPath}`. CWD is implicitly the project root.
- **Global tasks** belong to Damon by default (unless an explicit `agent` field overrides). Require explicit `cwd` in frontmatter or fall back to `DORKOS_DEFAULT_CWD`.
- **Templates** are seeded on first run and serve as starting points for new tasks. They are not runnable.

#### TaskFrontmatterSchema (Zod)

Defined in `apps/server/src/services/tasks/task-file-parser.ts`:

```typescript
import { z } from 'zod';

/** Duration strings: "5m", "1h", "30s", "2h30m" */
export const DurationSchema = z
  .string()
  .regex(/^(\d+h)?(\d+m)?(\d+s)?$/, 'Duration must be like "5m", "1h", "30s", or "2h30m"');

export const TaskFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().default('UTC'),
  agent: z.string().optional(),
  enabled: z.boolean().default(true),
  maxRuntime: DurationSchema.optional(),
  permissions: z.enum(['acceptEdits', 'bypassPermissions']).default('acceptEdits'),
  tags: z.array(z.string()).default([]),
  cwd: z.string().optional(), // global tasks only
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
```

#### TaskDefinition Interface

```typescript
/** Full parsed task definition: frontmatter + body + derived fields. */
export interface TaskDefinition {
  /** Derived from filename slug (e.g., `daily-health-check.md` -> `daily-health-check`). */
  id: string;
  /** Parsed and validated frontmatter. */
  meta: TaskFrontmatter;
  /** Markdown body — the agent prompt. */
  prompt: string;
  /** Where the file lives: 'project' or 'global'. */
  scope: 'project' | 'global';
  /** Absolute path to the .md file on disk. */
  filePath: string;
  /** For project-scoped tasks, the project root directory. */
  projectPath?: string;
}
```

#### TaskFileParser

File: `apps/server/src/services/tasks/task-file-parser.ts`

Responsibilities:

- Parse `.md` file content with `gray-matter`
- Validate frontmatter with `TaskFrontmatterSchema.safeParse()`
- Validate filename is kebab-case (`/^[a-z0-9][a-z0-9-]*$/`)
- Return `TaskDefinition` or structured error

```typescript
import matter from 'gray-matter';
import path from 'node:path';

/** Kebab-case filename validation (matches extension ID convention). */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse a task markdown file into a validated TaskDefinition.
 *
 * @param filePath - Absolute path to the .md file
 * @param content - Raw file content (UTF-8)
 * @param scope - Whether the file is project-scoped or global
 * @param projectPath - Project root (required for project-scoped tasks)
 * @returns Parsed TaskDefinition or an error object
 */
export function parseTaskFile(
  filePath: string,
  content: string,
  scope: 'project' | 'global',
  projectPath?: string
): TaskDefinition | { error: string } {
  const { data, content: body } = matter(content);
  const result = TaskFrontmatterSchema.safeParse(data);

  if (!result.success) {
    return { error: result.error.message };
  }

  const slug = path.basename(filePath, '.md');
  if (!SLUG_REGEX.test(slug)) {
    return {
      error: `Invalid filename: must be kebab-case (got "${slug}")`,
    };
  }

  return {
    id: slug,
    meta: result.data,
    prompt: body.trim(),
    scope,
    filePath,
    projectPath,
  };
}
```

#### TaskFileWriter

File: `apps/server/src/services/tasks/task-file-writer.ts`

Uses the atomic temp+rename pattern from `packages/shared/src/manifest.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import type { TaskFrontmatter } from './task-file-parser.js';

/**
 * Write a task definition to a .md file atomically.
 *
 * Uses temp file + rename to prevent corruption on crash.
 *
 * @param tasksDir - Directory to write into (e.g., `{projectPath}/.dork/tasks/`)
 * @param slug - Task ID / filename without extension
 * @param frontmatter - YAML frontmatter fields
 * @param prompt - Markdown body (the agent prompt)
 * @returns Absolute path to the written file
 */
export async function writeTaskFile(
  tasksDir: string,
  slug: string,
  frontmatter: TaskFrontmatter,
  prompt: string
): Promise<string> {
  await fs.mkdir(tasksDir, { recursive: true });

  const content = matter.stringify(prompt, frontmatter);
  const targetPath = path.join(tasksDir, `${slug}.md`);
  const tempPath = path.join(tasksDir, `.task-${randomUUID()}.tmp`);

  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, targetPath);

  return targetPath;
}

/**
 * Delete a task file from disk.
 *
 * @param filePath - Absolute path to the .md file
 */
export async function deleteTaskFile(filePath: string): Promise<void> {
  await fs.unlink(filePath);
}
```

#### TaskFileWatcher

File: `apps/server/src/services/tasks/task-file-watcher.ts`

Watches `.dork/tasks/` directories for changes. Uses chokidar with `awaitWriteFinish` (same settings as session-broadcaster).

```typescript
import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { TaskStore } from './task-store.js';
import { parseTaskFile } from './task-file-parser.js';
import { createTaggedLogger } from '../../lib/logger.js';

const logger = createTaggedLogger('TaskFileWatcher');

/** Callback invoked when a task file changes or is removed. */
type TaskChangeCallback = (taskId: string) => void;

/**
 * Watches task directories for file changes and syncs to the DB cache.
 *
 * - Global tasks: `{dorkHome}/tasks/` — started unconditionally on server startup
 * - Project tasks: `{projectPath}/.dork/tasks/` — started per agent registration
 */
export class TaskFileWatcher {
  private watchers = new Map<string, FSWatcher>();

  constructor(
    private store: TaskStore,
    private onTaskChange: TaskChangeCallback,
    private dorkHome: string
  ) {}

  /**
   * Watch a task directory for .md file changes.
   *
   * @param tasksDir - Absolute path to the tasks directory
   * @param scope - 'project' or 'global'
   * @param projectPath - Project root (for project-scoped tasks)
   */
  watch(tasksDir: string, scope: 'project' | 'global', projectPath?: string): void {
    if (this.watchers.has(tasksDir)) {
      logger.warn(`Already watching ${tasksDir} — skipping duplicate`);
      return;
    }

    const watcher = chokidar.watch(path.join(tasksDir, '*.md'), {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 25,
      },
    });

    watcher.on('add', (filePath) => this.handleFileChange(filePath, scope, projectPath));
    watcher.on('change', (filePath) => this.handleFileChange(filePath, scope, projectPath));
    watcher.on('unlink', (filePath) => this.handleFileRemove(filePath));

    this.watchers.set(tasksDir, watcher);
    logger.info(`Watching ${tasksDir} (${scope})`);
  }

  /** Stop watching a specific directory (e.g., on agent unregister). */
  async stopWatching(tasksDir: string): Promise<void> {
    const watcher = this.watchers.get(tasksDir);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(tasksDir);
      logger.info(`Stopped watching ${tasksDir}`);
    }
  }

  /** Stop all watchers (server shutdown). */
  async stopAll(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      await watcher.close();
    }
    this.watchers.clear();
  }

  private async handleFileChange(
    filePath: string,
    scope: 'project' | 'global',
    projectPath?: string
  ): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const result = parseTaskFile(filePath, content, scope, projectPath);

      if ('error' in result) {
        logger.warn(`Invalid task file ${filePath}: ${result.error}`);
        return;
      }

      // Upsert into DB cache
      this.store.upsertFromFile(result);
      this.onTaskChange(result.id);
    } catch (err) {
      logger.error(`Failed to process ${filePath}`, err);
    }
  }

  private handleFileRemove(filePath: string): void {
    const slug = path.basename(filePath, '.md');
    // Mark as paused in DB (24h grace period handled by reconciler)
    this.store.markRemovedBySlug(slug);
    this.onTaskChange(slug);
    logger.info(`Task file removed: ${slug}`);
  }
}
```

#### TaskReconciler

File: `apps/server/src/services/tasks/task-reconciler.ts`

5-minute safety net that syncs file state to DB. Follows the agent reconciler pattern from `packages/mesh/src/reconciler.ts`.

Responsibilities:

1. Scan all known task directories (global + each registered agent's project).
2. For each `.md` file: parse, validate, compare to DB, update if different.
3. Mark DB entries as paused if file is missing (24h grace period).
4. Remove stale entries past the grace period.
5. Remove orphan DB entries that have no corresponding file.

Interval: 5 minutes (`300_000`ms). Grace period: 24 hours.

#### TaskStore Updates

`TaskStore` (formerly `PulseStore`) gains new methods for file-first CRUD:

```typescript
/** Upsert a task from a parsed file definition. Used by watcher and reconciler. */
upsertFromFile(def: TaskDefinition): void;

/** Mark a task as paused by filename slug (used when file is deleted). */
markRemovedBySlug(slug: string): void;

/** Get a task by its filename slug (for file-based lookups). */
getBySlug(slug: string): Task | null;
```

All existing CRUD methods (`createSchedule`, `updateSchedule`, `deleteSchedule`) are renamed and updated to write files first, then update DB. The `createTask()` and `updateTask()` methods:

1. Write/update the `.md` file via `TaskFileWriter`.
2. The watcher detects the change and calls `upsertFromFile()`.
3. Alternatively, call `upsertFromFile()` directly for immediate consistency (don't wait for watcher).

The `deleteTask()` method:

1. Delete the `.md` file via `deleteTaskFile()`.
2. The watcher detects removal and calls `markRemovedBySlug()`.
3. Run history is preserved in `pulse_runs` — only the definition row is affected.

#### API Routes

File: `apps/server/src/routes/tasks.ts`

All routes write `.md` files, not DB directly:

| Method   | Path                         | Description                                                   |
| -------- | ---------------------------- | ------------------------------------------------------------- |
| `GET`    | `/api/tasks`                 | List all tasks (with computed `nextRun` from scheduler)       |
| `POST`   | `/api/tasks`                 | Create task — writes `.md` file, returns created task         |
| `PATCH`  | `/api/tasks/:id`             | Update task — rewrites `.md` file, returns updated task       |
| `DELETE` | `/api/tasks/:id`             | Delete task — deletes `.md` file, rejects if `isSystem` agent |
| `POST`   | `/api/tasks/:id/trigger`     | Trigger manual run                                            |
| `GET`    | `/api/tasks/runs`            | List runs with optional filters                               |
| `GET`    | `/api/tasks/runs/:id`        | Get a specific run                                            |
| `POST`   | `/api/tasks/runs/:id/cancel` | Cancel a running task                                         |
| `GET`    | `/api/tasks/templates`       | List available templates                                      |

**Create task flow:**

1. Validate request body with `CreateTaskRequestSchema`.
2. Determine target directory: if `agentId` is set, resolve agent's `projectPath` and use `{projectPath}/.dork/tasks/`. If no agent, use `{dorkHome}/tasks/`.
3. Generate slug from `name` (kebab-case).
4. Call `writeTaskFile()` to write the `.md` file atomically.
5. Call `store.upsertFromFile()` for immediate DB consistency.
6. Call `scheduler.registerTask()` if the task has a cron expression.
7. Return the created task with computed `nextRun`.

#### Template System

Templates are `.md` files in `{dorkHome}/tasks/templates/`. Seeded on first server run via `ensureDefaultTemplates()`:

```typescript
/**
 * Seed default task templates if the templates directory is empty.
 *
 * @param dorkHome - Resolved data directory path
 */
async function ensureDefaultTemplates(dorkHome: string): Promise<void> {
  const templatesDir = path.join(dorkHome, 'tasks', 'templates');
  await fs.mkdir(templatesDir, { recursive: true });

  const existing = await fs.readdir(templatesDir);
  if (existing.some((f) => f.endsWith('.md'))) return; // Already seeded

  for (const template of DEFAULT_TEMPLATES) {
    await writeTaskFile(templatesDir, template.slug, template.frontmatter, template.prompt);
  }
}
```

`DEFAULT_TEMPLATES` is a TypeScript constant array replacing the former `pulse-presets.ts`. Templates include:

- `daily-health-check.md` — Lint, test, typecheck suite
- `weekly-dependency-audit.md` — Dependency update check
- `activity-summary.md` — Summarize recent agent activity
- `code-review-digest.md` — Review recent commits

The `GET /api/tasks/templates` endpoint reads and returns parsed template files from this directory. Users can edit, add, or delete template files.

#### MeshCore Lifecycle Integration

When an agent is registered via `meshCore.register()`:

```typescript
// After successful agent registration:
const tasksDir = path.join(agent.projectPath, '.dork', 'tasks');
taskFileWatcher.watch(tasksDir, 'project', agent.projectPath);
```

When an agent is unregistered via `meshCore.unregister()`:

```typescript
// Before removing agent:
const tasksDir = path.join(agent.projectPath, '.dork', 'tasks');
await taskFileWatcher.stopWatching(tasksDir);
```

The global watcher for `{dorkHome}/tasks/` is started unconditionally in `index.ts` after `ensureDamon()`:

```typescript
// In server startup (index.ts):
await ensureDamon(meshCore, dorkHome);
await ensureDefaultTemplates(dorkHome);
taskFileWatcher.watch(path.join(dorkHome, 'tasks'), 'global');
```

#### Data Flow

```
File edit (.dork/tasks/*.md)
  -> Chokidar detects change (50ms stability, 25ms poll)
    -> gray-matter parse + Zod validate
      -> TaskStore.upsertFromFile() (DB cache update)
        -> onTaskChange callback
          -> TaskSchedulerService re-registers cron (if cron changed)
            -> croner fires at scheduled time
              -> TaskSchedulerService.dispatch()
                -> AgentRuntime.sendMessage() (direct or via Relay)
                  -> TaskRun recorded in DB
```

---

### Phase 4: UI — `/tasks` Page + Standard Component

#### TaskRow Component

File: `apps/client/src/layers/features/tasks/ui/TaskRow.tsx`

Evolved from `ScheduleRow.tsx`. Adds `size` prop and `showAgent` prop.

```typescript
interface TaskRowProps {
  task: Task;
  /** Resolved agent for the task, or null. */
  agent?: AgentManifest | null;
  /** Display size variant. */
  size?: 'default' | 'compact' | 'minimal';
  /** Whether to show the agent column (default: true). */
  showAgent?: boolean;
  /** Whether the run history panel is expanded (default variant only). */
  expanded?: boolean;
  onToggleExpand?: () => void;
  onEdit?: () => void;
}
```

**Variant behavior:**

| Variant   | Agent column   | Cron/schedule info | Tags | Run history expand | Actions                               |
| --------- | -------------- | ------------------ | ---- | ------------------ | ------------------------------------- |
| `default` | If `showAgent` | Yes                | Yes  | Yes                | Full dropdown (Edit, Run Now, Delete) |
| `compact` | If `showAgent` | Yes                | No   | No                 | Run button only                       |
| `minimal` | No             | No                 | No   | No                 | None (display only)                   |

New features beyond `ScheduleRow`:

- **File path indicator**: In the expanded state (default variant), show `filePath` as a truncated monospace path below the run history.
- **Tags display**: Tag chips rendered below the cron description line when `meta.tags.length > 0`.
- **System badge**: If the associated agent is `isSystem: true`, render a subtle "System" chip.

#### TasksList Feature

File: `apps/client/src/layers/features/tasks/ui/TasksList.tsx`

Mirrors `AgentsList` structure:

- Uses `FilterBar` from shared components with `taskFilterSchema`
- Maps over filtered tasks, rendering `TaskRow` in default size
- Empty state component when no tasks match filters
- Supports sort by name, last run, next run, status

#### task-filter-schema.ts

File: `apps/client/src/layers/features/tasks/lib/task-filter-schema.ts`

```typescript
import { createFilterSchema, textFilter, enumFilter } from '@/layers/shared/lib';
import type { Task } from '@dorkos/shared/types';

/** Filter schema for the tasks list. */
export const taskFilterSchema = createFilterSchema<Task>({
  search: textFilter({
    fields: [(t) => t.name, (t) => t.description ?? '', (t) => t.tags?.join(' ') ?? ''],
  }),
  agent: enumFilter({
    field: (t) => t.agentId ?? '',
    options: [],
    dynamic: true,
    label: 'Agent',
  }),
  status: enumFilter({
    field: (t) => t.status,
    options: ['active', 'paused', 'pending_approval'],
    label: 'Status',
    labels: {
      active: 'Active',
      paused: 'Paused',
      pending_approval: 'Pending approval',
    },
  }),
  type: enumFilter({
    field: (t) => (t.cron ? 'scheduled' : 'on-demand'),
    options: ['scheduled', 'on-demand'],
    label: 'Type',
    labels: { scheduled: 'Scheduled', 'on-demand': 'On-demand' },
  }),
});
```

#### TasksPage Widget

File: `apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx`

Mirrors `AgentsPage` structure:

```
TasksPage
├── TasksHeader (breadcrumb, "New Task" button)
├── FilterBar (using taskFilterSchema)
└── TasksList (filtered, sorted task rows)
```

FSD layer: `widgets/tasks/` — can import from `features/tasks/`, `entities/tasks/`, `shared/`.

#### `/tasks` Route

In `apps/client/src/router.tsx`:

```typescript
import { TasksPage } from '@/layers/widgets/tasks';
import { taskFilterSchema } from '@/layers/features/tasks';

const tasksSearchSchema = z.object({}).merge(taskFilterSchema.searchValidator);

export type TasksSearch = z.infer<typeof tasksSearchSchema>;

const tasksRoute = createRoute({
  getParentRoute: () => appShellRoute,
  path: '/tasks',
  validateSearch: zodValidator(tasksSearchSchema),
  component: TasksPage,
});

// Add to route tree:
const routeTree = rootRoute.addChildren([
  appShellRoute.addChildren([
    indexRoute,
    sessionRoute,
    agentsRoute,
    tasksRoute, // <-- new
    activityRoute,
  ]),
]);
```

#### TasksDialog

File: `apps/client/src/layers/features/tasks/ui/TasksDialog.tsx`

Agent-scoped dialog for viewing/managing tasks from the agent detail page. Uses the same `TasksList` component, pre-filtered by `agentId`:

```typescript
interface TasksDialogProps {
  agentId: string;
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

Renders a `Dialog` containing `TasksList` with a fixed `agent` filter set to the given `agentId`. Includes a "New Task" button scoped to the agent.

#### Sidebar Navigation

In `DashboardSidebar`, replace the Pulse nav item:

```typescript
import { Zap } from 'lucide-react';

// Navigation item:
{
  label: 'Tasks',
  icon: Zap,
  href: '/tasks',
}
```

The `Zap` icon (Lucide) suggests automation and speed. It replaces `HeartPulse`.

#### Remove PulsePanel from Session Sidebar

The `PulsePanel` component is removed from the session sidebar entirely. Tasks are now a top-level page, not a sidebar panel. The session sidebar can optionally include a contextual link "View tasks for this agent" that navigates to `/tasks?agent={agentId}`.

#### Agent Detail Page

The agent detail page gains a "Tasks" button that opens `TasksDialog`, showing tasks filtered by that agent's ID. The button uses the same `Zap` icon and shows a count badge if the agent has tasks.

---

## Data Models

### TaskFrontmatter (File Schema)

See `TaskFrontmatterSchema` above. Fields:

| Field         | Type       | Required | Default         | Notes                                             |
| ------------- | ---------- | -------- | --------------- | ------------------------------------------------- |
| `name`        | `string`   | Yes      | —               | Human-readable display name                       |
| `description` | `string`   | No       | —               | One-line summary for list views                   |
| `cron`        | `string`   | No       | —               | Cron expression. Absent = on-demand               |
| `timezone`    | `string`   | No       | `'UTC'`         | IANA timezone for cron scheduling                 |
| `agent`       | `string`   | No       | —               | Agent ID or name. Absent = inferred from location |
| `enabled`     | `boolean`  | No       | `true`          | Whether the task is active                        |
| `maxRuntime`  | `string`   | No       | —               | Duration: `"5m"`, `"1h"`, `"30s"`, `"2h30m"`      |
| `permissions` | `enum`     | No       | `'acceptEdits'` | `'acceptEdits'` or `'bypassPermissions'`          |
| `tags`        | `string[]` | No       | `[]`            | Freeform tags for filtering                       |
| `cwd`         | `string`   | No       | —               | Global tasks only — explicit working directory    |

**Excluded from frontmatter** (derived or runtime-only):

| Field                   | Why                        | Where it lives                                            |
| ----------------------- | -------------------------- | --------------------------------------------------------- |
| `id`                    | Derived from filename slug | Filename: `daily-health-check.md` -> `daily-health-check` |
| `prompt`                | The markdown body          | Body of the `.md` file                                    |
| `status`                | Runtime state              | DB only (`active`, `paused`, `pending_approval`)          |
| `createdAt`/`updatedAt` | Git tracks better          | DB timestamps                                             |

### DB Schema

**`pulse_schedules`** (existing table, modified):

```typescript
export const pulseSchedules = sqliteTable('pulse_schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  cron: text('cron'),
  timezone: text('timezone').notNull().default('UTC'),
  prompt: text('prompt').notNull(),
  cwd: text('cwd'),
  agentId: text('agent_id'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  maxRuntime: integer('max_runtime'),
  permissionMode: text('permission_mode').notNull().default('acceptEdits'),
  status: text('status', {
    enum: ['active', 'paused', 'pending_approval'],
  })
    .notNull()
    .default('active'),
  filePath: text('file_path').notNull(), // NEW — absolute path to .md file
  tags: text('tags_json').notNull().default('[]'), // NEW — JSON array of strings
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

**`agents`** (existing table, modified):

```typescript
export const agents = sqliteTable('agents', {
  // ... all existing columns ...
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false), // NEW
});
```

**`pulse_runs`** — unchanged.

### Shared Types (packages/shared)

Renamed types in `packages/shared/src/schemas.ts`:

```typescript
// Enums
export type TaskStatus = 'active' | 'paused' | 'pending_approval';
export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskRunTrigger = 'scheduled' | 'manual' | 'agent';

// Core types
export interface Task {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  cron: string | null;
  timezone: string | null;
  cwd: string | null;
  agentId: string | null;
  enabled: boolean;
  maxRuntime: number | null;
  permissionMode: string;
  status: TaskStatus;
  filePath: string; // NEW
  tags: string[]; // NEW
  createdAt: string;
  updatedAt: string;
  nextRun?: string | null; // Computed by scheduler, not stored
}

export interface TaskRun {
  id: string;
  taskId: string; // Renamed from scheduleId
  status: TaskRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  outputSummary: string | null;
  error: string | null;
  sessionId: string | null;
  trigger: TaskRunTrigger;
  createdAt: string;
}

// Input types
export interface CreateTaskInput {
  name: string;
  prompt: string;
  description?: string;
  cron?: string | null;
  timezone?: string | null;
  cwd?: string | null;
  agentId?: string;
  enabled?: boolean;
  maxRuntime?: number | null;
  permissionMode?: string;
  tags?: string[];
}

export interface UpdateTaskRequest {
  name?: string;
  prompt?: string;
  description?: string;
  cron?: string | null;
  timezone?: string | null;
  cwd?: string | null;
  agentId?: string | null;
  enabled?: boolean;
  maxRuntime?: number | null;
  permissionMode?: string;
  status?: TaskStatus;
  tags?: string[];
}
```

Renamed in `packages/shared/src/relay-envelope-schemas.ts`:

```typescript
export const TaskDispatchPayloadSchema = z
  .object({
    type: z.literal('task_dispatch'),
    taskId: z.string(), // Renamed from scheduleId
    runId: z.string(),
    prompt: z.string(),
    cwd: z.string().nullable(),
    permissionMode: z.string(),
    taskName: z.string(), // Renamed from scheduleName
    cron: z.string().nullable(),
    trigger: z.string(),
  })
  .openapi('TaskDispatchPayload');

export type TaskDispatchPayload = z.infer<typeof TaskDispatchPayloadSchema>;
```

---

## API Design

### Task CRUD

```
GET    /api/tasks                 List all tasks (with computed nextRun)
POST   /api/tasks                 Create task (writes .md file)
PATCH  /api/tasks/:id             Update task (rewrites .md file)
DELETE /api/tasks/:id             Delete task (deletes .md file)
POST   /api/tasks/:id/trigger     Trigger manual run
```

### Task Runs

```
GET    /api/tasks/runs             List runs (query: taskId, status, limit, offset)
GET    /api/tasks/runs/:id         Get a specific run
POST   /api/tasks/runs/:id/cancel  Cancel a running task
```

### Templates

```
GET    /api/tasks/templates        List available template files
```

### Response Shapes

**`GET /api/tasks`** returns `Task[]` — each task includes `filePath`, `tags`, and computed `nextRun`.

**`POST /api/tasks`** accepts `CreateTaskRequest`, returns created `Task`.

**`POST /api/tasks/:id/trigger`** returns `{ runId: string }`.

**`GET /api/tasks/templates`** returns `TaskTemplate[]`:

```typescript
interface TaskTemplate {
  slug: string;
  name: string;
  description: string;
  prompt: string;
  cron: string;
  timezone?: string;
  tags?: string[];
}
```

---

## Implementation Phases

### Phase 1: Rename (no dependencies)

**Goal:** Eliminate all "Pulse" naming.

1. Rename all TypeScript identifiers (types, interfaces, schemas, classes, functions, variables).
2. Rename files and directories (`pulse/` -> `tasks/`).
3. Update API route paths (`/api/pulse/*` -> `/api/tasks/*`).
4. Rename Transport interface methods.
5. Update UI labels ("Pulse" -> "Tasks", `HeartPulse` -> `Zap`).
6. Remove `PULSE_ENABLED` env var and `--pulse` CLI flag.
7. Keep DB table names as `pulse_schedules` / `pulse_runs`.
8. Update AGENTS.md, contributing guides, and OpenAPI registry.
9. **Gate:** `pnpm typecheck && pnpm build && pnpm test -- --run`

### Phase 2: DB Schema + Damon (depends on Phase 1)

**Goal:** Prepare the data layer for file-backed tasks and the system agent.

1. Add `filePath TEXT NOT NULL` to `pulse_schedules` schema.
2. Add `tags_json TEXT NOT NULL DEFAULT '[]'` to `pulse_schedules` schema.
3. Add `isSystem INTEGER DEFAULT 0 NOT NULL` to `agents` schema.
4. Drop existing schedule and run data (alpha clean slate).
5. Implement `ensureDamon()` in server startup.
6. Add delete protection for `isSystem: true` agents.
7. Update `TaskStore` to include `filePath` and `tags` in all CRUD.
8. **Gate:** `pnpm typecheck && pnpm build && pnpm test -- --run`

### Phase 3: File Infrastructure (depends on Phase 2)

**Goal:** Files become the sole source of truth for task definitions.

1. Implement `TaskFrontmatterSchema` and `parseTaskFile()`.
2. Implement `TaskFileWriter` (atomic temp+rename).
3. Implement `TaskFileWatcher` (chokidar, callback pattern).
4. Implement `TaskReconciler` (5-minute interval, 24h grace period).
5. Add `upsertFromFile()`, `markRemovedBySlug()`, `getBySlug()` to `TaskStore`.
6. Update API routes to write `.md` files (not DB directly).
7. Wire `TaskFileWatcher` into MeshCore register/unregister lifecycle.
8. Start global watcher for `{dorkHome}/tasks/` in server startup.
9. Implement `ensureDefaultTemplates()` — seed template files on first run.
10. Replace `pulse-presets.ts` with template files and in-memory constants.
11. **Gate:** `pnpm typecheck && pnpm build && pnpm test -- --run`

### Phase 4: UI (depends on Phase 3)

**Goal:** Ship the `/tasks` page and standard task component.

1. Create `TaskRow` component (evolve `ScheduleRow`, add `size`/`showAgent` props, file path indicator, tags).
2. Create `task-filter-schema.ts`.
3. Create `TasksList` feature component with `FilterBar`.
4. Create `TasksPage` widget.
5. Add `/tasks` route in `router.tsx`.
6. Create `TasksDialog` (agent-scoped task dialog).
7. Add `Zap` icon "Tasks" item to `DashboardSidebar`.
8. Remove `PulsePanel` from session sidebar.
9. Add "Tasks" button to agent detail page (opens `TasksDialog`).
10. Update tests for all renamed and new components.
11. **Gate:** `pnpm typecheck && pnpm build && pnpm test -- --run`

---

## Acceptance Criteria

1. **No "Pulse" references remain** in TypeScript code, API routes, transport interface, or UI labels. DB table names `pulse_schedules`/`pulse_runs` are the sole exception (internal detail).
2. **Task definitions live in `.md` files.** The DB is a derived cache. Creating, editing, or deleting a task through the API writes/removes a file. Editing a file on disk syncs to the DB via watcher or reconciler.
3. **Damon is auto-registered on startup.** Visible in the agent list with a "System" badge. Not deletable via UI or API. Fixed ID `damon`, namespace `system`.
4. **`/tasks` page exists** with keyword, agent, status, and type (scheduled/on-demand) filters. Accessible via sidebar navigation with `Zap` icon.
5. **Standard `TaskRow` component** used on `/tasks` page (default variant), agent detail dialog (compact), and anywhere tasks are displayed. Supports `size` and `showAgent` props.
6. **`TasksDialog`** on agent detail page shows agent-scoped tasks using the same `TasksList` component filtered by `agentId`.
7. **Templates seeded** in `{dorkHome}/tasks/templates/` on first run. `GET /api/tasks/templates` returns them.
8. **`PulsePanel` removed** from session sidebar.
9. **Feature flags removed.** No `PULSE_ENABLED`, no `--pulse`. Tasks are always-on.
10. **All tests pass.** `pnpm typecheck && pnpm build && pnpm test -- --run` green.

---

## Non-Goals / Deferred

| Item                                     | Rationale                                                           |
| ---------------------------------------- | ------------------------------------------------------------------- |
| Task dependencies / chaining             | Future enhancement — requires DAG execution engine                  |
| Template marketplace                     | Future — community templates, import/export                         |
| Visual cron builder                      | Designed in V2 research (DOR-20260221), can be added as enhancement |
| DB table rename (`pulse_*` -> `tasks_*`) | Cosmetic cleanup, no user-facing impact, deferred                   |
| Tab title badge / notifications          | Polish item from V2 research, not blocked by this redesign          |
| Damon interactive chat                   | Damon runs tasks silently — no user-initiated sessions              |
