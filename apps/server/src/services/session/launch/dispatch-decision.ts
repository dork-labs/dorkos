/**
 * The dispatch handshake's waiting half (spec `warm-process-lifecycle` D2,
 * DOR-2065): start a runtime's stream and learn, before any turn is shown,
 * whether it may start or must stay queued behind the agent's background work.
 *
 * @module services/session/launch/dispatch-decision
 */
import type { DispatchHoldHandshake } from '@dorkos/shared/agent-runtime';
import type { QueuedWaitingOn, StreamEvent } from '@dorkos/shared/types';

/**
 * How long a runtime may take to answer the dispatch handshake before the turn
 * starts anyway. Far past the settle interval and a launch resolution; reached
 * only if a runtime forgets to answer, and then the turn simply starts late.
 */
export const DISPATCH_DECISION_TIMEOUT_MS = 30_000;

/**
 * Start a runtime's stream and wait for its answer to the dispatch handshake
 * before anything is shown (spec `warm-process-lifecycle` D2, DOR-2065).
 *
 * The runtime answers `proceed()` or `hold(waitingOn)` before its stream yields
 * anything. The first event, an end or a throw also count as "go ahead", so a
 * runtime that never answers costs nothing but the timeout. On `go`, the
 * returned stream replays the event already pulled and continues the same
 * generator; a throw surfaces from it exactly as from the runtime's own stream.
 *
 * @param start - Calls the runtime with the handshake
 * @param timeoutMs - Bound on waiting for an answer
 */
export async function awaitDispatchDecision(
  start: (hold: DispatchHoldHandshake) => AsyncGenerator<StreamEvent>,
  timeoutMs = DISPATCH_DECISION_TIMEOUT_MS
): Promise<{ held: QueuedWaitingOn } | { stream: AsyncIterable<StreamEvent> }> {
  let held: QueuedWaitingOn | undefined;
  let decide!: () => void;
  const decided = new Promise<void>((resolve) => {
    decide = resolve;
  });
  const generator = start({
    proceed: () => decide(),
    hold: (waitingOn) => {
      held ??= waitingOn;
      decide();
    },
  });
  const first = generator.next();
  // A throw is the turn's to report, through the stream below.
  const firstSettled = first.then(
    () => undefined,
    () => undefined
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    decided,
    firstSettled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (held !== undefined) {
    // The runtime ends its stream after holding; let it finish.
    await firstSettled;
    return { held };
  }
  return {
    stream: (async function* () {
      const result = await first;
      if (result.done) return;
      yield result.value;
      yield* generator;
    })(),
  };
}
