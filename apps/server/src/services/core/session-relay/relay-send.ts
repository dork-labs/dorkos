/**
 * What a relayed message asks the send path for: the owner's words and how to
 * deliver them, and a folder this computer chose, never one the request named.
 *
 * @module services/core/session-relay/relay-send
 */
import type { RelayError, RelayRequest } from '@dorkos/shared/session-relay';
import type { SendMessageRequest } from '@dorkos/shared/schemas';
import { RELAY_NO_AGENT, RELAY_NOT_FOUND } from './relay-errors.js';
import {
  relayAgentById,
  relayAgentForSession,
  type RelayAgent,
  type RelaySessionFacts,
} from './relay-serves.js';

/** A message the send path may take, or why the relay refuses it. */
export type RelayedMessage =
  { ok: true; message: SendMessageRequest; startsChat: boolean } | { ok: false; error: RelayError };

/**
 * Build the send path's request for one relayed message.
 *
 * - **A chat that exists** must be one the relay serves; it is fed in the
 *   folder this server placed it in, and a bound chat's own binding wins over
 *   even that. A `newChat` naming another agent is not this chat.
 * - **A chat that does not exist** starts only with `newChat`, for an agent
 *   the relay serves, in that agent's folder as Mesh knows it.
 * - Anything else is not found: a relayed message never starts a chat it did
 *   not ask for.
 *
 * Only the words, the client's message id and the disposition come from the
 * request. A slash command or an @-mention runs as it would at this computer:
 * the relay is the owner, so the text is the owner's own typing, not an
 * outsider's to neutralize.
 *
 * @param request - The parsed `session.send` request.
 * @param facts - The server's records for the chat, or `null` when it does not exist.
 * @param agents - Every registered agent, read for this request.
 */
export function relayedMessage(
  request: Extract<RelayRequest, { op: 'session.send' }>,
  facts: RelaySessionFacts | null,
  agents: readonly RelayAgent[]
): RelayedMessage {
  const typed = {
    content: request.content,
    ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
    ...(request.disposition ? { disposition: request.disposition } : {}),
  };
  const { newChat } = request;
  if (facts) {
    const agent = relayAgentForSession(facts, agents);
    if (!agent || facts.cwd === null || (newChat && newChat.agentId !== agent.id)) {
      return { ok: false, error: RELAY_NOT_FOUND };
    }
    return { ok: true, message: { ...typed, cwd: facts.cwd }, startsChat: false };
  }
  if (!newChat) return { ok: false, error: RELAY_NOT_FOUND };
  const agent = relayAgentById(agents, newChat.agentId);
  if (!agent) return { ok: false, error: RELAY_NO_AGENT };
  return {
    ok: true,
    message: { ...typed, create: true, cwd: agent.projectPath, agentPath: agent.projectPath },
    startsChat: true,
  };
}
