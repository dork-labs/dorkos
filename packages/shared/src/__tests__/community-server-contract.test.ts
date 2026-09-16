import { describe, expect, it } from 'vitest';
import {
  CommunityCapabilitiesSchema,
  PostCommunityEntryInputSchema,
} from '../community-adapter.js';
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireChannelSchema,
  CommunityWireEntryPostRequestSchema,
  CommunityWireEntryPageSchema,
  CommunityWireErrorSchema,
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

  it('keeps HTTP conversation DTOs strict and free of private fields', () => {
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

  it('isolates one-time credential responses in the private subpath', () => {
    expect(
      CommunityPairingExchangeSecretResponseSchema.safeParse({
        token: 'opaque-personal-token',
        grant: {
          id: 'grant-1',
          memberId: 'human-1',
          scopes: ['read', 'post'],
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
          ownerMemberId: 'human-1',
          active: true,
        },
      }).success
    ).toBe(true);
  });
});
