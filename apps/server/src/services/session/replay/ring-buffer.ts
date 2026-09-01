/**
 * Bounded ring of the current turn's session events.
 *
 * Backs the snapshot-then-replay contract (ADR-0264): a client that drops its
 * connection mid-turn — or hard-refreshes moments after a turn completes —
 * replays the missed events from this buffer rather than re-reading history.
 * The buffer holds ONLY the current turn; completed turns belong to the
 * unbounded {@link EventLog}. After a turn ends the events linger for a TTL so a
 * race between `turn_end` and a refresh still resolves, then they are evicted.
 *
 * @module services/session/replay/ring-buffer
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { RING_BUFFER_MAX_BYTES, eventByteSize } from './event-size-guard.js';

/**
 * Hard cap on events retained for a single turn. Bounds per-session memory under
 * a pathologically long turn (Performance Considerations, ADR-0264). When
 * exceeded, the oldest events are dropped — a client that fell that far behind
 * falls back to the {@link EventLog} / a fresh snapshot rather than gap-replay.
 */
export const RING_BUFFER_MAX_EVENTS = 200;

/**
 * How long a completed turn's events are retained after `turn_end` before
 * eviction. Absorbs the hard-refresh-just-after-completion race: the client
 * reconnects, fetches a snapshot whose cursor predates `turn_end`, and replays
 * the tail. Ten minutes mirrors {@link SESSIONS.INTERACTION_TIMEOUT_MS}.
 */
export const RING_BUFFER_TTL_MS = 10 * 60 * 1000;

/**
 * In-memory ring of the current turn's {@link SessionEvent}s.
 *
 * Eviction is LAZY (swept on access) rather than timer-driven: a per-session
 * `setTimeout` would keep the event loop alive and leak if a projector were
 * dropped without cleanup, whereas a lazy sweep has zero idle cost and is
 * trivially deterministic under fake timers. The cost — events linger in memory
 * until the next access past the TTL — is bounded by {@link RING_BUFFER_MAX_EVENTS}.
 */
export class RingBuffer {
  private events: SessionEvent[] = [];

  /**
   * Epoch ms when the current turn ended, or `null` while a turn is in progress
   * (or no turn has run). Drives the lazy TTL sweep.
   */
  private endedAt: number | null = null;

  /** Running byte total of {@link RingBuffer.events}, kept in step with it. */
  private bytes = 0;

  /**
   * Append an event to the current turn, dropping the oldest past EITHER cap.
   *
   * Two caps, because a count alone stopped being a bound once a message part
   * could stand for an image: two hundred events is a fixed number of entries
   * and an unbounded number of bytes. Whichever cap bites first wins, and both
   * have the same, already-defined consequence — a client that fell past the
   * ring replays from the {@link EventLog}, and one past that takes a fresh
   * snapshot. See `event-size-guard.ts` for the budget and its reasoning.
   */
  append(event: SessionEvent): void {
    this.sweepIfExpired();
    this.events.push(event);
    this.bytes += eventByteSize(event);
    if (this.events.length > RING_BUFFER_MAX_EVENTS) {
      this.evict(this.events.length - RING_BUFFER_MAX_EVENTS);
    }
    // Never evicts the event just appended: a single event past the whole
    // budget is still delivered, because dropping the only copy of what just
    // happened is worse than briefly exceeding a memory target — and the string
    // guard has already bounded how far past it can be.
    while (this.bytes > RING_BUFFER_MAX_BYTES && this.events.length > 1) {
      this.evict(1);
    }
  }

  /** Drop the oldest `count` events, keeping the byte total honest. */
  private evict(count: number): void {
    const dropped = this.events.splice(0, count);
    for (const event of dropped) this.bytes -= eventByteSize(event);
  }

  /** Begin a new turn: clear any retained (possibly expired) prior-turn events. */
  markTurnStarted(): void {
    this.events = [];
    this.bytes = 0;
    this.endedAt = null;
  }

  /** Mark the turn complete, starting the TTL retention window. */
  markTurnEnded(): void {
    this.endedAt = Date.now();
  }

  /**
   * Return retained events with `seq` strictly greater than `sinceCursor`.
   * Exclusive on the cursor so replay and live delivery overlap without dups.
   *
   * @param sinceCursor - Resume point; only events with a greater seq are returned.
   */
  replayFrom(sinceCursor: number): SessionEvent[] {
    this.sweepIfExpired();
    return this.events.filter((e) => e.seq > sinceCursor);
  }

  /**
   * How many events the ring currently holds, WITHOUT sweeping.
   *
   * Deliberately not `replayFrom(0).length`: that materialises the array and,
   * worse, runs the lazy TTL sweep — a mutation. The diagnostic read surface is
   * the one caller here, and a read that changes what the next read sees is a
   * read that cannot be trusted mid-incident. The count may therefore include
   * events an expired turn still holds, which is the honest answer to "what is
   * in memory right now".
   */
  size(): number {
    return this.events.length;
  }

  /** Evict retained events once the post-`turn_end` TTL has elapsed. */
  private sweepIfExpired(): void {
    if (this.endedAt !== null && Date.now() - this.endedAt >= RING_BUFFER_TTL_MS) {
      this.events = [];
      this.bytes = 0;
      this.endedAt = null;
    }
  }
}
