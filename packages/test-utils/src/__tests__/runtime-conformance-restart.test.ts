/**
 * The restart rules can fail (DOR-5213): the conformance suite only ever meets
 * runtimes that are supposed to pass, so this file shows each way a restart
 * declaration, or a continuation run, is caught.
 *
 * @module test-utils/__tests__/runtime-conformance-restart
 */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  restartContinueProblems,
  restartDeclarationProblems,
  type RestartContinueDriver,
} from '../runtime-conformance-restart.js';

type RestartFlags = Pick<
  RuntimeCapabilities,
  'wakesForLostBackgroundWork' | 'continuesInterruptedTurn'
>;

const driver: RestartContinueDriver = {
  start: () => ({}) as AgentRuntime,
  restart: () => ({}) as AgentRuntime,
};
const declines: RestartFlags = {
  wakesForLostBackgroundWork: false,
  continuesInterruptedTurn: false,
};
const claims: RestartFlags = { wakesForLostBackgroundWork: true, continuesInterruptedTurn: true };
const event = (type: string): StreamEvent => ({ type, data: {} }) as StreamEvent;

describe('restartDeclarationProblems', () => {
  it('accepts a runtime that declines with a reason, and one that claims with a driver', () => {
    expect(
      restartDeclarationProblems(declines, { restartContinueUnprovenReason: 'unmeasured' })
    ).toEqual([]);
    expect(restartDeclarationProblems(claims, { restartContinueTurn: driver })).toEqual([]);
  });

  it('fails a capability left undeclared', () => {
    const problems = restartDeclarationProblems(
      { continuesInterruptedTurn: false } as RestartFlags,
      { restartContinueUnprovenReason: 'unmeasured' }
    );
    expect(problems).toEqual([expect.stringContaining('`wakesForLostBackgroundWork` must be')]);
  });

  it('fails a claim with no driver, and a driver with no claim', () => {
    expect(restartDeclarationProblems(claims, {})).toEqual([
      expect.stringContaining('declares `continuesInterruptedTurn` but wires no'),
    ]);
    expect(restartDeclarationProblems(declines, { restartContinueTurn: driver })).toEqual([
      expect.stringContaining('does not declare `continuesInterruptedTurn`'),
    ]);
  });

  it('fails a decline with no reason, and a driver beside a reason', () => {
    expect(restartDeclarationProblems(declines, { restartContinueUnprovenReason: '   ' })).toEqual([
      expect.stringContaining('gives no `restartContinueUnprovenReason`'),
    ]);
    expect(
      restartDeclarationProblems(claims, {
        restartContinueTurn: driver,
        restartContinueUnprovenReason: 'unmeasured',
      })
    ).toEqual([expect.stringContaining('dead copy')]);
  });
});

describe('restartContinueProblems', () => {
  const answered = [event('text_delta'), event('done')];
  const toolEnded = [event('tool_call_start'), event('tool_call_end')];
  const problems = (cut: StreamEvent[], continuation: StreamEvent[], freshInstance = true) =>
    restartContinueProblems({ cut, continuation, freshInstance });

  it('accepts a turn cut after its tool call and a continuation that answers once', () => {
    expect(problems(toolEnded, answered)).toEqual([]);
  });

  it('fails a cut turn that never finished a tool, or that ended anyway', () => {
    expect(problems([event('text_delta')], answered)).toEqual([
      expect.stringContaining('never finished a tool call'),
    ]);
    expect(problems([event('tool_result'), event('done')], answered)).toEqual([
      expect.stringContaining('reached `done`'),
    ]);
  });

  it('fails a continuation that errors, stays silent or never ends', () => {
    expect(problems(toolEnded, [event('error'), ...answered])).toEqual([
      expect.stringContaining('`error` event'),
    ]);
    expect(problems(toolEnded, [event('done')])).toEqual([expect.stringContaining('said nothing')]);
    expect(problems(toolEnded, [event('text_delta')])).toEqual([
      expect.stringContaining('exactly one `done`'),
    ]);
  });

  it('fails a continuation that keeps going after its done', () => {
    expect(problems(toolEnded, [event('text_delta'), event('done'), event('text_delta')])).toEqual([
      expect.stringContaining('its last event was text_delta'),
    ]);
  });

  it('fails a restart that hands back the instance that ran the cut turn', () => {
    expect(problems(toolEnded, answered, false)).toEqual([
      expect.stringContaining('nothing restarted'),
    ]);
  });
});
