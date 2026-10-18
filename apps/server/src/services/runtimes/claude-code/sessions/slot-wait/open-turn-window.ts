/**
 * Opening a turn's window on a warm process, and saying why when it cannot be
 * opened (DOR-3012).
 *
 * Split out of `persistent-dispatch.ts`, which is past the line ceiling, with
 * two additions over what it did there:
 *
 * - **A full warm ceiling is a wait, and the turn says so.** The registry now
 *   waits for a slot instead of refusing (`session-pump-registry.ts`), which on
 *   its own would look like an agent that hangs. The first moment the launch
 *   starts waiting, the turn yields a `system_status` carrying
 *   {@link SLOT_WAIT_STATUS}, and again on a beat while it waits: the chat's
 *   status strip shows its words, a room says the agent is waiting, and the
 *   stall guard sees a turn that is alive.
 * - **A spent pump is replaced, not reported.** A pump can be reaped between
 *   the dispatch acquiring it and the dispatch reaching it — the idle timer, or
 *   another chat's launch reclaiming the least recently used slot, both fire
 *   across the awaits in between. The pump then refuses with "cannot go from
 *   reaped to warming", which used to reach the room as "ran into a problem".
 *   The attempt is made again, once, on a freshly acquired pump.
 *
 * @module services/runtimes/claude-code/sessions/slot-wait/open-turn-window
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { SLOT_WAIT_STATUS } from '@dorkos/shared/schemas';
import { turnNotStarted } from '../../../../session/launch/turn-not-started.js';
import { logger } from '../../../../../lib/logger.js';
import { SessionCrashLoopError } from '../session-crash-recovery.js';
import { IllegalPumpTransitionError, PumpRefusedError } from '../session-pump-contract.js';
import type { TurnWindow } from '../session-turn-windows.js';

/** What a person reads while their turn waits for a slot. */
export const SLOT_WAIT_MESSAGE = 'Waiting to start: every agent on this computer is busy.';

/** The `system_status` a turn yields while it waits for a slot. */
export function slotWaitEvent(): StreamEvent {
  return {
    type: 'system_status',
    data: { message: SLOT_WAIT_MESSAGE, status: SLOT_WAIT_STATUS },
  };
}

/**
 * How often a turn still waiting for a slot says so again. Far inside both of
 * the stall guard's windows (`SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS`, 2 min, and
 * `SESSIONS.TURN_STALL_TIMEOUT_MS`, 10 min), so a long wait is never mistaken
 * for a stalled turn.
 */
export const SLOT_WAIT_BEAT_MS = 60_000;

/**
 * The window once it opens, or `'beat'` if {@link SLOT_WAIT_BEAT_MS} passes
 * first. Rejects when the dispatch does.
 *
 * @param opened - The dispatch still opening its window
 */
async function raceBeat(opened: Promise<TurnWindow>): Promise<TurnWindow | 'beat'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const beat = new Promise<'beat'>((resolve) => {
    timer = setTimeout(() => resolve('beat'), SLOT_WAIT_BEAT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([opened, beat]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether `err` is a pump refusing because it was reaped under the dispatch.
 *
 * @param err - What the dispatch threw
 */
export function isSpentPump(err: unknown): boolean {
  return err instanceof IllegalPumpTransitionError && err.from === 'reaped';
}

/**
 * Open this turn's window, yielding {@link slotWaitEvent} if the launch has to
 * wait for a slot, and trying once more on a fresh pump if the first one was
 * reaped under it.
 *
 * @param sessionId - The session the turn is for, for the log
 * @param attempt - One dispatch. Called again on a retry, so it must acquire
 *   whatever pump the registry holds NOW, and wire `onWaiting` into it.
 * @returns The opened window
 * @throws Whatever the dispatch threw, when it was not a spent pump or the
 *   retry failed too
 */
export async function* openWindowWaitingForSlot(
  sessionId: string,
  attempt: (onWaiting: () => void) => Promise<TurnWindow>
): AsyncGenerator<StreamEvent, TurnWindow> {
  for (let tries = 1; ; tries += 1) {
    let startWaiting!: () => void;
    const waiting = new Promise<'waiting'>((resolve) => {
      startWaiting = () => resolve('waiting');
    });
    const opened = attempt(() => startWaiting());
    try {
      if ((await Promise.race([opened, waiting])) !== 'waiting') return await opened;
      // Said again on a beat while the wait lasts. Each one is proof of life to
      // the stall guard, which otherwise ends a turn that has been quiet for
      // `SESSIONS.TURN_STALL_TIMEOUT_MS` — and a full ceiling can last longer.
      for (;;) {
        yield slotWaitEvent();
        const beat = await raceBeat(opened);
        if (beat !== 'beat') return beat;
      }
    } catch (err) {
      if (tries > 1 || !isSpentPump(err)) throw err;
      logger.info(
        '[persistent-dispatch] the warm process was reaped under this turn; relaunching',
        {
          session: sessionId,
        }
      );
    }
  }
}

/**
 * Say why a dispatch never reached the process, in words a person can act on.
 *
 * Every one of these leaves this runtime's own queue alone: a row retires on
 * correlated OUTPUT evidence — the `turn_start` a window mints — and none of
 * these produced one (`session-crash-recovery.ts`). The dispatcher's queue row
 * is NOT kept: it retired on the projector's own `turn_start`, before this
 * dispatch was tried. So each refusal carries `turn_not_started` and a
 * refusal kind, the turn settles `failed`, and a chat message it
 * carried is reported not delivered rather than delivered (DOR-2994).
 *
 * @param sessionId - The session whose dispatch was refused
 * @param err - What the dispatch threw
 * @param closedByStop - Whether a DorkOS Stop is what killed the process this
 *   dispatch was waiting on (`SessionBundle.closedByStop`)
 */
export function* explainRefusedDispatch(
  sessionId: string,
  err: unknown,
  closedByStop: boolean
): Generator<StreamEvent> {
  // A Stop pressed while the turn was still LAUNCHING (DOR-1302). The close
  // kills the process before `system/init`, so the launch this dispatch was
  // waiting on rejects and there is no window to stream — the settle the
  // windower already wrote into that window reaches nobody. Left to fall
  // through, this became a rethrow that `guardTurnErrors` renders as a turn
  // error with a raw `process-gone` stack, which is the exact "your agent
  // crashed" report for an operator action that this whole change removes.
  //
  // Answered as the resume path answers its own version of this: a status
  // carrying the terminal reason the CLI never got to send, plus the terminal
  // `done`. The projector settles that turn `interrupted`. No `error` frame,
  // because there is no failure to report — and `stopWasRequested` is proven
  // by the branch, not guessed (`messaging/message-sender.ts` says the same of
  // its twin).
  //
  // Deliberately narrowed to `process-gone`: it is the only refusal a close
  // produces, and a session whose LAST process a Stop killed can still meet
  // the warm ceiling or a pending interaction on this launch, which are
  // different facts and keep their own sentences below.
  if (closedByStop && err instanceof PumpRefusedError && err.reason === 'process-gone') {
    logger.debug('[persistent-dispatch] settling a stopped launch as interrupted', {
      session: sessionId,
    });
    yield {
      type: 'session_status',
      data: { sessionId, terminalReason: 'interrupted', stopWasRequested: true },
    };
    yield { type: 'done', data: { sessionId } };
    return;
  }
  if (err instanceof SessionCrashLoopError) {
    // The raw error leads with the session id, which is a UUID nobody reads.
    // The operator gets the plain sentence; the id stays in `details` and in
    // the warning `SessionCrashRecovery` already logged.
    yield* turnNotStarted(
      sessionId,
      'crash-loop',
      `This chat's agent keeps stopping, so DorkOS did not start it again. ${
        err.crash?.message ?? 'It ended without saying why.'
      } Send the message again to try once more.`,
      err.message
    );
    return;
  }
  if (err instanceof PumpRefusedError && err.reason === 'warm-ceiling') {
    // Reached only after the turn waited `SESSIONS.WARM_SLOT_WAIT_MS` for a slot
    // and none came free (DOR-3012), so it says how this ended, not "close one".
    yield* turnNotStarted(
      sessionId,
      'warm-ceiling',
      'Every agent here stayed busy too long, so this didn’t start. Send it again.',
      err.message
    );
    return;
  }
  if (err instanceof PumpRefusedError && err.reason === 'pending-interaction') {
    yield* turnNotStarted(
      sessionId,
      'pending-interaction',
      'This chat is waiting on an answer from you, so the message was not sent yet. Answer the open request and send it again.',
      err.message
    );
    return;
  }
  // Anything else is a genuine failure to launch or dispatch. Rethrow so
  // `guardTurnErrors` translates it exactly as it does on the resume path —
  // one place owns the generic translation, not two.
  throw err;
}
