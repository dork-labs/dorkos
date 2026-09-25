/**
 * The redaction sync's own decisions, against a real SQLite mirror and a scripted feed: where it
 * resumes, when it starts over, what it skips, and when it stops asking. The end-to-end proof
 * against a real Community server, including the bytes on disk, is
 * `apps/community/src/__tests__/redaction-mirror.integration.test.ts`.
 *
 * @module services/communities/remote/__tests__/remote-redaction-sync
 */
import {
  CommunityRoomNotFoundError,
  StaleCommunityCursorError,
  type CommunityEntry,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import {
  communityMirrorEntries,
  communityMirrorRedactions,
  communityOutbox,
  notifications,
  roomAttachments,
} from '@dorkos/db';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../../../lib/logger.js';
import { agentLookupFor, createRoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import { searchMessages } from '../../../search/index.js';
import { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import { RemoteMirrorStore, type NativeMirrorEntry } from '../mirror-store.js';
import { RemoteRoomSubscriptionBridge } from '../remote-room-subscription-bridge.js';
import {
  RemoteRedactionFeedUnsupportedError,
  type RemoteRedactionPage,
} from '../remote-community-adapter.js';
import { RemoteRedactionSync, UNSUPPORTED_RECHECK_MS } from '../remote-redaction-sync.js';

const REF = 'remote_sync' as CommunityRef;
const ROOM = 'general';

function native(seq: number, text: string, author = 'Rae Remote'): NativeMirrorEntry {
  const entry: CommunityEntry = {
    community: REF,
    roomId: ROOM,
    id: `entry-${seq}`,
    authorId: 'remote-rae',
    text,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `cursor-${seq}` as CommunityEntry['cursor'],
    createdAt: '2026-09-24T00:00:00.000Z',
  };
  return {
    entry,
    remoteSeq: seq,
    author: { memberId: 'remote-rae', displayName: author, kind: 'human' },
  };
}

function setup(agents = agentLookupFor({})) {
  const harness = createRoomHarness({ agents });
  const clock = { now: Date.parse('2026-09-24T00:00:00.000Z') };
  const late: { sync?: RemoteRedactionSync } = {};
  // Wired as production wires it: a revocation's purge is finished by the sync.
  const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors, (purge) =>
    late.sync?.afterPurge(purge)
  );
  const room = mirrors.ensureRoom({
    communityRef: REF,
    remoteRoomId: ROOM,
    title: 'General',
    topic: null,
    ownerAuthorId: harness.human,
    accessors: [],
    authorizedAt: '2026-09-24T00:00:00.000Z',
  });
  const pages: Array<RemoteRedactionPage | Error> = [];
  const asked: Array<string | undefined> = [];
  const readRedactions = vi.fn(async (_roomId: string, opts: { cursor?: string } = {}) => {
    asked.push(opts.cursor);
    const next = pages.shift();
    if (!next) throw new Error('no page scripted');
    if (next instanceof Error) throw next;
    return next;
  });
  const deletedFiles: string[] = [];
  const sync = new RemoteRedactionSync({
    db: harness.db,
    mirrors,
    readers: () => ({ readRedactions }),
    now: () => clock.now,
    attachmentBytes: {
      delete: async (roomId, attachmentId, extension) => {
        deletedFiles.push(`${roomId}/${attachmentId}.${extension}`);
      },
    },
  });
  late.sync = sync;
  const target = { communityRef: REF, remoteRoomId: ROOM, ownerAuthorId: harness.human };
  const search = (word: string) =>
    searchMessages(harness.db, {
      scopes: [{ sourceId: 'rooms', visibility: 'all' }],
      query: word,
      limit: 5,
    });
  return {
    harness,
    clock,
    mirrors,
    room,
    pages,
    asked,
    readRedactions,
    sync,
    target,
    search,
    deletedFiles,
  };
}

/** An inbox row quoting one room entry, as the room-message emitter writes it. */
function quoteNotification(
  s: ReturnType<typeof setup>,
  entryId: string,
  fromName: string,
  preview: string
) {
  const payload = {
    roomId: s.room.id,
    entryId,
    entrySeq: 1,
    roomName: 'General',
    fromName,
    preview,
  };
  s.harness.db
    .insert(notifications)
    .values({
      id: `n-${entryId}`,
      kind: 'mention.received',
      tier: 'notable',
      subjectType: 'room',
      subjectId: s.room.id,
      roomId: s.room.id,
      title: `${fromName} mentioned you in General`,
      body: preview,
      dataJson: JSON.stringify(payload),
      dedupeKey: `mention:${entryId}`,
      createdAt: '2026-09-24T00:00:00.000Z',
    })
    .run();
}

const inbox = (s: ReturnType<typeof setup>) =>
  JSON.stringify(s.harness.db.select().from(notifications).all());

const cursorOf = (s: ReturnType<typeof setup>) =>
  s.mirrors.redactionCursor(REF, ROOM, s.harness.human)?.cursor;

describe('RemoteRedactionSync', () => {
  // Purpose: the stored cursor is where the next read starts, pages are followed while the server
  // says there are more, and only cached entries are rewritten. It fails if the cursor is not
  // stored, `hasMore` is ignored, or an uncached entry is invented.
  it('resumes from the stored cursor, follows hasMore, and rewrites only cached entries', async () => {
    const s = setup();
    s.mirrors.importEntries(REF, ROOM, [native(1, 'first words'), native(2, 'second words')]);
    s.pages.push(
      { items: [native(1, 'This message was deleted.')], nextCursor: 'c1', hasMore: true },
      { items: [native(9, 'This message was deleted.')], nextCursor: 'c2', hasMore: false }
    );
    await s.sync.sync(s.target, {});
    expect(s.asked).toEqual([undefined, 'c1']);
    expect(cursorOf(s)).toBe('c2');
    const texts = s.harness.store.listEntriesAfter(s.room.id, 0).map((entry) => entry.body.text);
    expect(texts).toEqual(['This message was deleted.', 'second words']);
    // The author's name is kept on a removal: only an erasure changes it.
    const author = s.harness.store.listEntriesAfter(s.room.id, 0)[0]!.authorId;
    expect(s.harness.authors.getById(author)?.displayName).toBe('Rae Remote');

    s.pages.push({ items: [], nextCursor: 'c2', hasMore: false });
    await s.sync.sync(s.target, {});
    expect(s.asked.at(-1)).toBe('c2');
  });

  // Purpose: the room is re-indexed in the same step, so search stops finding the old words. It
  // fails if the index is left to the append-only sweep, which never sees an in-place change.
  it('re-indexes the room so search stops finding the replaced text', async () => {
    const s = setup();
    s.mirrors.importEntries(REF, ROOM, [native(1, 'zqxsearchword here')]);
    await s.harness.indexMessages();
    const search = () =>
      searchMessages(s.harness.db, {
        scopes: [{ sourceId: 'rooms', visibility: 'all' }],
        query: 'zqxsearchword',
        limit: 5,
      });
    expect(search()).toHaveLength(1);
    s.pages.push({
      items: [native(1, 'This message was erased.', 'Erased member')],
      nextCursor: 'c1',
      hasMore: false,
    });
    await s.sync.sync(s.target, {});
    expect(search()).toEqual([]);
  });

  // Purpose: an erasure renames the author, and the handle derived from the erased name goes
  // with it. It fails if only the display name changes.
  it('renames an erased author and re-derives the handle', async () => {
    const s = setup();
    s.mirrors.importEntries(REF, ROOM, [native(1, 'hello', 'Zephyrine Quill')]);
    const authorId = s.harness.store.listEntriesAfter(s.room.id, 0)[0]!.authorId;
    expect(s.harness.authors.getById(authorId)?.handle).toContain('zephyrine');
    s.pages.push({
      items: [native(1, 'This message was erased.', 'Erased member')],
      nextCursor: 'c1',
      hasMore: false,
    });
    await s.sync.sync(s.target, {});
    const author = s.harness.authors.getById(authorId);
    expect(author?.displayName).toBe('Erased member');
    expect(author?.handle).not.toContain('zephyrine');
    expect(author?.handle).toContain('erased-member');
  });

  // Purpose: after a restore the server answers 410; the sync forgets its cursor and reads from
  // the start, once per sync, so a server that keeps refusing cannot loop it forever.
  it('starts over once on a stale cursor', async () => {
    const s = setup();
    s.mirrors.importEntries(REF, ROOM, [native(1, 'one')]);
    s.pages.push({ items: [], nextCursor: 'old', hasMore: false });
    await s.sync.sync(s.target, {});
    const stale = new StaleCommunityCursorError(REF, ROOM, 'restored');
    s.pages.push(stale, { items: [], nextCursor: 'fresh', hasMore: false });
    await s.sync.sync(s.target, {});
    expect(s.asked).toEqual([undefined, 'old', undefined]);
    expect(cursorOf(s)).toBe('fresh');

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    s.pages.push(stale, stale);
    await s.sync.sync(s.target, {});
    expect(s.asked.slice(-2)).toEqual(['fresh', undefined]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  // Purpose: a server from before the feed is skipped by the interval for an hour, not for the
  // life of the process, and a reconnect's replay asks again at once; the notice is logged once.
  // A channel that is no longer readable stops the sync quietly with the cursor kept.
  it('waits an hour before asking a server without the feed again, unless a replay asks', async () => {
    const s = setup();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    s.pages.push(new RemoteRedactionFeedUnsupportedError(REF));
    await s.sync.sync(s.target, {});
    await s.sync.sync(s.target, {});
    expect(s.readRedactions).toHaveBeenCalledOnce();
    s.pages.push(new RemoteRedactionFeedUnsupportedError(REF));
    await s.sync.sync(s.target, {}, { recheck: true });
    expect(s.readRedactions).toHaveBeenCalledTimes(2);
    s.clock.now += UNSUPPORTED_RECHECK_MS + 1;
    s.pages.push({ items: [], nextCursor: 'upgraded', hasMore: false });
    await s.sync.sync(s.target, {});
    expect(s.readRedactions).toHaveBeenCalledTimes(3);
    expect(cursorOf(s)).toBe('upgraded');
    expect(info).toHaveBeenCalledOnce();
    info.mockRestore();

    const t = setup();
    t.pages.push({ items: [], nextCursor: 'kept', hasMore: false });
    await t.sync.sync(t.target, {});
    t.pages.push(new CommunityRoomNotFoundError(REF, ROOM));
    await t.sync.sync(t.target, {});
    expect(cursorOf(t)).toBe('kept');
  });

  // Purpose: the index merge and the log checkpoint rewrite in proportion to the whole database,
  // so they run once per sync however many pages changed rows, and not at all when none did.
  it('compacts search once per sync, only when something changed', async () => {
    const s = setup();
    s.mirrors.importEntries(REF, ROOM, [native(1, 'a'), native(2, 'b'), native(3, 'c')]);
    const run = vi.spyOn(s.harness.db, 'run');
    const optimizes = () =>
      run.mock.calls.filter(([query]) => JSON.stringify(query).includes("'optimize'")).length;
    s.pages.push({ items: [], nextCursor: 'c0', hasMore: false });
    await s.sync.sync(s.target, {});
    expect(optimizes()).toBe(0);
    s.pages.push(
      { items: [native(1, 'This message was deleted.')], nextCursor: 'c1', hasMore: true },
      { items: [native(2, 'This message was deleted.')], nextCursor: 'c2', hasMore: true },
      { items: [native(3, 'This message was deleted.')], nextCursor: 'c3', hasMore: false }
    );
    await s.sync.sync(s.target, {});
    expect(optimizes()).toBe(1);
    run.mockRestore();
  });

  // Purpose: a local agent's own post that the outbox delivered as a remote entry is a copy too;
  // a removal or takedown of that entry rewrites it and drops it from search. It fails if only
  // cached remote entries are rewritten.
  it("rewrites a local agent's delivered post when its remote entry changes", async () => {
    const s = setup();
    const local = s.harness.service.post(s.room.id, {
      authorId: s.harness.human,
      text: 'zqxagentpost is here',
    });
    s.harness.db
      .insert(communityOutbox)
      .values({
        id: 'outbox-1',
        communityRef: REF,
        remoteRoomId: ROOM,
        ownerAuthorId: s.harness.human,
        localEntryId: local.id,
        localParentEntryId: null,
        localAgentId: 'local-ana',
        attachmentIds: '[]',
        idempotencyKey: 'key-1',
        state: 'confirmed',
        createdAt: '2026-09-24T00:00:00.000Z',
        expiresAt: '2026-09-24T00:05:00.000Z',
        remoteEntryId: 'entry-7',
        failure: null,
        attempts: 1,
        nextAttemptAt: '2026-09-24T00:00:00.000Z',
      })
      .run();
    expect(s.search('zqxagentpost')).toHaveLength(1);
    s.pages.push({
      items: [native(7, 'This message was removed by the host.')],
      nextCursor: 'c1',
      hasMore: false,
    });
    await s.sync.sync(s.target, {});
    const texts = s.harness.store.listEntriesAfter(s.room.id, 0).map((entry) => entry.body.text);
    expect(texts).toEqual(['This message was removed by the host.']);
    expect(s.search('zqxagentpost')).toEqual([]);
  });

  // Purpose: a change reported before the entry was cached is kept, so a stream frame or history
  // page read before the change and imported after the sync stores the entry as it is now, never
  // the older text. It fails if the feed item is simply skipped.
  it('keeps a late import from bringing back text the feed already reported changed', async () => {
    const s = setup();
    s.pages.push({
      items: [native(5, 'This message was erased.', 'Erased member')],
      nextCursor: 'c1',
      hasMore: false,
    });
    await s.sync.sync(s.target, {});
    const [saved] = s.mirrors.importEntries(REF, ROOM, [native(5, 'zqxlatesecret', 'Zed Quill')]);
    expect(saved?.body.text).toBe('This message was erased.');
    expect(s.harness.authors.getById(saved!.authorId)?.displayName).toBe('Erased member');
    // Imported once, the change is the cached entry's; nothing stays remembered beside it.
    expect(s.harness.db.select().from(communityMirrorRedactions).all()).toEqual([]);
  });

  // Purpose: a live frame read before its message was removed must not start a local agent on
  // it: the entry is stored as it is now, and dispatch reads the stored mentions, not the
  // frame's. It fails if dispatch trusts the frame.
  it('never dispatches an agent on a live frame for a message already removed', async () => {
    const s = setup(agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }));
    const ana = s.harness.authors.resolveAgent('/agents/ana', 'Ana');
    const enrollments = new CommunityAgentEnrollmentStore(s.harness.db);
    enrollments.activate({
      communityRef: REF,
      localAgentId: 'local-ana',
      remoteMemberId: 'remote-ana',
      ownerAuthorId: s.harness.human,
    });
    const bridge = new RemoteRoomSubscriptionBridge(
      s.mirrors,
      s.harness.service,
      enrollments,
      (localAgentId) => (localAgentId === 'local-ana' ? ana.id : null),
      () => Date.parse('2026-09-24T00:00:00.000Z')
    );
    const room = {
      communityRef: REF,
      remoteRoomId: ROOM,
      title: 'General',
      topic: null,
      ownerAuthorId: s.harness.human,
      accessors: [{ authorId: ana.id, responseMode: 'always' as const }],
      authorizedAt: '2026-09-24T00:00:00.000Z',
    };
    bridge.authorizeRoom(room);
    const removed = native(8, 'This message was deleted.');
    s.pages.push({ items: [removed], nextCursor: 'c1', hasMore: false });
    await s.sync.sync(s.target, {});
    const stale = native(8, 'zqxlive secret for @ana');
    stale.entry = { ...stale.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      { ...stale, serverCreatedAt: '2026-09-24T00:00:00.000Z' },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await s.harness.service.triggersIdle();
    expect(s.harness.runner.turns).toHaveLength(0);
    const texts = s.harness.store.listEntriesAfter(s.room.id, 0).map((entry) => entry.body.text);
    expect(texts).toEqual(['This message was deleted.']);

    // Control: a live mention that was never removed does dispatch.
    const fresh = native(9, 'hello @ana');
    fresh.entry = { ...fresh.entry, mentions: ['remote-ana'] };
    bridge.importLive(
      room,
      { ...fresh, serverCreatedAt: '2026-09-24T00:00:00.000Z' },
      { reconnect: false, wasActiveBeforeDisconnect: false, readOnly: false }
    );
    await s.harness.service.triggersIdle();
    expect(s.harness.runner.turns).toHaveLength(1);
  });

  // Purpose (review finding 1): a revoked mirror can no longer read the feed, so its content is
  // deleted — room entries, cached entries, and their search rows — rather than kept where a
  // later erasure or takedown could never reach it.
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
