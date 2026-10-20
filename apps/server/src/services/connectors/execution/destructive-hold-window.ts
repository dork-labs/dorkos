/**
 * Which destructive connected-app calls wait out a cancel window instead of
 * raising an approval card, and the wait itself (spec `trusted-by-default-flip`
 * §5.6, DOR-2739).
 *
 * ## Who is held, and who keeps the card
 *
 * A call is held only when every one of these is true, read fresh per call:
 *
 * 1. The install is on Trusted. Careful keeps the card.
 * 2. The caller is an agent in a chat: a turn-bound runtime principal, which
 *    the server minted for that agent and that chat. A no-chat `/mcp` caller,
 *    an API key and an operator never are.
 * 3. DorkOS knows that agent, and it is not switched off or expired. An
 *    agent DorkOS cannot name keeps the card.
 * 4. The chat's live level never asks: the level its latest turn ran at, as
 *    this process recorded it (`turn-power/turn-levels.ts`), and the stricter
 *    of the two when the chat is known by two ids. A chat this process never
 *    ran a turn on has no level and keeps the card, so a restart errs toward
 *    asking.
 * 5. No stranger started the turn, and no stranger's message reached it
 *    through a room or a ceiling (`startedByOutsider`, `marksOf`
 *    and the level's own `outsider` mark). This does NOT see outside content
 *    the turn read through a tool (an email, a web page); an injection-taint
 *    rule for that is a deferred follow-up (spec §8), and the 60-second
 *    window everyone is told about is the mitigation chosen meanwhile.
 * 6. DorkOS can say what the action is, in the app's own words. A hold
 *    everyone is told about must be describable.
 *
 * Anything else falls through to the tier gate, unchanged. So does an
 * eligible call whose waiting row could not be written: nothing runs that
 * nobody was told about.
 *
 * Conditions 1, 3 and 5 are checked again when the 60 seconds are up. If one
 * no longer holds, nothing is sent and the agent is told so.
 *
 * ## What the hold binds
 *
 * The approval a hold yields carries the preflight's authority digest, and the
 * broker accepts it only for that digest, before intent and again at dispatch
 * (`execution-broker.ts`). The input is the very value the registry parsed and
 * held while waiting. So the action that runs is the one everyone was told
 * about, on the account they were told about.
 *
 * @module services/connectors/execution/destructive-hold-window
 */
import path from 'node:path';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { stricterLevel } from '@dorkos/shared/permission-semantics';
import { trustPosture } from '@dorkos/shared/permissions';
import type {
  CapabilityInvocationContext,
  CapabilityPreflightResult,
} from '../../core/capabilities/registry.js';
import type { GrantedApproval } from '../../core/capabilities/tier-enforcement.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { permissionGateSources } from '../../core/capabilities/permission-enforcement.js';
import {
  getAgentIdentityService,
  type AgentIdentity,
} from '../../core/agent-identity/agent-identity-service.js';
import { lastTurnLevelOf, marksOf } from '../../core/turn-power/turn-levels.js';
import { marksOfLevel, startedByOutsider } from '../../core/turn-power/turn-marks.js';
import { isServerPrincipal } from '../principal/server-principal.js';
import type { DestructiveHoldService, HoldRequester } from './destructive-hold.js';

/** A hold the registry runs instead of the approval card. */
export type CancelWindowHold = () => Promise<Extract<GrantedApproval, { via: 'hold' }>>;

/** What eligibility reads, injectable for tests. Defaults read the live server. */
export interface HoldEligibilitySources {
  /** Whether the install is on Trusted. */
  trusted: () => boolean;
  /** The agent's identity by its home, to refuse a switched-off one. */
  describeAgent: (agentPath: string) => Promise<AgentIdentity | undefined>;
  /** The level a chat's latest turn ran at, or `undefined` when unknown. */
  turnLevel: (sessionId: string) => TurnPermissionLevel | undefined;
  /** Whether a stranger started this chat's turn or the turn read a stranger's words. */
  strangerTurn: (sessionId: string, agentPath: string) => boolean;
}

/** The live server's answers. */
const LIVE_SOURCES: HoldEligibilitySources = {
  trusted: () => trustPosture(permissionGateSources().readConfig().preset) === 'trusted',
  describeAgent: async (agentPath) => getAgentIdentityService()?.describeAgent(agentPath),
  turnLevel: lastTurnLevelOf,
  strangerTurn: (sessionId, agentPath) =>
    startedByOutsider(sessionId) || marksOf(sessionId, agentPath).outsider === true,
};

/** Whether a level never asks and read no stranger's words. */
function neverAsks(level: TurnPermissionLevel | undefined): boolean {
  return level !== undefined && level.asks === 'never' && marksOfLevel(level).outsider !== true;
}

/**
 * The agent a call would be held for, or `undefined` when it keeps the card.
 * See the module doc for every condition.
 *
 * @param context - The invocation context the surface supplied.
 * @param preflight - The connector preflight's result for this call.
 * @param sources - What to read; the live server by default.
 * @param fresh - Read the agent's identity from the store even when the
 *   surface resolved one, as the re-check at the end of the wait does: a
 *   switch-off during the wait must be seen.
 * @returns The requester, when the call is eligible.
 */
export async function holdRequesterFor(
  context: CapabilityInvocationContext,
  preflight: CapabilityPreflightResult,
  sources: HoldEligibilitySources = LIVE_SOURCES,
  fresh = false
): Promise<HoldRequester | undefined> {
  if (context.approvalToken || context.trusted || !preflight.approvalServiceAction)
    return undefined;
  const principal = context.serverPrincipal;
  if (!principal || !isServerPrincipal(principal) || principal.claims.kind !== 'runtime') {
    return undefined;
  }
  if (!sources.trusted()) return undefined;
  const { agentPath, agentId, canonicalSessionId } = principal.claims;
  const identity =
    (fresh ? undefined : context.identity) ?? (await sources.describeAgent(agentPath));
  // An agent DorkOS cannot name counts as switched off.
  if (!identity || identity.inactive) return undefined;
  // Both names the chat goes by on this call: the principal's canonical id,
  // and the session id the surface resolved, when it resolved one.
  const sessionIds = [...new Set([canonicalSessionId, context.sessionId])].filter(
    (id): id is string => typeof id === 'string' && id !== ''
  );
  if (sessionIds.some((sessionId) => sources.strangerTurn(sessionId, agentPath))) return undefined;
  // The stricter of the levels known under either id; none known keeps the card.
  const levels = sessionIds
    .map((sessionId) => sources.turnLevel(sessionId))
    .filter((level): level is TurnPermissionLevel => level !== undefined);
  if (levels.length === 0 || !neverAsks(levels.reduce(stricterLevel))) return undefined;
  return {
    agentPath,
    agentId,
    name: identity.displayName || path.basename(agentPath),
    sessionId: canonicalSessionId,
  };
}

/**
 * Whether the call may still run when its 60 seconds are up: still Trusted,
 * the agent still known and switched on, and still no stranger's turn. A
 * failure to read any of them counts as no.
 */
async function stillEligible(
  context: CapabilityInvocationContext,
  preflight: CapabilityPreflightResult,
  sources: HoldEligibilitySources | undefined
): Promise<boolean> {
  try {
    return (await holdRequesterFor(context, preflight, sources, true)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The cancel window for one destructive connected-app call, or `undefined`
 * when it keeps the approval card.
 *
 * The hold has already started (everyone was told) when this answers. The
 * function it returns waits it out and resolves with the `hold` approval once
 * the window ended with nobody cancelling and the call is still eligible. A
 * cancel, a stopped chat, or a call no longer eligible throws a tool error
 * saying nothing ran.
 *
 * @param holds - The server's hold service; absent keeps the card.
 * @param context - The invocation context the surface supplied.
 * @param preflight - The connector preflight's result for this call.
 * @param sources - What eligibility reads; the live server by default.
 * @returns The wait to run, or `undefined`.
 */
export async function cancelWindowFor(
  holds: DestructiveHoldService | undefined,
  context: CapabilityInvocationContext,
  preflight: CapabilityPreflightResult,
  sources?: HoldEligibilitySources
): Promise<CancelWindowHold | undefined> {
  if (!holds) return undefined;
  const requester = await holdRequesterFor(context, preflight, sources);
  const action = preflight.approvalServiceAction;
  if (!requester || !action) return undefined;
  const started = await holds.start({
    requester,
    action: { actionName: action.actionName, serviceName: action.serviceName },
    ...(context.signal ? { signal: context.signal } : {}),
  });
  // Nobody could be told, so nothing may run without a card.
  if (!started) return undefined;
  const { holdId, ended } = started;
  const authorityBindingDigest = preflight.authorityBinding.approvalScope.digest;
  const what = `"${action.actionName}" in ${action.serviceName}`;
  return async () => {
    const end = await ended;
    let cancelledBy: string | undefined;
    if (end.outcome === 'elapsed') {
      if (await stillEligible(context, preflight, sources)) {
        const released = await holds.release(holdId);
        if (released.ok) return { via: 'hold', holdId, authorityBindingDigest };
        cancelledBy = released.cancelledBy;
      } else {
        // A cancel during the re-check already ended it; say who.
        cancelledBy = holds.refuse(holdId);
      }
      if (cancelledBy === undefined) {
        throw new CapabilityToolError({
          error:
            `Nothing ran. When its time came, ${what} no longer qualified to run without the ` +
            "person's approval, so DorkOS did not send it. Ask the person before trying again.",
          code: 'HOLD_NO_LONGER_ALLOWED',
          holdId,
        });
      }
    }
    const who = cancelledBy ?? (end.outcome === 'cancelled' ? end.by : 'Stopping the chat');
    throw new CapabilityToolError({
      error: `${who} cancelled ${what} before it ran. It did not run. Do not try it again unless the person asks.`,
      code: 'CANCELLED',
      cancelledBy: who,
      holdId,
    });
  };
}
