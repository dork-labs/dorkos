/**
 * The seam this file guards: what a REAL failing claude-code turn settles to.
 *
 * Every other test of {@link deriveTurnEndLifecycle} hands the projector a
 * `turn_end` it wrote itself, which proves the rule and not the plumbing. This
 * one starts where a real turn starts — the SDK `result` message — and drives it
 * through the production result mapper, the production normalizer and the
 * production projector, asserting only the thing an operator sees.
 *
 * It exists because the DOR-1676 bug lived entirely in the JOIN. Each piece was
 * defensible alone: the mapper emits the CLI's own `terminal_reason` (right — it
 * is the diagnostic), the normalizer lets an explicit reason beat its error
 * latch (right — it must not overwrite `model_error` with a generic `error`),
 * and the projector settled anything that was not literally `'error'` as idle
 * (wrong, and invisible from either neighbour). A test that mocked any one of
 * the three would have encoded the same assumption that hid it.
 */
import { describe, expect, it } from 'vitest';

import { mapResultEvent } from '../../runtimes/claude-code/sdk/event-mappers/result-event-mapper.js';
import { feedProjector } from '../session-event-normalizer.js';
import { SessionStateProjector } from '../session-state-projector.js';

import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { StreamEvent } from '@dorkos/shared/types';

const SESSION_ID = 's-honesty';

/**
 * Run one SDK `result` through the real mapper, normalizer and projector, and
 * report what the session ended up saying about the turn.
 *
 * @param result - The `result` message fields under test.
 * @param wasStopped - DorkOS's own stop record for the query that produced this
 *   result, as the runtime would supply it. Omitted for a caller that keeps no
 *   record, which is the shape every non-stop case here wants.
 */
async function settle(
  result: Record<string, unknown>,
  wasStopped?: () => boolean
): Promise<{
  lifecycle: SessionLifecycle;
  lastErrorMessage: string | undefined;
  mapped: string[];
}> {
  const session = {} as unknown as Parameters<typeof mapResultEvent>[1];
  const mapped: StreamEvent[] = [];
  for await (const event of mapResultEvent(
    { type: 'result', ...result } as unknown as Parameters<typeof mapResultEvent>[0],
    session,
    SESSION_ID,
    wasStopped
  )) {
    mapped.push(event);
  }

  const projector = new SessionStateProjector(SESSION_ID);
  await feedProjector(
    projector,
    (async function* () {
      for (const event of mapped) yield event;
    })()
  );
  const status = projector.getStatus();
  return {
    lifecycle: status.lifecycle,
    lastErrorMessage: status.lastError?.message,
    mapped: mapped.map((e) => e.type),
  };
}

describe('a failing claude-code turn, end to end (DOR-1676)', () => {
  // The shape itself, asserted once so the cases below cannot quietly stop
  // exercising the path they claim to: a non-success result emits the CLI's
  // reason on a `session_status`, then the error frame, then the terminal
  // `done`. The reason rides `session_status` because `DoneEvent` has no field
  // for it.
  it('maps a failing result to session_status -> error -> done', async () => {
    const { mapped } = await settle({
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'model_error',
      errors: ['API Error: 500 internal server error'],
    });
    expect(mapped).toEqual(['session_status', 'error', 'done']);
  });

  // The bug, in the words of the person hitting it: the agent failed, and the
  // app said it was done. Every one of these is a reason the SDK sets on a
  // result that also carries an error subtype, and all of them settled `idle`
  // with the failure text erased before this fix.
  it.each([
    'model_error',
    'api_error',
    'turn_setup_failed',
    'prompt_too_long',
    'blocking_limit',
    'budget_exhausted',
    'malformed_tool_use_exhausted',
    'structured_output_retry_exhausted',
    'image_error',
    'rapid_refill_breaker',
    'max_turns',
  ])('settles to error and keeps the failure text when the CLI reports %s', async (reason) => {
    const { lifecycle, lastErrorMessage } = await settle({
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: reason,
      errors: ['API Error: 500 internal server error'],
    });
    expect(lifecycle).toBe('error');
    expect(lastErrorMessage).toBe('API Error: 500 internal server error');
  });

  // A result with no reason at all (older CLIs, and the synthetic `result` the
  // persistent pump writes for a dead process) still fails via the normalizer's
  // error latch — the path that always worked, kept working.
  it('settles to error when a failing result names no reason at all', async () => {
    const { lifecycle } = await settle({
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['The agent stopped before it finished this turn.'],
    });
    expect(lifecycle).toBe('error');
  });

  // The guard on the other side: a turn that SUCCEEDED must stay idle. Without
  // this, "settle more turns to error" is trivially satisfiable by settling all
  // of them.
  it('leaves a successful turn idle', async () => {
    const { lifecycle, mapped } = await settle({
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      total_cost_usd: 0.01,
    });
    expect(mapped).not.toContain('error');
    expect(lifecycle).toBe('idle');
  });

  // A turn the operator stopped is not a failure. The mapper drops the error
  // frame when DorkOS asked for the stop (DOR-1320), and the reason still
  // settles the turn as cut short — the distinct state that says "you did this",
  // not "it broke".
  it('settles a stop the operator asked for as interrupted, with no failure text', async () => {
    const { lifecycle, lastErrorMessage, mapped } = await settle(
      {
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        errors: ['[ede_diagnostic] result_type=user'],
      },
      () => true
    );
    expect(mapped).not.toContain('error');
    expect(lifecycle).toBe('interrupted');
    expect(lastErrorMessage).toBeUndefined();
  });

  // The other abort, and the one this file exists to tell apart from the one
  // above. An API refusal aborts the main turn controller directly, so the CLI
  // reports the SAME `aborted_streaming` while DorkOS never asked for anything.
  // The mapper keeps the error frame (DOR-1320) — and settlement then read the
  // reason on shape alone, called it `interrupted`, and cleared the frame on the
  // way out. The operator was told they stopped a turn they never touched, and
  // the refusal text was gone.
  //
  // Every layer in this path is the production one, which is the point: the bug
  // lived in the JOIN both times, and mocking any single hop would encode the
  // very assumption that hid it.
  it('settles an abort NOBODY asked for as an error, keeping the failure text', async () => {
    const { lifecycle, lastErrorMessage, mapped } = await settle(
      {
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        errors: ['Claude refused to continue with this request'],
      },
      () => false
    );
    expect(mapped).toContain('error');
    expect(lifecycle).toBe('error');
    expect(lastErrorMessage).toBe('Claude refused to continue with this request');
  });

  // The degradation pin, end to end: a runtime that supplies no stop record at
  // all reports the same abort, and the turn settles exactly as it did before
  // the signal existed. This is codex, opencode, and every turn already on disk.
  it('settles an abort from a runtime that keeps no stop record as interrupted', async () => {
    const { lifecycle } = await settle({
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
      errors: ['Claude refused to continue with this request'],
    });
    expect(lifecycle).toBe('interrupted');
  });
});
