/**
 * Reactions — the quietest write in the domain, and the quiet is the feature
 * (`specs/room-messaging-design` §2.5).
 *
 * A reaction takes no turn, dispatches no trigger, writes no entry, spends no
 * budget, starts no cascade and does not touch `lastActivityAt`. The
 * acknowledgment reaches the agent on its NEXT turn, in the room-context block
 * it was going to be handed anyway, and never a moment sooner. That is why a
 * reaction is not a post with a special body: a post is a turn in the
 * conversation, and a reaction is somebody saying "seen" for free.
 *
 * @module server/services/rooms/messages/room-reactions
 */
import type { RoomEntryReaction, RoomReactionEvent } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import type { ReactionBudget } from '../reactions/reaction-budget.js';
import type { ReactionStore } from '../reactions/reaction-store.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomCore } from '../service/room-core.js';
import { RoomError } from '../room-errors.js';
import type { RoomPublisher } from '../service/room-publisher.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTriggerDispatcher } from '../room-trigger.js';
import type { RoomVisibility } from '../service/room-visibility.js';

/** Putting an emoji on a message, taking it back, and reading them out. */
export class RoomReactions {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  private readonly reactions: ReactionStore;
  /** How many emoji an agent may still land in one room this hour. */
  private readonly reactionBudget: ReactionBudget;
  private readonly triggers: RoomTriggerDispatcher;

  constructor(
    core: RoomCore,
    private readonly visibility: RoomVisibility,
    private readonly publisher: RoomPublisher
  ) {
    this.store = core.store;
    this.authors = core.authors;
    this.reactions = core.reactions;
    this.reactionBudget = core.reactionBudget;
    this.triggers = core.triggers;
  }

  /**
   * Put one emoji on one entry, or take it back.
   *
   * **This is the quietest write in the domain, and the quiet is the feature**
   * (`specs/room-messaging-design` §2.5). Look at what it does not do: it takes
   * no turn, dispatches no trigger, writes no entry, writes no notice, spends no
   * budget, starts no cascade, and does not touch `lastActivityAt` — so a room
   * full of thanks does not climb a sidebar sorted by recency, and an agent
   * being thanked is not woken up to be told. The acknowledgment reaches the
   * agent on its NEXT turn, in the room-context block it was going to be handed
   * anyway (`room-context.ts`), and never a moment sooner.
   *
   * That is also why a reaction is not `post` with a special body. A post is a
   * turn in the conversation and everything above follows from that; a reaction
   * is a person saying "seen" for free, and free has to mean free.
   *
   * The refusals, in the order they are asked and for reasons that are not
   * interchangeable:
   *
   * - **Not visible** → `ROOM_NOT_FOUND`, before anything else, so a caller
   *   holding a room id learns nothing by probing with an emoji.
   * - **Not a member** → `MEMBER_NOT_FOUND`. Seeing a room is not being in it;
   *   `post` draws the same line and this one is no looser.
   * - **Archived** → `ROOM_ARCHIVED`. Archiving promises a room gains nothing
   *   more, and a pill is something it would gain.
   * - **An agent out of allowance** → `REACTION_RATE_LIMITED`. Agents may react
   *   (ADR 260814-195522, reversing etiquette E16b); what they may not do is
   *   react without a bound, because a reaction costs nothing and so nothing else
   *   in the system would ever slow one down. People are not counted.
   * - **No such entry here** → `ENTRY_NOT_FOUND`, scoped to this room so an id
   *   from elsewhere cannot attach a reaction to a message in a room the caller
   *   cannot see.
   * - **A turn somebody STOPPED** → `TURN_WAS_STOPPED`, DOR-1426. The same
   *   refusal `post_to_room` keeps, on the other thing a stopped turn can still
   *   do here, and it only ever reaches an agent.
   *
   * @param roomId - The room.
   * @param entryId - The entry being reacted to.
   * @param viewerAuthorId - Who is reacting.
   * @param emoji - The emoji, already validated by the request schema.
   * @param on - The state to land in, when the caller names one instead of
   *   flipping. `true` ensures the reaction is there and `false` ensures it is
   *   not, both of them idempotent in effect — which is what a client that may
   *   retry has to be able to ask for, because a retried flip undoes itself.
   * @returns Which way it went, and the caller's recomputed quick row.
   */
  toggleReaction(
    roomId: string,
    entryId: string,
    viewerAuthorId: string,
    emoji: string,
    on?: boolean
  ): { reacted: boolean; frequents: string[] } {
    const room = this.visibility.requireVisibleRoom(roomId, viewerAuthorId);
    if (!this.store.getMember(roomId, viewerAuthorId)) {
      throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    }
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    if (!this.store.getEntryById(roomId, entryId)) {
      throw new RoomError('ENTRY_NOT_FOUND', 'No such entry in this room');
    }
    // **A stopped turn does not react either** (DOR-1426, closing the named
    // limit of DOR-1313). A reaction writes no entry and takes no turn, which is
    // why the stop mark was first put on `post_to_room` alone — but a room that
    // has just been told everything in it was stopped, and then watches the
    // stopped agent thumbs-up the conversation, has been told something untrue.
    // The mark is the same `(room, agent)` one, with the same lifetime: it is
    // lifted by the next claim there, so the agent reacts again the moment the
    // room gives it another turn.
    //
    // Asked BEFORE the budget for the same reason every other refusal is: a
    // caller that is going to be refused must not have an allowance taken off it
    // on the way out. People are never marked — a claim belongs to an agent —
    // so this never reaches whoever pressed Stop.
    if (this.triggers.stoppedIn(roomId, viewerAuthorId)) {
      logger.info('[rooms] refused a stopped turn a reaction', {
        roomId,
        authorId: viewerAuthorId,
      });
      throw new RoomError(
        'TURN_WAS_STOPPED',
        'This conversation was stopped, so nothing more from this turn lands here. Wait for the next message before reacting.'
      );
    }
    // Asked LAST of the refusals, and after the entry check, because it is the
    // only one that SPENDS something: a caller that was going to be refused for
    // any other reason must not have an allowance taken off it on the way out.
    //
    // **Only an ADDITION spends.** Taking a reaction back is never refused and
    // never charged, because a retraction is the remedy for a reaction somebody
    // regrets and an agent that cannot take one back is an agent whose mistakes
    // are permanent — and because it makes the ceiling honest to describe:
    // twenty an hour means twenty pills, not twenty clicks. Which way this call
    // goes is settled before the write, from the row state: `on: false` removes,
    // a flip removes what is standing, and `on: true` on a reaction already there
    // is a no-op a retrying client must not be charged for.
    if (this.authors.getById(viewerAuthorId)?.kind !== 'human') {
      const standing = this.reactions.has({ roomId, entryId, authorId: viewerAuthorId, emoji });
      const lands = on === false ? false : !standing;
      if (lands && !this.reactionBudget.tryReserve(roomId, viewerAuthorId)) {
        throw new RoomError(
          'REACTION_RATE_LIMITED',
          'You have used up your reactions in this room for now — say something instead, or wait.'
        );
      }
    }

    const reacted = this.reactions.set(
      { roomId, entryId, authorId: viewerAuthorId, emoji },
      new Date().toISOString(),
      on
    );
    // **A reaction can BE the answer** (spec `tool-only-room-replies` §D10). Under
    // `rooms.toolOnlyReplies` a turn that reacts and says nothing has still put
    // something in front of the reader, so it releases as `'answered'` and earns
    // no "read this and did not reply" line.
    //
    // Marked AFTER the write and only when a pill is now STANDING. Both halves
    // matter: every refusal above throws, so nothing that put nothing in front of
    // anybody can reach this line — and a retraction leaves the entry with
    // nothing on it, which is not an answer to anything. A person's reaction
    // marks nothing, because a claim belongs to an agent.
    if (reacted) this.triggers.noteDeliberateReaction(roomId, viewerAuthorId);
    this.publisher.publishReactions(roomId, entryId);
    return { reacted, frequents: this.reactions.frequents(viewerAuthorId) };
  }

  /**
   * One entry's reactions right now, for a reader that already holds the entry.
   *
   * @param roomId - The room.
   * @param entryId - The entry.
   */
  reactionsFor(roomId: string, entryId: string): RoomEntryReaction[] {
    return this.reactions.listForEntry(roomId, entryId);
  }

  /**
   * The current reaction state of every entry in a room's trailing window — the
   * resume half of the reaction contract.
   *
   * A resume replays entries above the cursor, and each of those arrives with
   * its own reactions. What it cannot carry is a reaction that changed on an
   * OLDER message while the reader was away: that entry is below the cursor, so
   * nothing replays it, and the reader would sit on stale pills until a reload.
   * So the handler asks for this once, after the replay.
   *
   * **EVERY entry in the window, including the ones with no reactions at all.**
   * That is not padding, it is the difference between state and a diff, and
   * skipping the empties silently loses removals: react, disconnect, take it
   * back, resume — the entry is unchanged so nothing replays it, and it has no
   * pills so a "only what still has reactions" resync says nothing about it,
   * leaving the reader showing a 👍 that {@link RoomService.reactionsFor}
   * denies. The empty event IS the correction. It costs one small frame per
   * message in the window on a resume only, which is the price of the contract
   * {@link RoomReactionEventSchema} states.
   *
   * @param roomId - The room.
   * @param historyLimit - How many trailing entries to cover; the same window a
   *   cold connect hydrates, because it is the same set of drawable messages.
   * @returns One event per entry in the window, oldest first, carrying that
   *   entry's whole current set — `[]` when it has none.
   */
  reactionResync(roomId: string, historyLimit: number): RoomReactionEvent[] {
    const entries = this.store.listEntries(roomId, { limit: historyLimit });
    const grouped = this.reactions.listFor(
      roomId,
      entries.map((entry) => entry.id)
    );
    return entries.map((entry) => ({
      type: 'reaction',
      entryId: entry.id,
      reactions: grouped.get(entry.id) ?? [],
    }));
  }
}
