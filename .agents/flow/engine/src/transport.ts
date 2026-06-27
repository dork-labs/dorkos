/**
 * The **inbound transport seam** (§4; charter B0/G9) — the producer side of the
 * normalized event seam. An {@link InboundTransport} turns a tracker's native
 * inbound signal (a polled inbox, or a pushed webhook) into a stream of
 * {@link TrackerEvent}s. The engine programs against the *interface*, never a
 * concrete producer, so swapping poll → webhook is a config edit
 * (`ingestion.producer`, task 4.4), not a code change — and the consuming
 * reconciler **cannot tell which transport produced an event** (the G9
 * interchangeability invariant, `__tests__/transport.test.ts`).
 *
 * ## v1 ships poll only; webhook is a deferred drop-in
 *
 * {@link PollingTransport} is the v1 producer. The webhook producer is a future
 * drop-in implementing this **same** interface (per the Non-Goals — NOT built
 * here). Because both emit the identical {@link TrackerEvent} envelope, neither
 * the reducer nor any reconciler changes when the webhook lands.
 *
 * ## Package purity — the injected fetch seam
 *
 * `@dorkos/flow` is pure (no fs / network). {@link PollingTransport} therefore
 * does **not** call the tracker itself: it wraps an **injected reader**
 * ({@link InboxReader}) the adapter supplies (the impure `getInbox` lives in the
 * agent/adapter layer, outside this package), plus a durable {@link Watermark}
 * cursor. Everything {@link PollingTransport} does — filter by the watermark, map
 * each entry onto a {@link TrackerEvent}, advance the cursor — is pure
 * transformation. This mirrors the Phase 3 `FlowStateStore` seam: the I/O is
 * injected, the decision logic is pure and server-portable.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §4 (the inbound event seam)
 * @see ./events.ts ({@link TrackerEvent} — the seam's currency — task 4.1)
 * @see .agents/flow/skills/linear-adapter/SKILL.md (`getInbox` — the reader the adapter supplies)
 * @module @dorkos/flow/transport
 */

import type { InboxComment } from './comment-response.js';
import {
  trackerEventDedupeKey,
  type CommentAddedEvent,
  type MentionEvent,
  type TrackerEvent,
} from './events.js';

/**
 * A durable cursor marking the high-water point of consumed events — an opaque
 * string, in v1 the ISO-8601 `occurredAt` of the newest event seen. Durable, not
 * in-memory: persisting it (the run record / `flow-state.json`) keeps the poll
 * stream **gap-free across restarts**. Compared with `>` so a `poll(since)` returns
 * strictly newer events and never re-emits one already consumed.
 */
export type Watermark = string;

/**
 * The result of one {@link InboundTransport.poll}: the fresh events since the
 * given watermark, plus the **advanced** watermark to persist and pass to the next
 * poll. Returning the new watermark (rather than mutating internal state) keeps
 * {@link PollingTransport} pure and the cursor durable at the call site.
 */
export interface PollResult {
  /** The events strictly newer than the `since` watermark, oldest-first. */
  events: TrackerEvent[];
  /**
   * The watermark to persist and pass to the next {@link InboundTransport.poll}.
   * Advanced to the newest consumed `occurredAt`; unchanged from `since` when no
   * fresh events arrived.
   */
  watermark: Watermark;
}

/**
 * The **producer interface** (§4) — the one seam both the poller and the future
 * webhook implement. {@link poll} is the pull model (v1); {@link subscribe} is the
 * optional push model a webhook producer adds. A consumer drives whichever the
 * configured producer offers; the {@link TrackerEvent} stream is identical either
 * way (G9).
 */
export interface InboundTransport {
  /**
   * Pull the events that arrived since `since`, returning them oldest-first plus
   * the advanced {@link Watermark}. Idempotent on the watermark: `poll(w)`
   * immediately after a `poll()` that returned watermark `w` yields no events.
   *
   * @param since - The last persisted watermark, or `undefined` for a cold start
   *   (consume the whole current inbox).
   * @returns The fresh events and the watermark to persist for the next poll.
   */
  poll(since?: Watermark): Promise<PollResult>;
  /**
   * Register a push handler, returning an unsubscribe function. **Optional** — the
   * push model only a webhook producer offers; {@link PollingTransport} omits it.
   * The handler receives the identical {@link TrackerEvent} stream `poll` would.
   *
   * @param handler - Invoked once per pushed event.
   * @returns A function that unregisters the handler.
   */
  subscribe?(handler: (event: TrackerEvent) => void): () => void;
}

/**
 * One inbox entry as the injected {@link InboxReader} yields it — the adapter's
 * `getInbox` row, enriched with the envelope fields the package needs to build a
 * {@link TrackerEvent} ({@link itemId} + {@link occurredAt}) that a bare
 * {@link InboxComment} lacks. The adapter (impure, outside this package) does the
 * tracker query and normalization; {@link PollingTransport} only transforms.
 */
export interface InboxEntry {
  /** The human key of the item the entry is on (the `WorkItem.identifier`). */
  itemId: string;
  /** ISO-8601 timestamp the entry occurred — the watermark axis. */
  occurredAt: string;
  /** The triggering comment (`author`/`mentions`/`body`), the `comment.added` payload. */
  comment: InboxComment;
  /** The account that produced the entry; defaults to the comment author when omitted. */
  actor?: string;
  /** The tracker-native payload, carried opaque onto the event's `raw` field. */
  raw?: unknown;
}

/**
 * The **injected fetch seam** {@link PollingTransport} wraps — the adapter's
 * `getInbox`, returning the current inbox as {@link InboxEntry}s. Arg-less by
 * design: it yields the inbox snapshot, and {@link PollingTransport} applies the
 * watermark filter itself (the pure half). Keeping the I/O here, at the adapter,
 * is what lets `@dorkos/flow` stay free of fs/network.
 */
export type InboxReader = () => Promise<readonly InboxEntry[]>;

/**
 * Map one {@link InboxEntry} onto a {@link TrackerEvent} (always `receivedVia:
 * 'poll'`). A bare @mention notification (a non-empty `mentions` list with an
 * empty body) becomes a {@link MentionEvent}; every other entry — the common case,
 * a real comment — becomes a {@link CommentAddedEvent} carrying the
 * {@link InboxComment}. Pure and deterministic so the poll producer keys and
 * shapes events identically to the future webhook producer.
 */
function entryToEvent(entry: InboxEntry): CommentAddedEvent | MentionEvent {
  const actor = entry.actor ?? entry.comment.author;
  const isBareMention = entry.comment.body.trim().length === 0 && entry.comment.mentions.length > 0;

  if (isBareMention) {
    return {
      kind: 'mention',
      itemId: entry.itemId,
      actor,
      occurredAt: entry.occurredAt,
      receivedVia: 'poll',
      dedupeKey: trackerEventDedupeKey('mention', entry.itemId, entry.occurredAt),
      raw: entry.raw,
      mentioned: entry.comment.mentions[0],
    };
  }

  return {
    kind: 'comment.added',
    itemId: entry.itemId,
    actor,
    occurredAt: entry.occurredAt,
    receivedVia: 'poll',
    dedupeKey: trackerEventDedupeKey('comment.added', entry.itemId, entry.occurredAt),
    raw: entry.raw,
    comment: entry.comment,
  };
}

/**
 * The **v1 polling producer** (§4) — wraps an injected {@link InboxReader} + a
 * durable {@link Watermark} cursor and turns each inbox snapshot into a gap-free
 * delta of {@link TrackerEvent}s. Pure transformation around the injected reader:
 *
 * 1. read the current inbox via the injected {@link InboxReader};
 * 2. keep only entries strictly newer than the `since` watermark (`occurredAt > since`);
 * 3. map each survivor onto a `comment.added` / `mention` event ({@link entryToEvent});
 * 4. advance the watermark to the newest consumed `occurredAt`.
 *
 * Because the watermark is exclusive and advances to the newest entry, a second
 * `poll(watermark)` over the same snapshot returns `[]` — no event is ever
 * re-emitted. Events are **triggers, not truth**: a consumer re-reads each item's
 * current state via the adapter before acting, and dedupes on `dedupeKey` +
 * skip-self-authored (`identity.marker`) so a redelivered event acts at most once.
 *
 * The webhook producer is the deferred drop-in implementing the same
 * {@link InboundTransport} interface (NOT built here — v1 ships poll only).
 */
export class PollingTransport implements InboundTransport {
  /**
   * Construct a polling transport over an injected inbox reader. The reader is the
   * sole I/O dependency; everything the transport does around it is pure.
   *
   * @param read - The injected inbox reader (the adapter's `getInbox`).
   */
  constructor(private readonly read: InboxReader) {}

  /**
   * Poll the injected reader and return the events strictly newer than `since`,
   * oldest-first, plus the advanced watermark. See the class docs for the four
   * steps; idempotent on the watermark (a re-poll at the returned watermark yields
   * no events).
   *
   * @param since - The last persisted watermark, or `undefined` for a cold start.
   * @returns The fresh events (oldest-first) and the watermark to persist.
   */
  async poll(since?: Watermark): Promise<PollResult> {
    const entries = await this.read();

    // Gap-free delta: strictly newer than the cursor (exclusive), oldest-first so
    // the consumer processes events in occurrence order.
    const fresh = entries
      .filter((entry) => since === undefined || entry.occurredAt > since)
      .slice()
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

    const events = fresh.map(entryToEvent);

    // Advance to the newest consumed occurredAt; hold at `since` when nothing new.
    let watermark: Watermark = since ?? '';
    for (const entry of fresh) {
      if (entry.occurredAt > watermark) watermark = entry.occurredAt;
    }

    return { events, watermark };
  }
}
