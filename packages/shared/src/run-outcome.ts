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
 *   `cancelled` by its caller and must never also read as failed. Those reasons
 *   answer SHAPE and not intent, so the carve-out asks a second question before
 *   it excuses anything — see {@link isUnrequestedAbortFailure}, which is what
 *   keeps an abort nobody asked for from being filed as a stop.
 * - **A recovered error is not a failure.** A runtime that reports a mid-turn
 *   error and then completes the turn normally (`terminalReason: 'completed'`,
 *   e.g. a Codex `item_error` the turn recovers from) did the work.
 *
 * ## Alignment with `deriveTurnEndLifecycle`
 *
 * The chat projector's derivation once treated ONLY `terminalReason === 'error'`
 * as terminal, so an SDK-named reason on a failing result (`api_error`,
 * `model_error`, `turn_setup_failed`, …) beat the error latch and the session
 * settled idle — the same shape this module closed for run rows. It now shares
 * this module's core (DOR-1676, via {@link isAbsolvingTerminalReason} and
 * {@link isNonFatalErrorCode}): the frame decides, the reason absolves. One
 * ordering difference remains, deliberately: the projector checks its error
 * latch before the abort reasons, so a `status_change{lifecycle:'error'}`
 * followed by an abort still settles `error` there ("a failure is more
 * specific than a stop"), while this module checks the stop first — a
 * stopped RUN is recorded `cancelled` by its caller and must never also read
 * as failed. A lifecycle and a run row answer different questions; the shared
 * part is what counts as a failure, not which signal outranks which.
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
 *   `background_requested` all ride `SDKResultSuccess`; for two of the three the
 *   turn handed work off and will be back (DOR-1100), and the third is benign
 *   for a different reason — see {@link ABSOLVING_TERMINAL_REASONS}. Under an
 *   everything-else-fails fallback a recovered error followed by one of those
 *   would fail a run that succeeded.
 *
 * So: a window fails when it latched a FATAL error frame that no absolving
 * reason excuses, or when the reason is the codebase-wide `error` signal. An
 * unclassified reason absolves nothing and accuses nothing — the frame decides,
 * which is the same denylist direction {@link NON_FATAL_ERROR_CODES} documents:
 * an unclassified error is reported, because being told about a survivable
 * failure costs a retry while being told nothing about a real one costs the run.
 *
 * ## A run that was never allowed to do anything
 *
 * A third answer joined the two above (DOR-2101). A scheduled run has nobody to
 * approve a tool, so the runtime refuses every ask the moment it is raised
 * (`run-refusals`) — and a run whose tool calls were ALL refused settled to no
 * error at all, so it was written down as a success. Two real fires of one
 * mailbox schedule read nothing, refused four tools, and left two green rows;
 * a monitoring agent reporting healthy while observing nothing is worse than
 * one that plainly broke.
 *
 * So a window that latched no failure is asked a second question: was anything
 * refused for want of a person, and did NOTHING the agent actually reached for
 * succeed? Both halves are required, and both are read off the stream rather
 * than guessed:
 *
 * - **Refused** is {@link readRefusedAsk}, the same predicate the refusal log
 *   folds, so "nobody was there" means exactly one thing in both places —
 *   narrowed by {@link isRefusedTool} to the asks that are TOOLS. DorkOS
 *   refuses three things for want of a person, and a run that did all its work
 *   and then asked a question, or answered an MCP elicitation, has not lost
 *   the ability to act. Only a refused tool has. The refusal LOG still folds
 *   all three: the summary line and `tasks.ask_refused` are about what nobody
 *   answered, which is a wider question than this one.
 * - **Succeeded** is a tool frame that reports `complete` — every runtime
 *   stamps its terminal tool frame with an outcome (`tool_result` on
 *   claude-code, `tool_call_end` plus `tool_result` on codex and opencode), and
 *   a call the operator's absence refused comes back `error`, never `complete`.
 *   claude-code's `tool_call_end` says `running` on purpose (DOR-2011), so it
 *   cannot mistake a call that was about to be refused for one that worked.
 *
 * `blocked`, not `failed`, because the two need different things done about
 * them: a failed run wants debugging, and a blocked one wants the power it was
 * denied. Nothing broke — the run was simply never allowed to do its job.
 *
 * A run refused one tool that still got other work done stays `completed`: it
 * did what it could, and the refusal already leads its summary line.
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
import { isRefusedTool, readRefusedAsk } from './run-refusals.js';

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
 * Not just `completed`. The other three ride the SDK's `SDKResultSuccess`, so
 * the claude-code result mapper — which gates its error frame on the SUBTYPE,
 * not on `is_error` — emits no frame for any of them. That makes their
 * membership here inert on the default runtime today, and deliberately kept:
 * these are the shapes a runtime CAN close a deferred turn with, and the rule
 * should not depend on which of them a given SDK version happens to use.
 *
 * They are not all the same story, and the difference matters to anyone reading
 * this list as documentation:
 *
 * - `background_requested` and `tool_deferred` — the turn handed work off and
 *   WILL be back, the DOR-1100 continuation this tracker already models as a
 *   second window. Settling these as a failure would call a turn that is still
 *   working a turn that broke.
 * - `tool_deferred_unavailable` — the turn will NOT be back. The SDK reports it
 *   with `is_error: true` and a line saying the deferred tool is no longer
 *   available because its MCP server disconnected. It is here because the
 *   subtype is still `success`, so no error frame is latched and the frame rule
 *   answers "no failure" regardless; it is NOT here because the turn is coming
 *   back.
 *
 * Two more reasons are deliberately ABSENT and equally benign: the SDK's
 * `stop_hook_prevented` and `hook_stopped` also ride the success subtype and so
 * latch no frame either. They fall through to the frame rule on their own, which
 * is why they need no exoneration here.
 *
 * **Why this list is short on purpose.** It is the ABSOLVING half of the rule
 * this module founds — the outcome is decided by whether the turn carried a
 * fatal error FRAME, and a reason may only ever excuse that frame, never
 * manufacture one. The SDK's `TerminalReason` union is mostly failures
 * (`api_error`, `model_error`, `turn_setup_failed`, `prompt_too_long`,
 * `blocking_limit`, `budget_exhausted`, …), and a reason nobody has classified
 * absolves nothing and accuses nothing. So the safe direction is a short
 * allowlist of exonerations rather than a long denylist of failures that a new
 * SDK value could silently fall off (DOR-1676).
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
 * imports it, so the places that must agree about "is this error the turn
 * failing?" cannot drift. The chat pipeline joined them in DOR-1676: the session
 * normalizer's error latch and the projector's `deriveTurnEndLifecycle` both
 * read this set too. The answer an agent reply gives, the answer a scheduled
 * run's row gives and the answer a live session's lifecycle gives are one
 * answer.
 */
export const NON_FATAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'hook_failure',
  // Spelled out rather than referencing UNREADABLE_ENTRY_ERROR_CODE below: the
  // set is built at module load, before that constant exists.
  'unreadable_entry',
]);

/**
 * Whether an `error` event's code marks it as survivable rather than turn-fatal.
 *
 * @param code - The `data.code` of an `error` StreamEvent, when it has one.
 */
export function isNonFatalErrorCode(code: string | undefined): boolean {
  return code !== undefined && NON_FATAL_ERROR_CODES.has(code);
}

/**
 * The code on a client-side stand-in for a stored message or prompt the client
 * could not read (DOR-2078). It marks a note, never a failure: it is non-fatal,
 * never mirrored into `status.lastError`, and never hides the turn-failed notice.
 */
export const UNREADABLE_ENTRY_ERROR_CODE = 'unreadable_entry';

/**
 * Whether a terminal reason says the turn DID its work — so an error frame it
 * carried along the way was one it recovered from.
 *
 * Exported for `deriveTurnEndLifecycle` (the chat projector), which settles a
 * latched fatal error frame by the same frame-decides/reason-absolves rule this
 * module founds (DOR-1676).
 *
 * Read defensively rather than by narrowing, exactly as
 * `isInterruptedTerminalReason` is: `TerminalReasonSchema` is a forward-open
 * union, so an unfamiliar value is simply not an exoneration, and an `undefined`
 * reason absolves nothing.
 *
 * @param reason - The `turn_end`/`session_status` terminal reason, when carried.
 */
export function isAbsolvingTerminalReason(reason: string | undefined): boolean {
  return reason !== undefined && ABSOLVING_TERMINAL_REASONS.has(reason);
}

/**
 * Whether an abort-shaped ending is a FAILURE wearing a stop's shape — the
 * question `isInterruptedTerminalReason` cannot answer on its own.
 *
 * Every settlement reader outranks its error frame with the abort reasons, so
 * that ordering decides which of two very different turns a person is shown:
 * one they ended on purpose, and one that ended itself. The reason alone cannot
 * tell them apart — the CLI drives nine distinct abort causes through one
 * `signal.aborted` check and collapses them into two strings
 * ({@link isInterruptedTerminalReason}). The provable case is
 * `refusal-fallback-edit`: an API refusal aborts the main turn controller,
 * DorkOS never asked for a stop, and the claude-code result mapper KEEPS the
 * error frame on purpose (`sdk/sdk-error-mapping.ts`, `isStoppedTurnResult`).
 * Read as a stop, that turn was presented as one the operator stopped and its
 * explanation was erased on the way out.
 *
 * **Both halves are required, and the asymmetry between them is the design.**
 *
 * - `stopWasRequested === false` — a POSITIVE denial, never merely an absent
 *   signal. `undefined` means the runtime does not keep a stop record (codex,
 *   opencode) or the turn predates the field, and guessing "then nobody asked"
 *   would turn every abort on those runtimes into a crash. Unknown settles the
 *   way it always did.
 * - A fatal error frame — because an abort with nothing to report is a turn cut
 *   short however it happened, and `interrupted` is the honest word for it. A
 *   shutdown mid-turn is not a failure just because no person pressed Stop.
 *
 * Callers supply the frame test rather than the frame: the run tracker latches
 * only fatal frames (a survivable one never reaches it), while the two chat
 * projections hold the last frame and test it with {@link isNonFatalErrorCode}.
 * Same question, two honest ways of already knowing the answer.
 *
 * @param stopWasRequested - The `turn_end`/`session_status` stop record, when
 *   the runtime supplies one.
 * @param hasFatalErrorFrame - Whether the closing window latched an error frame
 *   that is not marked survivable.
 */
export function isUnrequestedAbortFailure(
  stopWasRequested: boolean | undefined,
  hasFatalErrorFrame: boolean
): boolean {
  return stopWasRequested === false && hasFatalErrorFrame;
}

/**
 * Read a `stopWasRequested` off any event that carries one.
 *
 * Read defensively and NOT narrowed to `session_status`, for the same reason
 * {@link readTerminalReason} is: it is latched as a PAIR with the reason it
 * arrives beside, so wherever a runtime chooses to put the reason, its intent
 * signal travels with it.
 *
 * @param event - The event to read.
 */
export function readStopWasRequested(event: StreamEvent): boolean | undefined {
  const stop = (event.data as { stopWasRequested?: unknown } | undefined)?.stopWasRequested;
  return typeof stop === 'boolean' ? stop : undefined;
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

/**
 * The frames that can report a tool call having ENDED, whichever runtime is
 * speaking. Both carry a `status`, and only `complete` on one of them is a tool
 * that did its job — see the module doc for why `tool_call_end` alone would be
 * wrong on claude-code and right on the other two.
 */
const TOOL_OUTCOME_EVENT_TYPES: ReadonlySet<StreamEvent['type']> = new Set([
  'tool_call_end',
  'tool_result',
]);

/** The `status` a tool frame carries when the call actually did its job. */
const TOOL_STATUS_COMPLETE = 'complete';

/** The line a run row shows when the runtime named nothing of its own. */
const UNNAMED_FAILURE = 'Run stopped with an error';

/**
 * How a run ended, as its row is written from.
 *
 * Three answers rather than the two this module started with, because a run
 * that was never allowed to use a tool is neither a success nor a breakage —
 * see the module doc. `cancelled` is absent on purpose: a stop is decided by
 * the caller, which knows whether DorkOS raised the abort, and never by this
 * fold.
 */
export type RunSettlement =
  /** The turn did its work, or did enough of it. */
  | { outcome: 'completed' }
  /**
   * The turn settled to an error.
   *
   * @property error - The line to write on the run row, already written for a
   *   person.
   */
  | { outcome: 'failed'; error: string }
  /**
   * Every tool the run reached for was refused because nobody was there to
   * approve it, and nothing it reached for succeeded. Nothing broke; the run
   * was never given the power to do its job.
   */
  | { outcome: 'blocked' };

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
   * @returns How the run ended. A stop is NOT one of the answers: it reports
   *   `completed` for a clean turn, a recovered mid-turn error, or a turn cut
   *   short that nobody had to be told about, and the caller records a run it
   *   stopped as `cancelled` without asking.
   */
  settle(): RunSettlement;
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
  /**
   * The stop record that arrived WITH {@link terminalReason} — latched as a
   * pair, so the intent always describes the reason it is read beside rather
   * than some earlier ending's.
   */
  let stopWasRequested: boolean | undefined;
  /** The last error frame the OPEN window carried, if any. */
  let latched: { message?: string; category?: ErrorCategory } | null = null;
  /** How the last CLOSED window settled. */
  let settled: string | null = null;
  /**
   * Whether this RUN — not this window — was refused a TOOL because nobody was
   * there to approve it.
   *
   * Run-scoped, and deliberately not reset when a window reopens. A refusal in
   * the first window and a successful tool in the second describe one run that
   * lost a tool and carried on, which is the `completed` case; forgetting the
   * refusal at the window boundary would make the answer depend on where the
   * runtime happened to split the turn.
   */
  let refusedAToolForWantOfAPerson = false;
  /** Whether any tool call in this RUN ended having actually done its job. */
  let toolSucceeded = false;

  const close = (): void => {
    if (!open) return;
    open = false;
    settled = decide();
  };

  /** Whether this event reports a tool call that ended having done its job. */
  const isToolSuccess = (event: StreamEvent): boolean => {
    if (!TOOL_OUTCOME_EVENT_TYPES.has(event.type)) return false;
    const status = (event.data as { status?: unknown } | undefined)?.status;
    return status === TOOL_STATUS_COMPLETE;
  };

  /** Apply the settlement rule to the window that is closing. */
  const decide = (): string | null => {
    // A stop, not a failure: the caller records a stopped run as `cancelled`.
    // Unless nobody asked for the abort and the window latched a fatal frame —
    // then the run really did break, and answering `null` here files it as a
    // SUCCESS. Not as `cancelled`: that status is written by a different branch
    // entirely, the one that fires when DorkOS itself raised the abort signal
    // (an operator cancel, a deadline, a shutdown). A run that aborted on its
    // own never reaches that branch, so it lands on `failure ? 'failed' :
    // 'completed'` and a 3am run that died on a refusal came back with a green
    // tick (`task-scheduler-service.ts`, `relay/task-handler.ts`).
    if (isInterruptedTerminalReason(terminalReason)) {
      return isUnrequestedAbortFailure(stopWasRequested, latched !== null)
        ? composeMessage(latched)
        : null;
    }
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
      // No `stopWasRequested` reset here, and the asymmetry with the session
      // normalizer's twin is deliberate rather than an omission. Here the record
      // is READ only from inside the abort branch of `decide()`, which needs
      // `terminalReason` to be an abort reason — and the only way to set one is
      // the pair-latch below, which rewrites the record in the same statement.
      // A stale value is therefore unreachable. The normalizer emits the field
      // INDEPENDENTLY of whether a reason arrived, so its reset is load-bearing
      // and this one would be dead code.
      if (!open && TURN_REOPENING_EVENT_TYPES.has(event.type)) {
        open = true;
        terminalReason = undefined;
        latched = null;
      }
      const reason = readTerminalReason(event);
      // Latched TOGETHER: the stop record is read off the event that named the
      // reason, so a later ending cannot inherit an earlier one's intent. An
      // event that names a reason and carries no record clears the record too,
      // which is the safe direction — unknown intent settles as a stop.
      if (reason !== undefined) {
        terminalReason = reason;
        stopWasRequested = readStopWasRequested(event);
      }
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
      const refused = readRefusedAsk(event);
      if (refused !== undefined && isRefusedTool(refused)) refusedAToolForWantOfAPerson = true;
      if (isToolSuccess(event)) toolSucceeded = true;
      if (event.type === 'done') close();
    },
    settle(): RunSettlement {
      close();
      // A failure outranks everything: a run that broke is a run that broke,
      // whatever it was also refused along the way.
      if (settled !== null) return { outcome: 'failed', error: settled };
      // Nothing broke, so the second question: was this run ever allowed to do
      // anything? See the module doc for why both halves are required.
      if (refusedAToolForWantOfAPerson && !toolSucceeded) return { outcome: 'blocked' };
      return { outcome: 'completed' };
    },
  };
}
