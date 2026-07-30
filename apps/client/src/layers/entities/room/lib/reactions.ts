/**
 * The rules a reaction row follows, with nothing React in them.
 *
 * Reactions are DURABLE state that rides the entry: every path that hands a
 * reader an entry hands over that entry's reactions with it — the history page,
 * the stream's hydration snapshot, a resume replay, a live `entry` event — and
 * the `reaction` event keeps them fresh in between. So the rules here are about
 * one thing: taking a WHOLE set and putting it where the entry already is.
 *
 * @module entities/room/lib/reactions
 */
import type { RoomEntry, RoomEntryReaction } from '@dorkos/shared/room-schemas';

/**
 * How many pills a row draws before the rest collapse into "+N more".
 *
 * Ten, from the approved design (`specs/room-messaging-design` §4). The row
 * wraps up to that, which on the narrowest phone is three lines of pills — past
 * it the reactions would be taller than the message they are about.
 */
export const REACTION_ROW_LIMIT = 10;

/** How many people one pill names before it starts counting them instead. */
const NAMES_BEFORE_COUNT = 4;

/**
 * Whether two reaction sets say the same thing.
 *
 * Content, not reference: an arriving set is always freshly parsed off the
 * wire, so referential equality answers "no" every single time and can never be
 * the bail. Order counts because the row is drawn in the order it arrives, and
 * `firstAt` counts because it is what that order is derived from server-side.
 *
 * @param a - One set.
 * @param b - The other.
 */
function sameReactions(a: readonly RoomEntryReaction[], b: readonly RoomEntryReaction[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index]!;
    return (
      left.emoji === right.emoji &&
      left.firstAt === right.firstAt &&
      left.authorIds.length === right.authorIds.length &&
      left.authorIds.every((id, i) => id === right.authorIds[i])
    );
  });
}

/**
 * Replace one entry's whole reaction set inside a cached history.
 *
 * **Replace, never merge.** The stream carries state rather than a delta
 * (`RoomReactionEventSchema`), so a reader that missed five of these and caught
 * the sixth is correct again — and a client that merged would keep a pill the
 * server no longer holds until the page was reloaded.
 *
 * **A frame that changes nothing writes nothing.** Two cases reach this with
 * no work to do, and both are the common case rather than the rare one: an
 * entry this reader does not hold (a resume re-sends the trailing window, which
 * routinely names entries paged out of view), and an entry whose pills are
 * exactly what they already were (the same resume re-sends every entry in that
 * window, including all the ones nobody touched). Either way the cached array
 * keeps its identity, so the timeline does not re-render — measured at a
 * hundred no-op frames producing a hundred new arrays before this bail existed,
 * and none after.
 *
 * @param cached - The current cached history, oldest-first.
 * @param entryId - The entry whose reactions changed.
 * @param reactions - Its complete set now; empty means the last pill went.
 * @returns The history with that entry's set replaced.
 */
export function mergeRoomReactions(
  cached: readonly RoomEntry[] | undefined,
  entryId: string,
  reactions: RoomEntryReaction[]
): RoomEntry[] {
  const list = cached ?? [];
  const index = list.findIndex((held) => held.id === entryId);
  if (index === -1) return list as RoomEntry[];
  const held = list[index]!.reactions;
  if (held !== undefined && sameReactions(held, reactions)) return list as RoomEntry[];
  const next = [...list];
  next[index] = { ...list[index]!, reactions };
  return next;
}

/**
 * Put one emoji on a set, take it off, or land it in the state you name.
 *
 * The same rule the server keys on — `(entry, you, emoji)` holds at most one
 * reaction — so drawing this optimistically and reconciling against the stream
 * cannot disagree about what a click meant. A pill keeps its place when the
 * reader joins one that is already there, because the row is ordered by first
 * appearance; a brand-new emoji lands at the end for the same reason.
 *
 * @param reactions - The entry's set now, or undefined for an entry with none.
 * @param emoji - The emoji being toggled.
 * @param authorId - The reader's own author id in this room.
 * @param on - The state to land in. Omit to flip, which is what a click means.
 * @returns The new set, and which way it went.
 */
export function applyReactionToggle(
  reactions: readonly RoomEntryReaction[] | undefined,
  emoji: string,
  authorId: string,
  on?: boolean
): { reactions: RoomEntryReaction[]; on: boolean } {
  const held = reactions ?? [];
  const existing = held.find((reaction) => reaction.emoji === emoji);
  const reacted = existing !== undefined && existing.authorIds.includes(authorId);
  const next = on ?? !reacted;

  if (next === reacted) return { reactions: held as RoomEntryReaction[], on: reacted };

  if (next) {
    if (!existing) {
      return {
        reactions: [...held, { emoji, authorIds: [authorId], firstAt: new Date().toISOString() }],
        on: true,
      };
    }
    return {
      reactions: held.map((reaction) =>
        reaction.emoji === emoji
          ? { ...reaction, authorIds: [...reaction.authorIds, authorId] }
          : reaction
      ),
      on: true,
    };
  }

  return {
    reactions: held.flatMap((reaction) => {
      if (reaction.emoji !== emoji) return [reaction];
      const authorIds = reaction.authorIds.filter((id) => id !== authorId);
      // The last person off a pill takes the pill with them.
      return authorIds.length === 0 ? [] : [{ ...reaction, authorIds }];
    }),
    on: false,
  };
}

/**
 * Whether this author is on this pill.
 *
 * @param reaction - The pill.
 * @param authorId - Who to look for.
 */
export function hasReacted(reaction: RoomEntryReaction, authorId: string): boolean {
  return reaction.authorIds.includes(authorId);
}

/**
 * Who reacted, in words — "You and LifeOS reacted 👍".
 *
 * **Names, not counts** (`specs/room-messaging-design` §2, behaviour 2): rooms
 * here hold a handful of people and agents, and which of them said "got it" is
 * the whole information. The reader comes first and is called You, because a
 * row that led with somebody else's name would make you hunt for your own.
 *
 * Past four names it starts counting, which is the point where a tooltip stops
 * being readable at a glance. An id the roster does not hold belongs to somebody
 * who has left the room; it is named as that rather than printed raw.
 *
 * @param reaction - The pill being described.
 * @param viewerAuthorId - The reader's own author id in this room.
 * @param names - Display names by author id, from the room's roster.
 * @returns One sentence, fit to put in a tooltip.
 */
export function reactionSummary(
  reaction: RoomEntryReaction,
  viewerAuthorId: string,
  names: ReadonlyMap<string, string>
): string {
  const ordered = [
    ...reaction.authorIds.filter((id) => id === viewerAuthorId),
    ...reaction.authorIds.filter((id) => id !== viewerAuthorId),
  ];
  const spoken = ordered.map((id) =>
    id === viewerAuthorId ? 'You' : (names.get(id) ?? 'Someone who left')
  );

  const named = spoken.slice(0, NAMES_BEFORE_COUNT);
  const rest = spoken.length - named.length;
  if (rest > 0) named.push(rest === 1 ? '1 other' : `${rest} others`);

  const who =
    named.length === 1
      ? named[0]!
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`;

  return `${who} reacted ${reaction.emoji}`;
}

/**
 * Split a row into the pills it draws and the count it hides behind "+N more".
 *
 * @param reactions - The entry's whole set, oldest pill first.
 */
export function splitReactionRow(reactions: readonly RoomEntryReaction[]): {
  shown: RoomEntryReaction[];
  hidden: number;
} {
  return {
    shown: reactions.slice(0, REACTION_ROW_LIMIT),
    hidden: Math.max(0, reactions.length - REACTION_ROW_LIMIT),
  };
}
