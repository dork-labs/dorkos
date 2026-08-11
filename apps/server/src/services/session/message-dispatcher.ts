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
import type { SessionSettings } from '@dorkos/shared/types';
import type { ClientContext, RoomContextData } from '@dorkos/shared/additional-context';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { COMMAND_INTENT_QUEUE_WAIT_MS } from '@dorkos/shared/command-intents';
import { getMessageQueueStore } from './message-queue-store.js';
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
  const budgetMs = opts.queueWaitMs ?? SESSIONS.LOCK_TTL_MS;

  const record = getMessageQueueStore()?.enqueue({
    sessionId: sessionKey,
    content,
    clientId,
    disposition: requested,
    context: opts.context ?? null,
  });
  const messageId = record?.id ?? crypto.randomUUID();
  const queuePosition = record
    ? (getMessageQueueStore()
        ?.list(sessionKey)
        .findIndex((row) => row.id === messageId) ?? 0) + 1
    : 1;
  const outcome: MessageDeliveryOutcome = { messageId, requested, ...resolved };

  const startedWaitingAt = Date.now();
  const launched = new Promise<TriggerTurnResult>((resolve, reject) => {
    const launch = ({ budgetExhausted }: { budgetExhausted: boolean }): void => {
      const remainingMs = budgetExhausted
        ? 0
        : Math.max(0, budgetMs - (Date.now() - startedWaitingAt));
      const token = Symbol('dispatcher-turn');
      // Only a launch the pump permitted owns the in-flight slot. One released
      // by the wait bound is deliberately racing the turn ahead of it: it goes
      // straight to the write-lock and gets the same answer a stranger would.
      if (!budgetExhausted) inFlight.set(sessionKey, { clientId, token });
      const clearIfOurs = (): void => {
        if (inFlight.get(sessionKey)?.token === token) inFlight.delete(sessionKey);
        schedulePump(sessionKey);
      };
      getMessageQueueStore()?.remove(messageId);
      let turn: Promise<TriggerTurnResult>;
      try {
        turn = triggerTurn({
          sessionId,
          clientId,
          content,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.context ? { context: opts.context } : {}),
          ...(opts.roomContext ? { roomContext: opts.roomContext } : {}),
          ...(opts.seedContext ? { seedContext: opts.seedContext } : {}),
          ...(opts.settings ? { settings: opts.settings } : {}),
          ...(opts.stallTimeoutMs !== undefined ? { stallTimeoutMs: opts.stallTimeoutMs } : {}),
          ...(opts.onTurnStart ? { onTurnStart: opts.onTurnStart } : {}),
          projector,
          deps: turnDeps(runtime),
          queueWaitMs: remainingMs,
          messageId,
          onError: opts.onError,
          onSettled: (turnOutcome) => {
            clearIfOurs();
            opts.onSettled?.(turnOutcome);
          },
        });
      } catch (err) {
        clearIfOurs();
        reject(err);
        return;
      }
      turn.then(
        (result) => {
          // A refused turn never settles, so nothing else will hand the slot back.
          if (!result.accepted) clearIfOurs();
          resolve(result);
        },
        (err: unknown) => {
          clearIfOurs();
          reject(err);
        }
      );
    };

    // The first attempt is gated only by this client's own open turn. A message
    // from any OTHER client is launched straight away and meets the write-lock,
    // which is the answer that route has always given — deferring it here would
    // turn an immediate refusal into a wait of minutes.
    if (inFlight.get(sessionKey)?.clientId !== clientId) {
      launch({ budgetExhausted: false });
      return;
    }

    const entry: PendingDispatch = {
      messageId,
      sessionKey,
      clientId,
      launch: (launchOpts) => {
        if (!pending.delete(messageId)) return;
        clearTimeout(entry.timer);
        launch(launchOpts);
      },
      // Bounded for the same reason DOR-1088 bounds its chain: the write-lock has
      // a TTL and a queue does not, so a turn that went dark would otherwise hand
      // the session to a stranger while its own client's message waited forever.
      timer: setTimeout(() => entry.launch({ budgetExhausted: true }), budgetMs),
    };
    entry.timer.unref?.();
    pending.set(messageId, entry);
  });

  const result = await launched;
  return { ...result, outcome, queuePosition };
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
  const rows = getMessageQueueStore()?.list(sessionKey) ?? [];
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
  const store = getMessageQueueStore();
  if (!store || orphanedSessions.size === 0) return 0;
  const isLive = opts?.isLive ?? ((id: string) => projectorFor(id) !== undefined);
  const candidates = [...orphanedSessions];
  orphanedSessions.clear();
  const doomed = candidates.filter((id) => !isLive(id) && !inFlight.has(id));
  let removed = 0;
  for (let i = 0; i < doomed.length; i += SWEEP_CHUNK_SIZE) {
    removed += store.deleteForSessions(doomed.slice(i, i + SWEEP_CHUNK_SIZE));
  }
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
  const rows = getMessageQueueStore()?.list(primaryOf(sessionId)) ?? [];
  return rows.map(({ id, content, disposition, enqueuedAt, enqueuedBy }) => ({
    id,
    content,
    disposition,
    enqueuedAt,
    enqueuedBy,
  }));
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
