/**
 * Keep the sidebar's room list honest about rooms the reader does not have open.
 *
 * A room's entries ride its own `/api/rooms/:id/events` stream, which only the
 * open room subscribes to. Everything else a list row shows — a channel someone
 * else just created, a room that moved up the activity order, a title that
 * changed, an unread count — arrives on the global `/api/events` fan-out, which
 * is already connected for the session list (ADR-0265). Riding it costs no
 * second connection and replaces a poll.
 *
 * @module entities/room/model/use-room-list-stream
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEventSubscription } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/** Global events that change what a room list row says. */
const ROOM_LIST_EVENTS = [
  'room_created',
  'room_updated',
  'room_member_added',
  'room_member_removed',
  'room_activity',
] as const;

/**
 * Refresh the room list whenever a room is created, changed, or spoken in.
 *
 * Call once, where the list is rendered. The invalidation is deliberately blunt
 * — a list row is cheap to refetch and the alternative is patching five event
 * shapes into a cache by hand, which is five chances to drift from the server.
 */
export function useRoomListStream(): void {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: roomKeys.lists() });
  };

  // A fixed-length literal tuple, so the hook count never varies between
  // renders — this is a loop over constants, not over data.
  useEventSubscription(ROOM_LIST_EVENTS[0], refresh);
  useEventSubscription(ROOM_LIST_EVENTS[1], refresh);
  useEventSubscription(ROOM_LIST_EVENTS[2], refresh);
  useEventSubscription(ROOM_LIST_EVENTS[3], refresh);
  useEventSubscription(ROOM_LIST_EVENTS[4], refresh);
}
