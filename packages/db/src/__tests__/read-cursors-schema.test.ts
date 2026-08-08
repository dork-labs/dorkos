/**
 * What `read_cursors` enforces on its own, before any service is in front of it
 * (team-room-home spec §D4, ADR 260808-140956).
 *
 * The composite primary key is the whole per-user story: it is why two people
 * in one room cannot overwrite each other, and why the same id under two
 * `thread_kind`s is two different threads rather than a collision. The `CHECK`
 * is why a typo'd kind is a write error here rather than a thread that silently
 * never matches a read.
 *
 * Monotonicity is NOT asserted here, because it is not a table property — it is
 * the write path's, and it is proved in
 * `apps/server/src/services/core/__tests__/read-cursor-store.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
import { readCursors } from '../schema/read-cursors.js';

const NOW = '2026-08-08T09:00:00.000Z';

/** One cursor row, ready to insert. */
function cursor(overrides: Partial<typeof readCursors.$inferInsert> = {}) {
  return {
    userId: 'user-dorian',
    threadKind: 'room' as const,
    threadId: 'room-team',
    lastReadSeq: 12,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('read_cursors', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('refuses a second row for the same (user, kind, thread)', () => {
    db.insert(readCursors).values(cursor()).run();
    expect(() => db.insert(readCursors).values(cursor()).run()).toThrow(/UNIQUE/i);
  });

  it('gives two people independent cursors in the same thread', () => {
    db.insert(readCursors).values(cursor()).run();
    db.insert(readCursors)
      .values(cursor({ userId: 'user-priya', lastReadSeq: 3 }))
      .run();

    const rows = db.select().from(readCursors).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.lastReadSeq).sort((a, b) => a - b)).toEqual([3, 12]);
  });

  it('does not collide a session and a room that share a thread id', () => {
    db.insert(readCursors)
      .values(cursor({ threadId: 'shared-id' }))
      .run();
    db.insert(readCursors)
      .values(cursor({ threadKind: 'session', threadId: 'shared-id', lastReadSeq: 99 }))
      .run();

    expect(db.select().from(readCursors).all()).toHaveLength(2);
  });

  it('refuses a thread_kind outside room | session | inbox', () => {
    expect(() =>
      db
        .insert(readCursors)
        // The type parameter is the point of the cast: this is the write a
        // future caller makes when it invents a kind the table never learned.
        .values(cursor({ threadKind: 'dm' as 'room' }))
        .run()
    ).toThrow(/CHECK/i);
  });

  it('accepts every kind the schema names', () => {
    for (const kind of ['room', 'session', 'inbox'] as const) {
      db.insert(readCursors)
        .values(cursor({ threadKind: kind, threadId: `thread-${kind}` }))
        .run();
    }
    expect(db.select().from(readCursors).all()).toHaveLength(3);
  });

  it('requires a user, so no row can stand for "whoever is looking"', () => {
    expect(() =>
      db
        .insert(readCursors)
        .values(cursor({ userId: null as unknown as string }))
        .run()
    ).toThrow(/NOT NULL/i);
  });

  /**
   * A negative position is not a position. It is the shape a sign error takes,
   * and it reads as "below every entry there is" — which marks a whole thread
   * unread forever rather than failing where anyone would look. The floor is
   * the table's to hold because it is a property of the value alone; the
   * ceiling and the forward-only rule are not, and live on the write path.
   */
  it('refuses a negative last_read_seq', () => {
    expect(() =>
      db
        .insert(readCursors)
        .values(cursor({ lastReadSeq: -1 }))
        .run()
    ).toThrow(/CHECK/i);
  });

  it('accepts zero, which is a real position and not an absent one', () => {
    db.insert(readCursors)
      .values(cursor({ lastReadSeq: 0 }))
      .run();

    expect(db.select().from(readCursors).all()[0].lastReadSeq).toBe(0);
  });
});
