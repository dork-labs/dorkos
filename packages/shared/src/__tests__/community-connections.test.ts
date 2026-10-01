import { describe, expect, it } from 'vitest';
import {
  CommunityConnectionDescriptorSchema,
  CommunityConnectionPollResponseSchema,
  CommunityConnectionStartResponseSchema,
  describeCommunityRetryWait,
} from '../community-connections.js';

const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
const access = {
  state: 'verified' as const,
  effective: capabilities,
  lastKnown: {
    lifecycle: 'active' as const,
    capabilities,
    verifiedAt: '2026-09-21T00:00:00.000Z',
  },
};

const connection = {
  ref: 'remote_abc',
  remoteCommunityId: 'remote-id',
  label: 'Writers',
  pinnedOrigin: 'https://community.example',
  connectedHumanMemberId: 'member-id',
  status: 'connected',
  expiresAt: null,
  access,
  attention: {
    state: 'verified' as const,
    unreadCount: 3,
    mentionCount: 1,
    verifiedAt: '2026-09-21T00:00:00.000Z',
  },
};

describe('local community connection DTOs', () => {
  it('accepts public status while rejecting secret and owner authority fields', () => {
    expect(CommunityConnectionDescriptorSchema.parse(connection)).toEqual(connection);
    for (const key of ['token', 'verifier', 'code', 'pairingId', 'ownerKey', 'agentIds']) {
      expect(
        CommunityConnectionDescriptorSchema.safeParse({ ...connection, [key]: 'hidden' }).success
      ).toBe(false);
    }
    expect(
      CommunityConnectionPollResponseSchema.parse({ status: 'connected', connection })
    ).toMatchObject({ status: 'connected' });
    expect(
      CommunityConnectionStartResponseSchema.safeParse({
        connection,
        approvalUrl: 'https://community.example/pairing',
        token: 'secret',
      }).success
    ).toBe(false);
  });

  it('reports host authority only on a verified connection, and treats its absence as no', () => {
    expect(CommunityConnectionDescriptorSchema.parse(connection)).not.toHaveProperty(
      'hostOperator'
    );
    expect(
      CommunityConnectionDescriptorSchema.parse({ ...connection, hostOperator: true })
    ).toMatchObject({ hostOperator: true });
    const unverified = {
      ...connection,
      access: {
        state: 'unverified' as const,
        effective: { read: false, post: false, enrollAgent: false, stream: false },
        lastKnown: access.lastKnown,
      },
    };
    expect(
      CommunityConnectionDescriptorSchema.safeParse({ ...unverified, hostOperator: true }).success
    ).toBe(false);
    expect(
      CommunityConnectionDescriptorSchema.safeParse({ ...unverified, hostOperator: false }).success
    ).toBe(true);
  });

  it('accepts a connection whose remote grant must be replaced', () => {
    expect(
      CommunityConnectionDescriptorSchema.parse({
        ...connection,
        status: 'reconnect-required',
        access: {
          state: 'reconnect-required',
          effective: { read: false, post: false, enrollAgent: false, stream: false },
          lastKnown: access.lastKnown,
        },
        attention: {
          state: 'unavailable',
          unreadCount: null,
          mentionCount: null,
          verifiedAt: null,
        },
      })
    ).toMatchObject({ status: 'reconnect-required' });
  });

  it('requires pending and established descriptors to expose honest access state', () => {
    expect(
      CommunityConnectionDescriptorSchema.parse({
        ...connection,
        connectedHumanMemberId: null,
        status: 'pending',
        expiresAt: '2026-09-21T00:10:00.000Z',
        access: null,
        attention: null,
      })
    ).toMatchObject({ status: 'pending', access: null });
    expect(
      CommunityConnectionDescriptorSchema.safeParse({ ...connection, access: null }).success
    ).toBe(false);
    expect(
      CommunityConnectionDescriptorSchema.safeParse({
        ...connection,
        status: 'pending',
        access,
        attention: connection.attention,
      }).success
    ).toBe(false);
  });

  it('rejects a fabricated zero and a mention count outside unread activity', () => {
    expect(
      CommunityConnectionDescriptorSchema.safeParse({
        ...connection,
        attention: { state: 'unavailable', unreadCount: 0, mentionCount: 0, verifiedAt: null },
      }).success
    ).toBe(false);
    expect(
      CommunityConnectionDescriptorSchema.safeParse({
        ...connection,
        attention: {
          state: 'verified',
          unreadCount: 1,
          mentionCount: 2,
          verifiedAt: '2026-09-21T00:00:00.000Z',
        },
      }).success
    ).toBe(false);
  });
});

// Purpose: one phrasing of a Community's wait for the route and the dialog. Fails if a short
// wait is rounded away, a long one is not rounded up to minutes, or a missing or unusable wait
// is turned into a number.
describe('describeCommunityRetryWait', () => {
  it('says seconds under a minute, rounded-up minutes past it, and a minute when unknown', () => {
    expect(describeCommunityRetryWait(1)).toBe('1 second');
    expect(describeCommunityRetryWait(17)).toBe('17 seconds');
    expect(describeCommunityRetryWait(60)).toBe('a minute');
    expect(describeCommunityRetryWait(61)).toBe('2 minutes');
    expect(describeCommunityRetryWait(90)).toBe('2 minutes');
    for (const unknown of [undefined, null, 0, -5, 1.5, '17', Number.NaN])
      expect(describeCommunityRetryWait(unknown), String(unknown)).toBe('a minute');
  });
});
