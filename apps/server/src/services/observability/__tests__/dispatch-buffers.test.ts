/**
 * The two rings: bounded, newest-first, and honest about what they no longer
 * hold.
 *
 * The eviction cases are the ones worth pinning. A ring that quietly grew would
 * be a memory leak on a long-running server, and a ring that dropped the wrong
 * end would answer "what just happened" with the oldest thing it knows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordDispatchStart,
  recordDispatchEnd,
  recentDispatches,
  recordRefusal,
  recentRefusals,
  resetDispatchBuffers,
  DISPATCH_BUFFER_SIZE,
} from '../dispatch-buffers.js';

beforeEach(() => {
  resetDispatchBuffers();
});

describe('the recent-dispatch ring', () => {
  it('returns newest first', () => {
    recordDispatchStart({ dispatchId: 'dsp_1', origin: 'room' });
    recordDispatchStart({ dispatchId: 'dsp_2', origin: 'session' });
    expect(recentDispatches(10).map((d) => d.dispatchId)).toEqual(['dsp_2', 'dsp_1']);
  });

  it('holds no more than its capacity, keeping the newest', () => {
    for (let i = 0; i < DISPATCH_BUFFER_SIZE + 10; i += 1) {
      recordDispatchStart({ dispatchId: `dsp_${i}`, origin: 'task' });
    }
    const held = recentDispatches(DISPATCH_BUFFER_SIZE * 2);
    expect(held).toHaveLength(DISPATCH_BUFFER_SIZE);
    expect(held[0].dispatchId).toBe(`dsp_${DISPATCH_BUFFER_SIZE + 9}`);
    expect(held.at(-1)?.dispatchId).toBe('dsp_10');
  });

  it('closes a dispatch in place rather than adding a second row', () => {
    recordDispatchStart({ dispatchId: 'dsp_1', origin: 'room', roomId: 'r1' });
    recordDispatchEnd('dsp_1', 'answered', 'session-9');
    const held = recentDispatches(10);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      outcome: 'answered',
      sessionId: 'session-9',
      roomId: 'r1',
    });
    expect(held[0].endedAt).not.toBeNull();
  });

  it('ignores an end whose start has already been evicted', () => {
    // A room turn can legitimately outlive 256 later dispatches. Resurrecting it
    // as a start-less row would put a dispatch with no beginning at the top of
    // the list, which reads as the newest thing that happened.
    recordDispatchStart({ dispatchId: 'dsp_old', origin: 'room' });
    for (let i = 0; i < DISPATCH_BUFFER_SIZE; i += 1) {
      recordDispatchStart({ dispatchId: `dsp_${i}`, origin: 'task' });
    }
    recordDispatchEnd('dsp_old', 'answered');
    expect(recentDispatches(DISPATCH_BUFFER_SIZE).some((d) => d.dispatchId === 'dsp_old')).toBe(
      false
    );
  });

  it('closes the NEWEST run of a repeated id', () => {
    // Ids are unique in production, but the ring must not depend on that: a
    // match from the far end would close a dispatch that finished long ago.
    recordDispatchStart({ dispatchId: 'dsp_1', origin: 'room' });
    recordDispatchEnd('dsp_1', 'quiet');
    recordDispatchStart({ dispatchId: 'dsp_1', origin: 'room' });
    recordDispatchEnd('dsp_1', 'failed');
    expect(recentDispatches(10).map((d) => d.outcome)).toEqual(['failed', 'quiet']);
  });
});

describe('the refusal ring', () => {
  it('keeps the dispatch context it was given, and omits what it was not', () => {
    recordRefusal(
      { reason: 'agent_busy', visibility: 'damped', roomId: 'r1', authorId: 'a1' },
      { dispatchId: 'dsp_1', origin: 'room' }
    );
    recordRefusal({ reason: 'no_binding', visibility: 'silent' });
    const held = recentRefusals(10);
    expect(held[0]).toMatchObject({ reason: 'no_binding', visibility: 'silent' });
    expect(held[0].dispatchId).toBeUndefined();
    expect(held[1]).toMatchObject({ dispatchId: 'dsp_1', origin: 'room', roomId: 'r1' });
  });

  it('holds no more than its capacity', () => {
    for (let i = 0; i < DISPATCH_BUFFER_SIZE + 5; i += 1) {
      recordRefusal({ reason: 'agent_busy', visibility: 'silent', roomId: `r${i}` });
    }
    const held = recentRefusals(DISPATCH_BUFFER_SIZE * 2);
    expect(held).toHaveLength(DISPATCH_BUFFER_SIZE);
    expect(held[0].roomId).toBe(`r${DISPATCH_BUFFER_SIZE + 4}`);
  });

  it('never carries the `detail` bag a log line takes', () => {
    // `detail` is where a call site puts an error message or a tool name. The
    // log may have it; a response a person can hit without a credential when
    // login is off may not.
    recordRefusal({
      reason: 'turn_failed',
      visibility: 'silent',
      detail: { error: '/Users/someone/secret.md is unreadable' },
    });
    expect(JSON.stringify(recentRefusals(1))).not.toContain('Users');
  });
});
