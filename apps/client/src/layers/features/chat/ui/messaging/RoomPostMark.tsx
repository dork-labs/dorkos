/**
 * "· in #room" beside the author of a room post that opened a turn in a
 * room-attached chat (DOR-2113). Part of the author line, so where the message
 * came from is never behind a hover, and it links to the room.
 *
 * @module features/chat/ui/messaging/RoomPostMark
 */
import { useNavigate } from '@tanstack/react-router';
import type { RoomMessageStamp } from '@dorkos/shared/chat-messages';
import { appRoutes } from '@/layers/shared/lib';

/**
 * The room a post came from, as a link to that room.
 *
 * @param props - The stamp the server put on the message.
 */
export function RoomPostMark({ stamp }: { stamp: RoomMessageStamp }) {
  const navigate = useNavigate();
  const room = stamp.roomLabel ?? 'a room';
  return (
    <span
      data-testid="room-post-mark"
      className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs"
    >
      <span aria-hidden>·</span>
      <span>in</span>
      <button
        type="button"
        aria-label={`Open ${room}`}
        onClick={() => void navigate({ ...appRoutes.channels(), search: { id: stamp.roomId } })}
        className="focus-ring text-foreground/80 hover:text-foreground max-w-48 truncate underline-offset-4 hover:underline"
      >
        {room}
      </button>
    </span>
  );
}
