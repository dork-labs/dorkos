/**
 * The **normalized inbound event seam** (§4; charter B0/G9) — the one typed
 * currency every inbound signal the `/flow` engine reacts to is expressed in,
 * regardless of how it arrived. A poller and a webhook both produce the *same*
 * {@link TrackerEvent} stream, so the engine downstream **cannot tell which
 * transport produced an event** (the G9 interchangeability invariant, pinned by
 * `__tests__/transport.test.ts`).
 *
 * ## Events are TRIGGERS, not truth
 *
 * A {@link TrackerEvent} says "*something changed on this item*", never "*this is
 * the item's current state*". The consuming reconciler **re-reads the item's
 * current state via the adapter (the `PMClient`) before acting** — the event only
 * tells it *which* item to look at. Two properties keep that idempotent across a
 * redelivered or double-polled event:
 *
 * - **{@link TrackerEventBase.dedupeKey}** — a stable key (`kind:itemId:occurredAt`,
 *   see {@link trackerEventDedupeKey}) so a consumer drops a duplicate it already
 *   processed.
 * - **skip-self-authored** — a `comment.added` carrying the agent's own
 *   `identity.marker` is the agent's own write; the comment-response rules
 *   (`shouldRespondToComment`, rule 1) ignore it so the loop never reacts to
 *   itself.
 *
 * ## The variant set (v1)
 *
 * The union closes over six `kind`s. The existing {@link InboxComment} becomes the
 * payload of {@link CommentAddedEvent} (the `comment` field); each other variant
 * carries exactly the payload its branch acts on (a mentioned account, a
 * from/to state category, the new assignee). The transport layer
 * (`transport.ts`) maps a tracker's native inbox/webhook payload onto these; the
 * reconciler layer (`reconcilers.ts`) consumes them. No tracker-native field name
 * crosses this seam — the adapter owns that mapping.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §4 (the inbound event seam)
 * @see ./transport.ts (the `InboundTransport` / `PollingTransport` producers — task 4.2)
 * @see ./comment-response.ts ({@link InboxComment} — the `comment.added` payload)
 * @module @dorkos/flow/events
 */

import type { InboxComment } from './comment-response.js';
import type { StateCategory } from './work-item.js';

/**
 * The closed set of inbound event kinds (§4). The discriminant of
 * {@link TrackerEvent}: every variant narrows on its `kind`.
 *
 * - `comment.added` — a comment landed on an item (carries the {@link InboxComment}).
 * - `item.readied` — an item crossed into the `agent/ready` disposition.
 * - `item.assigned` — an item's assignee changed (carries the new assignee).
 * - `item.state-changed` — an item moved workflow state (carries from/to category).
 * - `mention` — the agent account was @mentioned (carries the mentioned account).
 * - `item.created` — a new item appeared.
 */
export type TrackerEventKind =
  | 'comment.added'
  | 'item.readied'
  | 'item.assigned'
  | 'item.state-changed'
  | 'mention'
  | 'item.created';

/**
 * How an event reached the engine — the **provenance** field. The G9 invariant is
 * that no consumer ever branches on this: it exists for audit/telemetry only, so a
 * `poll`-produced and a `webhook`-produced event with otherwise-identical fields
 * drive identical downstream behavior. `webhook` is the deferred drop-in producer;
 * v1 only ever emits `poll`.
 */
export type ReceivedVia = 'poll' | 'webhook';

/**
 * The common envelope every {@link TrackerEvent} carries (§4). The discriminated
 * variants extend this with their `kind` literal + payload; these fields are
 * uniform across the union so a consumer can dedupe, order, and audit any event
 * without narrowing first.
 */
export interface TrackerEventBase {
  /** The variant discriminant (narrow the union on this). */
  kind: TrackerEventKind;
  /**
   * The human key of the item the event is about (e.g. `"DOR-123"`) — the
   * `WorkItem.identifier`. The consumer re-reads this item's CURRENT state via the
   * adapter before acting (events are triggers, not truth).
   */
  itemId: string;
  /**
   * The account that produced the event (the comment author, the assigner, the
   * account that changed state). Compared against `identity.agent` / the
   * `identity.marker` to skip the agent's own writes.
   */
  actor: string;
  /** ISO-8601 timestamp the event occurred on the tracker — the watermark axis. */
  occurredAt: string;
  /** How the event reached the engine. Audit-only; **never** branched on (G9). */
  receivedVia: ReceivedVia;
  /**
   * A stable idempotency key (`kind:itemId:occurredAt`, see
   * {@link trackerEventDedupeKey}). A consumer drops an event whose `dedupeKey` it
   * already processed, so a redelivered or double-polled event acts at most once.
   */
  dedupeKey: string;
  /**
   * The tracker-native payload the adapter mapped this event from, carried opaque
   * for audit and for fields the generic layer does not model. The generic layer
   * never reads `raw`; only the adapter does.
   */
  raw: unknown;
}

/**
 * A comment landed on an item (§4, §5). The inbound half of the comms channel:
 * carries the existing {@link InboxComment} (`author`/`mentions`/`body`) as its
 * payload so the comment-response rules (`shouldRespondToComment`) can decide
 * respond / resume / ignore. The load-bearing variant — the `agent/needs-input`
 * resume (rule 3) rides on this.
 */
export interface CommentAddedEvent extends TrackerEventBase {
  /** Discriminant. */
  kind: 'comment.added';
  /** The comment that landed (the adapter's `getInbox` comment shape). */
  comment: InboxComment;
}

/**
 * An item crossed into the `agent/ready` disposition (§4) — fresh dispatch fuel.
 * Carries no payload beyond the envelope: the dispatch reconciler re-reads the
 * item's current eligibility via the adapter, so the event is a pure "look at this
 * item" trigger.
 */
export interface ItemReadiedEvent extends TrackerEventBase {
  /** Discriminant. */
  kind: 'item.readied';
}

/**
 * An item's assignee changed (§4). Carries the new assignee account so a consumer
 * can re-derive ownership (`classifyOwnership`) without an extra read, while still
 * re-reading the item before acting.
 */
export interface ItemAssignedEvent extends TrackerEventBase {
  /** Discriminant. */
  kind: 'item.assigned';
  /** The new assignee account id, or `null` when the item was unassigned. */
  assignee: string | null;
}

/**
 * An item moved workflow state (§4). Carries the from/to **categories** (never the
 * team-customizable display names) so a consumer can react to a started→completed
 * transition (e.g. a finished item leaving the gate) by category.
 */
export interface ItemStateChangedEvent extends TrackerEventBase {
  /** Discriminant. */
  kind: 'item.state-changed';
  /** The workflow-state category the item moved FROM. */
  from: StateCategory;
  /** The workflow-state category the item moved TO. */
  to: StateCategory;
}

/**
 * The agent account was @mentioned on an item (§4, §5). Carries the mentioned
 * account so a consumer can confirm it is the agent being addressed (rule 2,
 * "directly addressed"). Distinct from {@link CommentAddedEvent}: a bare mention
 * notification need not carry a comment body.
 */
export interface MentionEvent extends TrackerEventBase {
  /** Discriminant. */
  kind: 'mention';
  /** The mentioned account id (the addressed party — the agent in v1). */
  mentioned: string;
}

/**
 * A new item appeared on the board (§4) — a triage trigger. Carries no payload
 * beyond the envelope: the triage reconciler re-reads the item to classify and
 * route it.
 */
export interface ItemCreatedEvent extends TrackerEventBase {
  /** Discriminant. */
  kind: 'item.created';
}

/**
 * The **normalized inbound event** (§4) — a discriminated union over `kind`. Every
 * inbound signal the engine reacts to, regardless of transport, is one of these.
 * Narrow on `kind` to reach a variant's payload; the {@link TrackerEventBase}
 * envelope fields are available without narrowing.
 */
export type TrackerEvent =
  | CommentAddedEvent
  | ItemReadiedEvent
  | ItemAssignedEvent
  | ItemStateChangedEvent
  | MentionEvent
  | ItemCreatedEvent;

/**
 * Build the stable {@link TrackerEventBase.dedupeKey} for an event from its
 * `kind`, `itemId`, and `occurredAt`. The convention is `kind:itemId:occurredAt`
 * — stable across redelivery of the *same* event (a poll re-read or a webhook
 * retry), distinct across different events, so a consumer can dedupe with a plain
 * string set. Centralized here so the poll and webhook producers key identically
 * (the G9 invariant depends on it).
 *
 * @param kind - The event's discriminant.
 * @param itemId - The item's human key the event is about.
 * @param occurredAt - The ISO-8601 timestamp the event occurred.
 * @returns The `kind:itemId:occurredAt` dedupe key.
 */
export function trackerEventDedupeKey(
  kind: TrackerEventKind,
  itemId: string,
  occurredAt: string
): string {
  return `${kind}:${itemId}:${occurredAt}`;
}
