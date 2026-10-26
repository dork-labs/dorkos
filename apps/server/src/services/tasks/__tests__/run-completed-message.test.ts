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
  it('leads a run that needs attention with the padlock, not the tick or the warning triangle', () => {
    const body = formatCompletionMessage(
      task,
      run({ status: 'needs_attention', error: REFUSAL, refusedTools: ['Bash'] })
    );

    expect(body).toContain('🔒');
    expect(body).not.toContain('✅');
    expect(body).not.toContain('⚠️');
    expect(body).not.toContain('failed');
  });

  it('says "nobody was there to approve" once, not twice', () => {
    // The detail IS the refusal sentence, so the lead must not repeat its words.
    const body = formatCompletionMessage(
      task,
      run({ status: 'needs_attention', outcome: 'nothing_done', error: REFUSAL })
    );

    expect(body).toContain('Mailroom — used none of its tools in 4s.');
    expect(body).toContain(REFUSAL);
    expect(body.match(/nobody was there to approve/g)).toHaveLength(1);
  });

  it('says a run that carried on was refused a tool, not that it used none (DOR-3123)', () => {
    const body = formatCompletionMessage(
      task,
      run({ status: 'needs_attention', outcome: 'partial', error: REFUSAL })
    );

    expect(body).toContain('🔒 Mailroom — was refused a tool in 4s.');
    expect(body).not.toContain('used none');
  });

  it('ends the one notice of a failing streak with the no-repeat line, never cut off (DOR-3123)', () => {
    const body = formatCompletionMessage(
      task,
      run({ status: 'needs_attention', outcome: 'partial', error: 'x'.repeat(400) }),
      true
    );

    expect(
      body.endsWith(' You won’t get another notice about it until it runs cleanly and fails again.')
    ).toBe(true);
    expect(body.length).toBeLessThanOrEqual(200);
  });

  it('still says done for a success and failed for a failure', () => {
    expect(formatCompletionMessage(task, run({ outputSummary: 'All clear' }))).toBe(
      '✅ Mailroom — done in 4s. All clear'
    );
    expect(formatCompletionMessage(task, run({ status: 'failed', error: 'API Error: 500' }))).toBe(
      '⚠️ Mailroom — failed after 4s. API Error: 500'
    );
  });
});
