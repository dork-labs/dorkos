/**
 * The visual mark for a room.
 *
 * @module entities/room/ui/RoomAvatar
 */
import { cva, type VariantProps } from 'class-variance-authority';
import { Hash, MessagesSquare } from 'lucide-react';
import type { AuthorRef, Room } from '@dorkos/shared/room-schemas';
import { cn, initialOf } from '@/layers/shared/lib';
import { IdentityAvatar } from '@/layers/shared/ui';
import { authorColor, dmCounterpart } from '../lib/room-display';

/** The channel/thread glyph scales with `size` too, so it reads at the same
 * visual weight as the disc it stands in for at that size. */
const roomAvatarIconVariants = cva('text-muted-foreground shrink-0', {
  variants: {
    size: {
      xs: 'size-3.5',
      sm: 'size-5',
      md: 'size-6',
    },
  },
  defaultVariants: { size: 'xs' },
});

export interface RoomAvatarProps extends VariantProps<typeof roomAvatarIconVariants> {
  /** The room to draw a mark for. */
  room: Pick<Room, 'id' | 'kind' | 'title'>;
  /**
   * Who is in the room, when the caller knows — `RoomSummary.participants` from
   * the list, or the resolved roster of a room already open. Only a direct
   * message reads it.
   */
  participants?: readonly AuthorRef[] | null;
  className?: string;
}

/**
 * A room's mark: `#` for a channel, a branch glyph for a thread, and for a
 * direct message the agent it is with — the same emoji and colour that agent
 * carries everywhere else in the cockpit.
 *
 * A DM whose roster the caller does not have, or one whose join never put an
 * agent in it, falls back to a letter disc tinted from the room's own id. That
 * is stable and honest: guessing an agent from the room's title would silently
 * swap a person's avatar the moment two agents shared a display name.
 *
 * Decorative — every use sits beside the room's name in text, so the mark is
 * hidden from assistive technology.
 */
export function RoomAvatar({ room, participants, size, className }: RoomAvatarProps) {
  if (room.kind === 'channel') {
    return (
      <Hash
        aria-hidden
        data-slot="room-avatar"
        className={cn(roomAvatarIconVariants({ size }), className)}
      />
    );
  }

  if (room.kind === 'thread') {
    return (
      <MessagesSquare
        aria-hidden
        data-slot="room-avatar"
        className={cn(roomAvatarIconVariants({ size }), className)}
      />
    );
  }

  const counterpart = dmCounterpart(participants);
  return (
    <IdentityAvatar
      aria-hidden
      data-slot="room-avatar"
      size={size}
      color={counterpart?.color ?? authorColor(counterpart?.id ?? room.id)}
      emoji={counterpart?.emoji}
      fallback={initialOf(counterpart?.displayName ?? room.title)}
      className={className}
    />
  );
}
