/**
 * Who is calling, for to-dos and agents' own promises (DOR-3088): the one place either answer is made.
 *
 * - {@link callerAgentId}: the calling agent's Mesh id. Today it comes from the verified identity's
 *   agent home. DOR-3640 replaces that with a server-issued principal; when it lands, this
 *   function is the only thing that changes. `assigned_by`, the per-assigner caps and the "only
 *   your own to-dos" gate all read it, and nothing else may work the id out on its own.
 * - {@link personProof}: whether an HTTP request proves the person who owns this DorkOS. Only the
 *   owner's own session cookie does. This computer's open gate (`isOwner` with login off) does not:
 *   any program here can reach it with no agent headers, and it must not mint `person` authority.
 *   Nor does a request from Wi-Fi that the shared Wi-Fi hold holds (DOR-5070): a to-do runs at
 *   the agent's own level, so it follows the same rule as a message from that device.
 *
 * @module services/todos/caller
 */
import { clearsTheAgentBar } from '../../lib/caller-authority.js';
import { isInstallOwner } from '../core/auth/install-owner.js';
import {
  isOwnerSignInOnWifi,
  wifiTurnHeld,
  type WifiTurnFacts,
} from '../core/auth/sessions/wifi-turn-ceiling.js';
import { presentsAgentIdentity } from '../../middleware/agent-identity.js';

/** The verified identity a caller presented, as the capability context and request facts carry it. */
export interface CallerIdentity {
  /** The agent's home folder, verified by its identity token. */
  readonly agentPath: string;
  /** Set when the identity no longer acts: its token expired, or the agent was revoked. */
  readonly inactive?: string | boolean;
}

/** The calling agent's Mesh id, or why there is none. */
export type CallerAgent =
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly code: 'NO_AGENT' | 'UNKNOWN_AGENT' };

/**
 * The calling agent's Mesh id, from its verified identity. Never from a request body.
 *
 * @param identity - The verified identity, if any.
 * @param agentIdForPath - Mesh's lookup from an agent home to its id.
 */
export function callerAgentId(
  identity: CallerIdentity | undefined,
  agentIdForPath: (agentPath: string) => string | undefined
): CallerAgent {
  if (!identity || identity.inactive) return { ok: false, code: 'NO_AGENT' };
  const agentId = agentIdForPath(identity.agentPath);
  return agentId ? { ok: true, agentId } : { ok: false, code: 'UNKNOWN_AGENT' };
}

/**
 * Whether a request proves the owner in person: no agent identity, no approval token, the
 * owner's own session cookie (the sign-in, or the step-up that leaves the same cookie), and not
 * a Wi-Fi request the Wi-Fi hold holds. From Wi-Fi only a sign-in the owner let run agents
 * proves the person, the same rule every path that starts a turn asks (`wifiTurnHeld`).
 *
 * @param facts - The request's facts.
 */
export function personProof(
  facts: Parameters<typeof clearsTheAgentBar>[0] & WifiTurnFacts
): boolean {
  if (presentsAgentIdentity(facts)) return false;
  if (!clearsTheAgentBar(facts)) return false;
  if (wifiTurnHeld(facts)) return false;
  return facts.user?.credential === 'cookie' && isInstallOwner(facts.user);
}

/**
 * Whether a request is the owner's own sign-in on a Wi-Fi device the Wi-Fi hold holds (DOR-5070,
 * Security's option 1): their cookie, from the app's own page, on a device not let run agents.
 * It never proves the person ({@link personProof} stays false), so it mints no `person`
 * authority. The capability mount hands it to a `person-held` capability as a request fact
 * (`context.request.heldWifiOwner`), and a person's to-do writes treat it as an unproven person
 * with the no-owner allowance: it may also finish, reopen, note or reorder a to-do assigned to the
 * person (`todo-policy`). Like any unproven person it can still make a to-do, at the lowest power.
 *
 * @param facts - The request's facts.
 */
export function heldWifiOwner(
  facts: Parameters<typeof clearsTheAgentBar>[0] & WifiTurnFacts
): boolean {
  if (!clearsTheAgentBar(facts)) return false;
  return wifiTurnHeld(facts) && isOwnerSignInOnWifi(facts);
}
