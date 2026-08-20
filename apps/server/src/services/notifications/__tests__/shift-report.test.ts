/**
 * The daily Shift Report: the 4am boundary, the composer, the copy, and the
 * once-per-day trigger (spec `notification-system`, task 5.2, DOR-1389).
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

  it('reports null on an empty day — nothing to invent a moment about', () => {
    expect(composeShiftReport(store, Date.now())).toBeNull();
  });

  it('counts turns, runs by outcome, asks by outcome, and messages', async () => {
    const since = Date.now();
    await service.notify('turn.completed', turn('s1'));
    await service.notify('turn.completed', turn('s2'));
    await service.notify('run.completed', {
      runId: 'r1',
      taskId: 't1',
      taskName: 'nightly',
      status: 'completed',
      channelMessage: 'x',
    });
    await service.notify('run.completed', {
      runId: 'r2',
      taskId: 't1',
      taskName: 'nightly',
      status: 'failed',
      channelMessage: 'x',
    });
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
    await service.notify('dm.received', {
      roomId: 'room-1',
      entryId: 'e1',
      fromName: 'Ana',
      preview: 'hi',
    });
    await service.notify('mention.received', {
      roomId: 'room-1',
      entryId: 'e2',
      roomName: 'general',
      fromName: 'Ana',
      preview: 'hi',
    });

    expect(composeShiftReport(store, since)).toEqual({
      turnsCompleted: 2,
      runsSucceeded: 1,
      runsFailed: 1,
      asksAnswered: 1,
      asksExpired: 1,
      messages: 2,
    } satisfies ShiftReportCounts);
  });

  it('does not count activity that happened before the boundary', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 7, 20, 3, 0, 0)); // 3am — still yesterday's shift
      await service.notify('turn.completed', turn('s1'));

      vi.setSystemTime(new Date(2026, 7, 20, 9, 0, 0)); // 9am — today's shift started
      const boundary = shiftReportBoundary(Date.now());
      expect(composeShiftReport(store, boundary)).toBeNull();

      await service.notify('turn.completed', turn('s2'));
      expect(composeShiftReport(store, boundary)).toEqual(
        expect.objectContaining({ turnsCompleted: 1 })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildShiftReportText', () => {
  it('leads with the two most useful facts and lists every fact in the body', () => {
    const counts: ShiftReportCounts = {
      turnsCompleted: 0,
      runsSucceeded: 3,
      runsFailed: 1,
      asksAnswered: 0,
      asksExpired: 0,
      messages: 0,
    };
    const { title, summary } = buildShiftReportText(counts);
    expect(title).toBe('While you were away: 3 runs finished, 1 run needs a look');
    expect(summary).toBe('3 runs finished. 1 run needs a look.');
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
    expect(buildShiftReportText(counts).summary).toBe('1 turn finished. 2 runs need a look.');
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
    expect(summary).toBe('1 question answered. 1 question went unanswered.');
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
});
