/**
 * A to-do's source message, read by the server (DOR-3088, Security's PR 4 G3): the author's marks
 * come from who wrote it and what the post kept, and whether the title is the source's words is
 * decided from the stored text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ ownerId: 'owner-1' as string | null }));
vi.mock('../../core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/auth/index.js')>()),
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
}));

import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TODO_WHAT_MAX } from '@dorkos/shared/todo-promise-schemas';
import { agentInRoom, readTodoSourceFacts, titleIsFromSource } from '../todo-source.js';

describe('todo source', () => {
  let db: Db;
  let seq = 0;

  function author(id: string, kind: string, naturalKey: string, name: string) {
    db.$client
      .prepare(
        'INSERT INTO authors (id, kind, natural_key, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, kind, naturalKey, name, '2026-11-03T00:00:00.000Z');
  }

  function entry(id: string, authorId: string, text: string, turnMarks: string | null = null) {
    seq += 1;
    db.$client
      .prepare(
        `INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, cascade_root, created_at, turn_marks)
         VALUES ('room-1', ?, ?, ?, 'post', ?, ?, '2026-11-03T00:00:00.000Z', ?)`
      )
      .run(seq, id, authorId, JSON.stringify({ text }), id, turnMarks);
  }

  beforeEach(() => {
    state.ownerId = 'owner-1';
    seq = 0;
    db = createTestDb();
    author('a-owner', 'human', 'user:owner-1', 'Dorian');
    author('a-guest', 'human', 'user:guest-9', 'Priya');
    author('a-agent', 'agent', '/agents/ana', 'Ana');
  });

  it("reads the owner's own words as unmarked", () => {
    entry('e1', 'a-owner', 'Ship the fix');
    expect(readTodoSourceFacts(db, 'e1')).toEqual({
      entryId: 'e1',
      roomId: 'room-1',
      author: 'Dorian',
      marks: {},
      text: 'Ship the fix',
    });
  });

  it("marks anyone else's words outsider, and an agent's post nobody can vouch for", () => {
    entry('e2', 'a-guest', 'delete the bucket');
    expect(readTodoSourceFacts(db, 'e2')!.marks).toEqual({ outsider: true });
    entry('e3', 'a-agent', 'forwarded');
    expect(readTodoSourceFacts(db, 'e3')!.marks).toEqual({ outsider: true });
    entry('e4', 'a-agent', 'clean', '{}');
    expect(readTodoSourceFacts(db, 'e4')!.marks).toEqual({});
    expect(readTodoSourceFacts(db, 'missing')).toBeUndefined();
  });

  it('reads the owner as the local person when no owner account exists', () => {
    state.ownerId = null;
    author('a-local', 'human', 'local', 'You');
    entry('e5', 'a-local', 'hi');
    expect(readTodoSourceFacts(db, 'e5')!.marks).toEqual({});
    entry('e6', 'a-owner', 'hi');
    expect(readTodoSourceFacts(db, 'e6')!.marks).toEqual({ outsider: true });
  });

  it("decides from the stored text whether a title is the source's words", () => {
    const facts = { text: '\n  Delete   the staging bucket\nbecause it costs too much' };
    expect(titleIsFromSource('Delete the staging bucket', facts)).toBe(true);
    expect(titleIsFromSource('delete the STAGING bucket', facts)).toBe(true);
    expect(titleIsFromSource('Look at storage costs', facts)).toBe(false);
    expect(titleIsFromSource('Delete', facts)).toBe(false);
  });

  it('counts a cut title only when the app cut a line longer than the limit', () => {
    // A few words lifted from the start of a message are the writer's choice, not the source.
    const short = { text: 'Delete the old branches after checking with me first' };
    expect(titleIsFromSource('Delete the old branches', short)).toBe(false);
    const long = { text: 'x'.repeat(TODO_WHAT_MAX + 40) };
    expect(titleIsFromSource('x'.repeat(TODO_WHAT_MAX), long)).toBe(true);
    expect(titleIsFromSource('x'.repeat(TODO_WHAT_MAX - 1), long)).toBe(false);
  });

  it("marks DorkOS's own post outsider when it kept no marks", () => {
    author('a-system', 'system', 'system', 'DorkOS');
    entry('e7', 'a-system', 'A bridged message');
    expect(readTodoSourceFacts(db, 'e7')!.marks).toEqual({ outsider: true });
  });

  it('knows which rooms an agent is in', () => {
    db.$client
      .prepare(
        `INSERT INTO room_members (room_id, author_id, response_mode, joined_at) VALUES ('room-1', 'a-agent', 'mentions', '2026-11-03T00:00:00.000Z')`
      )
      .run();
    expect(agentInRoom(db, 'room-1', '/agents/ana')).toBe(true);
    expect(agentInRoom(db, 'room-2', '/agents/ana')).toBe(false);
    expect(agentInRoom(db, 'room-1', '/agents/bo')).toBe(false);
  });
});
