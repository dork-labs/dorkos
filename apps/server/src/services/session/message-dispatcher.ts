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
 *    dispatcher resolves that against the resolved runtime's capabilities and
 *    answers with a {@link MessageDeliveryOutcome} saying what actually
 *    happened. Every runtime declares all three capability flags `false` today
 *    (task 2.1), so `steer` and `stage` come back as `applied: 'queue'` with
 *    `degradedBecause: 'unsupported'`. The ladder's shape is here; its native
 *    rungs land in P4.
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
 * The one exception is a `whenBusy: 'refuse'` caller, whose row IS removed when
 * its launch fails: it has said the message has no value later, and leaving it
 * behind would put a prompt nobody typed into somebody's composer for good.
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
 * Resolve what a sender asked for against what the runtime can actually do.
 *
 * The ladder has exactly one rung today. `queue` is the floor and is always
 * available, because the server owns the queue — that is why there is no
 * `supportsQueue` flag. `steer` and `stage` need a runtime that declares them,
 * and no runtime does (task 2.1 lands all three flags `false` everywhere and the
 * conformance suite holds them there), so both degrade to the floor and say so.
 *
 * P4 adds the native rungs ABOVE this fallback. Until they exist, a runtime that
 * declared the capability early would be promising something the server has no
 * mechanism for, so the honest answer is still "we queued it" — logged, because
 * a declaration arriving ahead of its mechanism is a bug in the adapter.
 *
 * @param requested - What the sender asked for; absent means `queue`
 * @param capabilities - The resolved runtime's declarations
 */
function resolveDisposition(
  requested: MessageDisposition,
  capabilities: RuntimeCapabilities
): Pick<MessageDeliveryOutcome, 'applied' | 'degradedBecause'> {
  if (requested === 'queue') return { applied: 'queue' };
  const declared =
    requested === 'steer' ? capabilities.supportsSteer : capabilities.supportsContextStaging;
  if (declared) {
    logger.error('[MessageDispatcher] runtime declares a disposition the server cannot deliver', {
      runtime: capabilities.type,
      requested,
    });
  }
  return { applied: 'queue', degradedBecause: 'unsupported' };
}

/**
 * The `queue_update` member as an emitter builds it — the projector stamps the
 * `seq`. Narrowed out of the union member by member, because a bare
 * `Omit<SessionEvent, 'seq'>` over a union keeps only the keys every member
 * shares and would drop `queue` and `outcome` on the floor.
 */
type RawQueueUpdate = Omit<Extract<SessionEvent, { type: 'queue_update' }>, 'seq'>;

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
   * - `'refuse'` — answer `{ accepted: false }` and write nothing. For a trigger
   *   a machine generated on somebody's behalf (a room turn, an MCP sign-in
   *   resume), where the reason it was sent may not survive the wait and firing
   *   it late is worse than not firing it.
   */
  whenBusy?: WhenBusy;
}

/**
 * What a caller wants done when the session is already working.
 *
 * @see DispatchMessageOpts.whenBusy
 */
export type WhenBusy = 'queue' | 'refuse';

/** What happened to a message the dispatcher accepted. */
export interface MessageDispatchResult extends TriggerTurnResult {
  /** What was asked for, what was applied, and why they differ. */
  outcome: MessageDeliveryOutcome;
  /**
   * Where the message sat in its session's queue at acceptance, 1-based.
   * `1` means it was the head — nothing was ahead of it. `0` means it was never
   * queued at all, which only a refusal is.
   */
  queuePosition: number;
  /**
   * True when the message was accepted onto the queue rather than started. Its
   * turn begins when the session frees up, announced on the session's stream
   * like every other queue change.
   */
  queued: boolean;
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
   * dropped with its row (`'refuse'`).
   */
  whenBusy: WhenBusy;
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
 * Give up on a message whose launch started no turn, or put it back in line.
 *
 * Which of the two is the caller's `whenBusy`, and the difference is a promise
 * to a person: a message somebody typed and was told was accepted must survive
 * a launch the write-lock refused, while a machine-generated trigger that asked
 * not to wait must not be left sitting in their composer.
 *
 * A message already gone from the queue — removed from another window between
 * the launch and its refusal — is left gone.
 */
function returnToQueue(plan: DispatchPlan): void {
  const store = getMessageQueueStore();
  if (plan.whenBusy === 'refuse') {
    if (store?.remove(plan.messageId)) emitQueueUpdate(plan.sessionKey);
    return;
  }
  if (store && !store.get(plan.messageId)) return;
  parkDispatch(plan, unwatchedSettle(plan), { waitingOnLock: true });
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
  if (!opts.budgetExhausted) inFlight.set(sessionKey, { clientId, token });
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
    timer: setTimeout(() => entry.launch({ budgetExhausted: true }), plan.budgetMs),
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
  const resolved = resolveDisposition(requested, runtime.getCapabilities());
  const sessionKey = primaryOf(runtime.getInternalSessionId(sessionId) ?? sessionId);
  const queueKey = queueKeyOf(sessionId);
  const budgetMs = opts.queueWaitMs ?? SESSIONS.LOCK_TTL_MS;
  const whenBusy = opts.whenBusy ?? 'queue';

  // Asked and answered before anything is written: a caller that refuses rather
  // than waits must not leave a row behind for a message it is about to disown.
  if (whenBusy === 'refuse' && inFlight.has(sessionKey)) {
    return {
      accepted: false,
      queued: false,
      outcome: { messageId: crypto.randomUUID(), requested, ...resolved },
      queuePosition: 0,
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

  const record = getMessageQueueStore()?.enqueue({
    sessionId: queueKey,
    content,
    clientId,
    disposition: requested,
    context: opts.context ?? null,
  });
  const messageId = record?.id ?? crypto.randomUUID();
  const queuePosition = record
    ? (getMessageQueueStore()
        ?.list(queueKey)
        .findIndex((row) => row.id === messageId) ?? 0) + 1
    : 1;
  const outcome: MessageDeliveryOutcome = { messageId, requested, ...resolved };
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
    if (whenBusy === 'refuse') throw err;
    return waiting();
  }
  if (result.accepted) return { ...result, queued: false, outcome, queuePosition };
  // The write-lock said no. For a refusing caller that is the answer; for
  // everybody else the message kept its place in the queue and runs when the
  // holder lets go.
  if (whenBusy === 'refuse') {
    return { accepted: false, queued: false, outcome, queuePosition: 0 };
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
  if (!inFlight.has(sessionKey)) inFlight.set(sessionKey, { clientId, token });
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
