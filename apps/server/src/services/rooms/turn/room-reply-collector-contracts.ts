import type { BlockingInteractionEventType } from '@dorkos/shared/session-stream';
import type { LateRoomReply, RoomTurnWaiting } from '../room-trigger.js';

/** One turn's output, once it has closed one way or another. */
export interface CollectedTurn {
  /** The agent's text, or `null` if it said nothing worth posting. */
  text: string | null;
  /** The turn ended in an error, or was given up on at the ceiling. */
  failed: boolean;
  /** How long the turn took, measured from the moment the room subscribed. */
  waitedMs: number;
}

/** What a subscription to one turn's output is collecting. */
export interface ReplyCollector {
  /**
   * The turn's outcome if it closes within the wait deadline, `null` if the
   * deadline passes first. `null` is not "nothing to say" — it is "not yet".
   */
  beforeDeadline: Promise<CollectedTurn | null>;
  /**
   * The same turn's outcome, whenever it eventually closes. Read only after
   * {@link ReplyCollector.beforeDeadline} resolved `null`; it is the answer
   * that gets posted late.
   */
  afterDeadline: Promise<LateRoomReply>;
  /** Stop collecting — the turn never started. */
  cancel(): void;
}

/**
 * One turn's identity on the durable stream, shared between the trigger that
 * mints it and the collector that reads for it.
 *
 * `null` until the turn actually opens, and a collector treats `null` as "not
 * mine" rather than waiting — see where it is constructed.
 */
export interface OwnTurn {
  /** The `seq` of this turn's `turn_start`, or `null` before it has one. */
  startSeq: number | null;
}

/** Original private collector classification DATA, available only through the root-owned selector. */
export interface RoomTurnReplyView {
  readonly messageBoundary: Set<string>;
  readonly waitingKinds: Record<BlockingInteractionEventType, RoomTurnWaiting['kind']>;
}
