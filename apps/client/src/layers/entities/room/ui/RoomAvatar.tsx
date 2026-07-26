/**
 * The visual mark for a room.
 *
 * @module entities/room/ui/RoomAvatar
 */
import { cva, type VariantProps } from 'class-variance-authority';
import { Hash, MessagesSquare } from 'lucide-react';
import type { Room } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { authorColor, initialOf } from '../lib/room-display';

const roomAvatarVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full font-medium',
  {
    variants: {
      size: {
        xs: 'size-5 text-[10px]',
        sm: 'size-7 text-xs',
        md: 'size-9 text-sm',
      },
    },
    defaultVariants: { size: 'xs' },
  }
);

export interface RoomAvatarProps extends VariantProps<typeof roomAvatarVariants> {
  /** The room to draw a mark for. */
  room: Pick<Room, 'id' | 'kind' | 'title'>;
  className?: string;
}

/**
 * A room's mark: `#` for a channel, a branch glyph for a thread, and a tinted
 * letter disc for a direct message.
 *
 * The tint is hashed from the room's own id rather than from whoever is in it.
 * A DM's roster is not on the list endpoint, and guessing an agent from the
 * room's title would silently swap a person's avatar the moment two agents
 * shared a display name. Hashing is stable, honest, and needs no second fetch.
 *
 * Decorative — every use sits beside the room's name in text, so the mark is
 * hidden from assistive technology.
 */
export function RoomAvatar({ room, size, className }: RoomAvatarProps) {
  if (room.kind === 'channel') {
    return (
      <Hash
        aria-hidden
        data-slot="room-avatar"
        className={cn('text-muted-foreground size-3.5 shrink-0', className)}
      />
    );
  }

  if (room.kind === 'thread') {
    return (
      <MessagesSquare
        aria-hidden
        data-slot="room-avatar"
        className={cn('text-muted-foreground size-3.5 shrink-0', className)}
      />
    );
  }

  const color = authorColor(room.id);
  return (
    <span
      aria-hidden
      data-slot="room-avatar"
      className={cn(roomAvatarVariants({ size }), className)}
      // Mixed from a per-room hashed color Tailwind cannot know at build time —
      // the same reason AgentAvatar styles its background inline.
      style={{ backgroundColor: `color-mix(in oklch, ${color} 18%, transparent)` }}
    >
      {initialOf(room.title)}
    </span>
  );
}
