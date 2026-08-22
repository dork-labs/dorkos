/**
 * The quiet state's forward look is derived, never invented (team-room-home
 * spec D3.6).
 *
 * Every assertion here reads its expectation out of the fixture. Nothing checks
 * for a hardcoded summary sentence, because a sentence this file could write
 * without a task to point at is exactly the fake recap the spec forbids.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '@dorkos/shared/types';
import { nextScheduledRun, forwardLookSentence } from '../lib/forward-look';

/** A scheduled task, overriding only what a test cares about. */
function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'morning-standup',
    displayName: 'Morning standup',
    description: null,
    prompt: 'Summarise yesterday',
    cron: '0 9 * * *',
    timezone: null,
    agentId: null,
    enabled: true,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'active',
    filePath: '/tasks/morning-standup.md',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    nextRuns: [],
    nextRun: null,
    ...overrides,
  };
}

/** 2026-08-08, 10:00 local. */
const NOW = new Date(2026, 7, 8, 10, 0, 0).getTime();

/** A local time on the day `dayOffset` days from {@link NOW}. */
function localRun(dayOffset: number, hour: number, minute = 0): string {
  return new Date(2026, 7, 8 + dayOffset, hour, minute, 0).toISOString();
}

describe('nextScheduledRun', () => {
  it('finds nothing when the tasks list has not loaded', () => {
    expect(nextScheduledRun(undefined, NOW)).toBeNull();
  });

  it('finds nothing when no task is scheduled', () => {
    expect(nextScheduledRun([buildTask()], NOW)).toBeNull();
  });

  it('takes the soonest future run, not the first in the list', () => {
    const later = buildTask({ id: 'later', name: 'nightly', nextRun: localRun(2, 3) });
    const sooner = buildTask({ id: 'sooner', name: 'standup', nextRun: localRun(1, 9) });

    expect(nextScheduledRun([later, sooner], NOW)?.at).toBe(sooner.nextRun);
  });

  it('ignores a run already in the past — a stale timestamp is not a plan', () => {
    const stale = buildTask({ nextRun: localRun(-1, 9) });
    expect(nextScheduledRun([stale], NOW)).toBeNull();
  });

  it('ignores tasks the scheduler will not fire', () => {
    const off = buildTask({ id: 'off', enabled: false, nextRun: localRun(1, 9) });
    const paused = buildTask({ id: 'paused', status: 'paused', nextRun: localRun(1, 9) });

    expect(nextScheduledRun([off, paused], NOW)).toBeNull();
  });

  it('names the run the way the Tasks list names it', () => {
    const named = buildTask({ displayName: 'Morning standup', nextRun: localRun(1, 9) });
    const unnamed = buildTask({
      id: 'raw',
      displayName: null,
      name: 'nightly-sweep',
      nextRun: localRun(3, 9),
    });

    expect(nextScheduledRun([named], NOW)?.name).toBe(named.displayName);
    expect(nextScheduledRun([unnamed], NOW)?.name).toBe(unnamed.name);
  });
});

describe('forwardLookSentence', () => {
  it('says nothing at all when there is no run to look forward to', () => {
    expect(forwardLookSentence(null, NOW)).toBeNull();
  });

  it('names tomorrow as tomorrow, with a real clock time', () => {
    const task = buildTask({ nextRun: localRun(1, 9, 30) });
    const run = nextScheduledRun([task], NOW);

    const line = forwardLookSentence(run, NOW);

    expect(line).toContain(task.displayName);
    expect(line).toContain('tomorrow');
    // A real reading off the fixture's own timestamp, in the reader's locale —
    // not a string this test made up.
    expect(line).toContain(
      new Date(task.nextRun!).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    );
  });

  it('says today for a run later the same day', () => {
    const run = nextScheduledRun([buildTask({ nextRun: localRun(0, 18) })], NOW);
    expect(forwardLookSentence(run, NOW)).toContain('today');
  });

  it('dates a run further out, because a weekday alone is not a time', () => {
    const task = buildTask({ nextRun: localRun(9, 9) });
    const run = nextScheduledRun([task], NOW);

    const line = forwardLookSentence(run, NOW);

    expect(line).not.toContain('today');
    expect(line).not.toContain('tomorrow');
    expect(line).toContain(
      new Date(task.nextRun!).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      })
    );
  });
});
