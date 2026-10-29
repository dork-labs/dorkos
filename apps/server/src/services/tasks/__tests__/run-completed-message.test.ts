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
    expect(body).not.toContain('✕');
  });

  it('says what the inbox notice says, in its four parts, with no log wording (DOR-3123)', () => {
    const body = formatCompletionMessage(
      task,
      run({
        status: 'needs_attention',
        outcome: 'partial',
        error: REFUSAL,
        refusedTools: ['Bash', 'mcp__gmail__search'],
      }),
      true
    );

    expect(body).toBe(
      '🔒 Mailroom needs attention. Bash and gmail: search were refused, with nobody there to ' +
        'approve them. Open the schedule to fix it. ' +
        'You won’t get another notice about it until it runs cleanly and fails again.'
    );
    // Neither the run's own log sentence nor how long it ran.
    expect(body).not.toContain('Skipped');
    expect(body).not.toContain('4s');
  });

  it('says when nothing got done', () => {
    expect(
      formatCompletionMessage(
        task,
        run({ status: 'needs_attention', outcome: 'nothing_done', refusedTools: ['Bash'] })
      )
    ).toBe(
      '🔒 Mailroom needs attention. Nothing got done: Bash was refused. Open the schedule to fix it.'
    );
  });

  it('ends the one notice of a failing streak with the no-repeat line, never cut off (DOR-3123)', () => {
    const body = formatCompletionMessage(
      task,
      run({
        status: 'needs_attention',
        outcome: 'partial',
        refusedTools: [`mcp__${'a'.repeat(300)}__search`],
      }),
      true
    );

    expect(
      body.endsWith(' You won’t get another notice about it until it runs cleanly and fails again.')
    ).toBe(true);
    expect(body.length).toBeLessThanOrEqual(280);
    // The reason is what got cut, and the fix survived it.
    expect(body).toContain('… Open the schedule to fix it.');
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
