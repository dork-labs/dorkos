import { describe, it, expect } from 'vitest';
import {
  CommunityMemberSchema,
  CommunityWarningSchema,
  LOCAL_COMMUNITY,
} from '../community-adapter.js';
import { RoomListWarningSchema } from '../room-schemas.js';

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

describe('RoomListWarningSchema restates CommunityWarningSchema', () => {
  it('carries exactly the same fields, so the restatement cannot drift', () => {
    // `room-schemas.ts` restates this shape rather than importing it, because
    // the port already imports `room-schemas.ts` and a back-import would put two
    // top-level Zod modules in a cycle. That is a sound reason to duplicate and
    // no reason at all to let the two diverge — the wire is the same object.
    const fields = Object.keys(CommunityWarningSchema.shape).sort();
    // Asserted so the comparison below cannot pass by both sides being empty —
    // the failure mode of every shape-equality test.
    expect(fields).toEqual(['community', 'label', 'message']);
    expect(Object.keys(RoomListWarningSchema.shape).sort()).toEqual(fields);
  });

  it('accepts a CommunityWarning unchanged, brand and all', () => {
    // The compile-time brand on `community` is gone by the time this is JSON, so
    // a warning the aggregation produced must parse here with no mapping step.
    const warning = { community: LOCAL_COMMUNITY, label: 'This machine', message: 'All quiet.' };
    expect(RoomListWarningSchema.parse(warning)).toEqual(warning);
  });
});
