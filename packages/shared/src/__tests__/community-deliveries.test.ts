/** @module shared/__tests__/community-deliveries */
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_DELIVERY_MAX_ATTACHMENT_BYTES,
  CommunityDeliverySnapshotSchema,
} from '../community-deliveries.js';

const pending = {
  idempotencyKey: '01JQ0XVC4RGH6T1E2J2M7YB10T',
  author: { kind: 'agent' as const, displayName: 'Research agent' },
  text: 'I found the answer.',
  parentEntryId: 'remote-parent-1',
  attachments: [{ name: 'notes.txt', contentType: 'text/plain', byteSize: 24 }],
  state: 'pending' as const,
  failure: null,
};

describe('community delivery DTOs', () => {
  it('accepts a qualified bounded owner-safe pending delivery snapshot', () => {
    expect(
      CommunityDeliverySnapshotSchema.parse({
        community: 'remote_abc',
        roomId: 'general',
        deliveries: [pending],
      })
    ).toMatchObject({ community: 'remote_abc', roomId: 'general', deliveries: [pending] });
  });

  it('enforces state-specific failures and refuses local or diagnostic fields', () => {
    const snapshot = { community: 'remote_abc', roomId: 'general', deliveries: [pending] };
    for (const delivery of [
      { ...pending, failure: 'expired' },
      { ...pending, localEntryId: 'sqlite-entry' },
      { ...pending, attachments: [{ ...pending.attachments[0], id: 'sqlite-attachment' }] },
      { ...pending, failure: new Error('raw remote error').message },
      {
        ...pending,
        state: 'failed' as const,
        failure: null,
      },
      {
        ...pending,
        attachments: [
          {
            ...pending.attachments[0],
            byteSize: COMMUNITY_DELIVERY_MAX_ATTACHMENT_BYTES + 1,
          },
        ],
        text: 'x'.repeat(100_001),
      },
    ]) {
      expect(
        CommunityDeliverySnapshotSchema.safeParse({ ...snapshot, deliveries: [delivery] }).success
      ).toBe(false);
    }
    expect(
      CommunityDeliverySnapshotSchema.parse({
        ...snapshot,
        deliveries: [{ ...pending, state: 'failed', failure: 'not-confirmed' }],
      }).deliveries[0]
    ).toMatchObject({ state: 'failed', failure: 'not-confirmed' });
  });

  it('bounds snapshots rather than streaming an unbounded local queue', () => {
    expect(
      CommunityDeliverySnapshotSchema.safeParse({
        community: 'remote_abc',
        roomId: 'general',
        deliveries: Array.from({ length: 101 }, () => pending),
      }).success
    ).toBe(false);
  });

  it('refuses duplicate pending identities in a replacement snapshot', () => {
    expect(
      CommunityDeliverySnapshotSchema.safeParse({
        community: 'remote_abc',
        roomId: 'general',
        deliveries: [pending, pending],
      }).success
    ).toBe(false);
  });
});
