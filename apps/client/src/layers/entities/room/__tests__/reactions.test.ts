import { describe, it, expect } from 'vitest';
import type { RoomEntry, RoomEntryReaction } from '@dorkos/shared/room-schemas';
import {
  REACTION_ROW_LIMIT,
  applyReactionToggle,
  hasReacted,
  mergeRoomReactions,
  reactionSummary,
  splitReactionRow,
} from '../lib/reactions';

/** One entry, with only the fields these rules read. */
function entry(id: string, seq: number, reactions?: RoomEntryReaction[]): RoomEntry {
  return {
    roomId: 'room-1',
    seq,
    id,
    authorId: 'author-them',
    kind: 'post',
    body: { text: `entry ${id}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-30T09:00:00.000Z',
    ...(reactions ? { reactions } : {}),
  };
}

/** One pill, as the wire carries it. */
function pill(emoji: string, authorIds: string[], firstAt = '2026-07-30T09:00:00.000Z') {
  return { emoji, authorIds, firstAt };
}

describe('mergeRoomReactions — the stream carries whole sets, never deltas', () => {
  it('replaces the named entry’s set outright', () => {
    const cached = [entry('a', 1, [pill('👍', ['me'])]), entry('b', 2)];

    const next = mergeRoomReactions(cached, 'a', [pill('🎉', ['them'])]);

    // Replaced, not merged: a client that ADDED the arriving pills would keep a
    // 👍 the server no longer holds forever.
    expect(next[0]!.reactions).toEqual([pill('🎉', ['them'])]);
    expect(next[1]!.reactions).toBeUndefined();
  });

  it('empties a set when the last pill was taken back', () => {
    const cached = [entry('a', 1, [pill('👍', ['me'])])];

    expect(mergeRoomReactions(cached, 'a', [])[0]!.reactions).toEqual([]);
  });

  it('leaves the cache alone — same array — for an entry it does not hold', () => {
    const cached = [entry('a', 1)];

    // A resume re-sends the trailing window, which can name entries this reader
    // paged away. Rewriting the array for one of those would re-render a room
    // for nothing.
    expect(mergeRoomReactions(cached, 'gone', [pill('👍', ['me'])])).toBe(cached);
  });

  it('writes nothing for a frame that changes nothing', () => {
    // A resume re-sends the trailing window — EVERY entry of it, including the
    // ones whose pills never moved. Handing back a new array for each of those
    // re-renders the whole timeline for no visible change; the room's own
    // reconnects make that the common case, not the rare one.
    const held = [pill('👍', ['me', 'them']), pill('🎉', ['them'])];
    const cached = [entry('a', 1, held), entry('b', 2)];

    // A different array carrying identical content, which is what a parsed SSE
    // frame always is — referential equality can never do this job.
    const identical = [pill('👍', ['me', 'them']), pill('🎉', ['them'])];

    expect(mergeRoomReactions(cached, 'a', identical)).toBe(cached);
  });

  it('still writes when the same emoji changed hands', () => {
    // The bail has to be about CONTENT, not about the emoji list. A pill whose
    // membership changed is a pill whose count changed.
    const cached = [entry('a', 1, [pill('👍', ['them'])])];

    expect(mergeRoomReactions(cached, 'a', [pill('👍', ['them', 'me'])])).not.toBe(cached);
  });

  it('still writes when only the order changed', () => {
    // The row is drawn in the order it arrives, so a reorder is a visible change.
    const cached = [entry('a', 1, [pill('👍', ['them']), pill('🎉', ['them'])])];

    expect(mergeRoomReactions(cached, 'a', [pill('🎉', ['them']), pill('👍', ['them'])])).not.toBe(
      cached
    );
  });

  it('writes the first time, when the entry had no reactions field at all', () => {
    // `undefined` and `[]` are the same row to a reader, but the entry has to
    // stop being undefined or nothing downstream can tell them apart later.
    const cached = [entry('a', 1)];

    expect(mergeRoomReactions(cached, 'a', [])).not.toBe(cached);
  });

  it('holds one array reference across a hundred no-op resume frames', () => {
    // The cost this bail exists to remove, stated as a number. Every reconnect
    // re-sends one frame per entry in the trailing window whether or not
    // anything moved, and each new array re-renders the timeline, which is not
    // memoized.
    let list: RoomEntry[] = [entry('a', 1, [pill('👍', ['them'])]), entry('b', 2, [])];
    const first = list;

    for (let i = 0; i < 100; i += 1) {
      list = mergeRoomReactions(list, 'a', [pill('👍', ['them'])]);
      list = mergeRoomReactions(list, 'b', []);
    }

    expect(list).toBe(first);
  });

  it('survives an empty cache', () => {
    expect(mergeRoomReactions(undefined, 'a', [pill('👍', ['me'])])).toEqual([]);
  });
});

describe('applyReactionToggle — the pill is the toggle', () => {
  it('adds the reader to a pill that is already there, keeping its place', () => {
    const held = [pill('👍', ['them']), pill('🎉', ['them'])];

    const { reactions, on } = applyReactionToggle(held, '👍', 'me');

    expect(on).toBe(true);
    expect(reactions[0]).toMatchObject({ emoji: '👍', authorIds: ['them', 'me'] });
    // Ordered by first appearance, so joining a pill never moves it.
    expect(reactions.map((r) => r.emoji)).toEqual(['👍', '🎉']);
  });

  it('appends a brand-new pill at the row’s end', () => {
    const { reactions, on } = applyReactionToggle([pill('👍', ['them'])], '🎉', 'me');

    expect(on).toBe(true);
    expect(reactions.map((r) => r.emoji)).toEqual(['👍', '🎉']);
  });

  it('takes the reader back out on a second press, leaving the others', () => {
    const { reactions, on } = applyReactionToggle([pill('👍', ['them', 'me'])], '👍', 'me');

    expect(on).toBe(false);
    expect(reactions).toEqual([pill('👍', ['them'])]);
  });

  it('drops the pill entirely when the reader was the only one on it', () => {
    const { reactions, on } = applyReactionToggle([pill('👍', ['me'])], '👍', 'me');

    expect(on).toBe(false);
    expect(reactions).toEqual([]);
  });

  it('is idempotent when the state is named rather than flipped', () => {
    // What a revert sends, and what a retry may safely repeat.
    const held = [pill('👍', ['me'])];

    expect(applyReactionToggle(held, '👍', 'me', true).reactions).toEqual(held);
    expect(applyReactionToggle([], '👍', 'me', false).reactions).toEqual([]);
  });

  it('treats an entry with no reactions at all as an empty row', () => {
    const { reactions, on } = applyReactionToggle(undefined, '👍', 'me');

    expect(on).toBe(true);
    expect(reactions).toEqual([{ emoji: '👍', authorIds: ['me'], firstAt: expect.any(String) }]);
  });
});

describe('hasReacted', () => {
  it('answers for the reader and for everybody else', () => {
    expect(hasReacted(pill('👍', ['them', 'me']), 'me')).toBe(true);
    expect(hasReacted(pill('👍', ['them']), 'me')).toBe(false);
  });
});

describe('reactionSummary — names, not counts', () => {
  const names = new Map([
    ['them', 'LifeOS'],
    ['mio', 'Mio PM'],
    ['ana', 'Ana'],
    ['kai', 'Kai'],
  ]);

  it('puts the reader first and calls them You', () => {
    expect(reactionSummary(pill('👍', ['them', 'me']), 'me', names)).toBe(
      'You and LifeOS reacted 👍'
    );
  });

  it('says just You when the reader is alone on it', () => {
    expect(reactionSummary(pill('👍', ['me']), 'me', names)).toBe('You reacted 👍');
  });

  it('joins three with a comma and an and', () => {
    expect(reactionSummary(pill('🎉', ['them', 'mio']), 'me', names)).toBe(
      'LifeOS and Mio PM reacted 🎉'
    );
    expect(reactionSummary(pill('🎉', ['them', 'mio', 'ana']), 'me', names)).toBe(
      'LifeOS, Mio PM and Ana reacted 🎉'
    );
  });

  it('stops naming past four and counts the rest', () => {
    expect(reactionSummary(pill('🎉', ['them', 'mio', 'ana', 'kai', 'me']), 'me', names)).toBe(
      'You, LifeOS, Mio PM, Ana and 1 other reacted 🎉'
    );
  });

  it('says somebody left rather than showing a raw id', () => {
    expect(reactionSummary(pill('👍', ['ghost']), 'me', names)).toBe('Someone who left reacted 👍');
  });
});

describe('splitReactionRow — 10 wrap, then “+N more”', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => pill(String.fromCodePoint(0x1f600 + i), ['them']));

  it('shows everything at the limit', () => {
    const { shown, hidden } = splitReactionRow(many(REACTION_ROW_LIMIT));

    expect(shown).toHaveLength(REACTION_ROW_LIMIT);
    expect(hidden).toBe(0);
  });

  it('hides the overflow one past the limit', () => {
    const { shown, hidden } = splitReactionRow(many(REACTION_ROW_LIMIT + 3));

    expect(shown).toHaveLength(REACTION_ROW_LIMIT);
    expect(hidden).toBe(3);
  });
});
