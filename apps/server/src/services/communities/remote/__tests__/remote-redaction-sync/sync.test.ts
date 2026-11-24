import { REF, ROOM, native, setup, cursorOf } from './fixtures.js';
import { StaleCommunityCursorError } from '@dorkos/shared/community-adapter';
import { communityMirrorRedactions, communityOutbox } from '@dorkos/db';
import { describe, expect, it, vi } from 'vitest';
import { eventFanOut } from '../../../../core/event-fan-out.js';
import { logger } from '../../../../../lib/logger.js';
import { agentLookupFor } from '../../../../rooms/__tests__/room-test-harness.js';
import { searchMessages } from '../../../../search/index.js';
import { CommunityAgentEnrollmentStore } from '../../agent-enrollment-store.js';
import { RemoteRoomSubscriptionBridge } from '../../remote-room-subscription-bridge.js';

describe('RemoteRedactionSync', () => {
  // Purpose: the stored cursor is where the next read starts, pages are followed while the server
  // says there are more, and only cached entries are rewritten. It fails if the cursor is not
  // stored, `hasMore` is ignored, or an uncached entry is invented.
  it('addresses a purged mirror removal to its former member, not another account', () => {
    const s = setup();
    const publish = vi.spyOn(eventFanOut, 'broadcast');
    try {
      s.mirrors.revoke(REF, s.harness.human);
      s.mirrors.purgeRevoked(REF, s.harness.human);
      const notice = publish.mock.calls.find(([name]) => name === 'room_member_removed');
      expect(notice?.[1]).toEqual({ roomId: s.room.id, authorId: s.harness.human });
      expect(notice?.[2]?.({ kind: 'operator' })).toBe(true);
      expect(notice?.[2]?.({ kind: 'program', userId: 'outsider' })).toBe(false);
      expect(notice?.[2]?.({ kind: 'agent' })).toBe(false);
    } finally {
      publish.mockRestore();
    }
  });

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
});
