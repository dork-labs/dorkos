/**
 * Who hears that a read cursor moved: real rooms, a real cursor table and the
 * real fan-out, wired by the production `createRoomSubsystem` (DOR-3269).
 *
 * Every cursor belongs to one person and goes only to that person's screens. A
 * room cursor also needs that person to still be in the room. Only people read
 * the stream at all (DOR-4986).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { PersonPrincipal } from '../../../lib/caller-principal.js';
import { logger } from '../../../lib/logger.js';
import { eventFanOut, type FanOutClient } from '../event-fan-out.js';
import { ReadCursorService } from '../read-cursor-service.js';
import { ReadCursorStore } from '../read-cursor-store.js';
import { createRoomSubsystem } from '../../rooms/index.js';

const disconnect: (() => void)[] = [];
let rooms: ReturnType<typeof createRoomSubsystem>;

/** Connect a recording stream as `principal`; the `read_cursor` payloads it was sent. */
function stream(principal: PersonPrincipal): unknown[] {
  const cursors: unknown[] = [];
  const client: FanOutClient = {
    send: (frame) => {
      if (frame.event === 'read_cursor')
        cursors.push((JSON.parse(frame.json) as { payload: unknown }).payload);
    },
    drop() {},
    bufferedBytes: 0,
    gone: false,
  };
  disconnect.push(eventFanOut.addClient(client, principal));
  return cursors;
}

beforeEach(() => {
  rooms = createRoomSubsystem({ db: createTestDb() });
});

afterEach(() => {
  disconnect.splice(0).forEach((off) => off());
  vi.restoreAllMocks();
});

describe('read_cursor audience', () => {
  it('sends a room cursor to its own person’s screens only, not to other members', () => {
    const owner = rooms.authors.localHuman();
    const member = rooms.authors.human('account-member');
    rooms.authors.human('account-outsider');
    const room = rooms.service.createRoom(
      { kind: 'channel', title: 'Fixture room', members: [member.id], agentPaths: [] },
      owner.id
    );

    const memberFirst = stream({ kind: 'program', userId: 'account-member' });
    const memberSecond = stream({ kind: 'program', userId: 'account-member' });
    const ownerStream = stream({ kind: 'operator' });
    const outsiderStream = stream({ kind: 'program', userId: 'account-outsider' });

    rooms.readCursors.advance(member.id, 'room', room.id, 7, { unreadCount: () => 3 });

    const frame = {
      userId: member.id,
      threadKind: 'room',
      threadId: room.id,
      lastReadSeq: 7,
      unreadCount: 3,
    };
    expect(memberFirst).toEqual([frame]);
    expect(memberSecond).toEqual([frame]);
    // The owner is in the room too, but it is not the owner's cursor.
    for (const left of [ownerStream, outsiderStream]) {
      expect(left).toEqual([]);
    }
  });

  it('sends a room cursor to nobody once its person is no longer in the room', () => {
    const owner = rooms.authors.localHuman();
    const outsider = rooms.authors.human('account-outsider');
    const room = rooms.service.createRoom(
      { kind: 'channel', title: 'Fixture room', members: [], agentPaths: [] },
      owner.id
    );
    const outsiderStream = stream({ kind: 'program', userId: 'account-outsider' });
    const ownerStream = stream({ kind: 'operator' });

    // Straight onto the service, past the room's own membership check.
    rooms.readCursors.advance(outsider.id, 'room', room.id, 2);

    expect(outsiderStream).toEqual([]);
    expect(ownerStream).toEqual([]);
  });

  it('sends nothing for a room that does not exist', () => {
    const ownerStream = stream({ kind: 'operator' });
    rooms.readCursors.advance(rooms.authors.localHuman().id, 'room', 'missing-room', 1);
    expect(ownerStream).toEqual([]);
  });

  it.each(['session', 'inbox', 'room-thread'] as const)(
    'sends a %s cursor to each screen of its own person and nobody else',
    (kind) => {
      const person = rooms.authors.human('account-member');
      const first = stream({ kind: 'program', userId: 'account-member' });
      const second = stream({ kind: 'program', userId: 'account-member' });
      const otherPerson = stream({ kind: 'program', userId: 'account-other' });
      const operator = stream({ kind: 'operator' });

      rooms.readCursors.advance(person.id, kind, 'fixture-thread', 4);

      expect(first).toEqual([
        { userId: person.id, threadKind: kind, threadId: 'fixture-thread', lastReadSeq: 4 },
      ]);
      expect(second).toEqual(first);
      for (const left of [otherPerson, operator]) expect(left).toEqual([]);
    }
  );

  it('sends the operator’s own session cursor to the operator’s screen only', () => {
    const operator = stream({ kind: 'operator' });
    const other = stream({ kind: 'program', userId: 'account-other' });

    rooms.readCursors.advance(rooms.authors.localHuman().id, 'session', 'fixture-session', 1);

    expect(operator).toHaveLength(1);
    expect(other).toEqual([]);
  });

  it('sends nothing, and says so in the log, when the audience cannot be worked out', () => {
    const warn = vi.spyOn(logger, 'warn');
    const cursors = new ReadCursorService(new ReadCursorStore(createTestDb()), () => {
      throw new Error('the rooms graph is not ready');
    });
    const operator = stream({ kind: 'operator' });
    const program = stream({ kind: 'program', userId: 'account-member' });

    const cursor = cursors.advance('someone', 'session', 'fixture-session', 5);

    expect(cursor.lastReadSeq).toBe(5);
    expect(operator).toEqual([]);
    expect(program).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('read cursor'),
      expect.objectContaining({ threadKind: 'session' })
    );
  });
});
