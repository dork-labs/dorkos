/**
 * The one invariant {@link ReadCursorStore} exists to hold: a read cursor moves
 * FORWARD only (team-room-home spec §D4, ADR 260808-140956).
 *
 * Every test here runs against a real migrated SQLite database rather than a
 * mocked query builder, because the monotonic guard IS the `WHERE` clause — a
 * mock would assert that a predicate was passed, not that it excluded anything.
 *
 * The clock is injected for the same reason. `updatedAt` is what proves a
 * rejected write left NO trace, and two real `new Date()` calls in one test
 * land in the same millisecond often enough that comparing them would pass
 * whether or not the guard fired.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { ReadCursorStore } from '../read-cursor-store.js';

const USER = 'user-dorian';
const ROOM = 'room-team';

describe('ReadCursorStore', () => {
  let db: Db;
  let store: ReadCursorStore;
  /** Ticks one minute per read, so every write carries a distinguishable stamp. */
  let tick: number;

  beforeEach(() => {
    db = createTestDb();
    tick = 0;
    store = new ReadCursorStore(
      db,
      () => `2026-08-08T09:${String(tick++).padStart(2, '0')}:00.000Z`
    );
  });

  it('has no cursor until one is written', () => {
    expect(store.get(USER, 'room', ROOM)).toBeNull();
  });

  it('round-trips a cursor', () => {
    const written = store.set(USER, 'room', ROOM, 7);

    expect(written).toEqual({
      userId: USER,
      threadKind: 'room',
      threadId: ROOM,
      lastReadSeq: 7,
      updatedAt: '2026-08-08T09:00:00.000Z',
    });
    expect(store.get(USER, 'room', ROOM)).toEqual(written);
  });

  it('advances the cursor when the new seq is higher', () => {
    store.set(USER, 'room', ROOM, 7);
    const advanced = store.set(USER, 'room', ROOM, 9);

    expect(advanced.lastReadSeq).toBe(9);
    expect(advanced.updatedAt).toBe('2026-08-08T09:01:00.000Z');
    expect(store.get(USER, 'room', ROOM)).toEqual(advanced);
  });

  it('ignores a lower seq — a stale client cannot un-read a thread', () => {
    const forward = store.set(USER, 'room', ROOM, 9);
    const backward = store.set(USER, 'room', ROOM, 2);

    expect(backward.lastReadSeq).toBe(9);
    expect(backward.updatedAt, 'a rejected write leaves no trace, not even a fresh timestamp').toBe(
      forward.updatedAt
    );
  });

  it('ignores a repeat of the seq already stored', () => {
    const first = store.set(USER, 'room', ROOM, 9);
    expect(store.set(USER, 'room', ROOM, 9)).toEqual(first);
  });

  it('keeps two people in one thread independent', () => {
    store.set(USER, 'room', ROOM, 9);
    store.set('user-priya', 'room', ROOM, 3);

    expect(store.get(USER, 'room', ROOM)?.lastReadSeq).toBe(9);
    expect(store.get('user-priya', 'room', ROOM)?.lastReadSeq).toBe(3);
  });

  it("does not let one person's cursor answer for another's", () => {
    store.set(USER, 'room', ROOM, 9);
    expect(store.get('user-priya', 'room', ROOM)).toBeNull();
  });

  it('keeps the same id under two thread kinds apart', () => {
    store.set(USER, 'room', 'shared-id', 9);
    store.set(USER, 'session', 'shared-id', 2);

    expect(store.get(USER, 'room', 'shared-id')?.lastReadSeq).toBe(9);
    expect(store.get(USER, 'session', 'shared-id')?.lastReadSeq).toBe(2);
  });

  it('serves inbox threads too', () => {
    expect(store.set(USER, 'inbox', 'item-1', 4).lastReadSeq).toBe(4);
  });

  /**
   * A position is computed arithmetically by the cursor migrations, so a bug in
   * that arithmetic has to surface AS an arithmetic error carrying the value.
   * SQLite would not do it: the table's `CHECK` catches a negative as a
   * constraint violation naming a constraint, and it catches `NaN` and `1.5`
   * not at all — a float in an `INTEGER` column is stored as a float, and `NaN`
   * silently becomes `NULL` for the `NOT NULL` to blame on the column.
   */
  describe('refuses a position that is not one', () => {
    it.each([
      ['a negative', -1],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['a fraction', 1.5],
    ])('%s', (_label, seq) => {
      expect(() => store.set(USER, 'room', ROOM, seq)).toThrow(RangeError);
      expect(store.get(USER, 'room', ROOM), 'a refused write stores nothing').toBeNull();
    });

    it('names the offending value, so the caller can see what it computed', () => {
      expect(() => store.set(USER, 'room', ROOM, NaN)).toThrow(/got NaN/);
      expect(() => store.set(USER, 'room', ROOM, -3)).toThrow(/got -3/);
    });

    it('leaves a cursor that already stands alone', () => {
      const written = store.set(USER, 'room', ROOM, 5);
      expect(() => store.set(USER, 'room', ROOM, NaN)).toThrow(RangeError);
      expect(store.get(USER, 'room', ROOM)).toEqual(written);
    });
  });

  describe('refuses an empty id', () => {
    it('refuses an empty userId', () => {
      expect(() => store.set('', 'room', ROOM, 1)).toThrow(TypeError);
    });

    it('refuses an empty threadId', () => {
      expect(() => store.set(USER, 'room', '', 1)).toThrow(TypeError);
    });
  });
});
