import { REF, ROOM, native, setup, quoteNotification, inbox } from './fixtures.js';
import {
  communityMirrorEntries,
  communityOutbox,
  notifications,
  roomAttachments,
} from '@dorkos/db';
import { describe, expect, it } from 'vitest';
import { RemoteMirrorStore } from '../../mirror-store.js';

describe('RemoteRedactionSync', () => {
  it("deletes a mirror's content and its search rows when the mirror is revoked", async () => {
    for (const revoke of ['connection', 'absent'] as const) {
      const s = setup();
      s.mirrors.importEntries(REF, ROOM, [native(1, 'zqxrevokedword one')]);
      await s.harness.indexMessages();
      expect(s.search('zqxrevokedword')).toHaveLength(1);
      if (revoke === 'connection') s.mirrors.revoke(REF, s.harness.human);
      else s.mirrors.revokeAbsentRooms(REF, s.harness.human, new Set());
      s.mirrors.purgeRevoked(REF, s.harness.human);
      await s.sync.whenScrubbed();
      expect(s.harness.store.listEntriesAfter(s.room.id, 0)).toEqual([]);
      expect(s.harness.db.select().from(communityMirrorEntries).all()).toEqual([]);
      expect(s.search('zqxrevokedword')).toEqual([]);
    }
  });

  // Purpose (delta review 1): readmission after a purge starts a fresh local room, so imported
  // entries do not reuse sequence numbers a reader already marked read or resumed past, and the
  // old room is gone. It fails if the purged room row or its members survive.
  it('gives a readmitted mirror a fresh room after a purge', async () => {
    const s = setup();
    s.mirrors.importEntries(REF, ROOM, [native(1, 'one'), native(2, 'two')]);
    s.mirrors.revoke(REF, s.harness.human);
    s.mirrors.purgeRevoked(REF, s.harness.human);
    expect(s.harness.store.getRoom(s.room.id)).toBeNull();
    const again = s.mirrors.ensureRoom({
      communityRef: REF,
      remoteRoomId: ROOM,
      title: 'General',
      topic: null,
      ownerAuthorId: s.harness.human,
      accessors: [],
      authorizedAt: '2026-09-24T01:00:00.000Z',
    });
    expect(again.id).not.toBe(s.room.id);
    const [first] = s.mirrors.importEntries(REF, ROOM, [native(3, 'three')]);
    expect(first?.seq).toBe(1);
    expect(s.mirrors.canRead(again.id, s.harness.human)).toBe(true);
  });

  // Purpose (delta review 2): revoking one owner's connection leaves another owner's mirrors of
  // the same community alone.
  it("revokes and purges only the revoking owner's mirrors", async () => {
    const s = setup();
    const other = s.harness.authors.resolveExternal({
      platformType: 'test',
      instanceId: 'x',
      platformUserId: 'other-owner',
      displayName: 'Other owner',
    }).id;
    const theirs = s.mirrors.ensureRoom({
      communityRef: REF,
      remoteRoomId: 'random',
      title: 'Random',
      topic: null,
      ownerAuthorId: other,
      accessors: [],
      authorizedAt: '2026-09-24T00:00:00.000Z',
    });
    const random = native(1, 'theirs');
    random.entry = { ...random.entry, roomId: 'random' };
    s.mirrors.importEntries(REF, 'random', [random]);
    s.mirrors.revoke(REF, s.harness.human);
    s.mirrors.purgeRevoked(REF, s.harness.human);
    expect(s.harness.store.getRoom(s.room.id)).toBeNull();
    expect(s.mirrors.canRead(theirs.id, other)).toBe(true);
    expect(s.harness.store.listEntriesAfter(theirs.id, 0)).toHaveLength(1);
  });

  // Purpose (delta review 3): a local agent's delivered post that is not cached yet still has its
  // change remembered, so the post's own late echo is stored as it is now.
  it("remembers a change to a delivered post, so its late echo can't bring the text back", async () => {
    const s = setup();
    const local = s.harness.service.post(s.room.id, {
      authorId: s.harness.human,
      text: 'zqxechoword here',
    });
    s.harness.db
      .insert(communityOutbox)
      .values({
        id: 'outbox-echo',
        communityRef: REF,
        remoteRoomId: ROOM,
        ownerAuthorId: s.harness.human,
        localEntryId: local.id,
        localParentEntryId: null,
        localAgentId: 'local-ana',
        attachmentIds: '[]',
        idempotencyKey: 'key-echo',
        state: 'confirmed',
        createdAt: '2026-09-24T00:00:00.000Z',
        expiresAt: '2026-09-24T00:05:00.000Z',
        remoteEntryId: 'entry-7',
        failure: null,
        attempts: 1,
        nextAttemptAt: '2026-09-24T00:00:00.000Z',
      })
      .run();
    s.pages.push({
      items: [native(7, 'This message was removed by the host.')],
      nextCursor: 'c1',
      hasMore: false,
    });
    await s.sync.sync(s.target, {});
    const [echo] = s.mirrors.importEntries(REF, ROOM, [native(7, 'zqxechoword here')]);
    expect(echo?.body.text).toBe('This message was removed by the host.');
    expect(s.search('zqxechoword')).toEqual([]);
  });

  // Purpose (delta review 4): if the purge's search drop never runs, the next search sweep still
  // removes the deleted room, because it prunes containers that no longer exist.
  it('lets the next sweep drop a purged room from search if the purge could not', async () => {
    const s = setup();
    const unwired = new RemoteMirrorStore(s.harness.db, s.harness.store, s.harness.authors);
    unwired.importEntries(REF, ROOM, [native(1, 'zqxsweepword')]);
    await s.harness.indexMessages();
    expect(s.search('zqxsweepword')).toHaveLength(1);
    unwired.revoke(REF, s.harness.human);
    unwired.purgeRevoked(REF, s.harness.human);
    expect(s.search('zqxsweepword')).toHaveLength(1);
    await s.harness.indexMessages();
    expect(s.search('zqxsweepword')).toEqual([]);
  });

  // Purpose (delta review 5): a purge takes files that were uploaded and never posted too, rows
  // and bytes.
  it('deletes unbound files with a purged room', async () => {
    const s = setup();
    s.harness.db
      .insert(roomAttachments)
      .values({
        roomId: s.room.id,
        id: 'att-unbound',
        entryId: null,
        authorId: s.harness.human,
        name: 'draft.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        size: 3,
        createdAt: '2026-09-24T00:00:00.000Z',
      })
      .run();
    s.mirrors.revoke(REF, s.harness.human);
    s.mirrors.purgeRevoked(REF, s.harness.human);
    await s.sync.whenScrubbed();
    expect(s.harness.db.select().from(roomAttachments).all()).toEqual([]);
    expect(s.deletedFiles).toEqual([`${s.room.id}/att-unbound.txt`]);
  });

  // Purpose: an inbox notification that quoted a message is a copy of it. When the message is
  // removed its preview is rewritten, and when its author is erased the name in its title goes
  // too. It fails if only the room log is rewritten.
  it('rewrites inbox notifications that quote a changed message', async () => {
    const s = setup();
    s.mirrors.importEntries(REF, ROOM, [native(1, 'zqxquoted words', 'Zephyrine Quill')]);
    const cachedId = s.harness.store.listEntriesAfter(s.room.id, 0)[0]!.id;
    quoteNotification(s, cachedId, 'Zephyrine Quill', 'zqxquoted words');
    const local = s.harness.service.post(s.room.id, {
      authorId: s.harness.human,
      text: 'zqxagentquote here',
    });
    s.harness.db
      .insert(communityOutbox)
      .values({
        id: 'outbox-quote',
        communityRef: REF,
        remoteRoomId: ROOM,
        ownerAuthorId: s.harness.human,
        localEntryId: local.id,
        localParentEntryId: null,
        localAgentId: 'local-ana',
        attachmentIds: '[]',
        idempotencyKey: 'key-quote',
        state: 'confirmed',
        createdAt: '2026-09-24T00:00:00.000Z',
        expiresAt: '2026-09-24T00:05:00.000Z',
        remoteEntryId: 'entry-7',
        failure: null,
        attempts: 1,
        nextAttemptAt: '2026-09-24T00:00:00.000Z',
      })
      .run();
    quoteNotification(s, local.id, 'Ana', 'zqxagentquote here');
    // A notification about another message in the room is left alone.
    quoteNotification(s, 'another-entry', 'Bo', 'zqxuntouched');
    expect(inbox(s)).toContain('zqxquoted');
    s.pages.push({
      items: [
        native(1, 'This message was erased.', 'Erased member'),
        native(7, 'This message was removed by the host.'),
      ],
      nextCursor: 'c1',
      hasMore: false,
    });
    await s.sync.sync(s.target, {});
    const rows = s.harness.db.select().from(notifications).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(`n-${cachedId}`)).toMatchObject({
      title: 'Erased member mentioned you in General',
      body: 'This message was erased.',
    });
    expect(byId.get(`n-${local.id}`)).toMatchObject({
      title: 'Ana mentioned you in General',
      body: 'This message was removed by the host.',
    });
    expect(inbox(s)).not.toMatch(/zqxquoted|zqxagentquote|Zephyrine/);
    expect(inbox(s)).toContain('zqxuntouched');
  });

  // Purpose: a purged room's inbox notifications go with it.
  it("deletes a purged room's notifications", async () => {
    const s = setup();
    quoteNotification(s, 'entry-x', 'Bo', 'zqxpurgedquote');
    s.mirrors.revoke(REF, s.harness.human);
    s.mirrors.purgeRevoked(REF, s.harness.human);
    expect(s.harness.db.select().from(notifications).all()).toEqual([]);
  });

  // Purpose: several agents' streams share one room; concurrent syncs share one read, and a
  // revoked mirror is never read at all (a departed member's copy keeps what it had).
  it('shares one read between concurrent syncs and never reads a revoked mirror', async () => {
    const s = setup();
    s.pages.push({ items: [], nextCursor: 'c1', hasMore: false });
    await Promise.all([s.sync.sync(s.target, {}), s.sync.sync(s.target, {})]);
    expect(s.readRedactions).toHaveBeenCalledOnce();

    s.mirrors.revoke(REF, s.harness.human);
    await s.sync.sync(s.target, {});
    expect(s.readRedactions).toHaveBeenCalledOnce();
  });
});
