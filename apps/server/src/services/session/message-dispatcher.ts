/**
 * The single ingress for every turn a caller can start (spec
 * `persistent-session-runtime` §3.4, task 2.3).
 *
 * A message stops being a request and becomes a turn HERE, and nowhere else.
 * Before this module the eight callers that could start a turn each reached
 * {@link triggerTurn} (or {@link triggerCommandIntent}) with their own copy of
 * the runtime port, so each one carried its own copy of the race: two of them
 * could decide independently that a session was free. Now they all ask one
 * object, which decides in one place whether a message runs now or waits, and
 * owns the queue it waits in.
 *
 * ## What it decides
 *
 * 1. **The disposition.** A sender asks for `queue`, `steer` or `stage`; the
 *    dispatcher runs the degradation ladder ({@link deliverByDisposition}) and
 *    answers with a {@link MessageDeliveryOutcome} saying what actually happened.
 *    A `steer` reaches a runtime that declares it and joins the live turn; a
 *    `stage` reaches the transcript or folds into the next dispatch; anything a
 *    runtime cannot do degrades to the queue floor and says why. `queue` is the
 *    floor and always available — the server owns the queue.
 * 2. **Whether it runs now.** A message arriving while the session has a turn
 *    open waits in the durable queue ({@link MessageQueueStore}) instead of
 *    starting a second stream beside it — whichever window sent it. A busy
 *    session is a queue, not a refusal (task 2.4). A caller that would rather
 *    not run at all than run late says so with `whenBusy: 'refuse'`.
 * 3. **When a waiting message runs.** On the signal a turn actually ENDED —
 *    `turn_end` on the projector — never on a bare `result`. Dequeuing on
 *    `result` is how every queue-capable tool has shipped the same bug
 *    (OpenCode #15696): a turn can produce a result and keep going, and the
 *    message behind it fires into work that is still running.
 * 4. **Whether it is safe to run.** Never while
 *    {@link SessionStateProjector.hasPendingInteractions} is true. Firing a
 *    queued prompt into an open permission ask is the other known failure
 *    (Gemini #17719, OpenCode #2609). That probe already exists and is already
 *    shared by the write-lock and the stall watchdog; this reuses it rather
 *    than inventing a third notion of "is this session parked on a person".
 *
 * ## What every window sees (task 2.5)
 *
 * A queue nobody can see is not a queue somebody can trust, so every mutation
 * the dispatcher makes — an acceptance, a dispatch — announces the WHOLE queue
 * on the session's durable stream through {@link emitQueueUpdate}, and the
 * snapshot carries the same list on a cold connect. The queue routes announce
 * theirs the same way. A message therefore appears in the second window the
 * moment it is accepted, and disappears from it the moment it runs.
 *
 * Rows survive a restart; the in-memory entries that pump them do not. That gap
 * is closed by {@link adoptQueuedMessages}, which recreates the entries around
 * the surviving rows **by their existing ids** rather than re-offering them
 * through {@link dispatchMessage} — re-offering would enqueue a duplicate beside
 * every original and hand the person their queue twice.
 *
 * ## When a dispatch answers its caller (task 2.4)
 *
 * At ACCEPTANCE, not at the turn's start. A message that can run now still
 * answers when its turn has started, because that answer is available
 * immediately and carries the canonical id; a message that has to wait answers
 * the moment its row is written. Nothing holds an HTTP socket for a turn ahead
 * of it any more, and no caller is told "no" because the session was busy.
 *
 * The write-lock survives this, retargeted: it is no longer "who may send" but
 * the mutex one turn window holds, and its inactivity TTL (`LockActivity`,
 * DOR-782) is untouched — a turn that goes dark still loses the session a TTL
 * later.
 *
 * ## When a message leaves the queue
 *
 * **When a turn actually STARTS with it** — the `turn_start` the projector
 * ingests — and never at the launch ATTEMPT. The two are not the same moment: a
 * launch can be refused by the write-lock (a holder this module does not track)
 * or throw before any turn exists, and a row dropped at the attempt would take
 * words the sender was told were accepted with it. That is the loss DOR-480
 * named, and after task 2.5 it can also hit a row this process ADOPTED rather
 * than accepted, whose sender is long gone and cannot retype it. A message that
 * did not start goes back in line instead.
 *
 * The one exception is a refusing caller — `whenBusy: 'refuse'` or
 * `'refuse-foreign'` — whose row IS removed when its launch fails: it has said
 * the message has no value later, and leaving it behind would put a prompt
 * nobody typed into somebody's composer for good.
 *
 * The same promise, made earlier, is why such a caller accepted while a FINISHED
 * turn is still closing its stream (DOR-1239) gets no row in the first place: it
 * waits in {@link pending} alone and is dropped rather than deferred if it cannot
 * run. See {@link DispatchPlan.transient}.
 *
 * {@link SessionTurnQueue} (DOR-1088) is kept, underneath: it is the
 * intra-process ordering primitive inside `triggerTurn` and this does not
 * replace it. What changed is that no HTTP request waits on it.
 *
 * @module services/session/message-dispatcher
 */
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeDeliveryResult,
} from '@dorkos/shared/agent-runtime';
import type {
  DispositionDowngradeReason,
  MessageDeliveryOutcome,
  MessageDisposition,
  QueuedMessage,
} from '@dorkos/shared/schemas';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SessionSettings } from '@dorkos/shared/types';
import type {
  AdditionalContext,
  ClientContext,
  RoomContextData,
} from '@dorkos/shared/additional-context';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { COMMAND_INTENT_QUEUE_WAIT_MS } from '@dorkos/shared/command-intents';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { getMessageQueueStore, toQueuedMessage } from './message-queue-store.js';
import type { SessionStateProjector } from './session-state-projector.js';
import {
  onProjectorRekey,
  onProjectorTurnBoundary,
  peekProjector,
  rekeyProjector,
} from './session-state-projector.js';
import {
  forgetSessionAliases,
  linkSessionId,
  primaryOf,
  projectorFor,
  queueKeyOf,
  resetSessionKeys,
} from './session-key-registry.js';
import { onSessionRemoved } from './session-list-broadcaster.js';
import { holdStagedContext } from './staged-context-store.js';
import { triggerTurn, type TriggerTurnDeps, type TriggerTurnResult } from './trigger-turn.js';
import { triggerCommandIntent } from './trigger-command-intent.js';
import { SESSIONS } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';
import { captureDispatchScope, runInDispatch } from '../../lib/dispatch-context.js';
import { recordDispatchEnd, recordDispatchStart } from '../observability/dispatch-buffers.js';

/**
 * How many session ids the orphan sweep hands to one `DELETE ... IN (...)`.
 *
 * SQLite's compiled-in variable ceiling is ~32k and every id is one variable, so
 * a fleet with more orphans than that would fail the whole delete rather than
 * some of it. 500 is far below the ceiling and still one statement per 500
 * sessions.
 */
const SWEEP_CHUNK_SIZE = 500;

/** The turn a session currently has open, and who owns it. */
interface InFlightTurn {
  /** The lock identity that started it. */
  clientId: string;
  /** Identity of this particular launch, so a stale settle cannot clear a newer turn. */
  token: symbol;
  /** When the launch claimed the session — what a refusal reports as `since`. */
  startedAt: number;
  /**
   * Whether this launch's turn has appeared on the projector yet.
   *
   * Until it has, the slot is the ONLY evidence about the session, and it says
   * busy: a launch between claiming the slot and its `turn_start` is assembling
   * context, and no `turn_end` can have been seen for a turn that has not
   * started. Once it is true the projector takes over as the authority on
   * whether the turn is still producing — see {@link isStillProducing}.
   */
  sawTurnStart: boolean;
}

/** One accepted message waiting for its turn to come round. */
interface PendingDispatch {
  /** The server-minted message id; the same id the queue row is keyed by. */
  messageId: string;
  /** The session key it is queued under (canonical where one is known). */
  sessionKey: string;
  /** Who asked for it — the lock identity its turn will run under. */
  clientId: string;
  /** Run it now. Idempotent — the wait bound and the pump can both reach it. */
  launch: (opts: { budgetExhausted: boolean }) => void;
  /** The wait bound's timer, cleared when the dispatch launches. */
  timer: ReturnType<typeof setTimeout>;
  /**
   * True for a message whose launch the write-lock has already refused.
   *
   * The pump skips it until the session reaches a turn boundary, because
   * nothing between now and then can change the lock's answer — and a pump that
   * retried immediately would spin: every refusal hands the slot back, which
   * schedules the pump, which launches it again, which is refused again. That
   * loop exhausted the heap in testing. Only a boundary (or, if none ever
   * comes, the wait bound) tries again.
   */
  waitingOnLock: boolean;
}

/** Turns open right now, keyed by resolved session id. */
const inFlight = new Map<string, InFlightTurn>();
/** Accepted messages waiting to launch, keyed by message id. */
const pending = new Map<string, PendingDispatch>();
/**
 * Messages whose launch is under way: out of {@link pending}, still on the
 * queue.
 *
 * The gap between the two is not instantaneous. A launch leaves `pending`
 * synchronously and the row leaves the store at `turn_start`, and between those
 * two moments the turn is awaiting its neutral context bag — real filesystem
 * work. A row seen in that window is on disk with no pending entry behind it,
 * which is precisely what {@link adoptQueuedMessages} takes to mean "a previous
 * process left this", so it would adopt a message that is at this instant being
 * sent — running somebody's words twice and reporting a queue recovery on a
 * server that never restarted.
 */
const launching = new Set<string>();
/** Tail of each session's dispatch mutex chain; dropped when it drains. */
const dispatchMutex = new Map<string, Promise<void>>();
/** Sessions the fleet has reported gone, awaiting the next sweep. */
const orphanedSessions = new Set<string>();

/**
 * Run `fn` with this session's dispatch mutex held.
 *
 * Every decision that starts or ends a turn goes through here, so two of them
 * cannot interleave on one session. Today the only holder is the pump; **the
 * warm-process reaper (P3, task 3.4) is the second**, and it shares this mutex
 * precisely so a reap racing a dispatch simply does not happen. The mutex is
 * released as soon as the decision is made — it is never held for the turn's
 * duration, which is the write-lock's job.
 *
 * @param sessionKey - The resolved session id to serialize on
 * @param fn - The critical section
 */
export async function withDispatchMutex<T>(
  sessionKey: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = dispatchMutex.get(sessionKey) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => held);
  dispatchMutex.set(sessionKey, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Only the CURRENT tail may drop the entry; a later waiter has already
    // chained onto ours and must keep its place.
    if (dispatchMutex.get(sessionKey) === chained) dispatchMutex.delete(sessionKey);
  }
}

/**
 * One rung of the degradation ladder: either the disposition LANDED natively (a
 * steer joined the live turn, a stage reached the transcript or folded into the
 * next dispatch) and answers its caller here, or it must DEGRADE to the queue,
 * carrying the reason it could not be delivered as asked.
 */
type LadderRung = { landed: MessageDispatchResult } | { degrade: DispositionDowngradeReason };

/**
 * The degradation ladder (spec `persistent-session-runtime` §P4, task 4.4).
 *
 * ```
 * steer -> supportsSteer AND no pending interaction AND a turn is open
 *            -> deliverIntoTurn({ mode: 'steer' })   (joins the live turn)
 *          else -> queue, and say why
 * stage -> supportsContextStaging -> deliverIntoTurn({ mode: 'stage' })
 *          else -> fold into the next dispatch as additional context
 * ```
 *
 * `queue` is the floor and never reaches here — the server owns the queue, so it
 * is always available. This resolves the two dispositions that need a runtime to
 * declare them, reusing the primitives {@link deliverSteer} and
 * {@link deliverStage} rather than re-deciding what they already decide: the flag
 * is the ROUTING authority (which rung to try), the receipt is the DELIVERY
 * authority (what actually happened).
 *
 * The one downgrade the person is not told about is `session-idle`: a steer on an
 * idle session simply runs now, which lost nothing. Every other degrade sets
 * `degradedBecause` so the sender's window can say what happened instead of it.
 *
 * @param opts - The dispatch request (session, client, content, projector, runtime)
 * @param requested - The disposition asked for; never `queue` (the caller gates that)
 * @param caps - The resolved runtime's declared capabilities
 */
async function deliverByDisposition(
  opts: DispatchMessageOpts,
  requested: Exclude<MessageDisposition, 'queue'>,
  caps: RuntimeCapabilities
): Promise<LadderRung> {
  const { sessionId, clientId, content, projector, runtime } = opts;
  const messageId = crypto.randomUUID();
  const canonicalId = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const queueKey = queueKeyOf(sessionId);
  const landed = (outcome: MessageDeliveryOutcome): LadderRung => ({
    landed: { accepted: true, queued: false, canonicalId, outcome, queuePosition: 0 },
  });

  if (requested === 'steer') {
    // The flag is the routing authority, and it is checked FIRST so a runtime
    // that cannot steer reads `unsupported` rather than whatever the session
    // happens to be doing (AC2). A steer it cannot take rides the queue instead.
    if (!caps.supportsSteer) return { degrade: 'unsupported' };
    // Firing a steer into an open approval or question is the failure the pump's
    // own gate exists for — the agent is parked on a person, and words arriving
    // now are read as their reply. So a steer never reaches a turn parked on an
    // interaction; it queues and waits for the resolution, exactly as a queued
    // message does (AC4). {@link deliverSteer} does not probe this, so the router
    // must.
    if (projector.hasPendingInteractions()) return { degrade: 'pending-interaction' };
    const result = await deliverSteer({ sessionId, clientId, content, messageId, runtime });
    if (result.delivered) return landed({ messageId, requested, applied: 'steer' });
    // Declared the capability but could not deliver it — a declaration arriving
    // ahead of its mechanism is an adapter bug, logged as one, and degraded
    // honestly rather than lost.
    if (result.reason === 'unsupported') {
      logger.error('[MessageDispatcher] runtime declares steer but did not deliver it', {
        runtime: caps.type,
      });
      return { degrade: 'unsupported' };
    }
    // No turn was open to join, so the message just runs now — the one downgrade
    // the UI stays quiet about, because running immediately lost nothing (AC3).
    if (result.authorized && result.reason === 'no-open-turn') return { degrade: 'session-idle' };
    // A DIFFERENT client owns the live turn (unauthorized), or its input stream
    // had already closed: there is no turn THIS caller may join, so it waits.
    return { degrade: 'no-open-turn' };
  }

  // stage. The flag routes: a runtime that declares staging is asked to append to
  // its transcript natively; one that does not folds the words into the next
  // dispatch (ADR-0273) WITHOUT a native attempt that would contradict the flag.
  if (!caps.supportsContextStaging) {
    return landed(foldStage(sessionId, content, messageId, queueKey));
  }
  // {@link deliverStage} is the native primitive, reused whole. It should deliver
  // natively here (flag true, method present); a fold receipt would mean the
  // adapter declared ahead of its mechanism, so it is logged and recorded as one.
  const result = await deliverStage({ sessionId, clientId, content, messageId, runtime });
  if (result.delivered) {
    if (result.viaFallback === true) {
      // deliverStage ALREADY folded — it held the text and emitted the
      // `context_staged` receipt before returning `viaFallback`. Do NOT fold
      // again (that would hold the words twice and send two receipts). Only log
      // the declared-ahead-of-mechanism adapter bug and announce the downgrade
      // the fold produced.
      logger.error('[MessageDispatcher] runtime declares context staging but had to fold', {
        runtime: caps.type,
      });
      const outcome: MessageDeliveryOutcome = {
        messageId,
        requested,
        applied: 'stage',
        degradedBecause: 'unsupported',
      };
      emitQueueUpdate(queueKey, outcome);
      return landed(outcome);
    }
    return landed({ messageId, requested, applied: 'stage' });
  }
  // A DIFFERENT client owns the live turn, so the runtime refused the write. The
  // message waits in line rather than being lost — a rare cross-client race.
  return { degrade: 'no-open-turn' };
}

/**
 * Fold a staged message into the next dispatch and build its receipt — the
 * fallback for a runtime that cannot append to its own transcript (spec
 * `persistent-session-runtime` §2.5, ADR-0273). The words are held
 * ({@link holdStagedContext}) to ride the next turn as a `staged_context` entry,
 * the `context_staged` receipt is emitted so a successful fold is not
 * indistinguishable from a dropped message, and the outcome is announced on the
 * durable stream because no queue row backs a fold.
 *
 * The same two steps {@link deliverStage} takes on its own fallback, reached here
 * by the routing flag instead of by a native attempt. To the person a stage
 * landed either way; `degradedBecause: 'unsupported'` on the receipt is only how.
 *
 * @param sessionId - Either id a caller might hold (request uuid or canonical)
 * @param content - The person's staged text, pristine
 * @param messageId - The server-minted correlation id for the staged message
 * @param queueKey - The session's queue key, for the durable-stream announcement
 */
function foldStage(
  sessionId: string,
  content: string,
  messageId: string,
  queueKey: string
): MessageDeliveryOutcome {
  holdStagedContext(sessionId, content, messageId);
  emitContextStaged(sessionId, content, messageId);
  const outcome: MessageDeliveryOutcome = {
    messageId,
    requested: 'stage',
    applied: 'stage',
    degradedBecause: 'unsupported',
  };
  emitQueueUpdate(queueKey, outcome);
  return outcome;
}

/**
 * The `queue_update` member as an emitter builds it — the projector stamps the
 * `seq`. Narrowed out of the union member by member, because a bare
 * `Omit<SessionEvent, 'seq'>` over a union keeps only the keys every member
 * shares and would drop `queue` and `outcome` on the floor.
 */
type RawQueueUpdate = Omit<Extract<SessionEvent, { type: 'queue_update' }>, 'seq'>;

/**
 * The `context_staged` member as an emitter builds it — the projector stamps the
 * `seq`, exactly as it does for {@link RawQueueUpdate}.
 */
type RawContextStaged = Omit<Extract<SessionEvent, { type: 'context_staged' }>, 'seq'>;

/**
 * Announce a session's queue on its durable stream — the one way a queue change
 * reaches the windows watching it (spec `persistent-session-runtime` §3.2).
 *
 * Reads the store and emits the WHOLE queue, never a diff. The queue is small
 * and bounded, and a full replacement makes every ordering and dedup bug
 * unrepresentable: a window that missed an update is corrected by the next one
 * instead of drifting. The event is ingested like any other, so it is stamped
 * with a `seq`, replayed to a client resuming from `Last-Event-ID`, and covered
 * by the client's existing idempotent-apply-by-seq with no new rules.
 *
 * **Call this after every queue mutation** — enqueue, edit, reorder, remove,
 * dispatch, clear. The dispatcher calls it for the two mutations it owns; the
 * queue routes call it for theirs. A mutation that forgets leaves every other
 * window showing a queue that is no longer true until something else changes.
 *
 * A no-op when no queue store is wired (embedded hosts, most unit tests) or when
 * no projector is registered for the session: with nobody listening there is
 * nothing to correct, and the next cold connect reads the queue from the store
 * anyway.
 *
 * @param sessionId - Either id a caller might hold (request uuid or canonical)
 * @param outcome - Present when an accepted message caused this update, so the
 *   sender's window can say what actually happened to it
 */
export function emitQueueUpdate(sessionId: string, outcome?: MessageDeliveryOutcome): void {
  const store = getMessageQueueStore();
  if (!store) return;
  const sessionKey = queueKeyOf(sessionId);
  const projector = peekProjector(sessionKey);
  if (!projector) return;
  const event: RawQueueUpdate = {
    type: 'queue_update',
    queue: store.list(sessionKey).map(toQueuedMessage),
    ...(outcome !== undefined ? { outcome } : {}),
  };
  projector.ingest(event);
}

/**
 * The `turn_input` member as an emitter builds it — the projector stamps the
 * `seq`. Narrowed member by member for the same reason {@link RawQueueUpdate}
 * is: a bare `Omit<SessionEvent, 'seq'>` keeps only the union's shared keys.
 */
type RawTurnInput = Omit<Extract<SessionEvent, { type: 'turn_input' }>, 'seq'>;

/**
 * Carry a delivered steer onto a session's durable stream so it renders inline
 * in the running turn (spec `persistent-session-runtime` §P4, task 4.3).
 *
 * A steer JOINS the open turn — {@link deliverSteer} is the one caller, and it
 * calls this ONLY once the runtime confirmed delivery — so the person's words
 * reached the model but produced no turn-shaped events of their own: the
 * transcript would show the agent changing course with nothing to say why. This
 * mints the carrier for it. Server-authored and ingested straight onto the
 * projector, exactly like {@link emitQueueUpdate}: it is not a runtime
 * `StreamEvent`, so it has no `session-event-normalizer` mapping.
 *
 * Ingested (not opening or closing a turn) it rides the OPEN turn — the
 * projector pushes any non-boundary event onto `inProgressTurn` — so it gets a
 * `seq`, replays gap-free to a client resuming from `Last-Event-ID`, and folds
 * inline in reading order. Ordering holds because this runs synchronously the
 * instant delivery returns, before the model's answer to the steer can stream
 * back, and under the dispatch mutex {@link deliverSteer} holds so no `turn_end`
 * can straddle it.
 *
 * A no-op when no projector is registered for the session (nobody is listening,
 * and a delivered steer with no live turn is not a state that reaches here).
 *
 * @param sessionKey - The session's primary key (the id its projector is under).
 * @param content - The person's words, pristine — the same text handed the model.
 * @param messageId - The steer's server-minted correlation id.
 */
function emitTurnInput(sessionKey: string, content: string, messageId: string): void {
  const projector = projectorFor(sessionKey);
  if (!projector) return;
  const event: RawTurnInput = { type: 'turn_input', content, disposition: 'steer', messageId };
  projector.ingest(event);
}

/**
 * Announce that a person STAGED context — the receipt for a `stage` (spec
 * `persistent-session-runtime` §2.5, task 4.2). A staged message opens no turn,
 * so it mints no `turn_start`; without this event a successful stage would be
 * indistinguishable on the stream from a dropped one, which is the exact failure
 * the receipt exists to prevent.
 *
 * Synthesized server-side and ingested straight into the projector — the same
 * path {@link emitQueueUpdate} takes, so it is stamped with a `seq`, replayed to
 * a client resuming from `Last-Event-ID`, and folded outside the turn transcript
 * (`EVENTS_OUTSIDE_THE_TURN`) rather than as a user turn. Emitted for BOTH the
 * native path (the message reached the runtime's transcript directly) and the
 * fold-into-next fallback (the text is held to ride the next dispatch).
 *
 * A no-op when no projector is registered — nobody is listening, and a cold
 * connect learns the staged text from the runtime's transcript (native) or sees
 * it fold into the next turn (fallback) either way.
 *
 * @param sessionId - Either id a caller might hold (request uuid or canonical)
 * @param content - The person's staged text, pristine
 * @param messageId - The server-minted correlation id for the staged message
 */
function emitContextStaged(sessionId: string, content: string, messageId: string): void {
  const projector = peekProjector(primaryOf(sessionId));
  if (!projector) return;
  const event: RawContextStaged = { type: 'context_staged', content, messageId };
  projector.ingest(event);
}

/** Build the runtime-neutral port `triggerTurn` needs from a resolved runtime. */
function turnDeps(runtime: AgentRuntime): TriggerTurnDeps {
  return {
    acquireLock: (sid, cid, lifecycle, token) => runtime.acquireLock(sid, cid, lifecycle, token),
    releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
    sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
    interruptQuery: (sid) => runtime.interruptQuery(sid),
    getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
    rekeyProjector: (oldId, newId) => rekeyProjector(oldId, newId),
    getCapabilities: () => runtime.getCapabilities(),
  };
}

/** Inputs for {@link dispatchMessage}. */
export interface DispatchMessageOpts {
  sessionId: string;
  /** Lock identity of whoever is sending; a message waits only behind its own client. */
  clientId: string;
  /** The person's words, passed through pristine. */
  content: string;
  /** What the sender asked be done when the session is busy. Defaults to `queue`. */
  disposition?: MessageDisposition;
  cwd?: string;
  /** Neutral client-sourced context signals (ui_state, queued) for this turn. */
  context?: ClientContext;
  /** Where this turn is happening, when a room triggered it. */
  roomContext?: RoomContextData;
  /** Background the caller attached to this turn; the person never sees it. */
  seedContext?: string;
  /** Per-turn execution settings, when the caller has resolved them itself. */
  settings?: Pick<SessionSettings, 'model' | 'effort'>;
  /** The projector for `sessionId` (keyed by the stable client-facing id). */
  projector: SessionStateProjector;
  /** The runtime this session resolves to. */
  runtime: AgentRuntime;
  /** Inactivity window before the stall watchdog fires. */
  stallTimeoutMs?: number;
  /**
   * The whole budget this message may spend waiting for the turns ahead of it,
   * across BOTH the dispatcher's queue and `SessionTurnQueue` underneath.
   * Defaults to `SESSIONS.LOCK_TTL_MS` — the point at which a stranger could
   * take the lock out from under the turn ahead, so an owner is never the last
   * to get in. Whatever is left of it when the message launches is what the
   * chain underneath is given, so the two waits cannot add up past the budget.
   */
  queueWaitMs?: number;
  /** Records a detached-turn failure (logging is the caller's concern). */
  onError?(err: unknown): void;
  /** Fired once when the detached turn settles, however it settles. */
  onSettled?(outcome: 'ok' | 'failed'): void;
  /** Receives the `seq` of this turn's `turn_start` — its identity on the stream. */
  onTurnStart?(seq: number): void;
  /**
   * What to do when the session already has a turn open.
   *
   * - `'queue'` (default) — accept it and run it when the session frees up. The
   *   answer for a message a person typed and is watching: it is theirs, it is
   *   durable, every window can see it, and they can edit or remove it while it
   *   waits.
   * - `'refuse'` — answer `{ accepted: false }` and write nothing, while the
   *   agent is still producing. For a trigger a machine generated on somebody's
   *   behalf (an MCP sign-in resume, a UI action), where the reason it was sent
   *   may not survive the wait and firing it late is worse than not firing it.
   *   Once the turn has ENDED there is nothing to fire late into, so the message
   *   is accepted and runs as the stream finishes closing — with no queue row
   *   behind it, and dropped rather than deferred if that stream outlasts the
   *   wait bound ({@link DispatchPlan.transient}).
   * - `'refuse-foreign'` — refuse a turn ANOTHER client opened, and wait behind
   *   one of the caller's own. For a caller that already sequences its own turns
   *   and only needs protecting from a stranger; see {@link WhenBusy}.
   */
  whenBusy?: WhenBusy;
}

/**
 * What a caller wants done when the session is already working.
 *
 * **"Already working" means the agent is still PRODUCING**, not that the last
 * turn's stream has finished closing. Both refusing modes ask
 * {@link isStillProducing} first, so neither of them refuses over a turn that has
 * already ended — see that function for the window this cost the product
 * (DOR-1239).
 *
 * **`'refuse-foreign'` is the same promise as `'refuse'`, asked of the right
 * question.** A refusing caller is saying "do not queue my trigger behind
 * somebody else's work" — and a turn the CALLER ITSELF opened is not somebody
 * else's work. Rooms are why the distinction exists: a room already allows one
 * turn per `(room, agent)` and holds a re-mention until that turn's claim
 * releases (RP8, `room-collect.ts`), so by the time the held message is
 * dispatched the previous turn has ended on the projector — but the in-flight
 * slot it took is cleared a beat later, when the turn settles. A blanket
 * `'refuse'` lost that race and told the room its own agent was busy with
 * something else, so the room wrote "didn't pick this up, send it again" over a
 * message it was about to answer (DOR-1230).
 *
 * A foreign turn is still refused, which is the case the notice was written for:
 * somebody typing into the very agent a room addressed.
 *
 * @see DispatchMessageOpts.whenBusy
 */
export type WhenBusy = 'queue' | 'refuse' | 'refuse-foreign';

/** What happened to a message the dispatcher accepted. */
export interface MessageDispatchResult extends TriggerTurnResult {
  /** What was asked for, what was applied, and why they differ. */
  outcome: MessageDeliveryOutcome;
  /**
   * Where the message sat in its session's queue at acceptance, 1-based.
   * `1` means it was the head — nothing was ahead of it. `0` means it is on no
   * queue at all: a refusal, a steer/stage that landed natively through the
   * degradation ladder, or a {@link DispatchPlan.transient} wait — which is
   * accepted (`queued: true`) but deliberately rowless.
   */
  queuePosition: number;
  /**
   * True when the message was accepted onto the queue rather than started. Its
   * turn begins when the session frees up, announced on the session's stream
   * like every other queue change.
   */
  queued: boolean;
  /**
   * Who holds the turn this message was refused for, when the dispatcher could
   * name them. Present only on a refusal, and absent when the holder let go in
   * the same beat it said no.
   *
   * It exists so a caller answering `409 SESSION_LOCKED` can name a holder that
   * really exists. A route asking its own authority instead — `getLockInfo`,
   * under the id the REQUEST used rather than the canonical one the lock is
   * keyed by — could not see the turn the dispatcher had just refused it for, so
   * it reported `lockedBy: "unknown"`: a locked session with nobody holding it
   * (DOR-1239).
   */
  refusedBy?: {
    /** The lock identity of the turn that caused the refusal. */
    clientId: string;
    /** Epoch ms at which that turn claimed the session. */
    since: number;
  };
}

/** Everything one accepted message needs to become a running turn. */
interface DispatchPlan {
  /** The client-facing session id the turn is triggered under. */
  sessionId: string;
  /** The id this session's in-memory dispatcher state is filed under. */
  sessionKey: string;
  clientId: string;
  content: string;
  /** The server-minted id shared by the queue row, the turn, and the outcome. */
  messageId: string;
  projector: SessionStateProjector;
  runtime: AgentRuntime;
  /** The whole budget this message may spend waiting for the turns ahead of it. */
  budgetMs: number;
  /** When it started spending that budget. */
  startedWaitingAt: number;
  /**
   * What a launch that started no turn means for this message: go back in line
   * (`'queue'`, the default everywhere except the callers that opt out) or be
   * dropped with its row (either refusing mode) — unless
   * {@link DispatchPlan.answered}, which outranks it.
   */
  whenBusy: WhenBusy;
  /**
   * Somebody has already been told this message was accepted.
   *
   * True wherever that is so: a `'refuse-foreign'` plan that waited out the
   * caller's own turn, and every row {@link adoptQueuedMessages} recovered,
   * whose original caller was answered by a process that is now gone.
   *
   * It only CHANGES anything for a refusing plan, and there it outranks
   * `whenBusy`. Dropping the message is the promise `'refuse'` makes about
   * words nobody has been promised anything about; once an `accepted: true` is
   * out there it cannot be taken back, so the message goes back in line like
   * anybody else's rather than evaporating (the DOR-480 rule, in the module doc
   * above).
   */
  answered: boolean;
  /**
   * This message waits with NO durable row, and is dropped rather than deferred
   * the moment it cannot run — fast, or never.
   *
   * True for exactly one shape: a blanket-`'refuse'` caller accepted while the
   * session's slot is still held by a turn that has ALREADY ENDED (the drain
   * window, DOR-1239). It is waiting out a stream that is closing, not queueing
   * behind work.
   *
   * **`'refuse-foreign'` is deliberately NOT this**, though it can wait in the
   * same window. What the two carry is different: a `'refuse'` trigger is
   * machine-generated (a widget click, a sign-in nudge) and belongs to nobody,
   * while a `'refuse-foreign'` message is a person's words in a room, which
   * DOR-1230 accepts precisely so the room answers them. Those keep their row and
   * their place in line, exactly as that fix decided.
   *
   * Both halves follow from what such a caller was promised, and neither is
   * optional:
   *
   * - **No row.** A refusing caller's message must never sit in somebody's
   *   composer (module doc above). A widget action's content is the raw
   *   `<ui_action>` block, and the queue panel draws a row's content verbatim and
   *   lets a person edit it — an edit {@link launchDispatch} would then send to
   *   the model, because it sends the ROW's words. So the wait happens in
   *   {@link pending} alone, exactly as {@link dispatchCommandIntent} waits.
   * - **Dropped, never deferred.** The budget bound must not FORCE this one
   *   through: a budget-exhausted launch deliberately skips the in-flight slot,
   *   which for a stream that is still open means a second `sendMessage` racing
   *   the first on one session. And {@link returnToQueue} must not re-park it,
   *   which would hand it a fresh full budget and start the cycle again.
   *
   * It sorts behind anything with a row ({@link orderedWaiting}), which is
   * anything a person typed — the right way round, since those words came first.
   */
  transient: boolean;
  /** What the caller passes straight through to the turn. */
  turn: Pick<
    DispatchMessageOpts,
    | 'cwd'
    | 'context'
    | 'roomContext'
    | 'seedContext'
    | 'settings'
    | 'stallTimeoutMs'
    | 'onError'
    | 'onSettled'
    | 'onTurnStart'
  >;
}

/**
 * Whether the turn holding the in-flight slot is STILL PRODUCING — the question
 * a refusal is really asking (DOR-1239).
 *
 * The slot answers a different question: "has the stream closed and been handed
 * back". Those two moments are not the same one. A runtime keeps its stream open
 * past the end of the turn to drain background work — claude-code's subprocess
 * stays alive after `done` precisely so a finished task can wake the agent again
 * (`session-event-normalizer.ts`) — and the write-lock is released on the same
 * late signal, so asking the REAL lock instead would give the same wrong answer.
 * Through that whole window the agent has stopped: the projector has already been
 * told `turn_end`, every window draws the session as idle, and a widget button
 * rendered in the reply is on screen and clickable. A click there was answered
 * `409 SESSION_LOCKED` over a session nothing was using.
 *
 * So the projector is the authority once the turn has reached it: its in-progress
 * turn opens at `turn_start` and closes at `turn_end`, which is exactly "the
 * agent is producing". It re-opens on its own if the agent wakes itself up
 * (DOR-1100), so a session that starts producing again refuses again without
 * this needing to know that happened.
 *
 * **What accepting here does NOT promise is adjacency.** The message runs when
 * the slot clears, and one turn at a time still holds — but a self-woken window
 * (DOR-1100) can open and close inside that same stream, so the accepted message
 * can land after a window the person never asked for, rather than immediately
 * after the turn it was clicked in. That is measured behavior, not a hypothesis.
 * It is still the better answer than a hard refusal: the alternative was 409 over
 * a session nothing was using, and every ordering guarantee is unchanged.
 *
 * @param open - The turn holding the session's in-flight slot.
 * @param sessionKey - The id that turn's dispatcher state is filed under.
 * @param fallback - The caller's projector, used when the registry has none.
 * @returns True while the turn is producing; false in the post-`turn_end` drain.
 */
function isStillProducing(
  open: InFlightTurn,
  sessionKey: string,
  fallback: SessionStateProjector
): boolean {
  if (!open.sawTurnStart) return true;
  // The registry's projector, which is the one the pump's own gate reads and the
  // one the turn is ingesting into whichever id the caller happens to hold.
  const projector = projectorFor(sessionKey) ?? fallback;
  return projector.peekInProgressTurn() !== null;
}

/**
 * Whether the turn that is open right now is one this caller refuses to wait
 * behind.
 *
 * Two questions, and a refusal needs both to be yes. Is the session still
 * PRODUCING ({@link isStillProducing}) — a turn that has ended is not something
 * to refuse over, whoever it belonged to. And is it a turn this caller refuses to
 * wait behind, which is where the whole difference between the two refusing modes
 * lives: a question about WHOSE turn is open rather than about whether one is.
 * See {@link WhenBusy} for why a caller that sequences its own turns — a room —
 * must not be told its own tail is a stranger.
 *
 * @param opts.whenBusy - What the caller asked for.
 * @param opts.open - The turn holding the session's in-flight slot, if any.
 * @param opts.clientId - The caller's lock identity.
 * @param opts.sessionKey - The id the session's dispatcher state is filed under.
 * @param opts.projector - The caller's projector, for the producing probe.
 * @returns True when this message should be refused rather than accepted.
 */
function refusesOpenTurn(opts: {
  whenBusy: WhenBusy;
  open: InFlightTurn | undefined;
  clientId: string;
  sessionKey: string;
  projector: SessionStateProjector;
}): boolean {
  const { whenBusy, open, clientId } = opts;
  if (open === undefined || whenBusy === 'queue') return false;
  if (!isStillProducing(open, opts.sessionKey, opts.projector)) return false;
  return whenBusy === 'refuse' || open.clientId !== clientId;
}

/**
 * Give up on a message whose launch started no turn, or put it back in line.
 *
 * Which of the two is the caller's `whenBusy`, and the difference is a promise
 * to a person: a message somebody typed and was told was accepted must survive
 * a launch the write-lock refused, while a machine-generated trigger that asked
 * not to wait must not be left sitting in their composer.
 *
 * **{@link DispatchPlan.answered} outranks `whenBusy`**, because by then the
 * refusal the caller asked for is no longer available: it is holding an
 * `accepted: true` and there is no channel to take that back. Dropping the
 * message would leave it waiting for a turn nothing will ever start — for a room
 * that is a claim held to its ceiling and a "something went wrong" an hour
 * later, over a message the model never saw. It goes back in line instead, which
 * is what the acceptance promised.
 *
 * A message already gone from the queue — removed from another window between
 * the launch and its refusal — is left gone.
 */
function returnToQueue(plan: DispatchPlan): void {
  const store = getMessageQueueStore();
  // Fast, or never. A transient plan has no row to go back to and no later
  // moment worth running at, and re-parking it would hand it a fresh full budget
  // — the requeue cycle, with a trigger nobody can see waiting in it.
  if (plan.transient) {
    dropTransient(plan, 'the launch could not start it');
    return;
  }
  if (plan.whenBusy !== 'queue' && !plan.answered) {
    if (store?.remove(plan.messageId)) emitQueueUpdate(plan.sessionKey);
    return;
  }
  if (store && !store.get(plan.messageId)) return;
  parkDispatch(plan, unwatchedSettle(plan), { waitingOnLock: true });
}

/**
 * Give up on a {@link DispatchPlan.transient} message, and say so.
 *
 * The whole disposal: there is no row to remove and nobody holding a request
 * open, so the log line is the only trace it leaves. It is a `warn` because a
 * trigger somebody's click generated did not reach the model, even though the
 * caller was told it was accepted — rare (it needs a stream that stays open past
 * the wait bound, or a stranger taking the session in the same beat), and
 * invisible without this.
 *
 * @param plan - The transient plan being dropped
 * @param why - What stopped it, for the log line
 */
function dropTransient(plan: DispatchPlan, why: string): void {
  pending.delete(plan.messageId);
  logger.warn('[MessageDispatcher] a refusing caller’s trigger was dropped rather than run late', {
    sessionId: plan.sessionKey,
    messageId: plan.messageId,
    clientId: plan.clientId,
    why,
  });
}

/**
 * Settlement handlers for a launch nobody is waiting on.
 *
 * Every parked dispatch is one of these now: the caller was answered at
 * ACCEPTANCE (task 2.4), and an adopted row's caller belonged to a process that
 * is gone. So a failure has to be reported here or it is reported nowhere.
 */
function unwatchedSettle(plan: DispatchPlan): {
  resolve(result: TriggerTurnResult): void;
  reject(err: unknown): void;
} {
  return {
    resolve: () => {},
    reject: (err: unknown) => {
      logger.warn('[MessageDispatcher] a waiting message failed to start', {
        sessionId: plan.sessionKey,
        messageId: plan.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  };
}

/**
 * Start one accepted message's turn: claim the session, hand it to
 * {@link triggerTurn}, and take it off the queue once the turn is really
 * running.
 *
 * Shared by every way a message reaches this point — accepted onto an idle
 * session, released from the queue by the pump, or a row
 * {@link adoptQueuedMessages} recovered after a restart — so all of them leave
 * the queue on the same signal, announce that the queue moved, and hand the
 * session back the same way however they got here.
 *
 * **The message leaves the queue at `turn_start`, not here at the attempt.** See
 * the module doc: an attempt the write-lock refuses must leave the words where
 * they were, and {@link returnToQueue} puts the message back in line.
 *
 * @param plan - The message, its session, and the turn's passthroughs
 * @param opts.budgetExhausted - The wait bound fired: launch anyway, with no
 *   budget left and WITHOUT claiming the in-flight slot, so this message meets
 *   the write-lock exactly as a stranger would rather than telling the pump the
 *   turn ahead of it had ended
 */
function launchDispatch(
  plan: DispatchPlan,
  opts: { budgetExhausted: boolean }
): Promise<TriggerTurnResult> {
  const { sessionKey, clientId, messageId } = plan;
  const remainingMs = opts.budgetExhausted
    ? 0
    : Math.max(0, plan.budgetMs - (Date.now() - plan.startedWaitingAt));
  const token = Symbol('dispatcher-turn');
  if (!opts.budgetExhausted)
    inFlight.set(sessionKey, { clientId, token, startedAt: Date.now(), sawTurnStart: false });
  // Held from here until this launch is done with the message, whichever way it
  // ends. Every exit below routes through `clearIfOurs` — the sync throw, the
  // rejection, the refusal, and the settle — so there is no path that leaves an
  // id behind, and each of them hands the message back to `pending` (or to
  // nobody, if it ran) in the same synchronous beat.
  launching.add(messageId);
  const clearIfOurs = (): void => {
    launching.delete(messageId);
    if (inFlight.get(sessionKey)?.token === token) inFlight.delete(sessionKey);
    schedulePump(sessionKey);
  };
  const { turn } = plan;
  let started: Promise<TriggerTurnResult>;
  try {
    started = triggerTurn({
      sessionId: plan.sessionId,
      clientId,
      // The ROW's words, not the ones the plan was built with: a message that
      // waited may have been reworded while it waited, and running what the
      // person first typed instead of what they left in the queue would make
      // the edit a lie.
      content: getMessageQueueStore()?.get(messageId)?.content ?? plan.content,
      ...(turn.cwd !== undefined ? { cwd: turn.cwd } : {}),
      ...(turn.context ? { context: turn.context } : {}),
      ...(turn.roomContext ? { roomContext: turn.roomContext } : {}),
      ...(turn.seedContext ? { seedContext: turn.seedContext } : {}),
      ...(turn.settings ? { settings: turn.settings } : {}),
      ...(turn.stallTimeoutMs !== undefined ? { stallTimeoutMs: turn.stallTimeoutMs } : {}),
      // The turn is running: THIS is the instant the message stops waiting, and
      // every window is told so in the same beat — a queue chip that outlives
      // the message it stands for is a lie about what is still waiting.
      onTurnStart: (seq) => {
        if (getMessageQueueStore()?.remove(messageId)) emitQueueUpdate(sessionKey);
        // The turn is on the projector now, so the projector — not this slot —
        // becomes the authority on whether it is still producing
        // ({@link isStillProducing}). Only for OUR launch: a stale settle must
        // not annotate a newer turn's slot.
        const slot = inFlight.get(sessionKey);
        if (slot?.token === token) slot.sawTurnStart = true;
        turn.onTurnStart?.(seq);
      },
      projector: plan.projector,
      deps: turnDeps(plan.runtime),
      queueWaitMs: remainingMs,
      messageId,
      onError: turn.onError,
      onSettled: (turnOutcome) => {
        clearIfOurs();
        turn.onSettled?.(turnOutcome);
      },
    });
  } catch (err) {
    clearIfOurs();
    returnToQueue(plan);
    // Rejected with what was thrown, unchanged: `triggerTurn` throws typed
    // errors its callers narrow on, and re-wrapping would cost them that.
    return Promise.reject(err as Error);
  }
  return started.then(
    (result) => {
      // A refused turn never settles, so nothing else will hand the slot back.
      if (!result.accepted) {
        clearIfOurs();
        returnToQueue(plan);
      }
      return result;
    },
    (err: unknown) => {
      clearIfOurs();
      returnToQueue(plan);
      throw err;
    }
  );
}

/**
 * Park a message in the pending set until the pump releases it, bounded so a
 * turn that went dark cannot make it wait forever.
 *
 * @param plan - The message and everything its turn will need
 * @param settle - Receives the launch's result, however it settles
 * @param opts.waitingOnLock - This message has already been refused by the
 *   write-lock once, so the pump leaves it alone until a turn boundary; see
 *   {@link PendingDispatch.waitingOnLock}
 */
function parkDispatch(
  plan: DispatchPlan,
  settle: { resolve(result: TriggerTurnResult): void; reject(err: unknown): void },
  opts?: { waitingOnLock?: boolean }
): void {
  // Taken HERE, where the message was accepted, and applied wherever the pump
  // eventually calls `launch` — which is inside the PREVIOUS turn's scope on
  // both routes that reach it: the projector's `turn_end`, and the turn handing
  // its slot back. Correlation follows the call chain, and a parked closure's
  // call chain is not its own, so without this snapshot a queued turn logs
  // under the id of the turn it waited behind (DOR-1159). The `setTimeout`
  // below never had the problem, because a timer captures its creation context;
  // this makes the two paths agree.
  const scope = captureDispatchScope();
  const entry: PendingDispatch = {
    messageId: plan.messageId,
    sessionKey: plan.sessionKey,
    clientId: plan.clientId,
    waitingOnLock: opts?.waitingOnLock ?? false,
    launch: (launchOpts) => {
      if (!pending.delete(plan.messageId)) return;
      clearTimeout(entry.timer);
      scope(() => {
        void launchDispatch(plan, launchOpts).then(settle.resolve, settle.reject);
      });
    },
    // Bounded for the same reason DOR-1088 bounds its chain: the write-lock has
    // a TTL and a queue does not, so a turn that went dark would otherwise hand
    // the session to a stranger while its own client's message waited forever.
    //
    // The bound ends two different ways, because the two kinds of waiting made
    // two different promises. A queued message is somebody's words: it launches
    // anyway, meeting the write-lock as a stranger would. A transient one is a
    // refusing caller's trigger: forcing it through would put a second
    // `sendMessage` on a session whose stream is still open, so it is dropped.
    timer: setTimeout(() => {
      if (plan.transient) {
        dropTransient(plan, 'the stream it was waiting on had not closed within the wait budget');
        return;
      }
      entry.launch({ budgetExhausted: true });
    }, plan.budgetMs),
  };
  entry.timer.unref?.();
  pending.set(plan.messageId, entry);
}

/**
 * Accept a message and decide when it runs.
 *
 * Resolves at ACCEPTANCE (task 2.4): immediately for a message that has to
 * wait, and — for one that can run now — as soon as its turn has started and the
 * canonical id is known. Nothing here waits for a turn ahead of it.
 *
 * The message is persisted before anything else, so from the moment this returns
 * it survives a refresh, a second window, a failed turn and a restart. It leaves
 * the queue when a turn actually STARTS with it; see the module doc for why that
 * is not the same moment as the launch attempt.
 *
 * @param opts - The message, its sender, the session's projector and runtime
 * @returns The delivery outcome, the queue position it was accepted at, whether
 *   it is waiting, and the `{ accepted, canonicalId }` every caller has read
 */
export async function dispatchMessage(opts: DispatchMessageOpts): Promise<MessageDispatchResult> {
  const { sessionId, clientId, content, projector, runtime } = opts;
  const requested = opts.disposition ?? 'queue';
  const caps = runtime.getCapabilities();
  const sessionKey = primaryOf(runtime.getInternalSessionId(sessionId) ?? sessionId);
  const queueKey = queueKeyOf(sessionId);
  const budgetMs = opts.queueWaitMs ?? SESSIONS.LOCK_TTL_MS;
  const whenBusy = opts.whenBusy ?? 'queue';

  // The degradation ladder (task 4.4). A steer or stage that can land natively
  // does so here and answers its caller without ever becoming a queue row;
  // everything else — and every downgrade — falls through to the queue below,
  // carrying the reason it could not be delivered as asked.
  let degradedBecause: DispositionDowngradeReason | undefined;
  if (requested !== 'queue') {
    const rung = await deliverByDisposition(opts, requested, caps);
    if ('landed' in rung) return rung.landed;
    degradedBecause = rung.degrade;
  }

  // Asked and answered before anything is written: a caller that refuses rather
  // than waits must not leave a row behind for a message it is about to disown.
  const open = inFlight.get(sessionKey);
  if (open && refusesOpenTurn({ whenBusy, open, clientId, sessionKey, projector })) {
    return {
      accepted: false,
      queued: false,
      outcome: {
        messageId: crypto.randomUUID(),
        requested,
        applied: 'queue',
        ...(degradedBecause ? { degradedBecause } : {}),
      },
      queuePosition: 0,
      // The turn this was refused for, named by the same authority that refused
      // it — so a 409 built from this cannot invent a holder (DOR-1239).
      refusedBy: { clientId: open.clientId, since: open.startedAt },
    };
  }

  // Anything a previous server process left queued is picked up first, so this
  // message joins a queue that is whole rather than jumping a person's own
  // older words that nothing else would ever run again.
  adoptQueuedMessages({
    sessionId,
    projector,
    runtime,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });

  // A blanket-`'refuse'` caller that got past the gate with the slot still held
  // got past it for exactly one reason — the turn holding it has ENDED — so it is
  // waiting out a stream that is closing rather than queueing behind work. It
  // waits with no row at all. See {@link DispatchPlan.transient}.
  const transient =
    whenBusy === 'refuse' && open !== undefined && !isStillProducing(open, sessionKey, projector);

  const record = transient
    ? undefined
    : getMessageQueueStore()?.enqueue({
        sessionId: queueKey,
        content,
        clientId,
        disposition: requested,
        context: opts.context ?? null,
      });
  const messageId = record?.id ?? crypto.randomUUID();
  // Its place in the queue at acceptance: the row's, or the head when no store is
  // wired — and 0 for a message that is deliberately on no queue at all.
  let queuePosition = transient ? 0 : 1;
  if (record) {
    queuePosition =
      (getMessageQueueStore()
        ?.list(queueKey)
        .findIndex((row) => row.id === messageId) ?? 0) + 1;
  }
  const outcome: MessageDeliveryOutcome = {
    messageId,
    requested,
    applied: 'queue',
    ...(degradedBecause ? { degradedBecause } : {}),
  };
  // The acceptance is a queue change like any other, and it carries the outcome:
  // this is what lets the sender's window say "queued, because Codex cannot take
  // messages mid-turn" instead of silently doing something else.
  if (record) emitQueueUpdate(queueKey, outcome);

  const plan: DispatchPlan = {
    sessionId,
    sessionKey,
    clientId,
    content,
    messageId,
    projector,
    runtime,
    budgetMs,
    startedWaitingAt: Date.now(),
    whenBusy,
    answered: false,
    transient,
    turn: opts,
  };

  /** Accepted, waiting: the answer for every message that does not start now. */
  const waiting = (): MessageDispatchResult => ({
    accepted: true,
    queued: true,
    canonicalId: runtime.getInternalSessionId(sessionId) ?? sessionId,
    outcome,
    queuePosition,
  });

  // A session with a turn open takes the message and holds it — whoever sent it.
  // Racing a second stream into one session is what left a live session showing
  // an idle composer (DOR-1088), and refusing the second window instead is what
  // task 2.4 retires.
  if (inFlight.has(sessionKey)) {
    // Told it was accepted, so it can no longer be quietly dropped — including
    // for the refusing caller that reaches here, which is a `'refuse-foreign'`
    // waiting out its own turn. See {@link DispatchPlan.answered}.
    plan.answered = true;
    parkDispatch(plan, unwatchedSettle(plan));
    return waiting();
  }

  let result: TriggerTurnResult;
  try {
    result = await launchDispatch(plan, { budgetExhausted: false });
  } catch (err) {
    // The launch threw rather than being refused. `returnToQueue` has already
    // decided what becomes of the message; a caller that asked to refuse still
    // wants the throw, and one that is queueing has an accepted message either
    // way and learns about the failure through `onError`.
    if (whenBusy !== 'queue') throw err;
    return waiting();
  }
  if (result.accepted) return { ...result, queued: false, outcome, queuePosition };
  // The write-lock said no. For a refusing caller that is the answer — and for
  // `'refuse-foreign'` too, because the lock is the one place a caller's OWN
  // turn never refuses it: a same-client trigger waits in `SessionTurnQueue`
  // before it ever reaches the lock, so a refusal here is a stranger by
  // construction. For everybody else the message kept its place in the queue and
  // runs when the holder lets go.
  if (whenBusy !== 'queue') {
    // Named from the lock that just said no, asked under the id it is actually
    // keyed by — the canonical one, which a route does not necessarily hold.
    const held = runtime.getLockInfo(runtime.getInternalSessionId(sessionId) ?? sessionId);
    return {
      accepted: false,
      queued: false,
      outcome,
      queuePosition: 0,
      ...(held ? { refusedBy: { clientId: held.clientId, since: held.acquiredAt } } : {}),
    };
  }
  return waiting();
}

/** Inputs for {@link adoptQueuedMessages}. */
export interface AdoptQueuedMessagesOpts {
  /** Either id a caller might hold for the session (request uuid or canonical). */
  sessionId: string;
  /** The session's projector — the gate the pump reads before it releases anything. */
  projector: SessionStateProjector;
  /** The runtime an adopted message's turn will run on. */
  runtime: AgentRuntime;
  /** Working directory for the recovered turns, when the caller knows it. */
  cwd?: string;
}

/**
 * Take ownership of queue rows this process did not accept, so they run.
 *
 * A row that survives a restart is INERT on its own: the row is still there and
 * a snapshot still reports it, but the in-memory entry the pump releases died
 * with the old process, and nothing recreates it. The person is shown their
 * message waiting for a turn that will never come.
 *
 * This ADOPTS each surviving row **by its existing id** — same row, same
 * position, same words, same `enqueuedBy` — and wraps a pending entry around it
 * so the next turn boundary pumps it exactly as if this process had accepted it.
 * It deliberately does NOT re-offer them through {@link dispatchMessage}: that
 * would enqueue a fresh row beside every original and hand the person their
 * queue twice, which is the one failure worse than the queue not running at all.
 *
 * Idempotent by construction — a row this process is already carrying is
 * skipped, whether it is waiting ({@link pending}) or already on its way out
 * ({@link launching}) — so it is safe to call on every dispatch, which is what
 * makes recovery automatic rather than something a caller has to remember. Both
 * halves are load-bearing: a row is briefly in NEITHER the pending set nor the
 * store's rear-view while its turn assembles its context, and adopting there
 * sends somebody's message twice.
 *
 * Ends by giving the queue a chance to move: an idle session with rows on disk
 * has nothing else coming that would ever start them.
 *
 * @param opts - The session, its projector, and the runtime to run on
 * @returns How many rows were newly adopted
 */
export function adoptQueuedMessages(opts: AdoptQueuedMessagesOpts): number {
  const store = getMessageQueueStore();
  if (!store) return 0;
  const sessionKey = primaryOf(opts.sessionId);
  const rows = store.list(queueKeyOf(opts.sessionId));
  let adopted = 0;
  for (const row of rows) {
    if (pending.has(row.id) || launching.has(row.id)) continue;
    // The dispatch that accepted this row belonged to a process that is gone,
    // and its id went with it. Adoption is a new dispatch — its own id, its own
    // origin — because the alternative is a turn that appears in the log under
    // whichever unrelated caller happened to trigger the adoption sweep, or
    // under nothing at all.
    const dispatchId = newDispatchId();
    recordDispatchStart({ dispatchId, origin: 'queue-recovery', sessionId: sessionKey });
    const plan: DispatchPlan = {
      sessionId: opts.sessionId,
      sessionKey,
      clientId: row.enqueuedBy,
      content: row.content,
      messageId: row.id,
      projector: opts.projector,
      runtime: opts.runtime,
      budgetMs: SESSIONS.LOCK_TTL_MS,
      startedWaitingAt: Date.now(),
      // A recovered row is somebody's words with nobody left to retype them, so
      // it queues rather than being dropped if its first launch is refused.
      whenBusy: 'queue',
      // Its sender was told this was accepted by a process that no longer
      // exists, which is the strongest form of the reason the `'queue'` above
      // gives: there is nobody left to retype it.
      answered: true,
      // A recovered row is a row by definition, and somebody's words: it waits
      // as long as the queue waits.
      transient: false,
      turn: {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(row.context !== null ? { context: row.context } : {}),
        // Nobody is holding a request open for this one, so the buffer entry
        // would otherwise never be closed out.
        onSettled: (outcome) =>
          recordDispatchEnd(dispatchId, outcome === 'failed' ? 'failed' : 'answered'),
      },
    };
    // Parked INSIDE the scope, so the snapshot `parkDispatch` takes is this
    // recovery dispatch's rather than the caller's — an adoption triggered by
    // somebody else's `dispatchMessage` must not put its turn under that
    // person's id.
    runInDispatch({ dispatchId, origin: 'queue-recovery' }, () =>
      parkDispatch(plan, unwatchedSettle(plan))
    );
    adopted += 1;
  }
  if (adopted > 0) schedulePump(sessionKey);
  return adopted;
}

/** Inputs for {@link dispatchCommandIntent}. */
export interface DispatchCommandIntentOpts {
  sessionId: string;
  clientId: string;
  /** The runtime-fulfilled intent to dispatch (e.g. `'compact'`). */
  intent: RuntimeCommandIntentId;
  cwd?: string;
  /** Trailing instructions after the intent token. */
  instructions?: string;
  projector: SessionStateProjector;
  runtime: AgentRuntime;
  stallTimeoutMs?: number;
  /**
   * Total waiting budget. Defaults to {@link COMMAND_INTENT_QUEUE_WAIT_MS},
   * deliberately SHORTER than a turn's: the client abandons the request at
   * `COMMAND_INTENT_REQUEST_TIMEOUT_MS`, and a server that waited longer would
   * show the person a failure and compact the conversation afterwards anyway
   * (DOR-1101). Both bounds derive from the one constant, so they cannot drift.
   */
  queueWaitMs?: number;
  onError?(err: unknown): void;
}

/**
 * Dispatch a runtime-fulfilled command intent through the same ingress a message
 * uses.
 *
 * A `/compact` is not a special case of contention: for claude-code
 * `executeCommandIntent` is literally `sendMessage('/compact')`, so it contends
 * for the session's single writer exactly like a turn and has to be serialized
 * by the same thing. It is deliberately NOT persisted as a queue row — a queue
 * row is a person's words waiting to be said, and a command intent is neither
 * words nor something a person would want to find sitting in their composer.
 *
 * @param opts - The intent, its sender, the session's projector and runtime
 * @returns `{ accepted: false }` when the session is locked by another client
 */
export async function dispatchCommandIntent(
  opts: DispatchCommandIntentOpts
): Promise<{ accepted: boolean }> {
  const { sessionId, clientId, intent, projector, runtime } = opts;
  const sessionKey = primaryOf(runtime.getInternalSessionId(sessionId) ?? sessionId);
  const token = Symbol('dispatcher-command-intent');
  // Claim the session only if nothing already holds it. A compact arriving on a
  // busy session answers for itself at the chain and the lock; overwriting the
  // running turn's claim here would tell the pump that turn had ended.
  //
  // `sawTurnStart` stays false for the whole run, which is the conservative
  // answer and the deliberate one: a command intent reports no turn start to
  // this module, so nothing could ever flip it, and a slot that never claims to
  // have started reads as producing for as long as it is held
  // ({@link isStillProducing}). A refusing caller therefore keeps meeting a
  // refusal across a compact — which is what a compact is.
  if (!inFlight.has(sessionKey))
    inFlight.set(sessionKey, { clientId, token, startedAt: Date.now(), sawTurnStart: false });
  const clearIfOurs = (): void => {
    if (inFlight.get(sessionKey)?.token === token) inFlight.delete(sessionKey);
    schedulePump(sessionKey);
  };
  try {
    const result = await triggerCommandIntent({
      sessionId,
      clientId,
      intent,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
      ...(opts.stallTimeoutMs !== undefined ? { stallTimeoutMs: opts.stallTimeoutMs } : {}),
      projector,
      deps: {
        acquireLock: (sid, cid, lifecycle, tok) => runtime.acquireLock(sid, cid, lifecycle, tok),
        releaseLock: (sid, cid, tok) => runtime.releaseLock(sid, cid, tok),
        executeCommandIntent: (sid, i, o) => runtime.executeCommandIntent(sid, i, o),
        interruptQuery: (sid) => runtime.interruptQuery(sid),
        getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
      },
      queueWaitMs: opts.queueWaitMs ?? COMMAND_INTENT_QUEUE_WAIT_MS,
      onError: opts.onError,
      // The run is detached and the 202 has gone out long before it ends, so
      // this is the only moment the dispatcher can learn the session is free.
      onSettled: clearIfOurs,
    });
    // A refused run never settles at all, so nothing else will hand it back.
    if (!result.accepted) clearIfOurs();
    return result;
  } catch (err) {
    clearIfOurs();
    throw err;
  }
}

/** Inputs for {@link deliverSteer}. */
export interface DeliverSteerOpts {
  /** The session to steer; either id a caller might hold. */
  sessionId: string;
  /** The client asking to steer — the identity the authorization gate turns on. */
  clientId: string;
  /** The person's words, passed through pristine. */
  content: string;
  /** The server-minted correlation id for this steered message. */
  messageId: string;
  /** The neutral context bag, assembled server-side; rendered out of band. */
  additionalContext?: AdditionalContext;
  /** The runtime this session resolves to. */
  runtime: AgentRuntime;
}

/**
 * What a steer did, plus whether the caller was allowed to make it.
 *
 * `authorized: false` is distinct from an ordinary `delivered: false`: the
 * steer was refused before the runtime was ever asked, because the caller does
 * not own the turn. The degradation ladder (task 4.4) turns an unauthorized or
 * undelivered steer into a queued message; this is the receipt it reads.
 */
export interface SteerDeliveryResult extends RuntimeDeliveryResult {
  /** True when the caller was entitled to steer this session's live turn. */
  authorized: boolean;
}

/**
 * Steer a message into a session's live turn, through the same ingress and the
 * same authorization a turn passes (spec `persistent-session-runtime` §2.3,
 * task 4.1).
 *
 * **A steer is a WRITE.** A live turn is owned by exactly one client — the one
 * holding its write-lock — and injecting a message into that turn is as much a
 * write as starting it. So the authorization is the identical gate `sendMessage`
 * passes, asked of the identical authority: the runtime's real write-lock, via
 * {@link AgentRuntime.isLocked}. It is deliberately NOT the dispatcher's
 * {@link inFlight} mirror, which is lossy — a budget-exhausted launch runs its
 * turn holding the real lock WITHOUT ever claiming `inFlight`
 * ({@link launchDispatch} sets it only when `!budgetExhausted`), so `inFlight`
 * can be empty while a steerable turn is live, and gating on it would let ANY
 * client — including one that could not send right now — steer that turn.
 * `isLocked(key, clientId)` closes that hole: true only when a DIFFERENT client
 * holds the live lock, false for the owner, and false when no turn is open (the
 * lock is free and every client may send, so the runtime just reports
 * `no-open-turn`).
 *
 * Held under the dispatch mutex so the lock check and the delivery cannot
 * straddle a turn ending or a reap: the same mutex every turn boundary and the
 * warm-process reaper take, so a steer racing either simply does not interleave.
 *
 * This is the ONE server path to a runtime's `deliverIntoTurn`, exactly as
 * {@link dispatchMessage} is the one path to `sendMessage` — the single-ingress
 * audit (`dispatcher-single-ingress.test.ts`) holds it to that, so no caller
 * can reach the write around this gate.
 *
 * @param opts - The session, the steering client, the message, and the runtime
 * @returns Whether the caller was authorized, whether the steer was delivered,
 *   and why not when it was not
 */
export async function deliverSteer(opts: DeliverSteerOpts): Promise<SteerDeliveryResult> {
  const { sessionId, clientId, runtime } = opts;
  // The lock is keyed by the canonical id when one is known — the same `turnKey`
  // `triggerTurn` acquires it under — so ask under that id, not the request uuid.
  const lockKey = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const sessionKey = primaryOf(lockKey);
  return withDispatchMutex(sessionKey, async () => {
    // A DIFFERENT client holds the live write-lock: this client could not send
    // now, so it may not steer now. The only refusal that is authorization's.
    if (runtime.isLocked(lockKey, clientId)) {
      return { authorized: false, delivered: false };
    }
    // A runtime that declares neither steer nor stage simply omits the method;
    // the ladder degrades around a missing implementation rather than failing.
    if (runtime.deliverIntoTurn === undefined) {
      return { authorized: true, delivered: false, reason: 'unsupported' };
    }
    const result = await runtime.deliverIntoTurn(sessionId, opts.content, {
      mode: 'steer',
      messageId: opts.messageId,
      ...(opts.additionalContext !== undefined
        ? { additionalContext: opts.additionalContext }
        : {}),
    });
    // A delivered steer reached the model but carries no turn-shaped events of
    // its own — mint the `turn_input` carrier so the person's words render
    // inline in the open turn and survive a reconnect and a cold hydrate. Only
    // on delivery: a degraded or refused steer joined no turn, so there is
    // nothing to show inside one (task 4.3). Under the same mutex as the lock
    // check, so the ingest cannot straddle a turn ending.
    if (result.delivered) emitTurnInput(sessionKey, opts.content, opts.messageId);
    return { authorized: true, ...result };
  });
}

/** Inputs for {@link deliverStage}. */
export interface DeliverStageOpts {
  /** The session to stage onto; either id a caller might hold. */
  sessionId: string;
  /** The client staging — the identity the authorization gate turns on. */
  clientId: string;
  /** The person's words, passed through pristine. */
  content: string;
  /** The server-minted correlation id for this staged message. */
  messageId: string;
  /** The neutral context bag, assembled server-side; rendered out of band. */
  additionalContext?: AdditionalContext;
  /** The runtime this session resolves to. */
  runtime: AgentRuntime;
}

/**
 * What a stage did, plus whether the caller was allowed to make it.
 *
 * `authorized: false` is distinct from an ordinary `delivered: false`, exactly as
 * it is for a steer: the stage was refused before the runtime was ever asked,
 * because a DIFFERENT client owns the live turn.
 */
export interface StageDeliveryResult extends RuntimeDeliveryResult {
  /** True when the caller was entitled to write to this session. */
  authorized: boolean;
  /**
   * True when the stage landed via the fold-into-next FALLBACK rather than the
   * runtime's native transcript — the text is held and rides the next dispatch.
   * Absent on the native path. The person cannot tell the two apart, and should
   * not have to; this is for callers that log or degrade.
   */
  viaFallback?: boolean;
}

/**
 * Stage a message onto a session WITHOUT provoking a turn, through the same
 * ingress and the SAME authorization a steer and a turn pass (spec
 * `persistent-session-runtime` §2.5, task 4.2).
 *
 * **A stage is a WRITE**, so its authorization is identical to {@link
 * deliverSteer}'s: the runtime's real write-lock via {@link
 * AgentRuntime.isLocked}, refusing only when a DIFFERENT client owns the live
 * turn. The one difference from a steer is what a FREE lock means. A steer with
 * no open turn is `no-open-turn` — there is nothing to join. A stage needs no
 * open turn at all: a free lock is the ordinary case, and a cold session is warmed
 * so the message can reach a transcript. So this never reports `no-open-turn`.
 *
 * **Native, then fallback.** The runtime is asked to stage natively
 * ({@link AgentRuntime.deliverIntoTurn} with `mode: 'stage'`). A runtime that
 * cannot — it does not implement the method, or answers `unsupported` — degrades
 * to the fold-into-next fallback: the text is held ({@link holdStagedContext})
 * and rides the next dispatch as a `staged_context` entry, so nothing the person
 * staged is lost. Both paths emit the same `context_staged` receipt. This mirrors
 * the way {@link deliverSteer} degrades around a missing implementation rather
 * than reading a capability flag — the flag is the routing layer's concern (task
 * 4.4), not this gate's.
 *
 * Held under the dispatch mutex so the lock check and the delivery cannot
 * straddle a turn boundary or a reap, and so a stage that warms a cold session
 * does not interleave with a dispatch on the same session.
 *
 * This is the ONE server path to a runtime's `deliverIntoTurn` for a stage, the
 * same single ingress {@link deliverSteer} is for a steer — the single-ingress
 * audit holds both to it.
 *
 * @param opts - The session, the staging client, the message, and the runtime
 * @returns Whether the caller was authorized, whether the stage was delivered,
 *   whether it went via the fallback, and why not when it did not land
 */
export async function deliverStage(opts: DeliverStageOpts): Promise<StageDeliveryResult> {
  const { sessionId, clientId, runtime, content, messageId } = opts;
  // Keyed exactly as `deliverSteer` and `triggerTurn` key it — the canonical id
  // when known — so the lock check asks the same authority a turn would.
  const lockKey = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const sessionKey = primaryOf(lockKey);
  return withDispatchMutex(sessionKey, async () => {
    // A DIFFERENT client holds the live write-lock: this client could not send
    // now, so it may not stage now. A FREE lock is NOT a refusal — a stage needs
    // no open turn — which is the whole difference from a steer's gate.
    if (runtime.isLocked(lockKey, clientId)) {
      return { authorized: false, delivered: false };
    }
    const native = runtime.deliverIntoTurn
      ? await runtime.deliverIntoTurn(sessionId, content, {
          mode: 'stage',
          messageId,
          ...(opts.additionalContext !== undefined
            ? { additionalContext: opts.additionalContext }
            : {}),
        })
      : { delivered: false, reason: 'unsupported' as const };
    if (native.delivered) {
      emitContextStaged(sessionId, content, messageId);
      return { authorized: true, delivered: true };
    }
    if (native.reason === 'unsupported') {
      // The runtime cannot append to its own transcript. Hold the person's words
      // and fold them into the next dispatch (ADR-0273); the same receipt goes
      // out, because to the person a stage landed either way.
      holdStagedContext(sessionId, content, messageId);
      emitContextStaged(sessionId, content, messageId);
      return { authorized: true, delivered: true, viaFallback: true };
    }
    // A transient the runtime named (a stream that closed under a warm process, a
    // boundary a cwd failed). Report it; the caller decides what to say. Not
    // folded into the fallback — that is for a runtime that CANNOT stage, not one
    // that momentarily could not.
    return { authorized: true, ...native };
  });
}

/**
 * Give a session's queue a chance to move, on the next microtask.
 *
 * Deferred rather than immediate because the two things that call it — the
 * projector's `turn_end` and a turn handing back its slot — both run inside
 * machinery the pump would otherwise re-enter.
 *
 * @param sessionId - The session whose queue should be reconsidered
 */
function schedulePump(sessionId: string): void {
  const sessionKey = primaryOf(sessionId);
  queueMicrotask(() => {
    void withDispatchMutex(sessionKey, () => pumpLocked(sessionKey)).catch((err: unknown) => {
      logger.warn('[MessageDispatcher] pump failed', {
        sessionId: sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/**
 * Launch the head of a session's queue, if anything may run.
 *
 * Order is the store's: by `position`, so the queue dispatches in the order a
 * person put it in, and a reorder is honoured without this needing to know a
 * reorder happened. Two gates stand in front of it, and both are refusals to
 * act rather than reasons to drop anything — whatever is queued stays queued.
 *
 * Must be called with the dispatch mutex held.
 */
function pumpLocked(sessionKey: string): void {
  // Firing into an open approval, question or elicitation is the failure this
  // gate exists for: the agent is parked on a person, and a queued prompt
  // arriving now is answered by nobody and read as the person's reply by the
  // model. Reuse the probe the write-lock and the stall watchdog already share.
  if (projectorFor(sessionKey)?.hasPendingInteractions()) return;
  // One turn at a time on a session, whoever owns it. The pump is called both
  // when a turn ENDS on the projector and when one hands its slot back, and the
  // first of those fires while the ending turn still holds the write-lock — so
  // this gate is also what keeps the queue from racing a release it would lose.
  if (inFlight.has(sessionKey)) return;
  const head = orderedWaiting(sessionKey)[0];
  if (!head || head.waitingOnLock) return;
  head.launch({ budgetExhausted: false });
}

/**
 * A session's waiting dispatches in the order they should run.
 *
 * The stored `position` is the authority, because that is what a reorder edits
 * and what every window reads. A dispatch with no row behind it — no store is
 * wired, which is every embedded host and most unit tests — keeps its arrival
 * order, which is the same answer for a queue nobody can reorder. `sort` is
 * stable, so the two groups interleave predictably rather than by accident.
 */
function orderedWaiting(sessionKey: string): PendingDispatch[] {
  const rows = getMessageQueueStore()?.list(queueKeyOf(sessionKey)) ?? [];
  const rank = new Map(rows.map((row, index) => [row.id, index]));
  return [...pending.values()]
    .filter((entry) => entry.sessionKey === sessionKey)
    .sort(
      (a, b) =>
        (rank.get(a.messageId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.messageId) ?? Number.MAX_SAFE_INTEGER)
    );
}

/**
 * The dispatcher's signal that a turn boundary was reached — wired to the
 * projector at the composition root.
 *
 * Fired for `turn_end` and for `interaction_resolved`, and for nothing else.
 * That list is the whole contract: a turn that ENDED is the only thing that
 * frees the session for the message behind it, and an interaction that was
 * ANSWERED is the only thing that clears the other gate. A bare `result` is
 * deliberately not on it.
 *
 * @param sessionId - The session whose boundary was reached
 */
export function noteTurnBoundary(sessionId: string): void {
  // A boundary is the only thing that can change the write-lock's answer, so it
  // is also what re-arms a message the lock refused earlier.
  const sessionKey = primaryOf(sessionId);
  for (const entry of pending.values()) {
    if (entry.sessionKey === sessionKey) entry.waitingOnLock = false;
  }
  schedulePump(sessionId);
}

/**
 * Record that the fleet has reported a session gone, so the sweep can reclaim
 * whatever it left queued.
 *
 * Keyed on ORPHANING — the session no longer exists as far as any runtime is
 * concerned — and deliberately NOT on in-memory eviction. An evicted session is
 * still perfectly real: it comes back the moment somebody opens it, and its
 * queue must come back with it.
 *
 * @param sessionId - The session the fleet reported removed
 */
export function noteSessionOrphaned(sessionId: string): void {
  orphanedSessions.add(primaryOf(sessionId));
}

/**
 * Delete the queued messages of every session that has gone away, and report
 * how many rows went.
 *
 * Called on the existing health-check cadence rather than on its own timer. A
 * session that has come back to life since it was reported gone is spared: the
 * report is a signal, not a verdict, and dropping somebody's queued words
 * because a watcher blinked is the one outcome worth guarding against.
 *
 * @param opts.isLive - Answers "is this session alive after all?"; defaults to
 *   asking the projector registry
 */
export function sweepOrphanedMessageQueues(opts?: {
  isLive?: (sessionId: string) => boolean;
}): number {
  if (orphanedSessions.size === 0) return 0;
  const isLive = opts?.isLive ?? ((id: string) => projectorFor(id) !== undefined);
  const candidates = [...orphanedSessions];
  orphanedSessions.clear();
  const doomed = candidates.filter((id) => !isLive(id) && !inFlight.has(id));
  const store = getMessageQueueStore();
  let removed = 0;
  for (let i = 0; i < doomed.length && store; i += SWEEP_CHUNK_SIZE) {
    removed += store.deleteForSessions(doomed.slice(i, i + SWEEP_CHUNK_SIZE).map(queueKeyOf));
  }
  // The rename bookkeeping goes with them. Two entries are added per renamed
  // session and nothing has ever removed one, so a long-lived server accumulates
  // a pair for every session it ever started — small, but unbounded, and the
  // sweep is the one place that already knows a session is gone for good.
  for (const id of doomed) forgetSessionAliases(id);
  if (removed > 0) {
    logger.info('[MessageDispatcher] swept queued messages of vanished sessions', {
      sessions: doomed.length,
      rows: removed,
    });
  }
  return removed;
}

/**
 * A session's queue as every client sees it — the head first.
 *
 * @param sessionId - The session to read
 */
export function listQueuedMessages(sessionId: string): QueuedMessage[] {
  return (getMessageQueueStore()?.list(queueKeyOf(sessionId)) ?? []).map(toQueuedMessage);
}

/**
 * Disarm the pending dispatch of a message somebody took off the queue.
 *
 * The dispatcher owns the pending set, so removing a row without telling it
 * would leave the message armed: it would fire anyway one turn boundary later,
 * which is the worst possible reading of a Remove. Called by
 * {@link cancelQueuedMessage}, which owns the row half of the same act.
 *
 * @param messageId - The server-minted message id
 * @returns True when a dispatch was armed and is now cancelled
 */
export function cancelPendingDispatch(messageId: string): boolean {
  const entry = pending.get(messageId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(messageId);
  return true;
}

/**
 * Drop every scrap of in-memory dispatcher state.
 *
 * @internal Exported for testing only — a dispatcher outlives one test file.
 */
export function resetMessageDispatcher(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  inFlight.clear();
  pending.clear();
  launching.clear();
  resetSessionKeys();
  dispatchMutex.clear();
  orphanedSessions.clear();
}

// Wired on import rather than from the composition root, deliberately. The
// dispatcher is only correct while it is listening: a host that forgot the
// wiring — the Obsidian plugin, a test harness, a future embedder — would get a
// queue that accepts messages and never runs them, which is the worst possible
// way to fail. There is nothing to configure and nothing to tear down, so
// there is nothing for a root to decide.
onProjectorTurnBoundary(noteTurnBoundary);
onProjectorRekey(linkSessionId);
onSessionRemoved(noteSessionOrphaned);
