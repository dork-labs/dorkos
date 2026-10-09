/**
 * The pure half of dragging tabs to reorder them: which keys lift and drop a
 * tab, which tabs a dragged tab may land among, and what a screen reader hears
 * along the way. The strip wires these into dnd-kit; keeping them here lets the
 * rules be tested without a drag.
 *
 * @module features/app-tabs/lib/tab-reorder
 */
import {
  closestCenter,
  type Announcements,
  type CollisionDetection,
  type KeyboardCodes,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';

/**
 * Which keys lift, cancel and drop a tab.
 *
 * **Space lifts; nothing else does.** dnd-kit's default also lifts on Enter,
 * and the sidebar settled the same question the same way (`SidebarDnd`'s
 * `DRAG_KEYS`): Space is the pick-up key the ARIA drag-and-drop pattern names.
 * Once a tab is lifted, the arrow keys move it, and Space, Enter or Tab put it
 * down.
 */
export const TAB_DRAG_KEYS: KeyboardCodes = {
  start: ['Space'],
  cancel: ['Escape'],
  end: ['Space', 'Enter', 'Tab'],
};

/**
 * How far a pointer must travel before a press becomes a drag. Small enough to
 * feel immediate, large enough that a click with a shaky hand still just
 * switches tabs.
 */
export const TAB_DRAG_DISTANCE_PX = 4;

/** What a screen reader hears on landing on a tab that can be moved. */
export const TAB_DRAG_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'To move this tab, press Space. Use the arrow keys to move it, then Space to drop it, or Escape to cancel.',
};

/**
 * Collision detection that only offers a dragged tab places on its own side of
 * the pinned line, so a pinned tab cannot be dragged among unpinned ones and an
 * unpinned tab cannot be dragged among pinned ones. The store holds the same
 * rule (`moveTab` clamps); this one keeps the drag from ever showing a place it
 * would not keep.
 *
 * @param isPinned - Whether the tab with this id is pinned.
 */
export function sameSideCollision(isPinned: (id: string) => boolean): CollisionDetection {
  return (args) => {
    const side = isPinned(String(args.active.id));
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => isPinned(String(container.id)) === side
      ),
    });
  };
}

/** What the announcements need to read about the strip at the moment they speak. */
export interface TabAnnounceContext {
  /** The tab's name as the strip reads it out (its accessible name). */
  nameOf: (id: string) => string;
  /** The tab's current position, 0-based, or -1 when it is not in the strip. */
  indexOf: (id: string) => number;
  /** How many tabs the strip holds. */
  count: () => number;
}

/**
 * Plain-words announcements for a tab drag: what was picked up, where it is
 * now, where it was dropped, and that a cancel put it back.
 *
 * @param context - Live readers for names and positions.
 */
export function buildTabAnnouncements(context: TabAnnounceContext): Announcements {
  const { nameOf, indexOf, count } = context;
  const place = (id: string) => `position ${indexOf(id) + 1} of ${count()}`;
  return {
    onDragStart: ({ active }) => `Picked up ${nameOf(String(active.id))}.`,
    onDragOver: ({ active, over }) =>
      over ? `${nameOf(String(active.id))} is over ${place(String(over.id))}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `${nameOf(String(active.id))} dropped at ${place(String(over.id))}.`
        : `${nameOf(String(active.id))} put back.`,
    onDragCancel: ({ active }) => `Move cancelled. ${nameOf(String(active.id))} put back.`,
  };
}
