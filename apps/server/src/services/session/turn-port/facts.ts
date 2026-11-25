/**
 * The facts sink: the one way turn code tells the run record what happened to
 * a turn (spec `turns-survive-restarts` §3.1, §4.7; DOR-5159).
 *
 * Turn code never imports `services/runs`, which owns the record (§4.2); the
 * run record registers itself here at startup, and the dispatcher, the queue
 * store and the runtime-turn projector report through what it registered. That
 * keeps the import direction space → computer only, and it is why every
 * payload here is plain data: the sink is the in-process form of the facts a
 * remote computer will send over the wire (§3.6, item 5).
 *
 * Two halves:
 *
 * - {@link TurnFactsSink.report} takes the port's own {@link RunFact}s:
 *   `started`, `delivered`, `ended` and the rest, keyed by run id.
 * - {@link TurnFactsSink.dispatcher} takes the moments only this computer's
 *   dispatcher has (§4.7): a message taken into its queue, a launch beginning,
 *   words going back in line, a queue row leaving, a pause cutting a turn. A
 *   remote computer has no such moments; its space side writes them itself.
 *
 * **Every call is synchronous** and lands in the record in the same step as
 * the dispatcher decision it describes. A call made while a queue-store
 * transaction is open joins that transaction (one `better-sqlite3` connection
 * nests it as a savepoint), which is how a queue row and its run change
 * together. With no sink registered (most unit tests, or a host that never
 * wired the record) every call is skipped and the dispatcher behaves exactly
 * as it did before the record existed.
 *
 * @module services/session/turn-port/facts
 */
import type { RunFact, TurnOrigin, WaitReason, RunEnding } from '@dorkos/shared/turn-port';

/**
 * What the record answers when a launch begins (§4.7, transition 4).
 *
 * - `starting`: no other run of the chat is live; this run is now `starting`.
 * - `queued`: another run of the chat is `starting`; this launch goes on and
 *   stays `queued`, and its own `turn_start` writes 4 and 7 together.
 * - `busy`: another run of the chat is `started` or `running`. The launch
 *   must not go on: it re-parks and waits for that run to settle (one writer
 *   per chat, §5). `retryAt` (epoch ms) is set when that run is another
 *   boot's: nothing in this process will settle it, and it is retired once its
 *   lease runs out, so the launch looks again then.
 */
export type LaunchVerdict =
  { kind: 'starting' } | { kind: 'queued' } | { kind: 'busy'; retryAt?: number };

/**
 * Why queue rows are leaving the table, which decides what becomes of a run
 * that still waits on one (§4.7, the row for transition 5).
 *
 * - `removed`: a person took it off, Stop cleared the queue, or a recovered
 *   row was given up before its launch began. A `queued` run is cancelled; a
 *   run whose launch is under way is left for that launch to end.
 * - `session_gone`: its chat went away. As `removed`.
 * - `cancelled`: the words will not run, whatever the launch was doing (a
 *   private message refused at its final check, a recovered row given up
 *   after a failed start). A `queued` or `starting` run is cancelled.
 * - `outcome_unknown`: a private message's attempt may have reached the
 *   runtime and nobody can tell (§4.7, the private-message row). A `starting`
 *   run is cancelled; one an earlier boot left `started` ends `process_died`.
 *   Its words are never replayed either way.
 */
export type QueueRowExit = 'removed' | 'session_gone' | 'cancelled' | 'outcome_unknown';

/** How a turn ended, as the session's projector read its `turn_end` (§4.4). */
export interface ObservedTurnEnd {
  /** The ending, as observed. Never `shutdown` or `process_died`: those are not a `turn_end`. */
  ending: Exclude<RunEnding, 'shutdown' | 'process_died'>;
  /**
   * When the chat's usage limit began, if it holds one: the turn ended
   * `limited` when that limit began during it.
   */
  limitSince?: string;
}

/** The Mac dispatcher's moments, each one write (or none) on the run record (§4.7). */
export interface DispatcherRunFeed {
  /**
   * The dispatcher accepted a message (transition 1). Called inside the
   * transaction that writes its queue row, when it has one.
   *
   * @param input.chatKey - The chat, by the id its queue rows are kept under.
   * @param input.origin - What started it; `null` when nobody recorded it.
   * @param input.queueMessageId - Its queue row, when it has one.
   * @returns The new run's id.
   */
  accept(input: { chatKey: string; origin: TurnOrigin | null; queueMessageId?: string }): string;
  /**
   * The run of a queue row this process is adopting: the one its acceptance
   * wrote, its `paused` wait cleared (transition 3) since a re-arm is what a
   * resume does; or, for a row an earlier build accepted, a new one
   * (transition 1).
   *
   * @param input.chatKey - The chat, by the id its queue rows are kept under.
   * @param input.queueMessageId - The row.
   * @returns The run's id.
   */
  runOfQueueRow(input: { chatKey: string; queueMessageId: string }): string;
  /**
   * A queued run waits for a reason (transition 3), or stops waiting (`null`).
   *
   * @param runId - The run.
   * @param reason - Why it waits now, or `null`.
   */
  waiting(runId: string, reason: WaitReason | null): void;
  /**
   * A launch begins: read the record and write `starting` only when no other
   * run of the chat is live (transition 4). See {@link LaunchVerdict}.
   *
   * @param runId - The launching run.
   */
  launchBegins(runId: string): LaunchVerdict;
  /**
   * The launch ended with no turn and the words go back in line (transition
   * 8). Nothing is written for a run that is not `starting`.
   *
   * @param runId - The run.
   */
  backInLine(runId: string): void;
  /**
   * The words will not run: cancelled from `queued` (5) or `starting` (9).
   * Nothing is written for a run already past those.
   *
   * @param runId - The run.
   * @param why - What ended it, kept in `ending_detail`.
   */
  cancel(runId: string, why: string): void;
  /**
   * A waiting row's words joined another run's turn (transition 6). Called
   * inside the transaction that removes the row.
   *
   * @param queueMessageId - The folded row.
   */
  supersedeRow(queueMessageId: string): void;
  /**
   * Queue rows are leaving the table: each still-waiting run is ended as
   * {@link QueueRowExit} says. Called inside the transaction that deletes them.
   *
   * @param queueMessageIds - The rows.
   * @param why - Why they leave.
   */
  queueRowsLeaving(queueMessageIds: readonly string[], why: QueueRowExit): void;
  /**
   * One queue row moved to another chat's queue; the run that waits on it
   * moves with it. Called inside the transaction that moves the row.
   *
   * @param queueMessageId - The row.
   * @param toChatKey - The chat it now waits on.
   */
  queueRowMoved(queueMessageId: string, toChatKey: string): void;
  /**
   * The chat's `turn_end` was ingested: record its ending on the chat's
   * `started` or `running` run at once, before its status moves at settle.
   *
   * @param chatKey - The chat.
   * @param observed - What the `turn_end` said.
   */
  turnEnded(chatKey: string, observed: ObservedTurnEnd): void;
  /**
   * A pause cut the run's turn before the agent did anything and its row is
   * back in line, held (transitions 14 and 15).
   *
   * @param runId - The run.
   */
  pauseCut(runId: string): void;
  /**
   * The chat's queue rows moved to a new id; its runs move with them.
   *
   * @param fromChatKey - The id they were kept under.
   * @param toChatKey - The id they are kept under now.
   */
  rekeyChat(fromChatKey: string, toChatKey: string): void;
}

/** Where the turn code's facts go: the run record, registered at startup. */
export interface TurnFactsSink {
  /**
   * One fact about a run, in the port's vocabulary.
   *
   * @param fact - What happened.
   */
  report(fact: RunFact): void;
  /** The Mac dispatcher's own moments. */
  readonly dispatcher: DispatcherRunFeed;
}

let sink: TurnFactsSink | undefined;

/**
 * The runs whose in-memory owner this process holds right now: a launch under
 * way or a turn it opened, from the dispatcher's launch to its end, and a
 * runtime's own turn while it is projected. The run record renews only these
 * runs' leases, and retires a live run of this boot that is not here (a write
 * that failed left it live), so one failed write cannot hold a chat for the
 * life of the process.
 */
const heldRuns = new Set<string>();

/**
 * This process holds the run's in-memory owner from now on.
 *
 * @param runId - The run.
 */
export function holdRun(runId: string): void {
  heldRuns.add(runId);
}

/**
 * This process no longer holds the run's in-memory owner.
 *
 * @param runId - The run.
 */
export function releaseRun(runId: string): void {
  heldRuns.delete(runId);
}

/**
 * Whether this process holds the run's in-memory owner.
 *
 * @param runId - The run.
 */
export function isRunHeld(runId: string): boolean {
  return heldRuns.has(runId);
}

/**
 * Forget every held run.
 *
 * @internal Exported for testing only, through `resetMessageDispatcher`.
 */
export function forgetHeldRuns(): void {
  heldRuns.clear();
}

/**
 * Register (or clear) the run record as the sink. Called once at startup by
 * `services/runs`; `undefined` clears it (test isolation).
 *
 * @param next - The sink, or `undefined`.
 */
export function setTurnFactsSink(next: TurnFactsSink | undefined): void {
  sink = next;
}

/** The registered sink, or `undefined` when no run record is wired. */
export function turnFacts(): TurnFactsSink | undefined {
  return sink;
}
