// @vitest-environment jsdom
/**
 * What a SESSION feeds the lane, and — as much to the point — what it does not.
 *
 * `deriveLaneState`'s priority table has its own suite. What is asked here is
 * the session's own half, and two of the answers are decisions P4 made after
 * P2 left them hard-coded:
 *
 * - **A stalled stream is not the lane's to say on this surface.** The status
 *   chip under the same box is the cockpit's app-wide home for connection
 *   health, and two alarms about one fact teach people to read neither.
 *   `SESSION_CAPABILITIES.streamHealth` is false, and this file is what keeps a
 *   future rewiring from quietly growing the second voice back.
 * - **There is no `queued` rung at all any more.** It sat below every `turn-*`
 *   rung while a queue only ever exists BECAUSE a turn is running, so it could
 *   not be reached; held drafts live in the composer's queue panel.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SESSION_CAPABILITIES } from '../model/session-capabilities';
import { useSessionLaneState } from '../model/use-session-lane-state';

/** A session doing nothing in particular, so each case turns on one thing. */
function input(overrides: Partial<Parameters<typeof useSessionLaneState>[0]> = {}) {
  return {
    status: 'idle' as const,
    streamStartTime: null,
    estimatedTokens: 0,
    permissionMode: 'default' as const,
    isWaitingForUser: false,
    waitingType: 'approval' as const,
    activity: null,
    ...overrides,
  };
}

/** What the lane says for one session. */
function laneFor(overrides: Partial<Parameters<typeof useSessionLaneState>[0]> = {}) {
  return renderHook(() => useSessionLaneState(input(overrides))).result.current;
}

describe('useSessionLaneState — the connection is said once, and not here', () => {
  it('declares that the lane is not this session’s home for stream health', () => {
    // **Seeded defect:** flip `streamHealth` to true in the session's table, and
    // a dropped connection is announced twice six pixels apart — the lane's
    // room-flavoured sentence over the status chip that already says it. Run and
    // red.
    expect(SESSION_CAPABILITIES.streamHealth).toBe(false);
  });

  it('stays quiet in the lane whatever the stream is doing', () => {
    // The hook feeds `stalled: false` and the capability gate would drop it
    // anyway: two guards, one answer, and neither can be the one that slips.
    expect(laneFor().kind).not.toBe('stalled');
    expect(laneFor({ status: 'error' }).kind).not.toBe('stalled');
  });
});

describe('useSessionLaneState — the turn is what it does say', () => {
  it('says nothing at all between turns', () => {
    expect(laneFor().kind).toBe('empty');
  });

  it('reports the turn in flight', () => {
    const state = laneFor({ status: 'streaming', streamStartTime: Date.now() });

    expect(state.kind).toBe('turn-streaming');
  });

  it('reports a turn parked on the person', () => {
    const state = laneFor({
      status: 'streaming',
      streamStartTime: Date.now(),
      isWaitingForUser: true,
      waitingType: 'question',
    });

    expect(state).toMatchObject({ kind: 'turn-waiting', waitingType: 'question' });
  });
});
