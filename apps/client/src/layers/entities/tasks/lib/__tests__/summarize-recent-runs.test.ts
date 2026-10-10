import { describe, expect, it } from 'vitest';
import type { TaskRun } from '@dorkos/shared/types';
import { summarizeRecentRuns } from '../summarize-recent-runs';

/** A run with only the fields the summary reads. */
function run(scheduleId: string, status: TaskRun['status']): TaskRun {
  return { id: `${scheduleId}-${status}`, scheduleId, status } as TaskRun;
}

describe('summarizeRecentRuns', () => {
  it('says nothing about no runs', () => {
    expect(summarizeRecentRuns([])).toEqual({ running: [], failed: [] });
  });

  it('counts a schedule whose latest run failed', () => {
    expect(summarizeRecentRuns([run('digest', 'failed'), run('digest', 'completed')])).toEqual({
      running: [],
      failed: ['digest'],
    });
  });

  it('forgets a failure the next run made good', () => {
    expect(
      summarizeRecentRuns([run('digest', 'completed'), run('digest', 'failed')]).failed
    ).toEqual([]);
  });

  it('counts a blocked run as a failure', () => {
    expect(summarizeRecentRuns([run('inbox', 'blocked')]).failed).toEqual(['inbox']);
  });

  it('does not count a cancelled or skipped latest run as a failure', () => {
    const summary = summarizeRecentRuns([run('a', 'cancelled'), run('b', 'skipped')]);
    expect(summary.failed).toEqual([]);
  });

  it('names a running schedule once, however many runs it has going', () => {
    const summary = summarizeRecentRuns([
      run('digest', 'running'),
      run('digest', 'running'),
      run('digest', 'failed'),
      run('inbox', 'running'),
    ]);
    // Running now outranks the older failure on the same schedule.
    expect(summary).toEqual({ running: ['digest', 'inbox'], failed: [] });
  });
});
