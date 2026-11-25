/**
 * The problem documents the space connection routes share (DOR-4979): who may
 * use a stored connection, and how a connection's failure reads. One fixed
 * sentence per case, never a space's own text or an error's message; a space's
 * answer is read for its status and code only, and the cause goes to the log.
 *
 * @module routes/community-problems
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import { logger, logError } from '../lib/logger.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { getRoomService } from '../services/rooms/index.js';
import {
  RemoteConnectionAuthorizationError,
  RemoteConnectionNotFoundError,
} from '../services/communities/remote/connection-store.js';
import {
  RemotePairingBusyError,
  RemoteCommunityRateLimitedError,
  RemoteCommunityNameNotFoundError,
  RemoteCommunitySelectionRequiredError,
  RemoteCommunityUpgradeRequiredError,
} from '../services/communities/remote/pairing-service.js';
import { PinnedOriginError } from '../services/communities/remote/pinned-origin.js';
import { resolveCaller } from './room-caller.js';

/** A connection ref that is not path-safe, or names no connection. */
export const CONNECTION_NOT_FOUND = 'That space connection doesn’t exist.';

/**
 * The `404 not_found` for a connection ref that is not path-safe or names no
 * connection.
 *
 * @param c - The request's context.
 */
export function connectionNotFound(c: Context): Response {
  return problem(c, 'not_found', { detail: CONNECTION_NOT_FOUND });
}

/** The `409 reconnect_required` for a connection whose sign-in at the space ended. */
export function reconnectRequired(c: Context): Response {
  return problem(c, 'reconnect_required', { detail: 'Reconnect this space to continue.' });
}

/**
 * Resolve the only local human allowed to use a stored community connection.
 *
 * @param c - The request's context.
 * @returns The owner's author id, or the refusal to answer with.
 */
export function resolveCommunityOwner(c: Context<ApiEnv>): string | Response {
  const facts = honoRequestFacts(c);
  const cookieRefusal = requireOperatorCookieUnderLogin(facts, 'space connections');
  if (cookieRefusal) return problem(c, 'person_only', { detail: `${cookieRefusal.error}.` });
  if (!facts.user && !isAtThisComputer(facts)) {
    return problem(c, 'operator_only', {
      detail: 'Manage space connections from the computer DorkOS runs on.',
    });
  }
  let caller;
  try {
    caller = resolveCaller(facts);
  } catch {
    return problem(c, 'person_only', { detail: 'An agent can’t manage space connections.' });
  }
  if (!getRoomService().authorRegistry.isOwner(caller.id, readOwnerAccount()?.id ?? null)) {
    return problem(c, 'owner_only', {
      detail: 'Only the owner of this DorkOS can manage space connections.',
    });
  }
  const expectedOwner = c.req.header('x-dorkos-community-owner');
  if (expectedOwner && expectedOwner !== caller.id) {
    return problem(c, 'owner_changed', {
      detail: 'The owner of this DorkOS changed. Reload to see their spaces.',
    });
  }
  return caller.id;
}

/**
 * Answer a connection route's failure: a pairing refusal in its own code, an
 * address that is not one, or the space being out of reach.
 *
 * @param c - The request's context.
 * @param error - What was thrown.
 */
export function connectionFailure(c: Context, error: unknown): Response {
  if (error instanceof RemotePairingBusyError) {
    // Its own code, so a client can tell "another check of this connection is in
    // flight" (keep waiting) from a real refusal: every open window polls.
    return problem(c, 'pairing_busy', {
      detail: 'This pairing is still finishing. Try again in a moment.',
    });
  }
  if (error instanceof RemoteCommunitySelectionRequiredError) {
    return problem(c, 'space_choice_required', {
      detail: 'That address has more than one space. Use one space’s own link.',
    });
  }
  if (error instanceof RemoteCommunityNameNotFoundError) {
    return problem(c, 'space_name_not_found', {
      detail: 'No space uses that short address there. Check the spelling.',
    });
  }
  if (error instanceof RemoteCommunityRateLimitedError) {
    // The host's own wait, passed on so the person is told how long, not left to guess.
    const { retryAfterSeconds } = error;
    return problem(c, 'rate_limited', {
      detail: 'This DorkOS tried that space too often. Wait, then try again.',
      ...(retryAfterSeconds !== undefined ? { retryAfterMs: retryAfterSeconds * 1000 } : {}),
    });
  }
  if (error instanceof RemoteCommunityUpgradeRequiredError) {
    return problem(c, 'space_server_outdated', {
      detail: 'This space’s server is too old to connect. Ask whoever runs it to update it.',
    });
  }
  if (error instanceof RemoteConnectionAuthorizationError) return reconnectRequired(c);
  if (error instanceof RemoteConnectionNotFoundError) return connectionNotFound(c);
  if (error instanceof PinnedOriginError) {
    if (error.code === 'INVALID_ORIGIN' || error.code === 'UNSAFE_ADDRESS') {
      return problem(c, 'invalid_request', { detail: 'Enter an accessible HTTPS space address.' });
    }
    logger.warn('[Communities] A space refused a connection request', { code: error.code });
    return problem(c, 'upstream_unavailable', {
      detail: 'The space couldn’t finish connecting. Try again.',
    });
  }
  logger.warn('[Communities] A space connection failed', logError(error));
  return problem(c, 'upstream_unavailable', {
    detail: 'The space can’t be reached right now. Try again.',
  });
}
