/**
 * `BridgeStore` proved directly against a real SQLite connection
 * (`better-sqlite3`), the same way `RoomStore`'s own tests are — this store's
 * two load-bearing claims are both about the DATABASE, not about JavaScript:
 * the unique indexes reject a second bridge (spec §10.10, A10.6), and the
 * external-ref table is the structural echo-suppression mechanism (spec §6.3).
 * A mock would just encode the hypothesis being tested.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { RoomStore, type NewRoomEntry } from '../../../rooms/room-store.js';
import { BridgeStore, type NewBridge } from '../bridge-store.js';

const ROOM_ID = 'room-1';
const ADAPTER_ID = 'tg-main';
const CHAT_ID = '555';

function bridge(overrides: Partial<NewBridge> = {}): NewBridge {
  return {
    roomId: ROOM_ID,
    adapterId: ADAPTER_ID,
    chatId: CHAT_ID,
    channelType: null,
    platformChatType: 'private',
    bindingId: 'binding-1',
    platformTitle: null,
    deliverNotices: true,
    createdAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

/** Seed a room so a bridge row and its entries have something to point at. */
function seedRoom(roomStore: RoomStore, id = ROOM_ID): void {
  roomStore.createRoom(
    {
      id,
      kind: 'dm',
      slug: null,
      title: 'Bridged chat',
      topic: null,
      createdAt: '2026-08-03T00:00:00.000Z',
    },
    []
  );
}

function entry(roomStore: RoomStore, roomId: string, id: string, authorId = 'author-1') {
  const newEntry: NewRoomEntry = {
    roomId,
    id,
    authorId,
    kind: 'post',
    body: { text: 'hello' },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    createdAt: '2026-08-03T00:00:01.000Z',
  };
  return roomStore.appendEntry(newEntry);
}

describe('BridgeStore', () => {
  let db: Db;
  let store: BridgeStore;
  let rooms: RoomStore;

  beforeEach(() => {
    db = createTestDb();
    store = new BridgeStore(db);
    rooms = new RoomStore(db);
    seedRoom(rooms);
  });

  describe('createBridge / findBridgeByRoom / findBridgeByChat', () => {
    it('creates a bridge row and finds it by room and by (adapterId, chatId)', () => {
      const created = store.createBridge(bridge());
      expect(created.roomId).toBe(ROOM_ID);
      expect(created.lastDeliveredSeq).toBe(0);
      expect(created.archivedAt).toBeNull();

      expect(store.findBridgeByRoom(ROOM_ID)).toEqual(created);
      expect(store.findBridgeByChat(ADAPTER_ID, CHAT_ID)).toEqual(created);
    });

    it('returns null for a room or chat with no bridge', () => {
      expect(store.findBridgeByRoom('no-such-room')).toBeNull();
      expect(store.findBridgeByChat('no-such-adapter', 'no-such-chat')).toBeNull();
    });
  });

  describe('unique indexes (spec §10.10, A10.6) — asserted on the raw constraint', () => {
    it('rejects a second bridge row for an occupied roomId', () => {
      store.createBridge(bridge());
      seedRoom(rooms, 'other-room');
      expect(() =>
        store.createBridge(bridge({ roomId: ROOM_ID, chatId: 'a-different-chat' }))
      ).toThrow(/UNIQUE constraint failed/);
    });

    it('rejects a second bridge row for an occupied (adapterId, chatId)', () => {
      store.createBridge(bridge());
      seedRoom(rooms, 'other-room');
      expect(() => store.createBridge(bridge({ roomId: 'other-room' }))).toThrow(
        /UNIQUE constraint failed/
      );
    });

    it('allows the same chatId on a different adapter', () => {
      store.createBridge(bridge());
      seedRoom(rooms, 'other-room');
      expect(() =>
        store.createBridge(bridge({ roomId: 'other-room', adapterId: 'tg-second' }))
      ).not.toThrow();
    });
  });

  describe('archiveBridge / unarchiveBridge (spec §3.5)', () => {
    it('stamps archivedAt and leaves every other column untouched', () => {
      const created = store.createBridge(bridge());
      const archived = store.archiveBridge(ROOM_ID, '2026-08-03T01:00:00.000Z');
      expect(archived?.archivedAt).toBe('2026-08-03T01:00:00.000Z');
      expect(archived?.adapterId).toBe(created.adapterId);
      expect(archived?.chatId).toBe(created.chatId);
      expect(archived?.bindingId).toBe(created.bindingId);
    });

    it('un-archiving clears archivedAt and reuses the same row', () => {
      store.createBridge(bridge());
      store.archiveBridge(ROOM_ID, '2026-08-03T01:00:00.000Z');
      const unarchived = store.unarchiveBridge(ROOM_ID);
      expect(unarchived?.archivedAt).toBeNull();
      expect(unarchived?.roomId).toBe(ROOM_ID);
    });

    it('the row and its refs survive archival — un-bridging never deletes anything', () => {
      store.createBridge(bridge());
      const posted = entry(rooms, ROOM_ID, 'entry-1');
      store.recordInboundRef({
        roomId: ROOM_ID,
        entryId: posted.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        platformMessageId: 'pm-1',
        createdAt: posted.createdAt,
      });

      store.archiveBridge(ROOM_ID, '2026-08-03T01:00:00.000Z');

      expect(store.findBridgeByRoom(ROOM_ID)).not.toBeNull();
      expect(store.findRefByEntry(posted.id)).not.toBeNull();
    });
  });

  describe('rebindBridge (spec §3.5 — different-agent re-bridge adopts the row)', () => {
    it('re-points bindingId and leaves everything else, including roomId, alone', () => {
      const created = store.createBridge(bridge({ bindingId: 'binding-old' }));
      const rebound = store.rebindBridge(ROOM_ID, 'binding-new');
      expect(rebound?.bindingId).toBe('binding-new');
      expect(rebound?.roomId).toBe(created.roomId);
      expect(rebound?.adapterId).toBe(created.adapterId);
    });
  });

  describe('stampActivity', () => {
    it('advances lastActivityAt', () => {
      store.createBridge(bridge());
      const stamped = store.stampActivity(ROOM_ID, '2026-08-03T02:00:00.000Z');
      expect(stamped?.lastActivityAt).toBe('2026-08-03T02:00:00.000Z');
    });
  });

  describe('setLastDeliveredSeq — the catch-up scan cursor (spec §6.1)', () => {
    it('advances the cursor', () => {
      store.createBridge(bridge());
      const updated = store.setLastDeliveredSeq(ROOM_ID, 5);
      expect(updated?.lastDeliveredSeq).toBe(5);
    });

    it('is monotonic — a lower value never moves the cursor backward', () => {
      store.createBridge(bridge());
      store.setLastDeliveredSeq(ROOM_ID, 10);
      const afterLowerAttempt = store.setLastDeliveredSeq(ROOM_ID, 3);
      expect(afterLowerAttempt?.lastDeliveredSeq).toBe(10);
    });
  });

  describe('setVisibility (spec §8)', () => {
    it('sets visibility and visibilityCheckedAt together', () => {
      store.createBridge(bridge());
      const updated = store.setVisibility(ROOM_ID, 'mentions-only', '2026-08-03T03:00:00.000Z');
      expect(updated?.visibility).toBe('mentions-only');
      expect(updated?.visibilityCheckedAt).toBe('2026-08-03T03:00:00.000Z');
    });

    it('clears visibility with null', () => {
      store.createBridge(bridge());
      store.setVisibility(ROOM_ID, 'everything', '2026-08-03T03:00:00.000Z');
      const cleared = store.setVisibility(ROOM_ID, null, '2026-08-03T04:00:00.000Z');
      expect(cleared?.visibility).toBeNull();
    });
  });

  describe('setDeliverNotices — the one per-bridge override (spec §6.2, D-6 Q5)', () => {
    it('flips the seeded value and it sticks', () => {
      store.createBridge(bridge({ deliverNotices: false }));
      const updated = store.setDeliverNotices(ROOM_ID, true);
      expect(updated?.deliverNotices).toBe(true);
    });

    it('flips it back off', () => {
      store.createBridge(bridge({ deliverNotices: true }));
      store.setDeliverNotices(ROOM_ID, false);
      const cleared = store.setDeliverNotices(ROOM_ID, false);
      expect(cleared?.deliverNotices).toBe(false);
    });

    it('is a no-op read on a room with no bridge', () => {
      expect(store.setDeliverNotices('no-such-room', true)).toBeNull();
    });
  });

  describe('external refs (spec §6.3 — the only echo-suppression mechanism)', () => {
    it('records an inbound ref with its platform message id', () => {
      store.createBridge(bridge());
      const posted = entry(rooms, ROOM_ID, 'entry-in');
      const ref = store.recordInboundRef({
        roomId: ROOM_ID,
        entryId: posted.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        platformMessageId: 'pm-100',
        threadId: 'topic-1',
        threadName: 'General',
        createdAt: posted.createdAt,
      });
      expect(ref.direction).toBe('inbound');
      expect(ref.platformMessageId).toBe('pm-100');
      expect(ref.threadId).toBe('topic-1');
      expect(ref.threadName).toBe('General');
    });

    it('an outbound ref may be written with a null platformMessageId and patched afterward (write-before-send)', () => {
      store.createBridge(bridge());
      const posted = entry(rooms, ROOM_ID, 'entry-out');
      const written = store.recordOutboundRef({
        roomId: ROOM_ID,
        entryId: posted.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        createdAt: posted.createdAt,
      });
      expect(written.direction).toBe('outbound');
      expect(written.platformMessageId).toBeNull();

      const patched = store.patchOutboundPlatformId(posted.id, 'pm-sent-200');
      expect(patched?.platformMessageId).toBe('pm-sent-200');
      expect(store.findRefByEntry(posted.id)?.platformMessageId).toBe('pm-sent-200');
    });

    it('findRefByEntry finds a ref of either direction — deliver idempotence (spec §6.3)', () => {
      store.createBridge(bridge());
      const inbound = entry(rooms, ROOM_ID, 'entry-a');
      const outbound = entry(rooms, ROOM_ID, 'entry-b');
      store.recordInboundRef({
        roomId: ROOM_ID,
        entryId: inbound.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        platformMessageId: 'pm-a',
        createdAt: inbound.createdAt,
      });
      store.recordOutboundRef({
        roomId: ROOM_ID,
        entryId: outbound.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        createdAt: outbound.createdAt,
      });
      expect(store.findRefByEntry(inbound.id)?.direction).toBe('inbound');
      expect(store.findRefByEntry(outbound.id)?.direction).toBe('outbound');
      expect(store.findRefByEntry('no-such-entry')).toBeNull();
    });

    it('findRefsByEntries reads a batch in one query — room_context topic-label lookup (task 1.13)', () => {
      store.createBridge(bridge());
      const withTopic = entry(rooms, ROOM_ID, 'entry-topic');
      const noTopic = entry(rooms, ROOM_ID, 'entry-no-topic');
      store.recordInboundRef({
        roomId: ROOM_ID,
        entryId: withTopic.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        platformMessageId: 'pm-topic',
        threadId: 'topic-1',
        threadName: 'Release 2.0',
        createdAt: withTopic.createdAt,
      });
      store.recordInboundRef({
        roomId: ROOM_ID,
        entryId: noTopic.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        platformMessageId: 'pm-no-topic',
        createdAt: noTopic.createdAt,
      });

      const refs = store.findRefsByEntries([withTopic.id, noTopic.id, 'entry-never-existed']);

      expect(refs.size).toBe(2);
      expect(refs.get(withTopic.id)?.threadName).toBe('Release 2.0');
      expect(refs.get(noTopic.id)?.threadName).toBeNull();
      expect(refs.has('entry-never-existed')).toBe(false);
    });

    it('findRefsByEntries returns an empty map for an empty list without querying', () => {
      store.createBridge(bridge());
      expect(store.findRefsByEntries([])).toEqual(new Map());
    });

    it('findInboundRefByPlatformMessage is the dedup lookup (spec §5.2 step 1)', () => {
      store.createBridge(bridge());
      const posted = entry(rooms, ROOM_ID, 'entry-dedup');
      store.recordInboundRef({
        roomId: ROOM_ID,
        entryId: posted.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        platformMessageId: 'pm-dedup',
        createdAt: posted.createdAt,
      });

      expect(store.findInboundRefByPlatformMessage(ADAPTER_ID, CHAT_ID, 'pm-dedup')).not.toBeNull();
      expect(
        store.findInboundRefByPlatformMessage(ADAPTER_ID, CHAT_ID, 'no-such-message')
      ).toBeNull();
    });

    it('the inbound dedup index is scoped to direction: outbound rows never collide on a null platformMessageId', () => {
      store.createBridge(bridge());
      const a = entry(rooms, ROOM_ID, 'entry-out-a');
      const b = entry(rooms, ROOM_ID, 'entry-out-b');
      expect(() =>
        store.recordOutboundRef({
          roomId: ROOM_ID,
          entryId: a.id,
          chatId: CHAT_ID,
          adapterId: ADAPTER_ID,
          createdAt: a.createdAt,
        })
      ).not.toThrow();
      expect(() =>
        store.recordOutboundRef({
          roomId: ROOM_ID,
          entryId: b.id,
          chatId: CHAT_ID,
          adapterId: ADAPTER_ID,
          createdAt: b.createdAt,
        })
      ).not.toThrow();
    });

    it('deliver idempotence: the entry unique index rejects a second ref for the same entry', () => {
      store.createBridge(bridge());
      const posted = entry(rooms, ROOM_ID, 'entry-twice');
      store.recordOutboundRef({
        roomId: ROOM_ID,
        entryId: posted.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        createdAt: posted.createdAt,
      });
      expect(() =>
        store.recordOutboundRef({
          roomId: ROOM_ID,
          entryId: posted.id,
          chatId: CHAT_ID,
          adapterId: ADAPTER_ID,
          createdAt: posted.createdAt,
        })
      ).toThrow(/UNIQUE constraint failed/);
    });
  });

  describe('listUndeliveredAboveSeq — the catch-up scan candidate list (spec §6.1)', () => {
    it('returns entries above the cursor with no external ref, in seq order', () => {
      store.createBridge(bridge());
      const first = entry(rooms, ROOM_ID, 'entry-1');
      const second = entry(rooms, ROOM_ID, 'entry-2');

      const candidates = store.listUndeliveredAboveSeq(ROOM_ID, 0);
      expect(candidates.map((e) => e.id)).toEqual([first.id, second.id]);
    });

    it('excludes an entry with an inbound ref — it is not a delivery candidate at all (echo suppression)', () => {
      store.createBridge(bridge());
      const inbound = entry(rooms, ROOM_ID, 'entry-inbound');
      const plain = entry(rooms, ROOM_ID, 'entry-plain');
      store.recordInboundRef({
        roomId: ROOM_ID,
        entryId: inbound.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        platformMessageId: 'pm-1',
        createdAt: inbound.createdAt,
      });

      const candidates = store.listUndeliveredAboveSeq(ROOM_ID, 0);
      expect(candidates.map((e) => e.id)).toEqual([plain.id]);
    });

    it('excludes an entry with an outbound ref — already delivered or in flight', () => {
      store.createBridge(bridge());
      const delivered = entry(rooms, ROOM_ID, 'entry-delivered');
      const plain = entry(rooms, ROOM_ID, 'entry-plain-2');
      store.recordOutboundRef({
        roomId: ROOM_ID,
        entryId: delivered.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        createdAt: delivered.createdAt,
      });

      const candidates = store.listUndeliveredAboveSeq(ROOM_ID, 0);
      expect(candidates.map((e) => e.id)).toEqual([plain.id]);
    });

    it('respects the seq floor', () => {
      store.createBridge(bridge());
      const first = entry(rooms, ROOM_ID, 'entry-1');
      const second = entry(rooms, ROOM_ID, 'entry-2');

      const candidates = store.listUndeliveredAboveSeq(ROOM_ID, first.seq);
      expect(candidates.map((e) => e.id)).toEqual([second.id]);
    });
  });

  describe('listStaleNullOutboundRefs — the startup stranded-ref sweep candidate list (spec §10.1, DOR-898)', () => {
    it('returns a null-platformMessageId outbound ref older than the cutoff', () => {
      store.createBridge(bridge());
      const stranded = entry(rooms, ROOM_ID, 'entry-stranded');
      store.recordOutboundRef({
        roomId: ROOM_ID,
        entryId: stranded.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        createdAt: '2026-08-03T00:00:00.000Z',
      });

      const stale = store.listStaleNullOutboundRefs('2026-08-03T00:10:00.000Z');

      expect(stale.map((r) => r.entryId)).toEqual([stranded.id]);
      expect(stale[0].platformMessageId).toBeNull();
    });

    it('excludes a null-id ref that is not yet older than the cutoff (a plausibly in-flight retry)', () => {
      store.createBridge(bridge());
      const fresh = entry(rooms, ROOM_ID, 'entry-fresh');
      store.recordOutboundRef({
        roomId: ROOM_ID,
        entryId: fresh.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        createdAt: '2026-08-03T00:15:00.000Z',
      });

      expect(store.listStaleNullOutboundRefs('2026-08-03T00:10:00.000Z')).toEqual([]);
    });

    it('excludes a ref that already carries a platform id (delivered)', () => {
      store.createBridge(bridge());
      const delivered = entry(rooms, ROOM_ID, 'entry-delivered-old');
      store.recordOutboundRef({
        roomId: ROOM_ID,
        entryId: delivered.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        createdAt: '2026-08-03T00:00:00.000Z',
      });
      store.patchOutboundPlatformId(delivered.id, 'pm-delivered');

      expect(store.listStaleNullOutboundRefs('2026-08-03T00:10:00.000Z')).toEqual([]);
    });

    it('excludes an inbound ref — this candidate list is outbound-only', () => {
      store.createBridge(bridge());
      const inbound = entry(rooms, ROOM_ID, 'entry-inbound-old');
      store.recordInboundRef({
        roomId: ROOM_ID,
        entryId: inbound.id,
        chatId: CHAT_ID,
        adapterId: ADAPTER_ID,
        platformMessageId: 'pm-in',
        createdAt: '2026-08-03T00:00:00.000Z',
      });

      expect(store.listStaleNullOutboundRefs('2026-08-03T00:10:00.000Z')).toEqual([]);
    });
  });

  describe('optional transaction handle — participation, not atomicity (spec §5.2 steps 4–6)', () => {
    it('a ref written inside the caller-supplied transaction rolls back with it', () => {
      store.createBridge(bridge());
      const posted = entry(rooms, ROOM_ID, 'entry-atomic');

      expect(() => {
        db.transaction((tx) => {
          store.recordInboundRef(
            {
              roomId: ROOM_ID,
              entryId: posted.id,
              chatId: CHAT_ID,
              adapterId: ADAPTER_ID,
              platformMessageId: 'pm-atomic',
              createdAt: posted.createdAt,
            },
            tx
          );
          throw new Error('simulated failure after the ref write');
        });
      }).toThrow('simulated failure after the ref write');

      expect(store.findRefByEntry(posted.id)).toBeNull();
    });

    it('a ref written inside the caller-supplied transaction commits with it', () => {
      store.createBridge(bridge());
      const posted = entry(rooms, ROOM_ID, 'entry-atomic-2');

      db.transaction((tx) => {
        store.recordInboundRef(
          {
            roomId: ROOM_ID,
            entryId: posted.id,
            chatId: CHAT_ID,
            adapterId: ADAPTER_ID,
            platformMessageId: 'pm-atomic-2',
            createdAt: posted.createdAt,
          },
          tx
        );
      });

      expect(store.findRefByEntry(posted.id)).not.toBeNull();
    });

    // NEGATIVE CONTROL — omitting `tx` produces the IDENTICAL result to
    // supplying it. `@dorkos/db` is one `better-sqlite3` connection, so a
    // plain `this.db.insert(...).run()` called synchronously from inside
    // `db.transaction(...)` already lands in that same open transaction —
    // there is only one connection for it to run against. This is what the
    // two tests above cannot prove on their own: they show the write rolls
    // back / commits WITH the surrounding transaction, but not that `tx`
    // caused that. This test omits `tx` entirely and gets the same rollback,
    // which is the proof. What `tx` actually buys, on this single-connection
    // database, is explicitness — the call site declares its participation
    // instead of relying on an accident of call order — and it is the seam
    // that starts mattering for real atomicity the day `@dorkos/db` stops
    // being one connection. See `DbTransaction`'s doc in `@dorkos/db`.
    it('negative control: the SAME rollback happens with tx omitted, because this is one connection', () => {
      store.createBridge(bridge());
      const posted = entry(rooms, ROOM_ID, 'entry-no-tx');

      expect(() => {
        db.transaction(() => {
          // No `tx` argument — writes against `this.db` directly.
          store.recordInboundRef({
            roomId: ROOM_ID,
            entryId: posted.id,
            chatId: CHAT_ID,
            adapterId: ADAPTER_ID,
            platformMessageId: 'pm-no-tx',
            createdAt: posted.createdAt,
          });
          throw new Error('simulated failure after the ref write');
        });
      }).toThrow('simulated failure after the ref write');

      // Identical outcome to the `tx`-supplied rollback test above: the ref
      // is gone. `tx` was not what made this roll back.
      expect(store.findRefByEntry(posted.id)).toBeNull();
    });
  });
});
