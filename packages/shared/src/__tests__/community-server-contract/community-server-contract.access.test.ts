import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_API_V1_ROUTES,
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
  CommunityWireAttentionResponseSchema,
  CommunityWireEventSchema,
} from '../../community-wire.js';
import {
  CommunityPairingExchangeSecretResponseSchema,
  CommunityAgentEnrollmentSecretResponseSchema,
} from '../../community-private-wire.js';

describe('community server port additions', () => {
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
      account: { membership: 'inactive', boundToAnotherAccount: false },
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

  // Purpose: DorkOS must be able to record, parse, and branch on a host's whole-community
  // takedown as its own state: a lifecycle with no capabilities, a stream close reason, and an
  // error code distinct from a suspension or an ordinary deletion. Fails if any of the three is
  // missing, or if a taken-down community could still be recorded as readable.
  it('names a taken-down community distinctly in access, streams, and errors', () => {
    const none = { read: false, post: false, enrollAgent: false, stream: false };
    const takenDown = {
      state: 'verified',
      effective: none,
      lastKnown: {
        lifecycle: 'taken_down',
        capabilities: none,
        verifiedAt: '2026-09-29T00:00:00.000Z',
      },
    };
    expect(CommunityConnectionAccessSchema.parse(takenDown)).toEqual(takenDown);
    expect(
      CommunityConnectionAccessSchema.safeParse({
        ...takenDown,
        state: 'unverified',
        lastKnown: { ...takenDown.lastKnown, capabilities: { ...none, read: true } },
      }).success
    ).toBe(false);
    expect(
      CommunityWireEventSchema.parse({ type: 'closed', reason: 'taken_down', cursor: 'c1' })
    ).toEqual({ type: 'closed', reason: 'taken_down', cursor: 'c1' });
    expect(
      CommunityWireErrorSchema.parse({
        code: 'COMMUNITY_TAKEN_DOWN',
        message: 'This community was removed by its host.',
      }).code
    ).toBe('COMMUNITY_TAKEN_DOWN');
  });
});
