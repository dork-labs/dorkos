import { describe, expect, it } from 'vitest';
import {
  CommunityConnectionDescriptorSchema,
  CommunityConnectionPollResponseSchema,
  CommunityConnectionStartResponseSchema,
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
      }).success
    ).toBe(false);
  });
});
