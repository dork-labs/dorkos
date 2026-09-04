/**
 * The words for a room you can read but cannot post in — the sidebar row's
 * mark, the composer that replaces the field, and the target's refusal reason,
 * all spelled once here (DOR-1620).
 *
 * @module entities/room/lib/membership-copy
 */

/**
 * The whole of what this client honestly knows: the reader is not on this
 * room's roster right now.
 *
 * **Deliberately says nothing about history.** The only membership signal any
 * of these surfaces has is the absence of a read cursor — `unreadCount === null`
 * on a room summary, an empty own-entry on a roster — and absence answers "are
 * you in it now", never "were you ever". An agent may open a channel the owner
 * was never added to (legal under the three-way rule, DOR-1611), and the room
 * she left looks identical on the wire, so the previous wording ("You left this
 * channel") was a plain falsehood for one of the two. This sentence is true of
 * both, which is why no new field had to reach the wire to make the copy honest.
 */
export const NOT_IN_ROOM_LABEL = "You're not in this channel";

/**
 * The label plus the consequence, which is the part a reader actually needs:
 * the history stays readable, the field does not come back until she joins.
 */
export const NOT_IN_ROOM_SENTENCE = `${NOT_IN_ROOM_LABEL}. You can read it, but not add to it.`;

/**
 * The sidebar row's mark. Names what the room is FOR this reader rather than
 * what she is supposed to have done to it — the same reason the sentence above
 * leads with the consequence.
 */
export const NOT_IN_ROOM_PILL = 'Read only';

/**
 * The way in, from the composer's place and from the row menu alike.
 *
 * "Join" rather than "Rejoin" for the same reason: getting onto a roster is one
 * action whether or not the reader was ever on it before, and only one of those
 * two words is true in both cases.
 */
export const JOIN_ROOM_VERB = 'Join';
