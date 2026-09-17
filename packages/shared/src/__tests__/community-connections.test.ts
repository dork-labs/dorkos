import { describe, expect, it } from 'vitest';
import {
  CommunityConnectionDescriptorSchema,
  CommunityConnectionPollResponseSchema,
  CommunityConnectionStartResponseSchema,
} from '../community-connections.js';

const connection = {
  ref: 'remote_abc',
  remoteCommunityId: 'remote-id',
  label: 'Writers',
  pinnedOrigin: 'https://community.example',
  connectedHumanMemberId: 'member-id',
  status: 'connected',
  expiresAt: null,
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
});
