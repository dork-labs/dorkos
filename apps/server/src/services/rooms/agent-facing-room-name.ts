/**
 * The one name an agent is ever told for a room (DOR-4453, Security on #3821 and #3832).
 *
 * A bridged group is titled, and slugged, from its far-end chat's name at bridge time
 * (`room-bridge-create.ts`), and anyone in that chat can set the name. So while the room's title is
 * still that recorded name, every place that tells a model what the room is called says
 * {@link PLATFORM_NAMED_ROOM} instead: the turn's `room_context`, the room tools
 * (`list_member_rooms`, `get_room`, `find_room`, `search_member_rooms`), the hand-off prompt, the
 * memory stamp and the conventions block. Once the owner renames the room (operator-only), the
 * name is theirs and shows again. Matching what an agent TYPES against the real slug is fine:
 * input is not output.
 *
 * @module server/services/rooms/agent-facing-room-name
 */
import type { Room } from '@dorkos/shared/room-schemas';
import type { BridgeStore } from '../relay/chat-bridge/bridge-store.js';

/** What a bridged group is called while its name is still the far-end chat's. */
export const PLATFORM_NAMED_ROOM = 'Bridged channel';

/** The bridge lookup {@link agentFacingRoomName} reads. */
export type RoomBridgeLookup = Pick<BridgeStore, 'findBridgeByRoom'>;

/**
 * Whether a room is still named by its far-end chat, which a stranger may have set.
 *
 * @param room - The room.
 * @param platformTitle - The chat's title as recorded at bridge time, if the room has one.
 */
export function isPlatformNamed(
  room: Pick<Room, 'title'>,
  platformTitle: string | null | undefined
): boolean {
  return platformTitle !== null && platformTitle !== undefined && room.title === platformTitle;
}

/**
 * The room's name as any agent-facing surface prints it: `#slug` for a channel, the title for a
 * direct message, and {@link PLATFORM_NAMED_ROOM} for a bridged group nobody has renamed.
 *
 * @param room - The room.
 * @param bridges - Where the room's bridge row, and its recorded chat title, live.
 */
export function agentFacingRoomName(
  room: Pick<Room, 'id' | 'kind' | 'slug' | 'title'>,
  bridges: RoomBridgeLookup
): string {
  if (isPlatformNamed(room, bridges.findBridgeByRoom(room.id)?.platformTitle)) {
    return PLATFORM_NAMED_ROOM;
  }
  return room.kind === 'channel' && room.slug ? `#${room.slug}` : room.title;
}

/**
 * The session list's room labels (`RoomStore.resolveRoomOrigins`) with every bridged group nobody
 * renamed relabelled {@link PLATFORM_NAMED_ROOM}, so a session row an agent reads names the room
 * as every other agent surface does. Each room is looked up once, however many sessions it has.
 *
 * @param origins - Session id to its room label and room id; relabelled in place and returned.
 * @param rooms - Reads a room's current title.
 * @param bridges - Where a room's recorded chat title lives.
 */
export function fenceRoomOrigins<T extends { roomLabel: string; roomId: string }>(
  origins: Map<string, T>,
  rooms: { getRoom(roomId: string): Pick<Room, 'title'> | null | undefined },
  bridges: RoomBridgeLookup
): Map<string, T> {
  const named = new Map<string, boolean>();
  for (const [sessionId, origin] of origins) {
    let hidden = named.get(origin.roomId);
    if (hidden === undefined) {
      const room = rooms.getRoom(origin.roomId);
      const platformTitle = bridges.findBridgeByRoom(origin.roomId)?.platformTitle;
      hidden = room ? isPlatformNamed(room, platformTitle) : false;
      named.set(origin.roomId, hidden);
    }
    if (hidden) origins.set(sessionId, { ...origin, roomLabel: PLATFORM_NAMED_ROOM });
  }
  return origins;
}
