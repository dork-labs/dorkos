import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import { sidebarItemKey } from '../../model/sidebar-item';
import type { SidebarDndData, UngroupedSectionId } from '../../model/use-sidebar-dnd';

/**
 * Whether the sidebar drag layer is active. `SidebarDnd` sets this `true`; it
 * stays `false` on mobile (touch drag conflicts with scroll) and in any tree
 * without a `DndContext`, so the sortable/droppable primitives below can no-op
 * instead of calling dnd-kit hooks outside a provider.
 */
const SidebarDndEnabledContext = createContext(false);

/** Provider used by `SidebarDnd` to switch the drag primitives on. */
export const SidebarDndEnabledProvider = SidebarDndEnabledContext.Provider;

/**
 * The ARIA role the drag root wears, overriding dnd-kit's `button` default.
 *
 * **A whole sidebar row is the drag root, and a row is not a button — it
 * CONTAINS one** (DOR-1418). dnd-kit assumes the draggable is a bare handle and
 * defaults its `attributes` to `role="button"`; spread onto the wrapper around
 * a row, that put a `button` around the row's real `<button>`, its "⋮" and its
 * glyph action, which is the `nested-interactive` axe violation — 21 of them on
 * the sidebar once sections became draggable too. Screen readers do not reliably
 * announce a control nested inside another, so the outer role was actively
 * hiding the row it wrapped.
 *
 * `group` is the honest answer and it is not a widget role, so it may contain
 * focusable content: the wrapper really is a container of related controls, it
 * still takes `tabIndex`, `aria-disabled`, `aria-describedby` (dnd-kit's
 * keyboard instructions) and `aria-roledescription="sortable"` — which needs an
 * explicit role to be valid at all, so simply deleting the role would have
 * traded one violation for another.
 *
 * It costs `aria-pressed`, which dnd-kit emits only while the role is its
 * `button` default, and that is a real trade rather than a free one: the grabbed
 * state stops being a QUERYABLE attribute and becomes announcement-only, so a
 * reader who re-reads the row mid-drag is told nothing about it. What it is
 * traded for is that the row is announced at all — and announcement-only drag
 * state is the ARIA Authoring Practices drag-and-drop pattern, not a shortfall
 * of it: `buildSidebarAnnouncements` speaks the pick-up, every move and the drop
 * through the live region, which is how a keyboard drag here has always been
 * reported.
 */
const SORTABLE_ROOT_ROLE = 'group';

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

/**
 * Inert bindings used when the drag layer is disabled (no-op refs/handlers).
 * Also reused directly by callers that need a non-draggable row rendered
 * WITHOUT a `Sortable` wrapper at all (smart-group member rows, DOR-338 —
 * rule-owned membership is never draggable-out, drag layer or not).
 */
export const DISABLED_SORTABLE_BINDINGS: SortableBindings = {
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
  } = useSortable({ id, data, attributes: { role: SORTABLE_ROOT_ROLE } });
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
  // **Memoized, because the row underneath is** (`specs/sidebar-simplification`
  // D8). `RoomRow` is `React.memo` and takes these as one prop, so a fresh
  // bindings object on every render of the panel would defeat the memo for every
  // draggable row — which is all of them in the Library.
  const style = useMemo<CSSProperties>(
    () => ({
      transform: transform
        ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
        : undefined,
      transition: transition ?? undefined,
    }),
    [transform, transition]
  );
  const handleProps = useMemo(
    () => ({ ...attributes, ...(listeners ?? {}) }) as HTMLAttributes<HTMLElement>,
    [attributes, listeners]
  );
  const bindings = useMemo<SortableBindings>(
    () => ({ setNodeRef: setCombinedRef, handleProps, style, isDragging, isOver }),
    [setCombinedRef, handleProps, style, isDragging, isOver]
  );
  return <>{render(bindings)}</>;
}

/**
 * A sortable draggable. When the drag layer is off it renders its child with
 * inert bindings (no dnd-kit hook runs), so the same tree works on mobile and in
 * tests without a `DndContext`.
 */
export function Sortable({ id, data, children }: SortableProps) {
  if (!useSidebarDndEnabled()) return <>{children(DISABLED_SORTABLE_BINDINGS)}</>;
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
      // An inset 2px ring at 45% of the ring colour, not a ring drawn outside
      // the box and not a background wash (spec D5): the section's body is
      // clipped while it folds, and this container is the first thing inside it.
      className={cn('rounded-md transition-shadow', isOver && 'sidebar-drop-ring')}
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

/**
 * Build the dnd id for a sidebar row from its section key prefix + reference.
 *
 * This is an ephemeral DOM identity dnd-kit requires as a string — never a
 * membership key. Membership is compared with `sameSidebarItem` over the
 * `SidebarItemRef` in the node's data.
 *
 * Takes a reference rather than an agent path (rooms-in-groups, DOR-581): a room
 * row is a drag source too, and `sidebarItemKey` is the one place that spells a
 * reference as a string, so the two kinds cannot collide.
 */
export function sidebarRowDndId(keyPrefix: string, ref: SidebarItemRef): string {
  return `${keyPrefix}::${sidebarItemKey(ref)}`;
}

/**
 * Build a sidebar row's node data from its section key prefix + reference. The
 * prefix (`pinned` / `ungrouped` / a group id) names the home container that the
 * drop reducer reads back as the drag source or hovered target.
 *
 * `section` is the id of the ungrouped section this row actually sits in, for
 * the ARIA announcements only — "ungrouped" is three sections now (Agents,
 * Channels, Direct messages), and a hover that says "Over Agents." while the
 * cursor is over Channels is worse than no announcement at all.
 */
export function sidebarDndData(
  keyPrefix: string,
  ref: SidebarItemRef,
  section?: UngroupedSectionId
): SidebarDndData {
  if (keyPrefix === 'pinned') return { type: 'item', ref, container: { kind: 'pinned' } };
  if (keyPrefix === 'ungrouped') {
    return { type: 'item', ref, container: { kind: 'ungrouped', section } };
  }
  return { type: 'item', ref, container: { kind: 'group', groupId: keyPrefix } };
}
