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
 * `completed` again on the default runtime.
 *
 * ## What decides is WHAT the error was, not which reason arrived
 *
 * The rule is founded on the error FRAME, and the reason only ever absolves.
 * Founding it the other way round — "any reason that is not `completed` fails" —
 * is wrong in both directions, and both directions were measured:
 *
 * - **It over-fires.** {@link NON_FATAL_ERROR_CODES} exists because some `error`
 *   frames are not the turn failing. A `hook_failure` is the OPERATOR'S own
 *   script exiting non-zero; the turn then ends normally carrying the whole
 *   answer. Failing the run for it is expensive, not merely untidy: a `failed`
 *   run row raises `run.completed` with `relay: 'always'`, so every over-fire is
 *   an unconditional ping.
 * - **It under-absolves.** `tool_deferred`, `tool_deferred_unavailable` and
 *   `background_requested` all ride `SDKResultSuccess` — the turn handed work
 *   off and will be back (DOR-1100). Under an everything-else-fails fallback a
 *   recovered error followed by one of those would fail a run that succeeded.
 *
 * So: a window fails when it latched a FATAL error frame that no absolving
 * reason excuses, or when the reason is the codebase-wide `error` signal. An
 * unclassified reason absolves nothing and accuses nothing — the frame decides,
 * which is the same denylist direction {@link NON_FATAL_ERROR_CODES} documents:
 * an unclassified error is reported, because being told about a survivable
 * failure costs a retry while being told nothing about a real one costs the run.
 *
 * ## What this rule cannot see
 *
 * OpenCode emits no `terminalReason` anywhere — not on `session_status`, not on
 * `done`. So on that runtime the absolving half is unreachable and the rule
 * degrades to "any fatal error frame fails the run". That is the honest ceiling
 * of what its stream says, not a decision: give it terminal reasons and the
 * recovered-error carve-out starts working there for free.
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

/**
 * Terminal reasons that say the turn DID its work, so an error frame it carried
 * along the way was one it recovered from.
 *
 * Not just `completed`. The other three ride `SDKResultSuccess`: the turn handed
 * a tool off, or moved to the background, and will be back to finish — the
 * DOR-1100 continuation this tracker already models as a second window. Calling
 * any of them a failure would fail a run that is still working.
 */
const ABSOLVING_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'completed',
  'background_requested',
  'tool_deferred',
  'tool_deferred_unavailable',
]);

/**
 * `error` events that do NOT mean the turn failed.
 *
 * A DENYLIST, not an allowlist, and the direction is the whole decision. Most
 * genuinely fatal errors carry no `code` at all, so an allowlist of "fatal
 * codes" would pass every one of them off as a success. A denylist fails the
 * other way: an error nobody has classified yet is reported as a failure, and
 * being told about a failure that was survivable costs a retry, while being told
 * nothing about a real one costs the answer.
 *
 * `hook_failure` is on it because a hook is the OPERATOR'S own script, not the
 * agent's work. The claude-code runtime escalates any non-tool hook that exits
 * non-zero (Stop, SubagentStop, SessionStart — this repo configures all three)
 * to a stream `error` event, and the turn then ends with a normal `done`
 * carrying the complete answer.
 *
 * Runtime-neutral by construction: the rule is about the code's MEANING, not
 * about which runtime emitted it. A new runtime that invents a non-fatal error
 * code adds it here; until then its errors are treated as failures, which is the
 * safe half.
 *
 * Lifted out of the relay's `agent-handler.ts` (DOR-1337 / F6), which now
 * imports it, so the two places that must agree about "is this error the turn
 * failing?" cannot drift — the answer an agent reply gives and the answer a
 * scheduled run's row gives are one answer (DOR-1658).
 */
export const NON_FATAL_ERROR_CODES: ReadonlySet<string> = new Set(['hook_failure']);

/**
 * Whether an `error` event's code marks it as survivable rather than turn-fatal.
 *
 * @param code - The `data.code` of an `error` StreamEvent, when it has one.
 */
export function isNonFatalErrorCode(code: string | undefined): boolean {
  return code !== undefined && NON_FATAL_ERROR_CODES.has(code);
}

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
 * Read a `terminalReason` off any event that carries one.
 *
 * Deliberately NOT narrowed to `session_status`, even though that is the only
 * event whose schema declares the field today — `DoneEvent` has none, which is
 * why every runtime rides its outcome on a `session_status` emitted just before
 * `done`. The session normalizer's own `readTerminalReason` reads the field off
 * whatever event it is handed, and the day a runtime starts putting it on `done`
 * a narrowed copy here would silently stop seeing outcomes the session pipeline
 * still sees. Same shape, same blindness, no drift.
 *
 * @param event - The event to read.
 */
function readTerminalReason(event: StreamEvent): string | undefined {
  const reason = (event.data as { terminalReason?: unknown } | undefined)?.terminalReason;
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
    // The one reason that accuses on its own — every runtime and every injected
    // failure sets it deliberately, and Codex's dedupe path can close a failed
    // turn with it and no frame at all.
    if (terminalReason === TERMINAL_REASON_ERROR) return composeMessage(latched);
    // The turn did its work, or handed it off and is coming back. Either way an
    // error it reported along the way is one it recovered from.
    if (terminalReason !== undefined && ABSOLVING_TERMINAL_REASONS.has(terminalReason)) return null;
    // Otherwise the FRAME decides — including when the reason is one nobody has
    // classified, which absolves nothing and accuses nothing.
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
        const data = event.data as { message?: unknown; code?: unknown; category?: unknown };
        // A survivable error is not the turn failing, so it never reaches the
        // latch — the operator's own hook script exiting non-zero must not turn
        // a complete answer into a failed run.
        if (!isNonFatalErrorCode(typeof data.code === 'string' ? data.code : undefined)) {
          latched = {
            ...(typeof data.message === 'string' ? { message: data.message } : {}),
            ...(typeof data.category === 'string'
              ? { category: data.category as ErrorCategory }
              : {}),
          };
        }
      }
      if (event.type === 'done') close();
    },
    settle(): string | null {
      close();
      return settled;
    },
  };
}
