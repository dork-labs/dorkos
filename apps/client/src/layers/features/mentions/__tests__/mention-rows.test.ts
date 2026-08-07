/**
 * The picker's row model: who is offered, in what order, and what an insert
 * does to the text around it.
 */
import { describe, it, expect } from 'vitest';
import type { AuthorRef } from '@/layers/entities/room';
import {
  buildMentionRows,
  filterMentionRows,
  findSelectableIndex,
  insertMention,
  ROOM_SECTION_ORDER,
} from '../lib/mention-rows';

function author(over: Partial<AuthorRef> & { id: string }): { author: AuthorRef } {
  return {
    author: {
      kind: 'agent',
      displayName: over.id,
      ...over,
    } as AuthorRef,
  };
}

const YOU = author({ id: 'you', kind: 'human', displayName: 'You', handle: 'You' });
const PRIYA = author({ id: 'priya', kind: 'human', displayName: 'Priya', handle: 'priya' });
const ANA = author({ id: 'ana', kind: 'agent', displayName: 'Ana Reyes', handle: 'ana' });
const MIO = author({
  id: 'mio',
  kind: 'agent',
  displayName: 'Mio Clicker PM',
  handle: 'mio-clicker-pm',
});
const SYSTEM = author({ id: 'sys', kind: 'system', displayName: 'DorkOS' });

/** An agent whose every name has a space: nothing can address it. */
const UNADDRESSABLE = author({
  id: 'ab',
  kind: 'agent',
  displayName: 'Art Blocks Analytics',
});

const ROSTER = [YOU, PRIYA, ANA, MIO, SYSTEM, UNADDRESSABLE];

/** The rows a bare `@` opens with, in final on-screen order. */
function openRows() {
  return filterMentionRows(buildMentionRows(ROSTER, 'you'), '', ROOM_SECTION_ORDER);
}

describe('buildMentionRows', () => {
  it('leaves out the room’s own voice and the person reading', () => {
    const ids = buildMentionRows(ROSTER, 'you').map((row) => row.authorId);
    expect(ids).toEqual(['priya', 'ana', 'mio', 'ab']);
  });

  it('offers the handle the server advertised, never the display name', () => {
    // `Mio Clicker PM` is exactly the name that would post as plain text.
    const mio = buildMentionRows(ROSTER, 'you').find((row) => row.authorId === 'mio');
    expect(mio?.handle).toBe('mio-clicker-pm');
  });

  it('shows a member nothing can address, and refuses to offer a handle for them', () => {
    const row = buildMentionRows(ROSTER, 'you').find((r) => r.authorId === 'ab');
    // Present — a member who vanished from the picker is worse than one with a
    // reason on the row — but not selectable and carrying no handle to insert.
    expect(row?.handle).toBeUndefined();
    expect(row?.disabled).toBe(true);
    expect(row?.disabledReason).toBe('No @name');
  });

  it('takes the server\u2019s word on who a handle reaches, rather than re-deriving it', () => {
    // Two members rendering under the SAME display name. Which of them `@Ana`
    // reaches depends on names this side never receives — an agent's own handle
    // is not on the wire — so the server resolves ownership and withholds the
    // handle from the loser. A client re-deriving the rule from what it can see
    // would hand the second row `@Ana` and post to the first.
    const first = author({ id: 'a1', kind: 'agent', displayName: 'Ana', handle: 'ana-pm' });
    const second = author({ id: 'a2', kind: 'agent', displayName: 'Ana' });
    const rows = buildMentionRows([first, second], 'you');

    expect(rows[0]).toMatchObject({ authorId: 'a1', handle: 'ana-pm', disabled: false });
    expect(rows[1]).toMatchObject({ authorId: 'a2', disabled: true, disabledReason: 'No @name' });
    // Nothing to insert: the row exists to be seen, not to be taken.
    expect(rows[1]!.handle).toBeUndefined();
  });
});

describe('filterMentionRows', () => {
  it('puts People before Agents, and keeps roster order inside a section', () => {
    expect(openRows().map((row) => [row.section, row.authorId])).toEqual([
      ['people', 'priya'],
      ['agents', 'ana'],
      ['agents', 'mio'],
      ['agents', 'ab'],
    ]);
  });

  it('reaches an agent by typing, even though People lead the list', () => {
    const rows = filterMentionRows(buildMentionRows(ROSTER, 'you'), 'mio', ROOM_SECTION_ORDER);
    expect(rows.map((row) => row.authorId)).toEqual(['mio']);
  });

  it('matches the display name as well as the handle', () => {
    // Nobody can tell from the outside which of the two a member is found by.
    const byDisplay = filterMentionRows(
      buildMentionRows(ROSTER, 'you'),
      'reyes',
      ROOM_SECTION_ORDER
    );
    expect(byDisplay.map((row) => row.authorId)).toEqual(['ana']);
  });

  it('ranks an exact handle above one that merely contains the query', () => {
    const ana = author({ id: 'ana', kind: 'agent', displayName: 'Ana', handle: 'ana' });
    const banana = author({
      id: 'banana',
      kind: 'agent',
      displayName: 'Banana',
      handle: 'banana',
    });
    // Seeded in the order that would come out wrong if ranking did nothing.
    const rows = filterMentionRows(
      buildMentionRows([banana, ana], 'you'),
      'ana',
      ROOM_SECTION_ORDER
    );
    expect(rows.map((row) => row.authorId)).toEqual(['ana', 'banana']);
  });

  it('returns nothing for a query nobody answers to', () => {
    expect(filterMentionRows(buildMentionRows(ROSTER, 'you'), 'zzz', ROOM_SECTION_ORDER)).toEqual(
      []
    );
  });
});

describe('findSelectableIndex', () => {
  it('crosses the section boundary without stopping at it', () => {
    const rows = openRows();
    // Row 0 is the only person; row 1 is the first agent. One step, two
    // sections — the cursor has no idea a boundary went past.
    expect(findSelectableIndex(rows, 1, 1)).toBe(1);
    expect(rows[0]!.section).toBe('people');
    expect(rows[1]!.section).toBe('agents');
  });

  it('steps over a row nothing can address', () => {
    const rows = openRows();
    // Index 3 is the unaddressable agent; going forward from it wraps to 0.
    expect(rows[3]!.disabled).toBe(true);
    expect(findSelectableIndex(rows, 3, 1)).toBe(0);
  });

  it('wraps backwards past the disabled tail to the last usable row', () => {
    const rows = openRows();
    expect(findSelectableIndex(rows, -1, -1)).toBe(2);
  });

  it('returns 0 when every row is disabled', () => {
    const rows = buildMentionRows([UNADDRESSABLE], 'you');
    expect(findSelectableIndex(rows, 0, 1)).toBe(0);
  });
});

describe('insertMention', () => {
  it('writes the handle and a trailing space, leaving the caret after it', () => {
    expect(insertMention('hey @an', 4, 'an', 'ana')).toEqual({
      value: 'hey @ana ',
      cursorPos: 9,
    });
  });

  it('keeps the tail after the caret intact', () => {
    // Typing an `@` into the middle of a finished sentence. Dropping the tail
    // is the defect DOR-480 fixed for the command palette.
    expect(insertMention('hey @an, are you free?', 4, 'an', 'ana')).toEqual({
      value: 'hey @ana , are you free?',
      cursorPos: 9,
    });
  });

  it('does not double a space the tail already starts with', () => {
    expect(insertMention('hey @an there', 4, 'an', 'ana')).toEqual({
      value: 'hey @ana there',
      cursorPos: 9,
    });
  });

  it('inserts from a bare @ with nothing typed after it', () => {
    expect(insertMention('@', 0, '', 'ana')).toEqual({ value: '@ana ', cursorPos: 5 });
  });
});
