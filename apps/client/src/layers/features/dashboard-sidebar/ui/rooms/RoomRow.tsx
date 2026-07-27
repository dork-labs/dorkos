import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { SidebarMenuItem } from '@/layers/shared/ui';
import { RoomAvatar, RoomTitle, hasUnread, roomDisplayTitle } from '@/layers/entities/room';

interface RoomRowProps {
  /** The room this row opens. */
  room: RoomSummary;
  /** Whether this room is the one currently on screen. */
  isActive: boolean;
  /** Open the room. */
  onSelect: () => void;
}

/**
 * One room in the sidebar — its mark, its name, and an unread count when the
 * reader is behind.
 *
 * The badge reads `unreadCount` strictly: `null` means "you are not in this
 * room", which is not the same as `0` ("you are in it and caught up"), so a
 * room the operator has never joined shows no badge rather than a zero.
 */
export function RoomRow({ room, isActive, onSelect }: RoomRowProps) {
  const unread = hasUnread(room);
  const name = roomDisplayTitle(room);

  return (
    <SidebarMenuItem>
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'focus-visible:ring-sidebar-ring flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs outline-hidden transition-colors duration-100 focus-visible:ring-2 active:scale-[0.98]',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          unread && !isActive && 'text-foreground font-medium'
        )}
      >
        <RoomAvatar room={room} participants={room.participants} />
        <RoomTitle room={room} className="min-w-0 flex-1" />
        {unread && (
          <span
            className="bg-brand/15 text-brand shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
            aria-label={`${room.unreadCount} unread in ${name}`}
          >
            {room.unreadCount}
          </span>
        )}
      </button>
    </SidebarMenuItem>
  );
}
