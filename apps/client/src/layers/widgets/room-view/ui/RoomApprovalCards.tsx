/**
 * The request cards a room's own turns raised, shown in that room (spec
 * `agent-permissions` D7).
 *
 * A room is exactly where a Rooms request comes from: an agent in #proj-lunar
 * asks to open a room, and the person reading #proj-lunar is the one who knows
 * whether it should. Before this the card reached only the inbox and home, away
 * from the conversation that caused it.
 *
 * ## The same card, not a second one
 *
 * It renders {@link ApprovalList}, so the card, its three answers and its
 * receipt are the ones the inbox shows, and answering here resolves it
 * everywhere. Which requests belong to this room is the server's answer
 * (`PendingApproval.roomId`, read through the room-session binding when the card
 * is read), never re-derived here from session ids.
 *
 * ## Where it sits, and who sees it
 *
 * At the live end of the timeline, just above the lane that says who is working.
 * A pending request belongs to the turn in flight or the one that just ended,
 * which is always the newest point of the room; pinning it there keeps it on
 * screen while the person reads back up. It is mounted only by the local
 * {@link RoomSurface}, never by a remote community's surface, and the approvals
 * it reads are sent only to the install's operator, so the owner is the one
 * person who sees it. Answering still clears the server's person bars.
 *
 * @module widgets/room-view/ui/RoomApprovalCards
 */
import { usePendingApprovals } from '@/layers/entities/attention';
import { ApprovalList, useApprovalCards } from '@/layers/features/approvals';

/** Props for {@link RoomApprovalCards}. */
export interface RoomApprovalCardsProps {
  /** The room whose turns' requests to show. */
  roomId: string;
}

/** The request cards this room's turns raised, or nothing. */
export function RoomApprovalCards({ roomId }: RoomApprovalCardsProps) {
  const { approvals } = usePendingApprovals();
  // Answered cards keep their receipt for a beat, like everywhere else.
  const cards = useApprovalCards(approvals).filter((approval) => approval.roomId === roomId);
  if (cards.length === 0) return null;
  return (
    <section
      data-slot="room-approvals"
      aria-label="Requests waiting on you"
      className="shrink-0 px-3 pb-2 md:px-4"
    >
      <ApprovalList approvals={cards} />
    </section>
  );
}
