/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import {
  getRemoteCommunityDeliverySnapshot,
  getRemoteCommunityOriginIdempotencyKey,
  setRemoteCommunityDeliveryProjection,
} from '../state.js';

const REF = CommunityRefSchema.parse('remote_owner_a');

describe('remote community delivery projection', () => {
  it('keeps a failed qualified delivery and its safe oversized attachment metadata', () => {
    setRemoteCommunityDeliveryProjection({
      list: () => [
        {
          communityRef: REF,
          remoteRoomId: 'room-a',
          idempotencyKey: 'retry-a',
          author: { kind: 'agent', displayName: 'Build Agent' },
          text: 'result',
          parentEntryId: null,
          attachments: [
            { id: 'small', name: 'small.txt', mimeType: 'text/plain', size: 10 },
            {
              id: 'large',
              name: 'large.bin',
              mimeType: 'application/octet-stream',
              size: 25 * 1024 * 1024 + 1,
            },
          ],
          state: 'failed',
          failure: 'remote attachment too large',
        },
      ],
      originForRemoteEntry: (
        communityRef: unknown,
        roomId: string,
        owner: string,
        entryId: string
      ) =>
        communityRef === REF && roomId === 'room-a' && owner === 'owner-a' && entryId === 'remote-a'
          ? 'retry-a'
          : null,
    } as never);

    expect(getRemoteCommunityOriginIdempotencyKey(REF, 'room-a', 'owner-a', 'remote-a')).toBe(
      'retry-a'
    );
    expect(
      getRemoteCommunityOriginIdempotencyKey(REF, 'room-a', 'other-owner', 'remote-a')
    ).toBeNull();

    expect(getRemoteCommunityDeliverySnapshot(REF, 'room-a', 'owner-a')).toEqual({
      community: REF,
      roomId: 'room-a',
      deliveries: [
        {
          idempotencyKey: 'retry-a',
          author: { kind: 'agent', displayName: 'Build Agent' },
          text: 'result',
          parentEntryId: null,
          attachments: [
            { name: 'small.txt', contentType: 'text/plain', byteSize: 10 },
            {
              name: 'large.bin',
              contentType: 'application/octet-stream',
              byteSize: 25 * 1024 * 1024 + 1,
            },
          ],
          state: 'failed',
          failure: 'not-confirmed',
        },
      ],
    });
  });
});
