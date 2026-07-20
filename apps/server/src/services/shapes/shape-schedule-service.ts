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
 * Shape-created schedules are stamped with a provenance marker in their
 * frontmatter (`origin: shape` + `shape: <name>`). The re-bind flow gates on
 * that marker — never on name alone — so a user's own schedule that happens to
 * share a Shape schedule's name is never touched.
 *
 * @module services/shapes/shape-schedule-service
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import type { MeshCore } from '@dorkos/mesh';
import type { CreateTaskRequest } from '@dorkos/shared/schemas';
import type { Task } from '@dorkos/shared/types';
import type { Logger } from '@dorkos/shared/logger';
import { writeSkillFile, deleteSkillDir } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { slugify } from '@dorkos/skills/slug';
import { parseDuration } from '@dorkos/skills/duration';
import type { TaskStore } from '../tasks/task-store.js';
import type { TaskSchedulerService } from '../tasks/task-scheduler-service.js';
import type {
  ExistingSchedule,
  ScheduleOrigin,
  ScheduleRebind,
  ShapeScheduleServiceLike,
} from './apply-shape.js';

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
   * Every existing schedule (name + binding + enabled + provenance), across all
   * scopes (global + agents). The apply flow checks existence by NAME only — a
   * Shape schedule's target flips from `'global'` to a concrete agent id once
   * the offered agent appears, so a per-target check would miss the earlier
   * global copy and duplicate the schedule on re-apply. `shapeOrigin` is read
   * from each global schedule's file (the frontmatter provenance marker);
   * agent-bound schedules skip the file read — re-bind never considers them.
   *
   * @returns Every existing schedule's name, binding, enabled state, and origin.
   */
  async listSchedules(): Promise<ExistingSchedule[]> {
    return Promise.all(
      this.deps.taskStore.getTasks().map(async (t) => ({
        name: t.name,
        agentId: t.agentId ?? null,
        enabled: t.enabled,
        shapeOrigin: t.agentId ? null : await this.readShapeOrigin(t.filePath),
      }))
    );
  }

  /**
   * Create a schedule from a task-creation request. Writes the SKILL.md first
   * (stamped with the Shape provenance marker when `origin` is given), then
   * syncs to the DB and registers it with the scheduler when enabled. Safe to
   * call over an existing file — `upsertFromFile` is keyed by file path.
   *
   * @param req - The task-creation request built from a Shape schedule.
   * @param origin - Shape provenance to stamp into the file's frontmatter.
   */
  async createSchedule(req: CreateTaskRequest, origin?: ScheduleOrigin): Promise<void> {
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
    if (origin) {
      frontmatter.origin = 'shape';
      frontmatter.shape = origin.shape;
    }

    // EDGE: `writeSkillFile` writes into `<tasksDir>/<slug>/` and will overwrite
    // a same-slug task dir already present in the target scope (last write
    // wins, same as the tasks router's file write). The apply flow's by-name
    // existence check prevents this within DorkOS-managed schedules; a file
    // dropped on disk out-of-band between check and write could still be
    // replaced.
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
   * explicit user disable), carries no Shape provenance marker (defense in
   * depth: a user's colliding schedule is never hijacked, even if a caller
   * skipped its own gate), or the agent has no resolvable project path.
   *
   * The write-then-delete move is NOT atomic. If the process dies between the
   * two steps, both copies exist under one name — harmless, because the stale
   * copy is global + disabled (never fires), the task reconciler re-syncs both
   * files to the DB as-is, and the next apply/agent-create sees the agent-bound
   * copy first and no-ops. Worst case is a leftover disabled global schedule
   * the user can delete.
   *
   * @param name - The existing schedule's name (its cross-scope identity).
   * @param rebind - The agent id to bind to and the resulting enabled state.
   */
  async rebindSchedule(name: string, rebind: ScheduleRebind): Promise<void> {
    const existing = this.deps.taskStore.getTasks().find((t) => t.name === name);
    // Nothing to move, or the schedule already found its home — respect it.
    if (!existing || existing.agentId) return;

    // Provenance guard: only a schedule a Shape created may be re-homed.
    const shapeOrigin = await this.readShapeOrigin(existing.filePath);
    if (!shapeOrigin) {
      this.deps.logger.warn(
        `[shape-schedule] Refusing to re-bind '${name}' — no Shape provenance marker (user-created?)`
      );
      return;
    }

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
    // The provenance marker travels with the schedule — it stays a Shape
    // schedule in its new home.
    await this.createSchedule(
      {
        name: existing.name,
        description: existing.description ?? '',
        prompt: existing.prompt,
        cron: existing.cron,
        timezone: existing.timezone,
        target: rebind.agentId,
        enabled: rebind.enabled,
        permissionMode: existing.permissionMode,
      },
      { shape: shapeOrigin }
    );

    // Remove the old global copy (file + row + any scheduler registration) so
    // the schedule is not duplicated across scopes.
    await this.teardownSchedule(existing);
  }

  /**
   * Delete every schedule created by a given Shape (its provenance marker names
   * it), across both global and agent-bound scopes — the teardown that keeps a
   * Shape's schedules from outliving the Shape. Reads each schedule file's
   * marker directly (agent-bound schedules were moved into their agent's dir by
   * {@link rebindSchedule}, so a scope-blind scan is required) and fails closed:
   * a missing, unreadable, or mismatched marker leaves the schedule alone, so a
   * user's own schedule that collides on name is never deleted.
   *
   * @param shapeName - The owning Shape whose schedules to delete.
   * @param keepNames - Stored schedule names (`slugify`'d, matching `task.name`)
   *   to spare. The apply reconciliation passes the Shape's currently-declared
   *   names in slug form so only renamed/dropped schedules go; omit to delete
   *   all of the Shape's schedules (the uninstall teardown).
   * @returns The names of the schedules deleted.
   */
  async deleteSchedulesForShape(
    shapeName: string,
    keepNames?: ReadonlySet<string>
  ): Promise<string[]> {
    const deleted: string[] = [];
    for (const task of this.deps.taskStore.getTasks()) {
      if (keepNames?.has(task.name)) continue;
      // Provenance guard: only a schedule this exact Shape created is removed.
      const origin = await this.readShapeOrigin(task.filePath);
      if (origin !== shapeName) continue;
      await this.teardownSchedule(task);
      deleted.push(task.name);
    }
    return deleted;
  }

  /**
   * Full teardown of one schedule: unregister its cron job, delete its
   * task-store row, and remove its SKILL.md directory. Going through the
   * scheduler + store (not a bare file delete) is what guarantees a torn-down
   * schedule stops firing; a missing file is ignored because the registration +
   * row are what a stale schedule actually runs from.
   *
   * @param task - The schedule to tear down.
   */
  private async teardownSchedule(task: Task): Promise<void> {
    this.deps.scheduler.unregisterTask(task.id);
    this.deps.taskStore.deleteTask(task.id);
    if (task.filePath) {
      const dirPath = path.dirname(task.filePath);
      await deleteSkillDir(path.dirname(dirPath), path.basename(dirPath)).catch(() => {
        // File may already be gone — the row + registration are what mattered.
      });
    }
  }

  /**
   * Read the Shape provenance marker from a schedule's SKILL.md. Fail-closed:
   * any read/parse failure or missing marker returns `null`, which the re-bind
   * flow treats as "not a Shape schedule — do not touch".
   *
   * @param filePath - The schedule's SKILL.md path.
   * @returns The owning Shape's name, or `null` when unmarked/unreadable.
   */
  private async readShapeOrigin(filePath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = parseSkillFile(filePath, content, TaskFrontmatterSchema, {
        requireNameMatch: false,
      });
      if (!parsed.ok) return null;
      return parsed.definition.meta.origin === 'shape'
        ? (parsed.definition.meta.shape ?? null)
        : null;
    } catch {
      return null;
    }
  }
}
