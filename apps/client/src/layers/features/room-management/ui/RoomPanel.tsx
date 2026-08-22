/**
 * The right panel's Room tab — everything about the room the page is showing.
 *
 * @module features/room-management/ui/RoomPanel
 */
import { useEffect, useRef } from 'react';
import { Skeleton } from '@/layers/shared/ui';
import { useRoomPanelFocusStore } from '../model/room-panel-focus';
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
  const shown = route.status === 'ready' ? route.roomId : null;

  /**
   * Let go of a press whose room the reader has moved away from without ever
   * opening it.
   *
   * A request names its room and waits for that room's panel. If the room never
   * arrives — the navigation failed, the room was gone — nothing takes it, and
   * the next panel to open would spring its picker for a press about a room
   * nobody is looking at any more.
   *
   * **Released when the ROUTE moves, never when a panel mounts.** Mounting
   * cannot tell the two apart: `openRoomPanel` switches to this tab in the same
   * press, so on a route showing room A the panel mounts fresh for A while a
   * request for B is still in flight behind a navigation — and a mount-time
   * release swallowed exactly the press that had just been made (all three
   * sidebar doors, silently, whenever the Room tab was not already the active
   * one). A route move is unambiguous: it means the reader is somewhere else
   * now, and a request for a third room is stale by then.
   *
   * The first render is not a move, so the `null` on mount is skipped. It lives
   * here rather than in the body because the body is keyed on the room, so it
   * unmounts before the move it would have to notice.
   */
  const shownBefore = useRef<string | null>(null);
  useEffect(() => {
    const previous = shownBefore.current;
    shownBefore.current = shown;
    if (previous === null || previous === shown) return;
    const pending = useRoomPanelFocusStore.getState().request;
    if (pending !== null && pending.roomId !== shown) useRoomPanelFocusStore.getState().consume();
  }, [shown]);

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
