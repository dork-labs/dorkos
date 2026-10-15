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
  type ClientRect,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCodes,
  type KeyboardCoordinateGetter,
  type Modifier,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

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
  draggable: 'Press Space to move this tab. Arrows move it, Space drops it, Escape cancels.',
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

/**
 * The droppable containers on one side of the pinned line, shaped like the map
 * dnd-kit hands a coordinate getter (it reads `getEnabled` and `get`).
 */
class SideContainers extends Map<UniqueIdentifier, DroppableContainer> {
  /** Every container on this side that is not disabled. */
  getEnabled(): DroppableContainer[] {
    return [...this.values()].filter((container) => !container.disabled);
  }

  /** Every container on this side. */
  toArray(): DroppableContainer[] {
    return [...this.values()];
  }
}

/**
 * dnd-kit's sortable keyboard step, shown only the tabs on the lifted tab's own
 * side of the pinned line. The stock getter runs its own collision search over
 * every container, so without this an arrow key could draw an unpinned tab
 * among the pinned ones — a place the drop would never keep.
 *
 * @param isPinned - Whether the tab with this id is pinned.
 */
export function sameSideKeyboardCoordinates(
  isPinned: (id: string) => boolean
): KeyboardCoordinateGetter {
  return (event, args) => {
    const { context } = args;
    if (!context.active) return sortableKeyboardCoordinates(event, args);
    const side = isPinned(String(context.active.id));
    const sameSide = new SideContainers();
    for (const container of context.droppableContainers.toArray()) {
      if (isPinned(String(container.id)) === side) sameSide.set(container.id, container);
    }
    return sortableKeyboardCoordinates(event, {
      ...args,
      context: {
        ...context,
        droppableContainers: sameSide as unknown as typeof context.droppableContainers,
      },
    });
  };
}

/** The left and right edges a dragged tab must stay between. */
export interface SideBounds {
  left: number;
  right: number;
}

/**
 * The span the tabs on one side of the pinned line cover, from their rects
 * measured before anything moved. `null` with no rects.
 *
 * @param rects - The rects of every tab on the dragged tab's side, itself included.
 */
export function sideBounds(rects: readonly ClientRect[]): SideBounds | null {
  if (rects.length === 0) return null;
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    right: Math.max(...rects.map((rect) => rect.right)),
  };
}

/**
 * A modifier that holds the dragged tab inside its own side's span, so a
 * pointer drag cannot draw it across the pinned line either.
 *
 * @param getBounds - The span for the current drag, read when the modifier runs.
 */
export function clampToSide(getBounds: () => SideBounds | null): Modifier {
  return ({ transform, activeNodeRect }) => {
    const bounds = getBounds();
    if (!bounds || !activeNodeRect) return transform;
    const min = bounds.left - activeNodeRect.left;
    const max = bounds.right - activeNodeRect.right;
    return { ...transform, x: Math.min(Math.max(transform.x, min), max) };
  };
}

/**
 * The `[from, to]` indices a finished drag asks for, or `null` when it moved
 * nothing (no target, the same place, or an id the strip no longer holds).
 *
 * @param ids - Tab ids in strip order.
 * @param activeId - The dragged tab.
 * @param overId - The tab it was dropped on, if any.
 */
export function reorderIndices(
  ids: readonly string[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier | null | undefined
): [number, number] | null {
  if (overId === null || overId === undefined) return null;
  const from = ids.indexOf(String(activeId));
  const to = ids.indexOf(String(overId));
  if (from === -1 || to === -1 || from === to) return null;
  return [from, to];
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
