/**
 * Unmaking a scheduled task: the file half, which is the half that decides.
 *
 * @module services/tasks/lifecycle/delete-task
 */
import path from 'node:path';
import { deleteSkillDir } from '@dorkos/skills/writer';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { shapeScheduleReceipts } from '../../shapes/schedule-write-receipt.js';
import { isPackageOwned, packageOwnershipContext } from '../task-file-update.js';

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
