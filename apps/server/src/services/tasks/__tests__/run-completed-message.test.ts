/**
 * The sentence a chat integration says about a finished run, and the gate that
 * decides whether one is said at all.
 *
 * Pinned because every needs-attention branch in `run-completed.ts` could be deleted
 * without a single test going red (DOR-2101 review) — which is how a run that
 * did nothing kept its green tick in the first place.
 */
import { describe, expect, it } from 'vitest';
import type { Task, TaskRun } from '@dorkos/shared/types';
import { formatCompletionMessage } from '../../notifications/emitters/run-completed.js';

const task = { name: 'mailroom', displayName: 'Mailroom' } as Task;

/** A finished run row, as the terminal write persists it. */
function run(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    status: 'completed',
    startedAt: null,
    finishedAt: null,
    durationMs: 4000,
    outputSummary: null,
    error: null,
    sessionId: null,
    trigger: 'scheduled',
    resolvedRuntime: null,
    resolvedModel: null,
    refusedTools: null,
    outcome: null,
    scheduledFor: null,
    missedTicks: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const REFUSAL =
  'Skipped Bash and gmail: search — nobody was there to approve them on a scheduled run.';

describe('formatCompletionMessage', () => {
  it('sends only the refusal title to a chat channel, even on a streak notice', () => {
    expect(
      formatCompletionMessage(
        task,
        run({ status: 'needs_attention', error: REFUSAL, refusedTools: ['Bash'] }),
        true
      )
    ).toBe('Mailroom had a command refused');
    expect(
      formatCompletionMessage(
        task,
        run({ status: 'needs_attention', refusedTools: ['mcp__sample__search'] })
      )
    ).toBe('Mailroom was refused sample: search');
  });

  it('still says done for a success, and a run that did not finish gets the cross', () => {
    expect(formatCompletionMessage(task, run({ outputSummary: 'All clear' }))).toBe(
      '✅ Mailroom — done in 4s. All clear'
    );
    expect(formatCompletionMessage(task, run({ status: 'failed', error: 'API Error: 500' }))).toBe(
      '✕ Mailroom needs attention. Didn’t finish: API Error: 500. Open the schedule to fix it.'
    );
  });
});
