/**
 * Concrete {@link ShapeScheduleServiceLike} — the file-first schedule creator
 * the apply-shape flow uses in production.
 *
 * Mirrors the tasks router's create path (`routes/tasks.ts`): resolve the target
 * (a concrete agent's `.dork/tasks/` dir, or the global `tasks/` dir), write the
 * SKILL.md (the source of truth), then sync it to the DB and register it with
 * the scheduler when enabled. Reusing the shared `@dorkos/skills` primitives
 * keeps this consistent with hand-created schedules without duplicating the
 * router's HTTP concerns.
 *
 * @module services/shapes/shape-schedule-service
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import type { MeshCore } from '@dorkos/mesh';
import type { CreateTaskRequest } from '@dorkos/shared/schemas';
import type { Logger } from '@dorkos/shared/logger';
import { writeSkillFile, deleteSkillDir } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { slugify } from '@dorkos/skills/slug';
import { parseDuration } from '@dorkos/skills/duration';
import type { TaskStore } from '../tasks/task-store.js';
import type { TaskSchedulerService } from '../tasks/task-scheduler-service.js';
import type { ExistingSchedule, ScheduleRebind, ShapeScheduleServiceLike } from './apply-shape.js';

/** Constructor dependencies for {@link ShapeScheduleService}. */
export interface ShapeScheduleServiceDeps {
  taskStore: TaskStore;
  scheduler: TaskSchedulerService;
  meshCore?: MeshCore;
  dorkHome: string;
  logger: Logger;
}

/**
 * Creates Shape schedules idempotently (by name + target), file-first, exactly
 * like the tasks router. `target` is a concrete agent id or `'global'`.
 */
export class ShapeScheduleService implements ShapeScheduleServiceLike {
  constructor(private readonly deps: ShapeScheduleServiceDeps) {}

  /**
   * Every existing schedule (name + binding + enabled), across all scopes
   * (global + agents). The apply flow checks existence by NAME only — a Shape
   * schedule's target flips from `'global'` to a concrete agent id once the
   * offered agent appears, so a per-target check would miss the earlier global
   * copy and duplicate the schedule on re-apply. `agentId` lets the caller tell
   * a still-waiting global copy (re-bindable) from one already agent-bound.
   *
   * @returns Every existing schedule's name, bound agent id, and enabled state.
   */
  listSchedules(): ExistingSchedule[] {
    return this.deps.taskStore.getTasks().map((t) => ({
      name: t.name,
      agentId: t.agentId ?? null,
      enabled: t.enabled,
    }));
  }

  /**
   * Create a schedule from a task-creation request. Writes the SKILL.md first,
   * then syncs to the DB and registers it with the scheduler when enabled. Safe
   * to call over an existing file — `upsertFromFile` is keyed by file path.
   *
   * @param req - The task-creation request built from a Shape schedule.
   */
  async createSchedule(req: CreateTaskRequest): Promise<void> {
    const slug = slugify(req.name);
    let tasksDir: string;
    let agentId: string | null = null;

    if (req.target === 'global') {
      tasksDir = path.join(this.deps.dorkHome, 'tasks');
    } else {
      const projectPath = this.deps.meshCore?.getProjectPath(req.target);
      if (!projectPath) {
        // The agent vanished between resolution and creation — fall back to a
        // global schedule so the arrangement is not silently lost.
        tasksDir = path.join(this.deps.dorkHome, 'tasks');
        this.deps.logger.warn(
          `[shape-schedule] Agent '${req.target}' has no project path; created schedule '${slug}' globally`
        );
      } else {
        tasksDir = path.join(projectPath, '.dork', 'tasks');
        agentId = req.target;
      }
    }

    const frontmatter: Record<string, unknown> = { name: slug, description: req.description };
    if (req.cron) frontmatter.cron = req.cron;
    if (req.timezone) frontmatter.timezone = req.timezone;
    if (req.enabled === false) frontmatter.enabled = false;
    if (req.permissionMode && req.permissionMode !== 'acceptEdits') {
      frontmatter.permissions = req.permissionMode;
    }

    const filePath = await writeSkillFile(tasksDir, slug, frontmatter, req.prompt);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, TaskFrontmatterSchema);

    const schedule = parsed.ok
      ? this.deps.taskStore.upsertFromFile(
          { ...parsed.definition, scope: 'global' as const, projectPath: undefined },
          agentId ?? undefined
        )
      : this.deps.taskStore.createTask({
          name: slug,
          description: req.description,
          prompt: req.prompt,
          cron: req.cron,
          timezone: req.timezone,
          agentId,
          enabled: req.enabled,
          maxRuntime: req.maxRuntime ? parseDuration(req.maxRuntime) : null,
          permissionMode: req.permissionMode,
          filePath,
        });

    if (schedule.enabled && schedule.status === 'active') {
      this.deps.scheduler.registerTask(schedule);
    }
  }

  /**
   * Re-target a global (unbound) schedule to a now-present agent and enable it —
   * the second half of the `'global'` → agent flip promised above. The schedule
   * file physically moves from the global `tasks/` dir into the agent's
   * `.dork/tasks/` (the on-disk location is what makes a schedule agent-owned),
   * so this writes the agent-scoped copy first, then removes the old global one
   * to leave exactly one schedule. A no-op — leaving the global copy untouched —
   * when the named schedule is absent, is already agent-bound (respecting an
   * explicit user disable), or the agent has no resolvable project path.
   *
   * @param name - The existing schedule's name (its cross-scope identity).
   * @param rebind - The agent id to bind to and the resulting enabled state.
   */
  async rebindSchedule(name: string, rebind: ScheduleRebind): Promise<void> {
    const existing = this.deps.taskStore.getTasks().find((t) => t.name === name);
    // Nothing to move, or the schedule already found its home — respect it.
    if (!existing || existing.agentId) return;

    // Resolve the target up front: if the agent has no project path, leave the
    // schedule global (createSchedule would otherwise fall back to the SAME
    // global path and the cleanup below would delete what it just wrote).
    const projectPath = this.deps.meshCore?.getProjectPath(rebind.agentId);
    if (!projectPath) {
      this.deps.logger.warn(
        `[shape-schedule] Cannot re-bind '${name}' — agent '${rebind.agentId}' has no project path`
      );
      return;
    }

    // Write the agent-scoped copy (new file path → new row) and register it.
    await this.createSchedule({
      name: existing.name,
      description: existing.description ?? '',
      prompt: existing.prompt,
      cron: existing.cron,
      timezone: existing.timezone,
      target: rebind.agentId,
      enabled: rebind.enabled,
      permissionMode: existing.permissionMode,
    });

    // Remove the old global copy (file + row + any scheduler registration) so
    // the schedule is not duplicated across scopes.
    this.deps.scheduler.unregisterTask(existing.id);
    this.deps.taskStore.deleteTask(existing.id);
    if (existing.filePath) {
      const dirPath = path.dirname(existing.filePath);
      await deleteSkillDir(path.dirname(dirPath), path.basename(dirPath)).catch(() => {
        // File may already be gone — the DB row is what mattered.
      });
    }
  }
}
