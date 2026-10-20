/**
 * One door to an agent: `/channels?id=<the person's DM with one agent>` opens
 * that agent's Direct chat, never the room view (rule S12, DOR-2997).
 *
 * **The view follows who is in the conversation.** You plus one agent is
 * always the 1:1 view. Old links still name the room: a notification, a Today
 * row, a search hit, a bookmark. Each of them lands here and moves on.
 *
 * Same shape as {@link useTeamRoomRedirect}, for the same reasons: nothing is
 * drawn while the answer is unknown, so the room never flashes before the move,
 * and the move replaces the history entry, so Back does not walk into a
 * redirect that bounces straight forward again.
 *
 * @module widgets/room-view/model/use-direct-chat-redirect
 */
import { useEffect, useRef, useState } from 'react';
import { oneToOneDmAgentRef } from '@dorkos/shared/room-schemas';
import { useOpenDirectChat, useRooms } from '@/layers/entities/room';
import type { TeamRoomRedirect } from './use-team-room-redirect';

/**
 * Send a one-agent DM's address to that agent's Direct chat.
 *
 * @param roomId - The `?id=` on the route, if there is one.
 */
export function useDirectChatRedirect(roomId: string | undefined): TeamRoomRedirect {
  const rooms = useRooms();
  const open = useOpenDirectChat();
  const room = roomId === undefined ? undefined : rooms.data?.find((r) => r.id === roomId);
  const isDirect = room !== undefined && oneToOneDmAgentRef(room) !== null;
  const settled = roomId === undefined || rooms.data !== undefined || rooms.isError;
  // A redirect that failed draws the room instead, once, so the person still
  // reaches the conversation rather than a blank page.
  const [failedFor, setFailedFor] = useState<string | undefined>(undefined);
  const failed = roomId !== undefined && failedFor === roomId;
  // One move per room, however many times the effect runs.
  const startedFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!isDirect || roomId === undefined || failed || startedFor.current === roomId) return;
    startedFor.current = roomId;
    void open({ roomId }, { replace: true, quiet: true }).then((ok) => {
      if (!ok) setFailedFor(roomId);
    });
  }, [isDirect, roomId, failed, open]);

  if (!settled) return 'pending';
  return isDirect && !failed ? 'redirecting' : 'show';
}
