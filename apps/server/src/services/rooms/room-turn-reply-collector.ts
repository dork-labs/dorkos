/** Original reply collector and canvas tap, requiring the root-private module key before effects. */
import { createRoomReplyTurnGate } from './turn/room-reply-turn-data.js';
import { createRoomWaitingGrace } from './turn/room-waiting-grace.js';
import {
  createRoomReplyDeadline,
  createRoomReplyElapsedClock,
} from './turn/room-reply-deadline.js';
import { isBlockingInteractionEvent, type SessionActivity } from '@dorkos/shared/session-stream';
import { logger } from '../../lib/logger.js';
import type { UiCommand } from '@dorkos/shared/schemas';
import { getRoomService } from './index.js';
import { deriveSessionActivity } from '../session/activity/derive-activity.js';
import type { SessionStateProjector } from '../session/index.js';
import type { RoomTurnWaiting } from './room-trigger.js';
import { readOriginalRoomTurnReplyView } from './room-turn-runner.js';
import type {
  CollectedTurn,
  ReplyCollector,
  OwnTurn,
} from './turn/room-reply-collector-contracts.js';

/**
 * Put one unstamped `ui_command` on the room's canvas, through the single
 * writer.
 *
 * A thin wrapper that DISCARDS the result, because on this path there is nobody
 * to return it to: the turn produced the event and has moved on, so a refusal
 * has no channel back to the model. That is stated rather than hidden — what the
 * design guarantees here instead is that an operation nothing applied is never
 * claimed applied anywhere.
 *
 * Never throws: a canvas that cannot be reached must not take a room turn's
 * reply down with it.
 *
 * @param bounds - The room, the acting member and this turn's dispatch id.
 * @param command - The command the turn produced.
 */
export function applyRoomCanvasCommand(
  opaqueRunnerReplyKey: object,
  bounds: {
    roomId: string;
    authorId: string;
    turnId: string;
    cwd?: string;
    worktree?: string | null;
    aheadOfMain?: number | null;
  },
  command: UiCommand
): void {
  readOriginalRoomTurnReplyView(opaqueRunnerReplyKey);
  try {
    getRoomService().canvas.apply({
      roomId: bounds.roomId,
      authorId: bounds.authorId,
      turnId: bounds.turnId,
      command,
      ...(bounds.cwd !== undefined ? { cwd: bounds.cwd } : {}),
      ...(bounds.worktree ? { worktree: bounds.worktree } : {}),
      // **Carried, like the directory beside it.** The claude-code handler has
      // always passed this; the tap did not, so every document a CODEX,
      // OpenCode or scripted turn put on a room's table recorded "not measured"
      // — and the review surface (spec `canvas-agent-seat` §8) appears only for
      // a copy that is measurably ahead, so those runtimes could never produce
      // one. `undefined` still means "the caller did not say", which is what a
      // room with no files of its own says.
      ...(bounds.aheadOfMain !== undefined ? { aheadOfMain: bounds.aheadOfMain } : {}),
    });
  } catch (err) {
    logger.warn('[rooms] a turn’s canvas command could not be applied', {
      roomId: bounds.roomId,
      turnId: bounds.turnId,
      action: command.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Accumulate a turn's assistant text from the session's own event stream.
 *
 * **Bounded by its own turn, at both ends.** The read starts at this turn's
 * `turn_start` and stops at the matching `turn_end`, which is the same boundary
 * a client renders against. Anchoring only on the cursor was not enough: the
 * session write-lock lets the same room re-acquire (`session-lock.ts`), so a
 * follow-up message while a turn is running starts a second collector whose
 * cursor sits INSIDE the first turn's stream — it then broke at the first
 * turn's `turn_end` and posted its tail, mid-sentence, as the answer to the new
 * message. One question, two posts, the second a fragment of the first.
 *
 * Which `turn_start` is ours: the first one after the cursor that carries our
 * own prompt. `feedProjector` synthesizes exactly one per turn and echoes the
 * `content` it was triggered with, so this is an identity check rather than a
 * heuristic. A `turn_start` with no `userMessage` at all is accepted, because a
 * turn that does not say what triggered it cannot be attributed to anyone else
 * either, and waiting forever for a better one would report every turn as
 * failed.
 *
 * `turn_end` also carries `terminalReason`, which is how a turn that failed is
 * told from one that simply had nothing to say — the two used to be the same
 * `null` here, and the room reported neither.
 *
 * **Text is collected in paragraphs, not one string.** Every `text_delta` in the
 * turn used to be appended to a single buffer, so a message the agent wrote
 * before reaching for a tool was glued to the answer it wrote afterwards, with
 * no separator at all. Each run of deltas between {@link MESSAGE_BOUNDARY}
 * events is kept whole and the runs are joined with a blank line, so nothing is
 * dropped and the post reads the way the agent wrote it.
 *
 * ONE subscription serves both phases. The deadline resolves a race, it does
 * not abort the read: aborting at the deadline is what made a slow turn post
 * either nothing or a half-finished fragment of whatever it had streamed so far.
 *
 * @param projector - The session projector to read.
 * @param sinceCursor - The seq to resume from — taken before the turn starts.
 * @param bounds.waitMs - How long the room waits before moving on.
 * @param bounds.ceilingMs - When to give up on a turn that never closes.
 * @param bounds.ownTurn - This turn's identity, filled in when it opens.
 * @param bounds.onWaiting - Called when the turn has been stopped for a person
 *   for longer than `graceMs`, and is still stopped.
 * @param bounds.onActivity - Called with the tool this turn just started, and
 *   once with `null` when it can no longer be doing anything.
 * @param bounds.graceMs - How long a prompt may stand before it is mentioned.
 * @param bounds.onProducing - Called once, with the first event this turn's
 *   RUNTIME produced. Everything before it is DorkOS's own bookkeeping — the
 *   `turn_start` is synthesized here, before the runtime is even asked — so this
 *   is the earliest moment the turn is known to exist somewhere that can stop
 *   it (DOR-1424).
 */
export function collectReply(
  opaqueRunnerReplyKey: object,
  projector: SessionStateProjector,
  sinceCursor: number,
  bounds: {
    waitMs: number;
    ceilingMs: number;
    ownTurn: OwnTurn;
    onWaiting: (waiting: RoomTurnWaiting) => void;
    onActivity: (activity: SessionActivity | null) => void;
    graceMs: number;
    onProducing: () => void;
    /** The room this turn is answering in — where its canvas commands land. */
    roomId: string;
    /** The agent taking the turn, as a room author. What a document is attributed to. */
    authorId: string;
    /**
     * This turn's dispatch id.
     *
     * The SAME id `MessageOpts.roomTurn` carried into the runtime, so the
     * handler's ledger entries and this tap's are one ledger and the per-turn
     * canvas ceiling counts them together.
     */
    turnId: string;
    /**
     * The directory this turn is STANDING in — the one the dispatcher resolved,
     * which in a project room is this agent's own working copy of the room's
     * files and its own folder otherwise.
     *
     * Carried because a file document records the tree it was resolved against,
     * and every later read of it is checked on the READER against that stored
     * directory (spec `room-canvas` §8.1). Without it every document the tap
     * writes records nothing, and the reader rule short-circuits to "anybody may
     * read this" — which is exactly the rule inverted.
     */
    cwd: string;
    /** The agent's copy of the room's files, or `null` for a room without files. */
    worktree: string | null;
    /**
     * Commits this agent's working copy has that the room's `main` does not, as
     * the dispatcher measured them for this turn — the label half of §8, taken
     * as a snapshot at open time. `null` means git could not be asked, which is
     * a different claim from "level with the room".
     */
    aheadOfMain: number | null;
  }
): ReplyCollector {
  const facet = readOriginalRoomTurnReplyView(opaqueRunnerReplyKey);
  const abort = new AbortController();
  const elapsed = createRoomReplyElapsedClock();
  const ceiling = setTimeout(() => abort.abort(), bounds.ceilingMs);
  // `unref` so a pending room turn never holds the process open on shutdown.
  ceiling.unref?.();

  // Never rejects: both phases read this one promise, and the busy path reads
  // neither, so a rejection would surface as an unhandled one.
  /**
   * The grace timer for each prompt this turn is currently stopped on.
   *
   * Keyed by the interaction's own id so a turn stopped on two prompts at once
   * cancels exactly the one that was answered.
   */
  const waitingGrace = createRoomWaitingGrace<RoomTurnWaiting>(bounds.graceMs, (waiting) =>
    bounds.onWaiting(waiting)
  );
  const stopWaitingOn = waitingGrace.resolve;
  const stopWaitingOnEverything = waitingGrace.clear;

  /** Whether this turn has already said it is doing nothing. */
  let cleared = false;
  /**
   * Say the turn is no longer doing anything nameable — at most once.
   *
   * Three endings reach it (the `turn_end` branch, the read failing, and the
   * ceiling or a cancel in the `finally`) and a turn that ends and is then
   * aborted reaches two of them. Once is what the room should hear: a second
   * clear is a second publish for work that was already over.
   */
  const clearActivity = (): void => {
    if (cleared) return;
    cleared = true;
    bounds.onActivity(null);
  };

  const closed: Promise<CollectedTurn> = (async () => {
    /** One assistant message's text, finished. */
    const paragraphs: string[] = [];
    /** The message being streamed right now. */
    let collecting = '';
    /** Close the open paragraph, keeping it only if the agent said something. */
    const endParagraph = (): void => {
      if (collecting.trim() !== '') paragraphs.push(collecting.trim());
      collecting = '';
    };
    const ownEvents = createRoomReplyTurnGate(() => bounds.ownTurn.startSeq);
    /** Whether the runtime behind this turn has produced anything yet. */
    let producing = false;
    let ended = false;
    let failed = false;
    try {
      for await (const event of projector.subscribe(sinceCursor, abort.signal)) {
        // Ordinary sequence classification cannot issue a turn or stamp a projector.
        // The start sequence is still read from this genuine dispatch's private holder.
        if (!ownEvents.read(event.type, event.seq)) continue;
        // Past the synthesized `turn_start`, so this event came off the runtime:
        // the turn is really running, and a Stop that arrived while it was still
        // booting has something to aim at at last (DOR-1424).
        //
        // A `turn_end` is deliberately not "running": it is the turn being over,
        // and re-aiming a stop at a session whose turn has just closed is how a
        // stop meant for one turn lands on the one after it.
        if (!producing && event.type !== 'turn_end') {
          producing = true;
          bounds.onProducing();
        }
        // A prompt the turn has stopped on. It is reported after
        // {@link WAITING_NOTICE_GRACE_MS} and only if it is STILL unanswered
        // then — see that constant. Reported per prompt; the room damps
        // repeats, so a turn that stops three times still says so once.
        if (isBlockingInteractionEvent(event)) {
          const waiting: RoomTurnWaiting = {
            kind: facet.waitingKinds[event.type],
            ...(event.type === 'approval_required' ? { toolName: event.toolName } : {}),
          };
          waitingGrace.schedule(event.id, waiting);
        }
        // Answered, denied, cancelled or timed out — every ending arrives here
        // (`interaction_cancelled` is normalized into this event), so the room
        // says nothing about a wait that is already over.
        if (event.type === 'interaction_resolved') stopWaitingOn(event.id);
        if (event.type === 'text_delta') collecting += event.text;
        else if (facet.messageBoundary.has(event.type)) endParagraph();
        // What the turn is doing, for the room's own live lane (DOR-1351).
        // Derived by the SESSION's function, never a second one: the basename
        // rule, the first-line rule, the host rule and the 40-character
        // truncation are all its, and a second derivation is a second answer
        // that can disagree about one tool call.
        if (event.type === 'tool_call') {
          bounds.onActivity(deriveSessionActivity(event.toolName, event.input) ?? null);
        }
        // **The runtime-neutral half of the canvas seam** (spec `room-canvas`
        // §5.5). A `ui_command` reaches the projector from two kinds of producer.
        // `control_ui` is one CAPABILITY now, shared by every runtime (spec
        // `canvas-agent-seat` §5): it calls the writer itself and STAMPS what it
        // wrote, on claude-code, Codex and OpenCode alike. The scripted test-mode
        // runtime yields an ordinary unstamped `ui_command`, and so would any
        // future producer that emits the event without writing — which is exactly
        // the set this tap owns.
        //
        // **The stamp is the dedupe, and it is the whole of it.** Apply a
        // stamped event here too and every operation the handler performed lands
        // twice: two rows for content with no dedupe key, two counts against the
        // ceiling, two mentions in the turn's one line. Both conformance legs
        // that drive the real handler — claude-code's and Codex's — red at
        // `expected 2 to be 1` the moment the stamp is dropped.
        //
        // What a tap-only producer gives up is stated rather than hidden: its
        // refusal cannot reach the model, because the turn has moved on. The
        // property that holds instead is that an operation nothing applied is
        // never claimed applied anywhere — no row, no frame, and no line.
        if (event.type === 'ui_command' && event.applied === undefined) {
          applyRoomCanvasCommand(opaqueRunnerReplyKey, bounds, event.command);
        }
        if (event.type === 'turn_end') {
          ended = true;
          failed = event.terminalReason === 'error';
          clearActivity();
          break;
        }
      }
    } catch (err) {
      logger.warn('[rooms] could not read a turn off its session stream', {
        sessionId: projector.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      failed = true;
      clearActivity();
    } finally {
      clearTimeout(ceiling);
      // The turn has ended, one way or another. A prompt it was stopped on can
      // no longer be answered, so a notice about it now would be advice nobody
      // can act on — and a timer outliving its turn is a room that speaks about
      // work that is over.
      stopWaitingOnEverything();
      // The ceiling gave up, or the collector was cancelled. A verb that
      // outlives its turn is the one thing this feature must not do, so every
      // exit says so — and `clearActivity` makes saying it three times cost one
      // publish.
      clearActivity();
      // **The turn's one canvas line, posted here so every ending reaches it** —
      // a turn the ceiling or the deadline killed still reports what it put on
      // the table. Composed from the SERVICE's per-turn ledger rather than from
      // what this loop observed, which is what keeps "has a row" and "is named
      // in the line" the same set: a stamped event that reaches the projector
      // after this collector has settled still has both.
      //
      // Try-wrapped and logged, exactly as the runner wraps
      // `persistSessionRuntime`: posting can fail (a room archived mid-turn, a
      // busy database) and a rejection out of here would surface from a `closed`
      // promise this function documents as never rejecting.
      //
      // **The face comes off FIRST, in its own `try`.** The line and the face
      // are two different promises and only one of them can fail: posting can
      // throw (a room archived mid-turn, a busy database), and sharing a `try`
      // with it would mean the very endings this block exists for — the ones
      // that go wrong — are exactly the ones that leave an agent's face on a tab
      // for a turn that has stopped. Unconditional and silent: the service
      // publishes nothing for an agent that was not looking, which is every turn
      // that never called `read_canvas`.
      try {
        getRoomService().canvas.clearViewing(bounds.roomId, bounds.authorId);
      } catch (err) {
        logger.warn('[rooms] could not take an agent’s face off the canvas', {
          roomId: bounds.roomId,
          authorId: bounds.authorId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        getRoomService().canvas.finishTurn(bounds.turnId);
      } catch (err) {
        logger.warn('[rooms] could not close out a turn’s canvas line', {
          roomId: bounds.roomId,
          turnId: bounds.turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Whatever was streaming when the turn closed — or when the ceiling gave up
    // on it — is a paragraph too. An abandoned read still keeps what it heard.
    endParagraph();
    return {
      text: paragraphs.length === 0 ? null : paragraphs.join('\n\n'),
      // A stream that ends without a `turn_end` was aborted — the ceiling, or a
      // cancel. Either way nobody got an answer, which is a failure to report.
      failed: failed || !ended,
      waitedMs: elapsed(),
    };
  })();

  const deadline = createRoomReplyDeadline(closed, bounds.waitMs);
  return {
    beforeDeadline: deadline.beforeDeadline,
    afterDeadline: deadline.afterDeadline,
    cancel: () => {
      abort.abort();
      clearTimeout(ceiling);
      deadline.clear();
      stopWaitingOnEverything();
    },
  };
}
