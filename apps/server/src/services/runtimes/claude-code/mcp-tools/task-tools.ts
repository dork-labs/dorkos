import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Guard that returns an error response when Tasks is disabled. */
function requireTasks(deps: McpToolDeps) {
  if (!deps.taskStore) {
    return jsonContent({ error: 'Tasks scheduler is not enabled' }, true);
  }
  return null;
}

/** List all Tasks scheduled jobs. */
export function createListSchedulesHandler(deps: McpToolDeps) {
  return async (args: { enabled_only?: boolean }) => {
    const err = requireTasks(deps);
    if (err) return err;
    let schedules = deps.taskStore!.getTasks();
    if (args.enabled_only) {
      schedules = schedules.filter((s) => s.enabled);
    }
    return jsonContent({ schedules, count: schedules.length });
  };
}

/** Create a new scheduled job — always sets status to pending_approval. */
export function createCreateScheduleHandler(deps: McpToolDeps) {
  return async (args: {
    name: string;
    prompt: string;
    cron: string;
    description?: string;
    timezone?: string;
    maxRuntime?: string;
    permissionMode?: string;
  }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const schedule = deps.taskStore!.createTask({
      name: args.name,
      description: args.description ?? args.name,
      prompt: args.prompt,
      cron: args.cron,
      timezone: args.timezone ?? null,
      maxRuntime: null,
      filePath: '',
    });
    // Agent-created schedules always require user approval
    deps.taskStore!.updateTask(schedule.id, { status: 'pending_approval' });
    const updated = deps.taskStore!.getTask(schedule.id);
    return jsonContent({
      schedule: updated,
      note: 'Schedule created with pending_approval status. User must approve before it runs.',
    });
  };
}

/** Update an existing schedule. */
export function createUpdateScheduleHandler(deps: McpToolDeps) {
  return async (args: {
    id: string;
    name?: string;
    prompt?: string;
    cron?: string;
    enabled?: boolean;
    timezone?: string;
    maxRuntime?: string;
    permissionMode?: string;
  }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const { id, permissionMode, maxRuntime, ...rest } = args;
    const updated = deps.taskStore!.updateTask(id, {
      ...rest,
      ...(maxRuntime !== undefined && { maxRuntime }),
      ...(permissionMode !== undefined && {
        permissionMode: permissionMode as 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions',
      }),
    });
    if (!updated) return jsonContent({ error: `Schedule ${id} not found` }, true);
    return jsonContent({ schedule: updated });
  };
}

/** Delete a schedule. */
export function createDeleteScheduleHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const deleted = deps.taskStore!.deleteTask(args.id);
    if (!deleted) return jsonContent({ error: `Schedule ${args.id} not found` }, true);
    return jsonContent({ success: true, id: args.id });
  };
}

/** Get recent runs for a schedule. */
export function createGetRunHistoryHandler(deps: McpToolDeps) {
  return async (args: { schedule_id: string; limit?: number }) => {
    const err = requireTasks(deps);
    if (err) return err;
    const runs = deps.taskStore!.listRuns({
      taskId: args.schedule_id,
      limit: args.limit ?? 20,
    });
    return jsonContent({ runs, count: runs.length });
  };
}

/** Returns the Tasks tool definitions for registration with the MCP server. */
export function getTasksTools(deps: McpToolDeps) {
  return [
    tool(
      'tasks_list',
      'List all Tasks scheduled jobs. Returns schedule definitions with status and configuration.',
      { enabled_only: z.boolean().optional().describe('Only return enabled schedules') },
      createListSchedulesHandler(deps)
    ),
    tool(
      'tasks_create',
      'Create a new Tasks scheduled job. The schedule will be created with pending_approval status and must be approved by the user before it runs.',
      {
        name: z.string().describe('Name for the scheduled job'),
        prompt: z.string().describe('The prompt to send to the agent on each run'),
        cron: z.string().describe('Cron expression (e.g., "0 2 * * *" for daily at 2am)'),
        description: z.string().optional().describe('Description of what this task does'),
        timezone: z.string().optional().describe('IANA timezone (e.g., "America/New_York")'),
        maxRuntime: z.string().optional().describe('Maximum run time (e.g., "5m", "1h")'),
        permissionMode: z
          .string()
          .optional()
          .describe('Permission mode: acceptEdits or bypassPermissions'),
      },
      createCreateScheduleHandler(deps)
    ),
    tool(
      'tasks_update',
      'Update an existing Tasks schedule. Only provided fields are updated.',
      {
        id: z.string().describe('Schedule ID to update'),
        name: z.string().optional().describe('New name'),
        prompt: z.string().optional().describe('New prompt'),
        cron: z.string().optional().describe('New cron expression'),
        enabled: z.boolean().optional().describe('Enable or disable the schedule'),
        timezone: z.string().optional().describe('New timezone'),
        maxRuntime: z.string().optional().describe('New max runtime (e.g., "5m", "1h")'),
        permissionMode: z.string().optional().describe('New permission mode'),
      },
      createUpdateScheduleHandler(deps)
    ),
    tool(
      'tasks_delete',
      'Delete a Tasks schedule permanently.',
      { id: z.string().describe('Schedule ID to delete') },
      createDeleteScheduleHandler(deps)
    ),
    tool(
      'tasks_get_run_history',
      'Get recent run history for a Tasks schedule.',
      {
        schedule_id: z.string().describe('Schedule ID to get runs for'),
        limit: z.number().optional().describe('Max runs to return (default 20)'),
      },
      createGetRunHistoryHandler(deps)
    ),
  ];
}
