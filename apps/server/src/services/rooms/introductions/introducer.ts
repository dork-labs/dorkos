/**
 * Agents introduce themselves when a channel is opened with them in it, and
 * when one joins a channel later (DOR-2106, feedback FB-33).
 *
 * **Two writes per agent, and both are bounded in code rather than in a prompt.**
 *
 * 1. **A `joined_room` moment** — "Ana joined this room." — in the room's own
 *    voice. It is a system post, so it wakes nobody: its cascade is spent at the
 *    ceiling and it addresses no one (`RoomSystemPosts.postMoment`). It is also
 *    the durable marker. Whether an agent has been introduced in a room is a
 *    question about the room's log (`RoomStore.hasMoment`), never about memory
 *    in this process, so a restart, a second process, or the agent leaving and
 *    coming back cannot introduce it twice.
 * 2. **One aside turn**, framed on that line, in which the agent may post its
 *    own introduction in its own words. It is the welcome-back offer's turn
 *    (`RoomTriggerDispatcher.askAside`), so it carries everything that turn
 *    carries: the room's own `(room, agent)` session at the agent's own level;
 *    skipped when the agent is already working; charged to the room's hourly
 *    automatic-turn budget and skipped when that is spent; and claimed AT the
 *    cascade ceiling with no root, so what it posts starts no conversation and
 *    no other agent answers it.
 *
 * **What is introduced.** Ordinary channels only. A direct message is a person
 * and an agent who already know who they are talking to. #team (and any room
 * with a well-known key) seats every agent by itself and has its own
 * `joined_team` moment. A bridged chat holds one agent and belongs to the chat
 * on the other side. A room mirrored from a Community is written by that
 * Community. And an agent that opened a channel does not introduce itself to
 * the people it just invited.
 *
 * **Never throws.** An introduction is a courtesy riding on a create or an add
 * that has already succeeded; nothing here may fail it. The line is written
 * before the turn, so an agent that is busy, out of budget or failing is still
 * marked as introduced: "once" means once, not "until it works".
 *
 * @module server/services/rooms/introductions/introducer
 */
import type {
  Room,
  RoomEntry,
  RoomMoment,
  RoomMomentKind,
  RoomRosterEntry,
} from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import type { AuthorRecord } from '../author-registry.js';
import { joinedRoomText } from '../moments/moment-copy.js';
import type { OpenedRoom } from '../service/room-service-deps.js';

/** Everything an introduction needs, and nothing about how any of it is stored. */
export interface RoomIntroductionDeps {
  /** Whether introductions are on. Read per call, so a switch binds the next join. */
  enabled(): boolean;
  /** The room, or `null`. */
  room(roomId: string): Room | null;
  /** Whether a chat on another platform is bridged into this room. */
  isBridged(roomId: string): boolean;
  /** Whether this room mirrors a Community's timeline. */
  isMirrored(roomId: string): boolean;
  /** The author, or `undefined`. */
  author(authorId: string): AuthorRecord | undefined;
  /** Whether the room's log already holds this moment. */
  hasMoment(roomId: string, key: { kind: RoomMomentKind; ref?: string }): boolean;
  /** Write a moment in the room's own voice. */
  postMoment(
    roomId: string,
    input: { text: string; moment: RoomMoment; subjectAuthorId?: string }
  ): RoomEntry;
  /** Run one aside turn. See `RoomTurnControl.askAside`. */
  ask(input: {
    roomId: string;
    authorId: string;
    aboutEntryId: string;
    prompt: string;
  }): Promise<void>;
  /** The clock. */
  now?(): Date;
}

/**
 * What one agent is asked when it joins a channel.
 *
 * Carries nothing a member wrote — no title, no topic, no names — because the
 * turn's own room context block already describes the room, fenced as data. It
 * spells the call with the room's id in it, for the reason
 * `welcomeBackOfferPrompt` gives (DOR-1643): a turn's own words never reach the
 * room, and naming the call is what gets it made.
 *
 * @param roomId - The room to post into.
 */
export function introductionPrompt(roomId: string): string {
  return [
    'You have just been added to this channel. The other members do not know yet who you are or what you do.',
    'Introduce yourself in one or two short sentences, in your own words: who you are and what you can help with here. ' +
      `Post it with post_to_room(roomId: "${roomId}", text: <your introduction>). ` +
      'Nothing you write back to this session reaches the room.',
    'Ask no questions, mention nobody, and do not answer anybody else’s introduction. You will not be asked this again in this room.',
  ].join('\n\n');
}

/** Introduces agents to channels they join. See the module docs. */
export class RoomIntroductions {
  constructor(private readonly deps: RoomIntroductionDeps) {}

  /**
   * A room was opened: the agents it was opened with introduce themselves — not
   * the one that opened it, and nobody in a direct message that already existed.
   *
   * @param opened - What `createRoom` answered.
   * @param creatorAuthorId - Who opened it.
   * @returns `opened`, untouched.
   */
  opened(opened: OpenedRoom, creatorAuthorId: string): OpenedRoom {
    if (opened.created) {
      this.introduce(
        opened.id,
        opened.members.map((member) => member.authorId).filter((id) => id !== creatorAuthorId)
      );
    }
    return opened;
  }

  /**
   * A member was added to a room: if it is an agent, it introduces itself.
   *
   * @param roomId - The room.
   * @param member - What the add answered.
   * @returns `member`, untouched.
   */
  joined(roomId: string, member: RoomRosterEntry): RoomRosterEntry {
    this.introduce(roomId, [member.authorId]);
    return member;
  }

  /**
   * Introduce each of these members to the room, once each, ever.
   *
   * Returns as soon as the joined lines are written; the turns run on their own.
   * People and the system are skipped, as is every agent already introduced here.
   *
   * @param roomId - The channel they joined.
   * @param authorIds - Who joined.
   */
  introduce(roomId: string, authorIds: readonly string[]): void {
    try {
      if (!this.deps.enabled()) return;
      const room = this.deps.room(roomId);
      if (!room || !this.introducesIn(room)) return;
      const lines: Array<{ authorId: string; entryId: string }> = [];
      for (const authorId of authorIds) {
        const entryId = this.markJoined(room, authorId);
        if (entryId !== null) lines.push({ authorId, entryId });
      }
      for (const line of lines) {
        this.deps
          .ask({
            roomId,
            authorId: line.authorId,
            aboutEntryId: line.entryId,
            prompt: introductionPrompt(roomId),
          })
          .catch((err: unknown) => this.warn(roomId, line.authorId, err));
      }
    } catch (err) {
      this.warn(roomId, null, err);
    }
  }

  /** Whether this room is one agents introduce themselves in. */
  private introducesIn(room: Room): boolean {
    return (
      room.kind === 'channel' &&
      !room.archived &&
      !room.wellKnown &&
      !this.deps.isBridged(room.id) &&
      !this.deps.isMirrored(room.id)
    );
  }

  /**
   * Write the joined line for one agent, unless the room already has one.
   *
   * @returns The line's entry id, or `null` when nothing was written.
   */
  private markJoined(room: Room, authorId: string): string | null {
    try {
      const author = this.deps.author(authorId);
      if (author?.kind !== 'agent') return null;
      const ref = author.naturalKey;
      if (this.deps.hasMoment(room.id, { kind: 'joined_room', ref })) return null;
      const entry = this.deps.postMoment(room.id, {
        text: joinedRoomText(author.displayName),
        moment: {
          kind: 'joined_room',
          source: {
            kind: 'agent',
            ref,
            observedAt: (this.deps.now?.() ?? new Date()).toISOString(),
          },
          mintedByAgentRef: null,
        },
        subjectAuthorId: author.id,
      });
      return entry.id;
    } catch (err) {
      this.warn(room.id, authorId, err);
      return null;
    }
  }

  private warn(roomId: string, authorId: string | null, err: unknown): void {
    logger.warn('[rooms] an agent introduction was not made', {
      roomId,
      ...(authorId !== null && { authorId }),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
