/**
 * Editing a scheduled task: the SKILL.md half, which every update door owes.
 *
 * ## Why this is a service and not a paragraph of one route handler
 *
 * A scheduled task is a SKILL.md on disk with a derived row in SQLite. The file
 * is the source of truth and the row is a cache the watcher and the reconciler
 * rebuild from it, so an update that writes the ROW ALONE is not an update — it
 * is a change with a five-minute fuse on it. The reconciler re-reads every
 * skills root every five minutes and upserts what it finds, so the untouched
 * file puts the old values straight back.
 *
 * `PATCH /api/tasks/:id` had that sequence right. `tasks_update` — the MCP tool,
 * on BOTH servers — wrote the row and nothing else, so every field an agent
 * changed through it (`prompt`, `cron`, `name`, `timezone`, and the
 * runtime/model/effort trio) was silently reverted on the next sweep, after the
 * agent had been told the change landed (DOR-1625). Two doors onto one invariant
 * is one door too many, so the sequence lives here and both doors call it.
 *
 * What stays with each caller is only what genuinely differs: how it establishes
 * trust, how it clamps power, what it broadcasts, and how it shapes its reply.
 *
 * @module services/tasks/lifecycle/update-task-file
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Task, UpdateTaskRequest } from '@dorkos/shared/schemas';
import type { MeshCore } from '@dorkos/mesh';
import { writeSkillFile } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import {
  describeArmBlocker,
  isPackageOwned,
  planTaskFileUpdate,
  pluginRoots,
  touchesFile,
} from '../task-file-update.js';
import { logger } from '../../../lib/logger.js';

/** The collaborators a file rewrite needs. */
export interface TaskFileUpdateDeps {
  /** The resolved data directory, which anchors the global plugin root. */
  dorkHome: string;
  /** Resolves an agent id to its project path. Absent when Mesh is disabled. */
  meshCore?: MeshCore;
}

/** A rewrite that did not happen, and what to tell the caller. */
export interface TaskFileUpdateRefusal {
  ok: false;
  /** The HTTP status this maps to. MCP callers only use it to pick their wording. */
  status: 409 | 500;
  /** One line, written for whoever reads it. */
  error: string;
  /** A machine-readable code, on the refusals that carry one. */
  code?: string;
}

/** A rewrite that happened, or that correctly had nothing to do. */
export interface TaskFileUpdateSuccess {
  ok: true;
  /**
   * Whether this request changes anything that lives in the SKILL.md.
   *
   * Returned rather than recomputed by the caller because `PATCH /api/tasks/:id`
   * needs the same answer twice more after the write — to re-assert the status a
   * watcher event may have parked, and to decide whether a person's own edit
   * re-approves the schedule — and asking twice would let the two uses disagree.
   */
  changesFile: boolean;
}

/** The outcome of a file rewrite. */
export type TaskFileUpdateOutcome = TaskFileUpdateSuccess | TaskFileUpdateRefusal;

/** Why the disk refused, reduced to a sentence a person can read. */
function diskReason(err: unknown): string {
  return err instanceof Error ? err.message : 'the disk gave no reason';
}

/**
 * What a caller is told when a task's SKILL.md could not be read, understood,
 * or written.
 *
 * Written for a person, because these are the failures that a person has to go
 * and fix outside DorkOS: a read-only disk, a full one, a file owned by someone
 * else, a settings block someone hand-edited into nonsense. It names the file,
 * says plainly that nothing changed, and carries the underlying reason rather
 * than hiding it.
 *
 * The `parse` case matters most, and is the one added last (DOR-1481 review).
 * Any task still carrying the `max-runtime: null` corruption has an unreadable
 * file on disk right now, and the update path used to fall straight past it to
 * the row and answer 200 — so the corruption had no symptom at all. Now it has a
 * legible one that says which file to open.
 *
 * @param what - Which step failed: loading the file, understanding it, or writing it.
 * @param filePath - The SKILL.md being worked on.
 * @param reason - The underlying failure, already reduced to a sentence.
 * @returns One line for the caller's `error`.
 */
function describeTaskFileFailure(
  what: 'read' | 'parse' | 'save',
  filePath: string,
  reason: string
): string {
  const verb = { read: 'read', parse: 'make sense of', save: 'save' }[what];
  const advice = {
    read: 'Check who is allowed to open that file',
    parse:
      'Open that file and fix the settings block at the top — a setting written as `null` is the usual cause',
    save: 'Check who is allowed to write to that file and how much space is left on the disk',
  }[what];
  return (
    `DorkOS could not ${verb} this task's file at ${filePath}, so nothing was changed: ` +
    `${reason}. ${advice}, then try again.`
  );
}

/**
 * Merge an update into a task's SKILL.md, once the file has been read.
 *
 * Split out from {@link applyTaskFileUpdate} only to keep each half readable;
 * every gate here refuses BEFORE anything is written, so a caller is never told
 * a change landed when part of it did not.
 *
 * @param deps - Data directory and Mesh.
 * @param existing - The task as it stands, whose `filePath` is being rewritten.
 * @param content - The file's current bytes.
 * @param data - The fields the request carries.
 * @returns Nothing on success, or the refusal to report.
 */
async function rewriteTaskFile(
  deps: TaskFileUpdateDeps,
  existing: Task,
  content: string,
  data: UpdateTaskRequest
): Promise<TaskFileUpdateRefusal | null> {
  // A file the skill schema cannot read is the silent-success defect DOR-1481
  // closed: the update used to skip the write, change the row, and report
  // success. It refuses.
  const parsed = parseSkillFile(existing.filePath, content, SkillFrontmatterSchema);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 500,
      error: describeTaskFileFailure('parse', existing.filePath, parsed.error),
    };
  }

  // A skill an installed package owns is never ours to rewrite: the edit would
  // land in `.dork/plugins/`, be shared by every agent that installed the
  // package, and vanish at the next update.
  const owningProject = existing.agentId ? deps.meshCore?.getProjectPath(existing.agentId) : null;
  if (
    await isPackageOwned(existing.filePath, pluginRoots(deps.dorkHome, owningProject ?? undefined))
  ) {
    return {
      ok: false,
      status: 409,
      error:
        `This schedule belongs to an installed package, so DorkOS did not change its file. ` +
        `You can switch it on or off here; to change what it does, edit the package or make ` +
        `your own copy of the skill.`,
      code: 'schedule_package_owned',
    };
  }

  const plan = planTaskFileUpdate(existing.filePath, content, data, data.prompt);
  if (plan.kind === 'refuse') {
    return { ok: false, status: 409, error: plan.message, code: 'schedule_file_unreadable' };
  }

  const dirPath = path.dirname(existing.filePath);
  try {
    await writeSkillFile(
      path.dirname(dirPath),
      path.basename(dirPath),
      plan.frontmatter,
      plan.body
    );
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: describeTaskFileFailure('save', existing.filePath, diskReason(err)),
    };
  }
  return null;
}

/**
 * Write a task update into its SKILL.md, or refuse to touch the file.
 *
 * **The file goes first, and a failure here must end the caller's request.**
 * This used to be one `try {} catch {}` around the read AND the write, for
 * legacy DB-only tasks. It was — and it also swallowed `EACCES`, `ENOSPC` and
 * `EROFS` from the write, after which the row was updated anyway and the caller
 * got a success. Five minutes later the reconciler read the untouched file and
 * put the old values back, so the edit simply vanished with nothing anywhere
 * saying why. The only error that means "there is no file, edit the row alone"
 * is `ENOENT` on the read; every other one is a real failure and is reported as
 * one.
 *
 * **A request that changes nothing in the file does not open the file.**
 * `touchesFile` is what makes that true, and it is load-bearing rather than an
 * optimisation: approving a parked schedule sends `status` alone, and before
 * DOR-1485's review every Approve dragged the person's own SKILL.md through a
 * read-merge-write it had no reason to touch — which is how a click on Approve
 * could erase the file's `schedule:` block.
 *
 * @param deps - Data directory and Mesh.
 * @param options - The task as it stands and the fields the request carries.
 * @returns Whether the file was in scope, or a refusal that wrote nothing.
 */
export async function applyTaskFileUpdate(
  deps: TaskFileUpdateDeps,
  options: { existing: Task; data: UpdateTaskRequest }
): Promise<TaskFileUpdateOutcome> {
  const { existing, data } = options;
  // Arming is the one thing a person can ask for that the FILE can refuse, so it
  // opens the file even when nothing in the file changes.
  const arming = data.status === 'active' && existing.status === 'pending_approval';
  const changesFile = touchesFile(data, existing);
  if (!existing.filePath || !(changesFile || arming)) return { ok: true, changesFile };

  // No initializer: every catch path returns, so a value here could never be
  // read - and ESLint 10's no-useless-assignment now says so.
  let content: string;
  try {
    content = await fs.readFile(existing.filePath, 'utf-8');
  } catch (err) {
    // A legacy DB-only task: a row whose file was never written, or was deleted
    // outside DorkOS. Fall through and let the caller update the row alone.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        status: 500,
        error: describeTaskFileFailure('read', existing.filePath, diskReason(err)),
      };
    }
    // Said out loud, because this branch is the DOR-1625 bug reinstated for one
    // task: the row changes and no file records it. That is right for a task
    // whose file is genuinely gone, and wrong for one whose file is missing for
    // a moment — an unmounted volume, a checkout mid-`git`, a syncing folder —
    // where the file comes back holding the OLD values and the next sweep undoes
    // the edit with nothing anywhere saying why. One line naming the path is what
    // makes that diagnosable instead of mysterious.
    logger.warn('[tasks] updated the row alone: no file at this path', {
      taskId: existing.id,
      filePath: existing.filePath,
    });
    return { ok: true, changesFile };
  }

  // A schedule whose block or cron DorkOS cannot read has nothing to run on, so
  // approving it would produce a row that says `active` and never fires, with
  // the complaint that explained why now gone from the card. Say what is wrong
  // instead, and leave the schedule parked where they can see it.
  if (arming) {
    const blocker = describeArmBlocker(existing.filePath, content);
    if (blocker) {
      return {
        ok: false,
        status: 409,
        error:
          `This schedule cannot be switched on yet: ${blocker} ` +
          `Fix it in ${existing.filePath} and DorkOS will pick the change up on its own.`,
        code: 'schedule_file_unreadable',
      };
    }
  }

  if (!changesFile) return { ok: true, changesFile };

  const refusal = await rewriteTaskFile(deps, existing, content, data);
  return refusal ?? { ok: true, changesFile };
}
