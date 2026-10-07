/**
 * Counts every agent turn for keep-awake, at the one seam every turn passes
 * through: `runtimeRegistry.register()` (DOR-1654). The interactive composer, a
 * room reply, a scheduled run and a relay delivery all resolve their runtime
 * from the registry, so a turn started anywhere is held here exactly once.
 *
 * Same Proxy shape as `traceRuntime` and `watchRuntimeSignin`: only
 * `sendMessage` is intercepted, and every other member passes straight through,
 * bound to the real runtime so its private state stays intact.
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

const originalAwakeRoomObservers = new WeakMap<
  object,
  (sessionId: string, source: AsyncGenerator<StreamEvent>) => AsyncGenerator<StreamEvent>
>();

const NO_OP_HOLD: TurnAwakeHold = { touch: () => {}, release: () => {} };

async function* holdDuring(
  service: Pick<KeepAwakeService, 'holdTurn'>,
  runtime: AgentRuntime,
  sessionId: string,
  room: boolean,
  source: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  // The service already contains its own failures; this guards the seam as
  // well, because this wrapper sits in the path of every turn and must never
  // change what a turn produces or how it ends.
  let hold: TurnAwakeHold;
  try {
    hold = service.holdTurn({
      sessionId,
      room,
      isHelperWorking: () => runtime.isHelperWorking?.(sessionId) === true,
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
 * Wrap a runtime so each of its turns keeps the computer awake while it runs.
 *
 * @param runtime - The runtime to wrap.
 * @param service - The keep-awake service; the process singleton by default.
 * @returns A proxy over the runtime that counts its turns.
 */
export function holdAwakeDuringTurns(
  runtime: AgentRuntime,
  service: Pick<KeepAwakeService, 'holdTurn'> = keepAwakeService
): AgentRuntime {
  const wrapped = new Proxy(runtime, {
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
            opts?.roomTurn !== undefined,
            target.sendMessage(sessionId, content, opts)
          );
      }
      // Receiver is the real target (not the proxy) so getters/methods that
      // touch private fields resolve against the instance that owns them.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  originalAwakeRoomObservers.set(wrapped, (sessionId, source) =>
    holdDuring(service, runtime, sessionId, true, source)
  );
  return wrapped;
}

/**
 * Apply the original keep-awake observation to an already opened native Room stream.
 * This observes the supplied stream and never enters the runtime a second time.
 *
 * @param wrapped - The actual keep-awake constructor result selected by the registry.
 * @param sessionId - Canonical session already checked by the native stream owner.
 * @param source - The original stream with the registry's inner observers applied.
 * @returns The same event sequence with an outer keep-awake lifetime.
 */
export function observeOriginalAwakeRoomRuntimeStream(
  wrapped: object,
  sessionId: string,
  source: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  const observe = originalAwakeRoomObservers.get(wrapped);
  if (!observe) throw new Error('Original keep-awake runtime wrapper required.');
  return observe(sessionId, source);
}
