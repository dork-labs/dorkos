import { useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { cn, formatShortcutKey, SHORTCUTS, useLatest, useRenderSlot } from '@/layers/shared/lib';
import type { AppTab } from '@/layers/shared/model';
import { useRovingTabList, type TabActivationSource } from '@/layers/shared/ui';
import {
  TAB_DRAG_DISTANCE_PX,
  TAB_DRAG_INSTRUCTIONS,
  TAB_DRAG_KEYS,
  buildTabAnnouncements,
  clampToSide,
  reorderIndices,
  sameSideCollision,
  sameSideKeyboardCoordinates,
  sideBounds,
  type SideBounds,
} from '../lib/tab-reorder';
import type { AppTabMenuActions } from './AppTabContextMenu';
import { APP_TAB_ID_ATTRIBUTE, SortableAppTab } from './SortableAppTab';

interface AppTabStripProps {
  /** Open tabs, in strip order. */
  tabs: AppTab[];
  /** Id of the tab currently on screen. */
  activeId: string | null;
  /** Bring a tab to the front. */
  onActivate: (id: string, source: TabActivationSource) => void;
  /** Close a tab. Never called for the last remaining tab. */
  onClose: (id: string, source: TabActivationSource) => void;
  /** Open another tab. */
  onCreate: () => void;
  /** The right-click menu's actions. No menu when absent. */
  menu?: AppTabMenuActions;
  /**
   * Move the tab at `from` to `to`, after a drag. Tabs cannot be dragged when
   * absent. A drag only ever offers places on the tab's own side of the pinned
   * line.
   */
  onReorder?: (from: number, to: number) => void;
  /** Extra classes for the strip container (drag region, traffic-light inset). */
  className?: string;
}

/**
 * The window's tab strip — presentational, so the Dev Playground renders the
 * real thing rather than a lookalike. {@link AppTabBar} is the wired version.
 *
 * Keyboard-accessible per the WAI-ARIA Tabs pattern via
 * {@link useRovingTabList}: the whole strip is one Tab stop, arrow keys move
 * and switch as they go, Home/End jump to the ends, and Delete closes the
 * focused tab. The Cmd/Ctrl chords reach the same tabs faster, and this is still
 * not redundant beside them: a chord is invisible to sequential `Tab` focus and
 * announces nothing, while this strip is landed on in focus order and announced
 * as a labelled `tablist` whose tabs carry `aria-selected`. Someone using a
 * screen reader, or who simply never found the shortcut list, reaches the tabs
 * through this.
 *
 * The last tab keeps no close control: a window with nothing in it has nothing
 * to show, and on desktop closing the last tab is the window's job.
 *
 * Tabs can be dragged to a new place (pointer, or Space then the arrow keys)
 * and right-clicked for a menu (or Shift+F10). Pinned tabs sit at the left,
 * drawn as an icon only, and a drag keeps every tab on its own side of them.
 *
 * @module features/app-tabs/ui/AppTabStrip
 */
export function AppTabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onCreate,
  menu,
  onReorder,
  className,
}: AppTabStripProps) {
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  // The span the dragged tab may move within, measured once as a drag starts
  // (before other tabs shift to make room). A slot rather than a ref because
  // the modifier built below reads it, and only ever while dragging.
  const dragBounds = useRenderSlot<SideBounds | null>(null);
  const canClose = tabs.length > 1;
  const [dragActive, setDragActive] = useState(false);
  const ids = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  // Read by the collision rule and the announcements at the moment they run,
  // so neither has to be rebuilt (and dnd-kit re-measured) on every change.
  const latestTabs = useLatest(tabs);

  // Every drag rule keeps a tab on its own side of the pinned line: where it
  // may land (collision), where an arrow key may step it (keyboard), and where
  // it may be drawn (modifier).
  const { collisionDetection, coordinateGetter, modifiers, announcements } = useMemo(() => {
    const indexOf = (id: string) => latestTabs.read().findIndex((tab) => tab.id === id);
    const isPinned = (id: string) =>
      latestTabs.read().find((tab) => tab.id === id)?.pinned ?? false;
    return {
      collisionDetection: sameSideCollision(isPinned),
      coordinateGetter: sameSideKeyboardCoordinates(isPinned),
      modifiers: [clampToSide(dragBounds.read)],
      announcements: buildTabAnnouncements({
        // The tab's accessible name, read off the strip — the one place that
        // already knows what the tab is called. Tab ids are unique per window.
        nameOf: (id) =>
          Array.from(document.querySelectorAll(`[${APP_TAB_ID_ATTRIBUTE}]`))
            .find((node) => node.getAttribute(APP_TAB_ID_ATTRIBUTE) === id)
            ?.querySelector('[role="tab"]')
            ?.textContent?.trim() || 'Tab',
        indexOf,
        count: () => latestTabs.read().length,
      }),
    };
  }, [latestTabs, dragBounds]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: TAB_DRAG_DISTANCE_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter, keyboardCodes: TAB_DRAG_KEYS })
  );

  const handleDragStart = ({ active }: DragStartEvent) => {
    setDragActive(true);
    const side = tabs.find((tab) => tab.id === active.id)?.pinned ?? false;
    const rects = Array.from(
      tablistRef.current?.querySelectorAll<HTMLElement>(`[${APP_TAB_ID_ATTRIBUTE}]`) ?? []
    )
      .filter((node) => {
        const id = node.getAttribute(APP_TAB_ID_ATTRIBUTE);
        return (tabs.find((tab) => tab.id === id)?.pinned ?? false) === side;
      })
      .map((node) => node.getBoundingClientRect());
    dragBounds.write(sideBounds(rects));
  };

  const endDrag = () => {
    setDragActive(false);
    dragBounds.write(null);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    endDrag();
    const move = reorderIndices(ids, active.id, over?.id);
    if (move && onReorder) onReorder(...move);
  };

  // A menu item can close or replace the tab it was opened on, and the menu
  // would hand focus back to a tab that is gone. Put it on whichever tab is on
  // screen once the action has landed.
  const focusActiveTab = () => {
    setTimeout(() => {
      tablistRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    }, 0);
  };

  const { getTabProps } = useRovingTabList({
    orderedIds: tabs.map((tab) => tab.id),
    activeId,
    onActivate,
    // Delete is only wired while there is something to close, so the last tab
    // does not advertise a shortcut that does nothing.
    onClose: canClose ? onClose : undefined,
    getFallbackFocus: () => createButtonRef.current,
  });

  return (
    // The outer row does NOT scroll, and that is load-bearing: `className`
    // carries the macOS traffic-light clearance, so if it sat on the scroller
    // the first tabs would slide under the native window buttons the moment the
    // strip overflowed and stop responding to clicks. The "+" is outside the
    // scroller for the same reason Chrome pins it — an affordance you have to
    // scroll to find is one you will not find.
    <div className={cn('bg-muted/40 flex shrink-0 items-stretch border-b px-2 py-1', className)}>
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          modifiers={modifiers}
          accessibility={{ announcements, screenReaderInstructions: TAB_DRAG_INSTRUCTIONS }}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={endDrag}
        >
          <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
            <div
              ref={tablistRef}
              role="tablist"
              aria-label="Open tabs"
              className="flex items-stretch gap-1"
            >
              {tabs.map((tab) => (
                <SortableAppTab
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeId}
                  canClose={canClose}
                  tabProps={getTabProps(tab.id)}
                  onClose={onClose}
                  sortable={onReorder !== undefined}
                  dragActive={dragActive}
                  menu={menu}
                  onMenuClosed={focusActiveTab}
                  hasOthersToClose={tabs.some((other) => other.id !== tab.id && !other.pinned)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
      <button
        ref={createButtonRef}
        type="button"
        onClick={onCreate}
        aria-label="New tab"
        title={`New tab (${formatShortcutKey(SHORTCUTS.NEW_TAB)})`}
        className="focus-ring text-muted-foreground hover:bg-background/60 hover:text-foreground ml-1 flex shrink-0 items-center rounded-md px-1.5 transition-colors"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
