/**
 * The level an agent actually runs at, for its profile's Level row
 * (`GET /api/agents/:id/level`).
 *
 * Read-only, and never a second copy of the launch rule: the effective level is
 * `resolveAgentLaunchLevel`, the very call a room turn launches with, and the
 * person-set cap is the permission gate's own `personSetFilesAndCommands`
 * reader. Nothing here writes, and nothing here is an MCP tool.
 *
 * @module services/core/permissions/agent-level
 */
import type { PermissionStop, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { AgentLevelResponse } from '@dorkos/shared/permissions';
import { PERMISSION_STOPS } from '@dorkos/shared/permission-semantics';
import { resolveAgentLaunchLevel } from '../../session/resolution/agent-launch-level.js';
import { resolveUnattendedDefaultStop } from '../../session/resolution/resolve-session-defaults.js';
import { permissionGateSources } from '../capabilities/permission-enforcement.js';

/** Where the reader finds an agent, its runtime and what a person set for it. */
export interface AgentLevelReaderDeps {
  /** The registered agent's folder, or `undefined` for an id no agent has. */
  agentPath: (agentId: string) => string | undefined;
  /** The runtime a new chat of the agent at this folder launches on. */
  runtimeType: (agentPath: string) => Promise<string>;
  /** That runtime's capability profile, or `undefined` when it is not registered. */
  capabilities: (runtimeType: string) => RuntimeCapabilities | undefined;
  /**
   * What a person set for the agent's Files & commands. Defaults to the
   * permission gate's reader; `'unknown'` while that record cannot be trusted.
   */
  personSetStop?: (agentPath: string) => PermissionStop | null | 'unknown';
}

/** How far up the dial a stop sits: Ask first, then Act, then Full autonomy. */
function rank(stop: PermissionStop): number {
  return PERMISSION_STOPS.indexOf(stop);
}

/**
 * Build the reader the route answers from.
 *
 * `cappedByPerson` is true only when all three hold: a person set a stop for
 * this agent, it is below what the agent's runtime would otherwise give, and it
 * is the stop a launch resolves. An agent that tightened its own file further
 * is held by itself, not by a person, so the row does not say "by you".
 *
 * @param deps - See {@link AgentLevelReaderDeps}.
 * @returns A reader answering `null` for an id no registered agent has.
 */
export function createAgentLevelReader(
  deps: AgentLevelReaderDeps
): (agentId: string) => Promise<AgentLevelResponse | null> {
  const personSetStop =
    deps.personSetStop ??
    ((agentPath: string) =>
      permissionGateSources().personSetFilesAndCommands?.(agentPath) ?? 'unknown');
  return async (agentId) => {
    const agentPath = deps.agentPath(agentId);
    if (!agentPath) return null;
    const capabilities = deps.capabilities(await deps.runtimeType(agentPath));
    const launch = await resolveAgentLaunchLevel({ agentPath, capabilities });
    const declared = resolveUnattendedDefaultStop({
      configSection: capabilities?.settings.configSection ?? null,
    });
    const set = personSetStop(agentPath);
    const cappedByPerson =
      set !== 'unknown' &&
      set !== null &&
      declared !== null &&
      launch.stop === set &&
      rank(set) < rank(declared);
    return {
      effective: launch.stop,
      effectiveMode: launch.mode ?? null,
      declared,
      cappedByPerson,
    };
  };
}
