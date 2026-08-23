/**
 * The wall clock behind every Stop (DOR-1244).
 *
 * **The property: Stop is bounded.** Once a person presses Stop, the turn ends
 * within a small, named window whatever the CLI is doing — including the case
 * where the CLI can no longer hear DorkOS at all.
 *
 * That case is real, and it is DorkOS's own doing. At the `result` a turn is
 * taken to end on, `settleStdinAtResult` closes the held prompt, which sends the
 * CLI subprocess's stdin an EOF (`messaging/stdin-hold.ts`). The CLI can keep
 * going past that EOF — a background shell's notification, a hook — and reopen
 * the turn window (DOR-1100), so the cockpit shows a running turn with a Stop
 * button on it while the SDK's control channel is already gone. A control
 * request made then is dropped in silence by the SDK's transport ("Dropping
 * write to ended stdin stream", `ProcessTransport.write`, no throw), while
 * `Query.request()` hands back a promise with no timeout of its own — one that
 * only an ack can settle. The SDK rejects those pending entries in exactly one
 * place, `performCleanup`: when the process finally exits, or when somebody
 * calls `close()`. So `await query.interrupt()` waits for ever, the `close()`
 * escalation written behind it is unreachable, and `POST /interrupt` hangs with
 * it — Stop does nothing until the CLI ends on its own.
 *
 * Only a clock can break that tie, because each side of it is waiting on the
 * other. This module is that clock and nothing more: WHAT to do when no ack
 * comes is the caller's decision, and the two callers decide differently (see
 * `session-store.ts` — a Stop escalates to `close()`, a task stop does not).
 *
 * @module services/runtimes/claude-code/sessions/bounded-stop
 */

/**
 * How long a stop's control request may go unanswered before its caller gives
 * up on the graceful path.
 *
 * An interrupt is one JSON line written to an already-open pipe and answered by
 * the CLI's control handler without the model being involved, so a healthy
 * subprocess acks it in milliseconds.
 *
 * **This bound is not free, and the cost is not confined to the wind-down it
 * was written for.** `interruptGivenQuery` is the bounded Stop for EVERY phase
 * of a turn (`meta/chat-capabilities.md` §1). In the wind-down the graceful
 * attempt is already undeliverable, so expiring it loses nothing. In the other
 * phases the CLI is alive and would very likely have acked, and expiring on a
 * healthy-but-slow one KILLS a process that was about to stop politely. What
 * that forfeits is real: the CLI's own interrupt sentinel on each pending call,
 * the `result.terminal_reason` the turn would have settled with, and the
 * `[Request interrupted by user]` marker the CLI writes into its own transcript
 * — so a reader of that transcript sees no sign the turn was cut short. And the
 * channel genuinely can be slow under load: this repo already allows 8 s for a
 * control round-trip on the same pipe (`CONTEXT_USAGE_TIMEOUT_MS`,
 * `message-sender.ts`).
 *
 * Three seconds anyway, because the person is the tighter constraint: a Stop
 * that has visibly done nothing for longer than that reads as broken, and
 * pressing it again is the natural response. The trade is bounded on the other
 * side too — the live settle is honest either way ON THE RESUME PATH, where a
 * turn ended by an escalated close is reported as `interrupted` rather than as
 * finished (`messaging/message-sender.ts`, DOR-1244); the persistent pump does
 * not run that loop and still settles a killed process as a crash, which is a
 * named DOR-1244 follow-up. **That follow-up got more urgent when
 * `persistentSession` graduated to ON** (spec `full-power-defaults`, D1): the
 * pump is now the path a default install takes, so the honest-settle gap is on
 * the common path rather than the opt-in one. On the resume path a premature
 * escalation still costs only the CLI's transcript marker and a warm process,
 * not the operator's understanding of what just happened.
 *
 * Revisit this number with measurements of real ack latency under load, not
 * with an argument.
 */
export const STOP_ACK_TIMEOUT_MS = 3_000;

/** What a bounded stop request concluded. */
export type StopAck =
  /** The CLI answered: the stop was delivered. */
  | 'acked'
  /** The CLI, or the SDK on its behalf, answered with a failure. */
  | 'refused'
  /** Nothing answered inside the bound — which says nothing about whether it ever will. */
  | 'unacked';

/**
 * Make one stop-shaped control request against a wall clock.
 *
 * Never throws, and never leaves a live timer behind, whichever way it goes.
 * Two details are load-bearing rather than merely defensive:
 *
 * - The request is INVOKED here rather than passed in as a promise, so a
 *   synchronous throw from it becomes a `refused` like any other failure
 *   instead of escaping past the bound this function exists to provide.
 * - The losing promise keeps a rejection handler. A caller that escalates to
 *   `query.close()` makes the SDK reject every pending control response
 *   ("Query closed before response received") — a rejection that lands after
 *   this function has already returned, and would otherwise be unhandled.
 *
 * @param request - The control call to make, e.g. `() => query.interrupt()`.
 * @param timeoutMs - The bound to hold it to; defaults to {@link STOP_ACK_TIMEOUT_MS}.
 * @returns How the request settled, or `unacked` when the bound won.
 */
export async function awaitStopAck(
  request: () => Promise<unknown>,
  timeoutMs: number = STOP_ACK_TIMEOUT_MS
): Promise<StopAck> {
  const settled: Promise<StopAck> = (async () => request())().then(
    () => 'acked' as const,
    () => 'refused' as const
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const expiry = new Promise<StopAck>((resolve) => {
      timer = setTimeout(() => resolve('unacked'), timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([settled, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
