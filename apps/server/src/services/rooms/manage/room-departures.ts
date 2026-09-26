/**
 * An agent leaving your team, and coming back (DOR-2095).
 *
 * **Membership is live state; history is archive.** A channel roster is the
 * trust surface — "who will read this before I post it" — so an agent nobody
 * answers for any more comes off every channel. Its messages stay, and read as
 * retired through `RoomWithRoster.formerAuthors`. A direct message keeps it,
 * because a DM is named by who is in it (`DepartedSeatStore.removeFromChannels`
 * says why), and the member there reads as retired instead.
 *
 * **Leaving is recoverable.** The reconciler unregisters an agent whose folder
 * has been unreachable for 24 hours — a drive away for a weekend — and that
 * agent comes back with the same manifest. So every seat taken is written to a
 * tombstone in the same transaction, and given back when an agent with the same
 * manifest id answers for the author again.
 *
 * @module server/services/rooms/manage/room-departures
 */
import { eventFanOut } from '../../core/event-fan-out.js';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import { isLiveAuthor } from '../handles/author-handles.js';
import type { RoomAgentLookup } from '../room-errors.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';
import type { RoomCore } from '../service/room-core.js';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../room-errors.js';
import type { ChannelSeat } from './departed-seat-store.js';
import type { RoomMembership } from './room-membership.js';

/** What taking departed agents out of their channels changed. */
export interface DepartedAgentsDrop {
  /** The authors that failed the liveness check and were taken out. */
  authorIds: string[];
  /** Every channel seat they lost. */
  removed: ChannelSeat[];
}

/** Agents leaving the rooms they were in, and returning to them. */
export class RoomDepartures {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  /** Which agent occupies a directory right now — the liveness question. */
  private readonly agents: RoomAgentLookup;
  private readonly triggers: RoomTriggerDispatcher;

  constructor(
    core: RoomCore,
    /** The join rules every door into a room shares. */
    private readonly membership: Pick<RoomMembership, 'requireJoinAllowed'>
  ) {
    this.store = core.store;
    this.authors = core.authors;
    this.agents = core.agents;
    this.triggers = core.triggers;
  }

  /**
   * Take agents nobody answers for any more out of every channel, in one
   * transaction that also records each seat for a possible return.
   *
   * **Liveness is asked again here, whoever called.** Only an author that
   * {@link isLiveAuthor} fails is touched: an agent still registered — an
   * `unreachable` one on a sleeping laptop included — keeps every seat, however
   * the caller came to name it. That makes the method safe to call twice, and
   * makes a stale sweep unable to take out an agent that was re-registered in
   * the meantime.
   *
   * No refusal from `RoomMembership.removeMemberFrom` applies: each protects the
   * owner's seat or a person's choice to leave, and neither is in play for an
   * agent that no longer exists. What IS shared is what a removal owes the room
   * afterwards — its holds abandoned, and every open window told.
   *
   * @param authorIds - Candidate authors. Anything live, or not an agent, is ignored.
   * @param departedManifestId - The manifest id of the agent Mesh just
   *   unregistered, when this is the cascade. It is the identity recorded for an
   *   author that carries no stamp of its own; the sweep passes none, so such a
   *   seat is kept but never replayed.
   * @returns The authors taken out, and every channel seat they lost.
   */
  drop(authorIds: readonly string[], departedManifestId?: string): DepartedAgentsDrop {
    const departed = [...this.authors.getMany(authorIds).values()].filter(
      (author) => author.kind === 'agent' && !isLiveAuthor(author, this.agents)
    );
    const removed = this.store.departedSeats.removeFromChannels(
      departed.map((author) => ({
        authorId: author.id,
        manifestId: author.mintedForManifestId ?? departedManifestId ?? null,
      })),
      new Date().toISOString()
    );
    for (const { roomId, authorId } of removed) {
      this.triggers.abandonHolds(roomId, authorId);
      eventFanOut.broadcast('room_member_removed', { roomId, authorId });
    }
    const departedIds = departed.map((author) => author.id);
    // A direct message's roster did not move, but what it SAYS about the member
    // did: an open window re-reads it and draws them as retired.
    for (const roomId of this.store.departedSeats.listDmIdsWith(departedIds)) {
      eventFanOut.broadcast('room_updated', { roomId });
    }
    return { authorIds: departedIds, removed };
  }

  /**
   * Give the channel seats back to every author that is live again and was
   * left by the agent now answering for it.
   *
   * An author is only ever matched to the agent that left it: the tombstone
   * carries that agent's manifest id, and the one compared against it is the id
   * of whoever is registered at the author's directory NOW. A different agent at
   * the same folder therefore inherits nothing — the same rule ADR 260801-003051
   * applies to the author row itself.
   *
   * @param authorIds - Candidate authors. Anything not an agent, or with nobody registered at its directory, is ignored.
   * @returns Every seat given back.
   */
  restore(authorIds: readonly string[]): ChannelSeat[] {
    const restored: ChannelSeat[] = [];
    for (const author of this.authors.getMany(authorIds).values()) {
      if (author.kind !== 'agent') continue;
      // The occupant's id is the whole test, and it is stricter than asking
      // whether the author is live: a legacy author with no stamp is "live" for
      // ANY occupant, but its seats were recorded under the agent that left.
      const occupant = this.agents.byPath(author.naturalKey);
      if (!occupant) continue;
      const outcome = this.store.departedSeats.restore(author.id, occupant.id, (roomId) =>
        this.joinRefusal(roomId, author)
      );
      restored.push(...outcome.restored);
      for (const seat of outcome.refused) {
        logger.warn('[rooms] a returning agent was not given a seat back', {
          event: 'rooms.agent_return_refused',
          roomId: seat.roomId,
          authorId: seat.authorId,
          reason: seat.reason,
        });
      }
    }
    for (const { roomId, authorId } of restored) {
      eventFanOut.broadcast('room_member_added', { roomId, authorId });
    }
    return restored;
  }

  /**
   * Why an author may not rejoin a room now, or `null` when it may — the join
   * rules an ordinary add enforces (`RoomMembership.requireJoinAllowed`), read as
   * an answer rather than a throw so one refused seat does not cost the others.
   *
   * @param roomId - The room.
   * @param author - The returning author.
   */
  private joinRefusal(roomId: string, author: AuthorRecord): string | null {
    const room = this.store.getRoom(roomId);
    if (!room) return 'ROOM_NOT_FOUND';
    try {
      this.membership.requireJoinAllowed(room, author);
      return null;
    } catch (err) {
      if (err instanceof RoomError) return err.code;
      throw err;
    }
  }

  /** Every author with seats waiting to be given back. See {@link RoomDepartures.restore}. */
  listWaitingAuthorIds(): string[] {
    return this.store.departedSeats.listWaitingAuthorIds();
  }

  /**
   * Every agent author that still holds a channel seat and that nobody at its
   * directory answers for — the ghosts an unregister before DOR-2095 left behind,
   * and the candidates the repair sweep weighs. A pure read.
   */
  listDepartedChannelAgents(): AuthorRecord[] {
    const authors = this.authors.getMany(this.store.departedSeats.listChannelAgentMemberIds());
    return [...authors.values()].filter((author) => !isLiveAuthor(author, this.agents));
  }
}
