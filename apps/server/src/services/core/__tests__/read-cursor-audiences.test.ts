/**
 * Who hears that a read cursor moved: real rooms, a real cursor table and the
 * real fan-out, wired by the production `createRoomSubsystem` (DOR-3269).
 *
 * A room cursor goes to the room's members. Every other cursor goes only to
 * the person it belongs to, on each of their screens. No agent stream hears
 * either, including an agent seated in the room.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { CallerPrincipal } from '../../../lib/caller-principal.js';
import { eventFanOut, type FanOutClient } from '../event-fan-out.js';
import { createRoomSubsystem } from '../../rooms/index.js';

const disconnect: (() => void)[] = [];
let rooms: ReturnType<typeof createRoomSubsystem>;

/** Connect a recording stream as `principal`; the `read_cursor` payloads it was sent. */
function stream(principal: CallerPrincipal): unknown[] {
  const cursors: unknown[] = [];
  const client: FanOutClient = {
    send: (frame) => {
      if (frame.event === 'read_cursor')
        cursors.push((JSON.parse(frame.json) as { data: unknown }).data);
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
});

describe('read_cursor audience', () => {
  it('sends a room cursor to the room’s members, never to an outsider or an agent', () => {
    const owner = rooms.authors.localHuman();
    const member = rooms.authors.human('account-member');
    rooms.authors.human('account-outsider');
    const room = rooms.service.createRoom(
      { kind: 'channel', title: 'Fixture room', members: [member.id], agentPaths: [] },
      owner.id
    );

    const ownerStream = stream({ kind: 'operator' });
    const memberStream = stream({ kind: 'program', userId: 'account-member' });
    const outsiderStream = stream({ kind: 'program', userId: 'account-outsider' });
    const agentStream = stream({ kind: 'agent' });
    const bridgedStream = stream({ kind: 'bridged', platform: 'telegram', platformUserId: 'x' });
    const relayedStream = stream({ kind: 'relayed' });

    rooms.readCursors.advance(member.id, 'room', room.id, 7, { unreadCount: () => 3 });

    const frame = {
      userId: member.id,
      threadKind: 'room',
      threadId: room.id,
      lastReadSeq: 7,
      unreadCount: 3,
    };
    expect(ownerStream).toEqual([frame]);
    expect(memberStream).toEqual([frame]);
    for (const left of [outsiderStream, agentStream, bridgedStream, relayedStream]) {
      expect(left).toEqual([]);
    }
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
      const agent = stream({ kind: 'agent' });

      rooms.readCursors.advance(person.id, kind, 'fixture-thread', 4);

      expect(first).toEqual([
        { userId: person.id, threadKind: kind, threadId: 'fixture-thread', lastReadSeq: 4 },
      ]);
      expect(second).toEqual(first);
      for (const left of [otherPerson, operator, agent]) expect(left).toEqual([]);
    }
  );

  it('sends the operator’s own session cursor to the operator’s screen only', () => {
    const operator = stream({ kind: 'operator' });
    const other = stream({ kind: 'program', userId: 'account-other' });
    const agent = stream({ kind: 'agent' });

    rooms.readCursors.advance(rooms.authors.localHuman().id, 'session', 'fixture-session', 1);

    expect(operator).toHaveLength(1);
    expect(other).toEqual([]);
    expect(agent).toEqual([]);
  });
});
