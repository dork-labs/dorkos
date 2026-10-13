/**
 * The words the tier gate says to a caller it stopped: why the call is waiting,
 * and exactly how to retry it. Split out of `tier-enforcement.ts`, which decides
 * and leaves the wording here.
 *
 * @module services/core/capabilities/approval-wording
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type {
  ApprovalRequiredPayload,
  ApprovalRequiredReason,
  ApprovalRetryChannel,
} from './tier-enforcement.js';

/** The MCP tool argument a retry passes its approval token in. */
export const APPROVAL_TOKEN_ARGUMENT = 'approvalToken';

/** The HTTP header a retry passes its approval token in. */
export const APPROVAL_TOKEN_HEADER = 'x-dorkos-approval';

/**
 * The sentence every gated caller gets, whatever surface it arrived on
 * (DOR-1570).
 *
 * "An approval card is waiting for them" used to be the whole instruction, and
 * a model reading it would dutifully stop — leaving a person who had been told
 * nothing to find the card themselves. DorkOS raises the bell, the desktop
 * banner and (after the escalation delay) the phone ping on its own; the one
 * thing only the agent can do is say out loud that it is waiting.
 */
const SAY_SO_FIRST =
  'Tell the person what you are asking to do and that it is waiting on their approval — say it in ' +
  'your reply, do not just stop.';

/**
 * The extra sentence for an agent inside a live DorkOS session, where it can
 * put the card in front of somebody instead of only describing it.
 *
 * Only ever added for an in-session caller. `control_ui` needs an attached
 * interactive session and is not registered on the sessionless external `/mcp`
 * server, so naming it there would be an instruction that can only fail. It is
 * also not auto-allowed, which is why this offers rather than promises.
 */
const OPEN_THE_PANEL =
  "If the approval is about a scheduled task, control_ui({ action: 'open_panel', panel: 'tasks' }) " +
  'opens the Schedules panel for them.';

/**
 * Retry instructions for the surface the call arrived on.
 *
 * @param channel - Where a retry carries its token.
 * @param interactive - Whether the caller is an in-session MCP server, and can
 *   therefore reach the UI tools.
 * @returns The retry block of an `approval_required` payload.
 */
export function retryGuidance(
  channel: ApprovalRetryChannel,
  interactive: boolean
): ApprovalRequiredPayload['retry'] {
  const surface = interactive ? `${SAY_SO_FIRST} ${OPEN_THE_PANEL}` : SAY_SO_FIRST;
  if (channel === 'mcp-argument') {
    return {
      channel,
      field: APPROVAL_TOKEN_ARGUMENT,
      instructions:
        `${surface} An approval card is waiting for them in DorkOS. Once they have approved it, call this ` +
        `tool again with exactly the same arguments plus "${APPROVAL_TOKEN_ARGUMENT}" set to the approvalToken above. ` +
        `Changing any argument invalidates the approval, because an approval covers one exact action.`,
    };
  }
  return {
    channel,
    field: APPROVAL_TOKEN_HEADER,
    instructions:
      `${surface} An approval card is waiting for them in DorkOS. Once they have approved it, send exactly the ` +
      `same request again with the "${APPROVAL_TOKEN_HEADER}" header set to the approvalToken above ` +
      `(with the CLI: dorkos call <id> --approval <token>). Changing the input invalidates the approval, ` +
      `because an approval covers one exact action.`,
  };
}

/**
 * A connected-app action in the destructive tier. The app's service puts
 * sending, forwarding and sharing in that class too, so these are only ever
 * called high risk: "cannot be undone" would not be true of them.
 */
function isConnectedAppAction(capabilityId: string): boolean {
  return capabilityId.startsWith('connectors.execute_');
}

/**
 * Why a call needs a person, by tier: a destructive call because it cannot be
 * undone (a connected-app action because it is high risk), an `act` call
 * because its permission is set to Ask.
 *
 * @param tier - The action's tier.
 * @param capabilityId - The action's capability id.
 * @returns The clause, e.g. `is high risk`.
 */
export function needsApprovalClause(tier: CapabilityTier, capabilityId: string): string {
  if (tier !== 'destructive') return 'is set to ask a person first';
  return isConnectedAppAction(capabilityId) ? 'is high risk' : 'cannot be undone';
}

/**
 * The plain sentence explaining why a gated call is waiting.
 *
 * @param reason - Why the call is not running yet.
 * @param title - The action's title.
 * @param tier - The action's tier.
 * @param capabilityId - The action's capability id.
 * @param blocked - Whether the agent asked past a Blocked permission.
 * @returns The sentence.
 */
export function approvalMessage(
  reason: ApprovalRequiredReason,
  title: string,
  tier: CapabilityTier,
  capabilityId: string,
  blocked = false
): string {
  switch (reason) {
    case 'no_approval':
      if (blocked) {
        return `"${title}" is blocked for this agent, so DorkOS has asked the person whether to allow it this time.`;
      }
      return tier === 'destructive'
        ? `"${title}" ${needsApprovalClause(tier, capabilityId)}, so a person has to approve it first. DorkOS has asked them.`
        : `"${title}" is set to ask a person first. DorkOS has asked them.`;
    case 'awaiting_decision':
      return `"${title}" is still waiting on a person. Present the same token again once they have answered.`;
    case 'expired':
      return `That approval ran out of time before it was used. DorkOS has asked again.`;
    case 'already_used':
      return `That approval was already used. Approvals work once, so DorkOS has asked again.`;
    case 'wrong_action':
      return `That approval was granted for a different action, so it cannot be used here. DorkOS has asked for this one.`;
    case 'unknown_token':
      return `DorkOS does not recognize that approval token. It has asked for a new approval.`;
  }
}
