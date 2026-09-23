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

const community = 'remote_a' as CommunityRef;

describe('communityRefusal', () => {
  it.each([
    [new PinnedHttpError(400, 'STATE_CONFLICT'), 400, 'COMMUNITY_REJECTED'],
    [new PinnedHttpError(401, 'UNAUTHENTICATED'), 403, 'COMMUNITY_ACCESS_DENIED'],
    [new PinnedHttpError(403, 'FORBIDDEN'), 403, 'COMMUNITY_ACCESS_DENIED'],
    [new PinnedHttpError(404, 'NOT_FOUND'), 404, 'COMMUNITY_NOT_FOUND'],
    [new PinnedHttpError(409, 'STATE_CONFLICT'), 409, 'COMMUNITY_CONFLICT'],
    [new PinnedHttpError(410, 'CURSOR_STALE'), 410, 'COMMUNITY_CURSOR_STALE'],
    [new PinnedHttpError(413, 'ATTACHMENT_TOO_LARGE'), 413, 'COMMUNITY_TOO_LARGE'],
    [new PinnedHttpError(415, 'UNSUPPORTED_ATTACHMENT_TYPE'), 415, 'COMMUNITY_UNSUPPORTED_FILE'],
    [new PinnedHttpError(423, 'COMMUNITY_ARCHIVED'), 423, 'COMMUNITY_READ_ONLY'],
    [new PinnedHttpError(429, 'RATE_LIMITED'), 429, 'COMMUNITY_LIMIT_REACHED'],
    [new PinnedHttpError(422), 422, 'COMMUNITY_REJECTED'],
    [new PinnedHttpError(503, 'COMMUNITY_SUSPENDED'), 423, 'COMMUNITY_SUSPENDED'],
    [new CommunityRoomNotFoundError(community, 'room-a'), 404, 'COMMUNITY_NOT_FOUND'],
    [new StaleCommunityCursorError(community, 'room-a', 'stale'), 410, 'COMMUNITY_CURSOR_STALE'],
    [
      new CommunityUnsupportedError(community, 'roomAdmin', 'addMember'),
      409,
      'COMMUNITY_UNSUPPORTED',
    ],
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
      'You’ve reached your agent limit in this community. Remove one to add another.',
    ],
    ['MEMBER_LIMIT_REACHED', 'This community is full. Ask its owner to make room.'],
    ['STORAGE_LIMIT_REACHED', 'This community is out of file space.'],
  ] as const)('names the %s cap as a state, not a conflict or an outage', (code, error) => {
    // Purpose: a Community answers a cap with 409 and its own code; fails if that reads as a
    // generic conflict ("refresh and try again") that no refresh can fix.
    expect(communityRefusal(new PinnedHttpError(409, code))).toEqual({
      status: 409,
      code: 'COMMUNITY_LIMIT_REACHED',
      error,
    });
  });

  it('names the agent limit when adding an agent hits a 429', () => {
    expect(communityRefusal(new PinnedHttpError(429, 'RATE_LIMITED'), 'enroll-agent')).toEqual({
      status: 429,
      code: 'COMMUNITY_LIMIT_REACHED',
      error: 'You’ve reached this community’s limit on active agents. Remove one to add another.',
    });
    expect(communityRefusal(new PinnedHttpError(429, 'RATE_LIMITED'))?.error).toBe(
      'This community’s limit was reached. Try again later.'
    );
  });

  it('answers a hidden private channel exactly like a missing one', () => {
    const missing = communityRefusal(new PinnedHttpError(404, 'NOT_FOUND'));
    expect(communityRefusal(new CommunityRoomNotFoundError(community, 'private-room'))).toEqual(
      missing
    );
  });

  it('tells an archived community apart from one being deleted', () => {
    expect(communityRefusal(new PinnedHttpError(423, 'COMMUNITY_ARCHIVED'))?.error).toBe(
      'This community is archived, so it’s read-only.'
    );
    expect(communityRefusal(new PinnedHttpError(423, 'COMMUNITY_DELETION_PENDING'))?.error).toBe(
      'This community is being deleted.'
    );
  });

  it('words a reply-on-a-reply and a closed community specifically', () => {
    expect(communityRefusal(new PinnedHttpError(409, 'NESTED_THREAD'))?.error).toBe(
      'Replies can only go on a top-level message.'
    );
    expect(communityRefusal(new PinnedHttpError(409, 'COMMUNITY_UNAVAILABLE'))?.error).toBe(
      'This community isn’t open right now.'
    );
  });
});
