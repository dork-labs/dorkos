/**
 * Mark the turn a verified call ran in as one that read outside text (DOR-3969, spec §4.7). The one
 * place every server-side read that hands an agent someone else's words marks from: a connected
 * app's read, and DorkOS's own tools that return outside text (`dorkos-tool-reads.ts`).
 *
 * Placed from what the server verified, never from the call's arguments: the turn the runtime
 * principal is bound to, and the session the surface named. A call with neither (a person on the
 * HTTP API) marks nothing.
 *
 * @module services/core/capabilities/mark-caller-turn
 */
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import { markRunningTurnOutsider } from '../turn-power/turn-levels.js';
import { principalTurnOf } from './marked-turn-holds.js';

/** What a verified call says about the turn it ran in. */
export interface CallerTurn {
  /** The server principal the surface verified, if any. */
  serverPrincipal?: ServerPrincipalProof;
  /** The session the surface named, if any. */
  sessionId?: string;
  /** The calling agent's verified identity, if any. */
  identity?: { agentPath?: string } | null;
}

/**
 * Mark the caller's running turn, under every id the call verified.
 *
 * @param caller - The verified call.
 */
export function markCallerTurnOutsider(caller: CallerTurn): void {
  const { principalTurn } = principalTurnOf(caller.serverPrincipal);
  if (principalTurn) markRunningTurnOutsider(principalTurn.sessionId, principalTurn.agentPath);
  if (caller.sessionId && caller.sessionId !== principalTurn?.sessionId) {
    markRunningTurnOutsider(caller.sessionId, caller.identity?.agentPath);
  }
}
