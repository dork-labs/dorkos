import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Guard that returns an error response when Pulse is disabled. */
function requirePulse(deps: McpToolDeps) {
  if (!deps.pulseStore) {
    return jsonContent({ error: 'Pulse scheduler is not enabled' }, true);
  }
  return null;
}

/** List all Pulse scheduled jobs. */
export function createListSchedulesHandler(deps: McpToolDeps) {
  return async (args: { enabled_only?: boolean }) => {
    const err = requirePulse(deps);
    if (err) return err;
    let schedules = deps.pulseStore!.getSchedules();
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
    cwd?: string;
    timezone?: string;
    maxRuntime?: number;
    permissionMode?: string;
  }) => {
    const err = requirePulse(deps);
    if (err) return err;
    const schedule = deps.pulseStore!.createSchedule({
      name: args.name,
      prompt: args.prompt,
      cron: args.cron,
      cwd: args.cwd ?? null,
      timezone: args.timezone ?? null,
      maxRuntime: args.maxRuntime ?? null,
    });
    // Agent-created schedules always require user approval
    deps.pulseStore!.updateSchedule(schedule.id, { status: 'pending_approval' });
    const updated = deps.pulseStore!.getSchedule(schedule.id);
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
    maxRuntime?: number;
    permissionMode?: string;
  }) => {
    const err = requirePulse(deps);
    if (err) return err;
    const { id, permissionMode, ...rest } = args;
    const updated = deps.pulseStore!.updateSchedule(id, {
      ...rest,
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
    const err = requirePulse(deps);
    if (err) return err;
    const deleted = deps.pulseStore!.deleteSchedule(args.id);
    if (!deleted) return jsonContent({ error: `Schedule ${args.id} not found` }, true);
    return jsonContent({ success: true, id: args.id });
  };
}

/** Get recent runs for a schedule. */
export function createGetRunHistoryHandler(deps: McpToolDeps) {
  return async (args: { schedule_id: string; limit?: number }) => {
    const err = requirePulse(deps);
    if (err) return err;
    const runs = deps.pulseStore!.listRuns({
      scheduleId: args.schedule_id,
      limit: args.limit ?? 20,
    });
    return jsonContent({ runs, count: runs.length });
  };
}

/** Returns the Pulse tool definitions for registration with the MCP server. */
export function getPulseTools(deps: McpToolDeps) {
  return [
    tool(
      'pulse_list_schedules',
      'List all Pulse scheduled jobs. Returns schedule definitions with status and configuration.',
      { enabled_only: z.boolean().optional().describe('Only return enabled schedules') },
      createListSchedulesHandler(deps)
    ),
    tool(
      'pulse_create_schedule',
      'Create a new Pulse scheduled job. The schedule will be created with pending_approval status and must be approved by the user before it can run.',
      {
        name: z.string().describe('Name for the scheduled job'),
        prompt: z.string().describe('The prompt to send to the agent on each run'),
        cron: z.string().describe('Cron expression (e.g., "0 2 * * *" for daily at 2am)'),
        cwd: z.string().optional().describe('Working directory for the agent'),
        timezone: z.string().optional().describe('IANA timezone (e.g., "America/New_York")'),
        maxRuntime: z.number().optional().describe('Maximum run time in milliseconds'),
        permissionMode: z
          .string()
          .optional()
          .describe('Permission mode: acceptEdits or bypassPermissions'),
      },
      createCreateScheduleHandler(deps)
    ),
    tool(
      'pulse_update_schedule',
      'Update an existing Pulse schedule. Only provided fields are updated.',
      {
        id: z.string().describe('Schedule ID to update'),
        name: z.string().optional().describe('New name'),
        prompt: z.string().optional().describe('New prompt'),
        cron: z.string().optional().describe('New cron expression'),
        enabled: z.boolean().optional().describe('Enable or disable the schedule'),
        timezone: z.string().optional().describe('New timezone'),
        maxRuntime: z.number().optional().describe('New max runtime in ms'),
        permissionMode: z.string().optional().describe('New permission mode'),
      },
      createUpdateScheduleHandler(deps)
    ),
    tool(
      'pulse_delete_schedule',
      'Delete a Pulse schedule permanently.',
      { id: z.string().describe('Schedule ID to delete') },
      createDeleteScheduleHandler(deps)
    ),
    tool(
      'pulse_get_run_history',
      'Get recent run history for a Pulse schedule.',
      {
        schedule_id: z.string().describe('Schedule ID to get runs for'),
        limit: z.number().optional().describe('Max runs to return (default 20)'),
      },
      createGetRunHistoryHandler(deps)
    ),
  ];
}
