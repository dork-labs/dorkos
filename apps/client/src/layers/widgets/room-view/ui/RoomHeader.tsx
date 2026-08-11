import { useMemo } from 'react';
import { CircleStop } from 'lucide-react';
import type { RoomWithRoster } from '@/layers/entities/room';
import {
  BridgeVisibilityBadge,
  MemberList,
  RoomAvatar,
  RoomTitle,
  roomDisplayTitle,
  useHaltRoom,
  useOpenRoomWorking,
} from '@/layers/entities/room';
import { Button } from '@/layers/shared/ui';
import { useRoomAgentDirectory } from '../model/agent-info-context';

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
  // The masthead is a widget, so it can do the one thing `MemberList` cannot:
  // ask the fleet what each agent actually looks like. Without this the roster
  // stack falls to the author row's cache, which almost no agent fills — and
  // the same agent wearing its face in the sidebar wore a letter up here.
  const agents = useRoomAgentDirectory();
  const working = useOpenRoomWorking(room.id);
  const halt = useHaltRoom();

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
      {/* Sourced from the bridge row's own `visibility`, never from config —
          and never rendered for a DM, where `room.bridge?.visibility` is
          always `null` (privacy mode is a group concept, spec §8). Outside
          the `h1` on purpose: it is a disclosure with its own accessible
          name, and a heading whose name silently grew "sees mentions only"
          would say something no reader asked the room's TITLE to say. */}
      {room.bridge?.visibility && <BridgeVisibilityBadge visibility={room.bridge.visibility} />}
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
      {working > 0 && (
        // **Beside the count, and only while there is a count.** Stopping a room
        // that is doing nothing is a button that does nothing, and a control
        // panel that offers one teaches its reader to distrust the rest.
        //
        // It is also the only way to stop a room, and that is the whole design:
        // typing "stop" into the composer sends a message, which is what a
        // person means about a third of the time and never what a looping agent
        // hears (room-participation spec §10.4). Pressing this reaches the
        // runtimes instead.
        //
        // Deliberately NOT `destructive`. Nothing is destroyed — the turns stop
        // and what they already said stays — and red would put the room's most
        // ordinary recovery action in the same register as deleting something.
        <Button
          data-testid="room-header-halt"
          variant="outline"
          size="xs"
          disabled={halt.isPending}
          onClick={() => halt.mutate({ roomId: room.id })}
        >
          <CircleStop aria-hidden className="size-3.5" />
          Stop
        </Button>
      )}
      <MemberList
        members={room.members}
        onClick={onOpenMembers}
        facesByRef={agents.faces}
        // Says what pressing it does, then what it is about. "5 members" alone
        // would name the thing and never the action.
        label={`Members of ${roomDisplayTitle(room)}`}
      />
    </header>
  );
}
