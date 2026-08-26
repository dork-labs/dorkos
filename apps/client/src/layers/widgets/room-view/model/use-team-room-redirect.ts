/**
 * One door to #team: `/channels?id=<team>` is Home, so it goes there.
 *
 * @module widgets/room-view/model/use-team-room-redirect
 */
import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTeamRoom } from '@/layers/entities/room';

/** What {@link useTeamRoomRedirect} tells `/channels` to do with this id. */
export type TeamRoomRedirect =
  /** Not the team room (or there is no id) — draw the channel. */
  | 'show'
  /** It IS the team room, and Home is being navigated to. Draw nothing. */
  | 'redirecting'
  /** Not known yet. Draw nothing rather than a room that may be about to move. */
  | 'pending';

/**
 * Send `/channels?id=<team>` to `/`, carrying `?thread=` and `?entry=` with it.
 *
 * **Why a redirect and not a second copy of Home.** #team was reachable at two
 * addresses that drew the same room differently — Home with its triage header
 * and starter chips, `/channels` with neither — so which one you got depended on
 * which link you happened to press, and a bookmark could quietly be the lesser
 * of the two. One room, one address (spec §3.5, B1).
 *
 * **Nothing is drawn while the answer is unknown**, which is the ordering that
 * makes this flash-free. Rendering the channel view first and correcting a frame
 * later would show the room without its Home chrome, then swap it — the exact
 * flicker the spec rules out. In practice the wait is not visible: the answer
 * comes from the room list, which the shell keeps warm app-wide
 * (`useRoomDocumentTitle` owns its subscription), so on any cockpit that has
 * been open for a moment this is a cache read and resolves on the first render.
 *
 * **`replace`, not a push.** The team id is an address that no longer exists;
 * leaving it in history means Back walks into a redirect that bounces the reader
 * straight forward again.
 *
 * Every other room is untouched — `'show'` is the answer for any id that is not
 * #team, and for no id at all.
 *
 * **Every param that addresses a PLACE INSIDE the room travels with it**, or
 * the move quietly discards what the link was for: a message-search hit in
 * #team addresses `/channels?id=<team>&entry=<seq>`, and a redirect that kept
 * only the room would land the reader at the bottom of Home with the message
 * they clicked nowhere in sight.
 *
 * @param roomId - The `?id=` on the route, if there is one.
 * @param threadId - The `?thread=` on the route, carried through the move.
 * @param entrySeq - The `?entry=` on the route, carried through the move.
 */
export function useTeamRoomRedirect(
  roomId: string | undefined,
  threadId: string | undefined,
  entrySeq?: number
): TeamRoomRedirect {
  const team = useTeamRoom();
  const navigate = useNavigate();

  // An archived #team still answers here: `useTeamRoom` reports the room in that
  // state too, and Home is where the offer to bring it back lives. Sending an
  // archived team id to `/channels` instead would draw the room the owner put
  // away, which is the decision Home deliberately does not overrule.
  const isTeamRoom = roomId !== undefined && team.room?.id === roomId;
  // Only a resolved answer can be trusted. `loading` is "ask again next render",
  // never "not the team room".
  const settled = team.status !== 'loading';

  useEffect(() => {
    if (!isTeamRoom) return;
    void navigate({
      to: '/',
      search: {
        ...(threadId === undefined ? {} : { thread: threadId }),
        ...(entrySeq === undefined ? {} : { entry: entrySeq }),
      },
      replace: true,
    });
  }, [isTeamRoom, threadId, entrySeq, navigate]);

  if (roomId === undefined) return 'show';
  if (isTeamRoom) return 'redirecting';
  return settled ? 'show' : 'pending';
}
