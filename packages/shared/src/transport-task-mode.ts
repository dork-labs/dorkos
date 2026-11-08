/**
 * Putting back the mode one of our agents set on a running schedule without
 * asking (DOR-3703): the Undo on the notice DorkOS posts for it. A slice of
 * the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-task-mode
 */
import type { Task } from './types.js';

/** Undo an agent's mode change on a scheduled task. */
export interface TaskModeUndoTransport {
  /**
   * Put back exactly what the agent's change a notice named replaced: its
   * mode, its prompt, or both (`POST /api/tasks/:id/undo-agent-mode`). A
   * person's action only: the server refuses any agent. Refused with
   * `nothing_to_undo`, and a sentence saying what the task runs as now, once
   * the task changed since the notice.
   *
   * @param taskId - The schedule.
   * @param notificationId - The notice whose Undo this is.
   */
  undoAgentTaskMode(taskId: string, notificationId: string): Promise<Task>;
  /**
   * Approve a task's SKILL file as it is now, lifting the cap a change outside
   * the task tools put on its runs (`POST /api/tasks/:id/approve-file`, M4). A
   * person's action only. Refused with `file_changed_since` once the file
   * changed since the diff the person saw.
   *
   * @param taskId - The schedule.
   * @param capAt - When the cap the person saw first held (`Task.fileCap.at`).
   * @param hash - The file hash the diff they approved showed (`Task.fileCap.hash`).
   */
  approveTaskFile(taskId: string, capAt: string, hash: string): Promise<Task>;
}
