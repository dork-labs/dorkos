import { describe, expect, it } from 'vitest';
import {
  CommunityCapabilitiesSchema,
  CommunityReadContextSchema,
  ListCommunityEntriesOptsSchema,
  PostCommunityEntryInputSchema,
} from '../../community-adapter.js';
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireChannelSchema,
  CommunityWireMemberSchema,
  CommunityWireAgentSchema,
  CommunityWireAgentEnrollRequestSchema,
  CommunityWireMemberRoleUpdateRequestSchema,
  CommunityWireEntrySchema,
  CommunityWireEntryPostRequestSchema,
  CommunityWireEntryPostResponseSchema,
  CommunityWireEntryPageSchema,
  CommunityWireEntryRemoveResponseSchema,
  CommunityWireErrorSchema,
  CommunityWireAuthOptionsSchema,
} from '../../community-wire.js';

describe('community server port additions', () => {
  it('bounds post identity, idempotency and attachment references', () => {
    expect(
      PostCommunityEntryInputSchema.safeParse({
        text: 'hello',
        actingMemberId: 'agent-1',
        idempotencyKey: 'retry-1',
        attachmentIds: ['attachment-1'],
      }).success
    ).toBe(true);
    expect(
      PostCommunityEntryInputSchema.safeParse({ text: 'hello', attachmentIds: Array(9).fill('a') })
        .success
    ).toBe(false);
    expect(
      PostCommunityEntryInputSchema.safeParse({ text: 'hello', actingMemberId: '' }).success
    ).toBe(false);
    expect(
      PostCommunityEntryInputSchema.safeParse({ text: 'hello', idempotencyKey: '' }).success
    ).toBe(false);
  });

  it('declares browser-approved credentials and distinct agent/file capabilities', () => {
    const base = {
      type: 'remote',
      roomList: 'push',
      roomAddressing: 'opaque-id',
      canPost: true,
      roomAdmin: true,
      roles: {
        supported: true,
        default: 'member',
        values: [{ id: 'member', label: 'Member', administers: false }],
      },
      admission: 'invite',
      invite: 'room',
      agentAdmission: 'owner-vouched',
      readCursor: 'server',
      responseMode: false,
      threadDepth: 1,
      signals: 'none',
      credential: 'browser-approved',
      agentActing: true,
      attachments: true,
      conduct: true,
      reports: true,
    };
    expect(CommunityCapabilitiesSchema.safeParse(base).success).toBe(true);
    expect(CommunityCapabilitiesSchema.safeParse({ ...base, credential: 'random' }).success).toBe(
      false
    );
  });

  it('names an explicit agent for reads without carrying a credential', () => {
    expect(CommunityReadContextSchema.parse({ actingMemberId: 'owned-agent' })).toEqual({
      actingMemberId: 'owned-agent',
    });
    expect(CommunityReadContextSchema.safeParse({ actingMemberId: '' }).success).toBe(false);
    expect(
      CommunityReadContextSchema.safeParse({ actingMemberId: 'owned-agent', token: 'secret' })
        .success
    ).toBe(false);
    expect(
      ListCommunityEntriesOptsSchema.safeParse({ actingMemberId: 'owned-agent', limit: 50 }).success
    ).toBe(true);
  });

  it('keeps HTTP conversation DTOs strict and free of private fields', () => {
    expect(
      CommunityWireAuthOptionsSchema.parse({
        google: false,
        github: true,
        oidc: null,
        minimumAge: null,
      })
    ).toEqual({
      google: false,
      github: true,
      oidc: null,
      minimumAge: null,
      allowedCountries: null,
      emailLinks: false,
    });
    // Allowed countries cross as a non-empty list of two-capital-letter codes, or null.
    for (const [allowedCountries, ok] of [
      [['US'], true],
      [['US', 'CA'], true],
      [null, true],
      [[], false],
      [['us'], false],
      [['USA'], false],
      ['US', false],
    ] as const)
      expect(
        CommunityWireAuthOptionsSchema.safeParse({
          google: false,
          github: false,
          oidc: null,
          minimumAge: null,
          allowedCountries,
        }).success,
        JSON.stringify(allowedCountries)
      ).toBe(ok);
    // A Community from before mailed links reads as having none; a newer one says so.
    expect(
      CommunityWireAuthOptionsSchema.parse({
        google: false,
        github: false,
        oidc: null,
        minimumAge: null,
        emailLinks: true,
      }).emailLinks
    ).toBe(true);
    // A minimum age crosses as a whole number inside the host's allowed range, never outside it.
    for (const [minimumAge, ok] of [
      [18, true],
      [13, true],
      [21, true],
      [12, false],
      [22, false],
      [17.5, false],
    ] as const)
      expect(
        CommunityWireAuthOptionsSchema.safeParse({
          google: false,
          github: false,
          oidc: null,
          minimumAge,
        }).success
      ).toBe(ok);
    expect(
      CommunityWireAuthOptionsSchema.parse({
        google: false,
        github: false,
        oidc: { label: 'Example sign-in', mark: null },
        minimumAge: null,
      }).oidc
    ).toEqual({ label: 'Example sign-in', mark: null });
    // The button may carry the DorkOS mark, and no other named mark.
    expect(
      CommunityWireAuthOptionsSchema.parse({
        google: false,
        github: false,
        oidc: { label: 'DorkOS', mark: 'dorkos' },
        minimumAge: null,
      }).oidc
    ).toEqual({ label: 'DorkOS', mark: 'dorkos' });
    for (const mark of ['google', 'https://example.com/logo.svg', undefined])
      expect(
        CommunityWireAuthOptionsSchema.safeParse({
          google: false,
          github: false,
          oidc: { label: 'Example sign-in', mark },
          minimumAge: null,
        }).success,
        String(mark)
      ).toBe(false);
    // Only the button text and mark cross the wire: never the issuer, client ID or secret.
    expect(
      CommunityWireAuthOptionsSchema.safeParse({
        google: false,
        github: false,
        oidc: { label: 'Example sign-in', mark: null, clientId: 'private' },
        minimumAge: null,
      }).success
    ).toBe(false);
    expect(
      CommunityWireAuthOptionsSchema.safeParse({
        google: true,
        github: false,
        oidc: null,
        minimumAge: null,
        clientSecret: 'private',
      }).success
    ).toBe(false);
    const channel = {
      id: 'channel-1',
      name: 'General',
      description: null,
      visibility: 'public',
      archived: false,
      createdAt: '2026-09-16T00:00:00.000Z',
      joined: true,
      unreadCount: 0,
    };
    expect(CommunityWireChannelSchema.parse(channel)).toEqual(channel);
    expect(CommunityWireChannelSchema.safeParse({ ...channel, token: 'private' }).success).toBe(
      false
    );
    expect(
      CommunityWireEntryPostRequestSchema.safeParse({ text: 'Hello', idempotencyKey: 'retry-1' })
        .success
    ).toBe(true);
    expect(
      CommunityWireEntryPostRequestSchema.safeParse({
        text: 'Hello',
        idempotencyKey: 'retry-1',
        actingMemberId: 'agent',
      }).success
    ).toBe(false);
    expect(CommunityWireEntryPageSchema.parse({ entries: [], nextCursor: null })).toEqual({
      entries: [],
      nextCursor: null,
    });
    expect(
      CommunityWireErrorSchema.parse({ code: 'NESTED_THREAD', message: 'Replies have one level' })
        .code
    ).toBe('NESTED_THREAD');
    expect(COMMUNITY_API_V1_ROUTES.entries).toBe('/api/v1/channels/:id/entries');
  });

  it('requires stable handles and resolved mentions with each entry resume cursor', () => {
    const member = {
      memberId: 'human-1',
      kind: 'human',
      displayName: 'Ana',
      handle: 'ana',
      role: 'member',
      ownerMemberId: null,
      joinedAt: '2026-09-16T00:00:00.000Z',
    };
    expect(CommunityWireMemberSchema.parse(member).handle).toBe('ana');
    expect(
      CommunityWireMemberSchema.parse({ ...member, ownerDisplayName: null }).ownerDisplayName
    ).toBeNull();
    expect(
      CommunityWireMemberSchema.parse({
        ...member,
        kind: 'agent',
        role: null,
        ownerMemberId: 'human-1',
        ownerDisplayName: 'Ana',
      }).ownerDisplayName
    ).toBe('Ana');
    expect(
      CommunityWireMemberSchema.safeParse({
        ...member,
        ownerDisplayName: 'Ana',
        email: 'ana@example.com',
      }).success
    ).toBe(false);
    expect(CommunityWireMemberSchema.safeParse({ ...member, handle: null }).success).toBe(false);
    expect(CommunityWireMemberSchema.safeParse({ ...member, handle: 'Ana' }).success).toBe(false);
    expect(
      CommunityWireAgentSchema.safeParse({
        memberId: 'agent-1',
        displayName: 'Helper',
        handle: 'helper',
        ownerMemberId: 'human-1',
        active: true,
      }).success
    ).toBe(true);
    expect(
      CommunityWireAgentEnrollRequestSchema.safeParse({
        localAgentId: 'local-1',
        displayName: 'Helper',
        handle: 'helper',
      }).success
    ).toBe(true);
    expect(CommunityWireMemberRoleUpdateRequestSchema.parse({ role: 'admin' }).role).toBe('admin');
    expect(COMMUNITY_API_V1_ROUTES.memberRole).toBe('/api/v1/members/:id/role');
    const entry = {
      id: 'entry-1',
      channelId: 'channel-1',
      seq: 1,
      authorMemberId: 'human-1',
      authorDisplayName: 'Ana',
      authorKind: 'human',
      text: '@helper hello',
      mentions: ['agent-1'],
      cursor: 'room-resume-1',
      parentEntryId: null,
      threadRootEntryId: null,
      createdAt: '2026-09-16T00:00:00.000Z',
      attachments: [],
    };
    expect(CommunityWireEntrySchema.parse(entry).mentions).toEqual(['agent-1']);
    expect(
      CommunityWireEntryPostResponseSchema.safeParse({ entry, cursor: entry.cursor }).success
    ).toBe(true);
    expect(CommunityWireEntryPostResponseSchema.safeParse({ entry, cursor: 'wrong' }).success).toBe(
      false
    );
    // A removal answers with the entry alone; a receipt cursor is not part of it.
    expect(CommunityWireEntryRemoveResponseSchema.safeParse({ entry }).success).toBe(true);
    expect(
      CommunityWireEntryRemoveResponseSchema.safeParse({ entry, cursor: entry.cursor }).success
    ).toBe(false);
    expect(COMMUNITY_API_V1_ROUTES.entry).toBe('/api/v1/entries/:id');
    expect(
      CommunityWireEntryPageSchema.safeParse({ entries: [entry], nextCursor: 'page-only-cursor' })
        .success
    ).toBe(true);
    expect(
      CommunityWireEntrySchema.safeParse({ ...entry, localPath: '/private/file' }).success
    ).toBe(false);
    expect(CommunityWireEntrySchema.safeParse({ ...entry, mentions: undefined }).success).toBe(
      false
    );
    expect(CommunityWireEntrySchema.safeParse({ ...entry, cursor: undefined }).success).toBe(false);
    expect(
      CommunityWireEntrySchema.safeParse({ ...entry, mentions: ['agent-1', 'agent-1'] }).success
    ).toBe(false);
  });
});
