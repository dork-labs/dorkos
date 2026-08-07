/**
 * The people and agents in a room, as a compact row of marks.
 *
 * @module entities/room/ui/MemberList
 */
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { cn, resolveIdentityFace } from '@/layers/shared/lib';
import { IdentityAvatar, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { platformLabel } from '../lib/room-display';

/** How many marks are drawn before the rest collapse into a `+N`. */
const MAX_VISIBLE = 5;

export interface MemberListProps {
  /** The room's roster, authors already resolved. */
  members: RoomRosterEntry[];
  /**
   * Make the roster the thing you click to manage it.
   *
   * With this the whole row becomes one button rather than a list, which is
   * what the accessibility tree needs it to be: a list of tooltip triggers
   * inside a button is not something a browser will report coherently. Without
   * it the roster stays exactly what it was — a labelled list you can read and
   * cannot press.
   */
  onClick?: () => void;
  /**
   * What pressing it does. Joined to the member count to make the button's
   * accessible name, so it reads "Members of #backend, 3 members" — the action,
   * then what the discs say visually. A button named only "3 members" says what
   * it is and never what it will do; one named only for the action drops a
   * count every sighted reader can see.
   *
   * Ignored without {@link MemberListProps.onClick}, where the count alone is
   * the whole name because there is no action to describe.
   */
  label?: string;
  className?: string;
}

/**
 * Overlapping discs, one per member, with the rest counted off at the end.
 *
 * An agent wears the emoji and colour it wears everywhere else in the cockpit;
 * anyone with neither — a person, the room's own voice — gets a letter on a
 * colour hashed from their id.
 *
 * **Two shapes, chosen by whether it is pressable.** Read-only it is a labelled
 * list, each disc a tooltip trigger. Given an `onClick` it is a single button —
 * one tab stop and one action, rather than one per member — named by
 * {@link MemberListProps.label}. The pressable shape is what the room header
 * uses: it is the most obvious thing to click in a room and used to do nothing
 * at all (spec `rooms` §14.3).
 *
 * **Every disc names its member either way.** In the button that name does not
 * become the button's, because an explicit `aria-label` wins over content — but
 * it stays there for anything reading the roster off the element rather than
 * off the room.
 */
export function MemberList({ members, onClick, label, className }: MemberListProps) {
  if (members.length === 0) return null;

  const visible = members.slice(0, MAX_VISIBLE);
  const overflow = members.length - visible.length;
  const countLabel = `${members.length} ${members.length === 1 ? 'member' : 'members'}`;

  /**
   * One member's disc, carrying its member's name — and, for someone bridged
   * in from outside this machine, the platform they are on — for a screen
   * reader.
   *
   * The face comes from the shared resolver and the marks come from the disc's
   * own `kind`, so this and the member sheet's row draw one member one way. It
   * used to badge an external person and nothing else while the sheet badged
   * agents and nothing else, which meant the same agent wore a mark in one half
   * of the room and none in the other. Neither file decides it now.
   */
  const disc = ({ author, origin }: RoomRosterEntry) => {
    const isExternal = typeof origin === 'object' && origin !== null;
    const name = isExternal
      ? `${author.displayName}, from ${platformLabel(origin.platform)}`
      : author.displayName;
    return (
      <IdentityAvatar
        // Named explicitly: the tooltip trigger this stands in for would
        // otherwise stamp its own slot onto the disc.
        data-slot="room-member-avatar"
        size="xs"
        {...resolveIdentityFace({ record: author, origin })}
        // A roster disc is a step larger than the sidebar's, and rings itself in
        // the page background so the overlap still reads as separate people.
        className="border-background size-6 border"
      >
        <span className="sr-only">{name}</span>
      </IdentityAvatar>
    );
  };

  const overflowDisc = overflow > 0 && (
    <span className="border-background bg-muted text-muted-foreground inline-flex size-6 items-center justify-center rounded-full border text-[10px] font-medium">
      +{overflow}
    </span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-slot="room-member-list"
        aria-label={label ? `${label}, ${countLabel}` : countLabel}
        onClick={onClick}
        className={cn(
          'focus-visible:ring-ring hover:bg-accent flex shrink-0 items-center -space-x-1.5 rounded-full p-0.5 outline-hidden transition-colors focus-visible:ring-2',
          className
        )}
      >
        {visible.map((member) => (
          <span key={member.author.id} className="contents">
            {disc(member)}
          </span>
        ))}
        {overflowDisc}
      </button>
    );
  }

  return (
    <ul
      data-slot="room-member-list"
      aria-label={countLabel}
      className={cn('flex items-center -space-x-1.5', className)}
    >
      {visible.map((member) => (
        <li key={member.author.id}>
          <Tooltip>
            <TooltipTrigger asChild>{disc(member)}</TooltipTrigger>
            <TooltipContent>
              {typeof member.origin === 'object' && member.origin !== null
                ? `${member.author.displayName} · ${platformLabel(member.origin.platform)}`
                : member.author.displayName}
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
      {overflow > 0 && <li>{overflowDisc}</li>}
    </ul>
  );
}
