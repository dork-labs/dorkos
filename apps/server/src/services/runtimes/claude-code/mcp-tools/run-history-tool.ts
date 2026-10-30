/**
 * `tasks_get_run_history`, apart from the other Tasks tools because a run's output is a tool read
 * (DOR-3291), and the guard every Tasks tool shares.
 *
 * @module services/runtimes/claude-code/mcp-tools/run-history-tool
 */
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import type { TaskProvenanceResolver } from './task-tools.js';
import { markToolRead } from '../../../core/turn-power/tool-read-marks.js';

/**
 * Guard that returns an error response when Tasks is disabled.
 *
 * @param deps - The tool dependencies.
 */
export function requireTasks(deps: McpToolDeps) {
  if (!deps.taskStore) {
    return jsonContent({ error: 'Scheduled tasks are turned off on this DorkOS' }, true);
  }
  return null;
}

/**
 * Get recent runs for a schedule.
 *
 * A run's output is whatever that run read and said, an email or a web page included, so the
 * calling turn is marked before the rows reach it (DOR-3291; Security, 2026-10-29). The external
 * server names no session, so it names the calling agent, whose session-less calls are then marked
 * for a while; a caller with no identity is read as an outsider already.
 *
 * @param deps - The tool dependencies.
 * @param resolveProvenance - The calling session and agent the read is marked on.
 */
export function createGetRunHistoryHandler(
  deps: McpToolDeps,
  resolveProvenance?: TaskProvenanceResolver
) {
  return async (args: { schedule_id: string; limit?: number }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const runs = deps.taskStore!.listRuns({
      taskId: args.schedule_id,
      limit: args.limit ?? 20,
    });
    if (runs.length > 0) {
      const caller = resolveProvenance?.() ?? {};
      markToolRead({
        ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
        ...(caller.agentPath ? { agentPath: caller.agentPath } : {}),
      });
    }
    return jsonContent({ runs, count: runs.length });
  };
}
