/**
 * The people and agents in a room, as a compact row of marks.
 *
 * @module entities/room/ui/MemberList
 */
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { cn, initialOf } from '@/layers/shared/lib';
import { IdentityAvatar, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { authorColor } from '../lib/room-display';

/** How many marks are drawn before the rest collapse into a `+N`. */
const MAX_VISIBLE = 5;

export interface MemberListProps {
  /** The room's roster, authors already resolved. */
  members: RoomRosterEntry[];
  className?: string;
}

/**
 * Overlapping discs, one per member, with the rest counted off at the end.
 *
 * An agent wears the emoji and colour it wears everywhere else in the cockpit;
 * anyone with neither — a person, the room's own voice — gets a letter on a
 * colour hashed from their id. Each disc names its member on hover and to a
 * screen reader, so the roster is readable without opening anything.
 */
export function MemberList({ members, className }: MemberListProps) {
  if (members.length === 0) return null;

  const visible = members.slice(0, MAX_VISIBLE);
  const overflow = members.length - visible.length;

  return (
    <ul
      data-slot="room-member-list"
      aria-label={`${members.length} ${members.length === 1 ? 'member' : 'members'}`}
      className={cn('flex items-center -space-x-1.5', className)}
    >
      {visible.map(({ author }) => (
        <li key={author.id}>
          <Tooltip>
            <TooltipTrigger asChild>
              <IdentityAvatar
                // Named explicitly: the tooltip trigger this stands in for
                // would otherwise stamp its own slot onto the disc.
                data-slot="room-member-avatar"
                size="xs"
                color={author.color ?? authorColor(author.id)}
                emoji={author.emoji}
                fallback={initialOf(author.displayName)}
                // A roster disc is a step larger than the sidebar's, and rings
                // itself in the page background so the overlap still reads as
                // separate people.
                className="border-background size-6 border"
              >
                <span className="sr-only">{author.displayName}</span>
              </IdentityAvatar>
            </TooltipTrigger>
            <TooltipContent>{author.displayName}</TooltipContent>
          </Tooltip>
        </li>
      ))}
      {overflow > 0 && (
        <li>
          <span className="border-background bg-muted text-muted-foreground inline-flex size-6 items-center justify-center rounded-full border text-[10px] font-medium">
            +{overflow}
          </span>
        </li>
      )}
    </ul>
  );
}
