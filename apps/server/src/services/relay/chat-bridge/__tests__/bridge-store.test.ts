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
import { RoomStore } from '../../../rooms/room-store.js';
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

describe('BridgeStore', () => {
  let db: Db;
  let store: BridgeStore;
  let rooms: RoomStore;

  function seedRoom(id = ROOM_ID): void {
    rooms.createRoom(
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

  function entry(id: string) {
    return rooms.appendEntry({
      roomId: ROOM_ID,
      id,
      authorId: 'author-1',
      kind: 'post',
      body: { text: 'hello' },
      mentions: [],
      sessionId: null,
      cascadeRoot: id,
      cascadeDepth: 0,
      parentEntryId: null,
      threadRootEntryId: null,
      createdAt: '2026-08-03T00:00:01.000Z',
    });
  }

  const inbound = (entryId: string, platformMessageId: string, extra: object = {}) =>
    store.recordInboundRef({
      roomId: ROOM_ID,
      entryId,
      chatId: CHAT_ID,
      adapterId: ADAPTER_ID,
      platformMessageId,
      createdAt: '2026-08-03T00:00:00.000Z',
      ...extra,
    });

  const outbound = (entryId: string, createdAt = '2026-08-03T00:00:00.000Z') =>
    store.recordOutboundRef({
      roomId: ROOM_ID,
      entryId,
      chatId: CHAT_ID,
      adapterId: ADAPTER_ID,
      createdAt,
    });

  beforeEach(() => {
    db = createTestDb();
    store = new BridgeStore(db);
    rooms = new RoomStore(db);
    seedRoom();
  });

  it('creates a bridge row and finds it by room and by (adapterId, chatId)', () => {
    const created = store.createBridge(bridge());
    expect(created.lastDeliveredSeq).toBe(0);
    expect(store.findBridgeByRoom(ROOM_ID)).toEqual(created);
    expect(store.findBridgeByChat(ADAPTER_ID, CHAT_ID)).toEqual(created);
    expect(store.findBridgeByChat('no-such-adapter', CHAT_ID)).toBeNull();
  });

  it('unique indexes reject a second bridge for an occupied room or chat, not for another adapter (spec §10.10)', () => {
    store.createBridge(bridge());
    seedRoom('other-room');
    expect(() => store.createBridge(bridge({ chatId: 'a-different-chat' }))).toThrow(
      /UNIQUE constraint failed/
    );
    expect(() => store.createBridge(bridge({ roomId: 'other-room' }))).toThrow(
      /UNIQUE constraint failed/
    );
    expect(() =>
      store.createBridge(bridge({ roomId: 'other-room', adapterId: 'tg-second' }))
    ).not.toThrow();
  });

  it('archiving keeps the row and its refs, and un-archiving reuses the row (spec §3.5)', () => {
    store.createBridge(bridge());
    inbound(entry('entry-1').id, 'pm-1');
    expect(store.archiveBridge(ROOM_ID, '2026-08-03T01:00:00.000Z')?.archivedAt).toBe(
      '2026-08-03T01:00:00.000Z'
    );
    expect(store.findRefByEntry('entry-1')).not.toBeNull();
    expect(store.unarchiveBridge(ROOM_ID)?.archivedAt).toBeNull();
  });

  it('the catch-up cursor is monotonic — a lower value never moves it backward', () => {
    store.createBridge(bridge());
    store.setLastDeliveredSeq(ROOM_ID, 10);
    expect(store.setLastDeliveredSeq(ROOM_ID, 3)?.lastDeliveredSeq).toBe(10);
  });

  describe('external refs (spec §6.3 — the only echo-suppression mechanism)', () => {
    beforeEach(() => store.createBridge(bridge()));

    it('an outbound ref is written with a null platform id and patched after send', () => {
      const posted = entry('entry-out');
      expect(outbound(posted.id).platformMessageId).toBeNull();
      store.patchOutboundPlatformId(posted.id, 'pm-sent-200');
      expect(store.findRefByEntry(posted.id)?.platformMessageId).toBe('pm-sent-200');
    });

    it('findRefsByEntries reads a batch, with topic names (task 1.13)', () => {
      inbound(entry('entry-topic').id, 'pm-topic', { threadId: 't1', threadName: 'Release 2.0' });
      inbound(entry('entry-no-topic').id, 'pm-no-topic');
      const refs = store.findRefsByEntries(['entry-topic', 'entry-no-topic', 'never']);
      expect(refs.size).toBe(2);
      expect(refs.get('entry-topic')?.threadName).toBe('Release 2.0');
      expect(refs.get('entry-no-topic')?.threadName).toBeNull();
    });

    it('findInboundRefByPlatformMessage is the dedup lookup (spec §5.2 step 1)', () => {
      inbound(entry('entry-dedup').id, 'pm-dedup');
      expect(store.findInboundRefByPlatformMessage(ADAPTER_ID, CHAT_ID, 'pm-dedup')).not.toBeNull();
      expect(store.findInboundRefByPlatformMessage(ADAPTER_ID, CHAT_ID, 'other')).toBeNull();
    });

    it('two outbound refs with null platform ids never collide; a second ref for one entry is rejected', () => {
      const a = entry('entry-out-a');
      outbound(a.id);
      expect(() => outbound(entry('entry-out-b').id)).not.toThrow();
      expect(() => outbound(a.id)).toThrow(/UNIQUE constraint failed/);
    });

    it('listUndeliveredAboveSeq skips entries with a ref of either direction and respects the floor (spec §6.1)', () => {
      const first = entry('entry-1');
      inbound(entry('entry-in').id, 'pm-1');
      outbound(entry('entry-delivered').id);
      const last = entry('entry-plain');
      expect(store.listUndeliveredAboveSeq(ROOM_ID, 0).map((e) => e.id)).toEqual([
        first.id,
        last.id,
      ]);
      expect(store.listUndeliveredAboveSeq(ROOM_ID, first.seq).map((e) => e.id)).toEqual([last.id]);
    });

    it('listStaleNullOutboundRefs returns only old, unsent outbound refs (DOR-898)', () => {
      outbound(entry('entry-stranded').id, '2026-08-03T00:00:00.000Z');
      outbound(entry('entry-fresh').id, '2026-08-03T00:15:00.000Z');
      outbound(entry('entry-sent').id, '2026-08-03T00:00:00.000Z');
      store.patchOutboundPlatformId('entry-sent', 'pm-sent');
      inbound(entry('entry-in').id, 'pm-in');
      expect(
        store.listStaleNullOutboundRefs('2026-08-03T00:10:00.000Z').map((r) => r.entryId)
      ).toEqual(['entry-stranded']);
    });

    it('a ref written inside a caller-supplied transaction rolls back with it (spec §5.2)', () => {
      const posted = entry('entry-atomic');
      expect(() =>
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
        })
      ).toThrow('simulated failure after the ref write');
      expect(store.findRefByEntry(posted.id)).toBeNull();
    });
  });
});
