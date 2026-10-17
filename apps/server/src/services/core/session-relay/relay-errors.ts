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

/** An approval, or a challenge for one: these wait for the passkey proof (spec B4). */
export const RELAY_APPROVAL_REFUSED: RelayError = {
  status: 403,
  code: 'refused',
  message: 'Approvals from the web need a newer version of this computer.',
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
