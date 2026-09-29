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
 * It has two sources, and they mean different things:
 *
 * - **Unread content** on the two built-in document tabs (canvas, browser), a
 *   two-entry table. Drawn in the primary colour: something new is in there.
 * - **An extension's marker** (`api.setTabMarker`, spec `flow-multiproject`
 *   §6.7), from the extension registry. Drawn amber: something in there needs
 *   you. Core draws it; an extension can set or clear it, never style it. The
 *   tab's accessible name says so too (see {@link tabAccessibleName}).
 *
 * @module features/right-panel/ui/TabUnreadDot
 */
import type { CanvasView } from '@/layers/shared/lib';
import { useAppStore, useTabMarker, type TabMarker } from '@/layers/shared/model';

/** Which document view a right-panel tab draws, for the tabs that draw one. */
const VIEW_BY_TAB: Record<string, CanvasView> = {
  canvas: 'canvas',
  browser: 'browser',
};

/**
 * A right-panel tab's accessible name: its label, plus what its marker means
 * while an extension has marked it ("Flow, something needs you").
 *
 * @param title - The tab's label.
 * @param marker - The tab's marker, or null.
 */
export function tabAccessibleName(title: string, marker: TabMarker | null): string {
  return marker === 'attention' ? `${title}, something needs you` : title;
}

/** What {@link TabUnreadDot} is about. */
export interface TabUnreadDotProps {
  /** The right-panel contribution this tab is. */
  contributionId: string;
}

/**
 * A small dot, or nothing.
 *
 * Decorative: the tab beside it is already named, and for a marker the tab's
 * accessible name carries the fact the dot draws.
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
  const marker = useTabMarker(contributionId);

  if (marker === 'attention') {
    return (
      <span
        data-slot="right-panel-tab-marker"
        aria-hidden
        className="bg-status-warning-dot size-1.5 shrink-0 rounded-full"
      />
    );
  }
  if (!unread) return null;
  return (
    <span
      data-slot="right-panel-tab-unread"
      aria-hidden
      className="bg-primary size-1.5 shrink-0 rounded-full"
    />
  );
}
