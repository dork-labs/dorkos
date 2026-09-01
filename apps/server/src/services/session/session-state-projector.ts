/**
 * Server-side source of truth for a single live session's projected state.
 *
 * One {@link SessionStateProjector} exists per live session (obtain via
 * {@link getOrCreateProjector}). An adapter (task #4 for Claude Code, task #15
 * for the stateless runtime) normalizes its native sources — the in-band SDK
 * query for triggered turns and file-watch deltas for externally-driven JSONL —
 * into {@link RawSessionEvent}s and feeds them through {@link SessionStateProjector.ingest}.
 *
 * The projector — NOT the adapter, NOT JSONL line numbers — owns the per-session
 * monotonic `seq` (ADR-0263): each ingested event is stamped `seq = ++counter`,
 * appended to both the {@link EventLog} (completed-turn history + replay overflow)
 * and the {@link RingBuffer} (current turn), and folded into the live projection
 * (status, in-progress turn, pending interactions, todos, subagents). Adapters
 * expose `subscribeSession`/`getSessionSnapshot` by delegating to
 * {@link SessionStateProjector.subscribe} / {@link SessionStateProjector.buildSnapshot}.
 *
 * The persistence source for completed `messages` is INJECTED into
 * {@link SessionStateProjector.buildSnapshot} (ADR-0263 "own the boundary, not
 * the bytes"): Claude passes a JSONL-backed loader; the stateless runtime passes
 * an EventLog-derived loader. The projector never reads bytes itself.
 *
 * @module services/session/session-state-projector
 */
import { StaleResumeCursorError, isBlockingInteractionEvent } from '@dorkos/shared/session-stream';
import type {
  SessionEvent,
  SessionSnapshot,
  SessionStatus,
  SessionContextUsage,
  SessionLifecycle,
} from '@dorkos/shared/session-stream';
import { deriveSessionActivity } from './activity/derive-activity.js';
import type {
  HistoryMessage,
  PendingInteractionDTO,
  PermissionMode,
  TaskItem,
} from '@dorkos/shared/types';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { INTERRUPTED_TERMINAL_REASONS } from '@dorkos/shared/schemas';
import { listPendingInteractions } from './pending-interactions.js';
import type { SessionDebugCounters } from './session-debug-counters.js';
import { logger } from '../../lib/logger.js';
import { EventLog } from './replay/event-log.js';
import { RingBuffer } from './replay/ring-buffer.js';
import { guardEventSize } from './replay/event-size-guard.js';
import { devtoolsCaptureStore } from './devtools-capture-store.js';
import type { SessionEventStore } from './session-event-store.js';
import { getMessageQueueStore, toQueuedMessage } from './message-queue-store.js';
import { getStagedContextStore } from './staged-context-store.js';
import {
  EAGERLY_RECORDED_EVENT_TYPES,
  RECORDED_EVENT_TYPES,
  type ProjectorPersistence,
  type ProjectorPersistenceMode,
} from './projector-persistence.js';

/**
 * An event as produced by an adapter: a {@link SessionEvent} union member with
 * the `seq` omitted. The projector stamps `seq` on ingest so the adapter never
 * has to track ordering. This keeps the adapter a pure normalizer.
 */
export type RawSessionEvent = Omit<SessionEvent, 'seq'>;

/**
 * How long past its cap an in-session capability hold (DOR-939) keeps pausing
 * the stall watchdog.
 *
 * The cap and `SESSIONS.TURN_STALL_TIMEOUT_MS` are both ten minutes, and both
 * clocks start on the same event — the inline card. So they expire on the same
 * millisecond: the hold degrades to the poll payload at exactly the moment the
 * watchdog would fire, and whichever wins the race decides whether the agent
 * gets its payload or has its turn interrupted. This grace makes that race
 * unloseable — the pause outlives the cap by long enough for the degrading
 * `capability_approval_resolved` to travel the queue and reset the watchdog —
 * while keeping the bound finite, which is the whole point of bounding it.
 */
export const CAPABILITY_HOLD_PAUSE_GRACE_MS = 30_000;

/**
 * How long a background child may stay silent, once its session has gone idle,
 * before DorkOS stops counting it as running (DOR-1104).
 *
 * ## Why a clock is needed at all
 *
 * `runningSubagents` drains two ways: the child reports a terminal status, or the
 * stream-end sweep retires it (`feedProjector`'s `finally`, DOR-1100). A child
 * that hits NEITHER — its turn interrupted, its process killed, a runtime that
 * simply stops reporting — used to sit in the count with no bound and nothing in
 * the system that could ever remove it. Since DOR-1100 that count is on screen as
 * "still working in the background", so a leaked child is a session that claims
 * forever to be about to speak again.
 *
 * The gap cannot be closed by reacting to events, because the failure IS the
 * absence of events: on a session nobody touches again, nothing ever arrives to
 * notice. So the bound is a clock, and this is its length.
 *
 * ## What the clock measures, and why fifteen minutes
 *
 * SILENCE, not age, and only while the session is idle. A child that keeps
 * reporting keeps its place however long it runs, and the clock restarts at every
 * `turn_end` — the agent working is itself evidence its children are fine, and
 * finishing is what wakes it.
 *
 * Fifteen minutes is longer than the turn stall timeout (ten), on purpose: a
 * quiet turn means the agent is stuck, but a quiet CHILD is ordinary — a subagent
 * can read for minutes between tool calls. It is short enough that a leak is a
 * bounded wrong answer rather than a permanent one, and the cost of being early
 * is small now that the retirement says `untracked`
 * (DOR-1108) rather than claiming the child stopped: expiring a child that was in
 * fact alive downgrades what DorkOS says to "I lost sight of it", which was true
 * the whole time.
 *
 * The real fix for child lifecycle is the persistent-session pump (spec
 * `persistent-session-runtime`, P3), which can ask the runtime what is actually
 * running. This is the honest bound until it lands.
 */
export const SUBAGENT_SILENCE_TIMEOUT_MS = 15 * 60_000;

/**
 * Shortest gap between two fan-outs that exist only to report a NEW tool
 * ({@link SessionStatus.activity}).
 *
 * A busy turn starts tools several times a second, and every fan-out here
 * becomes an SSE frame on every connected client, for every session in the
 * fleet. Two seconds is slow enough that the wire cost is a rounding error and
 * fast enough that a person watching a sidebar sees the row change while the
 * tool is still running.
 *
 * It throttles NEW activity only. Clearing one is never delayed — see
 * {@link SessionStateProjector.ingest}.
 */
export const ACTIVITY_FANOUT_THROTTLE_MS = 2_000;

/**
 * A sign-in card the projector is carrying past its own turn (DOR-1004), plus
 * how much of its grace it has spent.
 */
interface SigninCardEntry {
  /** The card itself — the link, the disclosure, and who it is for. */
  required: Extract<SessionEvent, { type: 'mcp_signin_required' }>;
  /** The resolution that turned it into a receipt, once one has arrived. */
  resolved?: Extract<SessionEvent, { type: 'mcp_signin_resolved' }>;
  /**
   * Whether this entry has already survived a `turn_start`. An unresolved card
   * and a receipt both get exactly one turn of grace; the second `turn_start`
   * retires them.
   */
  carried: boolean;
}

/**
 * The partial status payload carried by a `status_change` event: top-level
 * keys are optional and the nested `contextUsage` is itself partial (a delta
 * may carry only `outputTokens`, or only the context/cache totals).
 */
type StatusChangePayload = Extract<SessionEvent, { type: 'status_change' }>['status'];

/** Permission mode used before any `status_change` reports one. */
const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/**
 * Events that ride the stream but are NOT part of the turn they arrive during.
 *
 * `inProgressTurn` is the turn's transcript: it is what a cold hydrate replays
 * as the live turn, what a log-backed projector persists as history, and what
 * the client folds into the conversation. Two members belong nowhere near it:
 *
 * - **`turn_end`** closes the window rather than joining it (the original rule).
 * - **`queue_update`** is bookkeeping ABOUT the session, not something the agent
 *   or the person said in it. Letting it in would persist the queue into a
 *   runtime's history and — worse — replay a STALE copy of the queue behind the
 *   snapshot's fresh `queuedMessages` on every reconnect, so a client applying
 *   the turn would overwrite a correct queue with an older one.
 * - **`context_staged`** is the receipt for a stage, which opens no turn (spec
 *   §2.5, task 4.2). It rides the stream so a window can show that a note landed,
 *   but it belongs to no turn's transcript: a staged message is not a turn the
 *   agent ran, and folding it into `inProgressTurn` would attach it to whatever
 *   window happened to be open, or strand it in a phantom one when none is.
 *
 * This is a rule about turn MEMBERSHIP only. It has nothing to do with the
 * reopen predicate (`TURN_REOPENING_STREAM_EVENT_TYPES`, #909), which acts on
 * raw runtime StreamEvents inside `feedProjector`: a `queue_update` never
 * travels that path at all, so it cannot open a window either.
 */
const EVENTS_OUTSIDE_THE_TURN: ReadonlySet<SessionEvent['type']> = new Set([
  'turn_end',
  'queue_update',
  'context_staged',
]);

/**
 * The `turn_end.terminalReason` value the detached-error path attaches (emitted
 * by `guardTurnErrors` in `trigger-turn.ts`). A turn that closes with this
 * settles to the `error` lifecycle so a cold hydrate still surfaces the failure.
 */
const TERMINAL_REASON_ERROR = 'error';

// `INTERRUPTED_TERMINAL_REASONS` — the reasons that settle a turn to the
// `interrupted` lifecycle rather than idle — is imported from `@dorkos/shared`,
// which is also where the claude-code result mapper reads it. It used to be a
// hand-kept copy in each place (DOR-1320 review).

/** A fully-zeroed {@link SessionContextUsage}; the base for the first delta. */
const ZERO_CONTEXT_USAGE: SessionContextUsage = {
  totalTokens: 0,
  maxTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Resolve the base to field-wise-merge a partial `contextUsage` delta onto.
 * When no prior usage exists (cold status), start from {@link ZERO_CONTEXT_USAGE}
 * so the merged result is still the full (non-partial) {@link SessionContextUsage}.
 *
 * @param prior - The currently-held usage, or `null` on a cold status.
 */
function mergeBaseContextUsage(prior: SessionContextUsage | null): SessionContextUsage {
  return prior ?? ZERO_CONTEXT_USAGE;
}

/** A cold-snapshot status: every usage field null, idle, no subagents. */
function coldStatus(): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: DEFAULT_PERMISSION_MODE,
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle: 'idle',
    lastError: null,
  };
}

/** A live interaction the projector tracks for pending-recovery projection. */
interface TrackedInteraction {
  type: PendingInteractionDTO['type'];
  startedAt: number;
  /** Re-emit payload, minus the timer fields the selector recomputes. */
  snapshot: Record<string, unknown>;
}

/**
 * A subscriber waiting for the next ingested event, or for the projector to be
 * retired ({@link SessionStateProjector.terminate}).
 */
type Waiter = (event: SessionEvent | typeof TERMINATED) => void;

/**
 * A lifecycle-bearing status update fanned out to global listeners (the
 * session-list broadcaster turns these into `session_status` events on
 * `/api/events`, which drive the sidebar's liveness indicators).
 */
export interface ProjectorStatusUpdate {
  /** The id the projector is CURRENTLY registered under (canonical post-rekey). */
  sessionId: string;
  /** Working directory of the session, when known — lets clients group liveness per agent. */
  cwd: string | undefined;
  /**
   * On a rekey re-announce only: the request UUID this projector streamed
   * under before the canonical id resolved. Listeners must retire any state
   * held under it — pre-rekey transitions fanned out under that id, and no
   * removal event will ever follow for it.
   */
  retiredSessionId?: string;
  /** A copy of the full projected status. */
  status: SessionStatus;
}

/** Listener invoked whenever any projector's `lifecycle` transitions. */
type StatusChangeListener = (update: ProjectorStatusUpdate) => void;

/** Global lifecycle-transition listeners (registry-level, not per-projector). */
const statusChangeListeners = new Set<StatusChangeListener>();

/**
 * Register a listener invoked whenever ANY session's projected `lifecycle`
 * transitions (idle/streaming/blocked/error/interrupted). Notification is
 * lifecycle-gated deliberately: per-chunk `status_change` deltas (output-token
 * counts) do NOT fan out, so listeners see only the infrequent transitions the
 * sidebar actually renders.
 *
 * @param listener - Receives the projector's current id, cwd (when known), and status.
 * @returns Unsubscribe function.
 */
export function onProjectorStatusChange(listener: StatusChangeListener): () => void {
  statusChangeListeners.add(listener);
  return () => statusChangeListeners.delete(listener);
}

/** Fan a projector's current status to all global listeners (throw-isolated). */
function notifyStatusChange(projector: SessionStateProjector, retiredSessionId?: string): void {
  if (statusChangeListeners.size === 0) return;
  const update: ProjectorStatusUpdate = {
    sessionId: projector.sessionId,
    cwd: projector.cwd,
    ...(retiredSessionId !== undefined && { retiredSessionId }),
    status: projector.getStatus(),
  };
  for (const listener of statusChangeListeners) {
    try {
      listener(update);
    } catch (err) {
      logger.warn('[SessionStateProjector] status-change listener threw', {
        sessionId: update.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * One projector starting or stopping holding a prompt only a person can answer.
 *
 * `pending` carries the whole DTO because the card that draws it is the card the
 * per-session stream already draws; `resolved` carries the id and how it ended,
 * because that is all a receipt needs.
 */
export type InteractionChange =
  | { type: 'pending'; sessionId: string; cwd: string; interaction: PendingInteractionDTO }
  | {
      type: 'resolved';
      sessionId: string;
      interactionId: string;
      outcome: 'answered' | 'cancelled' | 'expired';
      /**
       * The name of the person who answered, when the caller that took the
       * answer named one. Carried straight off the resolving event, so it is
       * present exactly when a person answered AND this install knows what to
       * call them — never on a cancellation or an expiry, which nobody
       * answered.
       */
      resolvedBy?: string;
    };

/** Notified when a projector starts or stops holding a pending interaction. */
type InteractionChangeListener = (change: InteractionChange) => void;

/** Global interaction listeners (registry-level, not per-projector). */
const interactionChangeListeners = new Set<InteractionChangeListener>();

/**
 * Subscribe to interaction transitions across every live projector.
 *
 * The seam that lets the Ask reach the whole cockpit without the projector
 * knowing a fan-out exists: it imports no transport today, is unit-tested in
 * isolation, and this keeps both true. The broadcaster subscribes here and turns
 * each change into an `interaction_pending` / `interaction_resolved` on the
 * global stream.
 *
 * Runtime-agnostic on purpose. `trackInteraction` folds the blocking events of
 * ANY runtime, so Codex and OpenCode raise an Ask through this seam with no
 * adapter work at all.
 *
 * @param listener - Receives every pending and resolved transition.
 * @returns Unsubscribe function.
 */
export function onProjectorInteractionChange(listener: InteractionChangeListener): () => void {
  interactionChangeListeners.add(listener);
  return () => interactionChangeListeners.delete(listener);
}

/**
 * Tell every interaction listener about one transition (throw-isolated).
 *
 * Isolated for the same reason {@link notifyStatusChange} is: a listener that
 * throws must not break the fold that was mid-flight when it did. A broken
 * broadcast costs one card its liveness; a broken projection costs the session.
 */
function notifyInteractionChange(change: InteractionChange): void {
  if (interactionChangeListeners.size === 0) return;
  for (const listener of interactionChangeListeners) {
    try {
      listener(change);
    } catch (err) {
      logger.warn('[SessionStateProjector] interaction-change listener threw', {
        sessionId: change.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * How an `interaction_resolved` ended, in the three words a receipt can say.
 *
 * The stream's own five resolutions collapse to three because that is what a
 * card has to draw: a person answered it, it stopped mattering, or the clock
 * answered instead. `approved`, `denied` and `answered` are all "a person
 * answered"; the receipt line that follows reads the transcript's own record for
 * WHICH, and this is only deciding whether to say "already answered" or
 * "no longer needed".
 *
 * A resolution with no outcome at all — the stream's generic clear — is
 * `cancelled` rather than `answered`, because nobody can say a person did
 * anything. "No longer needed" is the honest thing to put on a card whose
 * request quietly went away.
 *
 * @param resolution - The resolution the stream carried, when it carried one.
 */
function askOutcomeOf(
  resolution: 'approved' | 'denied' | 'answered' | 'expired' | 'cancelled' | undefined
): 'answered' | 'cancelled' | 'expired' {
  if (resolution === 'expired') return 'expired';
  if (resolution === undefined || resolution === 'cancelled') return 'cancelled';
  return 'answered';
}

/**
 * Sentinel resolved into a {@link SessionStateProjector.subscribe} wait when its
 * {@link AbortSignal} fires. Distinct from any {@link SessionEvent} (which always
 * carries a `seq`), so the generator can tell an abort from a real event.
 */
const ABORTED = Symbol('subscribe-aborted');

/**
 * Sentinel resolved into every {@link SessionStateProjector.subscribe} wait when
 * the projector is retired ({@link SessionStateProjector.terminate}). Like
 * {@link ABORTED}, distinct from any {@link SessionEvent}.
 */
const TERMINATED = Symbol('projector-terminated');

/**
 * Per-session projector: owns seq, the live projection, and the replay buffers.
 */
export class SessionStateProjector {
  private readonly log = new EventLog();
  private readonly ring = new RingBuffer();

  /** Per-session monotonic counter; `seq` of the latest ingested event. */
  private counter = 0;

  private status: SessionStatus = coldStatus();

  /** Events of the turn in progress, or `null` when idle (ADR-0264 contract). */
  private inProgressTurn: SessionEvent[] | null = null;

  /**
   * Durable persistence for LOG-BACKED sessions, or `undefined` when this
   * projector does not persist (claude-code, or no store wired). Set once via
   * {@link SessionStateProjector.enablePersistence}. When present, each
   * completed turn is flushed to the store on `turn_end` (DOR-189).
   */
  private persistence: ProjectorPersistence | undefined;

  /** Live interactions keyed by id; mirrors the DOR-73 pendingInteractions map. */
  private readonly interactions = new Map<string, TrackedInteraction>();

  /**
   * Live in-session capability approval HOLDS keyed by approval id (DOR-939).
   *
   * Deliberately separate from {@link interactions}: a capability hold does not
   * ride the PendingInteractionDTO recovery machinery — its inline card recovers
   * from the in-progress-turn replay, and it is bounded by the hold cap rather
   * than the 10-minute interaction timeout. It exists so
   * {@link hasPendingInteractions} reports the turn as legitimately parked while a
   * person decides, which is what pauses the stall watchdog and holds the session
   * lock (the same guarantee the three interaction kinds get, without their
   * durable-recovery surface). Each entry carries its own cap so a stranded hold —
   * a turn that threw with a hold outstanding — self-expires rather than pausing
   * the watchdog forever; `turn_end` clears whatever is left, because a held tool
   * call cannot outlive its turn. Every read of this map goes through
   * {@link hasLiveCapabilityHold}: a raw-size read is what let one stranded hold
   * latch a session at `blocked` for good (DOR-987).
   */
  private readonly capabilityHolds = new Map<string, { startedAt: number; capMs: number }>();

  /**
   * Sign-in cards still on screen, keyed by flow id (DOR-1004).
   *
   * The one thing in a turn that deliberately OUTLIVES it. Everything else in
   * `inProgressTurn` is gone at `turn_end`, and rightly so — the turn's real
   * record is the runtime's own history. But an OAuth sign-in card is asked for
   * in one turn and answered minutes later in a browser, so a card dropped at
   * `turn_end` would vanish from every tab opened after the agent stopped
   * talking, which is exactly when a person goes looking for it.
   *
   * {@link buildSnapshot} re-attaches these to whatever the snapshot's
   * in-progress turn is, so a cold hydrate mid-sign-in still draws the card.
   *
   * ## The one-turn grace, and why a resolved card is not simply dropped
   *
   * The bound is a `turn_start` — the conversation moved on, so the card goes
   * with it — but a resolved card gets ONE turn of grace first, and that grace is
   * load-bearing. Signing in triggers a resume turn almost immediately, and
   * retiring the card on that turn's `turn_start` erased the payoff about a
   * second after it appeared: a person walking back from their browser found a
   * transcript with no card, no tool count, and no record that anything had been
   * authorized. So a resolution converts the card into a terminal RECEIPT, the
   * receipt survives the turn the sign-in caused, and the turn AFTER that retires
   * it. The client applies the same rule, so the two cannot disagree about what
   * is on screen.
   */
  private readonly openSigninCards = new Map<string, SigninCardEntry>();

  /**
   * Running subagents by taskId, each mapped to the epoch ms of the last thing
   * DorkOS heard about it; size feeds `runningSubagentCount`.
   *
   * The timestamp is the liveness bound's only input (DOR-1104): it is refreshed
   * by every `running` update the child sends AND by every `turn_end`, and
   * {@link SUBAGENT_SILENCE_TIMEOUT_MS} past it — with no turn open — the child
   * is retired as `untracked`.
   */
  private readonly runningSubagents = new Map<string, number>();

  /**
   * Armed liveness sweep for {@link runningSubagents}, or `undefined` when none
   * is (no children, or a turn is open and the clock is not running).
   */
  private subagentExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Epoch ms of the last ACTIVITY-driven fan-out — the floor the throttle
   * measures from. Lifecycle fan-outs deliberately do not move it; see
   * {@link SessionStateProjector.announceNow}.
   */
  private lastActivityFanOutAt = 0;

  /** Armed trailing flush for a throttled activity, or `undefined` when none is. */
  private activityFlushTimer: ReturnType<typeof setTimeout> | undefined;

  /** Live subscribers awaiting the next event (resolved on each ingest). */
  private waiters: Waiter[] = [];

  /**
   * Callers parked on {@link awaitTurnSettled}, woken the moment no turn is in
   * progress. Never more than a couple — one per turn about to open.
   */
  private readonly turnSettledWaiters = new Set<() => void>();

  /** Active {@link subscribe} generators (replay or live phase). */
  private subscriberCount = 0;

  /** Set once by {@link terminate}: this instance will never be fed again. */
  private terminated = false;

  /** Backing field for {@link sessionId}; updated by {@link rekeyProjector}. */
  private _sessionId: string;

  /**
   * Working directory the session runs in, when known. Stamped by
   * {@link getOrCreateProjector} from the trigger/subscribe context and carried
   * on {@link ProjectorStatusUpdate}s so clients can group liveness per agent.
   */
  cwd: string | undefined;

  constructor(sessionId: string) {
    this._sessionId = sessionId;
  }

  /** The id this projector is currently registered under (canonical post-rekey). */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Adopt a new registry id. Called ONLY by {@link rekeyProjector} so status
   * fan-outs after the first-turn rekey carry the canonical id the sidebar's
   * session rows are keyed by, not the retired request UUID.
   *
   * @internal
   */
  adoptSessionId(newId: string): void {
    this._sessionId = newId;
  }

  /**
   * Ingest a raw adapter event: stamp `seq`, update the projection, append to
   * the log and ring, and wake live subscribers. Returns the seq'd event.
   *
   * @param raw - A {@link SessionEvent} union member without its `seq`.
   */
  ingest(raw: RawSessionEvent): SessionEvent {
    // Before anything else, so a stale child cannot ride one more event into a
    // count somebody is about to read. The armed timer is what normally catches
    // these; this catches the case where it could not run (a suspended process,
    // a machine asleep) and costs a map-size check otherwise. Re-entrant by
    // design — it ingests the retirements — and terminates because each stale
    // entry is removed before its own event is ingested.
    this.expireStaleSubagents();
    // Byte guard BEFORE the seq is stamped and before anything projects, so
    // every consumer — projection, log, ring, durable store, live subscriber —
    // sees the identical guarded event. An oversized string becomes a stated
    // omission rather than a silent truncation; the event's type and ids are
    // untouched, so nothing downstream is stranded (`event-size-guard.ts`).
    const event = guardEventSize({ ...raw, seq: ++this.counter } as SessionEvent);
    // Capture before project(): applyStatusChange replaces the status object.
    const lifecycleBefore = this.status.lifecycle;
    const activityBefore = this.status.activity;
    // Capture the completing turn BEFORE project() clears inProgressTurn, so a
    // persistence-enabled projector can flush the whole turn (turn_start … the
    // captured deltas … this turn_end) after the event has streamed. A turn_end
    // with no open turn is degenerate and not history-bearing — skip it.
    const turnToFlush =
      event.type === 'turn_end' && this.persistence !== undefined && this.inProgressTurn !== null
        ? [...this.inProgressTurn, event]
        : null;
    this.project(event);
    this.log.append(event);
    this.ring.append(event);
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake(event);
    // Flush AFTER waking subscribers: the turn already reached the client, so a
    // persistence failure only forfeits cross-restart durability, never live
    // streaming.
    if (turnToFlush !== null) this.flushTurn(turnToFlush);
    // An ask does not wait for its turn to end to become durable — the turn it
    // parked may never end at all (DOR-1439). Same placement and same reason as
    // the turn flush above: the event has already reached every live subscriber.
    if (EAGERLY_RECORDED_EVENT_TYPES.has(event.type)) this.flushTurn([event]);
    // Three ways this event can be worth telling the fleet about, in the order
    // they take precedence:
    //
    // 1. The lifecycle moved — the transition the sidebar has always drawn. It
    //    carries whatever activity is current, so a `blocked` still says what
    //    the session is blocked ON.
    // 2. The activity was CLEARED without the lifecycle moving. Only a typed
    //    `error` does this (a turn can carry one and recover), and it must not
    //    wait on the throttle: the alternative is up to two seconds of a verb
    //    for something that already failed.
    // 3. A NEW activity — throttled, because a chatty turn starts tools far
    //    faster than anybody can read them.
    if (this.status.lifecycle !== lifecycleBefore) {
      this.announceNow();
    } else if (activityBefore !== undefined && this.status.activity === undefined) {
      this.announceActivityNow();
    } else if (this.status.activity !== activityBefore) {
      this.scheduleActivityFanOut();
    }
    if (event.type === 'turn_end' || event.type === 'interaction_resolved') {
      notifyTurnBoundary(this._sessionId);
    }
    return event;
  }

  /**
   * Announce the current status immediately, dropping any armed trailing flush —
   * whatever that flush was going to say is either in this update already or has
   * been superseded by it.
   *
   * Deliberately does NOT re-arm the activity throttle. The throttle exists to
   * rate-limit tool churn, and a lifecycle transition is not tool churn: charging
   * it against the same budget delayed the FIRST tool of every turn by the full
   * window, because `turn_start` had just spent it.
   */
  private announceNow(): void {
    this.cancelActivityFlush();
    notifyStatusChange(this);
  }

  /** Announce an activity change now, and re-arm the throttle from this moment. */
  private announceActivityNow(): void {
    this.lastActivityFanOutAt = Date.now();
    this.announceNow();
  }

  /**
   * Report a newly-started tool, or — inside the throttle window — arm a single
   * trailing flush that will report whatever the LATEST tool is when it fires.
   *
   * Trailing rather than dropping, because dropping loses the end of a burst:
   * the last tool of a run of quick ones is exactly the one that then runs for
   * a minute, and the fleet would spend that minute naming a tool that finished
   * immediately.
   */
  private scheduleActivityFanOut(): void {
    const waited = Date.now() - this.lastActivityFanOutAt;
    if (waited >= ACTIVITY_FANOUT_THROTTLE_MS) {
      this.announceActivityNow();
      return;
    }
    if (this.activityFlushTimer !== undefined) return;
    this.activityFlushTimer = setTimeout(() => {
      this.activityFlushTimer = undefined;
      // Re-read at fire time rather than closing over a value: the point of the
      // trailing flush is to report the latest tool, not the one that armed it.
      this.announceActivityNow();
    }, ACTIVITY_FANOUT_THROTTLE_MS - waited);
    // A pending status update must never hold the process open — this timer is
    // pure liveness reporting, and there is nothing to report to on the way out.
    this.activityFlushTimer.unref?.();
  }

  /**
   * Drop every timer this projector owns, for a projector that is being retired
   * ({@link terminate}) or dropped from the registry ({@link disposeProjector}).
   *
   * One call rather than one per timer, because the two failure modes are the
   * same shape and the next timer added here would otherwise be forgotten at
   * exactly these two sites: an armed timer on a retired projector announces a
   * session that no longer exists, or ingests into an instance nothing can reach.
   *
   * @internal
   */
  cancelTimers(): void {
    this.cancelActivityFlush();
    this.cancelSubagentExpiry();
  }

  /** Drop any armed trailing activity flush. */
  private cancelActivityFlush(): void {
    if (this.activityFlushTimer === undefined) return;
    clearTimeout(this.activityFlushTimer);
    this.activityFlushTimer = undefined;
  }

  /**
   * Attach durable persistence to this projector (idempotent, DOR-189). On the
   * FIRST enable of a still-empty projector, restore `counter = maxSeq` so seq
   * continuity survives a server restart, and — in `'history'` mode only —
   * hydrate the in-memory log from the store so completed history survives with
   * it. A projector that has already ingested live events (`counter > 0`) is not
   * re-hydrated: its in-memory log is authoritative for this run and its
   * completed turns are already flushed; a later restart mints a fresh projector
   * that hydrates cleanly.
   *
   * **The counter restore is not optional in either mode**, and it is what makes
   * `'record'` work at all: `appendTurn` is `INSERT OR IGNORE` on
   * `(session_id, seq)`, so a projector that restarted at seq 0 would write its
   * next turn under seqs the last process already used and every row would be
   * silently ignored — a durable record that records nothing.
   *
   * **`'record'` deliberately does not hydrate.** It keeps only turn boundaries,
   * so hydrating would give the {@link EventLog} a replay source with each
   * turn's middle missing, and a resuming client would be served that gap as
   * though it were the whole turn. An empty log means {@link assertResumable}
   * refuses a stale cursor instead, and the client takes the cold snapshot —
   * which for claude-code is read from JSONL and is complete.
   *
   * The first enable wins the mode, which is safe because the mode is a function
   * of the RUNTIME rather than of the caller: every caller derives it the same
   * way ({@link persistenceModeFor}), so two callers on one session cannot
   * disagree about which it should be.
   *
   * @param store - The shared durable session-event store (injected at boot).
   * @param mode - What the rows are for; see {@link ProjectorPersistenceMode}.
   */
  enablePersistence(store: SessionEventStore, mode: ProjectorPersistenceMode = 'history'): void {
    if (this.persistence !== undefined) return;
    this.persistence = { store, mode };
    if (this.counter === 0 && mode === 'history') {
      const events = store.readAll(this.sessionId);
      if (events.length > 0) this.log.hydrate(events);
    }
    // Carry the counter past the durable max (and past any
    // unparseable-and-skipped rows), whatever the mode and whatever this
    // projector has already ingested. `Math.max` rather than an assignment
    // because persistence can now be enabled MID-LIFE: a session whose
    // projector was minted by an /events subscribe and only later opted in by
    // its first turn has a counter above zero and below the durable max, and
    // assigning would move it backwards while subscribers are reading
    // forwards. Leaving it low is the other
    // failure — the flush would land on seqs a previous process already used and
    // `INSERT OR IGNORE` would drop the whole turn without a word.
    this.counter = Math.max(this.counter, store.maxSeq(this.sessionId));
  }

  /**
   * Persist a just-completed turn to the durable store. Failure is
   * warned-and-swallowed: the turn already streamed to subscribers, so a
   * persistence error only forfeits cross-restart durability (degrading to the
   * pre-DOR-189 in-memory behavior) and must never break live streaming.
   *
   * In `'record'` mode the turn is narrowed to {@link RECORDED_EVENT_TYPES}
   * first, so the row count per turn is a constant rather than a function of how
   * much the model said.
   *
   * Also called with a SINGLE event, by the eager-record path in
   * {@link SessionStateProjector.ingest} — an ask writes itself down before its
   * turn ends, because the turn may never end (DOR-1439). Idempotent either way:
   * `appendTurn` is `INSERT OR IGNORE` on `(session_id, seq)`, so the turn flush
   * that later re-offers the same event writes nothing twice.
   *
   * Rows key by the LIVE {@link sessionId} — see the {@link ProjectorPersistence}
   * rekey note.
   */
  private flushTurn(events: SessionEvent[]): void {
    const persistence = this.persistence;
    if (persistence === undefined) return;
    const rows =
      persistence.mode === 'record'
        ? events.filter((event) => RECORDED_EVENT_TYPES.has(event.type))
        : events;
    if (rows.length === 0) return;
    try {
      persistence.store.appendTurn(this.sessionId, rows);
    } catch (err) {
      logger.warn('[SessionStateProjector] durable turn flush failed — history not persisted', {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Fold an event into the live projection. */
  private project(event: SessionEvent): void {
    if (this.inProgressTurn !== null && !EVENTS_OUTSIDE_THE_TURN.has(event.type)) {
      this.inProgressTurn.push(event);
    }
    switch (event.type) {
      case 'turn_start':
        this.inProgressTurn = [event];
        // Spend one turn of grace, then let the conversation move on (DOR-1004).
        // The turn a finished sign-in triggers is the FIRST one past the receipt,
        // so this is what keeps the payoff on screen through it.
        //
        // A window nobody asked for does not spend it. The grace is bounded by
        // "the conversation moved on", and an agent waking itself up because a
        // background task finished is not the conversation moving on — it fires
        // milliseconds later, unprompted, and would erase the card just as the
        // person got back from their browser, which is the exact failure DOR-1004
        // exists to prevent. The client applies the same rule.
        if (event.origin !== 'runtime') this.ageSigninCards();
        // The children's silence clock does not run while a turn is open
        // (DOR-1104), so drop any sweep armed while the session was idle.
        this.cancelSubagentExpiry();
        this.ring.markTurnStarted();
        this.status.lifecycle = 'streaming';
        // A new turn clears the previous failure surface.
        this.status.lastError = null;
        // …and the previous turn's tool. The new turn has not reached one yet,
        // and carrying the old one over would name the last thing the session
        // did as the thing it is doing.
        delete this.status.activity;
        break;
      case 'turn_end':
        this.inProgressTurn = null;
        // Ahead of everything else this case does: a turn waiting to open on
        // this one settling has nothing to learn from the bookkeeping below,
        // and it is holding a person's message (DOR-1295).
        this.wakeTurnSettledWaiters();
        this.ring.markTurnEnded();
        // Nothing is running any more, so nothing may be reported as running.
        delete this.status.activity;
        // A hold cannot outlive the turn that opened it: the held tool call died
        // with the turn, so any entry still here is stranded (DOR-987). Dropping
        // them bounds the map across a long session and keeps the lifecycle
        // derivation below reading only live state.
        this.capabilityHolds.clear();
        // `runningSubagents` is deliberately NOT cleared beside it, and the two
        // look similar enough that the difference has to be written down. A held
        // tool call dies with its turn; a background task does not — it keeps
        // running, and finishing is what WAKES the agent for another turn
        // (DOR-1100). So a session can legitimately sit `idle` with a non-zero
        // `runningSubagentCount`, and that pair is the whole signal: the agent
        // has stopped talking, but it is not finished. Clearing here would erase
        // the only honest account of why the session is about to speak again.
        //
        // Each entry leaves on its own terminal `subagent_update`, which is the
        // same event that wakes the agent, so the set drains itself — and for
        // the ones that never send it, the silence clock starts HERE (DOR-1104),
        // which is what "after the session went idle" means.
        this.restartSubagentSilenceClocks();
        this.status.lifecycle = this.deriveTurnEndLifecycle(event.terminalReason);
        // A turn that did not settle to error leaves no stale failure behind
        // (a mid-turn error the runtime recovered from must not linger).
        if (this.status.lifecycle !== 'error') this.status.lastError = null;
        break;
      case 'status_change':
        this.applyStatusChange(event.status);
        break;
      // A tool the session just started: the fleet-wide answer to "what is it
      // doing right now". Only `tool_call` — `tool_result` is the tool
      // FINISHING, and clearing on it would blank the row for the whole gap
      // between tools, which is most of a turn.
      case 'tool_call':
        this.status.activity = deriveSessionActivity(event.toolName, event.input);
        break;
      case 'error':
        // Whatever it was doing, it is not doing it now. Held separately from
        // the lifecycle on purpose: this event does not settle the turn, so
        // without this clear a recovered error would leave the failed tool
        // named until the next one started.
        delete this.status.activity;
        // Latch the failure details for the status projection. Deliberately
        // does NOT touch lifecycle: non-terminal errors exist (e.g. a Codex
        // item_error the turn recovers from), so terminal settling stays owned
        // by the turn_end derivation.
        this.status.lastError = {
          message: event.message,
          ...(event.code !== undefined ? { code: event.code } : {}),
          ...(event.category !== undefined ? { category: event.category } : {}),
          ...(event.details !== undefined ? { details: event.details } : {}),
        };
        break;
      case 'todo_update':
        this.applyTodoUpdate(event.tasks);
        break;
      case 'subagent_update':
        this.applySubagentUpdate(event.taskId, event.status);
        break;
      // Kept in sync with `BLOCKING_INTERACTION_EVENT_TYPES` — a switch cannot
      // be driven by the constant, but `trackInteraction` re-checks it.
      case 'approval_required':
      case 'question_prompt':
      case 'elicitation_prompt':
        this.trackInteraction(event);
        break;
      // An in-session capability hold (DOR-939): tracked as a pending hold so the
      // stall watchdog pauses and the lock is not stolen, then dropped when the
      // person decides. NOT a `trackInteraction` — see {@link capabilityHolds}.
      case 'capability_approval_required':
        this.trackCapabilityHold(event);
        break;
      case 'capability_approval_resolved':
        this.untrackCapabilityHold(event.approvalId);
        break;
      // An in-conversation sign-in card (DOR-1004). Tracked so it survives its
      // own `turn_end` and reaches a cold hydrate; NOT a hold and NOT an
      // interaction — nothing is waiting on it, so it neither pauses the stall
      // watchdog nor blocks the lifecycle.
      case 'mcp_signin_required':
        this.openSigninCards.set(event.flowId, { required: event, carried: false });
        break;
      case 'mcp_signin_resolved':
        this.attachSigninResolution(event);
        break;
      case 'interaction_resolved':
        // Backfill WHICH interaction this was and WHEN it began, before
        // dropping the only record of either. `project()` runs before the event
        // is logged, buffered, or fanned out, so this reaches every consumer —
        // and a client cannot recover it afterwards, because the pending DTO
        // carrying both is retired by this same event. The kind matters as much
        // as the timing: the three kinds share a cancellation path, so the
        // resolution alone cannot say whether a `expired` was a permission
        // prompt or a question.
        this.backfillResolution(event);
        // Read whether this projector was actually holding it BEFORE the drop:
        // a double-resolve (a stale click, a retried request) must not tell the
        // fleet a second time about a card every window has already retired.
        {
          const wasHeld = this.interactions.has(event.id);
          this.untrackInteraction(event.id);
          if (wasHeld) {
            notifyInteractionChange({
              type: 'resolved',
              sessionId: this.sessionId,
              interactionId: event.id,
              outcome: askOutcomeOf(event.resolution),
              // Only ever carried by an answer a person gave; the clock and a
              // torn-down turn both arrive here with nothing to name.
              ...(event.resolvedBy ? { resolvedBy: event.resolvedBy } : {}),
            });
          }
        }
        break;
      default:
        break;
    }
  }

  /**
   * Stamp a resolution with the kind and start time of the interaction it
   * retires, taken from the entry this projector still holds.
   *
   * Only fills what is missing, so a resolution that already carried either
   * (a replayed event, a runtime that knows its own answer) is left alone. An
   * untracked id leaves both undefined — consumers degrade to "an interaction
   * resolved" rather than being told something invented.
   *
   * @param event - The `interaction_resolved` event, mutated in place before it
   *   is logged, buffered, or fanned out.
   */
  private backfillResolution(event: Extract<SessionEvent, { type: 'interaction_resolved' }>): void {
    const pending = this.interactions.get(event.id);
    if (pending === undefined) return;
    if (event.kind === undefined) event.kind = pending.type;
    if (event.startedAt === undefined) event.startedAt = pending.startedAt;
  }

  /**
   * Drop a resolved interaction from the pending projection and settle the
   * lifecycle back from `blocked` once nothing remains pending. Runs via
   * {@link project} so the same fold applies on live ingest AND any replay.
   */
  private untrackInteraction(interactionId: string): void {
    this.interactions.delete(interactionId);
    this.settleBlockedLifecycle();
  }

  /**
   * Turn a carried sign-in card into a terminal receipt (DOR-1004).
   *
   * A resolution for a card this projector never saw is dropped rather than
   * carried on its own: a receipt with no card to attach to has no server name,
   * no disclosure, and nothing to say. That happens when the card belonged to a
   * turn old enough to have aged out, in which case the transcript has already
   * moved on and re-introducing a bare receipt would be a surprise, not a record.
   *
   * The grace is RESET here, not carried over: the receipt is a new thing on
   * screen and gets its own turn, whatever the card before it had already spent.
   */
  private attachSigninResolution(
    event: Extract<SessionEvent, { type: 'mcp_signin_resolved' }>
  ): void {
    const entry = this.openSigninCards.get(event.flowId);
    if (entry === undefined) return;
    entry.resolved = event;
    entry.carried = false;
  }

  /**
   * Spend one `turn_start` of every carried sign-in card's grace, retiring the
   * ones that had already spent theirs (DOR-1004).
   */
  private ageSigninCards(): void {
    for (const [flowId, entry] of this.openSigninCards) {
      if (entry.carried) this.openSigninCards.delete(flowId);
      else entry.carried = true;
    }
  }

  /** Track a capability hold (DOR-939) and flip the session to `blocked`. */
  private trackCapabilityHold(
    event: Extract<SessionEvent, { type: 'capability_approval_required' }>
  ): void {
    this.capabilityHolds.set(event.approval.approvalId, {
      startedAt: event.startedAt,
      capMs: event.capMs,
    });
    this.status.lifecycle = 'blocked';
  }

  /**
   * Drop a resolved capability hold and settle the lifecycle back from `blocked`.
   * The hold resolves MID-turn (the held tool call resumes), so it settles to
   * `streaming` while the turn keeps producing, not `idle`.
   */
  private untrackCapabilityHold(approvalId: string): void {
    this.capabilityHolds.delete(approvalId);
    this.settleBlockedLifecycle();
  }

  /**
   * Settle the lifecycle out of `blocked` once nothing — no interaction, no LIVE
   * capability hold — remains pending. Runs via {@link project}, so the same fold
   * applies on live ingest and any replay.
   *
   * The hold half is time-bounded, never a raw map read (DOR-987). A hold entry
   * CAN strand: the resolution is pushed onto the turn's event queue, and a turn
   * interrupted with a hold open never drains that queue again. Reading the raw
   * size meant one stranded hold latched the session at `blocked` for the rest of
   * its life — every later approval, question and elicitation settled back into
   * "waiting on you" after the person had already answered. The same
   * {@link hasLiveCapabilityHold} bound {@link hasPendingInteractions} applies is
   * used here, so the two answers to "is anyone still waiting?" cannot disagree.
   */
  private settleBlockedLifecycle(): void {
    if (this.interactions.size === 0 && !this.hasLiveCapabilityHold(Date.now())) {
      if (this.status.lifecycle === 'blocked') {
        this.status.lifecycle = this.inProgressTurn !== null ? 'streaming' : 'idle';
      }
    }
  }

  /**
   * Merge a partial status delta into the held status. `contextUsage` is merged
   * FIELD-WISE onto the prior value rather than wholesale-replaced: a final
   * `session_status` carries context/cache totals but no `outputTokens`, and a
   * streaming one carries only `outputTokens` — a wholesale replace would let
   * each delta zero the fields it does not carry (e.g. reset the running
   * output-token count at turn end). Absent fields keep their prior value.
   *
   * `activity` is DISCARDED here rather than merged, and the discard has to
   * live in this fold rather than only in the schema. `SessionEventSchema`
   * omits the key from the `status_change` payload, but the projector ingests
   * what an adapter hands it — `ingest` never parses — so the schema constrains
   * the WIRE while this line constrains the STATE. The field is derived by this
   * projector from the `tool_call` events it has seen and cleared by it at
   * every turn boundary; a status delta that could set it would let a runtime
   * name a tool the session never started, and that claim would fan out
   * fleet-wide indistinguishable from a real one.
   */
  private applyStatusChange(partial: StatusChangePayload): void {
    const {
      contextUsage,
      activity: _notTheirs,
      ...rest
    } = partial as StatusChangePayload & {
      activity?: unknown;
    };
    this.status = { ...this.status, ...rest };
    if (contextUsage !== undefined) {
      this.status.contextUsage =
        contextUsage === null
          ? null
          : { ...mergeBaseContextUsage(this.status.contextUsage), ...contextUsage };
    }
  }

  /**
   * The `taskId`s this projector still counts as running.
   *
   * Read by {@link feedProjector}'s stranding sweep, which retires each of them
   * with a terminal `subagent_update` when the runtime's stream ends (DOR-1100).
   * A copy, not the live set: the sweep ingests while it iterates.
   */
  listRunningSubagents(): string[] {
    return [...this.runningSubagents.keys()];
  }

  /** Recompute todo tallies from a `snapshot`/`update` task list. */
  private applyTodoUpdate(tasks: TaskItem[] | undefined): void {
    if (!tasks) return;
    this.status.todoCounts = {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    };
  }

  /**
   * Track running subagents; `runningSubagentCount` mirrors the live set size.
   *
   * A `running` update also refreshes the child's silence clock — progress
   * reports are the evidence the liveness bound (DOR-1104) waits for.
   */
  private applySubagentUpdate(taskId: string, status: string): void {
    if (status === 'running') {
      this.runningSubagents.set(taskId, Date.now());
    } else {
      this.runningSubagents.delete(taskId);
    }
    this.status.runningSubagentCount = this.runningSubagents.size;
    this.scheduleSubagentExpiry();
  }

  /**
   * Restart every running child's silence clock (DOR-1104).
   *
   * Called at `turn_end`, because the bound is "silent for a window AFTER the
   * session went idle" and this is that moment. Without it, a child that was
   * quiet through a long turn would be retired the instant the turn closed —
   * with a deadline that had already passed while the agent was demonstrably
   * alive and working beside it.
   */
  private restartSubagentSilenceClocks(): void {
    const now = Date.now();
    for (const taskId of this.runningSubagents.keys()) this.runningSubagents.set(taskId, now);
    this.scheduleSubagentExpiry();
  }

  /**
   * Retire every running child whose silence has outlasted
   * {@link SUBAGENT_SILENCE_TIMEOUT_MS} (DOR-1104).
   *
   * Two things make it safe to call from anywhere, including from inside
   * {@link ingest}:
   *
   * - **It cannot recurse.** EVERY stale entry leaves the map before ANY
   *   retirement is ingested, so the nested `expireStaleSubagents` at the top of
   *   `ingest` finds nothing left to expire. The two loops must stay two, and
   *   this is not a style preference: interleaving them retires each child once
   *   per pass and the passes nest, so N stale children emitted N(N+1)/2 events —
   *   three produced six. That is the COMMON case, not an edge, because
   *   {@link restartSubagentSilenceClocks} stamps every child with the same
   *   `now`, so a multi-child leak always expires as one batch. And the duplicate
   *   is not cosmetic: the client's fold sees the second copy as an id it no
   *   longer knows, which is the arm that decrements its count of children it
   *   cannot name — silently discounting children that are still alive.
   * - **It is a no-op with a turn open.** The clock only runs while the session
   *   is idle; a child that is quiet while the agent works is ordinary, and the
   *   agent is right there to hear from it.
   *
   * Retirements ride the stream like every other one, so a client folding its own
   * count drains the same ids rather than holding them forever — and they say
   * `untracked`, not `stopped` (DOR-1108), because silence is not evidence of a
   * stop.
   */
  private expireStaleSubagents(): void {
    if (this.runningSubagents.size === 0 || this.inProgressTurn !== null) return;
    const cutoff = Date.now() - SUBAGENT_SILENCE_TIMEOUT_MS;
    const stale = [...this.runningSubagents]
      .filter(([, lastSeenAt]) => lastSeenAt <= cutoff)
      .map(([taskId]) => taskId);
    if (stale.length === 0) return;
    // Empty the map, THEN tell anyone. See the recursion note above.
    for (const taskId of stale) this.runningSubagents.delete(taskId);
    for (const taskId of stale) {
      this.ingest({
        type: 'subagent_update',
        taskId,
        status: 'untracked',
      } as RawSessionEvent);
    }
    // The count moved without the lifecycle moving, so nothing else would tell
    // the fleet. A sidebar row reading "waiting on 3" for work that ended is the
    // whole bug; announcing here is what corrects it everywhere at once.
    this.announceNow();
  }

  /**
   * Arm (or re-arm) the liveness sweep for the earliest deadline outstanding.
   *
   * Cancels first, so this is also the "nothing to watch" path: no children, or a
   * turn open and the clock therefore stopped. `unref` for the same reason the
   * activity flush does it — a pending sweep is pure bookkeeping and must never
   * hold the process open.
   */
  private scheduleSubagentExpiry(): void {
    this.cancelSubagentExpiry();
    if (this.runningSubagents.size === 0 || this.inProgressTurn !== null) return;
    const earliest = Math.min(...this.runningSubagents.values());
    const delay = Math.max(0, earliest + SUBAGENT_SILENCE_TIMEOUT_MS - Date.now());
    this.subagentExpiryTimer = setTimeout(() => {
      this.subagentExpiryTimer = undefined;
      this.expireStaleSubagents();
    }, delay);
    this.subagentExpiryTimer.unref?.();
  }

  /** Drop any armed liveness sweep. */
  private cancelSubagentExpiry(): void {
    if (this.subagentExpiryTimer === undefined) return;
    clearTimeout(this.subagentExpiryTimer);
    this.subagentExpiryTimer = undefined;
  }

  /** Record a pending interaction and flip the session to `blocked`. */
  private trackInteraction(event: SessionEvent): void {
    // `BLOCKING_INTERACTION_EVENT_TYPES` is the one list — the Telegram
    // adapter stops its typing indicator off the same predicate
    // (`adapters/telegram/outbound.ts`), so the two cannot drift.
    if (!isBlockingInteractionEvent(event)) {
      return;
    }
    // Strip the union discriminator, seq, and timer fields — the selector
    // recomputes remainingMs and re-adds id/startedAt — leaving the re-emit body.
    const { type, seq, id, startedAt, remainingMs, ...snapshot } = event;
    void seq;
    void remainingMs;
    const entry = {
      type: this.interactionKind(type),
      startedAt,
      snapshot,
    };
    this.interactions.set(id, entry);
    this.status.lifecycle = 'blocked';
    // AFTER the set, and that ordering is load-bearing: a listener that reads
    // this projector back — the fan-out's room join does — must find the entry
    // already there. It is also what puts `interaction_pending` on the global
    // stream ahead of the per-session event, which `project()` has not yet
    // logged, buffered or handed to a subscriber.
    //
    // The DTO comes from the canonical selector, on a map of this one entry, so
    // the `remainingMs` on the wire is computed exactly as the recovery
    // snapshot's is. An entry that is somehow already past its budget (a replay
    // of an old event) yields nothing here rather than a card that is born dead.
    const [dto] = listPendingInteractions(new Map([[id, entry]]), Date.now());
    if (dto === undefined) return;
    // A session whose directory nobody stamped cannot be deep-linked or named
    // from its path, which are the two things `cwd` is on the wire for. Every
    // turn that can raise a prompt was started with one, so this is a "should
    // not happen" — and it says so out loud rather than dropping an Ask into
    // silence, because the fleet-wide card is the only place a person who is not
    // looking at this session would ever see it.
    if (this.cwd === undefined) {
      logger.warn('[SessionStateProjector] a prompt was raised on a session with no cwd', {
        sessionId: this.sessionId,
        interactionId: id,
      });
      return;
    }
    notifyInteractionChange({
      type: 'pending',
      sessionId: this.sessionId,
      cwd: this.cwd,
      interaction: dto,
    });
  }

  /** Map a session-event interaction type to the pending-map discriminator. */
  private interactionKind(type: string): PendingInteractionDTO['type'] {
    if (type === 'question_prompt') return 'question';
    if (type === 'elicitation_prompt') return 'elicitation';
    return 'approval';
  }

  /**
   * Resolve a pending interaction: ingests an `interaction_resolved` event so
   * the removal flows through the SAME seq'd stream every consumer reads —
   * live `/events` subscribers drop their card immediately (other windows
   * included), replay reproduces it, and the snapshot's pending list settles
   * via the projection fold. The adapter calls this when the operator acts
   * (approve / deny / answer / elicitation response).
   *
   * No-op for an id not currently tracked, so a double-resolve (stale click,
   * retried request) cannot emit a spurious event.
   *
   * @param interactionId - The id carried by the interaction event.
   * @param resolution - The outcome, when the caller knows it.
   * @param opts.reasonGiven - Whether the person's own words were delivered to
   *   the agent with a denial. Only the caller that delivered them can say so,
   *   which is why this is passed in rather than derived here.
   * @param opts.answeredBy - What to call the person who answered, for the
   *   receipt every other window draws. Passed in for the same reason
   *   `reasonGiven` is: only the caller that took the answer knows who gave it.
   */
  resolveInteraction(
    interactionId: string,
    resolution?: 'approved' | 'denied' | 'answered',
    opts?: { reasonGiven?: boolean; answeredBy?: string }
  ): void {
    if (!this.interactions.has(interactionId)) return;
    // RawSessionEvent's Omit-on-union collapses to the common keys, so the
    // member literal needs the same widening cast `ingest` itself applies.
    this.ingest({
      type: 'interaction_resolved',
      id: interactionId,
      resolution,
      // When the answer landed — the client keeps this as the timestamp on its
      // durable record of the decision.
      at: Date.now(),
      // Carried only when true: an absent field is the honest shape for "no
      // reason", and it keeps every pre-existing resolution byte-identical.
      ...(opts?.reasonGiven === true ? { reasonGiven: true } : {}),
      // Same rule for the answerer's name: absent unless the caller named one,
      // so a resolution nobody can attribute stays unattributed on the wire.
      ...(opts?.answeredBy ? { resolvedBy: opts.answeredBy } : {}),
    } as unknown as RawSessionEvent);
  }

  /**
   * Mark the in-flight turn interrupted — used by the restart-degradation hook
   * (task #6) when a turn was left `streaming` with no `turn_end`. No-op if no
   * turn is in progress.
   */
  markInterrupted(): void {
    if (this.inProgressTurn !== null || this.status.lifecycle === 'streaming') {
      // Retire the children through the STREAM, the same way `feedProjector`'s
      // stranding sweep does, and before the turn is torn down so they still
      // ride it. Mutating the set silently would leave every consumer holding
      // ids it never saw finish — and a client that folds its own count from
      // `subagent_update` (the cockpit does) would go on reporting them, or
      // resurrect them from a replay, while the server said zero. The two
      // projections have to drain through the same events or they disagree.
      //
      // `untracked`, for the same reason the sweep uses it (DOR-1108): this path
      // is DorkOS tearing a session down, which says nothing whatever about
      // whether the work it handed off is still running.
      //
      // Cleared BEFORE any of them is ingested, in the same shape and for the
      // same reason as {@link expireStaleSubagents}: `ingest` runs the liveness
      // sweep on its way in, and a half-emptied set is what lets that sweep
      // retire the ids this loop has not reached yet — a second time. Today the
      // open-turn guard happens to make that unreachable from here, which is a
      // reason to be careful rather than a reason to rely on it: this path can be
      // entered with `lifecycle === 'streaming'` and no turn open, and the safety
      // of the loop should not depend on a condition checked in another method.
      const stranded = this.listRunningSubagents();
      this.runningSubagents.clear();
      this.status.runningSubagentCount = 0;
      for (const taskId of stranded) {
        const untracked: RawSessionEvent = {
          type: 'subagent_update',
          taskId,
          status: 'untracked',
        } as RawSessionEvent;
        this.ingest(untracked);
      }
      this.inProgressTurn = null;
      // This path ingests no `turn_end`, so it is the other place a turn stops
      // being in progress — and anyone waiting for that has to hear it here too.
      this.wakeTurnSettledWaiters();
      this.ring.markTurnEnded();
      this.status.lifecycle = 'interrupted';
      // The turn is over, so whatever tool it was in is over with it.
      delete this.status.activity;
      // The set was emptied above, before the retirements went out. This path is
      // the eviction degradation — it tears the session down without ever running
      // a stream's `finally`, so the sweep that normally retires them never fires
      // here (DOR-1100) — and with nothing left to watch there is nothing left to
      // arm (DOR-1104).
      this.cancelSubagentExpiry();
      // Whatever this turn was parked on is not going to be answered: the turn
      // is gone and nothing will ever ingest its resolution. Every card for it
      // becomes "no longer needed" rather than a button that does nothing.
      //
      // The set itself is deliberately NOT emptied — {@link hasPendingInteractions}
      // bounds a stranded entry by its own expiry, and clearing it here would
      // change the watchdog and lock semantics this path documents. So a late
      // resolution for one of these can still arrive and be told to the fleet a
      // second time; removing an id twice is a no-op on every reader.
      for (const dto of this.getPendingInteractions()) {
        notifyInteractionChange({
          type: 'resolved',
          sessionId: this.sessionId,
          interactionId: dto.id,
          outcome: 'cancelled',
        });
      }
      // This path mutates lifecycle WITHOUT an ingest, so fan out here — and
      // through the activity path, so an armed trailing flush cannot land after
      // it and re-assert the tool this just cleared.
      this.announceNow();
    }
  }

  /**
   * Resolve once no turn is in progress on this projection — the ordering gate a
   * turn about to open uses when the turn ahead of it had to be abandoned
   * (DOR-1295).
   *
   * The terminal of an abandoned turn does not land here synchronously: it is
   * pushed into a stream whose consumer — the mapper, the stall guard,
   * `feedProjector` — unwinds on its own schedule, and only `feedProjector`'s
   * `finally` ingests the `turn_end`. So the caller waits for the PROJECTION to
   * settle rather than for the layer beneath it to return, which is the only
   * signal that means what the caller needs it to mean.
   *
   * **Always bounded, and the bound is not paranoia.** The abandoned turn's
   * stream may have no consumer left at all — an HTTP request that went away, a
   * generator nobody is pulling — in which case nothing will ever close that
   * turn and the wait would be forever. Timing out resolves rather than
   * rejecting: the caller's turn must start either way, and a turn that opens
   * beside a stale one is the pre-DOR-1295 behaviour, which is bad but is not a
   * reason to refuse a person's message.
   *
   * @param timeoutMs - How long to wait before giving up and resolving anyway
   */
  awaitTurnSettled(timeoutMs: number): Promise<void> {
    if (this.inProgressTurn === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        this.turnSettledWaiters.delete(settle);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      this.turnSettledWaiters.add(settle);
    });
  }

  /** Wake everyone parked on {@link awaitTurnSettled}; the turn is over. */
  private wakeTurnSettledWaiters(): void {
    if (this.turnSettledWaiters.size === 0) return;
    for (const settle of [...this.turnSettledWaiters]) settle();
  }

  /** Lifecycle to settle into when a turn ends: blocked if interactions remain. */
  private deriveIdleLifecycle(): SessionLifecycle {
    return this.interactions.size > 0 ? 'blocked' : 'idle';
  }

  /**
   * Lifecycle to settle into when a turn ends.
   *
   * Why this is NOT unconditionally idle (C2): on the detached-error path
   * `guardTurnErrors` ingests `status_change{lifecycle:'error'}` and then a
   * terminal `done`, which `feedProjector` maps to `turn_end{terminalReason:'error'}`.
   * Unconditionally calling {@link deriveIdleLifecycle} here would OVERWRITE the
   * `error` with `idle`, so a client that hard-refreshes (cold hydrate from the
   * snapshot) would see a clean idle session and the failure would be invisible
   * — defeating the interrupted-turn UX (Goal #1). The live `/events` consumers
   * saw the transient `error` frame, but the durable snapshot must also reflect
   * it. So a turn that ends in a terminal failure SETTLES to that terminal
   * lifecycle instead of idle.
   *
   * Terminal when: the held lifecycle is already `error` (the error
   * `status_change` arrived first), OR `terminalReason` names an error/abort.
   * Otherwise the normal idle/blocked derivation applies.
   *
   * Note: {@link markInterrupted} ingests NO `turn_end`, so the eviction-driven
   * interrupted lifecycle it sets is never routed through here — this only
   * affects turns that close with a `turn_end`.
   *
   * @param terminalReason - The `turn_end`'s terminal reason, if carried.
   */
  private deriveTurnEndLifecycle(terminalReason: string | undefined): SessionLifecycle {
    if (this.status.lifecycle === 'error' || terminalReason === TERMINAL_REASON_ERROR) {
      return 'error';
    }
    if (terminalReason !== undefined && INTERRUPTED_TERMINAL_REASONS.has(terminalReason)) {
      return 'interrupted';
    }
    return this.deriveIdleLifecycle();
  }

  /** The highest `seq` reflected so far; the snapshot/replay cursor. */
  getCursor(): number {
    return this.counter;
  }

  /**
   * Whether this session is parked on something only a person can answer — a
   * tool approval, a question, or an MCP elicitation that is STILL LIVE.
   *
   * The authoritative answer to "is this turn's silence legitimate?", and the
   * probe the stall watchdog and the session write-lock both ask (DOR-782).
   * Prefer it over reading `getStatus().lifecycle === 'blocked'`: the lifecycle
   * is a projection that a concurrent turn's `turn_start` overwrites with
   * `streaming`, whereas the pending set cannot be overwritten that way.
   *
   * Expiry is not optional here, and the map's raw size is the wrong answer.
   * An entry is normally removed by a resolution or an `interaction_cancelled`,
   * but both are events that must traverse the whole pipeline, and an entry CAN
   * strand: {@link markInterrupted} leaves the set populated, and a runtime
   * stream that throws with an approval outstanding never re-drains its event
   * queue. A stranded entry read as "still waiting" would be permanent — the
   * watchdog could never fire and the lock could never expire, so a turn frozen
   * before DOR-782 would become immortal after it. Delegating to
   * {@link listPendingInteractions} bounds that by the same
   * `INTERACTION_PARK_CEILING_MS` the recovery DTOs already use — a prompt
   * PARKS at `INTERACTION_TIMEOUT_MS` and stays legitimately pending until the
   * ceiling (spec `ask-parks-on-timeout`) — so the two answers to "what is
   * pending" cannot disagree. The window widened; it did not open.
   *
   * @param now - Server epoch ms to evaluate expiry against (injected for tests).
   */
  hasPendingInteractions(now = Date.now()): boolean {
    if (listPendingInteractions(this.interactions, now).length > 0) return true;
    // A capability hold (DOR-939) parks the turn on a person the same way, so it
    // pauses the watchdog too — bounded by its own cap so a stranded hold cannot
    // pause it forever, mirroring the interaction set's expiry.
    return this.hasLiveCapabilityHold(now);
  }

  /**
   * Whether any in-session capability hold is still within its cap (plus
   * {@link CAPABILITY_HOLD_PAUSE_GRACE_MS}). A hold past that is treated as gone:
   * the held tool call has, or is about to, degrade to the poll payload, so it
   * must stop pausing the watchdog and stop holding the lifecycle at `blocked`.
   *
   * @param now - Server epoch ms to evaluate each hold's cap against.
   */
  private hasLiveCapabilityHold(now: number): boolean {
    for (const { startedAt, capMs } of this.capabilityHolds.values()) {
      if (now - startedAt < capMs + CAPABILITY_HOLD_PAUSE_GRACE_MS) return true;
    }
    return false;
  }

  /** A copy of the held status projection. */
  getStatus(): SessionStatus {
    return { ...this.status };
  }

  /**
   * Pending interactions as recovery DTOs, with server-authoritative
   * `remainingMs` and expired entries (`remainingMs <= 0`) excluded. Delegates
   * to the canonical {@link listPendingInteractions} selector so the DOR-73
   * expiry semantics are not forked.
   *
   * @param now - Epoch ms to evaluate the countdown against (defaults to now).
   */
  getPendingInteractions(now: number = Date.now()): PendingInteractionDTO[] {
    return listPendingInteractions(this.interactions, now);
  }

  /**
   * Replay buffered events with `seq` greater than `sinceCursor`, merging the
   * {@link RingBuffer} (current turn) and the {@link EventLog} (full history +
   * overflow) into one ordered, deduped stream.
   *
   * The ring is CLEARED on every {@link RingBuffer.markTurnStarted}, so once a
   * new turn begins it holds only that turn. A client resuming from a cursor
   * that predates the new turn must still receive the prior turn's tail (and its
   * `turn_end`), which lives only in the log. Returning the ring's subset alone
   * would silently drop that tail and break the gap-free resumability guarantee
   * {@link SessionStateProjector.subscribe} promises (spec §B.3). Both sources
   * store identical full {@link SessionEvent}s, so deduping by `seq` is safe.
   *
   * @param sinceCursor - Resume point; only events with a greater seq are returned.
   */
  replayFrom(sinceCursor: number): SessionEvent[] {
    const fromRing = this.ring.replayFrom(sinceCursor);
    const fromLog = this.log.replayFrom(sinceCursor);
    if (fromRing.length === 0) return fromLog;
    if (fromLog.length === 0) return fromRing;
    const bySeq = new Map<number, SessionEvent>();
    for (const event of fromLog) bySeq.set(event.seq, event);
    for (const event of fromRing) bySeq.set(event.seq, event);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * The OPEN turn's events, or `null` when no turn is in flight.
   *
   * Read-only and uncopied, for readers that want the not-yet-durable window
   * specifically — a turn's events reach the store only when it ends, so this
   * is exactly the set that exists nowhere else yet. Cheaper than
   * `replayFrom(0)` for that question by the whole event log, which matters
   * because the approval-receipt overlay asks it on every history read.
   * {@link SessionStateProjector.buildSnapshot} still copies, because a
   * snapshot leaves the process.
   */
  peekInProgressTurn(): readonly SessionEvent[] | null {
    return this.inProgressTurn;
  }

  /**
   * Assemble a {@link SessionSnapshot}: completed messages from the injected
   * loader, the live in-progress turn, the held status, recovery DTOs for
   * pending interactions, and the current cursor as the resume point.
   *
   * Any open sign-in card (DOR-1004) is re-attached to the in-progress turn,
   * even when there is no turn in flight — see {@link openSigninCards} for why
   * that one event outlives its turn. A tab opened while a person is off in
   * their browser signing in therefore draws the card, which is the only state
   * in which a person is likely to open one.
   *
   * Reconciles the running-children count first (DOR-1104): a snapshot is a
   * fresh reader's whole picture of the session, and a child whose silence has
   * already outlasted the bound must not be in it — including on the paths the
   * armed sweep could not answer for (a suspended process, a projector nothing
   * has touched since the deadline passed).
   *
   * @param loadHistory - Supplies completed messages (Claude: JSONL; stateless: EventLog).
   */
  async buildSnapshot(loadHistory: () => Promise<HistoryMessage[]>): Promise<SessionSnapshot> {
    this.expireStaleSubagents();
    const messages = await loadHistory();
    return {
      messages,
      inProgressTurn: this.snapshotInProgressTurn(),
      status: this.getStatus(),
      pendingInteractions: this.getPendingInteractions(),
      queuedMessages: this.readQueue(),
      cursor: this.counter,
    };
  }

  /**
   * This session's queue, as the snapshot reports it.
   *
   * Read THROUGH to the store on every snapshot rather than held as projector
   * state, which is what makes the restart half of the durability promise free:
   * a projector re-created after a restart has no memory of anything, but the
   * rows are still on disk under the id it is registered under, so the first
   * cold connect after a restart hydrates the queue exactly as the last one
   * before it did. It is also what keeps a mutation made by another window
   * (task 2.4's routes write to the store) from needing to reach in here.
   *
   * Keyed by {@link sessionId} — the id the projector is registered under
   * TODAY. The queue's rows move across the canonical-id rename on the same
   * beat the projector does ({@link rekeyProjector}), so the two keys never
   * drift apart.
   */
  private readQueue(): QueuedMessage[] {
    return getMessageQueueStore()?.list(this._sessionId).map(toQueuedMessage) ?? [];
  }

  /**
   * The snapshot's copy of the in-progress turn, with any open sign-in card
   * re-attached.
   *
   * A card already inside the live turn is left where it is rather than
   * appended twice — the client's fold keys cards by `(agentId, serverName)`
   * and would collapse a duplicate anyway, but sending one is still a lie about
   * what the turn contained. Cards are appended in `seq` order after the turn's
   * own events; the fold is order-insensitive for them, and this keeps the list
   * monotonic for anything that assumes it.
   */
  private snapshotInProgressTurn(): SessionEvent[] | null {
    const cards: SessionEvent[] = [];
    for (const entry of this.openSigninCards.values()) {
      cards.push(entry.required);
      // The resolution rides along, because a receipt is the PAIR: the card
      // carries the server name and the disclosure, the resolution carries how it
      // ended. Sending the card alone would hydrate a cold tab with a live-looking
      // sign-in link for a sign-in that is already over.
      if (entry.resolved) cards.push(entry.resolved);
    }
    if (cards.length === 0) return this.inProgressTurn === null ? null : [...this.inProgressTurn];
    const live = this.inProgressTurn ?? [];
    const liveSeqs = new Set(live.map((event) => event.seq));
    const carried = cards.filter((card) => !liveSeqs.has(card.seq)).sort((a, b) => a.seq - b.seq);
    return [...live, ...carried];
  }

  /**
   * Validate that `sinceCursor` can be served gap-free, throwing
   * {@link StaleResumeCursorError} otherwise. Two unservable shapes:
   *
   * 1. Cursor AHEAD of the counter — the seq space was reset (a server restart
   *    re-created this projector); without this check the live filter
   *    `seq > cursor` would silently drop every future event and the client
   *    would be permanently deaf.
   * 2. Cursor below the {@link EventLog} replay floor — trimming dropped part
   *    of the gap, so replay would silently skip a window of events.
   *
   * Called eagerly by {@link subscribe} (NOT deferred to first iteration) so
   * the `/events` route can catch at call time and fall back to the cold
   * snapshot path.
   *
   * @param sinceCursor - The resume cursor a client presented.
   */
  assertResumable(sinceCursor: number): void {
    if (sinceCursor > this.counter) {
      throw new StaleResumeCursorError(
        this.sessionId,
        sinceCursor,
        `Resume cursor ${sinceCursor} is ahead of session ${this.sessionId}'s current seq ${this.counter} (seq space was reset)`
      );
    }
    if (sinceCursor === this.counter) return; // fully caught up — nothing to replay
    const earliest = this.log.earliestSeq();
    if (earliest === undefined || sinceCursor < earliest - 1) {
      throw new StaleResumeCursorError(
        this.sessionId,
        sinceCursor,
        `Resume cursor ${sinceCursor} for session ${this.sessionId} predates the replay floor (oldest retained seq: ${earliest ?? 'none'})`
      );
    }
  }

  /**
   * Resumable event stream: replays buffered events with `seq > sinceCursor`,
   * then yields live events as they are ingested. The boundary is gap- and
   * dup-free because replay is exclusive on the cursor and live delivery picks
   * up from the same monotonic counter. The adapter's `subscribeSession`
   * delegates here.
   *
   * Validates the cursor EAGERLY (throws {@link StaleResumeCursorError} at call
   * time, before returning the iterable) so callers can fall back to the cold
   * snapshot path instead of subscribing into an unservable gap.
   *
   * @param sinceCursor - Resume point; omit (or 0) to start from the beginning.
   * @param signal - Aborts the live wait so a parked consumer terminates and its
   *   `finally` runs. `iterator.return()` alone cannot interrupt the parked-on-
   *   ingest wait (the next ingest might never come for an idle session), so the
   *   route threads an AbortSignal as the deterministic teardown path.
   */
  subscribe(sinceCursor = 0, signal?: AbortSignal): AsyncIterable<SessionEvent> {
    this.assertResumable(sinceCursor);
    return this.subscribeFrom(sinceCursor, signal);
  }

  /** The live replay→park→yield loop behind {@link subscribe} (post-validation). */
  private async *subscribeFrom(
    sinceCursor: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    let cursor = sinceCursor;
    // Subscriber accounting spans the generator's WHOLE lifetime (replay + live)
    // so the finally can self-dispose an empty projector once the last
    // subscriber detaches — see the registry note there.
    this.subscriberCount += 1;
    // The resolver THIS generator parked, if any. On early termination (the
    // consumer breaks/returns or the signal aborts — e.g. a client disconnects)
    // the `finally` removes it so a dangling waiter is not left to be resolved
    // against a dead generator (the I2 leak fix). It is cleared after each
    // ingest resolves it, so the finally is a no-op in the steady state.
    let parked: Waiter | undefined;
    try {
      for (const event of this.replayFrom(cursor)) {
        cursor = event.seq;
        yield event;
      }
      while (true) {
        if (signal?.aborted) return;
        // Retired between the replay phase and parking: end here rather than
        // park on a projector nothing will ever feed again.
        if (this.terminated) return;
        // Drain anything ingested between the replay snapshot and registering as
        // a waiter, so a fast producer cannot slip an event past us.
        const buffered = this.replayFrom(cursor);
        if (buffered.length > 0) {
          for (const event of buffered) {
            cursor = event.seq;
            yield event;
          }
          continue;
        }
        // Race the next ingest against abort so a disconnect terminates the
        // parked wait deterministically. ABORTED is a sentinel distinct from any
        // SessionEvent (never has a `seq`), so we can detect it after the race.
        // ingest() resolves AND clears the waiter wholesale; an abort resolves
        // but leaves the resolver parked, so the abort path removes it itself.
        // The abort listener is REMOVED after every race (not just on abort):
        // `{ once: true }` only auto-removes when abort fires, so the normal
        // delivered-event path would otherwise accumulate one listener — and
        // one retained closure — per event for the connection's lifetime
        // (MaxListenersExceededWarning at 11, unbounded growth on a durable
        // stream).
        let onAbort: (() => void) | undefined;
        const waiter = await new Promise<SessionEvent | typeof ABORTED | typeof TERMINATED>(
          (resolve) => {
            parked = resolve as Waiter;
            this.waiters.push(parked);
            if (signal) {
              onAbort = () => resolve(ABORTED);
              signal.addEventListener('abort', onAbort, { once: true });
            }
          }
        );
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        const settled = parked;
        parked = undefined;
        if (waiter === ABORTED) {
          // ingest() didn't clear this resolver (only an abort resolved it), so
          // remove it ourselves before returning to avoid the I2 leak.
          if (settled) this.removeWaiter(settled);
          return;
        }
        // terminate() cleared the waiter list wholesale, exactly as ingest does,
        // so there is nothing to remove — just end the stream.
        if (waiter === TERMINATED) return;
        const next = waiter;
        if (next.seq > cursor) {
          cursor = next.seq;
          yield next;
        }
      }
    } finally {
      // Covers the consumer breaking/returning while parked with no signal: the
      // resolver is still in `waiters`, so remove it to avoid the I2 leak.
      if (parked) this.removeWaiter(parked);
      this.subscriberCount -= 1;
      // A projector that never ingested anything, holds no interactions, and
      // just lost its last subscriber is pure registry garbage — created by an
      // `/events` connect for a casually-browsed (or unknown) session id, which
      // the no-404 policy deliberately serves. Without this, every visited id
      // pins a projector for the server's lifetime (unbounded registry growth).
      // A rekeyed projector can never hit this path: rekey implies a turn ran,
      // so `counter > 0`.
      if (this.subscriberCount === 0 && this.counter === 0 && this.interactions.size === 0) {
        disposeProjectorIfCurrent(this.sessionId, this);
      }
    }
  }

  /**
   * Retire this instance: end every live subscription and refuse new ones
   * (DOR-782).
   *
   * For a projector that has been taken OFF the registry while subscribers are
   * still attached — today only the {@link rekeyProjector} collision, where an
   * active turn's instance displaces a pre-existing one under the canonical id.
   * A displaced instance can never be ingested into again (nothing can resolve
   * it), so its parked subscribers would wait on an event that cannot come:
   * their `/events` connections stay open receiving nothing but keepalives, and
   * the client has no way to notice. Ending the streams closes those responses,
   * and the client's normal reconnect lands on the live projector and
   * re-snapshots.
   *
   * Not the same as {@link disposeProjector}, which only drops the registry
   * entry. Idempotent.
   *
   * @returns How many live subscriptions this ended (0 when there were none).
   */
  terminate(): number {
    if (this.terminated) return 0;
    this.terminated = true;
    this.cancelTimers();
    // Nothing will ever be fed to this instance again, so a turn that is
    // "in progress" here will never settle. Release rather than hold to the
    // bound: the caller is holding a person's message either way.
    this.wakeTurnSettledWaiters();
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake(TERMINATED);
    return waiters.length;
  }

  /** Remove a specific parked resolver from the live waiters list. */
  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);
  }

  /**
   * Number of live subscribers currently parked awaiting the next event.
   *
   * @internal Exposed for tests asserting that a terminated subscription leaves
   * no dangling waiter behind (the I2 cleanup guarantee).
   */
  getWaiterCount(): number {
    return this.waiters.length;
  }

  /**
   * The projector's own bookkeeping, for the diagnostic read surface.
   *
   * One accessor rather than five getters, and content-free by construction:
   * every value is a count, a coarse enum, or a cursor. The events themselves
   * are never reachable from here — the buffers hold message text, and this is
   * a surface that answers "how much" and "what state", never "what was said".
   */
  debugCounters(): SessionDebugCounters {
    return {
      lifecycle: this.status.lifecycle,
      seq: this.counter,
      subscribers: this.subscriberCount,
      waiters: this.waiters.length,
      eventLogSize: this.log.size(),
      // Counted, never replayed: `replayFrom(0)` copies the array AND runs the
      // ring's lazy TTL sweep, so reading the debug surface would mutate the
      // state it is reporting.
      ringSize: this.ring.size(),
      persistence: this.persistence?.mode ?? 'off',
    };
  }
}

/** Live projector registry keyed by DorkOS session id. */
const projectors = new Map<string, SessionStateProjector>();

/**
 * Retired session id → the id its projector actually lives under now (DOR-1262).
 *
 * A brand-new session's 202 carries the REQUEST UUID whenever the runtime
 * assigns its canonical id after the response has already gone out, so a client
 * can legitimately hold an id this registry no longer keys anything by. Every
 * OTHER layer already accepts that id — the runtime resolves it, the routes
 * accept it, the lock follows it — and the projector registry was the one place
 * that did not: it minted a FRESH EMPTY projector, splitting the session in two
 * and (once the runtime re-announced the canonical id) terminating the live
 * subscribers of the real one.
 *
 * This is not the indefinite dual-id aliasing ADR-0267 rejected. The entry is
 * in-memory, one-directional (a retired id points at the canonical one, never
 * the reverse), born from the same one-time move {@link rekeyProjector} already
 * performs, and cleared when the canonical projector is disposed — so a retired
 * id never outlives the session that retired it, and there is still exactly ONE
 * projector per session.
 *
 * Flat by construction: {@link recordProjectorRedirect} collapses chains at
 * write time, so A→B→C resolves in one hop and every value is a live key rather
 * than another retired id. Size is a live session's rename HISTORY (one entry
 * per rename, and the SDK renames on every resume), all of it freed by
 * {@link forgetProjectorRedirects} when the session's projector goes.
 */
const projectorRedirects = new Map<string, string>();

/**
 * The id `sessionId`'s projector is registered under — itself, unless the id was
 * retired by a rekey, in which case the canonical id it moved to.
 */
function resolveProjectorId(sessionId: string): string {
  return projectorRedirects.get(sessionId) ?? sessionId;
}

/**
 * Record that `retiredId`'s projector now lives under `canonicalId`, keeping the
 * map flat: the new canonical id can no longer be a retired key, and anything
 * that pointed at the id being retired is re-pointed at its destination (so a
 * second rekey collapses A→B→C into A→C rather than growing a chain).
 */
function recordProjectorRedirect(retiredId: string, canonicalId: string): void {
  projectorRedirects.delete(canonicalId);
  for (const [from, to] of projectorRedirects) {
    if (to === retiredId) projectorRedirects.set(from, canonicalId);
  }
  projectorRedirects.set(retiredId, canonicalId);
}

/**
 * Drop every retired id pointing at `canonicalId`. Called wherever that
 * projector leaves the registry, so a redirect can never outlive the projector
 * it points at.
 *
 * This is what bounds the map. It holds one entry per RENAME of a live session,
 * not one per session — the SDK re-mints its id on every resume, so a
 * long-running session accumulates an entry per resume — and every one of them
 * is freed the moment that session's projector is disposed. Lookups are
 * unaffected either way: they stay one hop, because chains collapse on write.
 */
function forgetProjectorRedirects(canonicalId: string): void {
  for (const [from, to] of projectorRedirects) {
    if (to === canonicalId) projectorRedirects.delete(from);
  }
}

/**
 * Durable session-event store for LOG-BACKED runtimes (DOR-189), injected once
 * at boot. `undefined` until wired — and in unit tests / embedded hosts without
 * a Db — in which case persistence is a no-op and history degrades to the
 * in-memory EventLog (the pre-DOR-189 behavior).
 */
let sessionEventStore: SessionEventStore | undefined;

/**
 * Inject the durable session-event store, called once from the composition
 * root (`apps/server/src/index.ts`) after `createDb()`. Passing `undefined`
 * clears it (test isolation).
 *
 * @param store - The shared store, or `undefined` to disable persistence.
 */
export function setSessionEventStore(store: SessionEventStore | undefined): void {
  sessionEventStore = store;
}

/** The injected durable session-event store, or `undefined` when none is wired. */
export function getSessionEventStore(): SessionEventStore | undefined {
  return sessionEventStore;
}

/**
 * Remove `sessionId`'s registry entry only if it still maps to `instance`.
 * Guards the self-dispose path: between a subscriber detaching and this call,
 * the id could (in principle) have been re-keyed or re-created — deleting an
 * entry that now belongs to a DIFFERENT projector would orphan live state.
 */
function disposeProjectorIfCurrent(sessionId: string, instance: SessionStateProjector): void {
  if (projectors.get(sessionId) !== instance) return;
  projectors.delete(sessionId);
  forgetProjectorRedirects(sessionId);
}

/**
 * Return the single {@link SessionStateProjector} for a session, creating it on
 * first access. Task #4 (adapter) and task #5 (route) obtain the same instance
 * for a session through this registry.
 *
 * A RETIRED id resolves to the projector it was rekeyed to and never mints a
 * second one ({@link projectorRedirects}) — a client that only ever saw the
 * request UUID (the 202 for a brand-new session hands out nothing else when the
 * runtime names the session late) gets the session's one live projector, not an
 * empty duplicate.
 *
 * @param sessionId - DorkOS session id.
 * @param cwd - The session's working directory, when the caller knows it.
 *   Stamped once (first writer wins) and carried on status fan-outs.
 * @param opts.persist - Opts the session into durable session-event storage
 *   (DOR-189). `'history'` is the LOG-BACKED runtimes (codex/opencode/test-mode)
 *   on their read/subscribe paths, where the store IS the history; `'record'` is
 *   everything else, where the store holds only what the runtime's own
 *   transcript cannot answer for. Callers that own a turn pick between them with
 *   {@link persistenceModeFor}. A no-op when no store is wired, or on a
 *   projector that already persists.
 */
export function getOrCreateProjector(
  sessionId: string,
  cwd?: string,
  opts?: { persist?: ProjectorPersistenceMode }
): SessionStateProjector {
  const key = resolveProjectorId(sessionId);
  let projector = projectors.get(key);
  if (!projector) {
    projector = new SessionStateProjector(key);
    projectors.set(key, projector);
  }
  if (cwd !== undefined && projector.cwd === undefined) projector.cwd = cwd;
  if (opts?.persist !== undefined && sessionEventStore !== undefined) {
    projector.enablePersistence(sessionEventStore, opts.persist);
  }
  return projector;
}

/**
 * The current status of every live projector — the standing counterpart to
 * {@link onProjectorStatusChange}.
 *
 * That listener reports TRANSITIONS, which is all a client that was connected
 * the whole time needs. A client that connects afterwards has witnessed none of
 * them, so it needs the state those transitions left behind; this answers that,
 * off the same registry and in the same {@link ProjectorStatusUpdate} shape, so
 * a reader cannot tell a snapshot entry from a live one and no second
 * projection can drift from the first.
 *
 * `retiredSessionId` is deliberately never set here: a retirement is an edge
 * ("stop holding state under this id"), not a state, and re-announcing one to a
 * client that never held the retired id says nothing.
 *
 * **In-memory and therefore bounded.** A projector lives until its session is
 * evicted (claude-code: `SESSIONS.TIMEOUT_MS`, 30 minutes idle) or the server
 * restarts, so this answers for the recent fleet, not for all history. That is
 * the same bound the live fan-out has always had.
 */
export function listProjectorStatuses(): ProjectorStatusUpdate[] {
  return [...projectors.entries()].map(([sessionId, projector]) => ({
    sessionId,
    cwd: projector.cwd,
    status: projector.getStatus(),
  }));
}

/**
 * Every pending interaction across every live projector, with
 * server-authoritative `remainingMs` and expired entries excluded.
 *
 * The standing counterpart to {@link onProjectorInteractionChange}, exactly as
 * {@link listProjectorStatuses} is to {@link onProjectorStatusChange}: the
 * listener reports transitions, and a window that opened afterwards has
 * witnessed none of them. This is what it reads on mount.
 *
 * Expiry is not recomputed here. Each projector answers through
 * {@link SessionStateProjector.getPendingInteractions}, which delegates to the
 * canonical `listPendingInteractions` selector, so the rule about what counts as
 * still-live is defined exactly once and this cannot fork it.
 *
 * A session whose directory was never stamped is skipped, for the same reason
 * the live path skips it: `cwd` is the deep link and the name fallback, and
 * there is nothing honest to put there.
 *
 * **Bounded exactly as {@link listProjectorStatuses} is**: a projector lives
 * until its session is evicted or the process restarts, so this answers for the
 * recent fleet and never for all history. That is the same bound the live
 * fan-out has always had.
 *
 * @param now - Server epoch ms to evaluate each countdown against.
 */
export function listPendingInteractionsAcrossSessions(
  now: number = Date.now()
): Array<{ sessionId: string; cwd: string; interaction: PendingInteractionDTO }> {
  const out: Array<{ sessionId: string; cwd: string; interaction: PendingInteractionDTO }> = [];
  for (const [sessionId, projector] of projectors) {
    const { cwd } = projector;
    if (cwd === undefined) continue;
    for (const interaction of projector.getPendingInteractions(now)) {
      out.push({ sessionId, cwd, interaction });
    }
  }
  return out;
}

/**
 * Every session with a live projector, for the diagnostic read surface.
 *
 * The registry is a module-private `Map` and there has never been a way to ask
 * it anything from outside the process — which is how "which projector owns this
 * session, and who is subscribed?" became a question the 2026-07-31 incident
 * could not answer.
 *
 * `retiredIds` is the other half of that question: a client, a log line or a
 * bug report may name an id the session no longer answers to, and without the
 * redirects on this surface it would appear on no projector at all. Each entry
 * lists every retired id that resolves to it ({@link projectorRedirects}).
 *
 * @returns One entry per live projector, ids and counts only.
 */
export function listProjectorDebugCounters(): Array<
  { sessionId: string; retiredIds: string[] } & SessionDebugCounters
> {
  const retiredBySession = new Map<string, string[]>();
  for (const [retiredId, canonicalId] of projectorRedirects) {
    const ids = retiredBySession.get(canonicalId);
    if (ids) ids.push(retiredId);
    else retiredBySession.set(canonicalId, [retiredId]);
  }
  return [...projectors.entries()].map(([sessionId, projector]) => ({
    sessionId,
    retiredIds: retiredBySession.get(sessionId) ?? [],
    ...projector.debugCounters(),
  }));
}

/**
 * Return the existing projector for a session WITHOUT creating one, or
 * `undefined` if none is registered. Used by the eviction path (I1) to finalize
 * and drop only live projectors — never to allocate a throwaway for an id that
 * was never streamed.
 *
 * Redirect-aware like {@link getOrCreateProjector}: a retired id answers with
 * the projector it was rekeyed to, so a caller holding the pre-rekey id reads
 * the session's real state instead of `undefined` (DOR-1262).
 *
 * @param sessionId - DorkOS session id.
 */
export function peekProjector(sessionId: string): SessionStateProjector | undefined {
  return projectors.get(resolveProjectorId(sessionId));
}

/**
 * Drop a session's projector (e.g. on session eviction). A later
 * {@link getOrCreateProjector} for the same id yields a fresh instance.
 *
 * Takes either of the session's ids: a retired one disposes the projector it
 * points at, and every redirect onto that projector goes with it — a session
 * being disposed under one of its ids must not leave the other half alive.
 *
 * @param sessionId - DorkOS session id.
 */
export function disposeProjector(sessionId: string): void {
  const key = resolveProjectorId(sessionId);
  // Before the entry goes: an armed timer would otherwise fire on an instance
  // nothing can reach and announce a session that is gone.
  projectors.get(key)?.cancelTimers();
  projectors.delete(key);
  forgetProjectorRedirects(key);
  // Drop the session's DevTools capture buffer alongside its projector — the
  // preview is gone, and the buffer must not outlive the session (DOR-213). The
  // buffer moved to the canonical id on the rekey, so it is dropped by that id.
  devtoolsCaptureStore.dropSession(key);
}

/**
 * Move the SAME projector instance from `oldId` to `newId` in the registry,
 * preserving instance identity.
 *
 * Why this exists (C1): a brand-new session's turn is triggered under the
 * request UUID (`getOrCreateProjector(<requestUUID>)`), but the adapter assigns
 * the SDK canonical id mid-turn and the POST returns it in the 202 — so the
 * client re-keys its `/events` subscription to the canonical id. Without a
 * rekey, the subscription's `getOrCreateProjector(<canonicalId>)` would mint a
 * FRESH EMPTY projector (cursor 0) and the already-ingested turn — held under
 * the UUID — would be invisible under the canonical id. ADR-0267 forbids
 * server-side dual-id aliasing, so the id-keyed registry must instead be
 * RE-KEYED when the canonical id is resolved.
 *
 * Instance identity is preserved deliberately: the in-flight `feedProjector`
 * holds a direct reference to the instance, and any already-open `/events`
 * subscription iterates the instance (not the key). Both therefore keep working
 * across the rekey with no interruption — the move only changes how a FUTURE
 * `getOrCreateProjector`/`getSessionSnapshot` resolves the id.
 *
 * The move leaves a REDIRECT behind ({@link projectorRedirects}): `oldId` keeps
 * resolving to this projector for as long as it lives, so a client, an API
 * caller or a second trigger that still holds the retired id reaches the live
 * session instead of minting an empty duplicate beside it (DOR-1262). Callers
 * may therefore pass either id here too — a rekey announced under an already
 * retired id moves whatever that id resolves to.
 *
 * Edge case: if a projector already exists under `newId`, the ACTIVE turn's
 * instance wins and replaces the stale `newId` entry, with a warning. Dropping
 * the active turn's instance would orphan the in-flight feed; the pre-existing
 * `newId` projector has no active turn, so it is the safer one to discard. The
 * displaced instance is {@link SessionStateProjector.terminate}d rather than
 * merely dropped (DOR-782): once it is off the registry nothing can ingest into
 * it, so its live subscribers would otherwise sit on an open `/events`
 * connection receiving only keepalives, forever. Ending their streams sends them
 * through their normal reconnect onto the winner. This branch is DEFENSIVE and
 * no longer reachable by the path that made it fire in practice: a second turn
 * triggered under the retired id used to mint a fresh projector there, and the
 * runtime's next re-announce of the canonical id then killed the real
 * projector's live subscribers (DOR-1262). The redirect removes both halves —
 * the retired id cannot mint, and re-announcing a move that already happened
 * resolves to `newId` and returns below.
 *
 * No-op when `oldId === newId` (an existing session whose id never changes),
 * when `oldId` already resolves to `newId` (the same move announced twice), or
 * when no projector is registered under it.
 *
 * @param oldId - The id the projector is currently registered under (the request UUID).
 * @param newId - The canonical id to re-key it to.
 */
export function rekeyProjector(oldId: string, newId: string): void {
  if (oldId === newId) return;
  // Everything below works on the id the projector ACTUALLY lives under, so a
  // rekey announced under an already-retired id chains (A→B then A→C moves B to
  // C) rather than silently doing nothing, and the durable rows/observers below
  // are told about the move that really happened.
  const fromId = resolveProjectorId(oldId);
  if (fromId === newId) return;
  const projector = projectors.get(fromId);
  if (!projector) return;
  const displaced = projectors.get(newId);
  if (displaced !== undefined) {
    // Evicting the displaced instance is not enough: it is now unreachable, so
    // its live subscribers would park forever on an ingest that can never come.
    // End their streams so their clients reconnect onto the winner (DOR-782).
    const endedSubscribers = displaced.terminate();
    // The displaced projector's OWN retired ids still point at `newId`. Left
    // alone they would resolve to the winner — one session's ids silently
    // answering with another session's projector. They belong to the instance
    // that just died, so they die with it.
    forgetProjectorRedirects(newId);
    logger.warn('[SessionStateProjector] rekey target already has a projector; active turn wins', {
      oldId: fromId,
      newId,
      endedSubscribers,
    });
  }
  projectors.set(newId, projector);
  projectors.delete(fromId);
  recordProjectorRedirect(fromId, newId);
  // Carry any DevTools capture buffer across the same rekey so a preview opened
  // under the request UUID keeps feeding the canonical session (DOR-213).
  devtoolsCaptureStore.rekeySession(fromId, newId);
  // Carry the DURABLE rows too, or every permission decision made before the
  // rename stops existing. Rows key by the id held at flush time and readers
  // ask one id, so a session renamed after it has turns behind it would leave
  // them stranded — invisible on a cold open, which is the whole thing the
  // rows are for. The FIRST rename has nothing to move (a new session has
  // flushed nothing); the SECOND does, and the SDK issues one on a resume.
  // Failure costs the older receipts, never the rename.
  try {
    sessionEventStore?.rekeySession(fromId, newId);
    // The queue moves on the same beat, and it is the half that CANNOT be lost:
    // a person is told their message was accepted, and a row left behind at the
    // pre-rename id is invisible to every window and to the dispatcher, so their
    // words would evaporate on the session's very first turn. One call site,
    // beside the receipts, because both are "durable rows keyed by session id".
    getMessageQueueStore()?.rekeySession(fromId, newId);
    // And the staged hold with them, for the same reason one step further on:
    // the person has already been told their words will ride the next reply, and
    // a hold left at the pre-rename id is invisible to every dispatch after it.
    getStagedContextStore()?.rekeySession(fromId, newId);
  } catch (err) {
    logger.warn('[SessionStateProjector] durable rows not carried across rekey', {
      oldId: fromId,
      newId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Re-announce under the canonical id, carrying the id it just left as retired:
  // transitions broadcast before the rekey landed in client stores under that
  // id, and no session_removed will ever fire for it — without the retire
  // signal, a pre-rekey 'streaming' would pin agent-row liveness forever.
  projector.adoptSessionId(newId);
  notifyStatusChange(projector, fromId);
  // Notify id-keyed subsystems that hold their own per-session state (e.g. the
  // connector attach set) so they can move it across the same rekey. Kept as an
  // observer list so this session-core module never imports those domains.
  for (const listener of rekeyListeners) listener(fromId, newId);
}

/** A subscriber notified when a session reaches a turn boundary. */
type TurnBoundaryListener = (sessionId: string) => void;

/** Observers of `turn_end` / `interaction_resolved`; see {@link onProjectorTurnBoundary}. */
const turnBoundaryListeners = new Set<TurnBoundaryListener>();

/**
 * Subscribe to the two moments that can free a session for the message waiting
 * behind it: a turn that ENDED (`turn_end`), and an interaction a person
 * ANSWERED (`interaction_resolved`).
 *
 * The message dispatcher is the subscriber. The list is exactly those two events
 * and that is the whole contract — in particular a bare `result` is **not** a
 * turn boundary. A turn can produce a result and keep going, and dequeuing on
 * one is how a queued message fires into work that is still running (the
 * failure mode named in spec `persistent-session-runtime` §3.4).
 *
 * This is not the reopen predicate and must not be confused with it: a closed
 * turn still reopens only on raw model-speech StreamEvents (#909). This observes
 * a turn closing; it never reopens one.
 *
 * @param listener - Invoked with the session id at each boundary.
 * @returns An unsubscribe function.
 */
export function onProjectorTurnBoundary(listener: TurnBoundaryListener): () => void {
  turnBoundaryListeners.add(listener);
  return () => {
    turnBoundaryListeners.delete(listener);
  };
}

/** Tell every boundary observer, without letting one of them break an ingest. */
function notifyTurnBoundary(sessionId: string): void {
  for (const listener of turnBoundaryListeners) {
    try {
      listener(sessionId);
    } catch (err) {
      logger.warn('[SessionStateProjector] a turn-boundary observer threw', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** A subscriber notified when a projector is rekeyed to its canonical id. */
type RekeyListener = (oldId: string, newId: string) => void;

/** Observers moved across a canonical-id rekey; see {@link onProjectorRekey}. */
const rekeyListeners = new Set<RekeyListener>();

/**
 * Subscribe to projector rekeys — the canonical-id remap a brand-new session
 * undergoes mid-first-turn ({@link rekeyProjector}). Any subsystem that holds
 * per-session state keyed by the request id (the connector attach set) uses this
 * to migrate that state to the canonical id, so it is not stranded on the
 * pre-remap id. Runtime-neutral and decoupled: the listener is called after the
 * projector move, with `(oldId, newId)`.
 *
 * @param listener - Invoked on every rekey with the old and new session ids.
 * @returns An unsubscribe function.
 */
export function onProjectorRekey(listener: RekeyListener): () => void {
  rekeyListeners.add(listener);
  return () => {
    rekeyListeners.delete(listener);
  };
}
