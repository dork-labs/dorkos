/**
 * Find #team — the one room this install always has, and the room the home tab
 * renders (team-room-home spec D3.2).
 *
 * @module entities/room/model/use-team-room
 */
import { useQuery } from '@tanstack/react-query';
import { TEAM_ROOM_WELL_KNOWN, type RoomSummary } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { useRooms } from './use-rooms';

/**
 * {@link useTeamRoom}'s answer: what became of #team.
 *
 * A union rather than a status beside a nullable room, so the two can never
 * disagree: a caller that has checked the status has the room, and a caller
 * that has not cannot reach for one.
 *
 * Five cases, because a surface that renders a room has to tell them apart:
 * `missing` and `error` both mean "no room here", and only one of them is worth
 * offering a retry for. Collapsing any of them into "no room" is how a fresh
 * install ends up drawing a broken conversation while the server is still
 * opening it.
 */
export type TeamRoomState = {
  /** Ask again. For the `error` case; harmless anywhere else. */
  retry: () => void;
} & (
  | { status: 'loading'; room: null }
  | { status: 'missing'; room: null }
  | { status: 'error'; room: null }
  // `archived` carries a room too: it still has a title to say and an id to
  // bring it back by.
  | { status: 'ready'; room: RoomSummary }
  | { status: 'archived'; room: RoomSummary }
);

/**
 * The room the home tab draws, found by the key the server opened it under.
 *
 * **Found by `wellKnown`, never by `#team`.** The owner may rename the channel,
 * and a lookup on the slug would then quietly stop finding the room the whole
 * home surface is built on. The key never moves (spec D3.1).
 *
 * **The common case costs no request.** The live list is the same query the
 * sidebar already holds, so on a normal cockpit this is a cache read. Only when
 * #team is absent from it does a second, archived-inclusive read run — the one
 * case that needs it, because an archived room is not in the ordinary list at
 * all and would otherwise be indistinguishable from a server that has not
 * seeded one yet.
 *
 * **It never puts the room back on its own.** Archiving #team is the owner's
 * decision and this hook reports it; un-archiving is a press, which is what
 * keeps "I put that away" from being silently overruled by opening the page.
 */
export function useTeamRoom(): TeamRoomState {
  const transport = useTransport();
  const rooms = useRooms();
  const live = rooms.data?.find((room) => room.wellKnown === TEAM_ROOM_WELL_KNOWN) ?? null;
  // Only asked when the live list came back WITHOUT #team. `enabled` is what
  // keeps this off every ordinary load; a failed list must not trigger it
  // either, because "could not read" is not evidence the room is gone.
  const absent = rooms.isSuccess && live === null;

  const archived = useQuery({
    queryKey: roomKeys.wellKnown(TEAM_ROOM_WELL_KNOWN),
    queryFn: async () => {
      const all = await transport.listRooms({ includeArchived: true });
      return all.find((room) => room.wellKnown === TEAM_ROOM_WELL_KNOWN) ?? null;
    },
    enabled: absent,
  });

  const retry = () => {
    void rooms.refetch();
    if (absent) void archived.refetch();
  };

  if (live !== null) return { status: 'ready', room: live, retry };
  if (rooms.isError) return { status: 'error', room: null, retry };
  if (!absent) return { status: 'loading', room: null, retry };
  if (archived.isError) return { status: 'error', room: null, retry };
  if (archived.data === undefined) return { status: 'loading', room: null, retry };
  if (archived.data === null) return { status: 'missing', room: null, retry };
  return { status: 'archived', room: archived.data, retry };
}
