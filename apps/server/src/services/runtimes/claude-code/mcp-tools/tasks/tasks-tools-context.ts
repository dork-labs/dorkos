/**
 * The `<tasks_tools>` context block, split from `context-builder.ts` when its
 * cross-agent rule started naming what marks a turn (DOR-3858).
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/tasks-tools-context
 */
import { unmarkedTurnClause } from '../../../../core/turn-power/marked-turn-copy.js';
import { IN_SESSION_TOOL_PREFIX as T } from '../tool-exposure.js';

/**
 * The Tasks tool docs, plus the one place an agent is told durable CronCreate
 * is not a scheduler under DorkOS (DOR-2717). The CLI writes a durable job to
 * `.claude/scheduled_tasks.json` and fires it only while a CLI process for the
 * session that owns it is running and idle; a different session will not run
 * it. DorkOS holds a warm process for session-only timers, which the Stop
 * hook's `session_crons` names, but that list is the in-memory store only, so
 * a durable job holds nothing and dies quietly with the next idle reap. Tasks
 * is the scheduler that runs whether or not a chat is open.
 *
 * The cross-agent rule names exactly what marks a turn in this boot
 * (`marked-turn-copy.ts`).
 */
export const TASKS_TOOLS_CONTEXT = `<tasks_tools>
DorkOS Tasks lets you create and manage scheduled agent runs.

Available tools:
  ${T}tasks_list() -- list all configured schedules
  ${T}tasks_create(name, cron, prompt, ...) -- create a new schedule (live at once, or pending_approval when DorkOS asks first)
  ${T}tasks_update(id, ...) -- modify schedule settings
  ${T}tasks_delete(id) -- remove a schedule
  ${T}tasks_get_run_history(scheduleId) -- view past run results

A schedule's target is your own agent id, "global", or another agent's id. Leaving it out or "global" files it under you, in your own folder. Another agent's id works only from a chat at Full autonomy whose turn ${unmarkedTurnClause()};
a schedule you make or change for another agent runs at that agent's own level at most, and records that you made it.

Claude Code's own CronCreate with durable: true is not reliable here: its job fires only
while this chat's Claude Code process is running, and DorkOS ends idle processes. Use
${T}tasks_create for anything that must run on a schedule. Session-only timers
(CronCreate, ScheduleWakeup, /loop) are fine for a reminder later in this chat.
</tasks_tools>`;
