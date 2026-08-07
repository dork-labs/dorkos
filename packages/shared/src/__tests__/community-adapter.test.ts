import { describe, it, expect } from 'vitest';
import { CommunityMemberSchema, LOCAL_COMMUNITY } from '../community-adapter.js';

/** A member row with every required field and none of the optional ones. */
const BARE_MEMBER = {
  community: LOCAL_COMMUNITY,
  memberId: '01JZMEMBER',
  kind: 'human' as const,
  displayName: 'Dorian',
  handle: 'dorian',
  role: null,
  ownerMemberId: null,
  joinedAt: '2026-08-06T12:00:00.000Z',
};

describe('CommunityMemberSchema render cache', () => {
  it('parses a member with no photo, which is every member today', () => {
    const parsed = CommunityMemberSchema.parse(BARE_MEMBER);
    expect(parsed.imageUrl).toBeUndefined();
  });

  it('carries a photo beside the emoji rather than instead of it', () => {
    const parsed = CommunityMemberSchema.parse({
      ...BARE_MEMBER,
      emoji: '🐙',
      color: '#6366f1',
      imageUrl: '/api/profile/avatar/01JZMEMBER?v=abc123',
    });
    expect(parsed.imageUrl).toBe('/api/profile/avatar/01JZMEMBER?v=abc123');
    expect(parsed.emoji).toBe('🐙');
  });

  it('takes an absolute photo URL, because a remote backend hosts its own', () => {
    // The port is the seam a non-local community arrives through, so the field
    // has to hold a URL this machine did not mint. A schema that only accepted
    // a server-relative path would make a remote roster's faces unrepresentable.
    const parsed = CommunityMemberSchema.parse({
      ...BARE_MEMBER,
      imageUrl: 'https://cdn.example/avatars/01JZMEMBER.png',
    });
    expect(parsed.imageUrl).toBe('https://cdn.example/avatars/01JZMEMBER.png');
  });
});
