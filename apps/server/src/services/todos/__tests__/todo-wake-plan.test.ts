/**
 * When an agent is woken about a dated to-do and when it is missed (DOR-3034): start before the
 * due time by the guess plus a buffer, check in partway, missed at the due time plus a grace, and a
 * late wake keeps its grace.
 */
import { describe, expect, it } from 'vitest';
import {
  TODO_DEFAULT_LEAD_MS,
  TODO_GRACE_MS,
  nextWakeStep,
  wakeMoments,
} from '../timing/todo-wake-plan.js';

const DUE = '2026-11-20T17:00:00.000Z';
const due = Date.parse(DUE);
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const plan = (over: Partial<Parameters<typeof wakeMoments>[0]> = {}) => ({
  dueAt: DUE,
  estimateMinutes: null,
  dueSetAt: null,
  dueNotifiedAt: null,
  checkinNotifiedAt: null,
  ...over,
});

describe('wakeMoments', () => {
  it('wakes an hour before with no guess, with no check-in, and misses after the grace', () => {
    expect(wakeMoments(plan())).toEqual({
      startAt: due - TODO_DEFAULT_LEAD_MS,
      checkinAt: null,
      missedAt: due + TODO_GRACE_MS,
    });
  });

  it('starts an hour of work 75 minutes before (15 minutes of buffer), checking in halfway', () => {
    const { startAt, checkinAt } = wakeMoments(plan({ estimateMinutes: 60 }));
    expect(startAt).toBe(due - 75 * MINUTE);
    expect(checkinAt).toBe(due - 37.5 * MINUTE);
  });

  it('starts half a day of work five hours before', () => {
    expect(wakeMoments(plan({ estimateMinutes: 240 })).startAt).toBe(due - 5 * HOUR);
  });

  it('wakes a date set inside its own lead at the due time, with no check-in', () => {
    const setAt = new Date(due - 30 * MINUTE).toISOString();
    expect(wakeMoments(plan({ estimateMinutes: 60, dueSetAt: setAt }))).toMatchObject({
      startAt: due,
      checkinAt: null,
    });
    expect(wakeMoments(plan({ dueSetAt: new Date(due - 3 * HOUR).toISOString() })).startAt).toBe(
      due - TODO_DEFAULT_LEAD_MS
    );
  });

  it('gives a promise woken late its whole grace from that wake', () => {
    const woke = due + 2 * HOUR;
    expect(wakeMoments(plan({ dueNotifiedAt: new Date(woke).toISOString() })).missedAt).toBe(
      woke + TODO_GRACE_MS
    );
  });
});

describe('nextWakeStep', () => {
  it('waits for the start, then the check-in, then the miss', () => {
    const now = due - 10 * HOUR;
    expect(nextWakeStep(plan({ estimateMinutes: 60 }), now)?.phase).toBe('due');
    const woken = plan({
      estimateMinutes: 60,
      dueNotifiedAt: new Date(due - 75 * MINUTE).toISOString(),
    });
    expect(nextWakeStep(woken, now)?.phase).toBe('checkin');
    expect(
      nextWakeStep({ ...woken, checkinNotifiedAt: new Date(due - HOUR).toISOString() }, now)?.phase
    ).toBe('missed');
  });

  it('owes no check-in once the due time has come', () => {
    const woken = plan({
      estimateMinutes: 60,
      dueNotifiedAt: new Date(due - 75 * MINUTE).toISOString(),
    });
    expect(nextWakeStep(woken, due)?.phase).toBe('missed');
  });

  it('owes no check-in when the start wake came after it', () => {
    const late = plan({
      estimateMinutes: 60,
      dueNotifiedAt: new Date(due - 10 * MINUTE).toISOString(),
    });
    expect(nextWakeStep(late, due - 20 * MINUTE)?.phase).toBe('missed');
  });

  it('gives nothing for a date that does not parse', () => {
    expect(nextWakeStep(plan({ dueAt: 'not a date' }), due)).toBeNull();
  });
});
