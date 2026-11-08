/**
 * The due timers (spec `heartbeats` §12): one per open to-do, the due
 * moment then the missed moment an hour after the wake, late counts as due now,
 * and far-off dates waited for in hops because one `setTimeout` cannot wait
 * past about 24.8 days.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TODO_MISSED_AFTER_MS, TodoDueTimers } from '../todo-due-timers.js';

const START = Date.parse('2026-10-10T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe('TodoDueTimers', () => {
  let onDue: ReturnType<typeof vi.fn<(id: string) => void>>;
  let onMissed: ReturnType<typeof vi.fn<(id: string) => void>>;
  let timers: TodoDueTimers;

  /** A to-do due at `at`, never woken. */
  const dueAt = (at: number, dueNotifiedAt: string | null = null) => ({
    id: 'c1',
    dueAt: new Date(at).toISOString(),
    dueNotifiedAt,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    onDue = vi.fn<(id: string) => void>();
    onMissed = vi.fn<(id: string) => void>();
    timers = new TodoDueTimers({ now: () => Date.now(), onDue, onMissed });
  });

  afterEach(() => {
    timers.stop();
    vi.useRealTimers();
  });

  it('waits for a due date 40 days out without firing early', () => {
    timers.schedule(dueAt(START + 40 * DAY));
    vi.advanceTimersByTime(40 * DAY - 1);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledWith('c1');
    vi.advanceTimersByTime(TODO_MISSED_AFTER_MS);
    expect(onMissed).toHaveBeenCalledWith('c1');
  });

  it('clears a timer so nothing fires', () => {
    timers.schedule(dueAt(START + 1000));
    expect(timers.size).toBe(1);
    timers.clear('c1');
    expect(timers.size).toBe(0);
    vi.advanceTimersByTime(DAY);
    expect(onDue).not.toHaveBeenCalled();
    expect(onMissed).not.toHaveBeenCalled();
  });

  it('treats a promise found long overdue and never woken as due now, with a fresh hour', () => {
    // Due five hours ago, as after a restart: never "already missed".
    timers.rebuild([dueAt(START - 5 * HOUR)]);
    expect(onDue).toHaveBeenCalledWith('c1');
    expect(onMissed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOUR - 1);
    expect(onMissed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onMissed).toHaveBeenCalledWith('c1');
  });

  it('never wakes again for a promise already woken; its hour runs from that wake', () => {
    const wokeAt = new Date(START - 20 * 60 * 1000).toISOString();
    timers.rebuild([dueAt(START - HOUR, wokeAt)]);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40 * 60 * 1000 - 1);
    expect(onMissed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onMissed).toHaveBeenCalledTimes(1);
  });

  it('gives a fresh hour from the wake when the due timer fires late (the computer slept)', () => {
    // A wall clock that jumps ahead while timers are frozen, as across sleep.
    let slept = 0;
    const late = new TodoDueTimers({ now: () => Date.now() + slept, onDue, onMissed });
    late.schedule(dueAt(START + HOUR));
    slept = 3 * HOUR;
    vi.advanceTimersByTime(HOUR);
    expect(onDue).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOUR - 1);
    expect(onMissed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onMissed).toHaveBeenCalledTimes(1);
    late.stop();
  });
});
