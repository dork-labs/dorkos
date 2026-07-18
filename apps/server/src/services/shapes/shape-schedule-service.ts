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
import { writeSkillFile } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { slugify } from '@dorkos/skills/slug';
import { parseDuration } from '@dorkos/skills/duration';
import type { TaskStore } from '../tasks/task-store.js';
import type { TaskSchedulerService } from '../tasks/task-scheduler-service.js';
import type { ShapeScheduleServiceLike } from './apply-shape.js';

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
   * Every existing schedule name, across all scopes (global + agents). The
   * apply flow checks existence by NAME only — a Shape schedule's target flips
   * from `'global'` to a concrete agent id once the offered agent appears, so a
   * per-target check would miss the earlier global copy and duplicate the
   * schedule on re-apply.
   *
   * @returns All existing schedule names.
   */
  existingScheduleNames(): string[] {
    return this.deps.taskStore.getTasks().map((t) => t.name);
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
}
