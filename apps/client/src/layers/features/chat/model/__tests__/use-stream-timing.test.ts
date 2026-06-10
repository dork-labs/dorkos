/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { useStreamTiming } from '../use-stream-timing';

const SID = 'sess-1';

function textDelta(seq: number, text: string): SessionEvent {
  return { seq, type: 'text_delta', text };
}

interface Props {
  sessionId: string | null;
  turn: SessionEvent[];
  isStreaming: boolean;
}

function render(initial: Partial<Props> = {}) {
  return renderHook(
    ({ sessionId, turn, isStreaming }: Props) => useStreamTiming(sessionId, turn, isStreaming),
    {
      initialProps: {
        sessionId: SID,
        turn: [] as SessionEvent[],
        isStreaming: false,
        ...initial,
      },
    }
  );
}

describe('useStreamTiming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('anchors streamStartTime on the →streaming edge and clears it on settle', () => {
    // Real failure mode (CLI-B6): the legacy writers are gone, so the status
    // strip rendered a dead "0m 00s" — the clock must anchor when streaming
    // starts and hold that anchor across re-renders of the SAME turn.
    vi.setSystemTime(50_000);
    const turnStart: SessionEvent = { seq: 1, type: 'turn_start' };
    const { result, rerender } = render();
    expect(result.current.streamStartTime).toBeNull();

    rerender({ sessionId: SID, turn: [turnStart], isStreaming: true });
    expect(result.current.streamStartTime).toBe(50_000);

    // The anchor is stable while the turn continues (no clock restart).
    vi.setSystemTime(60_000);
    rerender({ sessionId: SID, turn: [turnStart, textDelta(2, 'hi')], isStreaming: true });
    expect(result.current.streamStartTime).toBe(50_000);

    rerender({ sessionId: SID, turn: [], isStreaming: false });
    expect(result.current.streamStartTime).toBeNull();
  });

  it('re-anchors for a DIFFERENT turn of the same session (stale-anchor regression)', () => {
    // Real failure mode: a session that settled and started a NEW turn while
    // backgrounded (or back-to-back turns coalesced into one render by a queued
    // flush) must not reuse the old turn's anchor — the strip would show the
    // previous turn's elapsed time. The anchor is keyed to the turn_start seq.
    vi.setSystemTime(50_000);
    const { result, rerender } = render({
      turn: [{ seq: 1, type: 'turn_start' }],
      isStreaming: true,
    });
    expect(result.current.streamStartTime).toBe(50_000);

    // Same session, new turn (higher turn_start seq), still streaming.
    vi.setSystemTime(90_000);
    rerender({
      sessionId: SID,
      turn: [{ seq: 7, type: 'turn_start' } as SessionEvent],
      isStreaming: true,
    });
    expect(result.current.streamStartTime).toBe(90_000);
  });

  it('estimates tokens from the turn’s streamed text deltas (~4 chars/token)', () => {
    const { result } = render({
      turn: [
        { seq: 1, type: 'turn_start' },
        textDelta(2, '12345678'), // 8 chars
        { seq: 3, type: 'thinking_delta', text: 'not counted' },
        textDelta(4, '1234'), // 4 chars
      ],
      isStreaming: true,
    });
    expect(result.current.estimatedTokens).toBe(3); // 12 chars / 4
  });

  it('raises isTextStreaming on token growth and decays it 500ms after the last delta', () => {
    const { result, rerender } = render({ isStreaming: true });
    expect(result.current.isTextStreaming).toBe(false);

    rerender({ sessionId: SID, turn: [textDelta(1, 'abcd')], isStreaming: true });
    expect(result.current.isTextStreaming).toBe(true);

    // Another delta inside the window extends the decay.
    act(() => vi.advanceTimersByTime(300));
    rerender({
      sessionId: SID,
      turn: [textDelta(1, 'abcd'), textDelta(2, 'efgh')],
      isStreaming: true,
    });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.isTextStreaming).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.isTextStreaming).toBe(false);
  });

  it('does not flag text streaming when the token count jumps due to a session switch', () => {
    // Real failure mode: switching to a session with a bigger in-progress turn
    // grows the estimate without any new delta arriving — flagging that as
    // "actively typing" would flash the typing affordance on every switch.
    const { result, rerender } = render({
      sessionId: 'sess-a',
      turn: [textDelta(1, 'ab')],
      isStreaming: true,
    });
    rerender({
      sessionId: 'sess-b',
      turn: [textDelta(1, 'a much longer accumulated turn body')],
      isStreaming: true,
    });
    expect(result.current.isTextStreaming).toBe(false);
  });
});
