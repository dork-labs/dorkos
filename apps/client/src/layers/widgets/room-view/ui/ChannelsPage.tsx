import { useSearch } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { useTeamRoomRedirect } from '../model/use-team-room-redirect';
import { RoomHistorySkeleton } from './RoomFlow';
import { RoomSurface } from './RoomSurface';

/**
 * The `/channels` page — one room's history, addressed by search param.
 *
 * `?id=` addresses the room, `?thread=` the thread open beside it, and
 * `?entry=` the one message it should open on — the address a message-search
 * hit navigates to (DOR-687). All three are read here and handed to
 * {@link RoomSurface}, which IS the room: this component is the address and
 * nothing else. The home tab renders the same surface for
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
  const { id, thread, entry } = useSearch({ from: '/_shell/channels' });
  const teamRoom = useTeamRoomRedirect(id, thread, entry);

  // **Not yet sure whether this id is Home's room — so draw the room's own
  // loading state, not a blank pane.** This branch is taken by EVERY room on a
  // cold load, not just #team: the answer comes from the room list, and until
  // that list lands nobody can say which room this is. Rendering nothing meant a
  // deep link opened onto an empty page for as long as the list took, which
  // reads as a broken link rather than a loading one. The skeleton is what
  // `RoomSurface` would be drawing at this exact moment anyway, so the handover
  // is invisible.
  if (teamRoom === 'pending') {
    return (
      <div className="flex h-full flex-col" aria-busy>
        <RoomHistorySkeleton />
      </div>
    );
  }

  // Mid-move: the navigation is already in flight, so this room is about to stop
  // being the answer. Drawing it for those frames is the flash the redirect
  // exists to avoid.
  if (teamRoom === 'redirecting') return null;

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

  return <RoomSurface roomId={id} threadId={thread} entrySeq={entry} threadRoute="/channels" />;
}
