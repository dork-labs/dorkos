/**
 * A saved spin-off report follows a seat that moved only when the spin-off started at or before
 * the move (DOR-3753).
 *
 * When a seat moves to a fresh session, its old session stays a real chat a person can reopen.
 * A spin-off started from that chat after the move is the chat's own work, so its saved report
 * must not wake the agent's seat in the room. Until a route back into the reopened chat exists,
 * it ends as an honest undelivered notice and nothing is sent anywhere.
 *
 * Driven through the real report outbox on a migrated database; only the delivery edges (the
 * seat hand-in, the chat send and the notice) stand in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agents,
  authors,
  roomMembers,
  roomReportOutbox,
  roomSeatMoves,
  roomSessions,
  rooms,
  sessionMetadata,
  sessionStartedBy,
  type Db,
} from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  ChatReportBack,
  type ChatReportBackDeps,
} from '../../../session/chat-messages/chat-report-back.js';
import { HandoffOutboxStore } from '../outbox/handoff-outbox-store.js';
import { reportSeatScope } from '../outbox/report-seat-scope.js';

const PATH = '/agents/river';
const JOINED = '2026-11-20T11:00:00.000Z';
const FIRST_MOVE = Date.parse('2026-11-20T12:00:00.000Z');
const SECOND_MOVE = Date.parse('2026-11-20T13:00:00.000Z');
const NOW = Date.parse('2026-11-20T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let db: Db;

beforeEach(() => {
  db = createTestDb();
  db.insert(agents)
    .values({
      id: 'river',
      name: 'river',
      runtime: 'claude-code',
      projectPath: PATH,
      registeredAt: JOINED,
      updatedAt: JOINED,
    })
    .run();
  for (const sessionId of ['child', 'old-seat', 'middle-seat', 'seat-now'])
    db.insert(sessionMetadata)
      .values({
        sessionId,
        runtime: 'claude-code',
        agentPath: PATH,
        launchOrigin: sessionId === 'child' ? 'agent-launch' : 'room',
        createdAt: JOINED,
      })
      .run();
  db.insert(authors)
    .values({
      id: 'river-author',
      kind: 'agent',
      naturalKey: PATH,
      displayName: 'River',
      mintedForManifestId: 'river',
      createdAt: JOINED,
    })
    .run();
  db.insert(rooms)
    .values({
      id: 'team',
      kind: 'channel',
      slug: 'team',
      title: 'Team',
      createdAt: JOINED,
      lastActivityAt: JOINED,
    })
    .run();
  db.insert(roomMembers)
    .values({
      roomId: 'team',
      authorId: 'river-author',
      responseMode: 'mention-only',
      joinedAt: JOINED,
    })
    .run();
  // The seat sits on `seat-now`: it moved from `old-seat` to `middle-seat`, then on again.
  db.insert(roomSessions)
    .values({ roomId: 'team', authorId: 'river-author', sessionId: 'seat-now', createdAt: JOINED })
    .run();
  db.insert(roomSeatMoves)
    .values([
      { fromSessionId: 'old-seat', roomId: 'team', authorId: 'river-author', movedAt: FIRST_MOVE },
      {
        fromSessionId: 'middle-seat',
        roomId: 'team',
        authorId: 'river-author',
        movedAt: SECOND_MOVE,
      },
    ])
    .run();
});

/** Record `child` as a spin-off `parent` started at `startedAt`. */
function startChild(parent: string, startedAt: number): void {
  db.insert(sessionStartedBy)
    .values({
      sessionId: 'child',
      kind: 'chat',
      startedBySessionId: parent,
      reportBack: true,
      createdAt: iso(startedAt),
    })
    .run();
}

/** Run one finished turn of `child` through the real report outbox. */
async function reportFrom(parent: string) {
  const send = vi.fn().mockResolvedValue({ messageId: 'm', chatId: parent, status: 'queued' });
  const onUndelivered = vi.fn().mockResolvedValue(undefined);
  const toRoomSeat = vi.fn<NonNullable<ChatReportBackDeps['toRoomSeat']>>(
    async (_parent, report) => report.beforeRun?.() ?? false
  );
  const reports = new ChatReportBack({
    service: { send },
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
  await reports.onTurnEnd('child', null, { to: NOW });
  const row = db.select().from(roomReportOutbox).get()!;
  return {
    send,
    onUndelivered,
    toRoomSeat,
    row,
    saved: new HandoffOutboxStore(db).reports.decode(row),
  };
}

const SEAT = {
  roomId: 'team',
  authorId: 'river-author',
  joinedAt: JOINED,
  agentPath: PATH,
};

describe('reportSeatScope', () => {
  it('answers for a moved session only for a spin-off started at or before its move', () => {
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE - 1)).toEqual(SEAT);
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE)).toEqual(SEAT);
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE + 1)).toBe('unavailable');
  });

  it('refuses a moved session when the spin-off’s start is unknown', () => {
    expect(reportSeatScope(db, 'old-seat', null)).toBe('unavailable');
  });

  it('leaves the seat’s current session alone, whenever its spin-off started', () => {
    expect(reportSeatScope(db, 'seat-now', NOW)).toEqual(SEAT);
    expect(reportSeatScope(db, 'seat-now', null)).toEqual(SEAT);
  });

  it('after two moves, each old session answers only for spin-offs from its own time', () => {
    const between = FIRST_MOVE + 1;
    expect(reportSeatScope(db, 'old-seat', between)).toBe('unavailable');
    expect(reportSeatScope(db, 'middle-seat', between)).toEqual(SEAT);
    expect(reportSeatScope(db, 'middle-seat', SECOND_MOVE + 1)).toBe('unavailable');
  });

  it('refuses after a leave and rejoin, whether the spin-off started before or after the move', () => {
    db.update(roomMembers)
      .set({ joinedAt: iso(SECOND_MOVE + 1) })
      .run();
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE - 1)).toBe('unavailable');
    expect(reportSeatScope(db, 'old-seat', FIRST_MOVE + 1)).toBe('unavailable');
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

  it('started from the reopened old chat after the move, wakes nothing and leaves a plain notice', async () => {
    startChild('old-seat', FIRST_MOVE + 60_000);

    const { send, onUndelivered, toRoomSeat, row, saved } = await reportFrom('old-seat');

    expect(saved.seat).toBe('unavailable');
    expect(toRoomSeat).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: 'declined', noticeState: 'accepted' });
    expect(onUndelivered).toHaveBeenCalledOnce();
    const notice = onUndelivered.mock.calls[0]![0];
    expect(notice).toMatchObject({ sessionId: 'child', parentSessionId: 'old-seat' });
    // Nothing was handed in, so the notice says so plainly rather than "may have been delivered".
    expect(notice.deliveryUnknown).toBe(false);
  });

  it('after two moves, follows the seat only from the session that held it when it started', async () => {
    startChild('middle-seat', FIRST_MOVE + 60_000);
    const fromMiddle = await reportFrom('middle-seat');
    expect(fromMiddle.saved.seat).toEqual(SEAT);
    expect(fromMiddle.toRoomSeat).toHaveBeenCalledOnce();

    db.delete(roomReportOutbox).run();
    db.delete(sessionStartedBy).run();
    startChild('old-seat', FIRST_MOVE + 60_000);
    const fromOld = await reportFrom('old-seat');
    expect(fromOld.saved.seat).toBe('unavailable');
    expect(fromOld.toRoomSeat).not.toHaveBeenCalled();
    expect(fromOld.onUndelivered).toHaveBeenCalledOnce();
  });
});
