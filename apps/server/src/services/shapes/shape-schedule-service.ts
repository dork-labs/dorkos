/**
 * Concrete {@link ShapeScheduleServiceLike} — the file-first schedule creator
 * the apply-shape flow uses in production.
 *
 * Mirrors the tasks router's create path (`routes/tasks.ts`): resolve the target
 * (a concrete agent's `.agents/skills/` dir, or the global `~/.dork/skills/`),
 * write the SKILL.md (the source of truth), then sync it to the DB and register
 * it with the scheduler. Reusing the shared `@dorkos/skills` primitives keeps
 * this consistent with hand-created schedules without duplicating the router's
 * HTTP concerns.
 *
 * Shape-created schedules are stamped with a provenance marker inside their
 * `schedule:` block (`origin: shape` + `shape: <name>`). The re-bind flow gates
 * on that marker — never on name alone — so a user's own schedule that happens
 * to share a Shape schedule's name is never touched.
 *
 * ## What DOR-1486 changed here, and why this service still owns it
 *
 * The marketplace's own materializer (`services/marketplace/lib/
 * materialize-schedules.ts`) deliberately skips a Shape's `schedules[]`, because
 * this service owns them — it has the re-bind and teardown flows that a Shape's
 * schedules need and a plugin's do not. What changed is the format and the
 * place: a schedule block in a skills root, exactly like every other schedule,
 * instead of top-level fields in a `tasks/` directory nothing scans any more.
 *
 * The row is written as a DISCOVERY sync, so an applied Shape's schedule PARKS
 * for approval rather than arming itself — the same answer a package-installed
 * one gets from the watcher, and the answer never-auto-arm requires (ADR
 * `260823-200726`). Applying a Shape is a person's decision to INSTALL an
 * arrangement; it is not, on its own, their decision to let a particular
 * unattended job start running on a timer.
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
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { hasSchedule, scheduleToFrontmatter, type ScheduleBlock } from '@dorkos/skills';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { slugify } from '@dorkos/skills/slug';
import { parseDuration } from '@dorkos/skills/duration';
import { agentSkillsRoot, globalSkillsRoot, resolveRootPath } from '../tasks/skills-roots.js';
import { readScheduleFromSkill } from '../tasks/skills-root-discovery.js';
import { clampSchedulePermissionMode } from '../tasks/schedule-permission-clamp.js';
import type { TaskStore } from '../tasks/task-store.js';
import type { TaskRegistrar } from '../tasks/task-registrar.js';
import { resolveParkedScheduleRemoved } from '../notifications/emitters/schedule-park.js';
import type {
  ExistingSchedule,
  ScheduleOrigin,
  ScheduleRebind,
  ShapeScheduleServiceLike,
} from './apply-shape.js';

/** Constructor dependencies for {@link ShapeScheduleService}. */
export interface ShapeScheduleServiceDeps {
  taskStore: TaskStore;
  /**
   * The one seam that turns a row into a live cron job. Shared with the tasks
   * routes, the file watcher, and the reconciler — a Shape's schedule is an
   * ordinary schedule, and must not have a second opinion about when it runs.
   */
  registrar: TaskRegistrar;
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
   * syncs to the DB and registers it with the scheduler when enabled.
   *
   * **It will not write over somebody else's skill.** See {@link claimTarget}:
   * the target directory is checked on DISK before anything is written, because
   * the apply flow's own existence check is by ROW and a person's hand-written
   * skill has no row. Re-applying a Shape over its own schedule is still an
   * ordinary overwrite — that is the marker's other job.
   *
   * @param req - The task-creation request built from a Shape schedule.
   * @param origin - Shape provenance to stamp into the file's frontmatter.
   * @returns Whether the schedule now exists. `false` means the target was
   *   somebody else's and nothing was written — the caller must not then delete
   *   anything on the strength of it (see {@link rebindSchedule}).
   */
  async createSchedule(req: CreateTaskRequest, origin?: ScheduleOrigin): Promise<boolean> {
    const slug = slugify(req.name);
    let skillsDir: string;
    let agentId: string | null = null;
    let projectPath: string | undefined;

    if (req.target === 'global') {
      skillsDir = globalSkillsRoot(this.deps.dorkHome);
    } else {
      const resolved = this.deps.meshCore?.getProjectPath(req.target);
      if (!resolved) {
        // The agent vanished between resolution and creation — fall back to a
        // global schedule so the arrangement is not silently lost.
        skillsDir = globalSkillsRoot(this.deps.dorkHome);
        this.deps.logger.warn(
          `[shape-schedule] Agent '${req.target}' has no project path; created schedule '${slug}' globally`
        );
      } else {
        skillsDir = agentSkillsRoot(resolved);
        projectPath = resolved;
        agentId = req.target;
      }
    }

    // Written through `scheduleToFrontmatter` so the block holds only what a
    // person would have typed — a default spelled out in the file is a line the
    // next reader has to decide whether to trust.
    const block: ScheduleBlock = {
      ...(req.cron ? { cron: req.cron } : {}),
      timezone: req.timezone || 'UTC',
      enabled: req.enabled !== false,
      // A Shape-declared schedule cannot ask for session-resume yet (DOR-1571):
      // there is no `sticky` field on a Shape schedule request, so it stays
      // isolated-per-run. `scheduleToFrontmatter` drops this `false`.
      sticky: false,
      ...(req.maxRuntime ? { 'max-runtime': req.maxRuntime } : {}),
      permissions: req.permissionMode ?? 'acceptEdits',
      ...(origin ? { origin: 'shape' as const, shape: origin.shape } : {}),
    };
    const frontmatter: Record<string, unknown> = {
      name: slug,
      description: req.description,
      schedule: scheduleToFrontmatter(block),
    };

    // Nothing is written until the target is known to be ours to write.
    if (!(await this.claimTarget(path.join(skillsDir, slug), slug, origin))) return false;

    const filePath = await writeSkillFile(skillsDir, slug, frontmatter, req.prompt);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
    // Keyed on the REAL path, because that is what the watcher reading this same
    // file moments from now will key its row on.
    const discovered = parsed.ok
      ? readScheduleFromSkill(parsed.definition, {
          scope: projectPath ? 'project' : 'global',
          projectPath,
          resolvedPath: path.join(await resolveRootPath(skillsDir), slug, SKILL_FILENAME),
        })
      : null;

    const schedule = discovered
      ? this.deps.taskStore.upsertFromFile(discovered.def, agentId ?? undefined, {
          source: 'discovery',
          problem: discovered.problem,
        })
      : this.deps.taskStore.createTask({
          name: slug,
          description: req.description,
          prompt: req.prompt,
          cron: req.cron,
          timezone: req.timezone,
          agentId,
          enabled: req.enabled,
          maxRuntime: req.maxRuntime ? parseDuration(req.maxRuntime) : null,
          // `taskStore.createTask` is the raw row writer — unlike
          // `upsertFromFile` above, it has no clamp of its own (DOR-823). This
          // branch runs exactly when `parseSkillFile` fails on the file this
          // method just wrote, which is precisely when a package-declared
          // schedule's permission mode must not reach the row unclamped: the
          // clamp exists so a Shape's schedule can't self-elevate, and a
          // parse failure is not a reason to skip it.
          permissionMode: clampSchedulePermissionMode(req.permissionMode ?? 'acceptEdits').mode,
          filePath,
        });

    this.deps.registrar.syncTask(schedule.id);
    return true;
  }

  /**
   * Whether `<skillsDir>/<slug>/` is this Shape's to write into.
   *
   * ## Why a disk check, when the apply flow already checks for a collision
   *
   * Because that check is by ROW, over `taskStore.getTasks()`, and the thing it
   * has to protect is not in the table. A skills root is where a person's own
   * skills live — most of them plain, none of them rows — so an apply that
   * trusted the row check wrote a Shape's schedule straight over a hand-written
   * skill with no warning anywhere, and the teardown that followed removed the
   * whole directory, reference files and all. The move from `tasks/` (a
   * directory DorkOS owned outright) to `.agents/skills/` (a directory a person
   * owns) is what turned a documented last-write-wins edge into data loss, so
   * the guard moved with it.
   *
   * Three answers:
   *
   * - **Nothing there** — free.
   * - **This Shape's own schedule** — free, and an ordinary re-apply. Decided by
   *   the provenance marker via {@link readShapeOrigin}, which fails closed, so
   *   an unreadable file is somebody else's by default.
   * - **Anything else** — refused, and said out loud. A symlink is refused
   *   FIRST and unconditionally, marker or no marker: a `pkg__name` link is how
   *   Harness Sync projects an installed package's skill, and writing through it
   *   edits the package's own checkout — shared by every agent that installed it,
   *   invisible in the cockpit, and gone at the next update.
   *
   * Refusing rather than renaming aside is deliberate. A suffixed schedule keeps
   * the arrangement alive at a name the Shape does not know, so the next apply
   * finds nothing by that name and stands up a second one; and a person who
   * named a skill has a claim on that name that a package does not get to
   * out-vote. The Shape is simply short one schedule, and the log says which.
   *
   * @param targetDir - The directory the schedule would be written into.
   * @param slug - Its name, for the log line.
   * @param origin - The Shape asking, when one is.
   * @returns Whether to go ahead.
   */
  private async claimTarget(
    targetDir: string,
    slug: string,
    origin?: ScheduleOrigin
  ): Promise<boolean> {
    let stat;
    try {
      stat = await fs.lstat(targetDir);
    } catch {
      return true; // Nothing there.
    }

    if (stat.isSymbolicLink()) {
      this.deps.logger.warn(
        `[shape-schedule] Refusing to write '${slug}' — ${targetDir} is a link to a skill DorkOS ` +
          `does not own (an installed package's, most likely)`
      );
      return false;
    }

    const owner = await this.readShapeOrigin(path.join(targetDir, SKILL_FILENAME));
    if (origin && owner === origin.shape) return true;

    this.deps.logger.warn(
      `[shape-schedule] Refusing to write '${slug}' — ${targetDir} already holds a skill this ` +
        `Shape did not create${owner ? ` (it belongs to '${owner}')` : ''}`
    );
    return false;
  }

  /**
   * Re-target a global (unbound) schedule to a now-present agent and enable it —
   * the second half of the `'global'` → agent flip promised above. The schedule
   * file physically moves from the global skills root into the agent's
   * `.agents/skills/` (the on-disk location is what makes a schedule
   * agent-owned),
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
    const created = await this.createSchedule(
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

    // The copy is what makes the teardown below safe to do. If the agent's
    // skills root already held a skill of that name, nothing was written — and
    // tearing the global copy down anyway would delete the only copy there is.
    if (!created) {
      this.deps.logger.warn(
        `[shape-schedule] Left '${name}' where it is — the agent's skills root already has a skill by that name`
      );
      return;
    }

    // Remove the old global copy (file + row + any scheduler registration) so
    // the schedule is not duplicated across scopes.
    await this.teardownSchedule(existing);
  }

  /**
   * Delete every schedule created by a given Shape (its provenance marker names
   * it), across both global and agent-bound scopes — the teardown that keeps a
   * Shape's schedules from outliving the Shape. Reads each schedule file's
   * marker directly (agent-bound schedules were moved into their agent's root by
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
    this.deps.taskStore.deleteTask(task.id);
    // Row first, then the seam: with no row to read, `syncTask` unregisters.
    this.deps.registrar.syncTask(task.id);
    // A Shape's schedule can be torn down while still waiting on the operator's
    // approval. Ending the standing condition here is what stops an armed
    // escalation buzzing a phone about a schedule that is gone (DOR-1387
    // review). A no-op for the ordinary active schedule this usually removes.
    resolveParkedScheduleRemoved(task);
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
      const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema, {
        requireNameMatch: false,
      });
      if (!parsed.ok || !hasSchedule(parsed.definition.meta)) return null;
      const { origin, shape } = parsed.definition.meta.schedule;
      return origin === 'shape' ? (shape ?? null) : null;
    } catch {
      return null;
    }
  }
}
