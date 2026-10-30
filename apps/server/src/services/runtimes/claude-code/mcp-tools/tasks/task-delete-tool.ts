/**
 * The `tasks_delete` handler, shared by both MCP servers through
 * `getTasksTools` in `task-tools.ts`, which registers it beside the other
 * `tasks_*` handlers. It lives in its own file only to keep `task-tools.ts`
 * under the line limit; the guard reasoning there applies here unchanged.
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/task-delete-tool
 */
import type { McpToolDeps } from '../types.js';
import { jsonContent, requireTasks } from '../types.js';
import {
  agentDeleteRefusal,
  removeScheduledTaskFile,
} from '../../../../tasks/lifecycle/delete-task.js';
import { broadcastTasksChanged } from '../../../../tasks/task-sse-events.js';
import { resolveParkedScheduleRemoved } from '../../../../notifications/emitters/schedule-park.js';

/**
 * Delete a schedule — its SKILL.md first, then its row.
 *
 * **The file half is not optional, and leaving it out was a lie-on-success**
 * (DOR-1568). This handler deleted the row alone and answered `{success: true}`;
 * the reconciler re-reads every skills root every five minutes and upserts what it
 * finds, so the task came back — new id, `status: 'active'` — minutes after the
 * agent had been told it was gone. `DELETE /api/tasks/:id` always removed the
 * file, and now both doors do it through the same seam.
 */
export function createDeleteScheduleHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireTasks(deps);
    if (err) return err;
    // Read BEFORE deleting: a schedule that was waiting on the operator has a
    // standing condition (and possibly an armed escalation) to end, and once the
    // row is gone there is nothing left to tell that from an ordinary task — and
    // the row is also the only place the file's path is recorded.
    const existing = deps.taskStore!.getTask(args.id);
    const agentDir = existing?.agentId ? deps.meshCore?.getProjectPath(existing.agentId) : null;
    const refusal = await agentDeleteRefusal(existing, agentDir);
    if (refusal) return jsonContent({ error: refusal }, true);
    await removeScheduledTaskFile(existing?.filePath ?? null, agentDir);
    const deleted = deps.taskStore!.deleteTask(args.id);
    if (!deleted) return jsonContent({ error: `Schedule ${args.id} not found` }, true);
    // With no row left to read, `syncTask` unregisters — which is the whole
    // point here: a deleted schedule whose job kept firing is worse than a
    // stale one, because the run it tries to record belongs to a schedule that
    // no longer exists (DOR-1493).
    deps.resolveTaskRegistrar?.()?.syncTask(args.id);
    resolveParkedScheduleRemoved(existing);
    broadcastTasksChanged();
    return jsonContent({ success: true, id: args.id });
  };
}
