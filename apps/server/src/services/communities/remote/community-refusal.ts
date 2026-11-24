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
 * @module services/communities/remote/community-refusal
 */
import {
  CommunityRoomNotFoundError,
  CommunityUnsupportedError,
  StaleCommunityCursorError,
} from '@dorkos/shared/community-adapter';
import type { ProblemCode } from '@dorkos/shared/problem';
import { PinnedHttpError } from './pinned-origin.js';
import { CommunityDeletedError, CommunityTakenDownError } from './remote-community-adapter.js';

/** A local answer for one refused Community request. */
export interface CommunityRefusal {
  /** HTTP status in the same class the Community used. */
  status: number;
  /** The problem code a client branches on (DOR-4979): never the Community's own code. */
  code: ProblemCode;
  /** Plain wording safe to show a person: one fixed sentence, never the Community's text. */
  detail: string;
  /** Whole seconds until the person can try again, sent on as `Retry-After`. Slow mode only. */
  retryAfterSeconds?: number;
}

/** The action being attempted, when it changes what a refusal means. */
export type CommunityRefusalAction = 'enroll-agent' | 'rename' | 'accept-rules' | 'report';

/** What a Community's `409 STATE_CONFLICT` means for a person's own conduct (DOR-2770). */
const CONDUCT_CONFLICTS: Partial<Record<CommunityRefusalAction, CommunityRefusal>> = {
  rename: {
    status: 409,
    code: 'name_taken',
    detail: 'That name is taken in this space. Try another.',
  },
  'accept-rules': {
    status: 412,
    code: 'precondition_failed',
    detail: 'The rules changed. Read them again first.',
  },
  report: { status: 409, code: 'conflict', detail: 'You can’t report this message.' },
};

const NOT_FOUND: CommunityRefusal = {
  status: 404,
  code: 'not_found',
  detail: 'That isn’t available in this space.',
};

/** The channel moved on since it was loaded: "changed since you looked", so 412. */
const STALE: CommunityRefusal = {
  status: 412,
  code: 'precondition_failed',
  detail: 'This channel changed since it was loaded. Refresh to catch up.',
};

const DELETED: CommunityRefusal = {
  status: 410,
  code: 'space_deleted',
  detail: 'This space was deleted.',
};

const TAKEN_DOWN: CommunityRefusal = {
  status: 423,
  code: 'space_taken_down',
  detail: 'This space was taken down.',
};

/**
 * The refusal for a community this installation already recorded as gone (DOR-2575), without
 * asking it again: the same answer a request to it would get, so a person's send refused before
 * it leaves this computer reads exactly like one the Community refused.
 *
 * @param lifecycle - The recorded lifecycle.
 * @returns The gone refusal, or `null` for any lifecycle that is not gone.
 */
export function communityGoneRefusal(lifecycle: string | undefined): CommunityRefusal | null {
  if (lifecycle === 'deleted') return DELETED;
  if (lifecycle === 'taken_down') return TAKEN_DOWN;
  return null;
}

/** The caps a Community sets, as `409` codes, in the app's own words. */
const LIMIT_MESSAGES: Partial<Record<string, string>> = {
  AGENT_LIMIT_REACHED: 'You’ve reached your agent limit in this space. Remove one to add another.',
  MEMBER_LIMIT_REACHED: 'This space is full. Ask its owner to make room.',
  STORAGE_LIMIT_REACHED: 'This space is out of file space.',
};

/** A post the space's moderation holds, by the Community's code (DOR-2768). */
const MODERATION_HOLDS: Partial<Record<string, CommunityRefusal>> = {
  COMMUNITY_MUTED: {
    status: 403,
    code: 'space_muted',
    detail: 'You’re muted in this space for now.',
  },
  COMMUNITY_SLOW_MODE: {
    status: 429,
    code: 'space_slow_mode',
    detail: 'This channel is in slow mode. Wait a moment, then post again.',
  },
  COMMUNITY_RULES_NOT_ACCEPTED: {
    status: 403,
    code: 'space_rules_not_accepted',
    detail: 'Accept this space’s rules before you post.',
  },
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
  // Before "not found" and before any 410: the whole community is gone, which is neither a
  // missing room nor a stale cursor (DOR-2334).
  if (
    error instanceof CommunityDeletedError ||
    (error instanceof PinnedHttpError && error.remoteCode === 'COMMUNITY_DELETED')
  )
    return DELETED;
  // Before the other 423s, which read as "archived".
  if (
    error instanceof CommunityTakenDownError ||
    (error instanceof PinnedHttpError && error.remoteCode === 'COMMUNITY_TAKEN_DOWN')
  )
    return TAKEN_DOWN;
  if (error instanceof CommunityRoomNotFoundError) return NOT_FOUND;
  if (error instanceof StaleCommunityCursorError) return STALE;
  if (error instanceof CommunityUnsupportedError)
    return {
      status: 409,
      code: 'space_unsupported',
      detail: 'This space doesn’t support that.',
    };
  if (!(error instanceof PinnedHttpError)) return null;
  const { status, remoteCode } = error;
  // A suspension arrives as 503, but it is the Community's decision, not an outage.
  if (remoteCode === 'COMMUNITY_SUSPENDED')
    return { status: 423, code: 'space_suspended', detail: 'This space is suspended.' };
  if (status < 400 || status >= 500) return null;
  // The space's moderation holds this person's posts: say which hold, so they know what to do.
  const held = remoteCode ? MODERATION_HOLDS[remoteCode] : undefined;
  if (held && remoteCode === 'COMMUNITY_SLOW_MODE' && error.retryAfterSeconds)
    return { ...held, retryAfterSeconds: error.retryAfterSeconds };
  if (held) return held;
  const conflict = action && status === 409 ? CONDUCT_CONFLICTS[action] : undefined;
  if (conflict && remoteCode === 'STATE_CONFLICT') return conflict;
  switch (status) {
    case 401:
    case 403:
      return { status: 403, code: 'forbidden', detail: 'The space didn’t allow that.' };
    case 404:
      return NOT_FOUND;
    case 409: {
      // A cap is a state the person can act on: name which one.
      const limit = remoteCode ? LIMIT_MESSAGES[remoteCode] : undefined;
      if (limit) return { status: 409, code: 'space_limit_reached', detail: limit };
      if (remoteCode === 'NESTED_THREAD')
        return {
          status: 409,
          code: 'conflict',
          detail: 'Replies can only go on a top-level message.',
        };
      if (remoteCode === 'COMMUNITY_UNAVAILABLE')
        return { status: 409, code: 'space_not_open', detail: 'This space isn’t open right now.' };
      // Any other clash means the space moved on since this was read: 412, as everywhere else.
      return {
        status: 412,
        code: 'precondition_failed',
        detail: 'That no longer matches the space. Refresh and try again.',
      };
    }
    case 410:
      return STALE;
    case 413:
      return { status: 413, code: 'request_too_large', detail: 'That’s too large for this space.' };
    case 415:
      return {
        status: 415,
        code: 'unsupported_media_type',
        detail: 'This space doesn’t accept that type of file.',
      };
    case 423:
      if (remoteCode === 'COMMUNITY_HELD')
        return {
          status: 423,
          code: 'space_on_hold',
          detail: 'This space is on hold. You can read it, but no one can post.',
        };
      return remoteCode === 'COMMUNITY_DELETION_PENDING'
        ? { status: 423, code: 'space_read_only', detail: 'This space is being deleted.' }
        : {
            status: 423,
            code: 'space_read_only',
            detail: 'This space is archived, so it’s read-only.',
          };
    case 429:
      // Community servers from before DOR-2254 answered the agent cap with 429 RATE_LIMITED.
      // Current servers answer 409 AGENT_LIMIT_REACHED (above); this keeps older ones readable.
      return action === 'enroll-agent'
        ? {
            status: 409,
            code: 'space_limit_reached',
            detail:
              'You’ve reached this space’s limit on active agents. Remove one to add another.',
          }
        : { status: 429, code: 'rate_limited', detail: 'This space is busy. Try again later.' };
    default:
      // The Community's own status, kept in the 4xx class it used.
      return { status, code: 'invalid_request', detail: 'The space didn’t accept that request.' };
  }
}
