import { useSearch } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { useTeamRoomRedirect } from '../model/use-team-room-redirect';
import { RoomSurface } from './RoomSurface';

/**
 * The `/channels` page — one room's history, addressed by search param.
 *
 * `?id=` addresses the room and `?thread=` the thread open beside it. Both are
 * read here and handed to {@link RoomSurface}, which IS the room: this component
 * is the address and nothing else. The home tab renders the same surface for
 * #team without going through this route (team-room-home spec D3.2), which is
 * why the two halves are apart at all — one room widget, reached from two
 * addresses, never copied.
 *
 * **One room #team is NOT reached through: its own.** `?id=<team>` is Home's
 * room at a second address, so it is sent to Home instead of drawn here — see
 * {@link useTeamRoomRedirect} for why that is a redirect rather than a duplicate
 * (spec §3.5). Every other id is unaffected.
 */
export function ChannelsPage() {
  const { id, thread } = useSearch({ from: '/_shell/channels' });
  const teamRoom = useTeamRoomRedirect(id, thread);

  // Mid-move, or not yet sure whether this is a move. Either way the honest
  // thing to draw is nothing: the alternative is this room appearing for a frame
  // on its way somewhere else.
  if (teamRoom !== 'show') return null;

  if (id === undefined) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm">
        <MessagesSquare className="text-muted-foreground/50 size-10" aria-hidden />
        <p className="text-foreground font-medium">Pick a conversation</p>
        <p className="max-w-sm">
          Channels and direct messages live in the sidebar. Open one to read it, or make a new
          channel to get a few agents talking in the same place.
        </p>
      </div>
    );
  }

  return <RoomSurface roomId={id} threadId={thread} threadRoute="/channels" />;
}
