import { useState } from 'react';
import { roomDisplayTitle, useRoom, useTeamRoom } from '@/layers/entities/room';
import { RoomDetailsDialog, type RoomDetailsFocus } from '@/layers/features/room-management';
import { BarMembersChip } from './BarMembersChip';

/**
 * Home's members chip: who is in #team, and the way into managing them.
 *
 * Home IS the #team room, so this is that room's roster where every other room
 * keeps it — on the bar. It reads the room the page below already resolved
 * (`useTeamRoom`, then the roster query `RoomSurface` runs for the same id), so
 * it costs no request of its own and cannot name a different room than the one
 * on screen.
 *
 * **Nothing is drawn until the count is real.** A chip that opens on `0` and
 * corrects itself a moment later has told the reader something false about their
 * own team, and it is the sort of wrong number nobody goes back to check.
 *
 * **It opens the room sheet, which is where room management lives today.** Phase
 * R2 moves that content into the right panel and re-points this press with it;
 * the focus it asks for (`'members'`) is the part that survives the move, which
 * is why the entry point names what the reader wanted rather than which dialog
 * answers it.
 */
export function HomeMembersChip() {
  const team = useTeamRoom();
  const roomId = team.room?.id ?? null;
  const roster = useRoom(roomId);
  const [focus, setFocus] = useState<RoomDetailsFocus | null>(null);

  const room = team.room;
  const count = roster.data?.members.length;
  if (room === null || count === undefined) return null;
  // An archived #team draws no room at all — Home offers to bring it back
  // instead (`HomeRoomPage`). A head count for a conversation that is not on
  // screen, opening a sheet to manage members of a room the owner put away, is
  // a control for something that is not there.
  if (team.status === 'archived') return null;

  return (
    <>
      <BarMembersChip
        count={count}
        roomName={roomDisplayTitle(room)}
        onClick={() => setFocus('members')}
      />
      {focus !== null && (
        <RoomDetailsDialog
          room={room}
          open
          onOpenChange={(next) => !next && setFocus(null)}
          focus={focus}
        />
      )}
    </>
  );
}
