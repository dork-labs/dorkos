/**
 * A session timer dies with its process (DOR-2717), and when DorkOS's own
 * upkeep ended the process, the agent's next turn is told (DOR-3755).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { endSessionTimers } from '../session-timers.js';
import {
  noteTurnCutoff,
  resetTurnCutoffs,
  takeTurnCutoff,
} from '../../../../../session/turn-cutoff/turn-cutoff.js';
import {
  forgetTimersStopped,
  formatTimersStopped,
  resetTimersStopped,
  takeTimersStopped,
} from '../../../../../session/turn-cutoff/timers-stopped.js';

const AT = Date.UTC(2026, 10, 1, 20, 48, 7);

afterEach(() => {
  resetTurnCutoffs();
  resetTimersStopped();
});

describe('endSessionTimers', () => {
  it('owes a note when the idle timer or the warm ceiling reaps a process with timers pending', () => {
    const session = { pendingTimers: 1 };
    endSessionTimers('chat-1', session, 'reaped', undefined, AT);

    expect(session.pendingTimers).toBeUndefined();
    expect(takeTimersStopped('chat-1')).toEqual({ timers: 1, at: AT });
  });

  it('owes a note when a record sweep tears the process down', () => {
    endSessionTimers('chat-1', { pendingTimers: 2 }, 'cold', 'sweep', AT);

    expect(takeTimersStopped('chat-1')).toEqual({ timers: 2, at: AT });
  });

  it.each([
    ['a shutdown, which the next boot wakes', 'shutdown'],
    ["a person's pause or a credits unlink", 'stop'],
    ['a relaunch for a turn that runs at once', 'replace'],
    ['a teardown that names no reason', 'evict'],
  ] as const)('owes nothing for %s', (_what, reason) => {
    const session = { pendingTimers: 2 };
    endSessionTimers('chat-1', session, 'cold', reason, AT);

    expect(session.pendingTimers).toBeUndefined();
    expect(takeTimersStopped('chat-1')).toBeNull();
  });

  it('owes nothing for a crash, which DorkOS did not cause', () => {
    const session = { pendingTimers: 2 };
    endSessionTimers('chat-1', session, 'crashed', undefined, AT);

    expect(session.pendingTimers).toBeUndefined();
    expect(takeTimersStopped('chat-1')).toBeNull();
  });

  it('owes nothing when no timer was pending', () => {
    endSessionTimers('chat-1', { pendingTimers: 0 }, 'reaped', undefined, AT);

    expect(takeTimersStopped('chat-1')).toBeNull();
  });

  it('leaves the timers alone on a move that keeps the process', () => {
    const session = { pendingTimers: 1 };
    endSessionTimers('chat-1', session, 'warm', undefined, AT);

    expect(session.pendingTimers).toBe(1);
    expect(takeTimersStopped('chat-1')).toBeNull();
  });

  // The stall guard interrupts a quiet turn, the Stop hook does not run after
  // an interrupt, so the count from the turn before stays, and a reclaim then
  // takes the process. Both notes must ride the next turn.
  it('keeps a stall cutoff owed beside it: both survive', () => {
    noteTurnCutoff('chat-1', { windowMs: 600_000, neverStarted: false });
    endSessionTimers('chat-1', { pendingTimers: 1 }, 'reaped', undefined, AT);

    expect(takeTurnCutoff('chat-1')).toEqual({ windowMs: 600_000, neverStarted: false });
    expect(takeTimersStopped('chat-1')).toEqual({ timers: 1, at: AT });
  });

  it('keeps a stop by another chat owed beside it: both survive', () => {
    noteTurnCutoff('chat-1', { stoppedBy: 'chat', via: 'stop' });
    endSessionTimers('chat-1', { pendingTimers: 3 }, 'cold', 'sweep', AT);

    expect(takeTurnCutoff('chat-1')).toEqual({ stoppedBy: 'chat', via: 'stop' });
    expect(takeTimersStopped('chat-1')).toEqual({ timers: 3, at: AT });
  });

  it('forgets the note of a session that is going away', () => {
    endSessionTimers('chat-1', { pendingTimers: 1 }, 'reaped', undefined, AT);
    forgetTimersStopped('chat-1');

    expect(takeTimersStopped('chat-1')).toBeNull();
  });
});

describe('the timers note', () => {
  it('says the count is from the last turn end, when the process ended, and what did not fire', () => {
    const text = formatTimersStopped({ timers: 2, at: AT });

    expect(text).toContain(
      '2 session timers you set (CronCreate, ScheduleWakeup or /loop) were pending at your last turn end.'
    );
    expect(text).toContain('2026-11-01T20:48:07.000Z');
    expect(text).toContain('a timer due before this message did not fire');
    // Never claims every timer is gone: Claude Code may set one not yet due up
    // again when it resumes.
    expect(text).not.toMatch(/will not fire|are gone/);
  });

  it('speaks of one timer in the singular', () => {
    expect(formatTimersStopped({ timers: 1, at: AT })).toContain(
      'A session timer you set (CronCreate, ScheduleWakeup or /loop) was pending at your last turn end.'
    );
  });
});
