/**
 * The daily Shift Report: the 4am date-key boundary, the trailing-24h
 * composer, the copy, and the once-per-day trigger (spec
 * `notification-system`, task 5.2, DOR-1389).
 *
 * @module services/notifications/__tests__/shift-report
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { NotificationStore } from '../notification-store.js';
import { NotificationService, setNotificationService } from '../notification-service.js';
import {
  buildShiftReportText,
  composeShiftReport,
  shiftReportBoundary,
  type ShiftReportCounts,
  type ShiftReportOnboarding,
} from '../shift-report.js';
import { watchShiftReport } from '../emitters/shift-report.js';

/**
 * An install that finished setup long ago, so the install-age gate is open and
 * a case is about what it is named after. The gate's own cases are below.
 */
const SETTLED: ShiftReportOnboarding = { startedAt: '2026-01-01T09:00:00.000Z' };

/** Let a fire-and-forget async chain (the shift-report's own `notify()` call) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** A turn-completed payload, varied per call so nothing dedupes by accident. */
function turn(sessionId: string) {
  return { sessionId, sessionLabel: 'acme', completedAt: new Date().toISOString() };
}

/** A scheduled-run payload, varied per call so nothing dedupes by accident. */
function run(id: string, status: 'completed' | 'failed' | 'needs_attention' = 'completed') {
  return {
    runId: id,
    taskId: 't1',
    taskName: 'nightly',
    status,
    channelMessage: `message for ${id}`,
  };
}

/** A DM payload, varied per call so nothing dedupes by accident. */
function dm(roomId: string, entrySeq: number) {
  return { roomId, entryId: `${roomId}-${entrySeq}`, entrySeq, fromName: 'Ana', preview: 'hi' };
}

/** A mention payload, varied per call so nothing dedupes by accident. */
function mention(roomId: string, entrySeq: number) {
  return {
    roomId,
    entryId: `${roomId}-${entrySeq}`,
    entrySeq,
    roomName: 'general',
    fromName: 'Ana',
    preview: 'hi',
  };
}

describe('shiftReportBoundary', () => {
  it('is the most recent 04:00 local that has passed', () => {
    const morning = new Date(2026, 7, 20, 9, 15).getTime();
    expect(new Date(shiftReportBoundary(morning)).getHours()).toBe(4);
    expect(new Date(shiftReportBoundary(morning)).getDate()).toBe(20);
  });
});

describe('composeShiftReport', () => {
  let db: Db;
  let store: NotificationStore;
  let service: NotificationService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    store = new NotificationStore(db);
    service = new NotificationService(store);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a blocked run as one that needs a look, never as a success', async () => {
    // Before DOR-2101 this run was a `completed` notification, so the shift
    // report told a person their schedule had succeeded overnight when it had
    // read nothing at all. `runsFailed` is a shade broader than its name now;
    // that is the right side of the line to be imprecise on.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0));
    try {
      await service.notify('run.completed', run('r1'));
      await service.notify('run.completed', run('r2', 'needs_attention'));

      expect(composeShiftReport(store, Date.now(), SETTLED)).toMatchObject({
        runsSucceeded: 1,
        runsFailed: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts turns, runs by outcome, asks by outcome, and messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0));

    await service.notify('turn.completed', turn('s1'));
    await service.notify('turn.completed', turn('s2'));
    await service.notify('run.completed', run('r1'));
    await service.notify('run.completed', run('r2', 'failed'));
    await service.resolveStanding(
      'ask.pending',
      { sessionId: 's1', interactionId: 'i1', sessionLabel: 'acme', summary: 'q' },
      { outcome: 'answered' }
    );
    await service.resolveStanding(
      'ask.pending',
      { sessionId: 's2', interactionId: 'i2', sessionLabel: 'acme', summary: 'q' },
      { outcome: 'expired' }
    );
    await service.notify('dm.received', dm('room-1', 1));
    await service.notify('mention.received', mention('room-2', 1));

    expect(composeShiftReport(store, Date.now(), SETTLED)).toEqual({
      turnsCompleted: 2,
      runsSucceeded: 1,
      runsFailed: 1,
      asksAnswered: 1,
      asksExpired: 1,
      messages: 2,
    } satisfies ShiftReportCounts);
  });

  describe('the reviewer probe: an overnight shift plus an early run, opened at 9am', () => {
    it('counts everything since the day before, not just what triggered the check', async () => {
      vi.useFakeTimers();
      try {
        // 21:00 Aug 19 — the fleet starts a long evening.
        vi.setSystemTime(new Date(2026, 7, 19, 21, 0, 0));
        await service.notify('turn.completed', turn('s1'));
        await service.notify('turn.completed', turn('s2'));

        // 23:30 Aug 19 — still working.
        vi.setSystemTime(new Date(2026, 7, 19, 23, 30, 0));
        await service.notify('turn.completed', turn('s3'));

        // 02:00 Aug 20 — a deploy fails overnight, well before the day's 4am
        // boundary rolls over.
        vi.setSystemTime(new Date(2026, 7, 20, 2, 0, 0));
        await service.notify('run.completed', run('overnight-deploy', 'failed'));

        // 03:30 Aug 20 — the last turn before quiet.
        vi.setSystemTime(new Date(2026, 7, 20, 3, 30, 0));
        await service.notify('turn.completed', turn('s4'));

        // 05:30 Aug 20 — a scheduled run, AFTER the 4am boundary rolls. A
        // since-4am window would have shown only this one row.
        vi.setSystemTime(new Date(2026, 7, 20, 5, 30, 0));
        await service.notify('run.completed', run('morning-run'));

        // 09:00 Aug 20 — the operator opens Home, which is what triggers the
        // check. The window has to reach back through all of the above.
        vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0));
        const counts = composeShiftReport(store, Date.now(), SETTLED);

        expect(counts).toEqual({
          turnsCompleted: 4,
          runsSucceeded: 1,
          runsFailed: 1,
          asksAnswered: 0,
          asksExpired: 0,
          messages: 0,
        } satisfies ShiftReportCounts);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('the install-age gate (DOR-2845)', () => {
  let db: Db;
  let store: NotificationStore;
  let service: NotificationService;
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    store = new NotificationStore(db);
    service = new NotificationService(store);
    setNotificationService(service);
    vi.useFakeTimers();
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    setNotificationService(null);
    vi.useRealTimers();
  });

  /** Every stored `report.daily` row. */
  function reports() {
    return service.list({ limit: 25, unread: false, kind: ['report.daily'] }).notifications;
  }

  /** First-run timestamps for a setup started at `at`. */
  function setUpAt(at: Date): ShiftReportOnboarding {
    return { startedAt: at.toISOString(), completedAt: at.toISOString(), dismissedAt: null };
  }

  it('raises nothing on a fresh install’s setup turn, then reports the next morning', async () => {
    const onboarding = setUpAt(new Date(2026, 7, 20, 16, 0, 0));
    vi.setSystemTime(new Date(2026, 7, 20, 16, 1, 0));
    unsubscribe = watchShiftReport(store, () => onboarding);

    await service.notify('turn.completed', turn('onboarding'));
    await flush();
    await service.notify('turn.completed', turn('first-chat'));
    await flush();
    expect(reports()).toHaveLength(0);

    vi.setSystemTime(new Date(2026, 7, 21, 9, 0, 0));
    await service.notify('turn.completed', turn('next-morning'));
    await flush();
    expect(reports()).toHaveLength(1);
  });
});

describe('buildShiftReportText', () => {
  it('leads the headline with problems, then the most useful positive fact, and closes the body with the window', () => {
    const counts: ShiftReportCounts = {
      turnsCompleted: 0,
      runsSucceeded: 3,
      runsFailed: 1,
      asksAnswered: 0,
      asksExpired: 0,
      messages: 0,
    };
    const { title, summary } = buildShiftReportText(counts);
    expect(title).toBe('While you were away: 1 run needs a look, 3 runs finished');
    expect(summary).toBe('3 runs finished, 1 run needs a look in the last day.');
  });
});

describe('watchShiftReport', () => {
  let db: Db;
  let store: NotificationStore;
  let service: NotificationService;
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    store = new NotificationStore(db);
    service = new NotificationService(store);
    setNotificationService(service);
  });

  afterEach(() => {
    unsubscribe?.();
    setNotificationService(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Every stored `report.daily` row, in this test's own service. */
  function reports() {
    return service.list({ limit: 25, unread: false, kind: ['report.daily'] }).notifications;
  }

  it('raises the report on the day’s first activity, and not again the same day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0));
    unsubscribe = watchShiftReport(store, () => SETTLED);

    await service.notify('turn.completed', turn('s1'));
    await flush();

    expect(reports()).toHaveLength(1);
    expect(reports()[0].title).toContain('turn finished');

    // More activity later the same day must not add a second row.
    await service.notify('turn.completed', turn('s2'));
    await flush();
    expect(reports()).toHaveLength(1);
  });
});
