/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import {
  CommunityRoomNotFoundError,
  CommunityUnsupportedError,
  StaleCommunityCursorError,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import {
  PinnedHttpError,
  PinnedOriginError,
} from '../../services/communities/remote/pinned-origin.js';
import { communityRefusal } from '../remote-community-refusal.js';
import {
  CommunityDeletedError,
  CommunityTakenDownError,
} from '../../services/communities/remote/remote-community-adapter.js';

const community = 'remote_a' as CommunityRef;

describe('communityRefusal', () => {
  it.each([
    [new PinnedHttpError(400, 'STATE_CONFLICT'), 400, 'invalid_request'],
    [new PinnedHttpError(401, 'UNAUTHENTICATED'), 403, 'forbidden'],
    [new PinnedHttpError(403, 'FORBIDDEN'), 403, 'forbidden'],
    [new PinnedHttpError(404, 'NOT_FOUND'), 404, 'not_found'],
    // Changed since it was read: 412, as everywhere else (DOR-4979).
    [new PinnedHttpError(409, 'STATE_CONFLICT'), 412, 'precondition_failed'],
    [new PinnedHttpError(410, 'CURSOR_STALE'), 412, 'precondition_failed'],
    [new PinnedHttpError(410), 412, 'precondition_failed'],
    // DOR-2334: a deleted community is neither a stale cursor nor a missing room.
    [new PinnedHttpError(410, 'COMMUNITY_DELETED'), 410, 'space_deleted'],
    [new CommunityDeletedError(community, 'room-a'), 410, 'space_deleted'],
    // DOR-2334: taken down by the host, which is not "archived" like the other 423s.
    [new PinnedHttpError(423, 'COMMUNITY_TAKEN_DOWN'), 423, 'space_taken_down'],
    [new CommunityTakenDownError(community, 'room-a'), 423, 'space_taken_down'],
    [new PinnedHttpError(413, 'ATTACHMENT_TOO_LARGE'), 413, 'request_too_large'],
    [new PinnedHttpError(415, 'UNSUPPORTED_ATTACHMENT_TYPE'), 415, 'unsupported_media_type'],
    [new PinnedHttpError(423, 'COMMUNITY_ARCHIVED'), 423, 'space_read_only'],
    [new PinnedHttpError(429, 'RATE_LIMITED'), 429, 'rate_limited'],
    [new PinnedHttpError(422), 422, 'invalid_request'],
    // DOR-2768: the space's moderation holds the post, and says which hold.
    [new PinnedHttpError(403, 'COMMUNITY_MUTED'), 403, 'space_muted'],
    [new PinnedHttpError(429, 'COMMUNITY_SLOW_MODE'), 429, 'space_slow_mode'],
    [new PinnedHttpError(403, 'COMMUNITY_RULES_NOT_ACCEPTED'), 403, 'space_rules_not_accepted'],
    [new PinnedHttpError(503, 'COMMUNITY_SUSPENDED'), 423, 'space_suspended'],
    [new CommunityRoomNotFoundError(community, 'room-a'), 404, 'not_found'],
    [new StaleCommunityCursorError(community, 'room-a', 'stale'), 412, 'precondition_failed'],
    [new CommunityUnsupportedError(community, 'roomAdmin', 'addMember'), 409, 'space_unsupported'],
  ])('passes a refusal on in its status class: %s', (error, status, code) => {
    expect(communityRefusal(error)).toMatchObject({ status, code });
  });

  it.each([
    ['a 5xx answer', new PinnedHttpError(500)],
    ['a 502 answer with a code', new PinnedHttpError(502, 'UNAVAILABLE')],
    ['a 503 answer that is not a suspension', new PinnedHttpError(503)],
    ['an unreachable host', new PinnedOriginError('REMOTE_UNAVAILABLE')],
    ['an unparseable answer', new PinnedOriginError('REMOTE_RESPONSE')],
    ['an unknown error', new Error('boom')],
  ])('leaves %s as an outage', (_label, error) => {
    expect(communityRefusal(error)).toBeNull();
  });

  it.each([
    [
      'AGENT_LIMIT_REACHED',
      'You’ve reached your agent limit in this space. Remove one to add another.',
    ],
    ['MEMBER_LIMIT_REACHED', 'This space is full. Ask its owner to make room.'],
    ['STORAGE_LIMIT_REACHED', 'This space is out of file space.'],
  ] as const)('names the %s cap as a state, not a conflict or an outage', (code, detail) => {
    // Purpose: a Community answers a cap with 409 and its own code; fails if that reads as a
    // generic conflict ("refresh and try again") that no refresh can fix.
    expect(communityRefusal(new PinnedHttpError(409, code))).toEqual({
      status: 409,
      code: 'space_limit_reached',
      detail,
    });
  });

  it('names the agent limit when adding an agent hits a 429', () => {
    expect(communityRefusal(new PinnedHttpError(429, 'RATE_LIMITED'), 'enroll-agent')).toEqual({
      status: 409,
      code: 'space_limit_reached',
      detail: 'You’ve reached this space’s limit on active agents. Remove one to add another.',
    });
    expect(communityRefusal(new PinnedHttpError(429, 'RATE_LIMITED'))?.detail).toBe(
      'This space is busy. Try again later.'
    );
  });

  it('answers a hidden private channel exactly like a missing one', () => {
    const missing = communityRefusal(new PinnedHttpError(404, 'NOT_FOUND'));
    expect(communityRefusal(new CommunityRoomNotFoundError(community, 'private-room'))).toEqual(
      missing
    );
  });

  it('says a held community is on hold by its host, not archived', () => {
    // Purpose: a hold is the host's decision and the owner can still export; calling it
    // "archived" would send people to an owner who cannot lift it.
    expect(communityRefusal(new PinnedHttpError(423, 'COMMUNITY_HELD'))).toEqual({
      status: 423,
      code: 'space_on_hold',
      detail: 'This space is on hold. You can read it, but no one can post.',
    });
  });

  it('tells an archived community apart from one being deleted', () => {
    expect(communityRefusal(new PinnedHttpError(423, 'COMMUNITY_ARCHIVED'))?.detail).toBe(
      'This space is archived, so it’s read-only.'
    );
    expect(communityRefusal(new PinnedHttpError(423, 'COMMUNITY_DELETION_PENDING'))?.detail).toBe(
      'This space is being deleted.'
    );
  });

  it('words a reply-on-a-reply and a closed community specifically', () => {
    expect(communityRefusal(new PinnedHttpError(409, 'NESTED_THREAD'))?.code).toBe(
      'reply_on_top_level_only'
    );
    expect(communityRefusal(new PinnedHttpError(409, 'NESTED_THREAD'))?.detail).toBe(
      'Replies can only go on a top-level message.'
    );
    expect(communityRefusal(new PinnedHttpError(409, 'COMMUNITY_UNAVAILABLE'))?.detail).toBe(
      'This space isn’t open right now.'
    );
  });
});
