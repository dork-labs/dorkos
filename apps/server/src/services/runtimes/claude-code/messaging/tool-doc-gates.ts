/**
 * Which switchable tool-doc blocks an agent's Claude Code prompt carries, from
 * the permission areas that are Blocked for it (spec `agent-permissions` D15).
 *
 * Its own module rather than a helper inside `context-builder.ts` so the launch
 * path can compute it without reaching into the prompt builder, which most
 * runtime tests replace wholesale.
 *
 * @module services/runtimes/claude-code/messaging/tool-doc-gates
 */
import type { PermissionAreaId } from '@dorkos/shared/permissions';

import { isRelayEnabled } from '../../../relay/relay-state.js';
import { isTasksEnabled } from '../../../tasks/task-state.js';

/**
 * Which of the switchable tool-doc blocks this agent is given.
 *
 * A block is left out when its server feature is off, or when the permission
 * area its tools live in is Blocked for this agent (spec `agent-permissions`
 * D15): the tools themselves are already left out of its tool list, so telling
 * the agent about them would describe tools it does not have. This replaced the
 * `agentContext.*Tools` switches, which only ever left the docs out and never
 * the tools (ADR 260726-171347, superseded).
 */
export interface ToolDocGates {
  /** `<tasks_tools>`: Tasks is on, and the Tasks & schedules area is not Blocked. */
  tasks: boolean;
  /** `<relay_tools>`: Relay is on, and Messages is not Blocked. */
  relay: boolean;
  /** `<mesh_tools>`: Other agents is not Blocked (Mesh is always on). */
  mesh: boolean;
  /** `<adapter_tools>` and `<relay_connections>`: Relay is on, and Chat connections is not Blocked. */
  adapter: boolean;
  /** `<marketplace_tools>`: Tools & packages is not Blocked. */
  packages: boolean;
}

/**
 * The tool-doc gates for an agent, from the areas that are Blocked for it.
 *
 * @param blockedAreas - The Blocked areas, from `resolveToolVisibility`.
 * @returns Which blocks this agent is given.
 */
export function toolDocGates(blockedAreas: readonly PermissionAreaId[]): ToolDocGates {
  const blocked = new Set(blockedAreas);
  return {
    tasks: isTasksEnabled() && !blocked.has('tasks'),
    relay: isRelayEnabled() && !blocked.has('messages'),
    mesh: !blocked.has('agents'),
    adapter: isRelayEnabled() && !blocked.has('connections'),
    packages: !blocked.has('packages'),
  };
}
