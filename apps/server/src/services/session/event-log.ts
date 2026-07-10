/**
 * In-process, append-only ordered log of a session's events.
 *
 * Two roles in the snapshot-then-replay contract (ADR-0264):
 *   1. Completed-turn history source for stateless runtimes (the DorkOS
 *      log-backed adapter, task #15) that have no JSONL to read back. The Claude
 *      adapter ignores this for history — it loads from JSONL — and uses the log
 *      only for gap-replay overflow.
 *   2. Gap-replay fallback when a resume cursor predates the {@link RingBuffer}'s
 *      eviction horizon: the ring holds only the current turn, so a deep resume
 *      reads from here instead.
 *
 * Trimmed (not strictly unbounded) so a long-lived session cannot grow memory
 * without limit; trimming drops the oldest events, which the ring/log can no
 * longer replay — such a client falls back to a fresh snapshot.
 *
 * @module services/session/event-log
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';

/**
 * Maximum events retained in the log before the oldest are trimmed. Sized well
 * above {@link RING_BUFFER_MAX_EVENTS} so the log spans many turns of replay
 * depth while still bounding per-session memory.
 */
export const EVENT_LOG_MAX_EVENTS = 5000;

/** Ordered, append-only, length-capped log of a single session's events. */
export class EventLog {
  private events: SessionEvent[] = [];

  /** Append an event, trimming the oldest once the cap is exceeded. */
  append(event: SessionEvent): void {
    this.events.push(event);
    if (this.events.length > EVENT_LOG_MAX_EVENTS) {
      this.events.splice(0, this.events.length - EVENT_LOG_MAX_EVENTS);
    }
  }

  /**
   * Seed the log from a durable event stream on projector hydration (DOR-189).
   * The events already carry their persisted `seq`, so they are appended as-is
   * (never re-stamped) and the same cap/trim applies. Called only on a FRESH
   * projector (empty log) whose persistence is enabled, so it never interleaves
   * with live events.
   *
   * @param events - Persisted events in seq order (from `SessionEventStore.readAll`).
   */
  hydrate(events: SessionEvent[]): void {
    for (const event of events) this.append(event);
  }

  /**
   * Return events with `seq` strictly greater than `sinceCursor`. Exclusive on
   * the cursor so replay and live delivery overlap without duplicates.
   *
   * @param sinceCursor - Resume point; only events with a greater seq are returned.
   */
  replayFrom(sinceCursor: number): SessionEvent[] {
    return this.events.filter((e) => e.seq > sinceCursor);
  }

  /**
   * The `seq` of the oldest event still retained, or `undefined` when empty.
   * The replay floor: a resume cursor below `earliestSeq() - 1` has a gap this
   * log can no longer serve (trimming dropped the events).
   */
  earliestSeq(): number | undefined {
    return this.events[0]?.seq;
  }

  /** Snapshot of all retained events in append order. */
  all(): SessionEvent[] {
    return [...this.events];
  }
}
