import { describe, expect, it, vi } from 'vitest';
import {
  pauseWhileWaitingToStart,
  runTimeLimitError,
  waitingToStartMessage,
} from '../run-time-limit.js';
import { SLOT_WAIT_STATUS } from '../schemas.js';

/**
 * The sentence itself is the contract here, so both branches are asserted as
 * FULL literals rather than by shape or substring.
 *
 * The direct-dispatch path's own suite checks its run row with
 * `toContain('time limit')`, which a jargon rewrite walks straight through —
 * "TTL budget expired: 5m time limit" contains it and the server suite stays
 * green. This file is where that wording is actually pinned, for the path that
 * names a duration as well as the one that cannot (DOR-1786).
 */
describe('runTimeLimitError', () => {
  it('names the limit when the caller knows it — the direct-dispatch path', () => {
    expect(runTimeLimitError('5m')).toBe('Run stopped after passing its 5m time limit');
  });

  it('says the same thing without a number when the caller has none — the relay path', () => {
    expect(runTimeLimitError()).toBe('Run stopped after passing its time limit');
  });

  it('carries the duration through exactly as it was formatted', () => {
    // The formatter is the server's (`apps/server/src/lib/format-duration.ts`)
    // and its output travels verbatim: this must never re-format, abbreviate or
    // re-punctuate what a person set.
    expect(runTimeLimitError('1h 30m')).toBe('Run stopped after passing its 1h 30m time limit');
  });
});

const WAIT = {
  type: 'system_status',
  data: {
    message: 'Waiting to start: every agent on this computer is busy.',
    status: SLOT_WAIT_STATUS,
  },
};

describe('waitingToStartMessage', () => {
  it('reads the slot-wait status, and nothing else', () => {
    expect(waitingToStartMessage(WAIT)).toBe(
      'Waiting to start: every agent on this computer is busy.'
    );
    expect(waitingToStartMessage({ type: 'system_status', data: { message: 'x' } })).toBeNull();
    expect(waitingToStartMessage({ type: 'text_delta', data: { text: 'hi' } })).toBeNull();
  });
});

describe('pauseWhileWaitingToStart (DOR-4576)', () => {
  it('pauses once for a wait, however many beats it says, and resumes at the first real event', () => {
    const limit = { pause: vi.fn(), resume: vi.fn() };
    const onWaiting = vi.fn();
    const observe = pauseWhileWaitingToStart(limit, onWaiting);

    observe(WAIT);
    observe(WAIT);
    expect(limit.pause).toHaveBeenCalledTimes(1);
    expect(onWaiting).toHaveBeenCalledWith(
      'Waiting to start: every agent on this computer is busy.'
    );

    observe({ type: 'text_delta', data: { text: 'working' } });
    observe({ type: 'text_delta', data: { text: 'more' } });
    expect(limit.resume).toHaveBeenCalledTimes(1);
    expect(onWaiting).toHaveBeenLastCalledWith(null);
    expect(onWaiting).toHaveBeenCalledTimes(2);
  });

  it('leaves a run that never waited alone', () => {
    const limit = { pause: vi.fn(), resume: vi.fn() };
    const onWaiting = vi.fn();
    pauseWhileWaitingToStart(limit, onWaiting)({ type: 'text_delta', data: { text: 'x' } });
    expect(limit.pause).not.toHaveBeenCalled();
    expect(limit.resume).not.toHaveBeenCalled();
    expect(onWaiting).not.toHaveBeenCalled();
  });
});
