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
 * `schedule:` block (`origin: shape` + `shape: <name>`), so anybody opening the
 * file can see where it came from. The marker is a LABEL, not a claim: since
 * DOR-1524 every ownership decision — may this apply overwrite that directory,
 * may this teardown delete it, may this schedule be re-homed — is answered from
 * the write receipt instead ({@link ShapeScheduleReceipts}), which records the
 * directories an apply actually wrote. A marker travels with the bytes, so a
 * copy of a Shape's schedule carries one; a receipt entry does not, so your copy
 * is yours.
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
import { writeSkillFile } from '@dorkos/skills/writer';
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
  ScheduleWriteOutcome,
  ScheduleWriteRefusal,
  ShapeScheduleServiceLike,
} from './apply-shape.js';
import { removeScheduledTaskFile } from '../tasks/lifecycle/delete-task.js';
import { shapeScheduleReceipts, type ShapeScheduleReceipts } from './schedule-write-receipt.js';

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
  /** The record of which schedule directories a Shape's apply actually wrote. */
  private readonly receipts: ShapeScheduleReceipts;

  /**
   * Build the service, opening the write receipt over the same data directory.
   *
   * @param deps - Task store, scheduler seam, mesh, data directory, and logger.
   */
  constructor(private readonly deps: ShapeScheduleServiceDeps) {
    this.receipts = shapeScheduleReceipts(deps.dorkHome, deps.logger);
  }

  /**
   * Every existing schedule (name + binding + enabled + owner), across all
   * scopes (global + agents). The apply flow checks existence by NAME only — a
   * Shape schedule's target flips from `'global'` to a concrete agent id once
   * the offered agent appears, so a per-target check would miss the earlier
   * global copy and duplicate the schedule on re-apply. `shapeOrigin` comes from
   * the write receipt; agent-bound schedules skip the lookup — re-bind never
   * considers them.
   *
   * @returns Every existing schedule's name, binding, enabled state, and origin.
   */
  async listSchedules(): Promise<ExistingSchedule[]> {
    await this.ensureAdopted();
    return Promise.all(
      this.deps.taskStore.getTasks().map(async (t) => ({
        name: t.name,
        agentId: t.agentId ?? null,
        enabled: t.enabled,
        shapeOrigin: t.agentId ? null : await this.ownerOf(t.filePath),
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
   * ordinary overwrite — the receipt is what says the directory is its own.
   *
   * A successful write is recorded in the receipt, and that recording is the
   * whole basis of every later ownership decision about the directory.
   *
   * @param req - The task-creation request built from a Shape schedule.
   * @param origin - The Shape standing this schedule up: recorded in the receipt
   *   and stamped into the file's frontmatter as a human-readable label.
   * @returns Whether the schedule now exists, and when it does not, why. A
   *   refusal means nothing was written — the caller must not then delete
   *   anything on the strength of it (see {@link rebindSchedule}).
   */
  async createSchedule(
    req: CreateTaskRequest,
    origin?: ScheduleOrigin
  ): Promise<ScheduleWriteOutcome> {
    await this.ensureAdopted();
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
    const refusal = await this.claimTarget(skillsDir, slug, origin);
    if (refusal) return { created: false, ...refusal };

    const filePath = await writeSkillFile(skillsDir, slug, frontmatter, req.prompt);
    // The REAL directory, because that is what the watcher reading this same
    // file moments from now will key its row on — and what the receipt has to
    // name, so an entry written here is found by a lookup made from a row.
    const resolvedDir = path.join(await resolveRootPath(skillsDir), slug);
    if (origin) await this.receipts.record(resolvedDir, origin.shape);

    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
    const discovered = parsed.ok
      ? readScheduleFromSkill(parsed.definition, {
          scope: projectPath ? 'project' : 'global',
          projectPath,
          resolvedPath: path.join(resolvedDir, SKILL_FILENAME),
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
    return { created: true };
  }

  /**
   * Whether `<skillsDir>/<slug>/` is this Shape's to write into — `null` to go
   * ahead, or the reason it was refused.
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
   * Four answers:
   *
   * - **Nothing there** — free.
   * - **This Shape's own schedule** — free, and an ordinary re-apply. Decided by
   *   the write receipt, which records the directories this Shape's applies
   *   actually wrote. Not by the file's own frontmatter: a copy of a Shape's
   *   schedule carries the same marker, and a person's adaptation of one is not
   *   the Shape's to overwrite (DOR-1524).
   * - **An empty directory** — refused, because DorkOS did not put it there and
   *   an empty directory in a skills root is somebody's half-finished skill as
   *   often as it is nothing. It used to be refused in a log line alone, which
   *   left the apply looking like it had worked; the reason now reaches the
   *   person as a warning naming the folder, so clearing it is a ten-second job
   *   rather than a mystery.
   * - **Anything else** — refused, and said out loud. A symlink is refused
   *   FIRST and unconditionally, receipt or no receipt: a `pkg__name` link is how
   *   Harness Sync projects an installed package's skill, and writing through it
   *   edits the package's own checkout — shared by every agent that installed it,
   *   invisible in the cockpit, and gone at the next update.
   *
   * Refusing rather than renaming aside is deliberate. A suffixed schedule keeps
   * the arrangement alive at a name the Shape does not know, so the next apply
   * finds nothing by that name and stands up a second one; and a person who
   * named a skill has a claim on that name that a package does not get to
   * out-vote. The Shape is simply short one schedule, and the person is told
   * which one and what is in its way.
   *
   * @param skillsDir - The skills root the schedule would be written into.
   * @param slug - Its name (also the directory name).
   * @param origin - The Shape asking, when one is.
   * @returns `null` to go ahead, or why the write was refused.
   */
  private async claimTarget(
    skillsDir: string,
    slug: string,
    origin?: ScheduleOrigin
  ): Promise<ScheduleWriteRefusal | null> {
    const targetDir = path.join(skillsDir, slug);
    let stat;
    try {
      stat = await fs.lstat(targetDir);
    } catch {
      return null; // Nothing there.
    }

    if (stat.isSymbolicLink()) {
      this.deps.logger.warn(
        `[shape-schedule] Refusing to write '${slug}' — ${targetDir} is a link to a skill DorkOS ` +
          `does not own (an installed package's, most likely)`
      );
      return { reason: 'symlink', targetDir };
    }

    const owner = await this.receipts.ownerOf(targetDir);
    if (origin && owner === origin.shape) return null;

    if (!owner && stat.isDirectory() && (await isEmptyDir(targetDir))) {
      this.deps.logger.warn(
        `[shape-schedule] Refusing to write '${slug}' — ${targetDir} is an empty directory no ` +
          `Shape created`
      );
      return { reason: 'empty-directory', targetDir };
    }

    this.deps.logger.warn(
      `[shape-schedule] Refusing to write '${slug}' — ${targetDir} already holds a skill this ` +
        `Shape did not create${owner ? ` (it belongs to '${owner}')` : ''}`
    );
    return { reason: 'occupied', targetDir };
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
   * explicit user disable), is not in the write receipt (defense in depth: a
   * user's colliding schedule is never hijacked, even if a caller skipped its
   * own gate), or the agent has no resolvable project path.
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
    await this.ensureAdopted();
    const existing = this.deps.taskStore.getTasks().find((t) => t.name === name);
    // Nothing to move, or the schedule already found its home — respect it.
    if (!existing || existing.agentId) return;

    // Ownership guard: only a schedule a Shape's apply actually wrote is re-homed.
    const shapeOrigin = await this.ownerOf(existing.filePath);
    if (!shapeOrigin) {
      this.deps.logger.warn(
        `[shape-schedule] Refusing to re-bind '${name}' — no Shape wrote it (user-created?)`
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
    // The write is receipted at its new path, so ownership travels with the
    // schedule — it stays this Shape's in its new home.
    const outcome = await this.createSchedule(
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
    // skills root already held something at that name, nothing was written —
    // and tearing the global copy down anyway would delete the only copy there
    // is.
    if (!outcome.created) {
      this.deps.logger.warn(
        `[shape-schedule] Left '${name}' where it is — the agent's skills root already has ` +
          `something at that name (${outcome.reason})`
      );
      return;
    }

    // Remove the old global copy (file + row + any scheduler registration) so
    // the schedule is not duplicated across scopes.
    await this.teardownSchedule(existing);
  }

  /**
   * Delete every schedule a given Shape's applies actually wrote, across both
   * global and agent-bound scopes — the teardown that keeps a Shape's schedules
   * from outliving the Shape. Ownership comes from the write receipt, looked up
   * per schedule directory (agent-bound schedules were moved into their agent's
   * root by {@link rebindSchedule}, so a scope-blind scan is required), and
   * fails closed: a directory the receipt does not name is left alone. That is
   * what makes a person's own copy of a Shape's schedule safe — the copy carries
   * the same frontmatter marker, but no Shape ever wrote it (DOR-1524).
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
    await this.ensureAdopted();
    const deleted: string[] = [];
    for (const task of this.deps.taskStore.getTasks()) {
      if (keepNames?.has(task.name)) continue;
      // Ownership guard: only a directory this exact Shape wrote is removed.
      const origin = await this.ownerOf(task.filePath);
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
    // Through the SAME seam the tasks route and the `tasks_delete` MCP tool use,
    // so a schedule directory is removed — and dropped from the write receipt —
    // in exactly one place. A Shape teardown with its own copy of that logic was
    // how the two other delete paths came to leave stale claims behind
    // (DOR-1524 review).
    await removeScheduledTaskFile(task.filePath);
  }

  /**
   * The Shape whose apply wrote a schedule's directory, from the write receipt.
   * Fail-closed: no receipt entry (and a schedule with no file at all) answers
   * `null`, which every caller reads as "not a Shape's — do not touch".
   *
   * @param filePath - The schedule's SKILL.md path, when it has one.
   * @returns The owning Shape's name, or `null`.
   */
  private async ownerOf(filePath: string | null | undefined): Promise<string | null> {
    if (!filePath) return null;
    return this.receipts.ownerOf(path.dirname(filePath));
  }

  /**
   * Bring an install that predates the write receipt under it, once.
   *
   * The receipt did not exist before DOR-1524, so an install upgrading into it
   * has Shape schedules on disk that nothing has written down. Their frontmatter
   * markers are the only evidence there is, and they are exactly the evidence
   * the old code acted on — so they seed the receipt, and from that moment on no
   * marker is ever consulted again. See
   * {@link ShapeScheduleReceipts.adoptOnce}.
   */
  private async ensureAdopted(): Promise<void> {
    await this.receipts.adoptOnce(async () => {
      const owned: { dir: string; shape: string }[] = [];
      for (const task of this.deps.taskStore.getTasks()) {
        if (!task.filePath) continue;
        const shape = await readLegacyShapeMarker(task.filePath);
        if (shape) owned.push({ dir: path.dirname(task.filePath), shape });
      }
      return owned;
    });
  }
}

/** Whether a directory holds nothing at all (an unreadable one counts as not empty). */
async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

/**
 * Read the Shape provenance marker from a schedule's SKILL.md — the pre-receipt
 * notion of ownership, kept for the one-time adoption in
 * {@link ShapeScheduleService.ensureAdopted} and used nowhere else. Fail-closed:
 * any read/parse failure or missing marker returns `null`.
 *
 * @param filePath - The schedule's SKILL.md path.
 * @returns The Shape named by the marker, or `null` when unmarked/unreadable.
 */
async function readLegacyShapeMarker(filePath: string): Promise<string | null> {
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
