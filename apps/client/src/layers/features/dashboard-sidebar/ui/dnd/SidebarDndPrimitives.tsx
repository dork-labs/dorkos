import {
  createContext,
  useCallback,
  useContext,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '@/layers/shared/lib';
import type { SidebarDndData } from '../../model/use-sidebar-dnd';

/**
 * Whether the sidebar drag layer is active. `SidebarDnd` sets this `true`; it
 * stays `false` on mobile (touch drag conflicts with scroll) and in any tree
 * without a `DndContext`, so the sortable/droppable primitives below can no-op
 * instead of calling dnd-kit hooks outside a provider.
 */
const SidebarDndEnabledContext = createContext(false);

/** Provider used by `SidebarDnd` to switch the drag primitives on. */
export const SidebarDndEnabledProvider = SidebarDndEnabledContext.Provider;

/** Read whether the sidebar drag layer is active in the current subtree. */
function useSidebarDndEnabled(): boolean {
  return useContext(SidebarDndEnabledContext);
}

/**
 * Everything a draggable element needs, spread onto its root. `handleProps`
 * carries the drag activators plus the WCAG sortable ARIA attributes; `style`
 * carries the live transform.
 */
export interface SortableBindings {
  /** Ref for the measured/draggable node. */
  setNodeRef: (node: HTMLElement | null) => void;
  /** Spread onto the draggable element (pointer/keyboard activators + a11y). */
  handleProps: HTMLAttributes<HTMLElement>;
  /** Live drag transform. */
  style: CSSProperties;
  /** Whether this item is the one being dragged. */
  isDragging: boolean;
  /** Whether a drag is currently hovering this item (drop-target ring). */
  isOver: boolean;
}

/** Inert bindings used when the drag layer is disabled (no-op refs/handlers). */
const DISABLED_BINDINGS: SortableBindings = {
  setNodeRef: () => {},
  handleProps: {},
  style: {},
  isDragging: false,
  isOver: false,
};

/** Renders a draggable, applying the supplied bindings to its root element. */
type SortableRender = (bindings: SortableBindings) => ReactNode;

interface SortableProps {
  /** Unique dnd id (e.g. `pinned::/path`, `group-header::id`). */
  id: string;
  /** Node data read back by the drop reducer. */
  data: SidebarDndData;
  /** Renders the draggable, applying the supplied bindings to its root. */
  children: SortableRender;
}

function SortableInner({
  id,
  data,
  render,
}: {
  id: string;
  data: SidebarDndData;
  render: SortableRender;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id, data });
  // Register the row as its own activator node. KeyboardSensor only starts a
  // drag when `event.target === activatorNode`, so Space/Enter on nested
  // interactive controls (the "…" trigger, "New session", session rows, the
  // rename input) bubble through untouched — only a keydown on the focused row
  // itself picks it up. Without this, activatorNode is null and dnd-kit skips
  // that guard entirely.
  const setCombinedRef = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      setActivatorNodeRef(node);
    },
    [setNodeRef, setActivatorNodeRef]
  );
  const style: CSSProperties = {
    transform: transform
      ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
      : undefined,
    transition: transition ?? undefined,
  };
  const handleProps = { ...attributes, ...(listeners ?? {}) } as HTMLAttributes<HTMLElement>;
  return <>{render({ setNodeRef: setCombinedRef, handleProps, style, isDragging, isOver })}</>;
}

/**
 * A sortable draggable. When the drag layer is off it renders its child with
 * inert bindings (no dnd-kit hook runs), so the same tree works on mobile and in
 * tests without a `DndContext`.
 */
export function Sortable({ id, data, children }: SortableProps) {
  if (!useSidebarDndEnabled()) return <>{children(DISABLED_BINDINGS)}</>;
  return <SortableInner id={id} data={data} render={children} />;
}

interface DroppableProps {
  /** Unique dnd id for the container (e.g. `container::pinned`). */
  id: string;
  /** Node data read back by the drop reducer. */
  data: SidebarDndData;
  children: ReactNode;
}

function DroppableInner({ id, data, children }: DroppableProps) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  return (
    <div
      ref={setNodeRef}
      className={cn('rounded-md transition-shadow', isOver && 'ring-sidebar-ring ring-2')}
    >
      {children}
    </div>
  );
}

/**
 * A section-level drop zone (group body, Pinned, Agents) so an agent can be
 * dropped anywhere in the section — including onto an empty group. Renders a
 * plain wrapper when the drag layer is off.
 */
export function Droppable({ id, data, children }: DroppableProps) {
  if (!useSidebarDndEnabled()) return <>{children}</>;
  return (
    <DroppableInner id={id} data={data}>
      {children}
    </DroppableInner>
  );
}

interface SortableListProps {
  /** Ordered sortable ids in this list (must match child `Sortable` ids). */
  items: string[];
  children: ReactNode;
}

/** A vertical `SortableContext` that no-ops when the drag layer is off. */
export function SortableList({ items, children }: SortableListProps) {
  if (!useSidebarDndEnabled()) return <>{children}</>;
  return (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

/** Build the dnd id for an agent row from its section key prefix + path. */
export function agentRowDndId(keyPrefix: string, path: string): string {
  return `${keyPrefix}::${path}`;
}

/**
 * Build an agent row's node data from its section key prefix + path. The prefix
 * (`pinned` / `ungrouped` / a group id) names the home container that the drop
 * reducer reads back as the drag source or hovered target.
 */
export function agentDndData(keyPrefix: string, path: string): SidebarDndData {
  if (keyPrefix === 'pinned') return { type: 'agent', path, container: { kind: 'pinned' } };
  if (keyPrefix === 'ungrouped') return { type: 'agent', path, container: { kind: 'ungrouped' } };
  return { type: 'agent', path, container: { kind: 'group', groupId: keyPrefix } };
}
