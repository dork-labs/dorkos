/**
 * A room's count of turns waiting on a person (DOR-3236), read from real
 * session projectors: 0, then 1 while an approval is open, then 0 again once
 * it is answered, and a `room_awaiting` event on each change only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionStateProjector,
  type RawSessionEvent,
} from '../../../session/session-state-projector.js';
import { eventFanOut, type FanOutClient } from '../../../core/event-fan-out.js';
import { agentLookupFor, createRoomHarness } from '../../__tests__/room-test-harness.js';
import { countAwaitingByRoom, watchRoomAwaiting } from '../room-awaiting.js';

/** Sessions bound to rooms, the way the room session ledger answers. */
const BINDINGS: Record<string, string> = { 'ses-ops': 'room-ops', 'ses-ship': 'room-ship' };
const bindings = {
  bindingForSession: (sessionId: string) => {
    const roomId = BINDINGS[sessionId];
    return roomId === undefined
      ? undefined
      : ({ roomId, authorId: 'agent:x' } as ReturnType<
          Parameters<typeof countAwaitingByRoom>[0]['bindingForSession']
        >);
  },
};

/** Put a projector on an approval a person has to answer. */
function askApproval(projector: SessionStateProjector, id: string): void {
  projector.ingest({
    type: 'approval_required',
    id,
    startedAt: Date.now(),
    remainingMs: 10 * 60 * 1000,
    toolName: 'Bash',
    input: '{}',
    hasSuggestions: false,
  } as RawSessionEvent);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('countAwaitingByRoom', () => {
  it('counts 0, then 1 while an approval is open, then 0 once it is answered', () => {
    const ops = new SessionStateProjector('ses-ops');
    const ship = new SessionStateProjector('ses-ship');
    const sessions = [ops, ship];
    expect(countAwaitingByRoom(bindings, sessions).get('room-ops') ?? 0).toBe(0);

    askApproval(ops, 'tool-1');
    expect(countAwaitingByRoom(bindings, sessions)).toEqual(new Map([['room-ops', 1]]));

    ops.ingest({ type: 'interaction_resolved', id: 'tool-1' } as RawSessionEvent);
    expect(countAwaitingByRoom(bindings, sessions).get('room-ops') ?? 0).toBe(0);
  });

  it('counts each waiting session of a room once', () => {
    const one = new SessionStateProjector('ses-ops');
    askApproval(one, 'tool-1');
    askApproval(one, 'tool-2');
    expect(countAwaitingByRoom(bindings, [one]).get('room-ops')).toBe(1);
  });

  it('counts no session that is bound to no room', () => {
    const loose = new SessionStateProjector('ses-direct');
    askApproval(loose, 'tool-1');
    expect(countAwaitingByRoom(bindings, [loose]).size).toBe(0);
  });
});

describe('watchRoomAwaiting', () => {
  it('sends the count when it changes, and nothing when it does not', () => {
    const ops = new SessionStateProjector('ses-ops');
    const publish = vi.fn();
    let listener: (update: { sessionId: string }) => void = () => undefined;
    const stop = watchRoomAwaiting(
      bindings,
      createRoomHarness({ agents: agentLookupFor({}) }).service,
      {
        onStatusChange: (next) => {
          listener = next;
          return () => undefined;
        },
        sessions: () => [ops],
        publish,
      }
    );

    listener({ sessionId: 'ses-ops' });
    expect(publish).not.toHaveBeenCalled();

    askApproval(ops, 'tool-1');
    listener({ sessionId: 'ses-ops' });
    listener({ sessionId: 'ses-ops' });
    expect(publish.mock.calls).toEqual([['room-ops', 1]]);

    ops.ingest({ type: 'interaction_resolved', id: 'tool-1' } as RawSessionEvent);
    listener({ sessionId: 'ses-ops' });
    expect(publish.mock.calls).toEqual([
      ['room-ops', 1],
      ['room-ops', 0],
    ]);

    // A session no room is bound to never reaches the wire.
    listener({ sessionId: 'ses-direct' });
    expect(publish).toHaveBeenCalledTimes(2);
    stop();
  });

  it('sends only to member streams and rechecks membership on each change', () => {
    const { service, authors, human, store } = createRoomHarness({ agents: agentLookupFor({}) });
    const room = service.createRoom(
      { kind: 'channel', title: 'Ops', slug: 'ops', members: [], agentPaths: [] },
      human
    );
    const member = authors.human('member');
    store.addMember({
      roomId: room.id,
      authorId: member.id,
      responseMode: 'mention-only',
      joinedAt: new Date().toISOString(),
    });
    const client = () => ({
      send: vi.fn<FanOutClient['send']>(),
      bufferedBytes: 0,
      gone: false,
      drop: vi.fn(),
    });
    const inside = client();
    const outside = client();
    const agent = client();
    const disconnect = [
      eventFanOut.addClient(inside, { kind: 'program', userId: 'member' }),
      eventFanOut.addClient(outside, { kind: 'program', userId: 'non-member' }),
      eventFanOut.addClient(agent, { kind: 'agent' }),
    ];
    const ops = new SessionStateProjector('ses-ops');
    let listener: (update: { sessionId: string }) => void = () => undefined;
    const stop = watchRoomAwaiting(
      {
        bindingForSession: () =>
          ({ roomId: room.id, authorId: human }) as ReturnType<typeof bindings.bindingForSession>,
      },
      service,
      {
        onStatusChange: (next) => {
          listener = next;
          return () => undefined;
        },
        sessions: () => [ops],
      }
    );
    try {
      askApproval(ops, 'tool-1');
      listener({ sessionId: 'ses-ops' });
      expect(inside.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(inside.send.mock.calls[0][0].json)).toMatchObject({
        event: 'room_awaiting',
        data: { roomId: room.id, awaiting: 1 },
      });
      expect(outside.send).not.toHaveBeenCalled();
      expect(agent.send).not.toHaveBeenCalled();

      service.removeMember(room.id, human, member.id);
      // Ignore the separate room_member_removed broadcast from the service.
      for (const stream of [inside, outside, agent]) stream.send.mockClear();
      ops.ingest({ type: 'interaction_resolved', id: 'tool-1' } as RawSessionEvent);
      listener({ sessionId: 'ses-ops' });
      expect(inside.send).not.toHaveBeenCalled();
      expect(outside.send).not.toHaveBeenCalled();
      expect(agent.send).not.toHaveBeenCalled();
    } finally {
      stop();
      disconnect.forEach((off) => off());
    }
  });
});
