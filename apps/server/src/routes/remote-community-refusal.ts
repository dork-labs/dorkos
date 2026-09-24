/**
 * Turn a Community's refusal into a local response a person can act on.
 *
 * A Community that answers "no" is not down. Its 4xx answers are passed on
 * with the same status class and plain wording written here, so a person sees
 * "limit reached" instead of "unavailable". Only transport failures and 5xx
 * answers stay outages. The Community's own message text is never forwarded:
 * it comes from a server this install does not control, so only its status
 * and closed-enum error code are read.
 *
 * Not-found and forbidden answers keep exactly the shape the Community used.
 * A Community answers a private channel a caller has not joined the same way
 * as a channel that does not exist, and passing its status through unchanged
 * keeps that true here.
 *
 * @module routes/remote-community-refusal
 */
import {
  CommunityRoomNotFoundError,
  CommunityUnsupportedError,
  StaleCommunityCursorError,
} from '@dorkos/shared/community-adapter';
import { PinnedHttpError } from '../services/communities/remote/pinned-origin.js';

/** A local answer for one refused Community request. */
export interface CommunityRefusal {
  /** HTTP status in the same class the Community used. */
  status: number;
  /** Stable local code a client can branch on. */
  code: string;
  /** Plain wording safe to show a person. */
  error: string;
}

/** The action being attempted, when it changes what a refusal means. */
export type CommunityRefusalAction = 'enroll-agent';

const NOT_FOUND: CommunityRefusal = {
  status: 404,
  code: 'COMMUNITY_NOT_FOUND',
  error: 'That isn’t available in this community.',
};

const STALE: CommunityRefusal = {
  status: 410,
  code: 'COMMUNITY_CURSOR_STALE',
  error: 'This channel changed since it was loaded. Refresh to catch up.',
};

const REJECTED = 'The community didn’t accept that request.';

/** The caps a Community sets, as `409` codes, in the app's own words. */
const LIMIT_MESSAGES: Partial<Record<string, string>> = {
  AGENT_LIMIT_REACHED:
    'You’ve reached your agent limit in this community. Remove one to add another.',
  MEMBER_LIMIT_REACHED: 'This community is full. Ask its owner to make room.',
  STORAGE_LIMIT_REACHED: 'This community is out of file space.',
};

/**
 * Map a refused Community request to a local answer.
 *
 * @param error - What the Community adapter threw.
 * @param action - The action being attempted, when a status means something
 *   specific for it (a 429 while adding an agent is the agent limit).
 * @returns The local answer, or `null` when this is not a refusal: the
 *   Community could not be reached or failed on its side.
 */
export function communityRefusal(
  error: unknown,
  action?: CommunityRefusalAction
): CommunityRefusal | null {
  if (error instanceof CommunityRoomNotFoundError) return NOT_FOUND;
  if (error instanceof StaleCommunityCursorError) return STALE;
  if (error instanceof CommunityUnsupportedError)
    return {
      status: 409,
      code: 'COMMUNITY_UNSUPPORTED',
      error: 'This community doesn’t support that.',
    };
  if (!(error instanceof PinnedHttpError)) return null;
  const { status, remoteCode } = error;
  // A suspension arrives as 503, but it is the Community's decision, not an outage.
  if (remoteCode === 'COMMUNITY_SUSPENDED')
    return { status: 423, code: 'COMMUNITY_SUSPENDED', error: 'This community is suspended.' };
  if (status < 400 || status >= 500) return null;
  switch (status) {
    case 401:
    case 403:
      return {
        status: 403,
        code: 'COMMUNITY_ACCESS_DENIED',
        error: 'The community didn’t allow that.',
      };
    case 404:
      return NOT_FOUND;
    case 409: {
      // A cap is a state the person can act on: name which one.
      const limit = remoteCode ? LIMIT_MESSAGES[remoteCode] : undefined;
      if (limit) return { status: 409, code: 'COMMUNITY_LIMIT_REACHED', error: limit };
      if (remoteCode === 'NESTED_THREAD')
        return {
          status: 409,
          code: 'COMMUNITY_CONFLICT',
          error: 'Replies can only go on a top-level message.',
        };
      if (remoteCode === 'COMMUNITY_UNAVAILABLE')
        return {
          status: 409,
          code: 'COMMUNITY_CONFLICT',
          error: 'This community isn’t open right now.',
        };
      return {
        status: 409,
        code: 'COMMUNITY_CONFLICT',
        error: 'That no longer matches the community. Refresh and try again.',
      };
    }
    case 410:
      return STALE;
    case 413:
      return {
        status: 413,
        code: 'COMMUNITY_TOO_LARGE',
        error: 'That’s too large for this community.',
      };
    case 415:
      return {
        status: 415,
        code: 'COMMUNITY_UNSUPPORTED_FILE',
        error: 'This community doesn’t accept that type of file.',
      };
    case 423:
      if (remoteCode === 'COMMUNITY_HELD')
        return {
          status: 423,
          code: 'COMMUNITY_HELD',
          error:
            'The host has put this community on hold. You can read it, but no one can post. Its owner can still export it.',
        };
      return remoteCode === 'COMMUNITY_DELETION_PENDING'
        ? { status: 423, code: 'COMMUNITY_READ_ONLY', error: 'This community is being deleted.' }
        : {
            status: 423,
            code: 'COMMUNITY_READ_ONLY',
            error: 'This community is archived, so it’s read-only.',
          };
    case 429:
      // Community servers from before DOR-2254 answered the agent cap with 429 RATE_LIMITED.
      // Current servers answer 409 AGENT_LIMIT_REACHED (above); this keeps older ones readable.
      return {
        status: 429,
        code: 'COMMUNITY_LIMIT_REACHED',
        error:
          action === 'enroll-agent'
            ? 'You’ve reached this community’s limit on active agents. Remove one to add another.'
            : 'This community’s limit was reached. Try again later.',
      };
    default:
      return { status, code: 'COMMUNITY_REJECTED', error: REJECTED };
  }
}
