/**
 * What the room panel says when there is no room to describe.
 *
 * @module features/room-management/ui/RoomPanelNotice
 */
import type { ReactNode } from 'react';

interface RoomPanelNoticeProps {
  /** The one line that says what happened. */
  title: string;
  /** Why, in a sentence, when there is something useful to add. */
  body?: string;
  /** The way out, when there is one. */
  action?: ReactNode;
}

/**
 * A quiet placeholder, centred in the panel.
 *
 * The panel keeps its tab on every route that shows a room, and a room can still
 * be missing on one of them — an id that no longer resolves, a #team that has
 * been archived. Saying so plainly is the honest answer; a blank panel reads as
 * something still loading.
 *
 * @param props - What to say, and the way out if there is one.
 */
export function RoomPanelNotice({ title, body, action }: RoomPanelNoticeProps) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
      <p className="text-foreground font-medium">{title}</p>
      {body && <p className="max-w-xs text-pretty">{body}</p>}
      {action}
    </div>
  );
}
