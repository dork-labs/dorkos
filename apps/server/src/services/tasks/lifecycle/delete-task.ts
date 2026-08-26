/**
 * Unmaking a scheduled task: the file half, which is the half that decides.
 *
 * @module services/tasks/lifecycle/delete-task
 */
import path from 'node:path';
import { deleteSkillDir } from '@dorkos/skills/writer';

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
 * Failure is swallowed on purpose: the file may already be gone, and a row that
 * outlives its file is the ordinary orphan case the reconciler cleans up.
 *
 * @param filePath - The task's `filePath`, empty for a legacy row-only task.
 */
export async function removeScheduledTaskFile(filePath: string | null): Promise<void> {
  if (!filePath) return;
  try {
    const dirPath = path.dirname(filePath);
    await deleteSkillDir(path.dirname(dirPath), path.basename(dirPath));
  } catch {
    // Already gone, or not ours to remove — the row delete stands either way.
  }
}
