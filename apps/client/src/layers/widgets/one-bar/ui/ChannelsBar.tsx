import { AtSign, Hash } from 'lucide-react';
import { BridgeVisibilityBadge, RoomTitle, roomDisplayTitle } from '@/layers/entities/room';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useOneBarState } from '../model/one-bar-context';
import { BarTitle, OneBar } from './OneBar';
import { RoomMembersChip } from './RoomMembersChip';
import { RoomRunState } from './RoomRunState';

/**
 * A room's identity in 36px: its mark, its name, and what it is about.
 *
 * **The topic hides first (I2), and it is built to.** It is the one part of this
 * a reader can lose without losing the room, so it carries the `min-w-0` and the
 * truncation while the name keeps its natural width — and below `sm` it is not
 * drawn at all, because a phone's bar is spending every pixel on the name and
 * the chips. Both name and topic keep their full text in a `title`, so a room
 * called something long is still readable by hovering it (spec §5 case 1).
 *
 * **A glyph, not a face.** The masthead drew a `RoomAvatar` with the fleet's
 * real agent emoji behind it, which this layer cannot reach: the faces come from
 * the room widget's own directory, and a widget may not import another widget.
 * Drawing the avatar anyway would fall back to a hashed letter — the same agent
 * wearing its emoji in the sidebar and a letter up here, which is the exact
 * disagreement the masthead was fixed to remove. So the bar shows no face rather
 * than a wrong one, and says which KIND of room this is instead.
 */
function RoomIdentity({ room }: { room: RoomWithRoster }) {
  const Mark = room.kind === 'channel' ? Hash : AtSign;

  return (
    <div className="flex min-w-0 shrink items-center gap-1.5">
      <Mark aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      <RoomTitle room={room} className="text-sm font-medium" />
      {room.topic && (
        <span
          className="text-muted-foreground hidden min-w-0 truncate text-xs sm:inline"
          title={room.topic}
        >
          {room.topic}
        </span>
      )}
    </div>
  );
}

/**
 * The `/channels` bar — the room you are reading, and what is true of it.
 *
 * The room is read once, in the app shell (`useRoomDocumentTitle`), and reaches
 * this through `useOneBarState` rather than being re-queried here: the same
 * room, resolved the same way the browser tab already resolves it, so the two
 * can never disagree about what is open. Without a bar of its own this route
 * once fell through to the shell's `default` branch and every channel and DM
 * read "Dashboard" (DOR-587).
 *
 * **This is the room's ONLY masthead now.** `RoomHeader` — the second, stacked
 * row that said the name again under this one — is deleted with this bar (spec
 * §3.4, phase R1). Everything it carried is here: the archived badge, the bridge
 * visibility badge, the working count, the room-wide Stop, and the roster as a
 * head count you can press.
 *
 * **No room, no room bar.** Before an id is picked, and when the id names a room
 * that is not there, the page below says so in full sentences and the bar says
 * only "Channels" (spec §5 case 6). A bar naming a room the page cannot show
 * would be the worse half of that pair.
 */
export function ChannelsBar() {
  const { room } = useOneBarState();

  if (room === null) return <OneBar identity={<BarTitle>Channels</BarTitle>} />;

  const name = roomDisplayTitle(room);

  return (
    <OneBar
      identity={<RoomIdentity room={room} />}
      chips={
        <>
          {room.archived && (
            <span className="text-muted-foreground bg-muted shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">
              Archived
            </span>
          )}
          {/* Sourced from the bridge row's own `visibility`, never from config —
              and never rendered for a DM, where it is always `null` (privacy
              mode is a group concept, rooms spec §8). */}
          {room.bridge?.visibility && <BridgeVisibilityBadge visibility={room.bridge.visibility} />}
          <RoomRunState roomId={room.id} roomName={name} />
          <RoomMembersChip room={room} count={room.members.length} />
        </>
      }
    />
  );
}
