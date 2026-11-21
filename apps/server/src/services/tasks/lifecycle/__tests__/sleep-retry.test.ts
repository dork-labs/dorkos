/**
 * Only a scheduled run the computer's sleep broke is tried again (DOR-3286).
 * The whole retry, through the scheduler, is in `sleep-during-run.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TaskRun } from '@dorkos/shared/types';
import { sleptDuringRunError } from '@dorkos/shared/schedule-notice-copy';
import { retryAfterSleep } from '../sleep-retry.js';

const TASK = { name: 'nightly', cron: '0 3 * * *', timezone: 'UTC' };
const DUE = '2026-10-30T03:00:00.000Z';

function ended(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 'run-1',
    status: 'failed',
    trigger: 'scheduled',
    error: sleptDuringRunError(),
    scheduledFor: DUE,
    startedAt: DUE,
    ...overrides,
  } as TaskRun;
}

/** Retry `run` with the settle firing at `at`; answers whether it dispatched. */
function retried(
  run: TaskRun,
  at = Date.parse(DUE) + 20 * 60_000,
  task: Parameters<typeof retryAfterSleep>[2] = TASK
): boolean {
  const dispatch = vi.fn(async (_task: unknown, _fire: unknown) => {});
  retryAfterSleep(
    { getRun: () => run },
    { run: (fire) => void fire(new Date(at)) },
    task,
    run,
    dispatch
  );
  return dispatch.mock.calls.length > 0;
}

describe('retryAfterSleep', () => {
  it('retries a scheduled run the computer slept through, while it is still due', () => {
    expect(retried(ended({}))).toBe(true);
  });

  it('leaves every other ending alone', () => {
    expect(retried(ended({ error: 'fetch failed' }))).toBe(false);
    expect(retried(ended({ status: 'completed', error: null }))).toBe(false);
    expect(retried(ended({ status: 'cancelled' }))).toBe(false);
  });

  it('never retries a run a person started', () => {
    const manual = ended({ trigger: 'manual', error: sleptDuringRunError() });
    expect(retried(manual)).toBe(false);
  });

  it('does not retry once the occurrence is an hour late', () => {
    expect(retried(ended({}), Date.parse(DUE) + 61 * 60_000)).toBe(false);
  });

  it('judges a one-shot run, which has no occurrence, from its start', () => {
    const oneShot = ended({ scheduledFor: null });
    const noCron = { name: 'once', cron: null, timezone: null };
    expect(retried(oneShot, Date.parse(DUE) + 20 * 60_000, noCron)).toBe(true);
    expect(retried(oneShot, Date.parse(DUE) + 61 * 60_000, noCron)).toBe(false);
  });
});
