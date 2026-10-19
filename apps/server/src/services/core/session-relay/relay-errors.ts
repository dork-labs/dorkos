/**
 * The refusals the session relay answers with. Plain sentences, the same for
 * every caller, and never a folder, an id or anything else from inside this
 * computer: a refusal must not tell the web side more than "no".
 *
 * @module services/core/session-relay/relay-errors
 */
import type { RelayError } from '@dorkos/shared/session-relay';
import type { SessionLaunchRefusal } from '../../session/launch/launch-session.js';

/** No such chat, or one the relay does not serve: the two read the same. */
export const RELAY_NOT_FOUND: RelayError = {
  status: 404,
  code: 'not_found',
  message: 'No such chat on this computer.',
};

/** No such agent, or one the relay does not serve. */
export const RELAY_NO_AGENT: RelayError = {
  ...RELAY_NOT_FOUND,
  message: 'No such agent on this computer.',
};

/** Something failed on this computer. Says nothing about what. */
export const RELAY_INTERNAL: RelayError = {
  status: 500,
  code: 'internal',
  message: 'Something went wrong on this computer.',
};

/** A request this version does not know, or one that does not parse. */
export const RELAY_INVALID: RelayError = {
  status: 400,
  code: 'invalid',
  message: 'That request is not valid.',
};

/** Too many open streams or unanswered requests on this connection. */
export const RELAY_RATE_LIMITED: RelayError = {
  status: 429,
  code: 'rate_limited',
  message: 'Too many requests at once. Try again in a moment.',
};

/** One of a chat's updates was too large to send, so its stream ended. */
export const RELAY_FRAME_TOO_LARGE: RelayError = {
  status: 500,
  code: 'internal',
  message: 'A frame was too large to relay.',
};

/** The link to the web fell too far behind, so a stream ended; reopening it catches up. */
export const RELAY_BACKLOGGED: RelayError = {
  ...RELAY_RATE_LIMITED,
  message: 'This chat fell behind. Reopen it to catch up.',
};

/** Too many chats started from the web are still running. */
export const RELAY_TOO_MANY_NEW_CHATS: RelayError = {
  ...RELAY_RATE_LIMITED,
  message: 'Too many new chats are running. Try again when one finishes.',
};

/** No approvals passkey is pinned here, or its file cannot be read. */
export const RELAY_APPROVAL_NO_PASSKEY: RelayError = {
  status: 403,
  code: 'refused',
  message: 'Add a passkey at this computer to approve from the web.',
};

/**
 * The approval would not fit in a statement the approve page can show and
 * sign: too large, nested too deep, or text with no exact form.
 */
export const RELAY_APPROVAL_TOO_LARGE: RelayError = {
  ...RELAY_APPROVAL_NO_PASSKEY,
  message: 'Too large to approve from the web. Approve it at the computer.',
};

/**
 * Granting it could raise what agents may do, so it is decided at this
 * computer only (Security Must 4), whatever proof comes with it. The same
 * sentence a Wi-Fi sign-in reads for the same refusal (DOR-3037).
 */
export const RELAY_APPROVAL_AT_COMPUTER: RelayError = {
  ...RELAY_APPROVAL_NO_PASSKEY,
  message: 'Do this at this computer.',
};

/** The chat is no longer waiting on that tool call. */
export const RELAY_APPROVAL_NOT_PENDING: RelayError = {
  ...RELAY_NOT_FOUND,
  message: 'That approval is no longer waiting.',
};

/** No live challenge for that proof: never issued, used already, or expired. */
export const RELAY_APPROVAL_EXPIRED: RelayError = {
  ...RELAY_APPROVAL_NO_PASSKEY,
  message: 'That approval request expired. Try again.',
};

/** A proof that did not pass every check. Says nothing about which one. */
export const RELAY_APPROVAL_PROOF_FAILED: RelayError = {
  ...RELAY_APPROVAL_NO_PASSKEY,
  message: 'The passkey check did not pass. Try again.',
};

/** Too many approvals waiting on a passkey on this connection. */
export const RELAY_TOO_MANY_APPROVALS: RelayError = {
  ...RELAY_RATE_LIMITED,
  message: 'Too many approvals are waiting. Finish one first.',
};

/**
 * A relayed answer to a question the chat is waiting on: it would put words
 * into a turn a person started at full power, so it waits for a passkey proof
 * of its own (spec B4e).
 */
export const RELAY_ANSWER_REFUSED: RelayError = {
  status: 403,
  code: 'refused',
  message: 'Answers from the web need a newer version of this computer.',
};

/**
 * A relayed message delivered any way but the queue. Staged or steered words
 * join a turn that may not be held to the relay's ceiling.
 */
export const RELAY_DISPOSITION_REFUSED: RelayError = {
  ...RELAY_INVALID,
  message: 'Messages from the web wait their turn.',
};

/**
 * A relayed message that starts with a slash command. A command can approve
 * tools ahead of time (`allowed-tools`), which would skip the ask.
 */
export const RELAY_SLASH_COMMAND_REFUSED: RelayError = {
  status: 403,
  code: 'refused',
  message: 'Slash commands run only at this computer.',
};

/** The chat's folder is outside what this computer allows. */
export const RELAY_OUTSIDE_BOUNDARY: RelayError = {
  status: 403,
  code: 'refused',
  message: "This chat's folder is outside what this computer allows.",
};

/**
 * The relay's answer to a launch the send path refused. Never the launch's own
 * sentence, which can name a folder.
 *
 * @param refused - Which check refused the launch.
 */
export function relayLaunchRefusal(refused: SessionLaunchRefusal['refused']): RelayError {
  const message =
    refused === 'AGENT_PAUSED'
      ? 'This agent is paused.'
      : refused === 'ACCOUNT_NOT_ALLOWED'
        ? "This chat's account can't work in this project."
        : 'This computer could not start that chat.';
  return { status: 409, code: 'refused', message };
}
