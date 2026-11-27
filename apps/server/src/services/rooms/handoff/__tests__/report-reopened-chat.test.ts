/**
 * A room seat's old chat, reopened after the seat moved, takes its own spin-offs' reports the way
 * any chat takes them (DOR-3753): `session_start` promises report-back there, and a report comes
 * in as a chat message. It stays no ordinary target for an agent's own `chat_send`, and the seat's
 * current chat still takes reports only through the room.
 *
 * The real chat-message service on a migrated database; only the launch stands in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionMetadata, eq, type Db } from '@dorkos/db';
import type { ChatMessageService } from '../../../session/chat-messages/chat-message-service.js';
import type { DispatchSessionMessageOpts } from '../../../session/launch/launch-session.js';
import { ChatReportBack } from '../../../session/chat-messages/chat-report-back.js';
import { takesReportsAsChat } from '../../../session/chat-messages/chat-target.js';
import { FIRST_MOVE, PATH, chatServiceOn, iso, seedMovedSeat } from './moved-seat-fixture.js';

const CHILD = { sessionId: 'child', agentPath: PATH };
/** When the spin-off's turn ends: after the seat moved off `old-seat`. */
const LATER = FIRST_MOVE + 120_000;

let db: Db;
let service: ChatMessageService;
let dispatched: DispatchSessionMessageOpts[];

beforeEach(() => {
  db = seedMovedSeat();
  ({ service, dispatched } = chatServiceOn(db));
});

afterEach(() => service.stop());

describe('takesReportsAsChat', () => {
  it.each([
    [true, false, 'room', 'report', true],
    [true, false, 'room', 'message', false],
    [true, true, 'room', 'report', false],
    [false, false, 'room', 'report', false],
    [true, false, 'schedule', 'report', false],
    [true, false, 'relay-binding', 'report', false],
    [true, false, null, 'report', false],
  ] as const)(
    'bound=%s room=%s origin=%s kind=%s takes it=%s',
    (bound, roomBound, launchOrigin, kind, expected) => {
      expect(takesReportsAsChat({ bound, roomBound, launchOrigin }, kind)).toBe(expected);
    }
  );
});

describe('a seat’s old chat after the seat moved (DOR-3753)', () => {
  it('is promised its spin-offs’ reports, as session_start asks, while the seat is not', async () => {
    expect(await service.canReceive('old-seat')).toBe(true);
    expect(await service.canReceive('middle-seat')).toBe(true);
    // The seat itself takes reports only through the room, as a turn there.
    expect(await service.canReceive('seat-now')).toBe(false);
  });

  it('is promised none when it is no room’s old chat but a scheduled run', async () => {
    db.update(sessionMetadata)
      .set({ launchOrigin: 'schedule' })
      .where(eq(sessionMetadata.sessionId, 'old-seat'))
      .run();
    expect(await service.canReceive('old-seat')).toBe(false);
  });

  it('takes a report as a chat message, and still refuses an agent’s own message', async () => {
    await expect(
      service.send(CHILD, { to: 'old-seat', message: 'Finished. The fix is in.' }, 'report')
    ).resolves.toMatchObject({ chatId: 'old-seat', status: 'working' });
    expect(dispatched.map((d) => d.sessionId)).toEqual(['old-seat']);

    await expect(
      service.send(CHILD, { to: 'old-seat', message: 'Can you look at this?' })
    ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect(dispatched).toHaveLength(1);
  });

  it('leaves the seat’s current chat closed to a report sent as a chat message', async () => {
    await expect(
      service.send(CHILD, { to: 'seat-now', message: 'Finished.' }, 'report')
    ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect(dispatched).toHaveLength(0);
  });

  it('gets a live report from a spin-off started there after the move, with no notice', async () => {
    const onUndelivered = vi.fn();
    const reports = new ChatReportBack({
      service,
      store: { listStopsOf: () => [], latestInterruptFrom: () => undefined },
      reportTargetOf: () => ({ parentSessionId: 'old-seat' }),
      agentPathOf: async () => PATH,
      marksOfTurn: () => ({}),
      holdsBackgroundWork: async () => false,
      statusOf: () => null,
      history: async () => [
        { id: 'answer', role: 'assistant', content: 'The fix is in.', timestamp: iso(LATER) },
      ],
      // The seat refuses a spin-off started after its move (`RoomSeatReports.deliver`).
      toRoomSeat: async () => false,
      delay: async () => {},
      later: () => {},
      now: () => LATER,
      onUndelivered,
    });

    await reports.onTurnEnd('child', null, { to: LATER });

    expect(dispatched.map((d) => d.sessionId)).toEqual(['old-seat']);
    expect(dispatched[0]!.request.content).toContain('The fix is in.');
    expect(onUndelivered).not.toHaveBeenCalled();
  });
});
