/**
 * A session timer dies with its process (DOR-2717), and when DorkOS is what
 * ended the process, the agent's next turn is told (DOR-3755).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { endSessionTimers } from '../session-timers.js';
import {
  formatTurnCutoff,
  resetTurnCutoffs,
  takeTurnCutoff,
} from '../../../../../session/turn-cutoff/turn-cutoff.js';

const AT = Date.UTC(2026, 10, 1, 20, 48, 7);

afterEach(() => resetTurnCutoffs());

describe('endSessionTimers', () => {
  it.each(['reaped', 'cold'] as const)(
    'owes a note when DorkOS ends the process (%s) with timers pending',
    (to) => {
      const session = { pendingTimers: 1 };
      endSessionTimers('chat-1', session, to, to === 'cold' ? 'evict' : undefined, AT);

      expect(session.pendingTimers).toBeUndefined();
      expect(takeTurnCutoff('chat-1')).toEqual({ timersStopped: 1, at: AT });
    }
  );

  it('owes nothing when no timer was pending', () => {
    const session = { pendingTimers: 0 };
    endSessionTimers('chat-1', session, 'reaped', undefined, AT);

    expect(takeTurnCutoff('chat-1')).toBeNull();
  });

  it('owes nothing at a shutdown: the next boot wakes the chat instead', () => {
    const session = { pendingTimers: 2 };
    endSessionTimers('chat-1', session, 'cold', 'shutdown', AT);

    expect(session.pendingTimers).toBeUndefined();
    expect(takeTurnCutoff('chat-1')).toBeNull();
  });

  it('owes nothing for a crash, which DorkOS did not cause', () => {
    const session = { pendingTimers: 2 };
    endSessionTimers('chat-1', session, 'crashed', undefined, AT);

    expect(session.pendingTimers).toBeUndefined();
    expect(takeTurnCutoff('chat-1')).toBeNull();
  });

  it('leaves the timers alone on a move that keeps the process', () => {
    const session = { pendingTimers: 1 };
    endSessionTimers('chat-1', session, 'warm', undefined, AT);

    expect(session.pendingTimers).toBe(1);
    expect(takeTurnCutoff('chat-1')).toBeNull();
  });
});

describe('the timers note', () => {
  it('says when the process ended and that a timer due since did not fire', () => {
    const text = formatTurnCutoff({ timersStopped: 2, at: AT });

    expect(text).toContain('2026-11-01T20:48:07.000Z');
    expect(text).toContain('2 session timers you set (CronCreate, ScheduleWakeup or /loop) were');
    expect(text).toContain('a timer due before this message did not fire');
    // Never claims every timer is gone: Claude Code may set one not yet due up
    // again when it resumes.
    expect(text).not.toMatch(/will not fire|are gone/);
  });

  it('speaks of one timer in the singular', () => {
    expect(formatTurnCutoff({ timersStopped: 1, at: AT })).toContain(
      'a session timer you set (CronCreate, ScheduleWakeup or /loop) was still pending'
    );
  });
});
