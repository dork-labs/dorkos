/**
 * The wall clock behind every control request (DOR-1244, DOR-1301).
 *
 * **The property: no control request outlives a bound.** Whatever DorkOS asks a
 * running CLI to do out of band — stop, change permission mode, swap the model,
 * reload plugins — it either gets an answer within a small, named window or
 * gives up and says so. Nothing waits for ever, including the case where the CLI
 * can no longer hear DorkOS at all.
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
 * comes is the caller's decision, and the callers decide differently (see
 * `session-store.ts` — a Stop escalates to `close()`, a task stop does not; and
 * `launch-live-settings.ts`, where an unanswered setter downgrades the
 * fingerprint instead of failing the turn).
 *
 * Every bound in the runtime is declared here rather than beside its call site,
 * so the whole property can be audited by reading one file.
 *
 * @module services/runtimes/claude-code/sessions/bounded-control
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
 * named DOR-1244 follow-up (`persistentSession` ships OFF). So on the path that
 * ships, a premature escalation costs the CLI's transcript marker and a warm
 * process, not the operator's understanding of what just happened.
 *
 * Revisit this number with measurements of real ack latency under load, not
 * with an argument.
 */
export const STOP_ACK_TIMEOUT_MS = 3_000;

/**
 * **What this bound does NOT bound** (DOR-1319).
 *
 * It bounds the ACK, and only the ack. What a person waits through after
 * pressing Stop is three segments end to end, and DorkOS owns one of them:
 *
 * | Segment                      | Bounded by                                     |
 * | ---------------------------- | ---------------------------------------------- |
 * | request sent → ack           | {@link STOP_ACK_TIMEOUT_MS}                    |
 * | ack → the CLI's own `result` | nothing here; it is the CLI winding down       |
 * | that `result` → `turn_end`   | on the pump, the closing window's accounting   |
 *
 * The clock on the first segment starts at the true send:
 * {@link awaitControlAck} invokes the request itself and arms the timer in the
 * same synchronous block, so there is no queue-then-measure gap to blame. What
 * the clock cannot see is a starved event loop — the timer rides the same loop
 * the ack does, so under real load the bound inflates along with everything
 * else, and no clock inside this process can subtract that out. The stop path
 * therefore MEASURES the ack and says so when it ran long
 * ({@link STOP_ACK_SLOW_MS}), which is what makes a slow Stop attributable
 * afterwards instead of guessed at.
 *
 * The third segment used to be the largest: two control round-trips on their
 * own 8 s budget, run after the turn was already over. A window closing on a
 * stopped turn now skips them (`sessions/session-turn-windows.ts`).
 */

/**
 * How long a stop's ack may take before it is worth a line in the log.
 *
 * A healthy interrupt is answered in milliseconds, so a full second is already
 * far outside normal and a third of the bound that follows it. Below this the
 * latency is recorded at debug and nothing more; above it, the log names the
 * number — so a Stop that took seconds can be split into "the CLI was slow to
 * hear us" and "the CLI was slow to wind down" from the log alone, which is the
 * question a 7.6 s Stop left unanswerable (DOR-1319).
 */
export const STOP_ACK_SLOW_MS = 1_000;

/**
 * How long a live permission-mode change may go unanswered before `PATCH
 * /api/sessions/:id` stops waiting on it.
 *
 * The same one-line control round-trip as an interrupt, so the same three
 * seconds, and for the same reason: a person is sitting in front of this one,
 * watching a control they just moved. Nothing is killed and nothing is reverted
 * when it expires — the new mode is already persisted before the live call is
 * made (write-through, ADR-0260), so it takes effect on the next turn either
 * way.
 *
 * **What expiring costs is not symmetric, and the expensive direction is the
 * safety-relevant one.** LOOSENING an unanswered mode costs a turn of extra
 * prompts and nothing else. TIGHTENING one — `bypassPermissions` back to
 * `default` — leaves the gate held by the CLI, not by DorkOS: under bypass the
 * CLI never calls `canUseTool` at all (`launch-resolver.ts`,
 * `phantom-cancellation.ts`), so no in-memory mode on this side can put the
 * approval prompts back for the turn already running.
 *
 * **What the product does about that, decided in DOR-1435.** The unanswered
 * TIGHTENING is REPORTED, not escalated:
 *
 * - `updateSession` answers `permissionModePendingUntilNextTurn`, and `PATCH
 *   /api/sessions/:id` turns that into a `202` saying the new mode starts on
 *   the next reply. The old `200 {permissionMode:'default'}` stated a safety
 *   posture the agent had not adopted; a person who is told can decide.
 * - The turn is NOT killed. Ending it is the same trade `STOP_ACK_TIMEOUT_MS`
 *   weighs above, and here it comes out the other way: an escalation on this
 *   clock would destroy real work on a channel that was merely slow, while the
 *   case that actually produces unacks is the wind-down, where the turn is
 *   ending anyway and killing it buys nothing. The person keeps the Stop button
 *   — now with an honest answer in front of them — which is the same power
 *   without the false positives.
 */
export const PERMISSION_MODE_ACK_TIMEOUT_MS = 3_000;

/**
 * How long a live setter that merely flips a field — `setModel`,
 * `setPermissionMode` — may go unanswered while a dispatch waits on it.
 *
 * Nothing happens behind these but a variable assignment in the CLI, so a
 * healthy subprocess answers in milliseconds. Three seconds is the same
 * human-facing budget as a Stop, because the wait lands in the same place: a
 * person has pressed send and their message has not started yet.
 */
export const LIVE_SETTING_ACK_TIMEOUT_MS = 3_000;

/**
 * How long a live setter with real work behind it — `setMcpServers`,
 * `reloadPlugins` — may go unanswered.
 *
 * These two are not field flips. `setMcpServers` connects and disconnects
 * servers, some of them freshly spawned processes; `reloadPlugins` re-reads
 * every plugin directory from disk and restarts the servers they declare. So
 * the same three seconds would expire on a HEALTHY CLI that is simply doing what
 * it was asked. Eight seconds is this repo's existing allowance for a control
 * round-trip that has to wait on something real (`CONTEXT_USAGE_TIMEOUT_MS`,
 * `sdk/context-usage.ts`), and there is no reason for a second number.
 */
export const PLUGIN_RELOAD_ACK_TIMEOUT_MS = 8_000;

/**
 * How long a probe fired at a freshly launched subprocess — the model list, the
 * MCP status snapshot, the command and subagent lists, and the model-cache
 * warm-up's own `supportedModels()` — may go unanswered.
 *
 * Nobody is blocked on any of these: they populate caches in the background
 * while the turn streams, and the caller-facing model read
 * (`getSupportedModels`) already races the warm-up on its own 3 s clock and
 * falls through to an empty list. What the bound protects is what an unanswered
 * probe leaves behind. In the warm-up, that is `warmupPromise` pinned for the
 * life of the server — every later warm-up deduplicating onto a promise nothing
 * will settle, with the throwaway subprocess never closed. In
 * `fireLaunchProbes`, it is one permanently pending promise per probe per
 * launch, each holding its query and its closures alive.
 *
 * Ten seconds because a cold start here pays for spawning a CLI subprocess
 * before the probe is even sent, and being generous costs nothing when no
 * request is waiting on the answer.
 */
export const LAUNCH_PROBE_ACK_TIMEOUT_MS = 10_000;

/**
 * A control request went unanswered for its whole bound.
 *
 * Its own class so a caller can tell "the CLI could not hear us" apart from "the
 * CLI answered with a failure" — the two deserve different logs, and only the
 * first says anything about the health of the channel.
 */
export class ControlRequestTimeoutError extends Error {
  /**
   * Name the request that went unanswered and the bound it outlived.
   *
   * @param request - The control call, e.g. `reloadPlugins`
   * @param timeoutMs - The bound it was held to
   */
  constructor(
    readonly request: string,
    readonly timeoutMs: number
  ) {
    super(`the CLI did not answer ${request} within ${timeoutMs}ms`);
    this.name = 'ControlRequestTimeoutError';
  }
}

/** What a bounded control request concluded. */
export type ControlAck =
  /** The CLI answered: the stop was delivered. */
  | 'acked'
  /** The CLI, or the SDK on its behalf, answered with a failure. */
  | 'refused'
  /** Nothing answered inside the bound — which says nothing about whether it ever will. */
  | 'unacked';

/**
 * Make one control request against a wall clock.
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
 * The bound is always passed in, never defaulted: every call site has had to
 * choose a number and justify it, and a default would let the next one skip
 * that.
 *
 * @param request - The control call to make, e.g. `() => query.interrupt()`.
 * @param timeoutMs - The bound to hold it to, from the table above.
 * @returns How the request settled, or `unacked` when the bound won.
 */
export async function awaitControlAck(
  request: () => Promise<unknown>,
  timeoutMs: number
): Promise<ControlAck> {
  const settled: Promise<ControlAck> = (async () => request())().then(
    () => 'acked' as const,
    () => 'refused' as const
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const expiry = new Promise<ControlAck>((resolve) => {
      timer = setTimeout(() => resolve('unacked'), timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([settled, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Make one control request against a wall clock, and keep its answer.
 *
 * The sibling of {@link awaitControlAck}, for the requests whose VALUE the
 * caller needs — the model list, the reload report — where an ack alone says
 * nothing. Same two load-bearing details as its sibling: the request is invoked
 * here, so a synchronous throw is just a rejection; and the losing promise keeps
 * a rejection handler, so a request that fails after the bound expired does not
 * surface as an unhandled rejection.
 *
 * Failure is a rejection, not a sentinel, because every caller of this form
 * already has a catch that treats "no answer" as "no fresh data". A timeout
 * rejects with {@link ControlRequestTimeoutError}; a refusal rejects with
 * whatever the SDK threw.
 *
 * @param request - The control call to make, e.g. `() => query.reloadPlugins()`.
 * @param timeoutMs - The bound to hold it to, from the table above.
 * @param name - What to call the request in the timeout message.
 * @returns What the request answered.
 * @throws ControlRequestTimeoutError When nothing answered inside the bound.
 */
export async function requestWithinBound<T>(
  request: () => Promise<T>,
  timeoutMs: number,
  name: string
): Promise<T> {
  const settled: Promise<T> = (async () => request())();
  let timer: NodeJS.Timeout | undefined;
  try {
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ControlRequestTimeoutError(name, timeoutMs)), timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([settled, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
    // The request may still fail long after the bound took the decision away
    // from it. Nobody is waiting on it by then, so without this its rejection
    // is unhandled.
    settled.catch(() => {});
  }
}
