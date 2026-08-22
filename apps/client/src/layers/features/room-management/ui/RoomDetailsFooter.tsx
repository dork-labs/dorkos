/**
 * The foot of the room panel: how old the room is, and the one verb that
 * retires it.
 *
 * @module features/room-management/ui/RoomDetailsFooter
 */
import { formatRelativeTime } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { useArchiveRoom, useUnarchiveRoom } from '@/layers/entities/room';
import type { RoomDetailsRoom } from '../model/room-details';

export interface RoomDetailsFooterProps {
  /** The room, as freshly as it has been read. */
  room: RoomDetailsRoom;
}

/**
 * When the room was made, and Archive — or, if it already is, the way back.
 *
 * **No confirmation here, and that is not an oversight.** The sidebar row's
 * "Archive channel" keeps its alert, because it fires from a menu over a row in
 * a list of rooms and the classic mistake there is archiving the wrong one. This
 * button is at the foot of the panel for the room you are reading, and pressing
 * it changes that same panel in front of you: the name grows an "Archived" badge
 * and this button becomes "Bring this room back". The state IS the confirmation,
 * and the undo is where the action was — which is better than an alert, not a
 * cheaper version of one.
 *
 * A modal alert would also be the dialog-over-a-dialog that `RemoveMemberConfirm`
 * exists to avoid: answering the inner one reaches the outer as an interaction
 * from outside it, and both close.
 *
 * Archiving is genuinely reversible — nothing is deleted and everything said is
 * kept — which is what makes "Archive" the honest verb rather than a delete
 * wearing a softer word.
 */
export function RoomDetailsFooter({ room }: RoomDetailsFooterProps) {
  const archiveRoom = useArchiveRoom();
  const unarchiveRoom = useUnarchiveRoom();
  const isBusy = archiveRoom.isPending || unarchiveRoom.isPending;

  // No per-call callbacks either way: the shared mutation toast names the
  // action from each hook's `meta` and appends the server's own sentence, which
  // is the only path that still reports if the room is closed mid-write.
  const toggle = () => {
    if (room.archived) unarchiveRoom.mutate({ roomId: room.id });
    else archiveRoom.mutate(room.id);
  };

  return (
    <div className="text-muted-foreground flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3 text-xs">
      <span>Created {formatRelativeTime(room.createdAt)}</span>
      <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={toggle}>
        {room.archived ? 'Bring this room back' : 'Archive room'}
      </Button>
    </div>
  );
}
