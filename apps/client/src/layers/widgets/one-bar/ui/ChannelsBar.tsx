import {
  BridgeVisibilityBadge,
  RoomAvatar,
  RoomTitle,
  roomDisplayTitle,
  useTeamRoom,
} from '@/layers/entities/room';
import { facesOfRoster, useRoomFaces } from '@/layers/features/room-management';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useOneBarState } from '../model/one-bar-context';
import { BarTitle, OneBar } from './OneBar';
import { RoomMembersChip } from './RoomMembersChip';
import { RoomRunState } from './RoomRunState';

/**
 * A room's identity in 36px: its mark, its name, and what it is about.
 *
 * **The topic yields first, and the shrink factors are what make that true
 * (I2).** Both the name and the topic are flex items, so the naive arrangement —
 * two items each free to shrink — makes them shrink IN PROPORTION TO THEIR
 * CONTENT, which is the opposite of the rule: a long topic beside a short name
 * ate the name first, and `#general` read as `#gen…` beside a topic with room to
 * spare. Giving the topic an enormous shrink factor makes it absorb essentially
 * all of the deficit, so it truncates away to nothing before the name gives up a
 * pixel; the name's `min-w` floor is what still lets it ellipsize as a LAST
 * resort rather than overflowing the row (spec §5 case 1). Below `sm` the topic
 * is not drawn at all — a phone's bar spends every pixel on the name.
 *
 * Both keep their full text in a `title`, so nothing is unreadable, only
 * abbreviated.
 *
 * **An `h1`, because this row is now the page's identity.** The masthead that
 * carried the room's heading is gone, and a page whose only name lives in a
 * `span` has no heading at all — which is a real regression for anyone
 * navigating by headings, not merely a selector detail. `RoomTitle` supplies the
 * accessible name (`#general`) while the eye reads the bare slug.
 *
 * **The real face, and the glyph only where a room HAS no face** (phase R2). R1
 * drew a glyph for both kinds, because the fleet's agent emoji came from a
 * directory this layer could not reach — and a hashed letter here would have
 * contradicted the emoji the sidebar shows two inches away. That cost landed
 * hardest on a one-to-one, whose identity IS the agent it is with and which the
 * `sidebar-simplification` work had already taken out of the sidebar: between
 * the two phases its face was drawn nowhere at all. The join now lives one layer
 * down, in `room-management`, and is READ here rather than re-made — the same
 * answer the room panel's roster draws, so the two cannot disagree. A channel is
 * still a `#`, which is what a channel's mark is.
 */
function RoomIdentity({ room }: { room: RoomWithRoster }) {
  const faces = useRoomFaces();
  const visuals = facesOfRoster(room.members, faces);

  return (
    <div className="flex min-w-0 shrink items-center gap-1.5">
      <RoomAvatar
        room={room}
        participants={room.members.map((member) => member.author)}
        visuals={visuals}
        size="xs"
        className="shrink-0"
      />
      <h1 className="flex min-w-[6ch] shrink items-center text-sm font-medium">
        <RoomTitle room={room} />
      </h1>
      {room.topic && (
        <span
          className="text-muted-foreground hidden min-w-0 shrink-[99999] truncate text-xs sm:inline"
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
  const team = useTeamRoom();

  // **#team never gets a room bar HERE, because this route never shows it.**
  // `?id=<team>` redirects to Home (spec §3.5), and while that navigation is in
  // flight the page below has already stopped drawing the room — so a bar
  // announcing `#team` sat over an empty pane for those frames, which is the
  // flash the redirect was added to prevent, relocated to the header. Resolved
  // from `useTeamRoom` rather than from the page's redirect hook because a
  // widget may not import another widget; both read the same room list, so they
  // cannot disagree about which room is #team.
  const leavingForHome = room !== null && team.room?.id === room.id;

  if (room === null || leavingForHome) return <OneBar identity={<BarTitle>Channels</BarTitle>} />;

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
