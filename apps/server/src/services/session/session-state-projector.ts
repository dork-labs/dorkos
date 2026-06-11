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
import { StaleResumeCursorError } from '@dorkos/shared/session-stream';
import type {
  SessionEvent,
  SessionSnapshot,
  SessionStatus,
  SessionContextUsage,
  SessionLifecycle,
} from '@dorkos/shared/session-stream';
import type {
  HistoryMessage,
  PendingInteractionDTO,
  PermissionMode,
  TaskItem,
} from '@dorkos/shared/types';
import { listPendingInteractions } from './pending-interactions.js';
import { logger } from '../../lib/logger.js';
import { EventLog } from './event-log.js';
import { RingBuffer } from './ring-buffer.js';

/**
 * An event as produced by an adapter: a {@link SessionEvent} union member with
 * the `seq` omitted. The projector stamps `seq` on ingest so the adapter never
 * has to track ordering. This keeps the adapter a pure normalizer.
 */
export type RawSessionEvent = Omit<SessionEvent, 'seq'>;

/**
 * The partial status payload carried by a `status_change` event: top-level
 * keys are optional and the nested `contextUsage` is itself partial (a delta
 * may carry only `outputTokens`, or only the context/cache totals).
 */
type StatusChangePayload = Extract<SessionEvent, { type: 'status_change' }>['status'];

/** Permission mode used before any `status_change` reports one. */
const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/**
 * The `turn_end.terminalReason` value the detached-error path attaches (emitted
 * by `guardTurnErrors` in `trigger-turn.ts`). A turn that closes with this
 * settles to the `error` lifecycle so a cold hydrate still surfaces the failure.
 */
const TERMINAL_REASON_ERROR = 'error';

/**
 * `turn_end.terminalReason` values that mean the turn was interrupted/aborted
 * rather than completing. Includes the explicit `interrupted` plus the SDK's
 * abort reasons (`TerminalReason`), so an aborted turn settles to the
 * `interrupted` lifecycle (not idle) and a cold hydrate shows it was cut short.
 */
const INTERRUPTED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'interrupted',
  'aborted_streaming',
  'aborted_tools',
]);

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
    cacheStats: null,
    model: null,
    permissionMode: DEFAULT_PERMISSION_MODE,
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle: 'idle',
  };
}

/** A live interaction the projector tracks for pending-recovery projection. */
interface TrackedInteraction {
  type: PendingInteractionDTO['type'];
  startedAt: number;
  /** Re-emit payload, minus the timer fields the selector recomputes. */
  snapshot: Record<string, unknown>;
}

/** A subscriber waiting for the next ingested event. */
type Waiter = (event: SessionEvent) => void;

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
 * Sentinel resolved into a {@link SessionStateProjector.subscribe} wait when its
 * {@link AbortSignal} fires. Distinct from any {@link SessionEvent} (which always
 * carries a `seq`), so the generator can tell an abort from a real event.
 */
const ABORTED = Symbol('subscribe-aborted');

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

  /** Live interactions keyed by id; mirrors the DOR-73 pendingInteractions map. */
  private readonly interactions = new Map<string, TrackedInteraction>();

  /** Running subagents by taskId; size feeds `runningSubagentCount`. */
  private readonly runningSubagents = new Set<string>();

  /** Live subscribers awaiting the next event (resolved on each ingest). */
  private waiters: Waiter[] = [];

  /** Active {@link subscribe} generators (replay or live phase). */
  private subscriberCount = 0;

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
    const event = { ...raw, seq: ++this.counter } as SessionEvent;
    // Capture before project(): applyStatusChange replaces the status object.
    const lifecycleBefore = this.status.lifecycle;
    this.project(event);
    this.log.append(event);
    this.ring.append(event);
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake(event);
    if (this.status.lifecycle !== lifecycleBefore) notifyStatusChange(this);
    return event;
  }

  /** Fold an event into the live projection. */
  private project(event: SessionEvent): void {
    if (this.inProgressTurn !== null && event.type !== 'turn_end') {
      this.inProgressTurn.push(event);
    }
    switch (event.type) {
      case 'turn_start':
        this.inProgressTurn = [event];
        this.ring.markTurnStarted();
        this.status.lifecycle = 'streaming';
        break;
      case 'turn_end':
        this.inProgressTurn = null;
        this.ring.markTurnEnded();
        this.status.lifecycle = this.deriveTurnEndLifecycle(event.terminalReason);
        break;
      case 'status_change':
        this.applyStatusChange(event.status);
        break;
      case 'todo_update':
        this.applyTodoUpdate(event.tasks);
        break;
      case 'subagent_update':
        this.applySubagentUpdate(event.taskId, event.status);
        break;
      case 'approval_required':
      case 'question_prompt':
      case 'elicitation_prompt':
        this.trackInteraction(event);
        break;
      case 'interaction_resolved':
        this.untrackInteraction(event.id);
        break;
      default:
        break;
    }
  }

  /**
   * Drop a resolved interaction from the pending projection and settle the
   * lifecycle back from `blocked` once nothing remains pending. Runs via
   * {@link project} so the same fold applies on live ingest AND any replay.
   */
  private untrackInteraction(interactionId: string): void {
    this.interactions.delete(interactionId);
    if (this.interactions.size === 0 && this.status.lifecycle === 'blocked') {
      this.status.lifecycle = this.inProgressTurn !== null ? 'streaming' : 'idle';
    }
  }

  /**
   * Merge a partial status delta into the held status. `contextUsage` is merged
   * FIELD-WISE onto the prior value rather than wholesale-replaced: a final
   * `session_status` carries context/cache totals but no `outputTokens`, and a
   * streaming one carries only `outputTokens` — a wholesale replace would let
   * each delta zero the fields it does not carry (e.g. reset the running
   * output-token count at turn end). Absent fields keep their prior value.
   */
  private applyStatusChange(partial: StatusChangePayload): void {
    const { contextUsage, ...rest } = partial;
    this.status = { ...this.status, ...rest };
    if (contextUsage !== undefined) {
      this.status.contextUsage =
        contextUsage === null
          ? null
          : { ...mergeBaseContextUsage(this.status.contextUsage), ...contextUsage };
    }
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

  /** Track running subagents; `runningSubagentCount` mirrors the live set size. */
  private applySubagentUpdate(taskId: string, status: string): void {
    if (status === 'running') {
      this.runningSubagents.add(taskId);
    } else {
      this.runningSubagents.delete(taskId);
    }
    this.status.runningSubagentCount = this.runningSubagents.size;
  }

  /** Record a pending interaction and flip the session to `blocked`. */
  private trackInteraction(event: SessionEvent): void {
    if (
      event.type !== 'approval_required' &&
      event.type !== 'question_prompt' &&
      event.type !== 'elicitation_prompt'
    ) {
      return;
    }
    // Strip the union discriminator, seq, and timer fields — the selector
    // recomputes remainingMs and re-adds id/startedAt — leaving the re-emit body.
    const { type, seq, id, startedAt, remainingMs, ...snapshot } = event;
    void seq;
    void remainingMs;
    this.interactions.set(id, {
      type: this.interactionKind(type),
      startedAt,
      snapshot,
    });
    this.status.lifecycle = 'blocked';
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
   */
  resolveInteraction(interactionId: string, resolution?: 'approved' | 'denied' | 'answered'): void {
    if (!this.interactions.has(interactionId)) return;
    // RawSessionEvent's Omit-on-union collapses to the common keys, so the
    // member literal needs the same widening cast `ingest` itself applies.
    this.ingest({
      type: 'interaction_resolved',
      id: interactionId,
      resolution,
    } as unknown as RawSessionEvent);
  }

  /**
   * Mark the in-flight turn interrupted — used by the restart-degradation hook
   * (task #6) when a turn was left `streaming` with no `turn_end`. No-op if no
   * turn is in progress.
   */
  markInterrupted(): void {
    if (this.inProgressTurn !== null || this.status.lifecycle === 'streaming') {
      this.inProgressTurn = null;
      this.ring.markTurnEnded();
      this.status.lifecycle = 'interrupted';
      // This path mutates lifecycle WITHOUT an ingest, so fan out here.
      notifyStatusChange(this);
    }
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
   * Assemble a {@link SessionSnapshot}: completed messages from the injected
   * loader, the live in-progress turn, the held status, recovery DTOs for
   * pending interactions, and the current cursor as the resume point.
   *
   * @param loadHistory - Supplies completed messages (Claude: JSONL; stateless: EventLog).
   */
  async buildSnapshot(loadHistory: () => Promise<HistoryMessage[]>): Promise<SessionSnapshot> {
    const messages = await loadHistory();
    return {
      messages,
      inProgressTurn: this.inProgressTurn === null ? null : [...this.inProgressTurn],
      status: this.getStatus(),
      pendingInteractions: this.getPendingInteractions(),
      cursor: this.counter,
    };
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
        const waiter = await new Promise<SessionEvent | typeof ABORTED>((resolve) => {
          parked = resolve as Waiter;
          this.waiters.push(parked);
          if (signal) {
            onAbort = () => resolve(ABORTED);
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        const settled = parked;
        parked = undefined;
        if (waiter === ABORTED) {
          // ingest() didn't clear this resolver (only an abort resolved it), so
          // remove it ourselves before returning to avoid the I2 leak.
          if (settled) this.removeWaiter(settled);
          return;
        }
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
}

/** Live projector registry keyed by DorkOS session id. */
const projectors = new Map<string, SessionStateProjector>();

/**
 * Remove `sessionId`'s registry entry only if it still maps to `instance`.
 * Guards the self-dispose path: between a subscriber detaching and this call,
 * the id could (in principle) have been re-keyed or re-created — deleting an
 * entry that now belongs to a DIFFERENT projector would orphan live state.
 */
function disposeProjectorIfCurrent(sessionId: string, instance: SessionStateProjector): void {
  if (projectors.get(sessionId) === instance) projectors.delete(sessionId);
}

/**
 * Return the single {@link SessionStateProjector} for a session, creating it on
 * first access. Task #4 (adapter) and task #5 (route) obtain the same instance
 * for a session through this registry.
 *
 * @param sessionId - DorkOS session id.
 * @param cwd - The session's working directory, when the caller knows it.
 *   Stamped once (first writer wins) and carried on status fan-outs.
 */
export function getOrCreateProjector(sessionId: string, cwd?: string): SessionStateProjector {
  let projector = projectors.get(sessionId);
  if (!projector) {
    projector = new SessionStateProjector(sessionId);
    projectors.set(sessionId, projector);
  }
  if (cwd !== undefined && projector.cwd === undefined) projector.cwd = cwd;
  return projector;
}

/**
 * Return the existing projector for a session WITHOUT creating one, or
 * `undefined` if none is registered. Used by the eviction path (I1) to finalize
 * and drop only live projectors — never to allocate a throwaway for an id that
 * was never streamed.
 *
 * @param sessionId - DorkOS session id.
 */
export function peekProjector(sessionId: string): SessionStateProjector | undefined {
  return projectors.get(sessionId);
}

/**
 * Drop a session's projector (e.g. on session eviction). A later
 * {@link getOrCreateProjector} for the same id yields a fresh instance.
 *
 * @param sessionId - DorkOS session id.
 */
export function disposeProjector(sessionId: string): void {
  projectors.delete(sessionId);
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
 * Edge case: if a projector already exists under `newId` (normally impossible
 * for a brand-new session — the canonical id has never been streamed before),
 * the ACTIVE turn's instance (`oldId`) wins and replaces the stale `newId`
 * entry, with a warning. Dropping the active turn's instance would orphan the
 * in-flight feed; the pre-existing `newId` projector has no active turn, so it
 * is the safer one to discard.
 *
 * No-op when `oldId === newId` (an existing session whose id never changes) or
 * when no projector is registered under `oldId`.
 *
 * @param oldId - The id the projector is currently registered under (the request UUID).
 * @param newId - The canonical id to re-key it to.
 */
export function rekeyProjector(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const projector = projectors.get(oldId);
  if (!projector) return;
  if (projectors.has(newId)) {
    logger.warn('[SessionStateProjector] rekey target already has a projector; active turn wins', {
      oldId,
      newId,
    });
  }
  projectors.set(newId, projector);
  projectors.delete(oldId);
  // Re-announce under the canonical id, carrying the request UUID as retired:
  // transitions broadcast before the rekey landed in client stores under the
  // UUID, and no session_removed will ever fire for it — without the retire
  // signal, a pre-rekey 'streaming' would pin agent-row liveness forever.
  projector.adoptSessionId(newId);
  notifyStatusChange(projector, oldId);
}
