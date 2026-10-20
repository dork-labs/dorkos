/**
 * A DM's lane (DOR-3074): "Working" while the agent works, with no clock and
 * no token estimate, and no finished-turn summary. Those are session detail.
 */
import { describe, it, expect } from 'vitest';
import type { LaneState } from '@/layers/features/conversation';
import { withoutTurnNumbers } from '../model/use-session-lane-state';

describe('withoutTurnNumbers', () => {
  it('keeps the working line and drops its time and tokens', () => {
    const streaming: LaneState = {
      kind: 'turn-streaming',
      verb: 'Working',
      verbKey: 'Working',
      elapsed: '0m 04s',
      tokens: '~12 tokens',
      isBypass: false,
    };
    expect(withoutTurnNumbers(streaming)).toEqual({ ...streaming, elapsed: '', tokens: '' });
  });

  it('drops the finished turn’s summary', () => {
    expect(
      withoutTurnNumbers({ kind: 'turn-complete', elapsed: '0m 09s', tokens: '~40 tokens' })
    ).toEqual({
      kind: 'empty',
    });
  });

  it('leaves a wait for the person exactly as it is', () => {
    const waiting: LaneState = { kind: 'turn-waiting', waitingType: 'approval', elapsed: '1m 02s' };
    expect(withoutTurnNumbers(waiting)).toBe(waiting);
  });
});
