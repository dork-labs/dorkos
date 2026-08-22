import { useState } from 'react';
import { roomDisplayTitle, useOpenRoomWorking } from '@/layers/entities/room';
import {
  RoomDetailsDialog,
  type RoomDetailsFocus,
  type RoomDetailsRoom,
} from '@/layers/features/room-management';
import { BarMembersChip } from './BarMembersChip';

interface RoomMembersChipProps {
  /** The room whose roster this counts, as the caller already holds it. */
  room: RoomDetailsRoom;
  /** How many members it has. */
  count: number;
}

/**
 * A room's head count in the bar, and the door it opens.
 *
 * The chip is {@link BarMembersChip}; what this adds is the one thing every
 * surface showing a room needs and none of them should re-decide — pressing it
 * opens that room's members. Home and `/channels` both mount it, which is what
 * keeps the press meaning the same thing on both.
 *
 * **It opens the room sheet, which is where room management lives today.** Phase
 * R2 moves that content into the right panel; when it does, this is the ONE
 * place the press is re-pointed, and the focus it asks for (`'members'`) is the
 * part that survives the move. That is why the entry point names what the reader
 * wanted rather than which surface answers it.
 *
 * The dialog is mounted only while open: a closed one would be holding a roster
 * from before the last change under it.
 */
export function RoomMembersChip({ room, count }: RoomMembersChipProps) {
  const [focus, setFocus] = useState<RoomDetailsFocus | null>(null);
  // Read here so BOTH bars get the phone's working dot from one place. It is a
  // store read, not a request — the same observer `RoomRunState` mounts, and on
  // a phone that component draws nothing, so this is the only thing left saying
  // the room is busy (spec §4).
  const working = useOpenRoomWorking(room.id);

  return (
    <>
      <BarMembersChip
        count={count}
        roomName={roomDisplayTitle(room)}
        working={working}
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
