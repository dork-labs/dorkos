// @vitest-environment jsdom
/**
 * The two inputs the session's lane spent three phases without.
 *
 * `deriveLaneState`'s priority table has its own suite; what is asked here is
 * what a SESSION feeds it. P2 built the `stalled` and `queued` rungs and left
 * both hard-coded — `stalled: false` because it had not decided who owned the
 * connection, `queueDepth: 0` because `ConversationTarget` did not exist yet.
 * P4 answers both, so these are the cases that would go quiet if either were
 * wired back to a constant.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ConnectionState } from '@dorkos/shared/types';
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
    connection: 'connected' as ConnectionState,
    queueDepth: 0,
    ...overrides,
  };
}

/** What the lane says for one session. */
function laneFor(overrides: Partial<Parameters<typeof useSessionLaneState>[0]> = {}) {
  return renderHook(() => useSessionLaneState(input(overrides))).result.current;
}

describe('useSessionLaneState — the connection', () => {
  it('says nothing while the stream is connected', () => {
    expect(laneFor({ connection: 'connected' }).kind).not.toBe('stalled');
  });

  it('says nothing while the stream is still opening', () => {
    // The opening handshake is not a stall, and a line for it would flash on
    // every session anybody opens.
    expect(laneFor({ connection: 'connecting' }).kind).not.toBe('stalled');
  });

  it('says the conversation has stopped hearing once the stream gives up', () => {
    // **Seeded defect:** leave `stalled: false` hard-coded, as P2 did → red. A
    // session whose stream has died then looks exactly like one that is idle.
    expect(laneFor({ connection: 'disconnected' }).kind).toBe('stalled');
  });

  it('says so while it is trying to come back, not only once it has failed', () => {
    expect(laneFor({ connection: 'reconnecting' }).kind).toBe('stalled');
  });
});

describe('useSessionLaneState — what is waiting behind the turn', () => {
  it('says nothing with an empty queue', () => {
    expect(laneFor({ queueDepth: 0 }).kind).not.toBe('queued');
  });

  it('counts what is held', () => {
    // **Seeded defect:** leave `queueDepth: 0` hard-coded → red. The queue panel
    // is unmounted for the whole time a prompt has taken the composer, which is
    // the one moment a person most wants to know their messages are still there.
    const state = laneFor({ queueDepth: 2 });

    expect(state.kind).toBe('queued');
    expect(state.kind === 'queued' && state.depth).toBe(2);
  });

  it('lets a dead stream outrank a queue, because one explains the other', () => {
    expect(laneFor({ connection: 'disconnected', queueDepth: 2 }).kind).toBe('stalled');
  });
});
