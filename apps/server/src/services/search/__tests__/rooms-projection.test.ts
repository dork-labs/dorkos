import { describe, it, expect } from 'vitest';
import { projectRoomEntries, type RoomEntrySourceRow } from '../projections/rooms.js';

/**
 * The room projection is pure — no filesystem, no database, no clock — so every
 * rule it carries is settled here at the level of one function, and the indexer
 * tests never have to reach through a sweep to check a mapping.
 */

const base: RoomEntrySourceRow = {
  roomId: 'room-1',
  seq: 1,
  kind: 'post',
  authorKind: 'human',
  body: JSON.stringify({ text: 'we talked about a dog' }),
  createdAt: '2026-07-28T10:00:00.000Z',
};

const row = (patch: Partial<RoomEntrySourceRow>): RoomEntrySourceRow => ({ ...base, ...patch });

describe('projectRoomEntries', () => {
  it('carries the room id as origin_key and the entry seq as ordinal', () => {
    // Red if the projection composes `origin_key` from anything else, or reads
    // its ordinal from anything but `seq` — the two navigation coordinates a hit
    // resolves through.
    expect(projectRoomEntries([row({ roomId: 'room-9', seq: 42 })])).toEqual({
      skipped: 0,
      messages: [
        {
          originKey: 'room-9',
          ordinal: 42,
          // A room lands by `seq` and needs no id of its own (DOR-1579). Red if
          // one is ever invented here — a second address for the same row, kept
          // in step by nothing.
          messageId: null,
          role: 'user',
          createdAt: '2026-07-28T10:00:00.000Z',
          body: 'we talked about a dog',
        },
      ],
    });
  });

  it('reads a human as user and everything else as assistant', () => {
    // Red if the role mapping inverts, or if a missing author row silently
    // becomes a `user` — which would file an agent's answer under the person.
    const roles = projectRoomEntries([
      row({ seq: 1, authorKind: 'human' }),
      row({ seq: 2, authorKind: 'agent' }),
      row({ seq: 3, authorKind: null }),
    ]).messages.map((message) => message.role);

    expect(roles).toEqual(['user', 'assistant', 'assistant']);
  });

  it('keeps an entry whose author row is missing rather than dropping it', () => {
    // A LEFT JOIN that found nothing must cost the role's precision, never the
    // message. Red the moment the read is switched to an inner join.
    expect(projectRoomEntries([row({ authorKind: null })]).messages).toHaveLength(1);
  });

  it('drops notices — a room reporting about itself is not something someone said', () => {
    const projected = projectRoomEntries([
      row({ seq: 1, kind: 'post', body: JSON.stringify({ text: 'a real message' }) }),
      row({
        seq: 2,
        kind: 'notice',
        authorKind: 'system',
        body: JSON.stringify({
          text: 'mio stopped replying here — this back-and-forth hit its automatic-reply limit.',
          notice: 'cascade_stopped',
        }),
      }),
    ]);

    expect(projected.messages.map((message) => message.body)).toEqual(['a real message']);
    // An expected outcome, not a signal: a notice is not a format change.
    expect(projected.skipped).toBe(0);
  });

  it('drops a post with no text left to search, and does not call it a format change', () => {
    const projected = projectRoomEntries([
      row({ seq: 1, body: JSON.stringify({ text: '   ' }) }),
      row({ seq: 2, body: JSON.stringify({ text: '' }) }),
      row({ seq: 3, body: JSON.stringify({ text: 'kept' }) }),
    ]);

    expect(projected.messages.map((message) => message.ordinal)).toEqual([3]);
    expect(projected.skipped).toBe(0);
  });

  it('degrades a body that will not parse to its raw column instead of throwing', () => {
    // We author that JSON, so a parse failure is a corrupted row. It costs that
    // one message's formatting; throwing here would trip `last_error` and stop
    // the whole room from being indexed. Red if the catch is removed.
    const projected = projectRoomEntries([row({ body: 'not json at all' })]);

    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0].body).toBe('not json at all');
    expect(projected.skipped).toBe(0);
  });

  it('skips and counts a body that parses but carries no text', () => {
    // THE format-change case, and the one the ADR names as its sharpest negative.
    // Indexing the raw JSON would put the container's own field names into the
    // search index as prose — `blocks`, `type` and `value` would all become terms
    // — and throwing would stop the room. Neither: skip it, and count it so the
    // drift has somewhere to show up.
    const projected = projectRoomEntries([
      row({ seq: 1, body: JSON.stringify({ blocks: [{ type: 'text', value: 'hello' }] }) }),
      row({ seq: 2, body: JSON.stringify({ text: 42 }) }),
      row({ seq: 3, body: JSON.stringify({ text: 'still fine' }) }),
    ]);

    expect(projected.messages.map((message) => message.body)).toEqual(['still fine']);
    expect(projected.skipped).toBe(2);
  });

  it('preserves ordinal order, so the caller can advance a watermark from the last row', () => {
    const projected = projectRoomEntries([
      row({ seq: 4 }),
      row({ seq: 5, kind: 'notice' }),
      row({ seq: 6 }),
    ]);

    expect(projected.messages.map((message) => message.ordinal)).toEqual([4, 6]);
  });
});
