import { roomDisplayTitle, useRoom, useTeamRoom } from '@/layers/entities/room';
import { RoomMembersChip } from './RoomMembersChip';
import { RoomRunState } from './RoomRunState';

/**
 * What Home's bar says about the room Home IS.
 *
 * Home is #team (team-room-home spec D3.2), so it wears the same chips a channel
 * wears — whether anything is running and who is in it — from the same
 * components, in the same order. Phase H1 gave it the head count; this adds back
 * the working count and the room-wide Stop, which went with the masthead and had
 * no replacement in between (spec §3.4, the `/` row's note).
 *
 * **One resolution for both chips.** `useTeamRoom` and the roster read happen
 * here and are handed down, rather than each chip finding the room for itself —
 * so the two can never end up describing different rooms, and the reads stay a
 * pair of cache hits on queries the page below already holds.
 *
 * **Archived resolves to no room at all, before the roster is even asked for.**
 * An archived #team draws no conversation — Home offers to bring it back instead
 * (`HomeRoomPage`) — so chips for it would be controls for something that is not
 * on screen, and a Stop for a room nobody can post to. Passing `null` rather
 * than filtering afterwards also means `useRoom` never runs the request (it is
 * `enabled` on the id), so an archived room costs no roster read.
 *
 * **Nothing is drawn until the count is real.** A chip that opens on `0` and
 * corrects itself a moment later has told the reader something false about their
 * own team, and it is the sort of wrong number nobody goes back to check.
 */
export function HomeRoomChips() {
  const team = useTeamRoom();
  const roomId = team.status === 'archived' ? null : (team.room?.id ?? null);
  const roster = useRoom(roomId);

  const room = roomId === null ? null : team.room;
  const count = roster.data?.members.length;
  if (room === null || count === undefined) return null;

  return (
    <>
      <RoomRunState roomId={room.id} roomName={roomDisplayTitle(room)} />
      <RoomMembersChip room={room} count={count} />
    </>
  );
}
