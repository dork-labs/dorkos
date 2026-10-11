import { readTerminalReason, readErrorCode } from './session-event-payload-helpers.js';
import { toRawSessionEvent, type RawOf } from './session-event-map.js';
export { toRawSessionEvent } from './session-event-map.js';
import { retireOriginalRoomResponderStream } from '../../canvas/doc-channel/operations/room-current-operation.js';
import {
  ingestOriginalSessionProjection,
  requireOriginalSessionProjection,
} from '../session-state-projector.js';
import {
  readOriginalClaudeRelayProjectionProjector,
  observeOriginalClaudeRelayProjection,
  observeOriginalClaudeRelayTerminalProjection,
} from '../../runtimes/claude-code/claude-code-runtime.js';
import {
  observeOriginalRoomResponderProjection,
  settleOriginalRoomResponderProjection,
} from '../../canvas/doc-channel/operations/room-responder-operation.js';
/**
 * Normalizer from a runtime's {@link StreamEvent} stream into the
 * runtime-neutral {@link RawSessionEvent} union the projector ingests.
 *
 * Every `AgentRuntime.sendMessage` yields SDK-free DorkOS `StreamEvent`s (the
 * Claude adapter translates raw SDK `SDKMessage`s into them in
 * `sdk/event-mappers/`); this module is the SECOND, lossy hop that folds those
 * `StreamEvent`s into the smaller session-stream contract the projector and
 * every client consume. `triggerTurn` drives EVERY runtime's turns through
 * {@link feedProjector} (the single delivery path, ADR-0264), so the normalizer
 * lives beside the projector it feeds — not inside any one adapter.
 *
 * Why a separate hop instead of feeding `StreamEvent`s directly: the
 * session-stream union is intentionally smaller (text/thinking/tool/interaction/
 * status/todo/subagent/hook/memory/error/turn), runtime-neutral, and carries the
 * projector-stamped `seq`. Transient `StreamEvent`s with no durable projection
 * (sync/presence, relay receipts, raw context-usage) map to `null` and are
 * dropped. Typed `error` events are NOT dropped: they ride the durable stream
 * so live clients render the failure inline and the projector latches
 * `SessionStatus.lastError`.
 *
 * Turn boundaries are NOT carried by `StreamEvent`s. The trigger knows when a
 * turn begins (the first event of a `sendMessage` generator) and ends (the
 * `done` event), so {@link feedProjector} synthesizes `turn_start`/`turn_end`
 * around the per-event mapping.
 *
 * @module services/session/session-event-normalizer
 */
import { isNonFatalErrorCode, readStopWasRequested } from '@dorkos/shared/run-outcome';
import type { StreamEvent, TerminalReason } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { RawSessionEvent, SessionStateProjector } from '../session-state-projector.js';

/**
 * Who opened a turn window: `'runtime'` for one nobody asked for, absent (or
 * `'user'`) for the ordinary case. Derived from the durable event rather than
 * restated, so the two can never drift.
 */
export type TurnOrigin = NonNullable<RawOf<'turn_start'>['origin']>;

/**
 * The normalized event types that REOPEN a turn window when they arrive after
 * the window already closed (DOR-1100).
 *
 * ## What this is for
 *
 * The claude-code adapter emits `done` on every SDK `result`
 * (`result-event-mapper.ts`, "Always emit done"), and {@link feedProjector}
 * closes the turn on it — but the CLI can keep a turn alive past its `result`
 * when a background task's notification is queued. The agent wakes, says more,
 * calls more tools, and every one of those events used to land OUTSIDE any turn:
 * the cockpit read idle while the agent worked, and the continuation was never
 * persisted (`flushTurn` only runs for events held in an open turn). Reopening a
 * window puts the continuation back on screen, back in the lifecycle, and back
 * in history.
 *
 * ## Why exactly these three, and why nothing else
 *
 * The line is THE MODEL SPEAKING AGAIN — new prose, new reasoning, a new tool
 * call — and nothing else. It is deliberately narrower than "content", because
 * plenty of ordinary content-shaped traffic trails a `result` in a turn that is
 * genuinely over, and reopening on any of it would manufacture a window nothing
 * ever fills: a ghost window, costing a `turn_start`/`turn_end` pair on the
 * durable stream, a spurious `streaming` flicker, and an empty persisted turn,
 * on turns that were perfectly normal.
 *
 * `tool_result` and `tool_progress` are the two that look like they belong here
 * and do not. All four of these post-`done` shapes were reproduced through the
 * real mappers:
 *
 * | Trailing SDK message                                   | Maps to          |
 * | ------------------------------------------------------ | ---------------- |
 * | `user` carrying the CLI's interrupt sentinel           | `tool_result`    |
 * | `tool_use_summary` for a tool that was in flight       | `tool_result`    |
 * | `stream_event` `content_block_stop` of a live tool     | `tool_result`    |
 * | `tool_progress` from a long-running tool               | `tool_progress`  |
 *
 * The first is pinned on `main` by `message-sender-phantom-cancellation.test.ts`
 * ("surfaces but does NOT steer a phantom arriving after the result message"),
 * and `message-sender`'s own `sawResult` guard exists precisely because that
 * ordering is real. All four are a tool call that was already running when the
 * `result` landed, reporting in afterwards — the turn settling, not restarting.
 *
 * The rest are bookkeeping ABOUT a turn rather than a turn:
 *
 * - **`status_change`** — `mapResultEvent` emits the terminal `session_status`
 *   BEFORE `done`, but a `rate_limit_event` can land after it, and the projector
 *   merges it into the held status either way.
 * - **`system_status`** — the phantom-cancellation notice (DOR-1087) is yielded
 *   deliberately AFTER its message's mapped events, so it is guaranteed to be
 *   able to trail a terminal `done`. An operator note, not work.
 * - **`subagent_update`** — a background child starting, reporting, or finishing
 *   is precisely the "idle, but children are still live" state; the projector's
 *   `runningSubagentCount` carries it, and drawing a turn around it would claim
 *   the agent is talking when it is not.
 * - **`error`** — `message-sender` orders every error BEFORE the terminal `done`
 *   on purpose ("nothing may follow done"). One arriving after is a stream-death
 *   artifact, and wrapping it in a fresh window would invent a turn that failed.
 * - Todo/hook/memory/compaction/interaction/sign-in/UI-command members are all
 *   either bookkeeping or a card, and none of them is the model talking.
 *
 * The narrowing costs nothing against the incident this exists for: a genuine
 * wake-up is the agent REACTING to a notification, which starts with reasoning,
 * prose, or a fresh tool call — all three still here.
 *
 * ## Why this is keyed on the StreamEvent, not the normalized member
 *
 * Because the normalizer ERASES the distinction this rule turns on.
 * `tool_call_start` (the model opening a NEW call) and `tool_call_delta` (an
 * already-open call streaming its arguments, or an `assistant` message
 * backfilling them) both normalize to one `tool_call` member — so a set keyed on
 * the normalized type cannot tell "the agent started something" from "the thing
 * it already started is still arriving". Two shapes exploit that gap, both
 * reproduced: a `content_block_delta{input_json_delta}` for a tool still open at
 * the `result`, and the `assistant` arm's input backfill for an id `toolState`
 * already knows — whose `content_block_start` was in the window that just
 * closed, so it is perfectly capable of being the first event after one.
 *
 * Reading the StreamEvent keeps the discriminant intact and costs nothing: this
 * predicate runs one line above the normalization anyway.
 */
export const TURN_REOPENING_STREAM_EVENT_TYPES: ReadonlySet<StreamEvent['type']> = new Set([
  'text_delta',
  'thinking_delta',
  'tool_call_start',
]);

/**
 * Drive a single triggered turn through the projector: emit `turn_start`,
 * normalize and ingest each `StreamEvent`, then emit `turn_end` when the turn's
 * `done` event arrives (or when the stream ends without one). The last-seen
 * `terminalReason` (carried on `session_status`/`done`) is attached to
 * `turn_end`; when none was carried but the turn yielded a typed `error`, the
 * error latch fills `terminalReason: 'error'` so the failure settles instead
 * of reading idle.
 *
 * ## One stream, one or more turn WINDOWS
 *
 * A `done` closes the window that is currently open. A `done` with no open
 * window is a no-op — never a second `turn_end` for the same window, never a
 * crash (spec `persistent-session-runtime` P0 / task 0.1; F5). The `finally`
 * closes whatever is still open, so the projection can never be left
 * `streaming`.
 *
 * A stream can carry MORE than one window, because the CLI can keep a turn alive
 * past the `result` DorkOS closed on: a queued background-task notification
 * wakes the agent and it keeps working. A content event arriving after the
 * window closed OPENS A NEW ONE ({@link TURN_REOPENING_STREAM_EVENT_TYPES}, DOR-1100),
 * so the continuation streams live, puts the lifecycle back to `streaming`, and
 * is persisted as its own turn when its own `done` (or the end of the stream)
 * closes it. The invariant that holds throughout is the spec's C2: exactly one
 * `turn_end` per window, however many native `result`s the backend produced.
 *
 * A reopened window resets the per-window latches, which is what makes it a
 * window rather than a continuation of the closed one: the previous window's
 * `terminalReason` and `error` belonged to the turn that already ended, and
 * carrying either forward would settle the new work as failed or interrupted
 * before it produced anything. Only the FIRST window notifies `onTurnStart` —
 * the caller's turn identity is the turn it triggered, not one the runtime
 * started on its own.
 *
 * This is the call site task #6 uses to make the message POST trigger-only:
 * pass it the runtime's `sendMessage(...)` generator so the turn is projected
 * once and read back over `subscribeSession`. It is also reusable for
 * externally-driven turns once JSONL deltas are re-expressed as `StreamEvent`s.
 *
 * @param projector - The session's projector (from `getOrCreateProjector`).
 * @param events - The adapter's `StreamEvent` stream for one turn.
 * @param opts.userMessage - The user message that triggered this turn, carried
 *   on the synthesized `turn_start` so log-backed runtimes can reconstruct the
 *   user side of the conversation from the EventLog alone (the POST is
 *   trigger-only, so the durable stream is the only place it can ride).
 * @param opts.origin - Who opened this window. Omit for the ordinary case, a
 *   turn a person or a caller triggered. Pass `'runtime'` for a window NOBODY
 *   asked for: the persistent pump's synthetic turn around a `result` that
 *   answers no dispatch, which must reach the stream (the durable stream is a
 *   complete account of the session) without being disguised as a person's
 *   turn. It is the same field, and the same rules, as the DOR-1100 reopen a
 *   few lines below.
 * @param opts.onTurnStart - Receives the `seq` this turn's `turn_start` was
 *   stamped with — the turn's identity, for a caller that also reads the stream
 *   and has to know which turn on it is the one it started. Called
 *   SYNCHRONOUSLY, in the same block as the ingest, so it always runs before any
 *   subscriber's continuation can observe the event; a caller may therefore
 *   treat "a `turn_start` arrived and I still have no identity" as proof the
 *   turn is somebody else's.
 */
/** Opaque identity minted only by the actual feedProjector drive of an original Relay stream. */
export interface OriginalSessionProjectionFeed {
  readonly kind: 'original-session-projection-feed';
}
const originalSessionProjectionFeeds = new WeakMap<
  OriginalSessionProjectionFeed,
  {
    stream: object;
    projector: SessionStateProjector;
    active: boolean;
    closed: boolean;
    start?: SessionEvent;
    end?: SessionEvent;
  }
>();
/** Require the original stream and projector association for a projection feed. */
export function requireOriginalSessionProjectionFeed(
  token: OriginalSessionProjectionFeed,
  stream: object,
  projector: SessionStateProjector,
  event: SessionEvent
): void {
  const own = originalSessionProjectionFeeds.get(token);
  if (
    !own ||
    !own.active ||
    own.stream !== stream ||
    own.projector !== projector ||
    own.start !== event
  )
    throw new Error('Original active session projection feed required');
  requireOriginalSessionProjection(projector, event);
}

/** Fixed original feed cleanup completed; inactive alone does not prove successful cleanup. */
export function requireOriginalClosedSessionProjectionFeed(
  token: OriginalSessionProjectionFeed,
  stream: object,
  projector: SessionStateProjector,
  start: SessionEvent,
  end: SessionEvent
): void {
  const own = originalSessionProjectionFeeds.get(token);
  if (
    !own ||
    own.active ||
    !own.closed ||
    own.stream !== stream ||
    own.projector !== projector ||
    own.start !== start ||
    own.end !== end
  )
    throw new Error('Original positively closed projection feed required');
  requireOriginalSessionProjection(projector, start);
  requireOriginalSessionProjection(projector, end);
}

/** Feed runtime events into the owning session projector. */
export async function feedProjector(
  projector: SessionStateProjector,
  events: AsyncIterable<StreamEvent>,
  opts: {
    userMessage?: string;
    origin?: TurnOrigin;
    onTurnStart?: (seq: number) => void;
    originalRoomStream?: object;
  } = {}
): Promise<void> {
  const relayProjector = readOriginalClaudeRelayProjectionProjector(events);
  if (relayProjector && relayProjector !== projector)
    throw new Error('Original Relay projector differs');
  const relayFeed: OriginalSessionProjectionFeed | undefined = relayProjector
    ? Object.freeze({ kind: 'original-session-projection-feed' })
    : undefined;
  const relayOwn = relayFeed
    ? {
        stream: events as object,
        projector,
        active: true,
        closed: false,
        start: undefined as SessionEvent | undefined,
        end: undefined as SessionEvent | undefined,
      }
    : undefined;
  if (relayFeed && relayOwn) originalSessionProjectionFeeds.set(relayFeed, relayOwn);
  const start: RawOf<'turn_start'> = {
    type: 'turn_start',
    ...(opts.userMessage !== undefined ? { userMessage: opts.userMessage } : {}),
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  };
  // Two statements, and they must stay two. Folded into
  // `opts.onTurnStart?.(projector.ingest(start).seq)` the optional CALL
  // short-circuits its own arguments, so a caller that passed no callback — which
  // is every caller but the room — never opened its turn at all.
  const ingest = (raw: RawSessionEvent) =>
    opts.originalRoomStream || relayFeed
      ? ingestOriginalSessionProjection(projector, raw)
      : projector.ingest(raw);
  /** Whether a turn window is open right now — the thing `done` closes. */
  let turnOpen = false;
  let terminalReason: TerminalReason | undefined;
  /**
   * The stop record that arrived WITH {@link terminalReason} — DorkOS's own
   * answer to "did anyone ask for this?", which the reason itself cannot give
   * (an abort reason names shape, never intent).
   *
   * Latched as a pair with the reason and carried onto `turn_end` rather than
   * consumed here: this hop decides nothing about what a turn's ending MEANS —
   * that is `deriveTurnEndLifecycle`'s job, on both sides of the wire — and the
   * projections that do decide need it on a durable event to still agree after
   * a reconnect.
   */
  let stopWasRequested: boolean | undefined;
  // Error latch: a turn that carried a typed `error` but whose runtime never
  // attached an explicit terminalReason (OpenCode/Codex crash paths) must still
  // close as `turn_end{terminalReason:'error'}` so it settles to the error
  // lifecycle. Explicit reasons always win; the latch only fills undefined —
  // the SDK's own reason is the diagnostic the terminal-reason chip shows, and
  // overwriting `model_error` with a generic `error` would throw it away. What
  // that reason MEANS for the lifecycle is the projector's
  // `deriveTurnEndLifecycle`, not this line (DOR-1676).
  //
  // A SURVIVABLE error never reaches the latch. A `hook_failure` is the
  // operator's own script exiting non-zero, and the turn then ends normally
  // carrying the whole answer — latching it closed a perfectly good turn as
  // `terminalReason: 'error'` whenever no explicit reason came, which the
  // session then reported as a failed turn and escalated. Same denylist, same
  // direction, as the projector's frame test.
  let sawError = false;
  const closeTurn = (originalTerminal?: StreamEvent): void => {
    // No open window: a second `done`, or a `finally` after one already closed.
    // Silently nothing — a second `turn_end` would double-settle the lifecycle,
    // re-flush the turn to the store, and (once the pump lands) close a window
    // that belongs to a different dispatch.
    if (!turnOpen) return;
    turnOpen = false;
    const reason = terminalReason ?? (sawError ? 'error' : undefined);
    const stamped = ingest({
      type: 'turn_end',
      ...(reason !== undefined ? { terminalReason: reason } : {}),
      // Rides only when the runtime actually said. A latch-supplied `'error'`
      // reason never has one — the latch fires precisely when no reason came,
      // and the stop record is only ever read beside a reason — so this cannot
      // pair an intent with a terminal the runtime did not name.
      ...(stopWasRequested !== undefined ? { stopWasRequested } : {}),
    });
    if (relayFeed && relayOwn) {
      relayOwn.end = stamped;
      if (originalTerminal)
        observeOriginalClaudeRelayTerminalProjection(
          events,
          projector,
          stamped,
          relayFeed,
          originalTerminal
        );
    }
    if (opts.originalRoomStream)
      settleOriginalRoomResponderProjection(
        opts.originalRoomStream,
        projector,
        stamped,
        originalTerminal
      );
  };
  /** Open a fresh window for runtime-initiated continuation work (DOR-1100). */
  const reopenTurn = (): void => {
    turnOpen = true;
    terminalReason = undefined;
    stopWasRequested = undefined;
    sawError = false;
    // `origin: 'runtime'` and no `userMessage`: nobody asked for this one, the
    // agent woke itself up. Both projections read that field to keep a window
    // nobody asked for from spending a sign-in card's grace, sounding the
    // turn-finished notification twice, or blanking the reply just produced.
    const reopened: RawOf<'turn_start'> = { type: 'turn_start', origin: 'runtime' };
    ingest(reopened);
  };
  let failed = false,
    first: unknown;
  const cleanup = async (work: () => unknown | Promise<unknown>) => {
    try {
      await work();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  };
  // Join this scope to its captured cleanup before returning or reporting failure.
  const drainOriginalCleanup = async () => {
    // The end of the stream is the end of the runtime's process, so anything it
    // still reports as running has stopped being OBSERVABLE. Retire each
    // stranded child with a terminal `subagent_update` BEFORE the close, so the
    // updates ride inside the last window (persisted with it), every consumer
    // drains through the same event it would have drained through anyway, and
    // the turn settles with an honest zero.
    //
    // The stream, not the turn, is the right boundary — verified in the
    // claude-code runtime rather than assumed. `executeSdkQuery` releases stdin
    // at a `result` — holding it open across the gap between a background task
    // settling and its notification being delivered (DOR-1149) — and keeps
    // reading, so the subprocess stays alive exactly as long as it has queued
    // background work to drain; that is what lets a finished task wake the agent
    // for another window in the first place. When
    // the iterator finally ends the process is gone, and no `task_notification`
    // can ever follow. The same holds for the paths that end a stream early — a
    // stop escalating to `query.close()`, a crash, an abandoned generator —
    // which is why this is one sweep at the end rather than a special case per
    // terminal reason. Without it the count is a permanent on-screen lie:
    // nothing else would ever clear it.
    //
    // ## Why `untracked` and not `stopped` (DOR-1108)
    //
    // This sweep used to declare every swept child STOPPED, on the reasoning
    // that the process hosting it had exited. That reasoning is one case short.
    // A subagent does live inside the CLI process and does die with it — but a
    // child the agent DETACHED does not: a `nohup`'d dev server started as a
    // background task is still serving long after the turn, the CLI, and the
    // session are over. DorkOS cannot observe either kind once the stream ends,
    // so it cannot tell them apart, and `stopped` asserted a death for both.
    //
    // `untracked` is the strongest claim the evidence supports: DorkOS lost
    // sight of this child. It is terminal in every way `stopped` was — it leaves
    // the running count, it retires the row — and it stops the product saying
    // something it does not know. Actually WATCHING a detached child is not this
    // fix's job and is not attempted here; the persistent-session pump (spec
    // `persistent-session-runtime`, P3) owns child lifecycle.
    //
    // It sweeps the SESSION's children, not this stream's, so it depends on one
    // stream per session at a time — the single-flight guarantee `sendMessage`
    // has always claimed and that DOR-1088 / PR #906 actually enforce (turn
    // serialization plus a lock that refuses any live holder). If two streams
    // ever ran concurrently on one session, whichever finished first would
    // retire the other's live children. The persistent pump keeps this correct
    // for a different reason: its stream spans every turn, so the `finally` is
    // the pump dying, which is still exactly when it stops being able to see
    // them.
    let taskIds: readonly string[] = [];
    await cleanup(() => {
      taskIds = projector.listRunningSubagents();
    });
    for (const taskId of taskIds) {
      const untracked: RawOf<'subagent_update'> = {
        type: 'subagent_update',
        taskId,
        status: 'untracked',
      };
      await cleanup(() => ingest(untracked));
    }
    await cleanup(() => closeTurn());
    const originalRoomStream = opts.originalRoomStream;
    if (originalRoomStream)
      await cleanup(() => retireOriginalRoomResponderStream(originalRoomStream));
    if (relayOwn) {
      relayOwn.active = false;
      relayOwn.closed = !failed;
    }
    if (failed) throw first;
  };
  try {
    const started = ingest(start);
    turnOpen = true;
    if (relayFeed && relayOwn) {
      relayOwn.start = started;
      observeOriginalClaudeRelayProjection(events, projector, started, relayFeed);
    }
    if (opts.originalRoomStream)
      observeOriginalRoomResponderProjection(opts.originalRoomStream, projector, started);
    opts.onTurnStart?.(started.seq);
    for await (const event of events) {
      const raw = toRawSessionEvent(event);
      // Checked BEFORE the latches below so the reopen's reset cannot be undone
      // by the very event that caused it (content events carry neither a
      // terminal reason nor an error, so this is belt-and-braces).
      if (!turnOpen && TURN_REOPENING_STREAM_EVENT_TYPES.has(event.type)) reopenTurn();
      const reason = readTerminalReason(event);
      // Read as a PAIR: the stop record comes off the event that named the
      // reason, never latched independently, so a turn cannot settle with one
      // ending's shape and an earlier ending's intent. A reason arriving with no
      // record clears the record, which is the safe direction — an unknown
      // intent settles the way it always did.
      if (reason !== undefined) {
        terminalReason = reason;
        stopWasRequested = readStopWasRequested(event);
      }
      if (event.type === 'error' && !isNonFatalErrorCode(readErrorCode(event))) sawError = true;
      if (event.type === 'done') {
        closeTurn(event);
        continue;
      }
      if (raw !== null) ingest(raw);
    }
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    await drainOriginalCleanup();
  }
}
