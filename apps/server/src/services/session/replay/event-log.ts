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
 * @module services/session/replay/event-log
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { EVENT_LOG_MAX_BYTES, eventByteSize } from './event-size-guard.js';

/**
 * Maximum events retained in the log before the oldest are trimmed. Sized well
 * above {@link RING_BUFFER_MAX_EVENTS} so the log spans many turns of replay
 * depth while still bounding per-session memory.
 */
export const EVENT_LOG_MAX_EVENTS = 5000;

/** Ordered, append-only, length-capped log of a single session's events. */
export class EventLog {
  private events: SessionEvent[] = [];

  /** Running byte total of {@link EventLog.events}, kept in step with it. */
  private bytes = 0;

  /**
   * Append an event, trimming the oldest once EITHER cap is exceeded.
   *
   * The byte cap is the one that makes this a real bound: 5000 events is a
   * fixed number of entries and an unbounded number of bytes, which was fine
   * while every event was a sentence and stopped being fine when a message part
   * could stand for an image. Trimming drops the oldest events, which the log
   * can no longer replay — a client that far behind takes a fresh snapshot, the
   * same outcome the count cap already had. See `event-size-guard.ts`.
   */
  append(event: SessionEvent): void {
    this.events.push(event);
    this.bytes += eventByteSize(event);
    if (this.events.length > EVENT_LOG_MAX_EVENTS) {
      this.trim(this.events.length - EVENT_LOG_MAX_EVENTS);
    }
    // Never trims the event just appended — see the same note on `RingBuffer`.
    while (this.bytes > EVENT_LOG_MAX_BYTES && this.events.length > 1) {
      this.trim(1);
    }
  }

  /** Drop the oldest `count` events, keeping the byte total honest. */
  private trim(count: number): void {
    const dropped = this.events.splice(0, count);
    for (const event of dropped) this.bytes -= eventByteSize(event);
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

  /**
   * How many events are retained.
   *
   * Separate from {@link EventLog.all} because the diagnostic read surface wants
   * only the number, and copying up to 5,000 events to call `.length` on the
   * copy is a real cost on a route somebody hits repeatedly during an incident.
   */
  size(): number {
    return this.events.length;
  }
}
