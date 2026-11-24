import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  agents,
  notifications,
  authors,
  rooms,
  roomMembers,
  roomSessions,
  eq,
  createDb,
  roomReportOutbox,
  runMigrations,
  sessionMetadata,
  sessionStartedBy,
  type Db,
} from '@dorkos/db';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { NotificationService } from '../../../notifications/notification-service.js';
import { NotificationStore } from '../../../notifications/notification-store.js';
import { notifyUndeliveredReport } from '../report-undelivered.js';
import { noteRoomTurnWords } from '../../../core/turn-power/outside-words.js';
import type { TurnMarks } from '../../../core/turn-power/turn-marks.js';
import { HandoffOutboxStore } from '../../../rooms/handoff/outbox/handoff-outbox-store.js';
import { ChatReportBack, REPORT_DETAIL_MAX, type ChatReportBackDeps } from '../chat-report-back.js';

const AT = '2026-11-20T12:00:00.000Z';
const PATH = '/agents/river';
const MARKS = {
  outsider: true as const,
  teammate: [{ roomId: 'a-space', authorId: 'a-teammate' }],
};
let home: string | undefined;
const handles: Db[] = [];
afterEach(() => {
  noteRoomTurnWords('child', false);
  vi.useRealTimers();
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  home = mkdtempSync(join(tmpdir(), 'report-restart-'));
  const file = join(home, 'reports.sqlite');
  const open = () => {
    const db = createDb(file);
    handles.push(db);
    runMigrations(db);
    return db;
  };
  const db = open();
  db.insert(agents)
    .values({
      id: 'river',
      name: 'river',
      runtime: 'claude-code',
      projectPath: PATH,
      registeredAt: AT,
      updatedAt: AT,
    })
    .run();
  for (const sessionId of ['child', 'parent'])
    db.insert(sessionMetadata)
      .values({
        sessionId,
        runtime: 'claude-code',
        agentPath: PATH,
        launchOrigin: 'interactive',
        createdAt: AT,
      })
      .run();
  db.insert(sessionStartedBy)
    .values({
      sessionId: 'child',
      kind: 'chat',
      startedBySessionId: 'parent',
      reportBack: true,
      createdAt: AT,
    })
    .run();
  const send = vi
    .fn()
    .mockResolvedValue({ messageId: 'one-report', chatId: 'parent', status: 'queued' });
  const deps: ChatReportBackDeps = {
    service: { send },
    store: { listStopsOf: () => [], latestInterruptFrom: () => undefined },
    reportTargetOf: () => ({ parentSessionId: 'parent' }),
    agentPathOf: async () => PATH,
    marksOfTurn: () => MARKS,
    holdsBackgroundWork: async () => true,
    statusOf: () => null,
    history: async () => [
      {
        id: 'last-answer',
        role: 'assistant',
        content: 'The waiting work is ready.',
        timestamp: AT,
      },
    ],
    delay: async () => {},
    later: () => {},
    now: () => Date.parse(AT),
  };
  return { db, open, send, deps };
}

function makeSeat(db: Db) {
  db.insert(authors)
    .values({
      id: 'river-author',
      kind: 'agent',
      naturalKey: PATH,
      displayName: 'River',
      mintedForManifestId: 'river',
      createdAt: AT,
    })
    .run();
  db.insert(rooms)
    .values({
      id: 'team',
      kind: 'channel',
      slug: 'team',
      title: 'Team',
      createdAt: AT,
      lastActivityAt: AT,
    })
    .run();
  db.insert(roomMembers)
    .values({
      roomId: 'team',
      authorId: 'river-author',
      responseMode: 'mention-only',
      joinedAt: AT,
    })
    .run();
  db.insert(roomSessions)
    .values({ roomId: 'team', authorId: 'river-author', sessionId: 'parent', createdAt: AT })
    .run();
}

it('prunes settled reports after seven days while keeping unacknowledged notices and waiting work', async () => {
  const { db, deps } = fixture();
  const outbox = new HandoffOutboxStore(db);
  const first = new ChatReportBack({ ...deps, holdsBackgroundWork: async () => false, outbox });
  await first.onTurnEnd('child', null, { to: Date.parse(AT) });
  const delivered = db.select().from(roomReportOutbox).get()!;
  const make = (
    id: string,
    state: typeof delivered.state,
    noticeState: typeof delivered.noticeState,
    settledAt: number | null
  ) =>
    db
      .insert(roomReportOutbox)
      .values({ ...delivered, id, state, noticeState, settledAt })
      .run();
  make('unacked', 'declined', 'ready', Date.parse(AT));
  make('waiting', 'deferred', 'none', null);
  make('recent', 'delivered', 'none', Date.parse(AT) + 1);
  outbox.reports.pruneSettled(Date.parse(AT) + 7 * 24 * 60 * 60_000);
  expect(outbox.reports.get(delivered.id)).toBeUndefined();
  for (const id of ['unacked', 'waiting', 'recent']) expect(outbox.reports.get(id)).toBeDefined();
});

it('saves a very long error already cut, so the outbox row stays small (DOR-3535)', async () => {
  const { db, send, deps } = fixture();
  const outbox = new HandoffOutboxStore(db);
  const reporter = new ChatReportBack({ ...deps, holdsBackgroundWork: async () => false, outbox });
  const failed = {
    lifecycle: 'error',
    limit: null,
    lastError: { message: 'Error detail. '.repeat(20_000) },
  } as SessionStatus;
  await reporter.onTurnEnd('child', failed, { to: Date.parse(AT) });
  const row = db.select().from(roomReportOutbox).get()!;
  const saved = outbox.reports.decode(row);
  expect(saved.detail).toHaveLength(REPORT_DETAIL_MAX);
  expect(saved.detail!.endsWith('… (Details cut short.)')).toBe(true);
  expect(row.payloadJson.length).toBeLessThan(20_000);
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]![1].message).toContain(saved.detail);
});

it('keeps a cross-runtime spin-off report durable under the session runtime', async () => {
  const { db, open, send, deps } = fixture();
  db.update(sessionMetadata)
    .set({ runtime: 'codex' })
    .where(eq(sessionMetadata.sessionId, 'child'))
    .run();
  const first = new ChatReportBack({ ...deps, outbox: new HandoffOutboxStore(db) });
  await expect(first.onTurnEnd('child', null, { to: Date.parse(AT) })).resolves.toBeNull();
  const row = db.select().from(roomReportOutbox).get()!;
  expect(new HandoffOutboxStore(db).reports.decode(row).source).toMatchObject({
    runtime: 'codex',
    agentId: 'river',
  });
  first.stop();
  await new ChatReportBack({
    ...deps,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(open()),
  }).recoverPending();
  expect(send).toHaveBeenCalledOnce();
});

it.each(['turn', 'waiting', 'startup'] as const)(
  'falls back to live delivery and a notice if saving the %s report fails',
  async (kind) => {
    const { db, send, deps } = fixture();
    const outbox = new HandoffOutboxStore(db);
    db.$client.exec(
      "CREATE TRIGGER report_disk_fault BEFORE INSERT ON room_report_outbox BEGIN SELECT RAISE(ABORT, 'disk write failed'); END"
    );
    const onUndelivered = vi.fn().mockResolvedValue(undefined);
    const reporter = new ChatReportBack({
      ...deps,
      holdsBackgroundWork: async () => false,
      ...(kind === 'waiting'
        ? { statusOf: () => ({ lifecycle: 'blocked', limit: null }) as SessionStatus }
        : {}),
      outbox,
      onUndelivered,
    });
    if (kind === 'waiting')
      await expect(reporter.onWaiting('child', { key: 'ask', what: 'Continue?' })).resolves.toBe(
        true
      );
    else if (kind === 'startup')
      await expect(
        reporter.onNeverStarted('child', 'It never started.', MARKS)
      ).resolves.toBeUndefined();
    else
      await expect(reporter.onTurnEnd('child', null, { to: Date.parse(AT) })).resolves.toBe(
        'finished'
      );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      marksAtTurnEnd: MARKS,
      outsideWordsAtTurnEnd: true,
    });
    expect(onUndelivered).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ recoveryUnavailable: true })
    );
  }
);

it('settles an answered wait recovered after restart without a false lost-report notice', async () => {
  const { db, open, send, deps } = fixture();
  let release!: () => void;
  const initial = new ChatReportBack({
    ...deps,
    outbox: new HandoffOutboxStore(db),
    delay: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  const waiting = initial.onWaiting('child', { key: 'old-ask', what: 'Continue?' });
  initial.stop();
  release();
  await waiting;
  const onUndelivered = vi.fn().mockResolvedValue(undefined);
  await new ChatReportBack({
    ...deps,
    outbox: new HandoffOutboxStore(open()),
    onUndelivered,
  }).recoverPending();
  expect(db.select().from(roomReportOutbox).get()).toMatchObject({
    state: 'delivered',
    noticeState: 'none',
  });
  expect(send).not.toHaveBeenCalled();
  expect(onUndelivered).not.toHaveBeenCalled();
});

it.each(['missing', 'unbound'] as const)(
  'keeps a startup failure as a terminal notice when its source identity is %s',
  async (identity) => {
    const { db, open, send, deps } = fixture();
    if (identity === 'missing') {
      db.delete(sessionMetadata).where(eq(sessionMetadata.sessionId, 'child')).run();
    } else {
      db.update(sessionMetadata)
        .set({ runtime: null, agentPath: null })
        .where(eq(sessionMetadata.sessionId, 'child'))
        .run();
    }
    const outbox = new HandoffOutboxStore(db);
    const initial = new ChatReportBack({
      ...deps,
      outbox,
      onUndelivered: async () => {
        throw new Error('notification storage offline');
      },
    });
    await expect(
      initial.onNeverStarted('child', 'The first launch never completed.', MARKS)
    ).resolves.toBeUndefined();
    const row = db.select().from(roomReportOutbox).get()!;
    expect(row).toMatchObject({ state: 'declined', noticeState: 'ready' });
    expect(outbox.reports.decode(row)).toMatchObject({ source: null, marks: MARKS });
    expect(send).not.toHaveBeenCalled();
    initial.stop();

    const onUndelivered = vi.fn().mockResolvedValue(undefined);
    const restored = new ChatReportBack({
      ...deps,
      outbox: new HandoffOutboxStore(open()),
      onUndelivered,
    });
    await restored.recoverPending();
    await restored.recoverPending();
    expect(onUndelivered).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reportId: row.id, reason: 'never-started' })
    );
    expect(send).not.toHaveBeenCalled();
  }
);

it.each(['private', 'seat'] as const)(
  'keeps outside-read evidence on a recovered %s report after live evidence is gone',
  async (destination) => {
    const { db, open, send, deps } = fixture();
    if (destination === 'seat') makeSeat(db);
    noteRoomTurnWords('child', true);
    const outbox = new HandoffOutboxStore(db);
    const initial = new ChatReportBack({ ...deps, marksOfTurn: () => ({}), outbox });
    await initial.onTurnEnd('child', null, { to: Date.parse(AT) });
    const row = db.select().from(roomReportOutbox).get()!;
    expect(outbox.reports.decode(row)).toMatchObject({ outsideWords: true, marks: {} });
    initial.stop();
    noteRoomTurnWords('child', false);

    const toRoomSeat = vi.fn<NonNullable<ChatReportBackDeps['toRoomSeat']>>(
      async (_parent, report) => {
        expect(report.outsideWords).toBe(true);
        // The seat the outbox checked, so no other seat can take it.
        expect(report.seat).toEqual({ roomId: 'team', authorId: 'river-author' });
        expect(report.beforeRun?.()).toBe(true);
        return true;
      }
    );
    await new ChatReportBack({
      ...deps,
      marksOfTurn: () => ({}),
      holdsBackgroundWork: async () => false,
      outbox: new HandoffOutboxStore(open()),
      ...(destination === 'seat' ? { toRoomSeat } : {}),
    }).recoverPending();
    if (destination === 'seat') {
      expect(toRoomSeat).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    } else {
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toMatchObject({ outsideWordsAtTurnEnd: true });
    }
  }
);

it('quarantines unreadable saved report marks instead of replaying a clean report', async () => {
  const { db, open, deps, send } = fixture();
  const initial = new ChatReportBack({ ...deps, outbox: new HandoffOutboxStore(db) });
  await initial.onTurnEnd('child', null, { to: Date.parse(AT) });
  initial.stop();
  const row = db.select().from(roomReportOutbox).get()!;
  const saved = JSON.parse(row.payloadJson);
  saved.marks = { outsider: 'unreadable' };
  db.update(roomReportOutbox)
    .set({ payloadJson: JSON.stringify(saved) })
    .where(eq(roomReportOutbox.id, row.id))
    .run();
  const onUndelivered = vi.fn().mockResolvedValue(undefined);
  const reopened = open();
  await new ChatReportBack({
    ...deps,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(reopened),
    onUndelivered,
  }).recoverPending();
  expect(send).not.toHaveBeenCalled();
  expect(onUndelivered).toHaveBeenCalledOnce();
  expect(reopened.select().from(roomReportOutbox).get()).toMatchObject({
    state: 'quarantined',
    noticeState: 'accepted',
  });
});

it('persists a deferred report before waiting, then a fresh report-back sends it once with its original marks', async () => {
  const { db, open, send, deps } = fixture();
  const initial = new ChatReportBack({ ...deps, outbox: new HandoffOutboxStore(db) });
  await initial.onTurnEnd('child', null, { from: Date.parse(AT) - 1000, to: Date.parse(AT) });
  expect(send).not.toHaveBeenCalled();
  const reopened = open();
  const restored = new ChatReportBack({
    ...deps,
    marksOfTurn: () => ({}),
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(reopened),
  });
  // Old releases have no recovery entry point. The observable regression is the missing report.
  await restored.recoverPending();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'child', marksAtTurnEnd: MARKS });
  expect(send.mock.calls[0]?.[1].message).toContain('The waiting work is ready.');
  await restored.recoverPending();
  expect(send).toHaveBeenCalledTimes(1);
  expect(reopened.select().from(roomReportOutbox).all()).toHaveLength(1);
});

it('records the report before the background-work probe can suspend the producer', async () => {
  const { db, deps } = fixture();
  let release!: (holding: boolean) => void;
  const probe = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const reports = new ChatReportBack({
    ...deps,
    holdsBackgroundWork: () => probe,
    outbox: new HandoffOutboxStore(db),
  });
  const pending = reports.onTurnEnd('child', null, { to: Date.parse(AT) });
  try {
    expect(db.select().from(roomReportOutbox).all()).toHaveLength(1);
  } finally {
    release(true);
    await pending;
  }
});

it('leaves a busy seat ready across restart and claims only at the final effect boundary', async () => {
  const { db, open, deps, send } = fixture();
  makeSeat(db);
  let release!: (taken: boolean) => void;
  let waiting!: () => void;
  const offered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const initial = new ChatReportBack({
    ...deps,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(db),
    toRoomSeat: async () => {
      waiting();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const oldWork = initial.onTurnEnd('child', null, { to: Date.parse(AT) });
  await offered;
  const [before] = db.select().from(roomReportOutbox).all();
  expect(before?.state).toBe('ready');
  initial.stop();
  let effects = 0;
  const reopened = open();
  const restored = new ChatReportBack({
    ...deps,
    outbox: new HandoffOutboxStore(reopened),
    toRoomSeat: async (_parent, report) => {
      expect(report.marks).toEqual(MARKS);
      expect(report.waitDeadlineAt).toBe(before?.waitDeadlineAt);
      if (report.beforeRun?.()) effects += 1;
      return true;
    },
  });
  await restored.recoverPending();
  release(false);
  await oldWork;
  expect(effects).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(reopened.select().from(roomReportOutbox).get()).toMatchObject({
    state: 'delivered',
    waitDeadlineAt: before?.waitDeadlineAt,
  });
  await restored.recoverPending();
  expect(effects).toBe(1);
});

it('lets a busy runtime retry its claimed seat turn under the same live worker', async () => {
  const { db, deps, send } = fixture();
  makeSeat(db);
  const answers: boolean[] = [];
  const onUndelivered = vi.fn().mockResolvedValue(undefined);
  const reports = new ChatReportBack({
    ...deps,
    onUndelivered,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(db),
    // The aside claims at beforeRun, the runtime answers busy, and the loop asks again.
    toRoomSeat: async (_parent, report) => {
      answers.push(report.beforeRun?.() ?? false);
      answers.push(report.beforeRun?.() ?? false);
      return true;
    },
  });
  await reports.onTurnEnd('child', null, { to: Date.parse(AT) });
  expect(answers).toEqual([true, true]);
  expect(send).not.toHaveBeenCalled();
  expect(onUndelivered).not.toHaveBeenCalled();
  expect(db.select().from(roomReportOutbox).get()).toMatchObject({ state: 'delivered' });
});

it('never replays a seat turn that started before restart and retries its terminal notice', async () => {
  const { db, open, deps } = fixture();
  makeSeat(db);
  let release!: (taken: boolean) => void;
  let started!: () => void;
  const effect = new Promise<void>((resolve) => {
    started = resolve;
  });
  let runs = 0;
  const initial = new ChatReportBack({
    ...deps,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(db),
    toRoomSeat: async (_parent, report) => {
      expect(report.beforeRun?.()).toBe(true);
      runs += 1;
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const oldWork = initial.onTurnEnd('child', null, { to: Date.parse(AT) });
  await effect;
  initial.stop();
  const reopened = open();
  const onUndelivered = vi.fn().mockRejectedValue(new Error('notification storage offline'));
  const restored = new ChatReportBack({
    ...deps,
    outbox: new HandoffOutboxStore(reopened),
    onUndelivered,
    toRoomSeat: async () => {
      runs += 1;
      return true;
    },
  });
  await restored.recoverPending();
  expect(runs).toBe(1);
  expect(reopened.select().from(roomReportOutbox).get()).toMatchObject({
    state: 'interrupted',
    noticeState: 'ready',
  });
  const notice = onUndelivered.mock.calls[0]?.[0];
  expect(notice).toMatchObject({
    deliveryUnknown: true,
    sessionId: 'child',
    parentSessionId: 'parent',
  });
  onUndelivered.mockResolvedValue(undefined);
  await restored.recoverPending();
  expect(onUndelivered.mock.calls.at(-1)?.[0]).toMatchObject({
    reportId: notice.reportId,
    at: notice.at,
    deliveryUnknown: true,
  });
  expect(reopened.select().from(roomReportOutbox).get()?.noticeState).toBe('accepted');
  release(true);
  await oldWork;
});

it('does not renew the original seat deadline after a restart', async () => {
  const { db, open, deps, send } = fixture();
  makeSeat(db);
  let offered!: () => void;
  let release!: (taken: boolean) => void;
  const wait = new Promise<void>((resolve) => {
    offered = resolve;
  });
  const initial = new ChatReportBack({
    ...deps,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(db),
    toRoomSeat: async () => {
      offered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const oldWork = initial.onTurnEnd('child', null, { to: Date.parse(AT) });
  await wait;
  initial.stop();
  const reopened = open();
  const onUndelivered = vi.fn();
  let effects = 0;
  const restored = new ChatReportBack({
    ...deps,
    now: () => Date.parse(AT) + 60 * 60_000,
    outbox: new HandoffOutboxStore(reopened),
    onUndelivered,
    toRoomSeat: async (_parent, report) => {
      if (report.beforeRun?.()) effects += 1;
      else throw new Error('expired');
      return true;
    },
  });
  await restored.recoverPending();
  expect(effects).toBe(0);
  expect(send).not.toHaveBeenCalled();
  expect(onUndelivered).toHaveBeenCalled();
  expect(reopened.select().from(roomReportOutbox).get()?.state).toBe('declined');
  release(false);
  await oldWork;
});

it.each(['source', 'membership'])('refuses a replaced %s while waiting', async (changed) => {
  const { db, open, deps, send } = fixture();
  makeSeat(db);
  const initial = new ChatReportBack({ ...deps, outbox: new HandoffOutboxStore(db) });
  await initial.onTurnEnd('child', null, { to: Date.parse(AT) });
  if (changed === 'membership')
    db.update(roomMembers)
      .set({ joinedAt: '2026-11-20T12:01:00.000Z' })
      .where(eq(roomMembers.roomId, 'team'))
      .run();
  if (changed === 'source')
    db.update(sessionMetadata)
      .set({ createdAt: '2026-11-20T12:01:00.000Z' })
      .where(eq(sessionMetadata.sessionId, 'child'))
      .run();
  const onUndelivered = vi.fn();
  const reopened = open();
  await new ChatReportBack({
    ...deps,
    outbox: new HandoffOutboxStore(reopened),
    onUndelivered,
  }).recoverPending();
  expect(send).not.toHaveBeenCalled();
  expect(onUndelivered).toHaveBeenCalledOnce();
  expect(reopened.select().from(roomReportOutbox).get()?.state).toBe('quarantined');
});

it('retries a safe preclaim refusal without renewing the seat deadline', async () => {
  const { db, deps } = fixture();
  makeSeat(db);
  const delays: number[] = [];
  const deadlines: (number | undefined)[] = [];
  let attempts = 0;
  const reporter = new ChatReportBack({
    ...deps,
    holdsBackgroundWork: async () => false,
    delay: async (ms) => {
      delays.push(ms);
    },
    outbox: new HandoffOutboxStore(db),
    toRoomSeat: async (_parent, report) => {
      deadlines.push(report.waitDeadlineAt);
      attempts += 1;
      if (attempts === 1) throw new Error('placement unavailable before beforeRun');
      expect(report.beforeRun?.()).toBe(true);
      return true;
    },
  });
  await reporter.onTurnEnd('child', null, { to: Date.parse(AT) });
  expect(attempts).toBe(2);
  expect(delays).toContain(5000);
  expect(deadlines[1]).toBe(deadlines[0]);
  expect(db.select().from(roomReportOutbox).get()?.state).toBe('delivered');
});

it('stops a producer suspended in the settle before storage closes', async () => {
  const { db, deps } = fixture();
  let settle!: () => void;
  const onUndelivered = vi.fn();
  const reporter = new ChatReportBack({
    ...deps,
    outbox: new HandoffOutboxStore(db),
    onUndelivered,
    delay: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  });
  const work = reporter.onWaiting('child', { key: 'ask', what: 'Continue?' });
  reporter.stop();
  db.$client.close();
  settle();
  await expect(work).resolves.toBe(false);
  expect(onUndelivered).not.toHaveBeenCalled();
});

it('keeps the oldest deferred clock, words and marks when later clean turns also wait', async () => {
  const { db, open, deps, send } = fixture();
  let now = Date.parse(AT);
  let marks: TurnMarks = MARKS;
  const original = new ChatReportBack({
    ...deps,
    now: () => now,
    marksOfTurn: () => marks,
    outbox: new HandoffOutboxStore(db),
  });
  await original.onTurnEnd('child', null, { from: now - 1000, to: now });
  now += 10_000;
  marks = {};
  await original.onTurnEnd('child', null, { from: now, to: now + 1000 });
  original.stop();
  now = Date.parse(AT) + 15 * 60_000;
  const reopened = open();
  const restored = new ChatReportBack({
    ...deps,
    now: () => now,
    marksOfTurn: () => ({}),
    outbox: new HandoffOutboxStore(reopened),
  });
  await restored.recoverPending();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[0].marksAtTurnEnd).toEqual(MARKS);
  expect(send.mock.calls[0]?.[1].message).toContain('background work still running');
  expect(send.mock.calls[0]?.[1].message).toContain('The waiting work is ready.');
  const states = reopened
    .select()
    .from(roomReportOutbox)
    .all()
    .map((row) => row.state);
  expect(states).toEqual(expect.arrayContaining(['superseded', 'delivered']));
});

it('does not duplicate a private report whose send may have started before restart', async () => {
  const { db, open, deps, send } = fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  send.mockImplementation(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { messageId: 'accepted', chatId: 'parent', status: 'queued' };
  });
  const initial = new ChatReportBack({
    ...deps,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(db),
  });
  const old = initial.onTurnEnd('child', null, { to: Date.parse(AT) });
  await started;
  initial.stop();
  const onUndelivered = vi.fn();
  const reopened = open();
  await new ChatReportBack({
    ...deps,
    outbox: new HandoffOutboxStore(reopened),
    onUndelivered,
  }).recoverPending();
  expect(send).toHaveBeenCalledOnce();
  expect(onUndelivered).toHaveBeenCalledWith(expect.objectContaining({ deliveryUnknown: true }));
  expect(reopened.select().from(roomReportOutbox).get()?.state).toBe('interrupted');
  release();
  await old;
});

it('restores an unrelated deferred report while an older seat report remains busy', async () => {
  const { db, open, deps, send } = fixture();
  makeSeat(db);
  for (const sessionId of ['other-child', 'other-parent'])
    db.insert(sessionMetadata)
      .values({
        sessionId,
        runtime: 'claude-code',
        agentPath: PATH,
        launchOrigin: 'interactive',
        createdAt: AT,
      })
      .run();
  db.insert(sessionStartedBy)
    .values({
      sessionId: 'other-child',
      kind: 'chat',
      startedBySessionId: 'other-parent',
      reportBack: true,
      createdAt: AT,
    })
    .run();
  const reportTargetOf = (id: string) => ({
    parentSessionId: id === 'child' ? 'parent' : 'other-parent',
  });
  let oldRelease!: (taken: boolean) => void;
  let oldOffered!: () => void;
  const oldOffer = new Promise<void>((resolve) => {
    oldOffered = resolve;
  });
  const initial = new ChatReportBack({
    ...deps,
    reportTargetOf,
    holdsBackgroundWork: async (id) => id === 'other-child',
    outbox: new HandoffOutboxStore(db),
    toRoomSeat: async () => {
      oldOffered();
      return new Promise((resolve) => {
        oldRelease = resolve;
      });
    },
  });
  const old = initial.onTurnEnd('child', null, { to: Date.parse(AT) });
  await oldOffer;
  await initial.onTurnEnd('other-child', null, { to: Date.parse(AT) });
  initial.stop();
  let freshRelease!: () => void;
  let freshOffered!: () => void;
  const freshOffer = new Promise<void>((resolve) => {
    freshOffered = resolve;
  });
  const restored = new ChatReportBack({
    ...deps,
    reportTargetOf,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(open()),
    toRoomSeat: async (parent, report) => {
      if (parent === 'other-parent') return false;
      freshOffered();
      return new Promise((resolve) => {
        freshRelease = () => resolve(report.beforeRun?.() ?? false);
      });
    },
  });
  const recovery = restored.recoverPending();
  try {
    await freshOffer;
    for (let step = 0; step < 50; step += 1) await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1].to).toBe('other-parent');
  } finally {
    freshRelease();
    oldRelease(false);
    await recovery;
    await old;
  }
});

it('keeps the original collecting clock when restart interrupts the first holding probe', async () => {
  const { db, open, deps, send } = fixture();
  let release!: (held: boolean) => void;
  const probe = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const original = new ChatReportBack({
    ...deps,
    holdsBackgroundWork: () => probe,
    outbox: new HandoffOutboxStore(db),
  });
  const old = original.onTurnEnd('child', null, { to: Date.parse(AT) });
  expect(db.select().from(roomReportOutbox).get()?.state).toBe('collecting');
  original.stop();
  const reopened = open();
  const restored = new ChatReportBack({
    ...deps,
    now: () => Date.parse(AT) + 15 * 60_000,
    outbox: new HandoffOutboxStore(reopened),
  });
  try {
    await restored.recoverPending();
    const row = reopened.select().from(roomReportOutbox).get()!;
    expect(JSON.parse(row.payloadJson).since).toBe(Date.parse(AT));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1].message).toContain('background work still running');
  } finally {
    release(true);
    await old;
  }
});

it('commits the terminal notice and its outbox acknowledgement together, even before a delayed restart', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AT));
  const { db, open, deps, send } = fixture();
  send.mockRejectedValue(new Error('delivery outcome unknown'));
  const service = new NotificationService(new NotificationStore(db));
  const onUndelivered = async (report: Parameters<typeof notifyUndeliveredReport>[0]) => {
    await notifyUndeliveredReport(report, {
      titleOf: async () => 'River work',
      agentPathOf: async () => PATH,
      agentIdOf: () => 'river',
      notify: service.notify.bind(service),
    });
    throw new Error('process stopped after notification committed, before caller acknowledgement');
  };
  const original = new ChatReportBack({
    ...deps,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(db),
    onUndelivered,
  });
  await original.onTurnEnd('child', null, { to: Date.parse(AT) });
  expect(db.select().from(notifications).all()).toHaveLength(1);
  expect(db.select().from(roomReportOutbox).get()?.noticeState).toBe('accepted');
  original.stop();
  vi.advanceTimersByTime(6 * 60_000);
  const reopened = open();
  await new ChatReportBack({
    ...deps,
    outbox: new HandoffOutboxStore(reopened),
    onUndelivered,
  }).recoverPending();
  expect(reopened.select().from(notifications).all()).toHaveLength(1);
});

it('rolls back a notification when its durable report acknowledgement cannot commit', async () => {
  const { db, deps, send } = fixture();
  send.mockRejectedValue(new Error('delivery outcome unknown'));
  db.$client.exec(
    "CREATE TRIGGER report_receipt_fault BEFORE UPDATE OF notice_state ON room_report_outbox WHEN NEW.notice_state = 'accepted' BEGIN SELECT RAISE(ABORT, 'owned receipt fault'); END"
  );
  const service = new NotificationService(new NotificationStore(db));
  const reporter = new ChatReportBack({
    ...deps,
    holdsBackgroundWork: async () => false,
    outbox: new HandoffOutboxStore(db),
    onUndelivered: (report) =>
      notifyUndeliveredReport(report, {
        titleOf: async () => 'River work',
        agentPathOf: async () => PATH,
        agentIdOf: () => 'river',
        notify: service.notify.bind(service),
      }),
  });
  await reporter.onTurnEnd('child', null, { to: Date.parse(AT) });
  expect(db.select().from(notifications).all()).toHaveLength(0);
  expect(db.select().from(roomReportOutbox).get()?.noticeState).toBe('ready');
  db.$client.exec('DROP TRIGGER report_receipt_fault');
  await reporter.recoverPending();
  expect(db.select().from(notifications).all()).toHaveLength(1);
  expect(db.select().from(roomReportOutbox).get()?.noticeState).toBe('accepted');
});
