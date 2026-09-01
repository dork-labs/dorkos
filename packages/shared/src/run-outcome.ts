/**
 * Did a background run's turn SETTLE to a failure? — the rule the run row is
 * written from.
 *
 * A scheduled run consumes a runtime's `sendMessage` stream itself: it attaches
 * no `SessionStateProjector`, so nothing on that path had ever answered the
 * question a run row asks. It recorded `completed` whenever the stream ended
 * without a stop, which meant a run that streamed a typed `error` and then
 * ended — an expired sign-in at 3am, a model error, a hook that stopped the
 * turn — was filed in run history as a success (DOR-1658).
 *
 * ## The semantic, and where it comes from
 *
 * A run failed **iff its turn settled to an error** — never merely because an
 * error event appeared. That distinction is the session pipeline's, not a new
 * one: `feedProjector` (`apps/server/src/services/session/session-event-normalizer.ts`)
 * folds a turn's stream into windows and closes each with
 * `terminalReason ?? (sawError ? 'error' : undefined)`, and the projector's
 * `deriveTurnEndLifecycle` settles that to the `error` lifecycle. The same
 * windowing is mirrored here: a `done` closes the open window, a content event
 * arriving after it OPENS A NEW ONE (DOR-1100) and resets the latches, and the
 * end of the stream closes whatever is still open. The run's answer is the
 * outcome of the LAST window it settled, exactly as the lifecycle is.
 *
 * Two carve-outs come with it, and both are the reason "any error event" is the
 * wrong rule:
 *
 * - **A stop is not a failure.** A turn cut short reports one of
 *   {@link isInterruptedTerminalReason}'s reasons; a stopped run is recorded
 *   `cancelled` by its caller and must never also read as failed.
 * - **A recovered error is not a failure.** A runtime that reports a mid-turn
 *   error and then completes the turn normally (`terminalReason: 'completed'`,
 *   e.g. a Codex `item_error` the turn recovers from) did the work.
 *
 * ## The one deliberate difference from `deriveTurnEndLifecycle`
 *
 * That derivation treats ONLY `terminalReason === 'error'` as terminal, so any
 * other explicit reason wins over the error latch. For a session lifecycle that
 * is right — the reason it exists is to keep a stop from reading as a crash.
 * For a run row it would reproduce the very bug this closes: the Claude Code
 * SDK names its own reason on a failing result (`api_error`, `model_error`,
 * `turn_setup_failed`, …), so an auth failure carrying one would settle to
 * `completed` again on the default runtime. So a window that latched a real
 * error frame settles as a failure unless the reason says the turn was STOPPED
 * or COMPLETED. Nothing else is treated as absolution.
 *
 * Pure and environment-agnostic: it lives here because both dispatch paths need
 * it and they share no other code — the direct one in `apps/server`, the
 * relay's in `packages/relay`, which cannot import from an app at all.
 *
 * @module run-outcome
 */
import type { ErrorCategory, StreamEvent } from './schemas.js';
import { isInterruptedTerminalReason } from './schemas.js';

/**
 * The codebase-wide turn-failure signal: the `terminalReason` every runtime and
 * every injected failure closes a failed turn with. Codex sets it explicitly on
 * `turn.failed`, `guardTurnErrors` sets it on a throw, and the session
 * projector settles it as the `error` lifecycle. It is schema-valid through
 * `TerminalReasonSchema`'s open `z.string()` branch.
 */
const TERMINAL_REASON_ERROR = 'error';

/** The reason a runtime reports when a turn finished its work normally. */
const TERMINAL_REASON_COMPLETED = 'completed';

/**
 * Events that OPEN a turn window when one is not open — the runtime picking the
 * work back up after a `done` (DOR-1100). Mirrors
 * `TURN_REOPENING_STREAM_EVENT_TYPES` in the session normalizer, which is what
 * makes a continuation its own window rather than more of the closed one.
 */
const TURN_REOPENING_EVENT_TYPES: ReadonlySet<StreamEvent['type']> = new Set([
  'text_delta',
  'thinking_delta',
  'tool_call_start',
]);

/** The line a run row shows when the runtime named nothing of its own. */
const UNNAMED_FAILURE = 'Run stopped with an error';

/**
 * Folds a run's event stream into the one answer a run row needs.
 */
export interface RunOutcomeTracker {
  /**
   * Fold one event from the run's stream. Safe to call for every event; the
   * ones that say nothing about the outcome are ignored.
   *
   * @param event - The event that just arrived.
   */
  observe(event: StreamEvent): void;
  /**
   * The stream is over: settle whatever window is still open and answer how the
   * run ended.
   *
   * Idempotent — asking twice gives the same answer, because settling a window
   * closes it.
   *
   * @returns The error line to write on the run row, already written for a
   *   person, or `null` when the run did not settle to a failure (a clean turn,
   *   a recovered mid-turn error, or a stop).
   */
  settle(): string | null;
}

/**
 * Read a `terminalReason` off an event that can carry one.
 *
 * Only `session_status` does: `DoneEvent` has no such field, which is why every
 * runtime rides its outcome on a `session_status` emitted just before `done`.
 *
 * @param event - The event to read.
 */
function readTerminalReason(event: StreamEvent): string | undefined {
  if (event.type !== 'session_status') return undefined;
  const reason = (event.data as { terminalReason?: unknown }).terminalReason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Compose the line a person reads, from the error the runtime reported.
 *
 * An `auth_error` gets a lead saying what to DO, matching the words the
 * sign-in notification uses ("needs you to sign in again", DOR-1654): the raw
 * runtime text for a dead credential is often a bare `401` or an SDK subtype,
 * which tells the operator nothing about the fix.
 *
 * @param error - The error frame the window latched, if any.
 */
function composeMessage(error: { message?: string; category?: ErrorCategory } | null): string {
  const message = error?.message?.trim();
  const line = message && message.length > 0 ? message : UNNAMED_FAILURE;
  return error?.category === 'auth_error' ? `Sign in again: ${line}` : line;
}

/**
 * Track how a run's turn ends, so its row can say so honestly.
 *
 * Feed it every event the run's stream yields, then ask {@link
 * RunOutcomeTracker.settle} once the stream is over. See the module doc for the
 * settled-not-transient rule it applies and where that rule comes from.
 */
export function createRunOutcomeTracker(): RunOutcomeTracker {
  /** Whether a turn window is open right now — the thing `done` closes. */
  let open = true;
  /** The last reason the OPEN window carried, if any. */
  let terminalReason: string | undefined;
  /** The last error frame the OPEN window carried, if any. */
  let latched: { message?: string; category?: ErrorCategory } | null = null;
  /** How the last CLOSED window settled. */
  let settled: string | null = null;

  const close = (): void => {
    if (!open) return;
    open = false;
    settled = decide();
  };

  /** Apply the settlement rule to the window that is closing. */
  const decide = (): string | null => {
    // A stop, not a failure: the caller records a stopped run as `cancelled`.
    if (isInterruptedTerminalReason(terminalReason)) return null;
    if (terminalReason === TERMINAL_REASON_ERROR) return composeMessage(latched);
    // The runtime says the turn did its work, so an error it reported along the
    // way was one it recovered from.
    if (terminalReason === TERMINAL_REASON_COMPLETED) return null;
    return latched === null ? null : composeMessage(latched);
  };

  return {
    observe(event: StreamEvent): void {
      // Checked first, so the reopen's reset cannot be undone by the very event
      // that caused it.
      if (!open && TURN_REOPENING_EVENT_TYPES.has(event.type)) {
        open = true;
        terminalReason = undefined;
        latched = null;
      }
      const reason = readTerminalReason(event);
      if (reason !== undefined) terminalReason = reason;
      if (event.type === 'error') {
        const data = event.data as { message?: unknown; category?: unknown };
        latched = {
          ...(typeof data.message === 'string' ? { message: data.message } : {}),
          ...(typeof data.category === 'string'
            ? { category: data.category as ErrorCategory }
            : {}),
        };
      }
      if (event.type === 'done') close();
    },
    settle(): string | null {
      close();
      return settled;
    },
  };
}
