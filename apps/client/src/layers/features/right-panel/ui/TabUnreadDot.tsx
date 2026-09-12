/**
 * The dot on a right-panel tab that says something arrived there while you were
 * looking somewhere else (spec `room-canvas` §9.3).
 *
 * It exists because the panel's auto-select is deliberately NOT changed by an
 * arrival: on a room route the panel opens on Room and stays there, and a
 * document another member put on the table has to be findable without having
 * yanked anybody's tab to announce itself. A tab that selected itself when
 * somebody else acted is the pixel version of a turn that triggers itself.
 *
 * Only the two document tabs can carry one today, so the mapping is a two-entry
 * table rather than a registry field: a contribution that wanted a badge would
 * need one, and inventing that surface before a second caller exists would be a
 * public API nobody asked for.
 *
 * It reads the store and nothing else — no router, no transport. The tab strip
 * renders in the Obsidian shell and in plenty of tests with neither behind it,
 * and a tab that resolved the route itself took 102 of them down when it tried.
 *
 * @module features/right-panel/ui/TabUnreadDot
 */
import type { CanvasView } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';

/** Which document view a right-panel tab draws, for the tabs that draw one. */
const VIEW_BY_TAB: Record<string, CanvasView> = {
  canvas: 'canvas',
  browser: 'browser',
};

/** What {@link TabUnreadDot} is about. */
export interface TabUnreadDotProps {
  /** The right-panel contribution this tab is. */
  contributionId: string;
}

/**
 * A small dot, or nothing.
 *
 * Decorative: the tab beside it is already named, and the dot means "there is
 * something new in here" rather than carrying a fact of its own.
 *
 * @param props - Which tab is asking.
 */
export function TabUnreadDot({ contributionId }: TabUnreadDotProps) {
  const view = VIEW_BY_TAB[contributionId];
  const unread = useAppStore((s) => {
    const roomId = s.roomCanvasLiveRoomId;
    if (roomId === null || view === undefined) return false;
    return (s.roomCanvasUnread[roomId]?.[view].length ?? 0) > 0;
  });

  if (!unread) return null;
  return (
    <span
      data-slot="right-panel-tab-unread"
      aria-hidden
      className="bg-primary size-1.5 shrink-0 rounded-full"
    />
  );
}
