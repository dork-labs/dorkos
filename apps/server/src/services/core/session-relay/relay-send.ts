/**
 * What a relayed message asks the send path for: the owner's words and how to
 * deliver them, and a folder this computer chose, never one the request named.
 *
 * @module services/core/session-relay/relay-send
 */
import type { RelayError, RelayRequest } from '@dorkos/shared/session-relay';
import type { SendMessageRequest } from '@dorkos/shared/schemas';
import {
  RELAY_DISPOSITION_REFUSED,
  RELAY_NO_AGENT,
  RELAY_NOT_FOUND,
  RELAY_SLASH_COMMAND_REFUSED,
} from './relay-errors.js';
import {
  relayAgentById,
  relayAgentForSession,
  type RelayAgent,
  type RelaySessionFacts,
} from './relay-serves.js';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';

/** Text that opens with a slash command, as the composer would run it. */
const SLASH_COMMAND = /^\s*\/[A-Za-z][\w:.-]*(\s|$)/;

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
 * Only the words and the client's message id come from the request. A hub
 * that was broken into could have written them, so two ways past the turn's
 * ceiling ({@link RELAY_TURN_CEILING}) are refused before anything is placed:
 *
 * - **A disposition other than `queue`.** Staged words wait for the next turn,
 *   whoever starts it, and steered words join a running turn; neither is held
 *   to the relay's ceiling. No disposition is passed on, so the send path
 *   queues the message as its own turn.
 * - **A slash command.** A command's `allowed-tools` approves tools ahead of
 *   time, which would skip the ask. Commands run only at this computer.
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
  if (request.disposition && request.disposition !== 'queue') {
    return { ok: false, error: RELAY_DISPOSITION_REFUSED };
  }
  if (SLASH_COMMAND.test(request.content)) {
    return { ok: false, error: RELAY_SLASH_COMMAND_REFUSED };
  }
  const typed = {
    content: request.content,
    ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
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

/**
 * The loosest level a relayed turn may run at: the runtime's own default,
 * which asks before anything that needs a person. It is the bound for words
 * this computer cannot vouch for, and a relayed message is that: it arrives
 * through the hub, so a hub that was broken into could have written it. Each
 * question it raises waits at this computer, or for the passkey-signed
 * approval from the web (spec B4); the relay never answers one without it.
 */
export const RELAY_TURN_CEILING: TurnPermissionCeiling = 'runtime-default';
