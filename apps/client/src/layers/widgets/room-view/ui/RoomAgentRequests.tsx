/**
 * The app requests a room's own agents raised, shown in that room (DOR-2415,
 * connections-one-list design §3).
 *
 * An agent in a room works in a session of its own, so its request for an app
 * never appears in the room's timeline as a tool call. This draws the same
 * card the chat draws, at the live end of the room beside the permission
 * requests, because a pending request belongs to the turn that is waiting on
 * it. Which requests belong here is the server's answer (`roomId`, read
 * through the room-session binding), never re-derived from session ids.
 *
 * Only the owner can read requests, so only the owner sees these cards. Other
 * people in the room see nothing: the agent's own message says what it is
 * waiting for, and a second line about it would be noise.
 *
 * @module widgets/room-view/ui/RoomAgentRequests
 */
import { useConnectorAgentRequests } from '@/layers/entities/connectors';
import { AgentRequestCard } from '@/layers/features/connections';

/** Props for {@link RoomAgentRequests}. */
export interface RoomAgentRequestsProps {
  /** The room whose agents' requests to show. */
  roomId: string;
}

/** The open app requests this room's agents raised, or nothing. */
export function RoomAgentRequests({ roomId }: RoomAgentRequestsProps) {
  const { data } = useConnectorAgentRequests('pending');
  const requests = (data ?? []).filter((request) => request.roomId === roomId);
  if (requests.length === 0) return null;
  return (
    <section
      data-slot="room-agent-requests"
      aria-label="Apps agents are asking for"
      className="shrink-0 space-y-2 px-3 pb-2 md:px-4"
    >
      {requests.map((request) => (
        <AgentRequestCard key={request.requestId} request={request} />
      ))}
    </section>
  );
}
