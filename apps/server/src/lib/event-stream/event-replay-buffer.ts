/**
 * Numbering and replay for a stream of `DorkOsEvent`s (ADR 261123-170833).
 *
 * Written for `GET /api/events`, and kept free of that stream's delivery so the
 * next one (a run's events, spec `send-to-an-agent` D9) numbers and replays the
 * same way. It owns three things:
 *
 * - **`seq`.** One counter per buffer, so per stream. It only grows; gaps are
 *   the reader's view of events that were not theirs.
 * - **The frame id.** `<resourceId>-<epoch>-<generation>-<seq>`, written by
 *   `streamFrameId`, the same writer the chat and room streams use, and read
 *   back by `parseResumeCursor`. The generation is minted per buffer, so a
 *   cursor from another buffer (a restart, or a test's fresh one) never reads
 *   as a place in this numbering.
 * - **The bounded window.** The last {@link EVENT_REPLAY_LIMITS} events. A
 *   cursor inside it replays the gap; anything else (a cursor older than the
 *   window, ahead of the counter, from another generation or process, or no
 *   cursor) is answered with a snapshot instead, the way the chat stream falls
 *   back when its replay floor has moved past a cursor.
 *
 * Each entry carries a `delivery` the owning stream defines (for the global
 * stream: the encoded frames and who may read them), and nothing else: no
 * second copy of the payload. Replay filters with the rights the reader has
 * when it resumes, which can differ from its rights when the event was sent.
 *
 * An event bigger than the whole byte budget is delivered live and not kept,
 * and it empties the window: keeping the older events would leave a gap where
 * it was, so any cursor before it gets a snapshot.
 *
 * @module lib/event-stream/event-replay-buffer
 */
import { mintStreamGeneration } from '@dorkos/shared/session-stream';
import type { DorkOsEventType } from '@dorkos/shared/dorkos-events';
import { cursorMatchesGeneration, streamFrameId, type ResumeCursor } from '../stream-cursor.js';

/**
 * How much a replay buffer keeps. Whichever cap bites first evicts the oldest.
 *
 * The byte cap sits under the fan-out's per-reader ceiling
 * (`SSE.MAX_BUFFERED_BYTES`, 1 MiB), so replaying the whole window to a reader
 * cannot by itself get that reader dropped as too slow.
 */
export const EVENT_REPLAY_LIMITS = {
  /** Events kept. */
  maxEvents: 500,
  /** Encoded bytes kept. */
  maxBytes: 512 * 1024,
} as const;

/** One numbered event and what its stream needs to deliver it again. */
export interface ReplayEntry<D> {
  /** The event's place in this stream. */
  readonly seq: number;
  /** The event type. */
  readonly type: DorkOsEventType;
  /** Its frame id, the resume cursor a reader echoes back. */
  readonly frameId: string;
  /** The stream's own delivery record. */
  readonly delivery: D;
  /** Bytes the delivery holds, counted against {@link EVENT_REPLAY_LIMITS.maxBytes}. */
  readonly bytes: number;
}

/** What a reconnecting reader gets: the gap, or a snapshot because the gap is lost. */
export type ResumeAnswer<D> =
  | { readonly kind: 'replay'; readonly entries: readonly ReplayEntry<D>[] }
  | { readonly kind: 'snapshot' };

/** A stream's numbering and its bounded replay window. */
export class EventReplayBuffer<D> {
  /** This buffer's seq space, carried in every frame id. */
  readonly generation = mintStreamGeneration();
  private counter = 0;
  private entries: ReplayEntry<D>[] = [];
  private bytes = 0;

  /**
   * Start an empty window with a fresh generation.
   *
   * @param resourceId - The first part of every frame id (`events` for the
   *   global stream); `parseResumeCursor` refuses a cursor naming another.
   * @param limits - The window's caps.
   */
  constructor(
    readonly resourceId: string,
    private readonly limits: { maxEvents: number; maxBytes: number } = EVENT_REPLAY_LIMITS
  ) {}

  /** The last `seq` handed out; 0 before the first. */
  get latestSeq(): number {
    return this.counter;
  }

  /**
   * Number one event and keep it, evicting the oldest past either cap. An
   * event over the whole byte budget is not kept and empties the window (see
   * the module doc).
   *
   * @param type - The event type.
   * @param deliver - Builds the delivery record from the event's frame id and
   *   `seq`.
   * @param measure - The bytes the delivery holds.
   * @returns The numbered entry, for the live write.
   */
  append(
    type: DorkOsEventType,
    deliver: (frameId: string, seq: number) => D,
    measure: (delivery: D) => number
  ): ReplayEntry<D> {
    const seq = ++this.counter;
    const frameId = streamFrameId(this.resourceId, this.generation, seq);
    const delivery = deliver(frameId, seq);
    const entry: ReplayEntry<D> = { seq, type, frameId, delivery, bytes: measure(delivery) };
    if (entry.bytes > this.limits.maxBytes) {
      this.entries = [];
      this.bytes = 0;
      return entry;
    }
    this.entries.push(entry);
    this.bytes += entry.bytes;
    while (this.entries.length > this.limits.maxEvents || this.bytes > this.limits.maxBytes) {
      this.bytes -= this.entries.shift()!.bytes;
    }
    return entry;
  }

  /** Bytes the window holds now. */
  get heldBytes(): number {
    return this.bytes;
  }

  /**
   * Decide what a connecting reader gets.
   *
   * A `null` generation (a bare integer that names no seq space) is refused
   * here, unlike `cursorMatchesGeneration` alone: this stream documents only
   * the whole frame id as its cursor.
   *
   * @param cursor - What `parseResumeCursor` read off the request, if anything.
   */
  resume(cursor: ResumeCursor | undefined): ResumeAnswer<D> {
    if (!cursor || cursor.generation === null) return { kind: 'snapshot' };
    if (!cursorMatchesGeneration(cursor, this.generation)) return { kind: 'snapshot' };
    // Ahead of the counter: not a place this numbering has been.
    if (cursor.seq > this.counter) return { kind: 'snapshot' };
    if (cursor.seq === this.counter) return { kind: 'replay', entries: [] };
    const earliest = this.entries[0]?.seq;
    // Part of the gap was evicted: replaying the rest would silently skip it.
    if (earliest === undefined || cursor.seq < earliest - 1) return { kind: 'snapshot' };
    return { kind: 'replay', entries: this.entries.filter((e) => e.seq > cursor.seq) };
  }
}
