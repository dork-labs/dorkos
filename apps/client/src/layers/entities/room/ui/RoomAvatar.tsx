/**
 * The visual mark for a room.
 *
 * @module entities/room/ui/RoomAvatar
 */
import { cva } from 'class-variance-authority';
import { Hash } from 'lucide-react';
import type { AuthorRef, Room } from '@dorkos/shared/room-schemas';
import { cn, initialOf, type AgentVisual } from '@/layers/shared/lib';
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
 * a lucide glyph for a channel, the shared identity disc for a DM — and those
 * two carry their own, different defaults. Left to them, an unspecified size
 * silently gave a channel a 14px glyph and a DM a 28px disc in the same
 * sidebar row.
 */
const DEFAULT_SIZE: RoomAvatarSize = 'xs';

/** The channel glyph scales with `size` too, so it reads at the same
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

/**
 * How many faces a group conversation's mark draws, and how far they overlap,
 * per size.
 *
 * **`xs` is the sidebar, and the sidebar's slot is 18px wide.** Three faces at
 * `-space-x-1.5` measure 48px there: they used to run 7px UNDER the room's own
 * title, and two measured 34px, which spilled past the gutter every other row's
 * glyph starts on. Two faces at −14px measure 18 + 18 − 14 = 22px — the room
 * between the slot and the label column, exactly (design-decisions §1).
 *
 * `sm` and `md` are drawn in roomier places (the masthead, the picker), so they
 * keep three and the roster's own overlap, which is what makes a group's mark
 * and the room header's roster read as one idea.
 */
const FACE_STACK = {
  xs: { maxFaces: 2, overlap: '-space-x-3.5' },
  sm: { maxFaces: 3, overlap: '-space-x-1.5' },
  md: { maxFaces: 3, overlap: '-space-x-1.5' },
} as const satisfies Record<RoomAvatarSize, { maxFaces: number; overlap: string }>;

export interface RoomAvatarProps {
  /** The room to draw a mark for. */
  room: Pick<Room, 'id' | 'kind' | 'title'>;
  /**
   * Who is in the room, when the caller knows — `RoomSummary.participants` from
   * the list, or the resolved roster of a room already open. Only a direct
   * message reads it, and only to fall back on when {@link RoomAvatarProps.visuals}
   * is absent.
   */
  participants?: readonly AuthorRef[] | null;
  /**
   * The faces of the agents in a direct message, already resolved against the
   * fleet by the caller.
   *
   * **This is what makes the mark a face rather than a letter (DOR-582).** An
   * agent's emoji and colour are a client-side hash of its manifest id whenever
   * it has no stored override, which is the case for most of a real fleet — so
   * `AuthorRef.emoji`, a server-side render cache, is empty for nearly everyone
   * and the fallback below drew a letter for them. Only the caller can resolve
   * the real face, because only it can match a participant back to the fleet.
   *
   * One face draws one disc, several draw a stack. Absent or empty falls back to
   * the letter disc.
   */
  visuals?: readonly AgentVisual[] | null;
  /** How large to draw the mark. Defaults to `xs`, the sidebar's size. */
  size?: RoomAvatarSize;
  /**
   * How many faces a group conversation's stack draws before it stops.
   * Defaults to {@link FACE_STACK}'s entry for {@link RoomAvatarProps.size}.
   */
  maxFaces?: number;
  /**
   * How far the faces in that stack overlap, as a Tailwind `-space-x-*` class.
   * Defaults to {@link FACE_STACK}'s entry for {@link RoomAvatarProps.size}.
   */
  overlap?: string;
  className?: string;
}

/**
 * A room's mark: `#` for a channel, and for a direct message the agent it is
 * with — the same emoji and colour that agent carries everywhere else in the
 * cockpit. A conversation with several agents in it draws them as a stack, so a
 * group reads as a group before you read its name.
 *
 * **A DM's face is an agent's face, and is drawn as one** — the filled square
 * with the bot mark, not the round person disc. The mark said "agent" in its
 * colour and emoji and "person" in its shape, in the sidebar, the masthead and
 * the command palette at once, because all three draw this one component.
 *
 * A DM whose faces the caller has not resolved falls back to a letter disc
 * tinted from the room's own id. That is stable and honest: guessing an agent
 * from the room's title would silently swap a person's avatar the moment two
 * agents shared a display name.
 *
 * Decorative — every use sits beside the room's name in text, so the mark is
 * hidden from assistive technology.
 */
export function RoomAvatar({
  room,
  participants,
  visuals,
  size = DEFAULT_SIZE,
  maxFaces = FACE_STACK[size].maxFaces,
  overlap = FACE_STACK[size].overlap,
  className,
}: RoomAvatarProps) {
  // Everything that is not a direct message is a place, and a place is drawn
  // `#`. Written as "not a DM" rather than "is a channel" because the fallback
  // matters more than the match: a DM's mark is a person's face, and the one
  // outcome worth ruling out is a room being handed somebody's face because its
  // kind was not the one this branch expected.
  if (room.kind !== 'dm') {
    return (
      <Hash
        aria-hidden
        data-slot="room-avatar"
        className={cn(roomAvatarIconVariants({ size }), className)}
      />
    );
  }

  const faces = (visuals ?? []).slice(0, maxFaces);

  if (faces.length === 1) {
    return (
      <IdentityAvatar
        aria-hidden
        data-slot="room-avatar"
        // A direct message's counterpart is an agent by construction — that is
        // what `dmCounterpart` looks for and all a DM can be with. Saying so
        // here is what makes the sidebar row, the room masthead and the command
        // palette draw the agent shape, since all three draw this mark.
        kind="agent"
        size={size}
        color={faces[0]!.color}
        emoji={faces[0]!.emoji}
        className={className}
      />
    );
  }

  if (faces.length > 1) {
    return (
      <span
        aria-hidden
        data-slot="room-avatar"
        className={cn('flex shrink-0 items-center', overlap, className)}
      >
        {faces.map((face, i) => (
          <IdentityAvatar
            // Faces come in roster order and a roster is deterministic
            // (`RoomStore.listMembers`), so position is a stable identity here —
            // and two agents can legitimately hash to the same emoji, which
            // rules the face itself out as a key.
            key={i}
            kind="agent"
            size={size}
            color={face.color}
            emoji={face.emoji}
          />
        ))}
      </span>
    );
  }

  const counterpart = dmCounterpart(participants);
  return (
    <IdentityAvatar
      aria-hidden
      data-slot="room-avatar"
      // Only when there IS a counterpart: it is an agent, and the same DM must
      // not change shape depending on whether its face happened to resolve.
      // With no counterpart this is the room's own letter and nobody's face, so
      // it claims nothing.
      kind={counterpart === null ? undefined : 'agent'}
      size={size}
      color={counterpart?.color ?? authorColor(counterpart?.id ?? room.id)}
      emoji={counterpart?.emoji}
      // Only this branch can carry one: `visuals` above is a fleet-resolved
      // `AgentVisual`, which is emoji and colour and has no photo in it. Here
      // the counterpart is a full `AuthorRef` off the roster, so whatever the
      // render cache holds for them reaches the disc.
      imageUrl={counterpart?.imageUrl}
      fallback={initialOf(counterpart?.displayName ?? room.title)}
      className={className}
    />
  );
}
