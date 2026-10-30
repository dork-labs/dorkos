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
import { getTasksTools } from '../../runtimes/claude-code/mcp-tools/tasks/task-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import { marksOf } from '../turn-power/turn-levels.js';
import type { TurnMarks } from '../turn-power/turn-marks.js';
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
 * @param identity - The calling agent, when the request carried a resolved identity token.
 */
export function registerTaskTools(
  registrar: ToolRegistrar,
  deps: McpToolDeps,
  identity?: AgentIdentity
): void {
  registerFromDefinitions(
    registrar,
    getTasksTools(deps, undefined, () => externalCallerMarks(identity)),
    TASKS_EXTERNAL_CONFIGS
  );
}

/**
 * The marks of an external caller's turn (DOR-3036): this server names no session, so an agent is
 * read through its agent (any marked turn of it running now), and a caller DorkOS cannot identify
 * carries the outsider mark, since nothing vouches for it. Its schedule parks either way.
 *
 * @param identity - The calling agent, when the request carried a resolved identity token.
 */
function externalCallerMarks(identity: AgentIdentity | undefined): TurnMarks {
  return identity ? marksOf(undefined, identity.agentPath) : { outsider: true };
}
