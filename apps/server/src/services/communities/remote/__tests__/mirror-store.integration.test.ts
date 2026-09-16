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
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';

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
  it('keeps agent enrollment qualified, owner-scoped, and fail-closed on revoke', () => {
    const { harness } = wired();
    const enrollments = new CommunityAgentEnrollmentStore(
      harness.db,
      () => '2026-09-16T00:00:00.000Z'
    );

    enrollments.activate({
      communityRef: REF_A,
      localAgentId: 'agent-local-1',
      remoteMemberId: 'agent-remote-1',
      ownerAuthorId: harness.human,
    });

    expect(enrollments.findLocalAgent(REF_A, 'agent-remote-1', harness.human)?.localAgentId).toBe(
      'agent-local-1'
    );
    expect(
      enrollments.findRemoteMember(REF_A, 'agent-local-1', harness.human)?.remoteMemberId
    ).toBe('agent-remote-1');
    expect(enrollments.findLocalAgent(REF_A, 'agent-remote-1', 'other-owner')).toBeNull();

    enrollments.revoke(REF_A, 'agent-local-1', harness.human);
    expect(enrollments.findLocalAgent(REF_A, 'agent-remote-1', harness.human)).toBeNull();
    expect(enrollments.findRemoteMember(REF_A, 'agent-local-1', harness.human)).toBeNull();
  });

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

  it('keeps remote order after arbitrary local appends without sharing their storage ordinal', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));

    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    for (const text of ['local one', 'local two', 'local three']) {
      harness.service.post(room.id, { authorId: harness.human, text });
    }
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 2)]);

    // The live log remains strictly monotonic by local `seq`; a late remote
    // sequence must never make an SSE replay move backward.
    expect(harness.store.listEntriesAfter(room.id, 0).map((entry) => entry.body.text)).toEqual([
      'remote 1',
      'local one',
      'local two',
      'local three',
      'remote 2',
    ]);
    // History and agent context use the persisted remote relation instead, so
    // the remote conversation is never reordered by arbitrary local appends.
    const timeline = harness.store.listEntries(room.id, { limit: 10 });
    expect(timeline.map((entry) => entry.body.text)).toEqual([
      'remote 1',
      'remote 2',
      'local one',
      'local two',
      'local three',
    ]);
    expect(
      timeline.filter((entry) => entry.body.text.startsWith('local')).map((entry) => entry.seq)
    ).toEqual([2, 3, 4]);
    expect(timeline.find((entry) => entry.body.text === 'remote 2')?.seq).toBe(5);
    const snapshot = harness.service.snapshot(room.id, harness.human, 10);
    expect(snapshot.entries.map((entry) => entry.body.text)).toEqual(
      timeline.map((entry) => entry.body.text)
    );
    expect(snapshot.cursor).toBe(5);
  });

  it('pages remote history by the timeline anchor without skipping a late remote entry', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 1)]);
    for (const text of ['local one', 'local two', 'local three']) {
      harness.service.post(room.id, { authorId: harness.human, text });
    }
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 2)]);

    const newest = harness.store.listEntries(room.id, { limit: 2 });
    const middle = harness.store.listEntries(room.id, { before: newest[0]!.seq, limit: 2 });
    const oldest = harness.store.listEntries(room.id, { before: middle[0]!.seq, limit: 2 });

    expect([...oldest, ...middle, ...newest].map((entry) => entry.body.text)).toEqual([
      'remote 1',
      'remote 2',
      'local one',
      'local two',
      'local three',
    ]);

    // The public history tool reverses each backward page for the reader, but
    // uses the same anchor contract; combining the pages still keeps every row.
    const historyNewest = harness.service.readHistory(room.id, harness.human, { limit: 2 });
    const historyMiddle = harness.service.readHistory(room.id, harness.human, {
      before: historyNewest.at(-1)!.seq,
      limit: 2,
    });
    const historyOldest = harness.service.readHistory(room.id, harness.human, {
      before: historyMiddle.at(-1)!.seq,
      limit: 2,
    });
    expect(
      [...historyOldest]
        .reverse()
        .concat([...historyMiddle].reverse(), [...historyNewest].reverse())
        .map((entry) => entry.body.text)
    ).toEqual(['remote 1', 'remote 2', 'local one', 'local two', 'local three']);

    const firstForward = harness.store.listEntriesForExport(room.id, { afterSeq: 0, limit: 2 });
    const secondForward = harness.store.listEntriesForExport(room.id, {
      afterSeq: firstForward.at(-1)!.seq,
      limit: 2,
    });
    const thirdForward = harness.store.listEntriesForExport(room.id, {
      afterSeq: secondForward.at(-1)!.seq,
      limit: 2,
    });
    expect(
      [...firstForward, ...secondForward, ...thirdForward].map((entry) => entry.body.text)
    ).toEqual(['remote 1', 'remote 2', 'local one', 'local two', 'local three']);
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

  it('hides stale and revoked mirror rooms from a retained enrolled agent membership', () => {
    const agents = agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } });
    const { harness, mirrors } = wired(agents);
    const agent = harness.authors.resolveAgent('/agents/ana', 'Ana');
    const room = mirrors.ensureRoom({
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
    });

    expect(harness.service.listRooms(agent.id).map((item) => item.id)).toContain(room.id);

    mirrors.markStale(REF_A, harness.human);
    expect(harness.service.listRooms(agent.id).map((item) => item.id)).not.toContain(room.id);

    mirrors.ensureRoom({
      ...roomInput(REF_A, 'general', harness.human),
      accessors: [{ authorId: agent.id, responseMode: 'always' }],
    });
    mirrors.revoke(REF_A);
    expect(harness.service.listRooms(agent.id).map((item) => item.id)).not.toContain(room.id);
  });

  it('keeps a reply’s opaque remote entry data and repairs its parent after backfill', () => {
    const { harness, mirrors } = wired();
    const room = mirrors.ensureRoom(roomInput(REF_A, 'general', harness.human));
    const reply = nativeEntry(REF_A, 'general', 2);
    reply.entry = {
      ...reply.entry,
      parentEntryId: 'entry-1',
      threadRootEntryId: 'entry-1',
      depth: 1,
      cursor: 'opaque-resume-after-reply' as CommunityEntry['cursor'],
      attachments: [
        {
          id: 'attachment-1',
          name: 'plan.pdf',
          contentType: 'application/pdf',
          byteSize: 42,
          checksum: 'sha256:fixture',
        },
      ],
    };

    // A page may contain a reply before its parent. The cache retains the
    // remote relation instead of deciding the reply is permanently top-level.
    mirrors.importEntries(REF_A, 'general', [reply]);
    const beforeParent = harness.store.listEntries(room.id, { limit: 10 })[0]!;
    expect(beforeParent.parentEntryId).toBeNull();

    const parent = nativeEntry(REF_A, 'general', 1);
    mirrors.importEntries(REF_A, 'general', [parent]);
    const parentLocal = harness.store
      .listEntries(room.id, { limit: 10 })
      .find((entry) => entry.body.text === 'remote 1')!;
    const repaired = harness.store.getEntryById(room.id, beforeParent.id)!;
    expect(repaired.parentEntryId).toBe(parentLocal.id);
    expect(repaired.threadRootEntryId).toBe(parentLocal.id);

    // A fresh cache store reads the original adapter entry without interpreting
    // its opaque cursor or discarding the attachment metadata.
    const restarted = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
    expect(restarted.cachedEntryForOwner(REF_A, 'general', reply.entry.id, harness.human)).toEqual(
      reply.entry
    );
    expect(restarted.cachedEntriesForOwner(REF_A, 'general', harness.human, { limit: 1 })).toEqual([
      parent.entry,
    ]);
    expect(
      restarted.cachedEntriesForOwner(REF_A, 'general', harness.human, {
        afterRemoteSeq: 1,
        limit: 1,
      })
    ).toEqual([reply.entry]);
    expect(
      restarted.cachedEntryForOwner(REF_A, 'general', reply.entry.id, 'other-owner')
    ).toBeNull();
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

    expect(
      harness.store.listEntries(room.id, { limit: 200 }).map((entry) => entry.body.text)
    ).toEqual(Array.from({ length: 150 }, (_, index) => `remote ${index + 1}`));
    expect(harness.runner.turns).toEqual([]);

    harness.service.post(room.id, { authorId: harness.human, text: 'local question' });
    await harness.service.triggersIdle();
    const context = harness.runner.turns[0]?.roomContext;
    expect(context?.pending.map((entry) => entry.text)).toEqual(
      Array.from({ length: 30 }, (_, index) => `remote ${index + 121}`)
    );

    // Local and imported rows receive independent storage ordinals. Remote
    // order still comes from the persisted native sequence relation.
    const local = harness.store
      .listEntriesAfter(room.id, 0)
      .find((entry) => entry.body.text === 'local question');
    expect(local?.seq).toBe(151);
    mirrors.importEntries(REF_A, 'general', [nativeEntry(REF_A, 'general', 151)]);
    expect(
      harness.store.listEntries(room.id, { limit: 200 }).map((entry) => entry.body.text)
    ).toEqual([
      ...Array.from({ length: 151 }, (_, index) => `remote ${index + 1}`),
      'local question',
      'on it',
    ]);
    expect(harness.store.getEntryById(room.id, local?.id ?? '')?.body.text).toBe('local question');
  });
});
