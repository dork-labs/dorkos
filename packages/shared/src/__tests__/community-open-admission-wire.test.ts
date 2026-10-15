import { describe, expect, it } from 'vitest';
import {
  CommunityAdminAdmissionPolicySchema,
  CommunityAdminSettingsUpdateRequestSchema,
} from '../community-admin-wire.js';
import {
  CommunityExportChannelRowSchema,
  CommunityWireBanRequestSchema,
  CommunityWireBanSchema,
  CommunityWireChannelSchema,
  CommunityWireChannelUpdateRequestSchema,
} from '../community-wire.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('open admission, bans and auto-join on the Community wire', () => {
  it('adds `open` to the admission policy without dropping either older value', () => {
    // Purpose: fails if `open` is missing (an open space could not be read) or if the change
    // was not additive (a reader of `invite_only` or `closed` would break).
    for (const policy of ['invite_only', 'closed', 'open'])
      expect(CommunityAdminAdmissionPolicySchema.parse(policy)).toBe(policy);
    expect(CommunityAdminSettingsUpdateRequestSchema.parse({ admissionPolicy: 'open' })).toEqual({
      admissionPolicy: 'open',
    });
    expect(CommunityAdminAdmissionPolicySchema.safeParse('public').success).toBe(false);
  });

  it('keeps auto-join off the channel projection older installations parse strictly', () => {
    // Purpose: fails if `autoJoin` is added to the shared channel projection, which an older
    // DorkOS installation parses strictly and would then refuse.
    const channel = {
      id: ID,
      name: 'welcome',
      description: null,
      visibility: 'public',
      archived: false,
      createdAt: '2026-10-07T00:00:00.000Z',
      joined: true,
      unreadCount: 0,
    };
    expect(CommunityWireChannelSchema.safeParse({ ...channel, autoJoin: true }).success).toBe(
      false
    );
    expect(CommunityWireChannelUpdateRequestSchema.parse({ autoJoin: true })).toEqual({
      autoJoin: true,
    });
  });

  it('reads an export channel row with or without auto_join', () => {
    // Purpose: fails if an archive written before auto-join existed stops importing.
    const row = {
      id: ID,
      name: 'welcome',
      description: null,
      visibility: 'public',
      archived: false,
      created_at: '2026-10-07T00:00:00.000Z',
    };
    expect(CommunityExportChannelRowSchema.parse(row)).toEqual(row);
    expect(CommunityExportChannelRowSchema.parse({ ...row, auto_join: true }).auto_join).toBe(true);
  });

  it('never carries an email or its key on a ban', () => {
    // Purpose: fails if the ban projection starts accepting the banned person's email or its hash.
    const ban = {
      id: ID,
      memberId: ID,
      displayName: 'Sam',
      handle: 'sam',
      reason: null,
      createdAt: '2026-10-07T00:00:00.000Z',
    };
    expect(CommunityWireBanSchema.parse(ban)).toEqual(ban);
    expect(CommunityWireBanSchema.safeParse({ ...ban, emailHash: 'a'.repeat(64) }).success).toBe(
      false
    );
    expect(CommunityWireBanRequestSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(
      false
    );
    expect(CommunityWireBanRequestSchema.parse({})).toEqual({});
  });
});
