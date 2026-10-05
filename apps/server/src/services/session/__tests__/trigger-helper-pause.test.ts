/**
 * A turn whose helper is still working is not stalled (DOR-2681).
 *
 * Measured against the real CLI on 2026-10-03: a foreground helper heartbeats
 * every thirty seconds, but a BACKGROUND helper emits nothing at all for the
 * length of one step. A twelve-minute build is twelve minutes of silence on a
 * turn that is doing exactly what it was asked, and the ten-minute watchdog
 * used to end it. The runtime now says when a helper is still working, and
 * both seams that compose a turn — a person's, and one the agent started —
 * treat that like a person-wait: silence is legitimate while it lasts.
 *
 * Neither test passes `stallTimeoutMs`, so the window is the shipped ten
 * minutes, and both sources yield once first, so the two-minute first-event
 * window is behind them.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

// The neutral context bag reads the real filesystem (git status); these tests
// are about a clock, so keep it inert.
vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import { triggerTurn, type TriggerTurnDeps } from '../trigger-turn.js';
import { subscribeRuntimeTurns } from '../runtime-turns/runtime-turn.js';
import { getOrCreateProjector, disposeProjector } from '../session-state-projector.js';
import { SESSIONS } from '../../../config/constants.js';

const SESSION = '00000000-0000-4000-8000-0000000000fd';
const TWELVE_MINUTES = 12 * 60_000;

/** A source that says one thing — the parent launching its helper — then goes quiet. */
async function* launchesThenGoesQuiet(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'Starting the build in a helper.' } };
  await new Promise<void>(() => {});
}

/** Let the detached turn's promise chain settle without moving the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

let helperWorking: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  helperWorking = true;
});

afterEach(() => {
  vi.useRealTimers();
  disposeProjector(SESSION);
  vi.restoreAllMocks();
});

describe('the stall watchdog waits while a helper is working', () => {
  it('leaves a person’s turn alone through a long silent helper step, then guards it again', async () => {
    const interruptQuery = vi.fn(async () => mockInterruptReceipt('acked'));
    const deps: TriggerTurnDeps = {
      acquireLock: () => true,
      releaseLock: () => {},
      sendMessage: () => launchesThenGoesQuiet(),
      interruptQuery,
      isHelperWorking: () => helperWorking,
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: () => ({ nativeContext: [] }) as unknown as RuntimeCapabilities,
    };

    const accepted = await triggerTurn({
      sessionId: SESSION,
      clientId: 'helper-pause-tab',
      content: 'build it',
      projector: getOrCreateProjector(SESSION),
      deps,
    });
    expect(accepted).toMatchObject({ accepted: true });

    await vi.advanceTimersByTimeAsync(TWELVE_MINUTES);
    await flush();
    expect(interruptQuery).not.toHaveBeenCalled();

    // The helper is done and the turn is still silent: that silence is now
    // the turn's own, and the ordinary window applies to it.
    helperWorking = false;
    await vi.advanceTimersByTimeAsync(SESSIONS.TURN_STALL_TIMEOUT_MS);
    await flush();
    expect(interruptQuery).toHaveBeenCalledTimes(1);
  });

  it('leaves a turn the agent started alone through the same step', async () => {
    const interruptQuery = vi.fn(async () => mockInterruptReceipt('acked'));
    let listener: ((sessionId: string, events: AsyncIterable<StreamEvent>) => void) | undefined;
    const runtime = {
      onRuntimeTurn: (next: typeof listener) => {
        listener = next;
        return () => {};
      },
      getInternalSessionId: () => undefined,
      getCapabilities: () => ({ nativeContext: [] }) as unknown as RuntimeCapabilities,
      acquireRuntimeLock: () => true,
      releaseLock: () => {},
      interruptQuery,
      isHelperWorking: () => helperWorking,
    } as unknown as AgentRuntime;
    const unsubscribe = subscribeRuntimeTurns(runtime);

    listener!(SESSION, launchesThenGoesQuiet());
    await flush();

    await vi.advanceTimersByTimeAsync(TWELVE_MINUTES);
    await flush();
    expect(interruptQuery).not.toHaveBeenCalled();

    helperWorking = false;
    await vi.advanceTimersByTimeAsync(SESSIONS.TURN_STALL_TIMEOUT_MS);
    await flush();
    expect(interruptQuery).toHaveBeenCalledTimes(1);
    unsubscribe?.();
  });
});
