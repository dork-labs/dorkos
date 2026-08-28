/**
 * Why {@link RoomStore.appendEntry} has TWO transaction hooks rather than one.
 *
 * The room-attachments spec proposed binding an attachment through the existing
 * `within(tx)` seam. It cannot work, and this file is the proof rather than the
 * assertion: `within` runs as the transaction's FIRST statement, before the
 * `room_entries` row exists, so an `UPDATE room_attachments SET entry_id = …`
 * there points a foreign key at a parent that has not been written yet. SQLite
 * checks that key immediately — `createDb` sets `foreign_keys = ON` and drizzle
 * emits no `DEFERRABLE` clause — so the write fails.
 *
 * The first test below is the one that failed before `bind` existed. Keeping it
 * green now proves the ordering claim is still TRUE, not that the bug is gone:
 * it asserts the FK violation still happens when the write is put in the wrong
 * hook, which is what makes the second test's success mean something.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { roomAttachments, sql, type Db } from '@dorkos/db';
import { RoomStore, type NewRoomEntry } from '../room-store.js';

const ROOM_ID = 'room-1';
const ENTRY_ID = 'entry-1';
const ATTACHMENT_ID = 'att-1';

/** A minimal appendable entry; the caller varies what it cares about. */
function entry(overrides: Partial<NewRoomEntry> & { id: string }): NewRoomEntry {
  return {
    roomId: ROOM_ID,
    authorId: 'author-1',
    kind: 'post',
    body: { text: 'here is the crash log' },
    mentions: [],
    sessionId: null,
    cascadeRoot: overrides.id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    createdAt: '2026-08-08T12:00:00.000Z',
    ...overrides,
  };
}

describe('appendEntry’s bind hook', () => {
  let db: Db;
  let store: RoomStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RoomStore(db);
    store.createRoom(
      {
        id: ROOM_ID,
        kind: 'channel',
        slug: ROOM_ID,
        title: `#${ROOM_ID}`,
        topic: null,
        createdAt: '2026-08-08T11:00:00.000Z',
      },
      []
    );
    // An attachment uploaded but not yet posted: the state the nullable
    // `entry_id` exists for, and the state the FK is skipped in.
    db.insert(roomAttachments)
      .values({
        roomId: ROOM_ID,
        id: ATTACHMENT_ID,
        entryId: null,
        authorId: 'author-1',
        name: 'crash.log',
        extension: 'log',
        mimeType: 'text/plain',
        size: 12,
        preview: null,
        url: '/api/rooms/room-1/attachments/att-1',
        createdAt: '2026-08-08T11:30:00.000Z',
      })
      .run();
  });

  /** How many attachments in this room point at an entry. */
  function boundCount(): number {
    return (
      db.$client
        .prepare('SELECT COUNT(*) AS n FROM room_attachments WHERE entry_id IS NOT NULL')
        .get() as { n: number }
    ).n;
  }

  /** How many entries this room's log holds. */
  function entryCount(): number {
    return (db.$client.prepare('SELECT COUNT(*) AS n FROM room_entries').get() as { n: number }).n;
  }

  /** The UPDATE that binds the seeded attachment to `entryId`. */
  function bindAttachment(exec: Pick<Db, 'update'>, entryId: string): void {
    exec
      .update(roomAttachments)
      .set({ entryId })
      .where(sql`room_id = ${ROOM_ID} AND id = ${ATTACHMENT_ID}`)
      .run();
  }

  it('refuses the bind through `within`, because the parent entry does not exist yet', () => {
    // THE SPEC'S ORIGINAL DESIGN. `within` is the transaction's first statement,
    // so this UPDATE runs while `room_entries` has no row to point at.
    expect(() =>
      store.appendEntry(entry({ id: ENTRY_ID }), (tx) => bindAttachment(tx, ENTRY_ID))
    ).toThrow(/FOREIGN KEY constraint failed/);

    // And the whole transaction rolled back, so the entry is not there either.
    expect(entryCount()).toBe(0);
    expect(boundCount()).toBe(0);
  });

  it('accepts the same bind through `bind`, which runs after the insert', () => {
    const committed = store.appendEntry(entry({ id: ENTRY_ID }), undefined, (tx) =>
      bindAttachment(tx, ENTRY_ID)
    );

    expect(committed.seq).toBe(1);
    expect(entryCount()).toBe(1);
    expect(boundCount()).toBe(1);
    const row = db.$client
      .prepare('SELECT entry_id FROM room_attachments WHERE id = ?')
      .get(ATTACHMENT_ID) as { entry_id: string };
    expect(row.entry_id).toBe(ENTRY_ID);
  });

  it('rolls the entry back when `bind` throws — both writes or neither', () => {
    expect(() =>
      store.appendEntry(entry({ id: ENTRY_ID }), undefined, () => {
        throw new Error('the row store refused');
      })
    ).toThrow('the row store refused');

    // The insert that had already run inside the transaction is gone with it.
    expect(entryCount()).toBe(0);
    expect(boundCount()).toBe(0);
  });

  it('still runs `within` BEFORE the insert, which is why it exists', () => {
    let entriesWhenWithinRan = -1;
    let entriesWhenBindRan = -1;

    store.appendEntry(
      entry({ id: ENTRY_ID }),
      () => {
        entriesWhenWithinRan = (
          db.$client
            .prepare('SELECT COUNT(*) AS n FROM room_entries WHERE id = ?')
            .get(ENTRY_ID) as { n: number }
        ).n;
      },
      () => {
        entriesWhenBindRan = (
          db.$client
            .prepare('SELECT COUNT(*) AS n FROM room_entries WHERE id = ?')
            .get(ENTRY_ID) as { n: number }
        ).n;
      }
    );

    // The two hooks sit on opposite sides of the insert. That is the whole
    // distinction, and it is what each one is for: `within` so a membership row
    // covers the entry's whole life, `bind` so a child row has a parent.
    expect(entriesWhenWithinRan).toBe(0);
    expect(entriesWhenBindRan).toBe(1);
  });

  it('hands `bind` the allocated seq, so a child row can record it', () => {
    store.appendEntry(entry({ id: 'entry-0' }));
    let seenSeq = -1;
    store.appendEntry(entry({ id: ENTRY_ID }), undefined, (_tx, seq) => {
      seenSeq = seq;
    });

    expect(seenSeq).toBe(2);
  });
});
