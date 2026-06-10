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
import { listPendingInteractions } from '../runtimes/claude-code/messaging/pending-interactions.js';
import type {
  InteractiveSession,
  PendingInteraction,
} from '../runtimes/claude-code/messaging/interactive-handlers.js';
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
  type: PendingInteraction['type'];
  startedAt: number;
  /** Re-emit payload, minus the timer fields the selector recomputes. */
  snapshot: Record<string, unknown>;
}

/** A subscriber waiting for the next ingested event. */
type Waiter = (event: SessionEvent) => void;

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

  constructor(readonly sessionId: string) {}

  /**
   * Ingest a raw adapter event: stamp `seq`, update the projection, append to
   * the log and ring, and wake live subscribers. Returns the seq'd event.
   *
   * @param raw - A {@link SessionEvent} union member without its `seq`.
   */
  ingest(raw: RawSessionEvent): SessionEvent {
    const event = { ...raw, seq: ++this.counter } as SessionEvent;
    this.project(event);
    this.log.append(event);
    this.ring.append(event);
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake(event);
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
      default:
        break;
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
  private interactionKind(type: string): PendingInteraction['type'] {
    if (type === 'question_prompt') return 'question';
    if (type === 'elicitation_prompt') return 'elicitation';
    return 'approval';
  }

  /**
   * Remove a resolved (approved/denied/answered) interaction so it is not
   * re-presented on reconnect. The adapter calls this when the operator acts.
   *
   * @param interactionId - The id carried by the interaction event.
   */
  resolveInteraction(interactionId: string): void {
    this.interactions.delete(interactionId);
    if (this.interactions.size === 0 && this.status.lifecycle === 'blocked') {
      this.status.lifecycle = this.inProgressTurn !== null ? 'streaming' : 'idle';
    }
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
    return listPendingInteractions(this.toInteractiveSession(), now);
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
   * Resumable event stream: replays buffered events with `seq > sinceCursor`,
   * then yields live events as they are ingested. The boundary is gap- and
   * dup-free because replay is exclusive on the cursor and live delivery picks
   * up from the same monotonic counter. The adapter's `subscribeSession`
   * delegates here.
   *
   * @param sinceCursor - Resume point; omit (or 0) to start from the beginning.
   * @param signal - Aborts the live wait so a parked consumer terminates and its
   *   `finally` runs. `iterator.return()` alone cannot interrupt the parked-on-
   *   ingest wait (the next ingest might never come for an idle session), so the
   *   route threads an AbortSignal as the deterministic teardown path.
   */
  async *subscribe(sinceCursor = 0, signal?: AbortSignal): AsyncIterable<SessionEvent> {
    let cursor = sinceCursor;
    for (const event of this.replayFrom(cursor)) {
      cursor = event.seq;
      yield event;
    }
    // The resolver THIS generator parked, if any. On early termination (the
    // consumer breaks/returns or the signal aborts — e.g. a client disconnects)
    // the `finally` removes it so a dangling waiter is not left to be resolved
    // against a dead generator (the I2 leak fix). It is cleared after each
    // ingest resolves it, so the finally is a no-op in the steady state.
    let parked: Waiter | undefined;
    try {
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
        const waiter = await new Promise<SessionEvent | typeof ABORTED>((resolve) => {
          parked = resolve as Waiter;
          this.waiters.push(parked);
          if (signal) {
            signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
          }
        });
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

  /**
   * Adapt the projector's tracked interactions to the minimal shape the
   * {@link listPendingInteractions} selector reads. Only `pendingInteractions`
   * is consulted; the queue fields are inert here.
   */
  private toInteractiveSession(): InteractiveSession {
    const pendingInteractions = new Map<string, PendingInteraction>();
    for (const [id, tracked] of this.interactions) {
      // The selector reads only `type`, `startedAt`, and `snapshot`; the live
      // SDK fields (resolve/reject/timeout/toolCallId) are absent here because
      // the projector tracks recovery state, not the live approval closures.
      pendingInteractions.set(id, {
        type: tracked.type,
        startedAt: tracked.startedAt,
        snapshot: tracked.snapshot,
      } as unknown as PendingInteraction);
    }
    return { pendingInteractions, eventQueue: [] };
  }
}

/** Live projector registry keyed by DorkOS session id. */
const projectors = new Map<string, SessionStateProjector>();

/**
 * Return the single {@link SessionStateProjector} for a session, creating it on
 * first access. Task #4 (adapter) and task #5 (route) obtain the same instance
 * for a session through this registry.
 *
 * @param sessionId - DorkOS session id.
 */
export function getOrCreateProjector(sessionId: string): SessionStateProjector {
  let projector = projectors.get(sessionId);
  if (!projector) {
    projector = new SessionStateProjector(sessionId);
    projectors.set(sessionId, projector);
  }
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
}
