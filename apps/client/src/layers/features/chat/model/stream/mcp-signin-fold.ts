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
 * - `connected` retires the card outright, while `failed` keeps it as a terminal
 *   note — the mirror image of the approval pair, because here the good ending
 *   is the one where the agent is already back at work and the bad ending is the
 *   one a person still has to hear about.
 *
 * @module features/chat/model/stream/mcp-signin-fold
 */
import type { MessagePart } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** The `mcp_signin` member of {@link MessagePart}. */
type McpSigninPart = Extract<MessagePart, { type: 'mcp_signin' }>;

/** Find the index of the sign-in card for a server, or `-1`. */
function findSigninIndex(parts: MessagePart[], agentId: string, serverName: string): number {
  return parts.findIndex(
    (part) =>
      part.type === 'mcp_signin' && part.agentId === agentId && part.serverName === serverName
  );
}

/**
 * Upsert the inline sign-in card for an `mcp_signin_required` event.
 *
 * An existing card for the same server is REPLACED in place: its flow is dead
 * the moment a new one is minted, so keeping both would offer the person a
 * choice between a working link and a broken one. Replacing also clears any
 * terminal note a previous failure left, which is exactly right — the agent is
 * asking again.
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
  const index = findSigninIndex(parts, event.agentId, event.serverName);
  if (index === -1) parts.push(card);
  else parts[index] = card;
}

/**
 * End the inline sign-in card on its `mcp_signin_resolved` event.
 *
 * Matched by FLOW id, so a resolution for an abandoned flow cannot retire the
 * card of the one that replaced it.
 *
 * - `connected` — the sign-in landed and the agent is already resuming, so the
 *   card has nothing left to say and is removed.
 * - `failed` — the card stays as a terminal note. Removing it would leave a
 *   person who was sent to a browser with no sign anything went wrong.
 */
export function foldMcpSigninResolved(
  parts: MessagePart[],
  event: Extract<SessionEvent, { type: 'mcp_signin_resolved' }>
): void {
  const index = parts.findIndex(
    (part) => part.type === 'mcp_signin' && part.flowId === event.flowId
  );
  if (index === -1) return;
  if (event.outcome === 'connected') {
    parts.splice(index, 1);
    return;
  }
  (parts[index] as McpSigninPart).outcome = 'failed';
}
