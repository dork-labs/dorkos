/**
 * A saved spin-off report follows a seat that moved only when the spin-off started at or before
 * the move (DOR-3753).
 *
 * When a seat moves to a fresh session, its old session stays a real chat a person can reopen.
 * A spin-off started from that chat after the move is the chat's own work: its saved report
 * must not wake the agent's seat in the room, and it comes back into that old chat as a chat
 * message, the way any spin-off reports to the chat that started it.
 *
 * Driven through the real report outbox and the real chat-message service on a migrated
 * database; only the seat hand-in, the launch and the notice stand in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { roomMembers, roomReportOutbox, sessionStartedBy, type Db } from '@dorkos/db';
import { DepartedSeatStore } from '../../manage/departed-seat-store.js';
import {
  ChatReportBack,
  type ChatReportBackDeps,
} from '../../../session/chat-messages/chat-report-back.js';
import { HandoffOutboxStore } from '../outbox/handoff-outbox-store.js';
import { reportSeatScope } from '../outbox/report-seat-scope.js';
import {
  FIRST_MOVE,
  NOW,
  PATH,
  SEAT,
  SECOND_MOVE,
  chatServiceOn,
  iso,
  seedMovedSeat,
  startChild as startChildIn,
} from './moved-seat-fixture.js';

let db: Db;

beforeEach(() => {
  db = seedMovedSeat();
});

/** Record `child` as a spin-off `parent` started at `startedAt`. */
function startChild(parent: string, startedAt: number): void {
  startChildIn(db, parent, startedAt);
}

type ToRoomSeat = NonNullable<ChatReportBackDeps['toRoomSeat']>;

/** A seat hand-in that takes the report when the outbox lets the seat's turn run. */
const seatTakes: ToRoomSeat = async (_parent, report) => report.beforeRun?.() ?? false;

/** Report-back for `child`, over a fresh outbox store as each server lifetime has. */
function reportBack(
  parent: string,
  service: ChatReportBackDeps['service'],
  toRoomSeat: ToRoomSeat,
  onUndelivered: ChatReportBackDeps['onUndelivered']
) {
  return new ChatReportBack({
    service,
    store: { listStopsOf: () => [], latestInterruptFrom: () => undefined },
    reportTargetOf: () => ({ parentSessionId: parent }),
    agentPathOf: async () => PATH,
    marksOfTurn: () => ({}),
    holdsBackgroundWork: async () => false,
    statusOf: () => null,
    history: async () => [
      { id: 'answer', role: 'assistant', content: 'The fix is in.', timestamp: iso(NOW) },
    ],
    delay: async () => {},
    later: () => {},
    now: () => NOW,
    outbox: new HandoffOutboxStore(db),
    toRoomSeat,
    onUndelivered,
  });
}

/** Run one finished turn of `child` through the real report outbox and chat-message service. */
async function reportFrom(parent: string, seat: ToRoomSeat = seatTakes) {
  const { service, dispatched } = chatServiceOn(db);
  const send = vi.spyOn(service, 'send');
  const onUndelivered = vi.fn().mockResolvedValue(undefined);
  const toRoomSeat = vi.fn<ToRoomSeat>(seat);
  await reportBack(parent, service, toRoomSeat, onUndelivered).onTurnEnd('child', null, {
    to: NOW,
  });
  service.stop();
  const row = db.select().from(roomReportOutbox).get()!;
  return {
    send,
    dispatched,
    onUndelivered,
    toRoomSeat,
    row,
    saved: new HandoffOutboxStore(db).reports.decode(row),
  };
}

/**
 * Save `child`'s report, stop the server while the report waits on the seat, run `meanwhile`,
 * then recover the saved report in a new server lifetime.
 */
async function savedThenRestarted(parent: string, meanwhile: () => void = () => {}) {
  const before = chatServiceOn(db);
  const parked = vi.fn<ToRoomSeat>(() => new Promise<boolean>(() => {}));
  const first = reportBack(parent, before.service, parked, vi.fn());
  void first.onTurnEnd('child', null, { to: NOW });
  await vi.waitFor(() => expect(parked).toHaveBeenCalled());
  first.stop();
  before.service.stop();
  meanwhile();
  const { service, dispatched } = chatServiceOn(db);
  const onUndelivered = vi.fn().mockResolvedValue(undefined);
  await reportBack(parent, service, seatTakes, onUndelivered).recoverPending();
  service.stop();
  const row = db.select().from(roomReportOutbox).get()!;
  return { dispatched, onUndelivered, row, saved: new HandoffOutboxStore(db).reports.decode(row) };
}

/** The chat each report-back message was launched into. */
const chatsReached = (dispatched: { sessionId: string }[]) => dispatched.map((d) => d.sessionId);

describe('reportSeatScope', () => {
  it('answers for a moved session only for a spin-off started at or before its move', () => {
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE - 1)).toEqual(SEAT);
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE)).toEqual(SEAT);
    // Later: no seat, so the report goes to the old chat as a chat message.
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE + 1)).toBeNull();
  });

  it('never takes an unknown start for the seat’s', () => {
    expect(reportSeatScope(db, 'old-seat', null)).toBeNull();
  });

  it('leaves the seat’s current session alone, whenever its spin-off started', () => {
    expect(reportSeatScope(db, 'seat-now', NOW)).toEqual(SEAT);
    expect(reportSeatScope(db, 'seat-now', null)).toEqual(SEAT);
  });

  it('after two moves, each old session answers only for spin-offs from its own time', () => {
    const between = FIRST_MOVE + 1;
    expect(reportSeatScope(db, 'old-seat', between)).toBeNull();
    expect(reportSeatScope(db, 'middle-seat', between)).toEqual(SEAT);
    expect(reportSeatScope(db, 'middle-seat', SECOND_MOVE + 1)).toBeNull();
  });

  it('after a leave and rejoin, the old chat is no seat for spin-offs from before or after', () => {
    db.update(roomMembers)
      .set({ joinedAt: iso(SECOND_MOVE + 1) })
      .run();
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE - 1)).toBeNull();
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE + 1)).toBeNull();
  });
});

describe('a saved report from a spin-off of a moved seat (DOR-3753)', () => {
  it('started before the move, wakes the seat where it sits now', async () => {
    startChild('old-seat', FIRST_MOVE - 60_000);

    const { send, onUndelivered, toRoomSeat, row, saved } = await reportFrom('old-seat');

    expect(saved.seat).toEqual(SEAT);
    expect(toRoomSeat).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(onUndelivered).not.toHaveBeenCalled();
    expect(row.state).toBe('delivered');
  });

  it('started from the reopened old chat after the move, comes back into that chat', async () => {
    startChild('old-seat', FIRST_MOVE + 60_000);

    const { send, dispatched, onUndelivered, toRoomSeat, row, saved } =
      await reportFrom('old-seat');

    expect(saved.seat).toBeNull();
    // The seat is asked and refuses: no seat turn may run for this report.
    expect(await toRoomSeat.mock.results[0]?.value).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![2]).toBe('report');
    expect(chatsReached(dispatched)).toEqual(['old-seat']);
    expect(dispatched[0]!.request.content).toContain('The fix is in.');
    expect(row.state).toBe('delivered');
    expect(onUndelivered).not.toHaveBeenCalled();
  });

  it('with an unknown start, never reaches the seat and comes back into the old chat', async () => {
    startChild('old-seat', FIRST_MOVE + 60_000);
    db.update(sessionStartedBy).set({ createdAt: 'not a time' }).run();

    const { dispatched, row, saved } = await reportFrom('old-seat');

    expect(saved.seat).toBeNull();
    expect(chatsReached(dispatched)).toEqual(['old-seat']);
    expect(row.state).toBe('delivered');
  });

  it('after two moves, each report goes where its spin-off’s start puts it', async () => {
    const cases: [parent: string, startedAt: number, seat: boolean][] = [
      ['old-seat', FIRST_MOVE - 60_000, true],
      ['old-seat', FIRST_MOVE + 60_000, false],
      ['old-seat', SECOND_MOVE + 60_000, false],
      ['middle-seat', FIRST_MOVE + 60_000, true],
      ['middle-seat', SECOND_MOVE + 60_000, false],
    ];
    for (const [parent, startedAt, seat] of cases) {
      db.delete(roomReportOutbox).run();
      startChild(parent, startedAt);
      const { dispatched, toRoomSeat, row, saved } = await reportFrom(parent);
      expect(saved.seat, `${parent} at ${iso(startedAt)}`).toEqual(seat ? SEAT : null);
      expect(chatsReached(dispatched)).toEqual(seat ? [] : [parent]);
      expect(await toRoomSeat.mock.results[0]?.value).toBe(seat);
      expect(row.state).toBe('delivered');
    }
  });

  it('after the agent leaves the room, reports come back to the chat that started each spin-off', async () => {
    new DepartedSeatStore(db).removeFromChannels(
      [{ authorId: 'river-author', manifestId: 'river' }],
      iso(NOW)
    );
    for (const [parent, startedAt] of [
      ['old-seat', FIRST_MOVE - 60_000],
      ['old-seat', FIRST_MOVE + 60_000],
      ['seat-now', SECOND_MOVE + 60_000],
    ] as const) {
      db.delete(roomReportOutbox).run();
      startChild(parent, startedAt);
      const { dispatched, row, saved } = await reportFrom(parent);
      expect(saved.seat).toBeNull();
      expect(chatsReached(dispatched)).toEqual([parent]);
      expect(row.state).toBe('delivered');
    }
  });

  it('saved while the seat was busy, then the agent left: the chat that started it gets it', async () => {
    for (const [parent, startedAt] of [
      ['seat-now', SECOND_MOVE + 60_000],
      ['old-seat', FIRST_MOVE - 60_000],
    ] as const) {
      db = seedMovedSeat();
      startChild(parent, startedAt);
      let waits = 0;
      let checkedFor: unknown;
      // The seat is busy; while the report waits on it, the agent leaves the room.
      const { dispatched, onUndelivered, row, saved } = await reportFrom(parent, async (_p, r) => {
        if (waits++ > 0) return r.beforeRun?.() ?? false;
        checkedFor = r.seat;
        new DepartedSeatStore(db).removeFromChannels(
          [{ authorId: 'river-author', manifestId: 'river' }],
          iso(NOW)
        );
        throw new Error('The report did not reach the room seat.');
      });
      expect(checkedFor, parent).toEqual({ roomId: 'team', authorId: 'river-author' });
      expect(saved.seat, parent).toBeNull();
      expect(chatsReached(dispatched)).toEqual([parent]);
      expect(row.state).toBe('delivered');
      expect(onUndelivered).not.toHaveBeenCalled();
    }
  });

  it('saved for the reopened old chat and recovered after a restart, is delivered there', async () => {
    startChild('old-seat', FIRST_MOVE + 60_000);

    const { dispatched, onUndelivered, row, saved } = await savedThenRestarted('old-seat');

    expect(saved.seat).toBeNull();
    expect(chatsReached(dispatched)).toEqual(['old-seat']);
    expect(row.state).toBe('delivered');
    expect(onUndelivered).not.toHaveBeenCalled();
  });

  it('saved for the seat, then the agent left while the server was down: the chat gets it', async () => {
    startChild('seat-now', SECOND_MOVE + 60_000);

    const { dispatched, onUndelivered, row, saved } = await savedThenRestarted('seat-now', () =>
      new DepartedSeatStore(db).removeFromChannels(
        [{ authorId: 'river-author', manifestId: 'river' }],
        iso(NOW)
      )
    );

    expect(saved.seat).toBeNull();
    expect(chatsReached(dispatched)).toEqual(['seat-now']);
    expect(row.state).toBe('delivered');
    expect(onUndelivered).not.toHaveBeenCalled();
  });

  it('after a rejoin, a report from before the move goes to the old chat, not the new seat', async () => {
    db.update(roomMembers)
      .set({ joinedAt: iso(SECOND_MOVE + 1) })
      .run();
    startChild('old-seat', FIRST_MOVE - 60_000);

    const { dispatched, toRoomSeat, row, saved } = await reportFrom('old-seat');

    expect(saved.seat).toBeNull();
    expect(await toRoomSeat.mock.results[0]?.value).toBe(false);
    expect(chatsReached(dispatched)).toEqual(['old-seat']);
    expect(row.state).toBe('delivered');
  });
});
