/**
 * The visual mark for a room.
 *
 * @module entities/room/ui/RoomAvatar
 */
import { cva } from 'class-variance-authority';
import { Hash, MessagesSquare } from 'lucide-react';
import type { AuthorRef, Room } from '@dorkos/shared/room-schemas';
import { cn, initialOf } from '@/layers/shared/lib';
import { IdentityAvatar } from '@/layers/shared/ui';
import { authorColor, dmCounterpart } from '../lib/room-display';

/**
 * How large a room's mark is drawn. A closed union rather than
 * `VariantProps`, which admits `null` — and `null` is exactly the value that
 * would send each variant table back to its own default again.
 */
type RoomAvatarSize = 'xs' | 'sm' | 'md';

/**
 * The size every room mark falls back to. Declared once and applied in the
 * component's own signature rather than in either variant table's
 * `defaultVariants`, because a room's mark is drawn by two different things —
 * a lucide glyph for a channel or thread, the shared identity disc for a DM —
 * and those two carry their own, different defaults. Left to them, an
 * unspecified size silently gave a channel a 14px glyph and a DM a 28px disc
 * in the same sidebar row.
 */
const DEFAULT_SIZE: RoomAvatarSize = 'xs';

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
});

export interface RoomAvatarProps {
  /** The room to draw a mark for. */
  room: Pick<Room, 'id' | 'kind' | 'title'>;
  /**
   * Who is in the room, when the caller knows — `RoomSummary.participants` from
   * the list, or the resolved roster of a room already open. Only a direct
   * message reads it.
   */
  participants?: readonly AuthorRef[] | null;
  /** How large to draw the mark. Defaults to `xs`, the sidebar's size. */
  size?: RoomAvatarSize;
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
export function RoomAvatar({
  room,
  participants,
  size = DEFAULT_SIZE,
  className,
}: RoomAvatarProps) {
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
