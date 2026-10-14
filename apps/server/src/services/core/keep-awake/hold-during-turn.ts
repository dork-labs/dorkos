/**
 * Counts every agent turn for keep-awake, at the one seam every turn passes
 * through: `runtimeRegistry.register()` (DOR-1654). The interactive composer, a
 * room reply, a scheduled run and a relay delivery all resolve their runtime
 * from the registry, so a turn started anywhere is held here exactly once.
 *
 * Same Proxy shape as `traceRuntime` and `watchRuntimeSignin`: two members are
 * intercepted, and every other member passes straight through, bound to the
 * real runtime so its private state stays intact.
 *
 * - `sendMessage`: every dispatched turn.
 * - `onRuntimeTurn`: a turn the agent starts on its own, most often when a
 *   background helper reports back. It has no dispatch, so it is held from its
 *   first event to its end exactly like one that did, unless its agent is
 *   paused: a paused agent's turn is being stopped, and keeps nothing awake.
 *
 * **A turn's end is not always the work's end.** When the runtime says the
 * agent still holds background work as a turn ends
 * (`AgentRuntime.holdsBackgroundWork`), the service keeps the hold until that
 * work is done.
 *
 * **The hold opens on the first `next()`, not when `sendMessage` is called.**
 * An async generator's body does not run before it is first pulled, so a stream
 * that is created and never consumed opens nothing and leaks nothing.
 *
 * **It is released on every way a turn ends**: the stream completing, the
 * runtime throwing, and the consumer calling `return()` (a `for await` break, or
 * an interrupt). All three run the `finally`. The one way that skips it, a
 * consumer that drops the stream without `return()`, is bounded by the
 * service's two-hour idle ceiling.
 *
 * @module services/core/keep-awake/hold-during-turn
 */
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  keepAwakeService,
  type KeepAwakeService,
  type TurnAwakeHold,
} from './keep-awake-service.js';

const NO_OP_HOLD: TurnAwakeHold = { touch: () => {}, release: () => {} };

/** Reads whether a session's agent is paused. Never expected to throw. */
type IsPaused = (sessionId: string) => boolean;

/** Ask whether a session's agent is paused; a probe that throws reads as "no". */
function pausedNow(isPaused: IsPaused | undefined, sessionId: string): boolean {
  try {
    return isPaused?.(sessionId) === true;
  } catch {
    return false;
  }
}

async function* holdDuring(
  service: Pick<KeepAwakeService, 'holdTurn'>,
  runtime: AgentRuntime,
  sessionId: string,
  opts: MessageOpts | undefined,
  source: AsyncIterable<StreamEvent>,
  isPaused: IsPaused | undefined,
  selfStarted = false
): AsyncGenerator<StreamEvent> {
  // The service already contains its own failures; this guards the seam as
  // well, because this wrapper sits in the path of every turn and must never
  // change what a turn produces or how it ends.
  let hold: TurnAwakeHold;
  try {
    hold = service.holdTurn({
      sessionId,
      room: opts?.roomTurn !== undefined,
      ...(selfStarted ? { selfStarted } : {}),
      isHelperWorking: () => runtime.isHelperWorking?.(sessionId) === true,
      // A paused agent's background work keeps nothing awake either.
      holdsBackgroundWork: () =>
        !pausedNow(isPaused, sessionId) && runtime.holdsBackgroundWork?.(sessionId) === true,
    });
  } catch {
    hold = NO_OP_HOLD;
  }
  try {
    for await (const event of source) {
      try {
        hold.touch();
      } catch {
        // Counting is never worth a turn.
      }
      yield event;
    }
  } finally {
    try {
      hold.release();
    } catch {
      // Counting is never worth a turn.
    }
  }
}

/**
 * Hold one turn the agent started on its own, unless its agent is paused.
 *
 * @param service - The keep-awake service.
 * @param runtime - The runtime the turn runs on.
 * @param sessionId - The session the turn belongs to.
 * @param events - The turn's events.
 * @param isPaused - Whether the session's agent is paused.
 */
async function* holdRuntimeTurn(
  service: Pick<KeepAwakeService, 'holdTurn'>,
  runtime: AgentRuntime,
  sessionId: string,
  events: AsyncIterable<StreamEvent>,
  isPaused: IsPaused | undefined
): AsyncGenerator<StreamEvent> {
  if (pausedNow(isPaused, sessionId)) {
    yield* events;
    return;
  }
  yield* holdDuring(service, runtime, sessionId, undefined, events, isPaused, true);
}

/**
 * Wrap a runtime so each of its turns keeps the computer awake while it runs,
 * and for as long as background work it leaves behind is still going.
 *
 * @param runtime - The runtime to wrap.
 * @param service - The keep-awake service; the process singleton by default.
 * @param isPaused - Whether a session's agent is paused. A turn the agent
 *   starts on its own for a paused agent is not held, and a paused agent's
 *   background work holds nothing. Dispatched turns need no such check: the
 *   pause hold outside this one refuses them first.
 * @returns A proxy over the runtime that counts its turns.
 */
export function holdAwakeDuringTurns(
  runtime: AgentRuntime,
  service: Pick<KeepAwakeService, 'holdTurn'> = keepAwakeService,
  isPaused?: IsPaused
): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (
          sessionId: string,
          content: string,
          opts?: MessageOpts
        ): AsyncGenerator<StreamEvent> =>
          holdDuring(
            service,
            target,
            sessionId,
            opts,
            target.sendMessage(sessionId, content, opts),
            isPaused
          );
      }
      if (prop === 'onRuntimeTurn' && typeof target.onRuntimeTurn === 'function') {
        const subscribe = target.onRuntimeTurn.bind(target);
        return (listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void) =>
          subscribe((sessionId, events) =>
            listener(sessionId, holdRuntimeTurn(service, target, sessionId, events, isPaused))
          );
      }
      // Receiver is the real target (not the proxy) so getters/methods that
      // touch private fields resolve against the instance that owns them.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
