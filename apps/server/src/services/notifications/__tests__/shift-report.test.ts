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
  shiftReportDateKey,
  SHIFT_REPORT_WINDOW_MS,
  type ShiftReportCounts,
} from '../shift-report.js';
import { watchShiftReport } from '../emitters/shift-report.js';

/** Let a fire-and-forget async chain (the shift-report's own `notify()` call) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** A turn-completed payload, varied per call so nothing dedupes by accident. */
function turn(sessionId: string) {
  return { sessionId, sessionLabel: 'acme', completedAt: new Date().toISOString() };
}

/** A scheduled-run payload, varied per call so nothing dedupes by accident. */
function run(id: string, status: 'completed' | 'failed' = 'completed') {
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

  it('is yesterday’s 04:00 for somebody still up at 01:00', () => {
    const lateNight = new Date(2026, 7, 20, 1, 0).getTime();
    expect(new Date(shiftReportBoundary(lateNight)).getDate()).toBe(19);
    expect(new Date(shiftReportBoundary(lateNight)).getHours()).toBe(4);
  });

  it('sits exactly on 04:00 without rolling back a day', () => {
    const fourAm = new Date(2026, 7, 20, 4, 0, 0).getTime();
    expect(shiftReportBoundary(fourAm)).toBe(fourAm);
  });
});

describe('shiftReportDateKey', () => {
  it('formats a local instant as YYYY-MM-DD', () => {
    expect(shiftReportDateKey(new Date(2026, 7, 9, 4, 0).getTime())).toBe('2026-08-09');
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

  it('reports null on an empty window — nothing to invent a moment about', () => {
    expect(composeShiftReport(store, Date.now())).toBeNull();
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

    expect(composeShiftReport(store, Date.now())).toEqual({
      turnsCompleted: 2,
      runsSucceeded: 1,
      runsFailed: 1,
      asksAnswered: 1,
      asksExpired: 1,
      messages: 2,
    } satisfies ShiftReportCounts);
  });

  it('excludes activity older than the trailing 24-hour window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0));
    await service.notify('turn.completed', turn('too-old'));

    // Exactly at the edge: one millisecond older than the window is out.
    vi.setSystemTime(
      new Date(new Date(2026, 7, 19, 9, 0, 0).getTime() + SHIFT_REPORT_WINDOW_MS + 1)
    );
    expect(composeShiftReport(store, Date.now())).toBeNull();

    await service.notify('turn.completed', turn('fresh'));
    expect(composeShiftReport(store, Date.now())).toEqual(
      expect.objectContaining({ turnsCompleted: 1 })
    );
  });

  it('keeps report.daily out of every bucket, including a still-in-window report from yesterday', async () => {
    // Reachable only because the window trails 24h from composition rather
    // than resetting at the local day's 4am boundary: yesterday's own report,
    // raised well inside today's 24h lookback, must not inflate today's.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 19, 9, 30, 0));
    await service.notify('report.daily', {
      date: '2026-08-19',
      title: 'While you were away: 2 turns finished',
      summary: '2 turns finished in the last day.',
    });
    await service.notify('dm.received', dm('room-1', 1));

    vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0));
    expect(composeShiftReport(store, Date.now())).toEqual({
      turnsCompleted: 0,
      runsSucceeded: 0,
      runsFailed: 0,
      asksAnswered: 0,
      asksExpired: 0,
      messages: 1,
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
        const counts = composeShiftReport(store, Date.now());

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

    it('gives two consecutive days different cards', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(2026, 7, 19, 10, 0, 0));
        await service.notify('turn.completed', turn('day1-a'));
        await service.notify('turn.completed', turn('day1-b'));

        vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0));
        const day1 = composeShiftReport(store, Date.now());

        vi.setSystemTime(new Date(2026, 7, 20, 10, 0, 0));
        await service.notify('turn.completed', turn('day2-a'));

        vi.setSystemTime(new Date(2026, 7, 21, 9, 0, 0));
        const day2 = composeShiftReport(store, Date.now());

        expect(day1).toEqual(expect.objectContaining({ turnsCompleted: 2 }));
        expect(day2).toEqual(expect.objectContaining({ turnsCompleted: 1 }));
        expect(day1).not.toEqual(day2);
      } finally {
        vi.useRealTimers();
      }
    });
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

  it('never lets a large positive count push a failure out of the headline', () => {
    const counts: ShiftReportCounts = {
      turnsCompleted: 40,
      runsSucceeded: 0,
      runsFailed: 1,
      asksAnswered: 0,
      asksExpired: 0,
      messages: 0,
    };
    expect(buildShiftReportText(counts).title).toBe(
      'While you were away: 1 run needs a look, 40 turns finished'
    );
  });

  it('pluralizes singular counts correctly', () => {
    const counts: ShiftReportCounts = {
      turnsCompleted: 1,
      runsSucceeded: 0,
      runsFailed: 2,
      asksAnswered: 0,
      asksExpired: 0,
      messages: 0,
    };
    expect(buildShiftReportText(counts).summary).toBe(
      '1 turn finished, 2 runs need a look in the last day.'
    );
  });

  it('says "Ask" in plain words — a question, not the product term', () => {
    const counts: ShiftReportCounts = {
      turnsCompleted: 0,
      runsSucceeded: 0,
      runsFailed: 0,
      asksAnswered: 1,
      asksExpired: 1,
      messages: 0,
    };
    const { summary } = buildShiftReportText(counts);
    expect(summary).toBe('1 question answered, 1 question went unanswered in the last day.');
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
    unsubscribe = watchShiftReport(store);

    await service.notify('turn.completed', turn('s1'));
    await flush();

    expect(reports()).toHaveLength(1);
    expect(reports()[0].title).toContain('turn finished');

    // More activity later the same day must not add a second row.
    await service.notify('turn.completed', turn('s2'));
    await flush();
    expect(reports()).toHaveLength(1);
  });

  it('keeps trying within the same day until there is something to say', async () => {
    // The first broadcast this test fires is `report.daily` itself — nothing
    // else has happened yet — so the naive "checked once, done for today"
    // design would never raise a report even once real activity arrives.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0));
    unsubscribe = watchShiftReport(store);

    // Kinds this report does not count still trigger a check, and must not
    // burn the day's one attempt on an empty result.
    await service.notify('agent.unreachable', { agentId: 'a1', agentName: 'Ana' });
    await flush();
    expect(reports()).toHaveLength(0);

    await service.notify('turn.completed', turn('s1'));
    await flush();
    expect(reports()).toHaveLength(1);
  });

  it('raises a second report once the next local day starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0));
    unsubscribe = watchShiftReport(store);
    await service.notify('turn.completed', turn('s1'));
    await flush();
    expect(reports()).toHaveLength(1);

    vi.setSystemTime(new Date(2026, 7, 21, 9, 0, 0));
    await service.notify('turn.completed', turn('s2'));
    await flush();
    expect(reports()).toHaveLength(2);
  });

  it('latches "reported today" on a dedupe hit too, so a restart stops rescanning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0));

    // The row already exists — as if an earlier process raised it and then
    // restarted, losing its in-memory `reportedFor`.
    await service.notify('report.daily', {
      date: '2026-08-20',
      title: 'While you were away: 1 turn finished',
      summary: '1 turn finished in the last day.',
    });
    expect(reports()).toHaveLength(1);

    unsubscribe = watchShiftReport(store);
    const scanSpy = vi.spyOn(store, 'countActivitySince');

    await service.notify('turn.completed', turn('s1'));
    await flush();
    await service.notify('turn.completed', turn('s2'));
    await flush();
    await service.notify('turn.completed', turn('s3'));
    await flush();

    // Exactly one scan: the first notification's check found today's row
    // already there (deduped) and latched `reportedFor`, so the second and
    // third notifications never asked the store anything at all.
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(reports()).toHaveLength(1);
  });
});
