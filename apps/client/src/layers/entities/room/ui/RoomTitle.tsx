/**
 * A room's name, written the way people say it.
 *
 * @module entities/room/ui/RoomTitle
 */
import type { Room } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { roomDisplayTitle, roomName } from '../lib/room-display';

export interface RoomTitleProps {
  /** The room to name. */
  room: Pick<Room, 'kind' | 'slug' | 'title'>;
  className?: string;
}

/**
 * Renders a room's name beside the mark `RoomAvatar` draws for it — so a channel
 * reads `general` next to its `#`, not `# #general`. Truncated to its container,
 * with the spoken name kept in the tooltip.
 *
 * A channel's `#` is a decorative glyph, so it would be lost to anyone not
 * looking at it. The spoken name (`#general`) therefore rides along as `sr-only`
 * text while the visible name is hidden from assistive technology — the same
 * split `MemberList` draws between an agent's emoji disc and its name. Two
 * elements rather than an `aria-label` on the span, because ARIA prohibits
 * `aria-label` on an element with no role and a browser may drop it.
 *
 * A room whose name carries no mark — a DM, a thread — renders as one text node,
 * because there is nothing for the two forms to disagree about.
 */
export function RoomTitle({ room, className }: RoomTitleProps) {
  const spoken = roomDisplayTitle(room);
  const name = roomName(room);

  return (
    <span data-slot="room-title" title={spoken} className={cn('truncate', className)}>
      {spoken === name ? (
        name
      ) : (
        <>
          <span className="sr-only">{spoken}</span>
          <span aria-hidden>{name}</span>
        </>
      )}
    </span>
  );
}
