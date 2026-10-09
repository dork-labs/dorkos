import {
  useCallback,
  useMemo,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEventHandler,
} from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { cn } from '@/layers/shared/lib';
import type { AppTab } from '@/layers/shared/model';
import type { RovingTabProps, TabActivationSource } from '@/layers/shared/ui';
import { AppTabItem } from './AppTabItem';
import { AppTabContextMenu, type AppTabMenuActions } from './AppTabContextMenu';

/** The attribute each tab's outer node carries, valued with the tab's id. */
export const APP_TAB_ID_ATTRIBUTE = 'data-app-tab-id';

interface SortableAppTabProps {
  /** The tab to render. */
  tab: AppTab;
  /** Whether this is the tab currently on screen. */
  isActive: boolean;
  /** Whether the tab may close (false for the last tab). */
  canClose: boolean;
  /** Roving-tablist props for this tab, from the strip's `getTabProps`. */
  tabProps: RovingTabProps;
  /** Close this tab. */
  onClose: (id: string, source: TabActivationSource) => void;
  /** Whether the tab can be dragged. Off when the strip has no `onReorder`. */
  sortable: boolean;
  /** Whether any tab in the strip is being dragged right now. */
  dragActive: boolean;
  /** The tab menu's actions; no menu when absent. */
  menu?: AppTabMenuActions;
  /** Whether "Close others" would close anything from this tab. */
  hasOthersToClose: boolean;
}

/**
 * One tab, made draggable and given its right-click menu — wrapped around
 * {@link AppTabItem} from outside so the tab itself stays about what it shows.
 *
 * **Who listens to what.** The outer node is what dnd-kit measures and moves,
 * and it carries the pointer listener, so a press anywhere on the tab (its close
 * control included) can become a drag once the pointer travels a few pixels. The
 * tab's own button is the keyboard activator: Space on a focused tab lifts it.
 * While any drag is in flight the strip's arrow-key traversal stands down, so
 * the arrows move the lifted tab instead of switching tabs under it.
 *
 * **The context-menu key.** Shift+F10 and the context-menu key open the same
 * menu a right-click does. Browsers do not reliably turn either into a
 * `contextmenu` event (macOS has no such key at all), so the tab makes that
 * event itself, anchored under the tab.
 */
export function SortableAppTab({
  tab,
  isActive,
  canClose,
  tabProps,
  onClose,
  sortable,
  dragActive,
  menu,
  hasOthersToClose,
}: SortableAppTabProps) {
  const pinned = tab.pinned ?? false;
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id, disabled: !sortable });

  // dnd-kit types its listeners as a bag of bare `Function`s; these are the two
  // its sensors register.
  const onPointerDown = listeners?.onPointerDown as PointerEventHandler | undefined;
  const sensorKeyDown = listeners?.onKeyDown as ((event: KeyboardEvent) => void) | undefined;

  // Sideways only: the strip is one row, and a tab that followed the pointer
  // down the window would look like it could be dropped there.
  const style: CSSProperties = {
    transform: transform ? `translate3d(${Math.round(transform.x)}px, 0, 0)` : undefined,
    transition: transition ?? undefined,
  };

  const { ref: rovingRef, onKeyDown: rovingKeyDown } = tabProps;
  const ref = useCallback(
    (element: HTMLElement | null) => {
      rovingRef(element);
      setActivatorNodeRef(element);
    },
    [rovingRef, setActivatorNodeRef]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (menu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault();
        const target = event.currentTarget as HTMLElement;
        const box = target.getBoundingClientRect();
        target.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: box.left,
            clientY: box.bottom,
          })
        );
        return;
      }
      // dnd-kit's keyboard sensor reads the activator's keydown for Space.
      sensorKeyDown?.(event);
      if (event.defaultPrevented || dragActive) return;
      rovingKeyDown(event);
    },
    [menu, sensorKeyDown, dragActive, rovingKeyDown]
  );

  const composedTabProps = useMemo(
    () =>
      ({
        ...tabProps,
        ref,
        onKeyDown,
        // Only the instructions: dnd-kit's `aria-roledescription="sortable"`
        // would replace "tab" in what a screen reader calls this control.
        ...(sortable ? { 'aria-describedby': attributes['aria-describedby'] } : {}),
      }) as RovingTabProps,
    [tabProps, ref, onKeyDown, sortable, attributes]
  );

  const node = (
    <div
      ref={setNodeRef}
      role="presentation"
      {...{ [APP_TAB_ID_ATTRIBUTE]: tab.id }}
      style={style}
      onPointerDown={onPointerDown}
      className={cn(
        'flex shrink-0',
        isDragging && 'bg-background shadow-soft relative z-10 rounded-md'
      )}
    >
      <AppTabItem
        tab={tab}
        isActive={isActive}
        canClose={canClose}
        tabProps={composedTabProps}
        onClose={onClose}
        pinned={pinned}
      />
    </div>
  );

  if (!menu) return node;
  return (
    <AppTabContextMenu
      tabId={tab.id}
      pinned={pinned}
      hasOthersToClose={hasOthersToClose}
      canClose={canClose}
      actions={menu}
    >
      {node}
    </AppTabContextMenu>
  );
}
