/**
 * Who may send a room seat a private message, checked as admission commits (DOR-4547).
 *
 * Both rules cover only writes into a seat by its chat id, the route this inbox owns. A send to
 * an agent's id goes to a direct chat with that agent instead, which neither rule touches.
 * Both read server-owned rows and in-memory queue state, never the message.
 *
 * - **Membership.** Only a live member of the seat's room may start a private message to it,
 *   checked at admission and again before the note's turn launches. An answer to something the
 *   seat itself sent is exempt: the seat started that conversation, and the agent it asked may
 *   sit outside the room (DOR-4472 D1).
 * - **One answer per exchange, seat to seat.** A private turn a seat runs because of notes from
 *   seat X may send X's seat one thing only: the answer to an original note of X's, never an
 *   answer to an answer and never a fresh note. So when X asks and the seat answers, X's turn
 *   about that answer cannot write back to the seat by chat id. The rule is per sending seat and
 *   per target seat, and holds only while that turn runs, so either seat may write again from a
 *   later turn. A cycle through a third seat stays bounded by each room's automatic-turn budget.
 *
 * @module server/services/rooms/handoff/seat-message-guards
 */
import type { RoomCore } from '../service/room-core.js';
import { isLiveAuthor } from '../handles/author-handles.js';
import { resolveSeatMessageTarget } from './seat-message-target.js';
import type { SeatMessagePending, SeatMessageTarget } from './seat-message-types.js';

/**
 * Whether the agent at a home is a live member of a room.
 *
 * @param core - The room core the seat lives in.
 * @param agentPath - The sending agent's home, from its verified turn.
 * @param roomId - The seat's room.
 */
export function senderIsRoomMember(core: RoomCore, agentPath: string, roomId: string): boolean {
  return core.authors
    .agentRowsAt(agentPath)
    .some(
      (author) =>
        isLiveAuthor(author, core.agents) && core.store.getMember(roomId, author.id) !== null
    );
}

/**
 * Whether a private turn may send this message to the target seat.
 *
 * @param core - The room core the seats live in.
 * @param running - The notes the sending seat's private turn is running on right now.
 * @param target - The seat being written to.
 * @param askedReplyToId - What the answered note itself answered: `null` for an original note,
 *   `undefined` when this message answers nothing.
 * @returns `true` when the message may be admitted.
 */
export function exchangeAllows(
  core: RoomCore,
  running: readonly SeatMessagePending[],
  target: SeatMessageTarget,
  askedReplyToId: string | null | undefined
): boolean {
  const fromTarget = running.some((item) => {
    const sender = resolveSeatMessageTarget(core, item.row.fromSessionId);
    return sender?.roomId === target.roomId && sender.authorId === target.authorId;
  });
  return !fromTarget || askedReplyToId === null;
}
