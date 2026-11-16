/** Dependencies the shared task-create lifecycle reads from an MCP tool server. */
import type { McpToolDeps } from '../types.js';
import type { TaskLifecycleDeps } from '../../../../tasks/lifecycle/create-task-deps.js';
import { readOperatorTimeZone } from '../../../../core/config/operator-time-zone.js';

/**
 * Select the lifecycle dependencies for one MCP `tasks_create` call.
 *
 * A schedule an agent makes without a zone runs on the person's clock, the
 * same zone the agent's room context reads times in (DOR-4120, DOR-3253).
 *
 * @param deps - The tool server's dependencies.
 * @returns The shared create lifecycle's dependency bag.
 */
export function taskCreateLifecycleDeps(deps: McpToolDeps): TaskLifecycleDeps {
  return {
    store: deps.taskStore!,
    registrar: deps.resolveTaskRegistrar?.() ?? null,
    dorkHome: deps.dorkHome,
    defaultTimezone: readOperatorTimeZone,
    ...(deps.meshCore && { meshCore: deps.meshCore }),
  };
}
