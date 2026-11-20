/**
 * A thread's own heavy calls share its turn (DOR-4209).
 *
 * An agent can send two heavy shell calls in one batch. With one slot, the first takes it and the
 * second waits for it; if the runtime waits for every call's hook before running any of them, the
 * first never runs, never gives the slot back, and the chat, and every heavy job behind it on the
 * computer, waits until the hard cap. So a call never waits behind a slot its own thread holds:
 *
 * - While the thread is still in line, a second call waits with the first, on the same ticket, and
 *   both go on when that ticket is granted.
 * - Once the thread holds the slot, a new call of its own joins it and goes on at once.
 * - The slot comes back when the LAST call sharing it gives it back. A call that stops waiting
 *   leaves on its own; the last one to leave takes the ticket out of line.
 *
 * **A thread, not a chat.** The share key names one runtime, one chat and one agent thread in it:
 * the main thread, or one helper. A chat's helpers run side by side, so sharing by chat would let
 * every helper's heavy job ride one slot on a busy computer, and keep it held while any of them
 * runs. Each helper takes its own turn instead; the runtime in the key keeps one runtime's ids from
 * ever meeting another's. Still one turn at a time per machine: everyone else waits behind it.
 *
 * @module services/core/load-gate/chat-turns
 */
import type { HeldSlot, WaitOptions, WaitRequest, WaitStatus } from './load-gate.js';

/** The error a stopped wait rejects with. */
export function abortError(): DOMException {
  return new DOMException('The wait for a heavy-job slot was stopped.', 'AbortError');
}

/** One thread's place in line, then its slot, and the calls sharing them. */
interface Turn {
  /** Calls still waiting for the slot, one entry per join, with each one's progress handler. */
  waiting: Map<symbol, WaitOptions['onWait']>;
  /** Calls holding the granted slot. */
  holders: number;
  /** Stops the one shared wait, once every call has left it. */
  stop: AbortController;
  /** The shared wait. */
  done: Promise<HeldSlot>;
  /** The slot, once granted. */
  granted?: HeldSlot;
}

/** Joining a thread's turn. */
export interface ChatTurns {
  /**
   * Wait for this thread's turn, sharing any wait or slot the thread already has.
   *
   * @param key - The thread the call belongs to: runtime, chat and agent thread.
   * @param request - The job, for a new wait.
   * @param options - This call's own cancellation and progress.
   * @returns This call's share of the slot; giving it back frees the slot when it is the last.
   */
  join(key: string, request: WaitRequest, options: WaitOptions): Promise<HeldSlot>;
}

/** `promise`, or an `AbortError` as soon as `signal` fires, whichever comes first. */
function untilOrAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Build the shared turns over one gate's own wait.
 *
 * @param wait - The gate's unshared wait for one slot.
 * @param report - Tells one progress handler how a wait is going, never throwing.
 */
export function createChatTurns(
  wait: (request: WaitRequest, options: WaitOptions) => Promise<HeldSlot>,
  report: (onWait: WaitOptions['onWait'], status: WaitStatus) => void
): ChatTurns {
  const turns = new Map<string, Turn>();
  const forget = (key: string, turn: Turn): void => {
    if (turns.get(key) === turn) turns.delete(key);
  };
  /** Nobody waits for the turn or holds its slot. */
  const empty = (turn: Turn): boolean => turn.waiting.size === 0 && turn.holders === 0;

  const open = (key: string, request: WaitRequest, token: symbol, first: WaitOptions): Turn => {
    const base = {
      waiting: new Map([[token, first.onWait]]),
      holders: 0,
      stop: new AbortController(),
    };
    const done = wait(request, {
      signal: base.stop.signal,
      // Each distinct handler once: two calls from one thread would say the same thing twice.
      onWait: (status) => {
        for (const onWait of new Set(base.waiting.values())) report(onWait, status);
      },
    });
    const turn: Turn = Object.assign(base, { done });
    turns.set(key, turn);
    done.then(
      (slot) => {
        turn.granted = slot;
        // Granted in the same moment the last call left: nobody will ever hold it.
        if (turns.get(key) !== turn && empty(turn)) slot.release();
      },
      () => forget(key, turn)
    );
    return turn;
  };

  /** A call left before holding: the last one out takes the ticket, or the unheld slot, with it. */
  const abandon = (key: string, turn: Turn): void => {
    if (!empty(turn)) return;
    forget(key, turn);
    if (turn.granted === undefined) turn.stop.abort();
    else turn.granted.release();
  };

  const hold = (key: string, turn: Turn): HeldSlot => {
    const slot = turn.granted!;
    turn.holders += 1;
    let released = false;
    return {
      waitedMs: slot.waitedMs,
      outcome: slot.outcome,
      heartbeat: () => !released && slot.heartbeat(),
      release: () => {
        if (released) return;
        released = true;
        turn.holders -= 1;
        // Calls already granted but not yet holding still count: they are about to.
        if (!empty(turn)) return;
        forget(key, turn);
        slot.release();
      },
    };
  };

  return {
    async join(key, request, options) {
      if (options.signal?.aborted) throw abortError();
      const token = Symbol('join');
      const existing = turns.get(key);
      const turn = existing ?? open(key, request, token, options);
      if (existing !== undefined && turn.granted === undefined) {
        turn.waiting.set(token, options.onWait);
      }
      if (turn.granted === undefined) {
        let left = true;
        try {
          await untilOrAbort(turn.done, options.signal);
          left = false;
        } finally {
          turn.waiting.delete(token);
          if (left) abandon(key, turn);
        }
      }
      return hold(key, turn);
    },
  };
}
