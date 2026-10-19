/**
 * When a room stops listening for an agent's reply (DOR-3113).
 *
 * A room turn the agent never closes is given up on at the late-reply ceiling,
 * an hour by default. A turn waiting on a person's answer is not that: it is
 * stopped on an approval, a question or a sign-in, and it goes on the moment
 * the person answers. Giving up on it reported the turn as failed while it
 * was still parked, freed its claim, and every later mention then failed too.
 * So while the session is waiting on a person the ceiling waits again, up to
 * as long as an answer itself may take.
 *
 * @module services/rooms/turn-guards/late-reply-ceiling
 */
import { SESSIONS } from '../../../config/constants.js';

/** The ceiling's timer, which re-arms itself while a person is being waited on. */
export interface LateReplyCeiling {
  /** Stop it: the turn is over. */
  clear(): void;
}

/**
 * Arm the late-reply ceiling for one room turn.
 *
 * @param abort - Aborted when the room gives up on the turn.
 * @param ceilingMs - How long a turn may stay open on its own.
 * @param session - The turn's session, asked whether it is parked on an answer now.
 * @param now - The clock.
 */
export function armLateReplyCeiling(
  abort: AbortController,
  ceilingMs: number,
  session: { hasPendingInteractions(): boolean },
  now: () => number = Date.now
): LateReplyCeiling {
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout>;
  const arm = (ms: number): void => {
    timer = setTimeout(() => {
      const waited = now() - startedAt;
      if (
        session.hasPendingInteractions() &&
        waited < ceilingMs + SESSIONS.INTERACTION_PARK_CEILING_MS
      ) {
        arm(ceilingMs);
        return;
      }
      abort.abort();
    }, ms);
    // `unref` so a pending room turn never holds the process open on shutdown.
    timer.unref?.();
  };
  arm(ceilingMs);
  return { clear: () => clearTimeout(timer) };
}
