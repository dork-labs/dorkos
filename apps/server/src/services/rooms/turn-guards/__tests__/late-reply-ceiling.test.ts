/**
 * A room stops listening for an agent's reply at its ceiling, except while the
 * agent waits on a person's answer (DOR-3113).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSIONS } from '../../../../config/constants.js';
import { armLateReplyCeiling } from '../late-reply-ceiling.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('armLateReplyCeiling', () => {
  it('gives up at the ceiling on a turn that is not waiting on anyone', () => {
    const abort = new AbortController();
    armLateReplyCeiling(abort, 1_000, { hasPendingInteractions: () => false });
    vi.advanceTimersByTime(1_000);
    expect(abort.signal.aborted).toBe(true);
  });

  it('keeps listening while the turn waits on a person, and gives up once it does not', () => {
    const abort = new AbortController();
    let waiting = true;
    armLateReplyCeiling(abort, 1_000, { hasPendingInteractions: () => waiting });
    vi.advanceTimersByTime(5_000);
    expect(abort.signal.aborted).toBe(false);
    waiting = false;
    vi.advanceTimersByTime(1_000);
    expect(abort.signal.aborted).toBe(true);
  });

  it('never waits longer than an answer itself may', () => {
    const abort = new AbortController();
    armLateReplyCeiling(abort, 60_000, { hasPendingInteractions: () => true });
    vi.advanceTimersByTime(SESSIONS.INTERACTION_PARK_CEILING_MS + 2 * 60_000);
    expect(abort.signal.aborted).toBe(true);
  });

  it('stops when cleared', () => {
    const abort = new AbortController();
    armLateReplyCeiling(abort, 1_000, { hasPendingInteractions: () => false }).clear();
    vi.advanceTimersByTime(2_000);
    expect(abort.signal.aborted).toBe(false);
  });
});
