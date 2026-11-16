/**
 * The due timers (spec `heartbeats` §12, DOR-3034): one per open to-do, waiting for the next
 * moment its plan names (start, check-in, missed), late counts as due now, and far-off dates are
 * waited for in hops because one `setTimeout` cannot wait past about 24.8 days. After each wake the
 * service saves it and schedules again; these tests do the same by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TodoDueTimers, type TimedTodo } from '../timing/todo-due-timers.js';
import { TODO_DEFAULT_LEAD_MS, TODO_GRACE_MS } from '../timing/todo-wake-plan.js';

const START = Date.parse('2026-10-10T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe('TodoDueTimers', () => {
  let onDue: ReturnType<typeof vi.fn<(id: string) => void>>;
  let onCheckin: ReturnType<typeof vi.fn<(id: string) => void>>;
  let onMissed: ReturnType<typeof vi.fn<(id: string) => void>>;
  let timers: TodoDueTimers;

  /** A to-do due at `at`, with what already happened. */
  const todo = (at: number, over: Partial<TimedTodo> = {}): TimedTodo => ({
    id: 'c1',
    dueAt: new Date(at).toISOString(),
    estimateMinutes: null,
    dueSetAt: null,
    dueNotifiedAt: null,
    checkinNotifiedAt: null,
    ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    onDue = vi.fn<(id: string) => void>();
    onCheckin = vi.fn<(id: string) => void>();
    onMissed = vi.fn<(id: string) => void>();
    timers = new TodoDueTimers({ now: () => Date.now(), onDue, onCheckin, onMissed });
  });

  afterEach(() => {
    timers.stop();
    vi.useRealTimers();
  });

  it('waits for a start 40 days out without firing early, an hour before the due time', () => {
    const due = START + 40 * DAY;
    timers.schedule(todo(due));
    vi.advanceTimersByTime(due - TODO_DEFAULT_LEAD_MS - START - 1);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledWith('c1');
  });

  it('wakes to start before a guessed day of work, checks in partway, and misses after grace', () => {
    const due = START + 2 * DAY;
    const plan = todo(due, { estimateMinutes: 480 });
    timers.schedule(plan);
    // A day of work (8 hours) plus a quarter of it as buffer (2 hours): 10 hours before.
    const startAt = due - 10 * HOUR;
    vi.advanceTimersByTime(startAt - START);
    expect(onDue).toHaveBeenCalledTimes(1);
    const woken = { ...plan, dueNotifiedAt: new Date(startAt).toISOString() };
    timers.schedule(woken);
    vi.advanceTimersByTime(5 * HOUR - 1);
    expect(onCheckin).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onCheckin).toHaveBeenCalledTimes(1);
    timers.schedule({ ...woken, checkinNotifiedAt: new Date(Date.now()).toISOString() });
    vi.advanceTimersByTime(5 * HOUR + TODO_GRACE_MS - 1);
    expect(onMissed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onMissed).toHaveBeenCalledWith('c1');
  });

  it('clears a timer so nothing fires', () => {
    timers.schedule(todo(START + 2 * HOUR));
    expect(timers.size).toBe(1);
    timers.clear('c1');
    expect(timers.size).toBe(0);
    vi.advanceTimersByTime(DAY);
    expect(onDue).not.toHaveBeenCalled();
    expect(onMissed).not.toHaveBeenCalled();
  });

  it('wakes a promise found long overdue and never woken now, never "already missed"', () => {
    timers.rebuild([todo(START - 5 * HOUR)]);
    vi.advanceTimersByTime(0);
    expect(onDue).toHaveBeenCalledWith('c1');
    expect(onMissed).not.toHaveBeenCalled();
  });

  it('runs the grace of a late wake from that wake, and owes no check-in past the due time', () => {
    const wokeAt = START - 5 * MINUTE;
    timers.rebuild([
      todo(START - HOUR, { estimateMinutes: 60, dueNotifiedAt: new Date(wokeAt).toISOString() }),
    ]);
    vi.advanceTimersByTime(TODO_GRACE_MS - 5 * MINUTE - 1);
    expect(onMissed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onMissed).toHaveBeenCalledTimes(1);
    expect(onCheckin).not.toHaveBeenCalled();
  });

  it('fires a start that a sleeping computer made late as soon as the timer runs', () => {
    let slept = 0;
    const late = new TodoDueTimers({ now: () => Date.now() + slept, onDue, onCheckin, onMissed });
    late.schedule(todo(START + 2 * HOUR));
    slept = 3 * HOUR;
    vi.advanceTimersByTime(HOUR);
    expect(onDue).toHaveBeenCalledTimes(1);
    late.stop();
  });
});
