/**
 * Inline projection of an OAuth sign-in an agent asked for mid-conversation
 * (DOR-1004).
 *
 * When an agent calls `mcp_signin` inside a session, the server pushes the
 * sign-in link and its custody disclosure onto the session rather than letting
 * the agent paste them into its reply. These folds turn that pair of events into
 * an inline `mcp_signin` part and end it when the sign-in resolves.
 *
 * Two rules differ from the capability-approval pair they are modeled on, and
 * both follow from the sign-in NOT holding the turn:
 *
 * - Cards are keyed by `(agentId, serverName)`, not by flow id. A retried
 *   sign-in mints a new flow for the same server, and stacking a second card
 *   would leave a dead link above the live one.
 * - NEITHER ending retires the card. Both convert it into a compact terminal
 *   receipt, because both are things the transcript should be able to say later:
 *   what was connected and how many tools it brought, or that a sign-in the
 *   person was sent away for did not take. An approval card can retire on a
 *   decision because the decision is recorded elsewhere; a sign-in has no such
 *   elsewhere.
 *
 * @module features/chat/model/stream/mcp-signin-fold
 */
import type { MessagePart } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** The `mcp_signin` member of {@link MessagePart}. */
type McpSigninPart = Extract<MessagePart, { type: 'mcp_signin' }>;

/**
 * Find the index of the LIVE sign-in card for a server, or `-1`.
 *
 * Live means unresolved. A receipt for the same server can sit beside a fresh
 * card once a sign-in is retried — the receipt records what happened, the card is
 * the new attempt — so "the card for this server" has to mean the one still
 * asking for something.
 */
function findLiveSigninIndex(parts: MessagePart[], agentId: string, serverName: string): number {
  return parts.findIndex(
    (part) =>
      part.type === 'mcp_signin' &&
      part.agentId === agentId &&
      part.serverName === serverName &&
      part.outcome === undefined
  );
}

/**
 * Upsert the inline sign-in card for an `mcp_signin_required` event.
 *
 * A still-LIVE card for the same server is replaced in place: its flow is dead
 * the moment a new one is minted, so keeping both would offer the person a choice
 * between a working link and a broken one. A settled receipt is left alone — it
 * is the record of an attempt that already happened, and a retry does not unmake
 * it.
 */
export function foldMcpSignin(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'mcp_signin_required' }>
): void {
  const card: McpSigninPart = {
    type: 'mcp_signin',
    serverName: event.serverName,
    agentId: event.agentId,
    flowId: event.flowId,
    authorizeUrl: event.authorizeUrl,
    disclosure: event.disclosure,
  };
  const index = findLiveSigninIndex(parts, event.agentId, event.serverName);
  if (index === -1) parts.push(card);
  else parts[index] = card;
}

/**
 * Turn the inline sign-in card into a terminal receipt on its
 * `mcp_signin_resolved` event.
 *
 * Matched by FLOW id, so a resolution for an abandoned flow cannot settle the
 * card of the one that replaced it.
 *
 * - `connected` — the receipt names the server and, when the connect probe found
 *   out, how many tools it brought. This used to remove the part, on the
 *   reasoning that the agent was already resuming; that deleted the payoff about
 *   a second after it appeared and left no record of what had been authorized.
 * - `failed` — the receipt says the sign-in did not take, so a person who was
 *   sent to a browser is not left guessing.
 */
export function foldMcpSigninResolved(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'mcp_signin_resolved' }>
): void {
  const index = parts.findIndex(
    (part) => part.type === 'mcp_signin' && part.flowId === event.flowId
  );
  if (index === -1) return;
  const part = parts[index] as McpSigninPart;
  part.outcome = event.outcome;
  // Absent stays absent: "we don't know how many tools" is honest, and a receipt
  // claiming zero is not.
  if (event.toolCount !== undefined) part.toolCount = event.toolCount;
}
