/**
 * Registers the `tasks_*` external MCP tools against a live `McpServer`
 * instance. Split out of `mcp-server.ts` — see `core-tools.ts` in this
 * directory for why.
 *
 * @module services/core/external-mcp/task-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TaskSchema } from '@dorkos/shared/schemas';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import {
  createListSchedulesHandler,
  createCreateScheduleHandler,
  createUpdateScheduleHandler,
  createDeleteScheduleHandler,
  createGetRunHistoryHandler,
} from '../../runtimes/claude-code/mcp-tools/task-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';

const A = ToolAnnotationPresets;

/** `outputSchema` for `tasks_list`. */
const tasksListOutputSchema = {
  schedules: z.array(TaskSchema),
  count: z.number(),
};

/**
 * Register `tasks_list`, `tasks_create`, `tasks_update`, `tasks_delete`, and
 * `tasks_get_run_history` against `server`.
 *
 * @param server - The external `McpServer` instance to register tools against.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerTaskTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'tasks_list',
    {
      description:
        'List all Tasks scheduled jobs. Returns schedule definitions with status and configuration.',
      inputSchema: {
        enabled_only: z.boolean().optional().describe('Only return enabled schedules'),
      },
      annotations: A.readOnlyLocal,
      outputSchema: tasksListOutputSchema,
    },
    createListSchedulesHandler(deps)
  );
  server.registerTool(
    'tasks_create',
    {
      description:
        'Create a new Tasks scheduled job. The schedule will be created with pending_approval status and must be approved by the user before it can run.',
      inputSchema: {
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
      annotations: A.mutateCreateLocal,
    },
    createCreateScheduleHandler(deps)
  );
  server.registerTool(
    'tasks_update',
    {
      description: 'Update an existing Tasks schedule. Only provided fields are updated.',
      inputSchema: {
        id: z.string().describe('Schedule ID to update'),
        name: z.string().optional().describe('New name'),
        prompt: z.string().optional().describe('New prompt'),
        cron: z.string().optional().describe('New cron expression'),
        enabled: z.boolean().optional().describe('Enable or disable the schedule'),
        timezone: z.string().optional().describe('New timezone'),
        maxRuntime: z.string().optional().describe('New max runtime (e.g., "5m", "1h")'),
        permissionMode: z.string().optional().describe('New permission mode'),
      },
      annotations: A.mutateUpdateLocal,
    },
    createUpdateScheduleHandler(deps)
  );
  server.registerTool(
    'tasks_delete',
    {
      description: 'Delete a Tasks schedule permanently.',
      inputSchema: {
        id: z.string().describe('Schedule ID to delete'),
      },
      annotations: A.mutateDeleteLocal,
    },
    createDeleteScheduleHandler(deps)
  );
  server.registerTool(
    'tasks_get_run_history',
    {
      description: 'Get recent run history for a Tasks schedule.',
      inputSchema: {
        schedule_id: z.string().describe('Schedule ID to get runs for'),
        limit: z.number().optional().describe('Max runs to return (default 20)'),
      },
      annotations: A.readOnlyLocal,
    },
    createGetRunHistoryHandler(deps)
  );
}
