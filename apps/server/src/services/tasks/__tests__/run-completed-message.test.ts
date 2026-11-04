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
  it('sends the refusal title and fixed guidance without commands or run output', () => {
    expect(
      formatCompletionMessage(
        task,
        run({
          status: 'needs_attention',
          refusedTools: ['Bash'],
          error: 'sample-command --sample',
          outputSummary: 'sample run output',
        })
      )
    ).not.toMatch(/sample-command|sample run output/);
    expect(
      formatCompletionMessage(
        task,
        run({
          status: 'needs_attention',
          error: REFUSAL,
          outputSummary: 'sample run output',
          refusedTools: ['Bash'],
        }),
        true
      )
    ).toBe(
      "Mailroom had a command refused\nOpen the schedule to fix it.\nYou won't get another notice about it until it runs cleanly and fails again."
    );
    expect(
      formatCompletionMessage(
        task,
        run({ status: 'needs_attention', refusedTools: ['mcp__sample__search'] })
      )
    ).toBe('Mailroom was refused sample: search\nOpen the schedule to fix it.');
  });

  it.each([false, true])(
    'reserves the complete guidance within 280 characters (streak: %s)',
    (streak) => {
      const tail = `Open the schedule to fix it.${streak ? "\nYou won't get another notice about it until it runs cleanly and fails again." : ''}`;
      for (const refusedTools of [['Bash'], [`mcp__sample__${'long'.repeat(200)}`]]) {
        const body = formatCompletionMessage(
          { ...task, displayName: 'Nightly sample report '.repeat(100) },
          run({
            status: 'needs_attention',
            refusedTools,
            error: 'sample-secret-command',
            outputSummary: 'sample-private-output',
          }),
          streak
        );
        expect(body.length).toBeLessThanOrEqual(280);
        expect(body).toContain(
          refusedTools[0] === 'Bash' ? ' had a command refused' : ' was refused '
        );
        expect(body.endsWith(tail)).toBe(true);
        expect(body).not.toMatch(/sample-secret-command|sample-private-output/);
      }
    }
  );

  it('still says done for a success, and a run that did not finish gets the cross', () => {
    expect(formatCompletionMessage(task, run({ outputSummary: 'All clear' }))).toBe(
      '✅ Mailroom — done in 4s. All clear'
    );
    expect(formatCompletionMessage(task, run({ status: 'failed', error: 'API Error: 500' }))).toBe(
      '✕ Mailroom needs attention. Didn’t finish: API Error: 500. Open the schedule to fix it.'
    );
  });
});
