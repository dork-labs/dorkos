/**
 * The actions a person decides every time a marked turn calls them (DOR-3036, DOR-3390).
 *
 * A turn that carries an outsider's words on runs at its agent's own level (DOR-3390), so the
 * mark, not the level, has to stop what such words must never do unasked. Two kinds of call, a
 * card each time whatever the preset:
 *
 * - **Standing changes.** An edit to who the agent is (`update_agent`), a chat route that gives
 *   an outside chat a line to an agent (`binding_create`), a package or MCP server every later
 *   session runs, and a settings change. Each outlives the turn, so the words would reach every
 *   later turn with no mark on them.
 * - **Acts in an outside account.** `execute_write` sends email, replies, drafts, trashes mail
 *   and creates or moves calendar events. Its destructive sibling already asks in a marked turn
 *   (`destructive-hold-window.ts`); this keeps the write tier from doing the same unasked.
 *
 * @module services/core/capabilities/marked-turn-holds
 */
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../connectors/principal/server-principal.js';
import type { ToolReadCaller } from '../turn-power/tool-read-marks.js';

/** Actions that ask in a marked turn, by capability id or hand-registered tool name. */
export const HELD_IN_A_MARKED_TURN: ReadonlySet<string> = new Set([
  'operator.update_agent',
  'operator.config_patch',
  'binding_create',
  'marketplace.install',
  'marketplace.update',
  'connectors.execute_write',
  'mcp.add',
  'mcp.import',
  'mcp.update',
  'mcp.remove',
  'mcp.enable',
  'mcp.disable',
  'mcp.signin',
  'mcp.set_client',
]);

/**
 * The area a marked turn's card is filed under, for a held action that declares none. Connected
 * accounts keep their own grant model and so have no area; the card still needs one to say what
 * it is about.
 */
const CARD_AREA_WITHOUT_ONE: Readonly<Record<string, PermissionAreaId>> = {
  'connectors.execute_write': 'connections',
};

/**
 * The area a held action with no area of its own asks under in a marked turn, or `undefined`
 * when it is not one.
 *
 * @param actionId - The action's id.
 */
export function markedTurnCardArea(actionId: string): PermissionAreaId | undefined {
  return Object.prototype.hasOwnProperty.call(CARD_AREA_WITHOUT_ONE, actionId)
    ? CARD_AREA_WITHOUT_ONE[actionId]
    : undefined;
}

/**
 * The chat and agent a turn-bound runtime principal names, as the spread the permission resolver
 * takes, so a call that arrives with the principal alone (the connector loopback) is read as the
 * turn it belongs to. Empty for any other caller.
 *
 * @param principal - The server principal the surface verified, if any.
 */
export function principalTurnOf(principal: ServerPrincipalProof | undefined): {
  principalTurn?: { sessionId: string; agentPath: string };
} {
  if (!principal || !isServerPrincipal(principal) || principal.claims.kind !== 'runtime') {
    return {};
  }
  const { canonicalSessionId, agentPath } = principal.claims;
  return { principalTurn: { sessionId: canonicalSessionId, agentPath } };
}

/**
 * The turn a tool read is marked on (DOR-3291): the session and agent the surface verified, or the
 * turn a runtime principal names. Never anything from the call's input.
 *
 * @param supplied - The invocation context the surface built.
 */
export function toolReadCallerOf(supplied: {
  sessionId?: string;
  identity?: { agentPath: string };
  serverPrincipal?: ServerPrincipalProof;
}): ToolReadCaller {
  const turn = principalTurnOf(supplied.serverPrincipal).principalTurn;
  const sessionId = supplied.sessionId ?? turn?.sessionId;
  const agentPath = supplied.identity?.agentPath ?? turn?.agentPath;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(agentPath ? { agentPath } : {}),
  };
}
