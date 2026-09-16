/**
 * Real SQLite and RoomService coverage for remote-community mirrors.
 *
 * The tests deliberately import through `RemoteMirrorStore` and read through
 * the ordinary room service. A cache-only test would miss the owner-wide local
 * visibility and dispatcher-context paths that a mirror row can otherwise
 * enter through.
 *
 * @module services/communities/remote/__tests__/mirror-store.integration
 */
import { communityMirrorEntries, eq } from '@dorkos/db';
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import { describe, expect, it } from 'vitest';
import { authorOrigin } from '../../../rooms/author-registry.js';
import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import { RemoteMirrorStore, type NativeMirrorEntry } from '../mirror-store.js';

const REF_A = 'remote_a' as CommunityRef;
const REF_B = 'remote_b' as CommunityRef;

function nativeEntry(ref: CommunityRef, roomId: string, seq: number): NativeMirrorEntry {
  const entry: CommunityEntry = {
    community: ref,
    roomId,
    id: `entry-${seq}`,
    authorId: 'remote-human',
    text: `remote ${seq}`,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `cursor-${seq}` as CommunityEntry['cursor'],
    createdAt: `2026-09-16T00:${String(seq % 60).padStart(2, '0')}:00.000Z`,
  };
  return {
    entry,
    remoteSeq: seq,
    author: { memberId: 'remote-human', displayName: 'Remote human' },
  };
}

function wired(agents = agentLookupFor({})): {
  harness: RoomHarness;
  mirrors: RemoteMirrorStore;
} {
  const state: { mirrors?: RemoteMirrorStore } = {};
  const access = {
    canRead: (roomId: string, authorId: string) => state.mirrors?.canRead(roomId, authorId) ?? null,
    hasMirrors: () => state.mirrors?.hasMirrors() ?? false,
  };
  const harness = createRoomHarness({ agents, mirrorAccess: access });
  const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
  state.mirrors = mirrors;
  return { harness, mirrors };
}

function roomInput(ref: CommunityRef, remoteRoomId: string, ownerAuthorId: string) {
  return {
    communityRef: ref,
    remoteRoomId,
    title: `Room ${remoteRoomId}`,
    topic: null,
    ownerAuthorId,
    accessors: [],
    authorizedAt: '2026-09-16T00:00:00.000Z',
  };
}

describe('RemoteMirrorStore', () => {
  it('keeps two community refs with the same remote ids as separate local rooms', () => {
    const { harness, mirrors } = wired();
    const first = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    const second = mirrors.ensureRoom(roomInput(REF_B, 'general', harness.human));

    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    mirrors.importEntries(REF_B, 'general', [nativeEntry(REF_B, 'general', 1)]);

    expect(first.id).not.toBe(second.id);
    expect(harness.store.listEntriesAfter(first.id, 0).map((entry) => entry.body.text)).toEqual([
      'remote 1',
    ]);
    expect(harness.store.listEntriesAfter(second.id, 0).map((entry) => entry.body.text)).toEqual([
      'remote 1',
    ]);
  });

  it('deduplicates an imported entry by its qualified remote identity without dispatching', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    const entry = nativeEntry(REF_A, 'general', 7);

    mirrors.importEntries(REF_A, 'general', [entry]);
    mirrors.importEntries(REF_A, 'general', [entry]);

    expect(harness.store.listEntriesAfter(room.id, 0)).toHaveLength(1);
    expect(
      harness.db
        .select()
        .from(communityMirrorEntries)
        .where(eq(communityMirrorEntries.localRoomId, room.id))
        .all()
    ).toHaveLength(1);
    expect(harness.runner.turns).toEqual([]);
  });

  it('hides a revoked cache row from the local owner and rejects its normal history read', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    mirrors.revoke(REF_A);

    expect(harness.service.listRooms(harness.human).map((item) => item.id)).not.toContain(room.id);
    expect(harness.service.listMemberRooms(harness.human).map((item) => item.roomId)).not.toContain(
      room.id
    );
    expect(() => harness.service.readHistory(room.id, harness.human, { limit: 10 })).toThrow(
      'No such room'
    );
  });

  it('allows only the last authorized owner to read a stale cache', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    mirrors.markStale(REF_A, harness.human);

    expect(harness.service.readHistory(room.id, harness.human, { limit: 10 })).toHaveLength(1);
    const other = harness.authors.resolveExternal({
      platformType: 'community',
      instanceId: REF_A,
      platformUserId: 'other',
      displayName: 'Other',
    });
    expect(() => harness.service.readHistory(room.id, other.id, { limit: 10 })).toThrow(
      'No such room'
    );
  });

  it('keeps remote authors external even when their remote id matches the local owner', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    const entry = nativeEntry(REF_A, 'general', 1);
    entry.author.memberId = harness.human;
    mirrors.importEntries(REF_A, 'general', [entry]);

    const stored = harness.store.listEntriesAfter(room.id, 0)[0];
    const author = harness.authors.getById(stored.authorId);
    expect(author).toBeDefined();
    const origin = authorOrigin(author!.naturalKey);
    if (origin === 'local') throw new Error('A remote mirror author became local');
    expect(origin.platform).toBe('community');
    expect(stored.authorId).not.toBe(harness.human);
  });

  it('orders late history backfill by native sequence in history and dispatcher context', async () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = mirrors.ensureRoom({
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
    });

    mirrors.importEntries(
      REF_A,
      'general',
      Array.from({ length: 50 }, (_, index) => nativeEntry(REF_A, 'general', index + 101))
    );
    mirrors.importEntries(
      REF_A,
      'general',
      Array.from({ length: 100 }, (_, index) => nativeEntry(REF_A, 'general', index + 1))
    );

    expect(harness.store.listEntriesAfter(room.id, 0).map((entry) => entry.seq)).toEqual(
      Array.from({ length: 150 }, (_, index) => index + 1)
    );
    expect(harness.runner.turns).toEqual([]);

    harness.service.post(room.id, { authorId: harness.human, text: 'local question' });
    await harness.service.triggersIdle();
    const context = harness.runner.turns[0]?.roomContext;
    expect(context?.pending.map((entry) => entry.text)).toEqual(
      Array.from({ length: 30 }, (_, index) => `remote ${index + 121}`)
    );
  });
});
