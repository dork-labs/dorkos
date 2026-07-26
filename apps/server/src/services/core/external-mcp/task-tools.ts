/**
 * Puts the `tasks_*` tools on the external `/mcp` server.
 *
 * The names, descriptions, and input schemas are NOT written here: they come from
 * `getTasksTools`, the same definitions the in-session server uses, via
 * {@link registerFromDefinitions}. Only the external-only additions live here —
 * see that module for why (DOR-499).
 *
 * @module services/core/external-mcp/task-tools
 */
import { z } from 'zod';
import { TaskSchema } from '@dorkos/shared/schemas';
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { getTasksTools } from '../../runtimes/claude-code/mcp-tools/task-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from './register-from-definitions.js';

const A = ToolAnnotationPresets;

/** `outputSchema` for `tasks_list`. */
const tasksListOutputSchema = {
  schedules: z.array(TaskSchema),
  count: z.number(),
};

/** The external-only additions for each `tasks_*` tool. */
const TASKS_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  tasks_list: { annotations: A.readOnlyLocal, outputSchema: tasksListOutputSchema },
  tasks_create: { annotations: A.mutateCreateLocal },
  tasks_update: { annotations: A.mutateUpdateLocal },
  tasks_delete: { annotations: A.mutateDeleteLocal },
  tasks_get_run_history: { annotations: A.readOnlyLocal },
};

/**
 * Register `tasks_list`, `tasks_create`, `tasks_update`, `tasks_delete`, and
 * `tasks_get_run_history` against `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`, which runs each
 *   tool's permission tier before its handler.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerTaskTools(registrar: ToolRegistrar, deps: McpToolDeps): void {
  registerFromDefinitions(registrar, getTasksTools(deps), TASKS_EXTERNAL_CONFIGS);
}
