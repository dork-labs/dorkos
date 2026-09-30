/**
 * What a community going away removes from this installation, and what it must leave (DOR-2334).
 *
 * The pairing service's own tests prove WHEN the revoke path runs (a Community being deleted, an
 * owner disconnecting) and that it is asked for exactly one owner's connection. This proves WHAT
 * that path, as production wires it, removes for that one connection: the mirrored rooms, their
 * entries, their files on disk and their search rows, and nothing of another community's or
 * another owner's.
 *
 * @module services/communities/remote/__tests__/community-deletion-purge
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulidx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import { agentLookupFor, createRoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import { AttachmentRowStore } from '../../../rooms/attachments/attachment-row-store.js';
import { LocalRoomAttachmentStore } from '../../../rooms/attachments/local-room-attachment-store.js';
import { searchMessages } from '../../../search/index.js';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import { RemoteMirrorStore, type NativeMirrorEntry } from '../mirror-store.js';
import { RemoteRoomSubscriptionBridge } from '../remote-room-subscription-bridge.js';
import { RemoteRedactionSync } from '../remote-redaction-sync.js';
import { orphanedMirrorSweepDeps, sweepOrphanedMirrors } from '../orphaned-mirror-sweep.js';
import { RemoteConnectionStore } from '../connection-store.js';
import { logger } from '../../../../lib/logger.js';

const DELETED = 'remote_deleted' as CommunityRef;
const OTHER_COMMUNITY = 'remote_other' as CommunityRef;
const OTHER_OWNERS = 'remote_other_owner' as CommunityRef;
const ROOM = 'general';

function native(community: CommunityRef, text: string): NativeMirrorEntry {
  const entry: CommunityEntry = {
    community,
    roomId: ROOM,
    id: `${community}-entry`,
    authorId: 'remote-rae',
    text,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `${community}-cursor` as CommunityEntry['cursor'],
    createdAt: '2026-09-29T00:00:00.000Z',
  };
  return {
    entry,
    remoteSeq: 1,
    author: { memberId: 'remote-rae', displayName: 'Rae Remote', kind: 'human' },
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('a community going away', () => {
  // Purpose: the revoke path for one owner's connection to a deleted community purges that
  // connection's mirrored rooms, their entries, files and search rows, and leaves another
  // community's and another owner's copies whole. It fails if the purge scope widens (another
  // community or owner loses its copy) or narrows (a file or search row outlives the room).
  it('removes exactly that connection’s copies: rooms, entries, files and search', async () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-community-deletion-'));
    dirs.push(dorkHome);
    const bytes = new LocalRoomAttachmentStore(dorkHome);
    const rows = new AttachmentRowStore(harness.db);
    const late: { sync?: RemoteRedactionSync } = {};
    const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors, (purge) =>
      late.sync?.afterPurge(purge)
    );
    late.sync = new RemoteRedactionSync({
      db: harness.db,
      mirrors,
      readers: () => null,
      attachmentBytes: bytes,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      mirrors,
      harness.service,
      new CommunityAgentEnrollmentStore(harness.db),
      () => null
    );
    const owner = harness.human;
    const otherOwner = harness.authors.human('someone-else').id;

    const mirror = async (community: CommunityRef, ownerAuthorId: string, word: string) => {
      const room = mirrors.ensureRoom({
        communityRef: community,
        remoteRoomId: ROOM,
        title: 'General',
        topic: null,
        ownerAuthorId,
        accessors: [],
        authorizedAt: '2026-09-29T00:00:00.000Z',
      });
      mirrors.importEntries(community, ROOM, [native(community, `${word} said here`)]);
      // A file on a post in the room, stored on disk.
      const attachmentId = ulid();
      const { url } = await bytes.put(room.id, attachmentId, 'txt', Buffer.from(word));
      rows.create(
        {
          roomId: room.id,
          id: attachmentId,
          authorId: ownerAuthorId,
          name: `${word}.txt`,
          extension: 'txt',
          mimeType: 'text/plain',
          size: word.length,
          preview: null,
          url,
        },
        '2026-09-29T00:00:00.000Z'
      );
      harness.service.post(room.id, {
        authorId: ownerAuthorId,
        text: `${word} post`,
        attachmentIds: [attachmentId],
      });
      return {
        roomId: room.id,
        file: path.join(dorkHome, 'rooms', room.id, 'attachments', `${attachmentId}.txt`),
      };
    };
    const deleted = await mirror(DELETED, owner, 'zqxdeletedcanary');
    const otherCommunity = await mirror(OTHER_COMMUNITY, owner, 'zqxothercommunity');
    const otherOwners = await mirror(OTHER_OWNERS, otherOwner, 'zqxotherowner');
    await harness.indexMessages();
    const found = (word: string) =>
      searchMessages(harness.db, {
        scopes: [{ sourceId: 'rooms', visibility: 'all' }],
        query: word,
        limit: 5,
      }).length;
    const onDisk = (file: string) =>
      stat(file).then(
        () => true,
        () => false
      );
    expect(found('zqxdeletedcanary')).toBeGreaterThan(0);

    // What the pairing service calls for this owner's connection when the Community answers
    // `423 COMMUNITY_DELETION_PENDING`, or when the owner disconnects.
    await bridge.revokeConnection(DELETED, owner);
    await late.sync.whenScrubbed();
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.store.getRoom(deleted.roomId)).toBeNull();
    expect(found('zqxdeletedcanary')).toBe(0);
    // The purge deletes bytes after its commit, without holding anything up.
    await vi.waitFor(async () => expect(await onDisk(deleted.file)).toBe(false));

    for (const [kept, word] of [
      [otherCommunity, 'zqxothercommunity'],
      [otherOwners, 'zqxotherowner'],
    ] as const) {
      expect(harness.store.getRoom(kept.roomId)).not.toBeNull();
      expect(found(word)).toBeGreaterThan(0);
      expect(await onDisk(kept.file)).toBe(true);
    }
  });

  describe('the startup sweep of copies whose connection is gone', () => {
    const OTHER_REF = 'remote_other_ref' as CommunityRef;

    /** Real mirrors and bridge, and the real connection store in its own data directory. */
    async function sweepSetup() {
      const harness = createRoomHarness({ agents: agentLookupFor({}) });
      const dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-orphan-sweep-'));
      dirs.push(dorkHome);
      const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
      const bridge = new RemoteRoomSubscriptionBridge(
        mirrors,
        harness.service,
        new CommunityAgentEnrollmentStore(harness.db),
        () => null
      );
      const owner = harness.human;
      const otherOwner = harness.authors.human('someone-else').id;
      const ensure = (community: CommunityRef, ownerAuthorId = owner) =>
        mirrors.ensureRoom({
          communityRef: community,
          remoteRoomId: ROOM,
          title: 'General',
          topic: null,
          ownerAuthorId,
          accessors: [],
          authorizedAt: '2026-09-29T00:00:00.000Z',
        }).id;
      const revoke = vi.fn((ref: CommunityRef, ownerAuthorId: string) =>
        bridge.revokeConnection(ref, ownerAuthorId)
      );
      const store = new RemoteConnectionStore(dorkHome);
      const file = path.join(dorkHome, 'communities', 'remote', 'connections.json');
      const writeConnections = async (text: string) => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text);
      };
      const record = (ref: CommunityRef, ownerKey: string) => ({
        ref,
        ownerKey,
        remoteCommunityId: 'community-id',
        label: 'A community',
        pinnedOrigin: 'https://community.example',
        connectedHumanMemberId: 'member-id',
        status: 'connected',
        pairingId: null,
        expiresAt: null,
        agentIds: [],
        access: null,
      });
      const sweep = () => sweepOrphanedMirrors(orphanedMirrorSweepDeps(store, mirrors, revoke));
      return {
        harness,
        mirrors,
        owner,
        otherOwner,
        ensure,
        revoke,
        file,
        writeConnections,
        record,
        sweep,
      };
    }

    // Purpose (review 4): an orphan is swept, and a connection that still exists for the same
    // ref and owner is not; a record for the same ref under ANOTHER owner, or for the same owner
    // under ANOTHER ref, does not vouch for the orphan. It fails if the match ignores the owner
    // or the ref, or if a live connection's copies are purged.
    it('sweeps exactly the connections with no record, matched on ref AND owner', async () => {
      const s = await sweepSetup();
      const orphan = s.ensure(DELETED);
      const live = s.ensure(OTHER_COMMUNITY);
      // Revoked by a disconnect whose purge then failed: its room is still here.
      const stranded = s.ensure(OTHER_OWNERS);
      s.mirrors.revoke(OTHER_OWNERS, s.owner);
      await s.writeConnections(
        JSON.stringify([
          s.record(OTHER_COMMUNITY, s.owner),
          s.record(DELETED, s.otherOwner),
          s.record(OTHER_REF, s.owner),
        ])
      );

      expect(await s.sweep()).toBe(2);
      expect(s.revoke.mock.calls).toEqual(
        expect.arrayContaining([
          [DELETED, s.owner],
          [OTHER_OWNERS, s.owner],
        ])
      );
      expect(s.revoke).toHaveBeenCalledTimes(2);
      expect(s.harness.store.getRoom(orphan)).toBeNull();
      expect(s.harness.store.getRoom(stranded)).toBeNull();
      expect(s.harness.store.getRoom(live)).not.toBeNull();

      // Once purged, the orphan's revoked mapping is not swept again.
      s.revoke.mockClear();
      expect(await s.sweep()).toBe(0);
      expect(s.revoke).not.toHaveBeenCalled();
    });

    // Purpose (review 4): the sweep deletes, so it fails CLOSED: a connection list that is
    // missing, unreadable, not JSON, or holds an invalid record sweeps nothing. It fails if any
    // of those reads as "no connections".
    it.each([
      ['there is no connection list', async () => undefined],
      [
        'the list is not JSON',
        async (s: Awaited<ReturnType<typeof sweepSetup>>) => s.writeConnections('{not json'),
      ],
      [
        'a record is invalid',
        async (s: Awaited<ReturnType<typeof sweepSetup>>) =>
          s.writeConnections(JSON.stringify([{ ...s.record(DELETED, s.owner), status: 'bogus' }])),
      ],
      [
        'the list cannot be read',
        async (s: Awaited<ReturnType<typeof sweepSetup>>) =>
          mkdir(s.file, { recursive: true }).then(() => undefined),
      ],
    ])('sweeps nothing when %s', async (_label, arrange) => {
      const s = await sweepSetup();
      const orphan = s.ensure(DELETED);
      await arrange(s);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      expect(await s.sweep()).toBe(0);
      expect(s.revoke).not.toHaveBeenCalled();
      expect(s.harness.store.getRoom(orphan)).not.toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });
  });
});
