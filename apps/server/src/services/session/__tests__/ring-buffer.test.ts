import { describe, it, expect, vi, afterEach } from 'vitest';
import { RingBuffer, RING_BUFFER_MAX_EVENTS, RING_BUFFER_TTL_MS } from '../ring-buffer.js';
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** Build a minimal text_delta event with the given seq for buffer tests. */
function textEvent(seq: number): SessionEvent {
  return { seq, type: 'text_delta', text: `t${seq}` } as SessionEvent;
}

describe('RingBuffer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Failure mode: a live turn longer than the cap would push the buffer's
  // memory unbounded; the oldest events must be dropped at the cap.
  it('drops the oldest events once the cap is exceeded', () => {
    const ring = new RingBuffer();
    for (let i = 1; i <= RING_BUFFER_MAX_EVENTS + 5; i++) {
      ring.append(textEvent(i));
    }
    const events = ring.replayFrom(0);
    expect(events).toHaveLength(RING_BUFFER_MAX_EVENTS);
    // Oldest 5 (seq 1..5) evicted; newest retained.
    expect(events[0]?.seq).toBe(6);
    expect(events.at(-1)?.seq).toBe(RING_BUFFER_MAX_EVENTS + 5);
  });

  // Failure mode: gap replay must not re-deliver events the client already saw,
  // so replayFrom is strictly exclusive on the cursor.
  it('replayFrom returns only events with seq strictly greater than the cursor', () => {
    const ring = new RingBuffer();
    [1, 2, 3, 4, 5].forEach((s) => ring.append(textEvent(s)));
    expect(ring.replayFrom(3).map((e) => e.seq)).toEqual([4, 5]);
    expect(ring.replayFrom(5)).toEqual([]);
    expect(ring.replayFrom(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  // Failure mode: a hard refresh moments after a turn ends must still find the
  // turn's events; eviction happens only after the TTL elapses.
  it('retains events through the TTL window after turn end, then evicts', () => {
    vi.useFakeTimers();
    const ring = new RingBuffer();
    [1, 2].forEach((s) => ring.append(textEvent(s)));
    ring.markTurnEnded();

    // Just before the TTL boundary: still recoverable.
    vi.advanceTimersByTime(RING_BUFFER_TTL_MS - 1);
    expect(ring.replayFrom(0).map((e) => e.seq)).toEqual([1, 2]);

    // At/after the TTL boundary: swept on next access.
    vi.advanceTimersByTime(1);
    expect(ring.replayFrom(0)).toEqual([]);
  });

  // Failure mode: a new turn starting after an expired-but-not-yet-swept turn
  // must clear stale events so the ring only ever reflects the current turn.
  it('clears retained events when a new turn starts', () => {
    const ring = new RingBuffer();
    [1, 2].forEach((s) => ring.append(textEvent(s)));
    ring.markTurnEnded();
    ring.markTurnStarted();
    expect(ring.replayFrom(0)).toEqual([]);
    ring.append(textEvent(3));
    expect(ring.replayFrom(0).map((e) => e.seq)).toEqual([3]);
  });
});
