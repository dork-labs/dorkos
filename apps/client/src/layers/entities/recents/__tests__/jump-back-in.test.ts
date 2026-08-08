import { describe, it, expect } from 'vitest';
import { createMockSession } from '@dorkos/test-utils';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import { mergeJumpBackIn, MAX_JUMP_BACK_IN } from '../lib/jump-back-in';

/** A room as `GET /api/rooms` carries it. */
function room(overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id' | 'kind'>): RoomSummary {
  return {
    slug: null,
    title: 'Untitled',
    topic: null,
    workspaceId: null,
    archived: false,
    // Earlier than `lastActivityAt` by default: equal timestamps mean a room
    // nobody has said anything in yet, which the model drops.
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

const channel = (id: string, slug: string, overrides: Partial<RoomSummary> = {}) =>
  room({ id, kind: 'channel', slug, title: slug, ...overrides });

const dm = (id: string, title: string, overrides: Partial<RoomSummary> = {}) =>
  room({ id, kind: 'dm', title, ...overrides });

const session = (overrides: Partial<Session> = {}) => createMockSession(overrides);

/** `${kind}:${id}` for each row, which is what "order" and "dedupe" both mean here. */
const keysOf = (items: { kind: string; id: string }[]) => items.map((i) => `${i.kind}:${i.id}`);

describe('mergeJumpBackIn', () => {
  // --- Empty sources ---

  it('answers with empty lists when both sources are empty', () => {
    expect(mergeJumpBackIn({ sessions: [], rooms: [] })).toEqual({ items: [], automated: [] });
  });

  it('answers with only rooms when there are no sessions', () => {
    const { items } = mergeJumpBackIn({ sessions: [], rooms: [channel('c1', 'general')] });
    expect(keysOf(items)).toEqual(['channel:c1']);
  });

  it('answers with only sessions when there are no rooms', () => {
    const { items } = mergeJumpBackIn({ sessions: [session({ id: 's1' })], rooms: [] });
    expect(keysOf(items)).toEqual(['session:s1']);
  });

  // --- Merge + ordering ---

  it('interleaves all three kinds strictly by last activity, newest first', () => {
    const { items } = mergeJumpBackIn({
      sessions: [
        session({ id: 's-old', updatedAt: '2026-08-01T09:00:00.000Z' }),
        session({ id: 's-new', updatedAt: '2026-08-01T12:00:00.000Z' }),
      ],
      rooms: [
        channel('c1', 'general', { lastActivityAt: '2026-08-01T11:00:00.000Z' }),
        dm('d1', 'Ana', { lastActivityAt: '2026-08-01T10:00:00.000Z' }),
      ],
    });
    expect(keysOf(items)).toEqual(['session:s-new', 'channel:c1', 'dm:d1', 'session:s-old']);
  });

  it('compares instants, not the strings they were spelled with', () => {
    // The same moment, written two legal ways. A string compare puts the
    // offset form first no matter which instant is later.
    const { items } = mergeJumpBackIn({
      sessions: [session({ id: 's1', updatedAt: '2026-08-01T12:00:00.000Z' })],
      rooms: [channel('c1', 'general', { lastActivityAt: '2026-08-01T13:00:00+00:00' })],
    });
    expect(keysOf(items)).toEqual(['channel:c1', 'session:s1']);
  });

  it('breaks an exact tie on the id, so tied rows never swap between renders', () => {
    const at = '2026-08-01T12:00:00.000Z';
    const first = mergeJumpBackIn({
      sessions: [session({ id: 'aaa', updatedAt: at }), session({ id: 'zzz', updatedAt: at })],
      rooms: [],
    });
    const reversed = mergeJumpBackIn({
      sessions: [session({ id: 'zzz', updatedAt: at }), session({ id: 'aaa', updatedAt: at })],
      rooms: [],
    });
    expect(keysOf(first.items)).toEqual(['session:zzz', 'session:aaa']);
    expect(keysOf(reversed.items)).toEqual(keysOf(first.items));
  });

  it('sorts an unreadable timestamp last rather than dropping the list on the floor', () => {
    const { items } = mergeJumpBackIn({
      // The id deliberately sorts FIRST under the descending id tiebreak, so a
      // NaN leaking into the comparator (which makes every difference falsy and
      // hands the whole order to that tiebreak) puts it at the top and this
      // goes red.
      sessions: [session({ id: 'zzz-broken', updatedAt: 'not-a-date' })],
      rooms: [channel('c1', 'general', { lastActivityAt: '2026-08-01T10:00:00.000Z' })],
    });
    expect(keysOf(items)).toEqual(['channel:c1', 'session:zzz-broken']);
  });

  // --- Dedupe ---

  it('gives a run started by something else no row of its own, however recent', () => {
    // The room is the thread; the channel-origin session is an engine run under
    // it. Two rows for one thread is the defect this model exists to remove.
    const { items, automated } = mergeJumpBackIn({
      sessions: [
        session({
          id: 'run-1',
          title: 'Telegram: what is the deploy status',
          origin: 'channel',
          originLabel: 'Telegram',
          updatedAt: '2026-08-01T23:00:00.000Z',
        }),
      ],
      rooms: [channel('c1', 'general', { lastActivityAt: '2026-08-01T10:00:00.000Z' })],
    });
    expect(keysOf(items)).toEqual(['channel:c1']);
    expect(keysOf(automated)).toEqual(['session:run-1']);
  });

  // THE dedupe case, and the one that shipped broken: a room's own turn is a
  // session with no marker of its own, so the server stamps `origin: 'room'`
  // from the `room_sessions` binding. Without that stamp the room and the run
  // under it are two rows that nothing here can tell apart — the key namespaces
  // (`channel:` / `session:`) can never collide.
  it('lists a room and its own turn as ONE row: the room', () => {
    const { items, automated } = mergeJumpBackIn({
      sessions: [
        session({
          id: 'room-turn',
          title: 'Ana in #general',
          origin: 'room',
          originLabel: '#general',
          updatedAt: '2026-08-01T23:00:00.000Z',
        }),
      ],
      rooms: [channel('c1', 'general', { lastActivityAt: '2026-08-01T23:00:00.000Z' })],
    });

    expect(keysOf(items)).toEqual(['channel:c1']);
    expect(keysOf(automated)).toEqual(['session:room-turn']);
  });

  it('keeps every non-user origin out of the rows and in `automated`', () => {
    const { items, automated } = mergeJumpBackIn({
      sessions: [
        session({ id: 'u1', origin: 'user' }),
        session({ id: 'a1', origin: 'agent' }),
        session({ id: 'r1', origin: 'room' }),
        session({ id: 't1', origin: 'task' }),
        session({ id: 'x1', origin: 'external' }),
      ],
      rooms: [],
    });
    expect(keysOf(items)).toEqual(['session:u1']);
    expect(keysOf(automated).sort()).toEqual([
      'session:a1',
      'session:r1',
      'session:t1',
      'session:x1',
    ]);
  });

  it('drops a repeated thread, keeping one row for it', () => {
    const twice = channel('c1', 'general', { lastActivityAt: '2026-08-01T10:00:00.000Z' });
    const { items } = mergeJumpBackIn({ sessions: [], rooms: [twice, { ...twice }] });
    expect(keysOf(items)).toEqual(['channel:c1']);
  });

  it('does not collapse a session and a room that happen to share an id', () => {
    const { items } = mergeJumpBackIn({
      sessions: [session({ id: 'same', updatedAt: '2026-08-01T12:00:00.000Z' })],
      rooms: [channel('same', 'general', { lastActivityAt: '2026-08-01T11:00:00.000Z' })],
    });
    expect(keysOf(items)).toEqual(['session:same', 'channel:same']);
  });

  // --- Which rooms belong here at all ---

  it('drops a muted room entirely rather than dimming it', () => {
    const { items } = mergeJumpBackIn({
      sessions: [],
      rooms: [channel('c1', 'general'), channel('c2', 'noisy')],
      mutedRoomIds: new Set(['c2']),
    });
    expect(keysOf(items)).toEqual(['channel:c1']);
  });

  it('drops a room the reader is not a member of', () => {
    // `null` is "you are not in this room", which is not zero (RoomSummary).
    const { items } = mergeJumpBackIn({
      sessions: [],
      rooms: [channel('c1', 'joined'), channel('c2', 'visiting', { unreadCount: null })],
    });
    expect(keysOf(items)).toEqual(['channel:c1']);
  });

  it('drops a room nobody has said anything in yet', () => {
    // A freshly created room's activity IS its creation, so there is no "back"
    // to jump to — and five channels made on Tuesday would otherwise fill the
    // whole list.
    const born = '2026-08-01T10:00:00.000Z';
    const { items } = mergeJumpBackIn({
      sessions: [],
      rooms: [
        channel('c1', 'used', { createdAt: born, lastActivityAt: '2026-08-01T11:00:00.000Z' }),
        channel('c2', 'brand-new', { createdAt: born, lastActivityAt: born }),
      ],
    });
    expect(keysOf(items)).toEqual(['channel:c1']);
  });

  // --- Cap ---

  it('caps the rows at 8, keeping the most recent', () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session({ id: `s${i}`, updatedAt: `2026-08-01T${String(i).padStart(2, '0')}:00:00.000Z` })
    );
    const { items } = mergeJumpBackIn({ sessions, rooms: [] });
    expect(items).toHaveLength(MAX_JUMP_BACK_IN);
    expect(keysOf(items)[0]).toBe('session:s11');
    expect(keysOf(items).at(-1)).toBe('session:s4');
  });

  it('caps AFTER merging, so a room is never pushed out by sessions alone', () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      session({ id: `s${i}`, updatedAt: `2026-08-01T0${i % 10}:00:00.000Z` })
    );
    const { items } = mergeJumpBackIn({
      sessions,
      rooms: [channel('c1', 'general', { lastActivityAt: '2026-08-01T23:00:00.000Z' })],
    });
    expect(items).toHaveLength(MAX_JUMP_BACK_IN);
    expect(keysOf(items)[0]).toBe('channel:c1');
  });

  it('honours a smaller cap from the caller', () => {
    const { items } = mergeJumpBackIn({
      sessions: [session({ id: 's1' }), session({ id: 's2' })],
      rooms: [channel('c1', 'general')],
      limit: 2,
    });
    expect(items).toHaveLength(2);
  });

  // --- Row content ---

  it('names each kind the way a person says it', () => {
    const { items } = mergeJumpBackIn({
      sessions: [session({ id: 's1', title: 'Fix the bug' })],
      rooms: [channel('c1', 'general'), dm('d1', 'Ana')],
    });
    const names = Object.fromEntries(items.map((i) => [i.id, i.name]));
    expect(names).toEqual({ s1: 'Fix the bug', c1: '#general', d1: 'Ana' });
  });

  it('summarises a session with its last message, flattened to one line', () => {
    const { items } = mergeJumpBackIn({
      sessions: [session({ id: 's1', lastMessagePreview: '  Deploy is green\n\nnext up: docs ' })],
      rooms: [],
    });
    expect(items[0]!.summary).toBe('Deploy is green next up: docs');
  });

  it('leaves the summary null when a session has no preview', () => {
    const { items } = mergeJumpBackIn({ sessions: [session({ id: 's1' })], rooms: [] });
    expect(items[0]!.summary).toBeNull();
  });

  it('summarises an unread room with its count, singular and plural', () => {
    const { items } = mergeJumpBackIn({
      sessions: [],
      rooms: [
        channel('c1', 'one', { unreadCount: 1, lastActivityAt: '2026-08-01T12:00:00.000Z' }),
        channel('c2', 'many', { unreadCount: 4, lastActivityAt: '2026-08-01T11:00:00.000Z' }),
      ],
    });
    expect(items.map((i) => i.summary)).toEqual(['1 new message', '4 new messages']);
  });

  it('prefers unread over live work, because unread is why you came back', () => {
    const { items } = mergeJumpBackIn({
      sessions: [],
      rooms: [channel('c1', 'general', { unreadCount: 2, working: 3 })],
    });
    expect(items[0]!.summary).toBe('2 new messages');
  });

  it('says who is working when a caught-up room has agents in flight', () => {
    const { items } = mergeJumpBackIn({
      sessions: [],
      rooms: [channel('c1', 'general', { unreadCount: 0, working: 2 })],
    });
    expect(items[0]!.summary).toBe('2 agents working');
  });

  it('falls back to the topic for a quiet, caught-up channel', () => {
    const { items } = mergeJumpBackIn({
      sessions: [],
      rooms: [channel('c1', 'general', { topic: 'Release  planning\n' })],
    });
    expect(items[0]!.summary).toBe('Release planning');
  });

  it('draws no summary at all for a quiet room with nothing to say', () => {
    const { items } = mergeJumpBackIn({ sessions: [], rooms: [dm('d1', 'Ana')] });
    expect(items[0]!.summary).toBeNull();
  });
});
