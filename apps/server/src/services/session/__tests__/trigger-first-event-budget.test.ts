/**
 * The first-event budget as PRODUCTION wires it (DOR-1229).
 *
 * `stall-guard.test.ts` proves the guard honours a `firstEventTimeoutMs` it is
 * handed. That is not the same claim as "the two trigger seams hand it one", and
 * the difference was measured: deleting the option from BOTH `trigger-turn.ts`
 * and `trigger-command-intent.ts` left 2935 tests green. These are the two
 * assertions that go red for it.
 *
 * **Neither test passes `stallTimeoutMs`**, so the inactivity window is the
 * shipped ten minutes. Anything firing at two is therefore the first-event
 * window and nothing else — which is exactly the wiring under test.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { SessionEvent } from '@dorkos/shared/session-stream';

// The neutral context bag reads the real filesystem (git status); these tests
// are about a clock, so keep it inert.
vi.mock('../context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import { triggerTurn } from '../trigger-turn.js';
import type { TriggerTurnDeps } from '../trigger-turn.js';
import { triggerCommandIntent } from '../trigger-command-intent.js';
import type { TriggerCommandIntentDeps } from '../trigger-command-intent.js';
import { getOrCreateProjector, disposeProjector } from '../session-state-projector.js';
import { SESSIONS } from '../../../config/constants.js';

const SESSION = '00000000-0000-4000-8000-0000000000fe';
const CLIENT = 'first-event-budget-tab';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  disposeProjector(SESSION);
  vi.restoreAllMocks();
});

/** A source that accepts the turn and then never yields anything, ever. */
async function* silent(): AsyncGenerator<StreamEvent> {
  await new Promise<void>(() => {});
}

/** Collect everything the projector emits from `cursor`, in the background. */
function watch(cursor: number): { events: SessionEvent[]; stop: () => void } {
  const projector = getOrCreateProjector(SESSION);
  const abort = new AbortController();
  const events: SessionEvent[] = [];
  void (async () => {
    try {
      for await (const event of projector.subscribe(cursor, abort.signal)) events.push(event);
    } catch {
      // The abort in `stop()`; nothing to report.
    }
  })();
  return { events, stop: () => abort.abort() };
}

/** Let the detached turn's promise chain settle without moving the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

/**
 * How long a trigger waits for a first event before answering with the request
 * id (`CANONICAL_ID_TIMEOUT_MS`). On a source that never yields, this is time
 * the caller ALWAYS spends, so it is advanced before the assertions start and
 * counted against the budget below rather than added to it.
 */
const CANONICAL_ID_WAIT_MS = 5_000;

describe('the trigger seams hand the stall guard a first-event window', () => {
  it('ends a turn that never yields at the first-event budget, visibly', async () => {
    const interruptQuery = vi.fn(async () => mockInterruptReceipt('acked'));
    const deps: TriggerTurnDeps = {
      acquireLock: () => true,
      releaseLock: () => {},
      sendMessage: () => silent(),
      interruptQuery,
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: () => ({ nativeContext: [] }) as unknown as RuntimeCapabilities,
    };
    const projector = getOrCreateProjector(SESSION);
    const watching = watch(projector.getCursor());

    // Not awaited yet: a trigger answers on the first event OR after
    // `CANONICAL_ID_TIMEOUT_MS`, and on a silent source only the clock can end
    // that wait — which under fake timers means advancing it first.
    const accepted = triggerTurn({
      sessionId: SESSION,
      clientId: CLIENT,
      content: 'answer the room',
      projector,
      deps,
    });
    await vi.advanceTimersByTimeAsync(CANONICAL_ID_WAIT_MS);
    expect(await accepted).toMatchObject({ accepted: true });

    // A minute short of the first-event budget — and MINUTES short of the
    // ten-minute inactivity window, which is what makes this a wiring test.
    await vi.advanceTimersByTimeAsync(
      SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS - CANONICAL_ID_WAIT_MS - 60_000
    );
    await flush();
    expect(interruptQuery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(interruptQuery).toHaveBeenCalledTimes(1);

    // Visible, not merely ended: the person gets a typed error naming the fault,
    // and the turn closes rather than sitting at `streaming`.
    const error = watching.events.find((event) => event.type === 'error');
    expect(error).toMatchObject({
      code: 'turn_stalled',
      message: 'The agent never started working after 2 minutes, so the turn was ended.',
    });
    expect(watching.events.find((event) => event.type === 'turn_end')).toMatchObject({
      terminalReason: 'error',
    });
    watching.stop();
  });

  it('does the same for a command intent that never yields', async () => {
    const interruptQuery = vi.fn(async () => mockInterruptReceipt('acked'));
    const deps: TriggerCommandIntentDeps = {
      acquireLock: () => true,
      releaseLock: () => {},
      executeCommandIntent: () => silent(),
      interruptQuery,
      getInternalSessionId: () => undefined,
    };
    const projector = getOrCreateProjector(SESSION);
    const watching = watch(projector.getCursor());

    // No canonical-id wait on this path: it answers as soon as the run starts.
    expect(
      await triggerCommandIntent({
        sessionId: SESSION,
        clientId: CLIENT,
        intent: 'compact',
        projector,
        deps,
      })
    ).toMatchObject({ accepted: true });
    await flush();

    await vi.advanceTimersByTimeAsync(SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS - 60_000);
    await flush();
    expect(interruptQuery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(interruptQuery).toHaveBeenCalledTimes(1);
    expect(watching.events.find((event) => event.type === 'error')).toMatchObject({
      code: 'turn_stalled',
    });
    watching.stop();
  });
});
