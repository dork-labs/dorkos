import { useMemo } from 'react';
import type { RoomWithRoster } from '@/layers/entities/room';
import {
  MemberList,
  RoomAvatar,
  RoomTitle,
  roomDisplayTitle,
  useOpenRoomWorking,
} from '@/layers/entities/room';

interface RoomHeaderProps {
  /** The room on screen, with its roster resolved. */
  room: RoomWithRoster;
  /** Open the members panel. The roster is what you press to get there. */
  onOpenMembers: () => void;
}

/**
 * A room's masthead: what it is called, what it is about, and who is in it —
 * and whether anything is happening in it right now.
 *
 * The roster is a button. It is the most obvious thing to click in a room and
 * until now it did nothing at all, which spec `rooms` §14.3 calls the most
 * disappointing part of this surface — so it opens the same members panel every
 * other entry point opens.
 *
 * **The working chip is here because this is where the eye is.** The presence
 * line under the composer says who and for how long, which is the detail, and
 * it is at the bottom of a scrolling column that a reader mid-history may not
 * have on screen at all. The masthead is the one part of a room that never
 * moves, so "something is running" belongs on it — and being fed by the room
 * list's own count, it is also the only thing that can say so in the first ten
 * seconds after opening a room mid-turn, before the stream republishes.
 */
export function RoomHeader({ room, onOpenMembers }: RoomHeaderProps) {
  // The open room carries its whole roster, so a DM's mark here comes from the
  // same place the sidebar's does — the members, not a hash of the room id.
  const participants = useMemo(() => room.members.map((member) => member.author), [room.members]);
  const working = useOpenRoomWorking(room.id);

  return (
    <header className="flex items-center gap-3 border-b px-4 py-3">
      <RoomAvatar room={room} participants={participants} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="flex items-center gap-2 text-sm font-medium">
          <RoomTitle room={room} />
          {room.archived && (
            <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-[10px] font-medium">
              Archived
            </span>
          )}
        </h1>
        {room.topic && <p className="text-muted-foreground truncate text-xs">{room.topic}</p>}
      </div>
      {working > 0 && (
        // A count and a dot, and no elapsed time: this says THAT something is
        // running, and the line under the composer says how long. Two clocks on
        // one screen ticking the same number is the sort of thing that makes a
        // control panel feel busy.
        //
        // Its own words rather than a bare dot with a label, because the header
        // has the room for them — and a colour-only signal is one that a reader
        // who cannot tell green from grey never receives.
        <span
          data-testid="room-header-working"
          className="text-status-success bg-status-success/10 flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
        >
          <span
            aria-hidden
            className="bg-status-success size-1.5 rounded-full motion-safe:animate-pulse"
          />
          {working === 1 ? '1 agent working' : `${working} agents working`}
        </span>
      )}
      <MemberList
        members={room.members}
        onClick={onOpenMembers}
        // Says what pressing it does, then what it is about. "5 members" alone
        // would name the thing and never the action.
        label={`Members of ${roomDisplayTitle(room)}`}
      />
    </header>
  );
}
