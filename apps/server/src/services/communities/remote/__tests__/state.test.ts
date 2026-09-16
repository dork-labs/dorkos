/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import {
  getRemoteCommunityDeliverySnapshot,
  setRemoteCommunityDeliveryProjection,
} from '../state.js';

const REF = CommunityRefSchema.parse('remote_owner_a');

describe('remote community delivery projection', () => {
  it('keeps the qualified delivery while withholding metadata over the browser limit', () => {
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
    } as never);

    expect(getRemoteCommunityDeliverySnapshot(REF, 'room-a', 'owner-a')).toEqual({
      community: REF,
      roomId: 'room-a',
      deliveries: [
        {
          idempotencyKey: 'retry-a',
          author: { kind: 'agent', displayName: 'Build Agent' },
          text: 'result',
          parentEntryId: null,
          attachments: [{ name: 'small.txt', contentType: 'text/plain', byteSize: 10 }],
          state: 'failed',
          failure: 'not-confirmed',
        },
      ],
    });
  });
});
