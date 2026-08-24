/**
 * Two bounded, process-lifetime rings: what has been dispatched recently, and
 * what was recently refused.
 *
 * Four of the five questions the 2026-07-31 incident asked are about LIVE
 * structures — the claim map, the projector registry, pending interactions, room
 * bindings — and a live structure wants a plain point-in-time read. These two
 * are the exception: they are about the PAST, and the past is not in memory
 * anywhere else.
 *
 * **They are deliberately not persisted.** The NDJSON log is the durable record;
 * a ring buffer written to disk would be a second, worse log with its own
 * retention and rotation problems, and this program exists partly because a
 * second worse log is what "more logging" produces. These die with the process,
 * and the log answers everything they cannot.
 *
 * Fixed-size arrays with a write cursor: one array write per dispatch and per
 * refusal, no allocation beyond the record itself, no timer, no sweep.
 *
 * @module services/observability/dispatch-buffers
 */
import type { DispatchOrigin } from '../../lib/dispatch-context.js';
import type { Refusal, RefusalReason, RefusalVisibility } from './refusals.js';

/**
 * How many entries each ring holds.
 *
 * Sized for an incident, not for history: 256 dispatches is a busy hour of one
 * person's rooms, which is the window somebody is actually reconstructing when
 * they open this. Anything older is a question for the log.
 */
export const DISPATCH_BUFFER_SIZE = 256;

/**
 * How a dispatch ended, once it has.
 *
 * Coarse on purpose — this is a bucket for grouping, not a status the product
 * shows anybody. `quiet` and `refused` are deliberately distinct: an agent that
 * chose to say nothing is exercising judgment, and a trigger that was declined
 * never ran at all, and conflating them is what made a busy agent and a broken
 * one look identical from outside.
 */
export type DispatchOutcome = 'answered' | 'quiet' | 'refused' | 'failed' | 'halted' | 'unfinished';

/** One dispatch, as the buffer remembers it. */
export interface RecentDispatch {
  dispatchId: string;
  origin: DispatchOrigin;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601, or `null` while the dispatch is still running. */
  endedAt: string | null;
  /** `null` while the dispatch is still running. */
  outcome: DispatchOutcome | null;
  roomId?: string;
  sessionId?: string;
}

/** One refusal, as the buffer remembers it. */
export interface RecentRefusal {
  /** ISO 8601. */
  at: string;
  dispatchId?: string;
  origin?: DispatchOrigin;
  reason: RefusalReason;
  visibility: RefusalVisibility;
  roomId?: string;
  authorId?: string;
  sessionId?: string;
  /**
   * The room entry it happened over, when there is one.
   *
   * An id, like every other field here, and that is the whole test for what may
   * live on this interface: `GET /api/debug/refusals` answers without a
   * credential while login is off, so the ring carries identifiers a reader
   * correlates with and nothing a call site composed. `Refusal.detail` — which
   * holds error strings and file paths on other paths — deliberately stays on
   * the log line only, and `dispatch-buffers.test.ts` fails if it ever arrives
   * here.
   */
  entryId?: string;
}

/**
 * A fixed-size ring with a write cursor.
 *
 * Reads come back newest-first, because every question anybody asks of this
 * starts with "what just happened".
 */
class Ring<T> {
  private readonly slots: Array<T | undefined>;
  private cursor = 0;
  private written = 0;

  constructor(private readonly capacity: number) {
    this.slots = new Array<T | undefined>(capacity);
  }

  /**
   * Record one entry, overwriting the oldest once the ring is full.
   *
   * @param entry - The record to keep.
   */
  push(entry: T): void {
    this.slots[this.cursor] = entry;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.written += 1;
  }

  /**
   * The most recent entries, newest first.
   *
   * @param limit - How many to return. Clamped to what the ring holds.
   * @returns Up to `limit` entries.
   */
  recent(limit: number): T[] {
    const held = Math.min(this.written, this.capacity);
    const wanted = Math.max(0, Math.min(limit, held));
    const out: T[] = [];
    for (let i = 1; i <= wanted; i += 1) {
      const slot = this.slots[(this.cursor - i + this.capacity) % this.capacity];
      if (slot !== undefined) out.push(slot);
    }
    return out;
  }

  /**
   * Find the newest entry matching `match`, for in-place updates.
   *
   * Scans backwards over the slots rather than through {@link Ring.recent},
   * which would materialise a 256-element array on every dispatch that ends —
   * an allocation per dispatch, on the messaging hot path, to find one row. The
   * module doc promises "no allocation per write beyond the record itself", and
   * this is the only place that promise could be broken.
   */
  findLatest(match: (entry: T) => boolean): T | undefined {
    const held = Math.min(this.written, this.capacity);
    for (let i = 1; i <= held; i += 1) {
      const slot = this.slots[(this.cursor - i + this.capacity) % this.capacity];
      if (slot !== undefined && match(slot)) return slot;
    }
    return undefined;
  }

  /** Forget everything. Test isolation only — nothing in the server calls it. */
  clear(): void {
    this.slots.fill(undefined);
    this.cursor = 0;
    this.written = 0;
  }
}

const dispatches = new Ring<RecentDispatch>(DISPATCH_BUFFER_SIZE);
const refusals = new Ring<RecentRefusal>(DISPATCH_BUFFER_SIZE);

/**
 * Note that a dispatch has started.
 *
 * @param entry - Its id, origin, and whatever ids are known at ingress.
 */
export function recordDispatchStart(entry: {
  dispatchId: string;
  origin: DispatchOrigin;
  roomId?: string;
  sessionId?: string;
}): void {
  dispatches.push({
    dispatchId: entry.dispatchId,
    origin: entry.origin,
    startedAt: new Date().toISOString(),
    endedAt: null,
    outcome: null,
    ...(entry.roomId !== undefined ? { roomId: entry.roomId } : {}),
    ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
  });
}

/**
 * Close out a dispatch that has finished.
 *
 * Mutates the entry in place rather than pushing a second record: one dispatch
 * is one row, and two rows for one dispatch would double the ring's cost for
 * half its span. A dispatch whose start has already been evicted is dropped
 * rather than resurrected as a start-less end.
 *
 * @param dispatchId - The dispatch that ended.
 * @param outcome - How it ended.
 * @param sessionId - The session it settled on, when that is only known now.
 */
export function recordDispatchEnd(
  dispatchId: string,
  outcome: DispatchOutcome,
  sessionId?: string
): void {
  const entry = dispatches.findLatest((d) => d.dispatchId === dispatchId);
  if (!entry) return;
  entry.endedAt = new Date().toISOString();
  entry.outcome = outcome;
  if (sessionId !== undefined) entry.sessionId = sessionId;
}

/**
 * Note one refusal, alongside the log line it already writes.
 *
 * @param refusal - The refusal, as {@link logRefusal} received it.
 * @param context - The dispatch it happened inside, when there is one.
 */
export function recordRefusal(
  refusal: Refusal,
  context?: { dispatchId?: string; origin?: DispatchOrigin }
): void {
  refusals.push({
    at: new Date().toISOString(),
    reason: refusal.reason,
    visibility: refusal.visibility,
    ...(context?.dispatchId !== undefined ? { dispatchId: context.dispatchId } : {}),
    ...(context?.origin !== undefined ? { origin: context.origin } : {}),
    ...(refusal.roomId !== undefined ? { roomId: refusal.roomId } : {}),
    ...(refusal.authorId !== undefined ? { authorId: refusal.authorId } : {}),
    ...(refusal.sessionId !== undefined ? { sessionId: refusal.sessionId } : {}),
    ...(refusal.entryId !== undefined ? { entryId: refusal.entryId } : {}),
  });
}

/**
 * The most recent dispatches, newest first.
 *
 * @param limit - How many to return.
 */
export function recentDispatches(limit = DISPATCH_BUFFER_SIZE): RecentDispatch[] {
  return dispatches.recent(limit);
}

/**
 * The most recent refusals, newest first.
 *
 * @param limit - How many to return.
 */
export function recentRefusals(limit = DISPATCH_BUFFER_SIZE): RecentRefusal[] {
  return refusals.recent(limit);
}

/** Empty both rings. Test isolation only — nothing in the server calls it. */
export function resetDispatchBuffers(): void {
  dispatches.clear();
  refusals.clear();
}
