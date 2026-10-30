/**
 * Unmaking a scheduled task: the file half, which is the half that decides.
 *
 * @module services/tasks/lifecycle/delete-task
 */
import path from 'node:path';
import type { MeshCore } from '@dorkos/mesh';
import type { Task } from '@dorkos/shared/schemas';
import { deleteSkillDir } from '@dorkos/skills/writer';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { shapeScheduleReceipts } from '../../shapes/schedule-write-receipt.js';
import { isPackageOwned, packageOwnershipContext } from '../task-file-update.js';
import type { TaskStore } from '../task-store.js';

/**
 * Why one project's copy of a global `scope: project` schedule cannot be
 * deleted (DOR-3376): its file is shared by every project's copy, so removing
 * it would take the schedule from all of them, and removing the row alone
 * would only bring it back, switched off, at the next sync.
 */
export const PROJECT_COPY_DELETE_REFUSAL =
  "This schedule comes from a package every project shares, so it can't be deleted for one " +
  'project. Switch it off here instead.';

/**
 * Why an agent cannot delete a schedule an installed package owns (DOR-2097):
 * the file is part of the package, and its next update would bring it back.
 */
export const PACKAGE_SCHEDULE_DELETE_REFUSAL =
  "This schedule came with an installed package, so it can't be deleted. " +
  'Switch it off here instead.';

/**
 * Whether a task's file belongs to an installed package, and so is not ours to
 * remove. The same answer the update door gets (`update-task-file.ts`).
 *
 * @param filePath - The task's `filePath`, empty for a legacy row-only task.
 * @param agentDir - The owning agent's directory, when mesh names one.
 * @returns True when the file came with an installed package.
 */
export async function isPackageOwnedTaskFile(
  filePath: string | null,
  agentDir?: string | null
): Promise<boolean> {
  if (!filePath) return false;
  return isPackageOwned(
    filePath,
    packageOwnershipContext(resolveDorkHome(), agentDir ?? undefined)
  );
}

/**
 * Why an agent may not delete this schedule, or `null` when it may.
 *
 * @param task - The schedule, when it exists.
 * @param agentDir - The owning agent's directory, when mesh names one.
 * @returns One line for the agent, or `null`.
 */
export async function agentDeleteRefusal(
  task: Pick<Task, 'projectOnly' | 'filePath'> | null | undefined,
  agentDir?: string | null
): Promise<string | null> {
  if (task?.projectOnly) return PROJECT_COPY_DELETE_REFUSAL;
  // Declining a package's schedule is a person's answer (DOR-2097).
  if (await isPackageOwnedTaskFile(task?.filePath ?? null, agentDir)) {
    return PACKAGE_SCHEDULE_DELETE_REFUSAL;
  }
  return null;
}

/**
 * What a person's delete does to a schedule: the row and file go, unless an
 * installed package owns the file (DOR-2097). Removing that would break the
 * package, so the answer is kept on the row and the file is not touched.
 *
 * The file goes before the row: a row deleted while its SKILL.md remains is
 * brought straight back by the next reconcile.
 *
 * @param task - The schedule.
 * @param store - The task store.
 * @param meshCore - Resolves its agent's directory; absent when Mesh is off.
 * @returns Which of the two happened.
 */
export async function deleteOrDeclineTask(
  task: Pick<Task, 'id' | 'agentId' | 'filePath'>,
  store: Pick<TaskStore, 'approvals' | 'deleteTask'>,
  meshCore?: Pick<MeshCore, 'getProjectPath'>
): Promise<'declined' | 'deleted'> {
  const agentDir = task.agentId ? meshCore?.getProjectPath(task.agentId) : null;
  if (await isPackageOwnedTaskFile(task.filePath, agentDir)) {
    store.approvals.recordDecline(task.id);
    return 'declined';
  }
  await removeScheduledTaskFile(task.filePath, agentDir);
  store.deleteTask(task.id);
  return 'deleted';
}

/**
 * Remove a task's SKILL.md directory, if it has one.
 *
 * **Deleting the row alone does not delete a task**, and that is the whole reason
 * this is exported rather than inlined at one call site. The file is the source of
 * truth: the reconciler re-reads every skills root every five minutes and upserts
 * whatever it finds, so a row deleted while its file remains comes straight back —
 * with a new id, at `active`, having told the caller it was gone. `tasks_delete`
 * on both MCP servers did exactly that until DOR-1568.
 *
 * It is also the ONE place a schedule directory is removed — the tasks route,
 * the `tasks_delete` MCP tool, and the Shape teardown all come through here —
 * which is why dropping the Shape write receipt lives here too rather than at
 * each caller. A directory a Shape wrote stays claimed by that Shape until the
 * receipt says otherwise, so a delete that skipped this step would let the next
 * re-apply overwrite whatever the person put at that freed name (DOR-1524). Any
 * future deleter that does not come through here reopens that hole.
 *
 * Order matters: the receipt is keyed on the RESOLVED directory, and a path that
 * no longer exists cannot be resolved, so the entry goes before the directory
 * does.
 *
 * Failure of the file delete is swallowed on purpose: the file may already be
 * gone, and a row that outlives its file is the ordinary orphan case the
 * reconciler cleans up. Failure of the receipt write is NOT swallowed quietly —
 * it leaves a claim on a directory being handed back to the person — but it does
 * not stop the delete either, because refusing to delete a task because of
 * bookkeeping would be the worse answer.
 *
 * A file an installed package owns is refused here, before anything is touched,
 * so no caller can reach the `rm` (DOR-2097): that directory is the package's own
 * skill folder, and removing it breaks the package.
 *
 * @param filePath - The task's `filePath`, empty for a legacy row-only task.
 * @param agentDir - The owning agent's directory, when mesh names one. Without it,
 *   only installs under the data directory are recognised.
 */
export async function removeScheduledTaskFile(
  filePath: string | null,
  agentDir?: string | null
): Promise<void> {
  if (!filePath) return;
  if (await isPackageOwnedTaskFile(filePath, agentDir)) {
    logger.warn(`[tasks] Left ${filePath} in place: it belongs to an installed package.`);
    return;
  }
  const dirPath = path.dirname(filePath);
  try {
    await shapeScheduleReceipts(resolveDorkHome(), logger).forget(dirPath);
  } catch (err) {
    // Present tense on purpose: the directory is removed BELOW, and that step
    // swallows its own failures — so a past-tense line here would assert a
    // deletion that may not have happened, to the one person reading the log
    // because something is already wrong.
    logger.error(
      `[shape-schedule] Could not drop ${dirPath} from the schedule receipt before removing it. ` +
        `A Shape may overwrite whatever is put at that name next. Remove the entry by hand.`,
      err
    );
  }
  try {
    await deleteSkillDir(path.dirname(dirPath), path.basename(dirPath));
  } catch {
    // Already gone or unreadable: the row delete stands either way.
  }
}
