/**
 * A room's name, written the way people say it.
 *
 * @module entities/room/ui/RoomTitle
 */
import type { Room } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { roomDisplayTitle } from '../lib/room-display';

export interface RoomTitleProps {
  /** The room to name. */
  room: Pick<Room, 'kind' | 'slug' | 'title'>;
  className?: string;
}

/**
 * Renders a room's display name — `#slug` for a channel, the title otherwise —
 * truncated to its container with the full name kept in the tooltip.
 */
export function RoomTitle({ room, className }: RoomTitleProps) {
  const label = roomDisplayTitle(room);
  return (
    <span data-slot="room-title" title={label} className={cn('truncate', className)}>
      {label}
    </span>
  );
}
