/**
 * Rooms — where this identity can be found, and a way into each (spec
 * `profile-unification` §1.5).
 *
 * @module features/profile/ui/pages/RoomsPage
 */
import { ChevronRight, Hash, MessagesSquare } from 'lucide-react';
import type { MemberRoom } from '@dorkos/shared/team-schemas';
import { useSafeNavigate } from '@/layers/shared/model';
import { Skeleton } from '@/layers/shared/ui';
import { useMemberRooms } from '@/layers/entities/team';
import type { ProfilePageContentProps } from './types';

/** The glyph that says what kind of room this is, at a glance. */
function RoomGlyph({ kind }: { kind: MemberRoom['kind'] }) {
  const className = 'text-muted-foreground size-3.5 shrink-0';
  // A channel wears the `#` its address is written with; a DM is a
  // conversation, and has no name of that shape to wear.
  if (kind === 'dm') return <MessagesSquare aria-hidden className={className} />;
  return <Hash aria-hidden className={className} />;
}

/** How many people are in it, in the words a row can carry. */
function memberWords(count: number): string {
  return count === 1 ? '1 member' : `${count} members`;
}

/**
 * The rooms this member is in, newest activity first.
 *
 * A list of places to go, so every row goes somewhere: tapping one opens
 * `/channels` on that room. With no router — the Obsidian embed — the rows are
 * plain text rather than buttons that do nothing.
 */
export function RoomsPage({ member }: ProfilePageContentProps) {
  const navigate = useSafeNavigate();
  const rooms = useMemberRooms(member.id);

  if (rooms.isPending) return <Skeleton className="h-16 w-full" />;

  if (rooms.isError) {
    return <p className="text-muted-foreground text-sm">Couldn’t read this member’s rooms.</p>;
  }

  const list = rooms.data?.rooms ?? [];
  if (list.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {member.isSelf ? 'You are' : `${member.displayName} is`} not in any rooms yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {list.map((room) => {
        const body = (
          <>
            <RoomGlyph kind={room.kind} />
            <span className="min-w-0 truncate text-sm">{room.name}</span>
            <span className="text-muted-foreground ml-auto shrink-0 text-xs">
              {memberWords(room.memberCount)}
            </span>
          </>
        );

        if (!navigate) {
          return (
            <div
              key={room.id}
              data-slot="profile-room-row"
              className="flex h-9 items-center gap-2 rounded-md px-2"
            >
              {body}
            </div>
          );
        }

        return (
          <button
            key={room.id}
            type="button"
            data-slot="profile-room-row"
            onClick={() => void navigate({ to: '/channels', search: { id: room.id } })}
            className="focus-ring hover:bg-muted/50 flex h-9 items-center gap-2 rounded-md px-2 text-left transition-colors"
          >
            {body}
            <ChevronRight aria-hidden className="text-muted-foreground/70 size-3.5 shrink-0" />
          </button>
        );
      })}
    </div>
  );
}
