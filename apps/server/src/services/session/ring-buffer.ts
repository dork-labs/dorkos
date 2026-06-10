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
 * @module services/session/ring-buffer
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';

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

  /** Append an event to the current turn, dropping the oldest past the cap. */
  append(event: SessionEvent): void {
    this.sweepIfExpired();
    this.events.push(event);
    if (this.events.length > RING_BUFFER_MAX_EVENTS) {
      this.events.splice(0, this.events.length - RING_BUFFER_MAX_EVENTS);
    }
  }

  /** Begin a new turn: clear any retained (possibly expired) prior-turn events. */
  markTurnStarted(): void {
    this.events = [];
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

  /** Evict retained events once the post-`turn_end` TTL has elapsed. */
  private sweepIfExpired(): void {
    if (this.endedAt !== null && Date.now() - this.endedAt >= RING_BUFFER_TTL_MS) {
      this.events = [];
      this.endedAt = null;
    }
  }
}
