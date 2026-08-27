/**
 * What the `room_entry_reactions` table enforces on its own, without a service
 * in front of it.
 *
 * Three constraints, and each is the reason a piece of service code does NOT
 * exist: the composite primary key is why toggling never has to read before it
 * writes, and the foreign key is why nothing has to sweep up reactions after a
 * message is removed (`specs/room-messaging-design` §4).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations } from '../index.js';
import { rooms, roomEntries, roomEntryReactions } from '../schema/rooms.js';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../index.js';

const NOW = '2026-07-30T09:00:00.000Z';

/** A room holding one entry, which is the smallest world a reaction needs. */
function seed(db: Db): void {
  db.insert(rooms)
    .values({
      id: 'room-1',
      kind: 'channel',
      slug: 'backend',
      title: '#backend',
      topic: null,
      archived: false,
      createdAt: NOW,
      lastActivityAt: NOW,
    })
    .run();
  db.insert(roomEntries)
    .values({
      roomId: 'room-1',
      seq: 1,
      id: 'entry-1',
      authorId: 'agent-ana',
      kind: 'post',
      body: JSON.stringify({ text: 'Deployed to staging.' }),
      mentions: '[]',
      sessionId: null,
      cascadeRoot: 'entry-1',
      cascadeDepth: 0,
      parentEntryId: null,
      threadRootEntryId: null,
      signature: null,
      createdAt: NOW,
    })
    .run();
}

/** One reaction row, ready to insert. */
function reaction(overrides: Partial<typeof roomEntryReactions.$inferInsert> = {}) {
  return {
    roomId: 'room-1',
    entryId: 'entry-1',
    authorId: 'human-dorian',
    emoji: '👍',
    createdAt: NOW,
    ...overrides,
  };
}

describe('room_entry_reactions', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    seed(db);
  });

  it('refuses a second row for the same (room, entry, author, emoji)', () => {
    db.insert(roomEntryReactions).values(reaction()).run();
    expect(() => db.insert(roomEntryReactions).values(reaction()).run()).toThrow(/UNIQUE/i);
  });

  it('lets the same person put a DIFFERENT emoji on the same entry', () => {
    db.insert(roomEntryReactions).values(reaction()).run();
    db.insert(roomEntryReactions)
      .values(reaction({ emoji: '🎉' }))
      .run();
    expect(db.select().from(roomEntryReactions).all()).toHaveLength(2);
  });

  it('lets a DIFFERENT person put the same emoji on the same entry', () => {
    db.insert(roomEntryReactions).values(reaction()).run();
    db.insert(roomEntryReactions)
      .values(reaction({ authorId: 'human-priya' }))
      .run();
    expect(db.select().from(roomEntryReactions).all()).toHaveLength(2);
  });

  it('refuses a reaction on an entry that does not exist', () => {
    expect(() =>
      db
        .insert(roomEntryReactions)
        .values(reaction({ entryId: 'no-such-entry' }))
        .run()
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuses a reaction that names the right entry id in the wrong room', () => {
    // The parent key is `(room_id, id)`, not `id` alone — so an entry id
    // borrowed from another room cannot be reacted to from this one.
    expect(() =>
      db
        .insert(roomEntryReactions)
        .values(reaction({ roomId: 'room-2' }))
        .run()
    ).toThrow(/FOREIGN KEY/i);
  });

  it('deletes reactions with the entry they sit on', () => {
    db.insert(roomEntryReactions).values(reaction()).run();
    db.insert(roomEntryReactions)
      .values(reaction({ authorId: 'human-priya', emoji: '🎉' }))
      .run();
    expect(db.select().from(roomEntryReactions).all()).toHaveLength(2);

    db.delete(roomEntries)
      .where(and(eq(roomEntries.roomId, 'room-1'), eq(roomEntries.id, 'entry-1')))
      .run();

    expect(
      db.select().from(roomEntryReactions).all(),
      'a message that is gone leaves no pills behind'
    ).toHaveLength(0);
  });

  it('stores a multi-code-point emoji byte for byte', () => {
    const family = '👨‍👩‍👧‍👦';
    db.insert(roomEntryReactions)
      .values(reaction({ emoji: family }))
      .run();
    expect(db.select().from(roomEntryReactions).get()?.emoji).toBe(family);
  });
});
