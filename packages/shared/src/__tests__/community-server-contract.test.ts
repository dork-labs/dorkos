import { describe, expect, it } from 'vitest';
import {
  CommunityCapabilitiesSchema,
  CommunityReadContextSchema,
  ListCommunityEntriesOptsSchema,
  PostCommunityEntryInputSchema,
} from '../community-adapter.js';
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
  CommunityWireErrorSchema,
  CommunityWireInviteListResponseSchema,
  CommunityWireInvitePreflightResponseSchema,
  CommunityWireInvitePendingResponseSchema,
  CommunityWirePairingPollRequestSchema,
  CommunityWirePairingCancelRequestSchema,
  CommunityWirePairingApproveResponseSchema,
  CommunityWirePairingDeclineRequestSchema,
  CommunityWirePairingDeclineResponseSchema,
  CommunityWirePairingStatusResponseSchema,
  CommunityWireAgentChannelMembershipRequestSchema,
  CommunityWireAgentChannelMembershipResponseSchema,
  CommunityWireOwnerTransferResponseSchema,
  CommunityWireGrantListResponseSchema,
  CommunityConnectionAccessSchema,
  CommunityWireAuthOptionsSchema,
  CommunityWireAttentionResponseSchema,
} from '../community-wire.js';
import {
  CommunityPairingExchangeSecretResponseSchema,
  CommunityAgentEnrollmentSecretResponseSchema,
} from '../community-private-wire.js';

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
    expect(CommunityWireAuthOptionsSchema.parse({ google: false, github: true })).toEqual({
      google: false,
      github: true,
    });
    expect(
      CommunityWireAuthOptionsSchema.safeParse({
        google: true,
        github: false,
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

  it('isolates one-time credential responses in the private subpath', () => {
    expect(
      CommunityPairingExchangeSecretResponseSchema.safeParse({
        token: 'opaque-personal-token',
        grant: {
          id: 'grant-1',
          memberId: 'human-1',
          installName: 'Desk',
          scopes: ['read', 'post'],
          lifecycle: 'active',
          capabilities: { read: true, post: true, enrollAgent: false, stream: true },
          createdAt: '2026-09-16T00:00:00.000Z',
        },
      }).success
    ).toBe(true);
    expect(
      CommunityAgentEnrollmentSecretResponseSchema.safeParse({
        token: 'opaque-agent-token',
        agent: {
          memberId: 'agent-1',
          displayName: 'Helper',
          handle: 'helper',
          ownerMemberId: 'human-1',
          active: true,
        },
      }).success
    ).toBe(true);
  });

  it('validates phase-two admission and management receipts without exposing secrets', () => {
    const invite = {
      id: 'invite-1',
      channelId: null,
      createdAt: '2026-09-16T00:00:00.000Z',
      expiresAt: '2026-09-17T00:00:00.000Z',
      seats: 2,
      uses: 0,
      revoked: false,
    };
    expect(CommunityWireInviteListResponseSchema.parse({ invites: [invite] }).invites).toHaveLength(
      1
    );
    expect(
      CommunityWireInviteListResponseSchema.safeParse({ invites: [{ ...invite, token: 'secret' }] })
        .success
    ).toBe(false);
    expect(
      CommunityWireInvitePreflightResponseSchema.parse({
        granted: true,
        expiresAt: '2026-09-17T00:00:00.000Z',
        communityName: 'Builders',
        inviterName: 'Owner',
        channelName: null,
      }).granted
    ).toBe(true);
    const pending = {
      expiresAt: '2026-09-17T00:00:00.000Z',
      communityName: 'Builders',
      inviterName: 'Owner',
      channelName: null,
      account: { membership: 'inactive' },
    };
    expect(CommunityWireInvitePendingResponseSchema.parse(pending).account?.membership).toBe(
      'inactive'
    );
    expect(
      CommunityWireInvitePendingResponseSchema.parse({ ...pending, account: null }).account
    ).toBe(null);
    // The resumed review never carries the invitation or its admission value back to the page.
    expect(
      CommunityWireInvitePendingResponseSchema.safeParse({ ...pending, token: 'secret' }).success
    ).toBe(false);
    expect(
      CommunityWirePairingPollRequestSchema.parse({ pairingId: 'pair-1', verifier: 'verifier-1' })
    ).toEqual({ pairingId: 'pair-1', verifier: 'verifier-1' });
    expect(
      CommunityWirePairingCancelRequestSchema.parse({ pairingId: 'pair-1', verifier: 'verifier-1' })
    ).toEqual({ pairingId: 'pair-1', verifier: 'verifier-1' });
    expect(CommunityWirePairingApproveResponseSchema.parse({ approved: true }).approved).toBe(true);
    expect(CommunityWirePairingDeclineRequestSchema.parse({ pairingId: 'pair-1' })).toEqual({
      pairingId: 'pair-1',
    });
    expect(CommunityWirePairingDeclineResponseSchema.parse({ cancelled: true }).cancelled).toBe(
      true
    );
    expect(
      CommunityWirePairingStatusResponseSchema.safeParse({
        pairingId: 'pair-1',
        status: 'approved',
        installName: 'Desk',
        scopes: ['read'],
        expiresAt: invite.expiresAt,
        code: 'secret',
      }).success
    ).toBe(false);
    expect(
      CommunityWireAgentChannelMembershipRequestSchema.parse({ agentId: 'agent-1' }).agentId
    ).toBe('agent-1');
    expect(CommunityWireAgentChannelMembershipResponseSchema.parse({ joined: true }).joined).toBe(
      true
    );
    expect(
      CommunityWireOwnerTransferResponseSchema.parse({
        communityId: 'community-1',
        ownerMemberId: 'human-2',
        lifecycleVersion: 2,
      }).ownerMemberId
    ).toBe('human-2');
    const grant = {
      id: 'grant-1',
      memberId: 'human-1',
      installName: 'Desk',
      scopes: ['read'],
      lifecycle: 'active',
      capabilities: { read: true, post: false, enrollAgent: false, stream: true },
      createdAt: invite.createdAt,
    };
    expect(CommunityWireGrantListResponseSchema.parse({ grants: [grant] }).grants).toHaveLength(1);
    expect(
      CommunityWireGrantListResponseSchema.safeParse({ grants: [{ ...grant, token: 'secret' }] })
        .success
    ).toBe(false);
    expect(
      CommunityWireGrantListResponseSchema.safeParse({
        grants: [{ ...grant, installName: undefined }],
      }).success
    ).toBe(false);
    expect(COMMUNITY_API_V1_ROUTES.pairingCancel).toBe('/api/v1/pairings/cancel');
    expect(COMMUNITY_API_V1_ROUTES.pairingDecline).toBe('/api/v1/pairings/decline');
    expect(COMMUNITY_API_V1_ROUTES.channelAgents).toBe('/api/v1/channels/:id/agents');
    expect(COMMUNITY_API_V1_ROUTES.attention).toBe('/api/v1/attention');
  });

  it('refuses a remote attention summary with more mentions than unread activity', () => {
    expect(CommunityWireAttentionResponseSchema.parse({ unreadCount: 2, mentionCount: 2 })).toEqual(
      { unreadCount: 2, mentionCount: 2 }
    );
    expect(
      CommunityWireAttentionResponseSchema.safeParse({ unreadCount: 1, mentionCount: 2 }).success
    ).toBe(false);
  });

  it('keeps stale Community authority separate from effective access', () => {
    const access = {
      state: 'unverified',
      effective: { read: false, post: false, enrollAgent: false, stream: false },
      lastKnown: {
        lifecycle: 'archived',
        capabilities: { read: true, post: false, enrollAgent: false, stream: false },
        verifiedAt: '2026-09-21T00:00:00.000Z',
      },
    };
    expect(CommunityConnectionAccessSchema.parse(access)).toEqual(access);
    expect(
      CommunityConnectionAccessSchema.safeParse({
        ...access,
        lastKnown: { ...access.lastKnown, lifecycle: 'pending_owner' },
      }).success
    ).toBe(false);
    expect(
      CommunityConnectionAccessSchema.safeParse({ ...access, privateToken: 'secret' }).success
    ).toBe(false);
    expect(
      CommunityConnectionAccessSchema.safeParse({
        ...access,
        state: 'verified',
        effective: { read: true, post: false, enrollAgent: false, stream: false },
      }).success
    ).toBe(true);
    expect(
      CommunityConnectionAccessSchema.safeParse({
        ...access,
        state: 'verified',
        effective: { read: true, post: true, enrollAgent: false, stream: false },
      }).success
    ).toBe(false);
    expect(
      CommunityConnectionAccessSchema.safeParse({
        ...access,
        effective: { read: true, post: false, enrollAgent: false, stream: false },
      }).success
    ).toBe(false);
    expect(
      CommunityConnectionAccessSchema.safeParse({
        ...access,
        lastKnown: {
          ...access.lastKnown,
          lifecycle: 'suspended',
          capabilities: { read: false, post: true, enrollAgent: false, stream: false },
        },
      }).success
    ).toBe(false);
    expect(
      CommunityConnectionAccessSchema.safeParse({
        ...access,
        lastKnown: {
          ...access.lastKnown,
          lifecycle: 'deletion_pending',
          capabilities: { read: false, post: false, enrollAgent: false, stream: true },
        },
      }).success
    ).toBe(false);
  });
});
