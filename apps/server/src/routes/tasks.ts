/**
 * Tasks scheduler routes — CRUD for schedules and runs.
 *
 * File-first architecture: API routes write SKILL.md files to disk,
 * then sync to the DB for immediate consistency. The watcher/reconciler
 * handles external file changes.
 *
 * @module routes/tasks
 */
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import {
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
  ListTaskRunsQuerySchema,
} from '@dorkos/shared/schemas';
import type { Task } from '@dorkos/shared/schemas';
import type { MeshCore } from '@dorkos/mesh';
import type { TaskStore } from '../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../services/tasks/task-scheduler-service.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { writeSkillFile, deleteSkillDir } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { slugify } from '@dorkos/skills/slug';
import { parseDuration } from '@dorkos/skills/duration';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { loadTemplates } from '../services/tasks/task-templates.js';
import { parseBody } from '../lib/route-utils.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import {
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
  OPERATOR_ONLY_TASK_CODE,
  OPERATOR_ONLY_TASK_ERROR,
} from '../services/tasks/task-write-policy.js';
import fs from 'node:fs/promises';

/**
 * Refuse a task write that reaches for a field only a person may set (DOR-504),
 * answering on `res` when it does.
 *
 * ## Why this route needs a caller check when the MCP twin does not
 *
 * `tasks_create` and `tasks_update` refuse `permissionMode` and `status`
 * unconditionally, because an MCP tool call is by construction the agent surface.
 * This route is not: the cockpit's Approve button writes `status: 'active'`
 * through it (`TaskRow.tsx`), and its task form writes `permissionMode`. So the
 * policy is skipped for a caller that clears `trustedCaller` — no agent identity
 * and no approval token — and applied to everyone else. That is exactly the shape
 * `PATCH /api/config` uses for operator-only settings, and the long note there
 * states the divergence it creates: under the default `local-trust` posture a
 * caller with a shell can omit both headers and clear the check, so this stops
 * an agent that follows the protocol, not an adversary already running as you.
 * That is stated rather than papered over, and it is strictly tighter than the
 * nothing this route enforced before.
 *
 * ## Read the RAW body, and refuse it whole
 *
 * The check runs before `parseBody` for two reasons. `CreateTaskRequestSchema`
 * DEFAULTS `permissionMode` to `acceptEdits`, so a parsed body always carries the
 * key and the guard could not tell a caller that sent it from one that did not.
 * And refusing before anything is parsed or written is what makes the refusal
 * whole: a caller is never told a change landed when only part of it did.
 *
 * @param req - The incoming request, whose raw body is inspected.
 * @param res - The response, answered with 403 when a field is refused.
 * @param trusted - Whether the caller cleared {@link trustedCaller}. Passed in
 *   rather than resolved here because `POST /` needs the same answer a second
 *   time, to decide whether the new task is parked (see {@link parksOnCreate}),
 *   and asking twice would let the two uses disagree.
 * @returns True when the request was refused and the route must stop.
 */
function refusedOperatorOnlyTaskWrite(req: Request, res: Response, trusted: boolean): boolean {
  if (trusted) return false;
  const operatorOnly = findOperatorOnlyTaskFields(req.body);
  if (operatorOnly.length === 0) return false;
  res.status(403).json({
    error: OPERATOR_ONLY_TASK_ERROR,
    code: OPERATOR_ONLY_TASK_CODE,
    fields: operatorOnly,
    message: describeOperatorOnlyTaskRefusal(operatorOnly),
  });
  return true;
}

/**
 * Whether a task created by this caller must wait for a person's approval
 * (DOR-504).
 *
 * ## The gap this closes
 *
 * `tasks_create` on both MCP servers parks every schedule it makes at
 * `pending_approval`, and says so in its own description. That parking lived in
 * the TOOL HANDLER, not in the store: both store insert paths hardcode
 * `status: 'active'`. So the REST twin created a LIVE cron task instead — and
 * `dorkos task create` is that REST surface, sending its agent header. An agent
 * could not arm a task through the tool it was told to use, and could through the
 * CLI it was also told to use.
 *
 * That is worth closing rather than only narrowing the prose around: a cron task
 * is persistence. It fires later, on its own, when nobody is looking, which is a
 * different thing from running a command now.
 *
 * ## Why trust, and not the presence of a `status` field
 *
 * The caller never has to ASK to arm a task here; it arms by default, because
 * the store's insert says `active`. So there is no field to refuse. The question
 * is only "did a person do this", which is the same question
 * {@link refusedOperatorOnlyTaskWrite} already asks, answered by the same
 * predicate — so the cockpit's task form and a signed-in operator are untouched,
 * and an agent's REST-created task now waits exactly like its MCP-created one.
 *
 * @param trusted - Whether the caller cleared {@link trustedCaller}.
 * @returns True when the new task must be parked at `pending_approval`.
 */
function parksOnCreate(trusted: boolean): boolean {
  return !trusted;
}

/**
 * Create the Tasks router with schedule and run management endpoints.
 *
 * @param store - TaskStore for data persistence
 * @param scheduler - TaskSchedulerService for cron management and dispatch
 * @param dorkHome - Resolved data directory path
 * @param meshCore - Optional MeshCore for resolving agent project paths
 * @param activityService - Optional ActivityService for emitting activity events
 */
export function createTasksRouter(
  store: TaskStore,
  scheduler: TaskSchedulerService,
  dorkHome: string,
  meshCore?: MeshCore,
  activityService?: ActivityService
): Router {
  const router = Router();

  // === Template endpoints ===

  router.get('/templates', async (_req, res) => {
    const templates = await loadTemplates(dorkHome);
    return res.json(templates);
  });

  // === Schedule endpoints ===

  router.get('/', (_req, res) => {
    const schedules = store.getTasks().map((s) => ({
      ...s,
      nextRun: scheduler.getNextRun(s.id)?.toISOString() ?? null,
    }));
    res.json(schedules);
  });

  router.post('/', async (req, res) => {
    const trusted = trustedCaller(readCallerAuthority(req, res)) !== undefined;
    if (refusedOperatorOnlyTaskWrite(req, res, trusted)) return;
    const data = parseBody(CreateTaskRequestSchema, req.body, res);
    if (!data) return;

    // Resolve slug and target directory
    const slug = slugify(data.name);
    let tasksDir: string;
    let agentId: string | null = null;

    if (data.target === 'global') {
      tasksDir = path.join(dorkHome, 'tasks');
    } else if (meshCore) {
      const projectPath = meshCore.getProjectPath(data.target);
      if (!projectPath) {
        return res.status(400).json({ error: `Agent ${data.target} not found in registry` });
      }
      tasksDir = path.join(projectPath, '.dork', 'tasks');
      agentId = data.target;
    } else {
      return res.status(400).json({ error: 'Cannot resolve agent — mesh not available' });
    }

    // Check for duplicate slug
    const existingPath = path.join(tasksDir, slug, SKILL_FILENAME);
    try {
      await fs.access(existingPath);
      return res.status(409).json({ error: `Task "${slug}" already exists in target directory` });
    } catch {
      // File doesn't exist — good
    }

    // Build frontmatter (only file-safe fields)
    const frontmatter: Record<string, unknown> = {
      name: slug,
      description: data.description,
    };
    if (data.displayName) frontmatter['display-name'] = data.displayName;
    if (data.cron) frontmatter.cron = data.cron;
    if (data.timezone) frontmatter.timezone = data.timezone;
    if (data.enabled === false) frontmatter.enabled = false;
    if (data.maxRuntime) frontmatter['max-runtime'] = data.maxRuntime;
    if (data.permissionMode && data.permissionMode !== 'acceptEdits') {
      frontmatter.permissions = data.permissionMode;
    }

    // Write file first (source of truth)
    const filePath = await writeSkillFile(tasksDir, slug, frontmatter, data.prompt);

    // Sync to DB for immediate consistency
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, TaskFrontmatterSchema);
    let schedule: Task;
    if (parsed.ok) {
      const def = { ...parsed.definition, scope: 'global' as const, projectPath: undefined };
      schedule = store.upsertFromFile(def, agentId ?? undefined);
    } else {
      // Fallback: create directly in DB
      schedule = store.createTask({
        name: slug,
        displayName: data.displayName,
        description: data.description,
        prompt: data.prompt,
        cron: data.cron,
        timezone: data.timezone,
        agentId,
        enabled: data.enabled,
        maxRuntime: data.maxRuntime ? parseDuration(data.maxRuntime) : null,
        permissionMode: data.permissionMode,
        filePath,
      });
    }

    // Both store insert paths hardcode `status: 'active'`, so parking is a patch
    // after the fact — the same two-step `tasks_create` uses on the MCP servers.
    // It has to happen BEFORE the register below, or the task fires while it is
    // still waiting to be approved.
    if (parksOnCreate(trusted)) {
      store.updateTask(schedule.id, { status: 'pending_approval' });
      schedule = store.getTask(schedule.id)!;
    }

    if (schedule.enabled && schedule.status === 'active') {
      scheduler.registerTask(schedule);
    }

    activityService?.emit({
      actorType: 'user',
      actorLabel: 'You',
      category: 'tasks',
      eventType: 'tasks.task_created',
      resourceType: 'schedule',
      resourceId: schedule.id,
      resourceLabel: schedule.displayName ?? schedule.name,
      summary: `Created task ${schedule.displayName ?? schedule.name}`,
      linkPath: '/',
    });

    // nextRun is derived from the scheduler (not persisted on the schedule row),
    // so it must be attached here the same way the list endpoint does below —
    // otherwise a freshly created task reports nextRun: null until the next list fetch.
    return res.status(201).json({
      ...schedule,
      nextRun: scheduler.getNextRun(schedule.id)?.toISOString() ?? null,
    });
  });

  router.patch('/:id', async (req, res) => {
    const trusted = trustedCaller(readCallerAuthority(req, res)) !== undefined;
    if (refusedOperatorOnlyTaskWrite(req, res, trusted)) return;
    const data = parseBody(UpdateTaskRequestSchema, req.body, res);
    if (!data) return;

    const existing = store.getTask(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // If there's a file on disk, update it
    if (existing.filePath) {
      try {
        const content = await fs.readFile(existing.filePath, 'utf-8');
        const parsed = parseSkillFile(existing.filePath, content, TaskFrontmatterSchema);

        if (parsed.ok) {
          const updatedFrontmatter: Record<string, unknown> = {
            ...(parsed.definition.meta as Record<string, unknown>),
          };
          if (data.name !== undefined) updatedFrontmatter.name = data.name;
          if (data.displayName !== undefined) updatedFrontmatter['display-name'] = data.displayName;
          if (data.description !== undefined) updatedFrontmatter.description = data.description;
          if (data.cron !== undefined) updatedFrontmatter.cron = data.cron;
          if (data.timezone !== undefined) updatedFrontmatter.timezone = data.timezone;
          if (data.enabled !== undefined) updatedFrontmatter.enabled = data.enabled;
          if (data.maxRuntime !== undefined) updatedFrontmatter['max-runtime'] = data.maxRuntime;
          if (data.permissionMode !== undefined)
            updatedFrontmatter.permissions = data.permissionMode;

          const updatedPrompt = data.prompt ?? parsed.definition.body;
          const parentDir = path.dirname(parsed.definition.dirPath);
          await writeSkillFile(
            parentDir,
            parsed.definition.name,
            updatedFrontmatter,
            updatedPrompt
          );
        }
      } catch {
        // File may not exist (legacy DB-only task) — update DB directly
      }
    }

    const updated = store.updateTask(req.params.id, data);
    if (!updated) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Re-register or unregister cron job based on new state
    if (updated.enabled && updated.status === 'active') {
      scheduler.registerTask(updated);
    } else {
      scheduler.unregisterTask(updated.id);
    }

    if (data.enabled === false && activityService) {
      activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'tasks',
        eventType: 'tasks.task_paused',
        resourceType: 'schedule',
        resourceId: req.params.id,
        resourceLabel: updated.displayName ?? updated.name,
        summary: `Paused task ${updated.displayName ?? updated.name}`,
        linkPath: '/',
      });
    }

    return res.json(updated);
  });

  router.delete('/:id', async (_req, res) => {
    const { id } = _req.params;
    const schedule = store.getTask(id);
    if (!schedule) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Delete file from disk first
    if (schedule.filePath) {
      try {
        const dirPath = path.dirname(schedule.filePath);
        const dirName = path.basename(dirPath);
        const parentDir = path.dirname(dirPath);
        await deleteSkillDir(parentDir, dirName);
      } catch {
        // File may already be gone — continue with DB cleanup
      }
    }

    scheduler.unregisterTask(id);
    store.deleteTask(id);

    activityService?.emit({
      actorType: 'user',
      actorLabel: 'You',
      category: 'tasks',
      eventType: 'tasks.task_deleted',
      resourceType: 'schedule',
      resourceId: id,
      resourceLabel: schedule.displayName ?? schedule.name,
      summary: `Deleted task ${schedule.displayName ?? schedule.name}`,
    });

    return res.json({ success: true });
  });

  router.post('/:id/trigger', async (_req, res) => {
    const run = await scheduler.triggerManualRun(_req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Schedule not found' });
    }
    return res.status(201).json({ runId: run.id });
  });

  // === Run endpoints ===

  router.get('/runs', (req, res) => {
    const data = parseBody(ListTaskRunsQuerySchema, req.query, res);
    if (!data) return;

    const runs = store.listRuns({
      taskId: data.scheduleId,
      status: data.status,
      limit: data.limit,
      offset: data.offset,
    });
    return res.json(runs);
  });

  router.get('/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json(run);
  });

  router.post('/runs/:id/cancel', (req, res) => {
    const run = store.getRun(req.params.id);
    const cancelled = scheduler.cancelRun(req.params.id);
    if (!cancelled) {
      return res.status(404).json({ error: 'Run not found or not active' });
    }

    if (activityService && run) {
      const schedule = store.getTask(run.scheduleId);
      activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'tasks',
        eventType: 'tasks.run_cancelled',
        resourceType: 'schedule',
        resourceId: run.scheduleId,
        resourceLabel: schedule?.displayName ?? schedule?.name ?? run.scheduleId,
        summary: `${schedule?.displayName ?? schedule?.name ?? run.scheduleId} was cancelled`,
        linkPath: '/',
      });
    }

    return res.json({ success: true });
  });

  return router;
}
