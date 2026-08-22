/**
 * The right panel's Room tab — everything about the room the page is showing.
 *
 * @module features/room-management/ui/RoomPanel
 */
import { Skeleton } from '@/layers/shared/ui';
import { useRouteRoom } from '../model/use-route-room';
import { RoomPanelBody } from './RoomPanelBody';
import { RoomPanelNotice } from './RoomPanelNotice';

/**
 * Room management, docked beside the room it is about (spec `one-bar-header`
 * §3.6).
 *
 * This used to be a modal over the conversation. It is a panel now, for the
 * reason every inspector in this app is one: reading who is in a room and
 * changing how loud they are is work you do WHILE reading the room, and a sheet
 * covering the thing it describes makes you close it to check. The right panel
 * already knows how to be a side-by-side split on a desktop and a slide-over on
 * a phone, so the one thing the modal was better at costs nothing to keep.
 *
 * **It follows the route, and holds no selection of its own.** The room is
 * whichever one the page is showing — `/channels?id=…`, or #team on Home — so
 * the panel and the bar above it can never describe different rooms, and there
 * is no third place where "the selected room" could go stale.
 */
export function RoomPanel() {
  const route = useRouteRoom();

  if (route.status === 'loading') {
    return (
      <div className="space-y-4 p-4" aria-busy>
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (route.status === 'none') {
    return (
      <RoomPanelNotice
        title="No room open"
        body="Open a channel or a direct message and this panel says who is in it."
      />
    );
  }

  // Keyed on the room: switching rooms starts with a clean roster rather than
  // the last one's expanded scale and half-typed search.
  return <RoomPanelBody key={route.roomId} roomId={route.roomId} />;
}
