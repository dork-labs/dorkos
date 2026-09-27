/**
 * How many agents a change to one default reaches: the honest preview every
 * surface that changes a default shows before it commits ("Affects 33 agents"),
 * and the CLI prints after (spec `agent-permissions`, task 4.3).
 *
 * One function, so the Settings rows, the preset picker, the Control Center,
 * the apply dialog and the CLI can never count the same change two ways.
 *
 * @module shared/permissions/affected-agents
 */
import { PERMISSION_AREA_IDS } from './permission-ids.js';
import type { PermissionAreaId } from './permission-schemas.js';
import type { PermissionsResponse } from './permission-api-schemas.js';

/** A default a person can change, as the preview counts it. */
export type PermissionDefaultKey =
  | { kind: 'preset' }
  | { kind: 'area'; area: PermissionAreaId }
  | { kind: 'action'; action: string; area: PermissionAreaId }
  | { kind: 'files' };

/**
 * Count the agents that follow one default today, and so change with it.
 *
 * An agent follows a key when nothing of its own beats that key in the
 * resolver's order (agent action, then agent area, then the defaults):
 *
 * - an **area**: every agent without its own setting for that area. An agent
 *   with only a single action of its own there still follows the area for the
 *   rest of its actions, so it counts.
 * - an **action**: every agent with neither its own setting for that action nor
 *   its own setting for the action's area, since either one wins over a default.
 * - the **preset**: every agent that follows it anywhere. A preset sets every
 *   area and the global Files & commands stop, so only an agent that has set
 *   every area of its own AND does not follow the global stop is out of reach.
 * - **Files & commands**: the agents the server lists as following the global
 *   stop (no stop of their own, and no stop set for their runtime).
 *
 * @param overview - The `GET /api/permissions` body.
 * @param key - The default about to change.
 * @returns How many agents the change reaches.
 */
export function countAgentsFollowing(
  overview: Pick<PermissionsResponse, 'agentCount' | 'exceptions' | 'filesAndCommands'>,
  key: PermissionDefaultKey
): number {
  const followsStop = new Set(overview.filesAndCommands.followingAgentIds);
  if (key.kind === 'files') return followsStop.size;
  const areaLevel = overview.exceptions.filter((e) => e.action === undefined);
  const excluded = new Set<string>();
  if (key.kind === 'preset') {
    const areasByAgent = new Map<string, Set<string>>();
    for (const e of areaLevel) {
      const set = areasByAgent.get(e.agentId) ?? new Set<string>();
      set.add(e.area);
      areasByAgent.set(e.agentId, set);
    }
    for (const [agentId, areas] of areasByAgent) {
      if (areas.size >= PERMISSION_AREA_IDS.length && !followsStop.has(agentId)) {
        excluded.add(agentId);
      }
    }
  } else {
    for (const e of areaLevel) if (e.area === key.area) excluded.add(e.agentId);
    if (key.kind === 'action') {
      for (const e of overview.exceptions) if (e.action === key.action) excluded.add(e.agentId);
    }
  }
  return Math.max(0, overview.agentCount - excluded.size);
}

/**
 * The preview in words: "affects 33 agents", "affects 1 agent".
 *
 * @param count - From {@link countAgentsFollowing}.
 */
export function describeAffectedAgents(count: number): string {
  return `affects ${count} ${count === 1 ? 'agent' : 'agents'}`;
}
