/**
 * The two streams a room fans out on — its own SSE stream for entries,
 * reactions and ephemeral signals, and the global `/api/events` stream for
 * activity — plus the two after-the-fact listeners the chat bridge registers.
 *
 * Everything here runs AFTER a write is durable, and nothing here may fail one.
 * A broadcast is never rolled back, a bridge delivery must never stall a
 * commit, and the message index is a derived copy of a log that is already the
 * truth — so each hook is guarded and each failure is a warning.
 *
 * @module server/services/rooms/service/room-publisher
 */
import type {
  RoomAttachment,
  RoomEntry,
  RoomPresencePayload,
  RoomSignalView,
} from '@dorkos/shared/room-schemas';
import { withoutActivityTarget } from '@dorkos/shared/room-schemas';
import type { SignalType } from '@dorkos/shared/relay-schemas';
import { logger } from '../../../lib/logger.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import type { ReactionStore } from '../reactions/reaction-store.js';
import type { RoomCore } from './room-core.js';
import type { RoomEntryIndexer } from './room-service-deps.js';
import type { RoomBroadcaster } from '../room-stream.js';

/**
 * The chat bridge's presence forwarder (chats-as-channels §6.8), called for
 * every ephemeral signal a room fans out.
 */
export type RoomSignalListener = (
  roomId: string,
  signal: SignalType,
  authorId: string,
  presence?: Partial<RoomPresencePayload>
) => void;

/** Everything a room says to its readers once a write is already durable. */
export class RoomPublisher {
  private readonly broadcaster: RoomBroadcaster;
  private readonly reactions: ReactionStore;
  /** Entries out, the moment they are committed. The message index's port. */
  private readonly indexEntry: RoomEntryIndexer;
  /**
   * Called synchronously after every committed entry — the chat bridge's
   * inline-delivery fast path (chats-as-channels §6.1). Registered after
   * construction (the delivery engine is built later, in the binding subsystem)
   * and unset by default, so an install with no bridge pays nothing here. It
   * must never throw into the commit; the bridge's own handler swallows its
   * errors, and this call site does too.
   */
  private onEntryCommitted?: (entry: RoomEntry) => void;
  /**
   * Called synchronously after every published ephemeral signal — the chat
   * bridge's presence forwarder (chats-as-channels §6.8). Registered after
   * construction, same as {@link RoomPublisher.onEntryCommitted}, and unset by
   * default, so an install with no bridge pays nothing here. It must never
   * throw into the publish; {@link RoomService.publishSignal} guards the call
   * the same way {@link RoomPublisher.publishEntry} guards its own listener.
   */
  private onSignalPublished?: RoomSignalListener;

  constructor(core: RoomCore) {
    this.broadcaster = core.broadcaster;
    this.reactions = core.reactions;
    this.indexEntry = core.indexEntry;
  }

  /** Fan one entry's whole current reaction set out to the room's readers. */
  publishReactions(roomId: string, entryId: string): void {
    this.broadcaster.publish(roomId, {
      type: 'reaction',
      entryId,
      reactions: this.reactions.listForEntry(roomId, entryId),
    });
  }

  /**
   * Register the chat bridge's inline-delivery hook (chats-as-channels §6.1),
   * called for every committed entry. At most one is set; the binding subsystem
   * wires it once the delivery engine exists.
   *
   * @param listener - Called with each committed entry, or `undefined` to clear.
   */
  setEntryCommitListener(listener: ((entry: RoomEntry) => void) | undefined): void {
    this.onEntryCommitted = listener;
  }

  /**
   * Publish a committed entry to the room's readers and bump global activity.
   *
   * @param entry - The committed entry.
   * @param attachments - The files bound to it in the same transaction. Unlike
   *   a reaction, an attachment EXISTS at the instant the entry does, so this
   *   path carries the real refs rather than an empty list — a reader who saw
   *   the live frame and a reader who hydrated a moment later must see the same
   *   message.
   */
  publishEntry(entry: RoomEntry, attachments: RoomAttachment[] = []): void {
    // `reactions: []` rather than omitted: an entry a millisecond old genuinely
    // has none, and a reader that had to treat "absent" and "empty" as the same
    // thing on the live path but not on the others would have two rules.
    this.broadcaster.publish(entry.roomId, {
      type: 'entry',
      seq: entry.seq,
      entry: { ...entry, reactions: [], attachments },
    });
    eventFanOut.broadcast('room_activity', {
      roomId: entry.roomId,
      seq: entry.seq,
      lastActivityAt: entry.createdAt,
    });
    // The bridge's inline fast path (chats-as-channels §6.1). Deliberately AFTER
    // the broadcast and fan-out, and guarded, so a bridge delivery can never
    // fail a commit or stall the room's own readers. The listener itself is
    // fire-and-forget; this guard is only for a synchronous throw building it.
    if (this.onEntryCommitted) {
      try {
        this.onEntryCommitted(entry);
      } catch (err) {
        logger.warn('[rooms] entry-commit listener threw', {
          roomId: entry.roomId,
          entryId: entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // LAST, and guarded twice (message-search spec Amendment 6). The message
    // index is a derived copy of this log, so it is the least important thing
    // this write does and the only one that may be skipped: everyone waiting on
    // this entry already has it, and a failure here costs at most the five
    // minutes until the reconciler reads the same rows. The port promises not to
    // throw; this catch is what keeps the promise true for whatever gets wired
    // in next, because a post that fails because a SEARCH INDEX could not be
    // updated is the exact inversion of "the log is the truth".
    try {
      this.indexEntry({ roomId: entry.roomId, seq: entry.seq });
    } catch (err) {
      logger.warn('[rooms] message-index write-through threw', {
        roomId: entry.roomId,
        entryId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Deliver an ephemeral signal — typing, presence, a receipt. Live only: it
   * never enters the log and is dropped on replay, because a room's record is
   * what another member should be able to read later.
   *
   * @param roomId - The room.
   * @param signal - The signal type, from the relay's shared vocabulary.
   * @param authorId - Who the signal is about.
   * @param presence - The working lifecycle, on a `'progress'` signal. Every
   *   publish carries the whole of it, `since` included: an ephemeral event is
   *   never replayed, so it has to be renderable by a client that connected in
   *   the middle of the work.
   *
   *   Typed as a PARTIAL here and as a whole {@link RoomPresencePayload} at the
   *   dispatcher's `publishPresence` dep, because the two producers have
   *   different floors. The dispatcher owns the claim map, so it always knows
   *   all three and is held to all three. `LocalCommunityAdapter` publishes on
   *   behalf of a `CommunityAdapter` caller, whose payload is optional field by
   *   field (a remote backend may only be able to say that somebody is working)
   *   — and inventing an `entryId` to satisfy a required type would be a worse
   *   answer than carrying less.
   */
  publishSignal(
    roomId: string,
    signal: SignalType,
    authorId: string,
    presence?: Partial<RoomPresencePayload>
  ): void {
    this.broadcaster.publish(roomId, {
      type: 'signal',
      signal,
      authorId,
      at: new Date().toISOString(),
      ...presence,
    });
    // The bridge's presence forwarder (chats-as-channels §6.8). Deliberately
    // AFTER the broadcast, and guarded, so a bridge with nothing to forward to
    // (or a forwarder that throws) can never fail the room's own signal —
    // same shape as `publishEntry`'s guard around `onEntryCommitted`.
    if (this.onSignalPublished) {
      try {
        // The verb travels; the target does not. A bridged chat is other
        // people's surface, and the room's own durable waiting notice already
        // refuses to put "file paths and commands included" in front of
        // everybody else (ADR 260819-022127). The broadcast above is untouched:
        // that one IS this operator's cockpit.
        this.onSignalPublished(
          roomId,
          signal,
          authorId,
          presence && withoutActivityTarget(presence)
        );
      } catch (err) {
        logger.warn('[rooms] signal listener threw', {
          roomId,
          signal,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Tell a room that somebody has started — or stopped — following a member
   * (spec `canvas-agent-seat` §6).
   *
   * **A `presence` signal, because that is the member that already means "where
   * this person is".** `specs/rooms/02-specification.md:229` forbids minting a
   * new signal name, and follow mode keeps that rule the way room presence kept
   * it before: the payload discriminates, not the verb.
   *
   * The frame goes to the room's own readers and **not** to
   * {@link RoomPublisher.setSignalListener}'s bridge forwarder. A bridged
   * Telegram or Slack chat is other people's surface, and "Ana is following Kai"
   * describes a panel in this app that nobody over there has.
   *
   * @param roomId - The room.
   * @param followerId - The person following.
   * @param leaderId - Who they are following, or `null` when they have stopped.
   */
  publishFollowClaim(roomId: string, followerId: string, leaderId: string | null): void {
    this.broadcaster.publish(roomId, {
      type: 'signal',
      signal: 'presence',
      authorId: followerId,
      at: new Date().toISOString(),
      follows: leaderId,
    });
  }

  /**
   * Fan out where a followed person is looking (spec `canvas-agent-seat` §6).
   *
   * Published only while somebody is following them — {@link RoomFollowService}
   * is what decides that, and this method is what carries it. Like every other
   * signal it is live only: never logged, never replayed, and gone the moment
   * nobody is reading.
   *
   * Off the bridge forwarder for the same reason the claim is: a scroll offset
   * in this app's panel is not something to say in somebody's Telegram.
   *
   * @param roomId - The room.
   * @param leaderId - The person whose view this is.
   * @param view - The document, page and scroll offset they are on.
   */
  publishFollowView(roomId: string, leaderId: string, view: RoomSignalView): void {
    this.broadcaster.publish(roomId, {
      type: 'signal',
      signal: 'presence',
      authorId: leaderId,
      at: new Date().toISOString(),
      view,
    });
  }

  /**
   * Register the chat bridge's presence forwarder (chats-as-channels §6.8),
   * called for every ephemeral signal this service fans out. At most one is
   * set; the binding subsystem wires it once the bridge presence forwarder
   * exists — the same one-listener shape as
   * {@link RoomService.setEntryCommitListener}.
   *
   * @param listener - Called with each published signal, or `undefined` to clear.
   */
  setSignalListener(listener: RoomSignalListener | undefined): void {
    this.onSignalPublished = listener;
  }
}
