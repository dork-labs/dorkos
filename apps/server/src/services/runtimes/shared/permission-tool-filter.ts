/**
 * What a Blocked permission does to an agent's tool list (spec
 * `agent-permissions` D15): the action is left out of the list, and one line per
 * Blocked area tells the agent the area exists and how to get it.
 *
 * Shared by every tool-list builder — claude-code's in-session server, the
 * Codex/OpenCode runtime listener, and the external `/mcp` server — so the three
 * cannot disagree about what an agent sees. It resolves with the SAME
 * `resolvePermission` the gate runs, over the same sources, so a hidden tool is
 * exactly a tool the gate would refuse.
 *
 * Hiding is a courtesy to the agent, never the enforcement: the gate resolves on
 * every call. A change takes effect the next time a list is built (the next
 * turn); a call made before then is still refused or asked about correctly.
 *
 * @module services/runtimes/shared/permission-tool-filter
 */
import {
  resolvePermission,
  type AgentPermissions,
  type PermissionAreaId,
} from '@dorkos/shared/permissions';

import { blockedAreaPhrase, permissionGateSources } from '../../core/capabilities/index.js';

/** The tools one agent should not be shown, and the areas that hid them. */
export interface ToolVisibility {
  /** MCP tool names to leave out of the list. */
  hiddenToolNames: ReadonlySet<string>;
  /** Areas with at least one member where the whole area resolves to Blocked. */
  blockedAreas: readonly PermissionAreaId[];
}

/** Nothing hidden. */
export const NOTHING_HIDDEN: ToolVisibility = { hiddenToolNames: new Set(), blockedAreas: [] };

/**
 * Resolve which tools an agent should not see.
 *
 * @param agent - The agent's stored overrides; `undefined` for an agent with
 *   none, or for a caller that is not an agent (the defaults decide).
 * @param options - `inactive` for a revoked or expired identity (everything
 *   with an area is Blocked).
 * @returns The hidden tool names and the Blocked areas.
 */
export function resolveToolVisibility(
  agent: AgentPermissions | undefined,
  options: { inactive?: boolean } = {}
): ToolVisibility {
  const sources = permissionGateSources();
  let config;
  try {
    config = sources.readConfig();
  } catch {
    // A config nobody can read hides nothing: the gate refuses every call in
    // that state anyway, and an empty list would only hide the refusal's reason.
    return NOTHING_HIDDEN;
  }
  const hidden = new Set<string>();
  const areasWithMembers = new Set<PermissionAreaId>();
  for (const action of sources.listActions()) {
    if (action.area === null) continue;
    areasWithMembers.add(action.area);
    const resolved = resolvePermission({
      area: action.area,
      actionId: action.id,
      tier: action.tier,
      config,
      ...(agent ? { agent } : {}),
      ...(options.inactive ? { inactive: true } : {}),
    });
    if (resolved.state === 'blocked' && action.toolName) hidden.add(action.toolName);
  }
  const blockedAreas = [...areasWithMembers].filter(
    (area) =>
      resolvePermission({
        area,
        // The empty id no action entry names: the area's own answer.
        actionId: '',
        tier: 'act',
        config,
        ...(agent ? { agent } : {}),
        ...(options.inactive ? { inactive: true } : {}),
      }).state === 'blocked'
  );
  return { hiddenToolNames: hidden, blockedAreas };
}

/**
 * {@link resolveToolVisibility} for an agent named by its project directory,
 * reading its overrides fresh off its manifest the way the gate does.
 *
 * A manifest that cannot be read hides nothing: the gate refuses every call
 * with an area in that state, with a sentence saying why, which is more useful
 * to the agent than a list that silently lost its tools.
 *
 * @param agentPath - The agent's directory, or `undefined` for a caller that is
 *   not an agent (the defaults decide).
 * @param options - `inactive` for a revoked or expired identity.
 */
export async function resolveToolVisibilityFor(
  agentPath: string | undefined,
  options: { inactive?: boolean } = {}
): Promise<ToolVisibility> {
  if (!agentPath) return resolveToolVisibility(undefined, options);
  let agent: AgentPermissions | undefined;
  try {
    agent = await permissionGateSources().readAgentPermissions(agentPath);
  } catch {
    return NOTHING_HIDDEN;
  }
  return resolveToolVisibility(agent, options);
}

/**
 * The context lines for the Blocked areas, one per area, or `''` when nothing
 * is blocked. Phase 1 has no request tool yet, so each line says to ask the
 * person.
 *
 * @param blockedAreas - From {@link resolveToolVisibility}.
 */
export function renderBlockedAreaLines(blockedAreas: readonly PermissionAreaId[]): string {
  return blockedAreas
    .map((area) => `${blockedAreaPhrase(area)} is blocked for you. Ask the person if you need it.`)
    .join('\n');
}
