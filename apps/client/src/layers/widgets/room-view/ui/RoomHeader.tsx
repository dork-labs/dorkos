import type { RoomWithRoster } from '@/layers/entities/room';
import { MemberList, RoomAvatar, RoomTitle } from '@/layers/entities/room';

interface RoomHeaderProps {
  /** The room on screen, with its roster resolved. */
  room: RoomWithRoster;
}

/**
 * A room's masthead: what it is called, what it is about, and who is in it.
 */
export function RoomHeader({ room }: RoomHeaderProps) {
  return (
    <header className="flex items-center gap-3 border-b px-4 py-3">
      <RoomAvatar room={room} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="flex items-center gap-2 text-sm font-medium">
          <RoomTitle room={room} />
          {room.archived && (
            <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-[10px] font-medium">
              Archived
            </span>
          )}
        </h1>
        {room.topic && <p className="text-muted-foreground truncate text-xs">{room.topic}</p>}
      </div>
      <MemberList members={room.members} />
    </header>
  );
}
