/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  getRemoteCommunityDeliverySnapshot,
  getRemoteCommunityEnrollmentStore,
  getRemoteCommunityOriginIdempotencyKey,
  readRemoteInstallationAgents,
  setRemoteCommunityDb,
  setRemoteCommunityDeliveryProjection,
  setRemoteCommunityLocalAgentResolver,
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

// DOR-2603. Purpose: Disconnect removes exactly the agents this installation added to that
// Community for that owner. Fails if it would reach an agent from another community or another
// owner, drops one revoked only here, or loses the name the person knows it by.
describe('the agents disconnecting removes', () => {
  it('reads only this owner’s agents on this community, named as this app knows them', () => {
    const OTHER = CommunityRefSchema.parse('remote_owner_b');
    setRemoteCommunityDb(createTestDb());
    setRemoteCommunityLocalAgentResolver((localAgentId) =>
      localAgentId === 'scout' ? { authorId: 'author-scout', displayName: 'Scout' } : null
    );
    const store = getRemoteCommunityEnrollmentStore();
    const add = (communityRef: typeof REF, localAgentId: string, owner: string) =>
      store.activate({
        communityRef,
        localAgentId,
        remoteMemberId: `member-${localAgentId}-${owner}-${communityRef}`,
        ownerAuthorId: owner,
      });
    add(REF, 'scout', 'owner-a');
    add(REF, 'renamed', 'owner-a');
    add(REF, 'removed', 'owner-a');
    store.revoke(REF, 'removed', 'owner-a');
    add(REF, 'echo', 'owner-b');
    add(OTHER, 'scout', 'owner-a');

    // Revoked here is not removed there: a rejected grant revokes every enrollment locally
    // without telling the Community, so those come back too, marked inactive.
    expect(readRemoteInstallationAgents(REF, 'owner-a')).toEqual([
      {
        localAgentId: 'scout',
        remoteMemberId: `member-scout-owner-a-${REF}`,
        displayName: 'Scout',
        active: true,
      },
      {
        localAgentId: 'renamed',
        remoteMemberId: `member-renamed-owner-a-${REF}`,
        displayName: null,
        active: true,
      },
      {
        localAgentId: 'removed',
        remoteMemberId: `member-removed-owner-a-${REF}`,
        displayName: null,
        active: false,
      },
    ]);
  });
});
