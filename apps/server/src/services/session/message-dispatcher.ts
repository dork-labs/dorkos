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
 * 2. **Whether it runs now.** A message whose client already has a turn open on
 *    the session waits in the durable queue ({@link MessageQueueStore}) instead
 *    of starting a second stream beside it. Anything else is launched
 *    immediately and meets the write-lock exactly as it did before, so a second
 *    CLIENT still gets the same refusal it has always got.
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
 * ## What it does NOT change (yet)
 *
 * The HTTP contract is untouched by this task. A dispatch still resolves when
 * the turn actually STARTS, so `POST /api/sessions/:id/messages` still holds
 * its socket for a queued message and still answers `409 SESSION_LOCKED` when
 * another client holds the lock. Task 2.4 retires both: the 202 will resolve at
 * acceptance and the queue will be what a busy session returns. The queue rows
 * this module writes are what that change stands on.
 *
 * {@link SessionTurnQueue} (DOR-1088) is likewise kept, underneath: it is the
 * intra-process ordering primitive inside `triggerTurn` and this does not
 * replace it. What changes later is that an HTTP request stops waiting on it.
 *
 * @module services/session/message-dispatcher
 */
import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type {
  MessageDeliveryOutcome,
  MessageDisposition,
  QueuedMessage,
} from '@dorkos/shared/schemas';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SessionSettings } from '@dorkos/shared/types';
import type { ClientContext, RoomContextData } from '@dorkos/shared/additional-context';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { COMMAND_INTENT_QUEUE_WAIT_MS } from '@dorkos/shared/command-intents';
import { getMessageQueueStore, toQueuedMessage } from './message-queue-store.js';
import type { SessionStateProjector } from './session-state-projector.js';
import {
  onProjectorRekey,
  onProjectorTurnBoundary,
  peekProjector,
  rekeyProjector,
} from './session-state-projector.js';
import { onSessionRemoved } from './session-list-broadcaster.js';
import { triggerTurn, type TriggerTurnDeps, type TriggerTurnResult } from './trigger-turn.js';
import { triggerCommandIntent } from './trigger-command-intent.js';
import { SESSIONS } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

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
  /** Who asked for it, so it waits only behind that client's own turn. */
  clientId: string;
  /** Run it now. Idempotent — the wait bound and the pump can both reach it. */
  launch: (opts: { budgetExhausted: boolean }) => void;
  /** The wait bound's timer, cleared when the dispatch launches. */
  timer: ReturnType<typeof setTimeout>;
}

/** Turns open right now, keyed by resolved session id. */
const inFlight = new Map<string, InFlightTurn>();
/** Accepted messages waiting to launch, keyed by message id. */
const pending = new Map<string, PendingDispatch>();
/** Later-learned session id → the id its dispatcher state is filed under. */
const sessionAliases = new Map<string, string>();
/**
 * Filing id → the id the PROJECTOR is registered under today.
 *
 * The two diverge for one session's first turn: dispatcher state stays filed
 * under the id the session was born with, while the projector registry moves to
 * the canonical id. Without this the pending-interaction gate would look up a
 * projector that is no longer there and read "no interactions" from its
 * absence — a gate that cannot fail is worse than no gate.
 */
const projectorIds = new Map<string, string>();
/** Tail of each session's dispatch mutex chain; dropped when it drains. */
const dispatchMutex = new Map<string, Promise<void>>();
/** Sessions the fleet has reported gone, awaiting the next sweep. */
const orphanedSessions = new Set<string>();

/** The id `sessionId`'s dispatcher state is filed under (itself, unless aliased). */
function primaryOf(sessionId: string): string {
  return sessionAliases.get(sessionId) ?? sessionId;
}

/**
 * The id a session's queue ROWS are stored under.
 *
 * Deliberately NOT {@link primaryOf}, and the difference is load-bearing. The
 * dispatcher's in-memory state stays filed under the id a session was born with
 * so an in-flight turn keeps its slot across the rename; the durable rows go the
 * other way, moved onto the canonical id by the store's `rekeySession` on the
 * same beat the projector is re-keyed. Reading them back through the filing id
 * therefore finds nothing, and — worse — a message enqueued after the rename
 * would be written under the filing id and land in a SECOND queue nothing lists
 * and nothing drains. Every store call resolves its key here so there is only
 * ever one queue per session.
 *
 * It is also the key the snapshot reads by, because it resolves to exactly the
 * id the projector is registered under.
 *
 * @param sessionId - Either id a caller might hold (request uuid or canonical)
 */
function queueKeyOf(sessionId: string): string {
  const primary = primaryOf(sessionId);
  return projectorIds.get(primary) ?? primary;
}

/**
 * Record that a session has gained its canonical id, so state filed under the
 * id it was born with stays reachable.
 *
 * A brand-new session is dispatched to under the request UUID and gains its
 * real SDK id mid-first-turn. The queue ROWS move with it (the store's
 * `rekeySession`, called from the projector's rekey choke point); this moves the
 * in-memory half — the open turn and anything queued behind it — so the second
 * message a person types does not queue against a session key nothing will ever
 * pump.
 *
 * @param oldId - The id the state is filed under today
 * @param newId - The canonical id the session is now known by
 */
export function linkSessionId(oldId: string, newId: string): void {
  const primary = primaryOf(oldId);
  if (newId === primary) return;
  sessionAliases.set(newId, primary);
  projectorIds.set(primary, newId);
}

/** The projector for a filing id, following the canonical-id rename. */
function projectorFor(sessionKey: string): SessionStateProjector | undefined {
  return peekProjector(projectorIds.get(sessionKey) ?? sessionKey);
}

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
}

/** What happened to a message the dispatcher accepted. */
export interface MessageDispatchResult extends TriggerTurnResult {
  /** What was asked for, what was applied, and why they differ. */
  outcome: MessageDeliveryOutcome;
  /**
   * Where the message sat in its session's queue at acceptance, 1-based.
   * `1` means it was the head — nothing was ahead of it.
   */
  queuePosition: number;
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
 * Start one accepted message's turn: claim the session, take the message off the
 * queue, and hand it to {@link triggerTurn}.
 *
 * Shared by the two ways a message reaches this point — accepted onto an idle
 * session, or released from the queue by the pump (including a row
 * {@link adoptQueuedMessages} recovered after a restart) — so all of them take
 * the message off the queue, announce that the queue moved, and hand the
 * session back the same way however they got here.
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
  const clearIfOurs = (): void => {
    if (inFlight.get(sessionKey)?.token === token) inFlight.delete(sessionKey);
    schedulePump(sessionKey);
  };
  // The row goes as the turn starts, and every window is told so in the same
  // beat — a queue chip that outlives the message it stands for is a lie about
  // what is still waiting.
  if (getMessageQueueStore()?.remove(messageId)) emitQueueUpdate(sessionKey);
  const { turn } = plan;
  let started: Promise<TriggerTurnResult>;
  try {
    started = triggerTurn({
      sessionId: plan.sessionId,
      clientId,
      content: plan.content,
      ...(turn.cwd !== undefined ? { cwd: turn.cwd } : {}),
      ...(turn.context ? { context: turn.context } : {}),
      ...(turn.roomContext ? { roomContext: turn.roomContext } : {}),
      ...(turn.seedContext ? { seedContext: turn.seedContext } : {}),
      ...(turn.settings ? { settings: turn.settings } : {}),
      ...(turn.stallTimeoutMs !== undefined ? { stallTimeoutMs: turn.stallTimeoutMs } : {}),
      ...(turn.onTurnStart ? { onTurnStart: turn.onTurnStart } : {}),
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
    // Rejected with what was thrown, unchanged: `triggerTurn` throws typed
    // errors its callers narrow on, and re-wrapping would cost them that.
    return Promise.reject(err as Error);
  }
  return started.then(
    (result) => {
      // A refused turn never settles, so nothing else will hand the slot back.
      if (!result.accepted) clearIfOurs();
      return result;
    },
    (err: unknown) => {
      clearIfOurs();
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
 */
function parkDispatch(
  plan: DispatchPlan,
  settle: { resolve(result: TriggerTurnResult): void; reject(err: unknown): void }
): void {
  const entry: PendingDispatch = {
    messageId: plan.messageId,
    sessionKey: plan.sessionKey,
    clientId: plan.clientId,
    launch: (launchOpts) => {
      if (!pending.delete(plan.messageId)) return;
      clearTimeout(entry.timer);
      launchDispatch(plan, launchOpts).then(settle.resolve, settle.reject);
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
 * Accept a message, decide when it runs, and resolve once its turn has started
 * (or been refused).
 *
 * The message is persisted before anything else, so from the moment this is
 * called it survives a refresh, a second window, a failed turn and a restart.
 * It is removed from the queue at the instant it is dispatched.
 *
 * @param opts - The message, its sender, the session's projector and runtime
 * @returns The delivery outcome, the queue position it was accepted at, and the
 *   same `{ accepted, canonicalId }` every caller has always read
 */
export async function dispatchMessage(opts: DispatchMessageOpts): Promise<MessageDispatchResult> {
  const { sessionId, clientId, content, projector, runtime } = opts;
  const requested = opts.disposition ?? 'queue';
  const resolved = resolveDisposition(requested, runtime.getCapabilities());
  const sessionKey = primaryOf(runtime.getInternalSessionId(sessionId) ?? sessionId);
  const queueKey = queueKeyOf(sessionId);
  const budgetMs = opts.queueWaitMs ?? SESSIONS.LOCK_TTL_MS;

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
    turn: opts,
  };

  const launched = new Promise<TriggerTurnResult>((resolve, reject) => {
    // The first attempt is gated only by this client's own open turn. A message
    // from any OTHER client is launched straight away and meets the write-lock,
    // which is the answer that route has always given — deferring it here would
    // turn an immediate refusal into a wait of minutes.
    if (inFlight.get(sessionKey)?.clientId !== clientId) {
      launchDispatch(plan, { budgetExhausted: false }).then(resolve, reject);
      return;
    }
    parkDispatch(plan, { resolve, reject });
  });

  const result = await launched;
  return { ...result, outcome, queuePosition };
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
 * Idempotent by construction — a row that already has a pending entry is skipped
 * — so it is safe to call on every dispatch, which is what makes recovery
 * automatic rather than something a caller has to remember.
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
    if (pending.has(row.id)) continue;
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
      turn: {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(row.context !== null ? { context: row.context } : {}),
      },
    };
    parkDispatch(plan, {
      resolve: () => {},
      // Nobody is awaiting a recovered turn — the request that accepted it
      // belonged to a process that is gone — so a failure has to be reported
      // here or it is reported nowhere.
      reject: (err: unknown) => {
        logger.warn('[MessageDispatcher] a recovered queued message failed to start', {
          sessionId: sessionKey,
          messageId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });
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
  for (const entry of orderedWaiting(sessionKey)) {
    // A client waits behind its OWN open turn and nobody else's, so a message
    // from a second window is not held hostage by the first window's turn.
    if (inFlight.get(sessionKey)?.clientId === entry.clientId) continue;
    entry.launch({ budgetExhausted: false });
    return;
  }
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
 * Drop the canonical-id bookkeeping for a session that is gone for good, in both
 * directions: the filing id's forward pointer, and every later id that resolved
 * back to it.
 *
 * @param primary - The id the session's dispatcher state was filed under
 */
function forgetSessionAliases(primary: string): void {
  projectorIds.delete(primary);
  for (const [alias, target] of sessionAliases) {
    if (target === primary) sessionAliases.delete(alias);
  }
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
 * Drop every scrap of in-memory dispatcher state.
 *
 * @internal Exported for testing only — a dispatcher outlives one test file.
 */
export function resetMessageDispatcher(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  inFlight.clear();
  pending.clear();
  sessionAliases.clear();
  projectorIds.clear();
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
