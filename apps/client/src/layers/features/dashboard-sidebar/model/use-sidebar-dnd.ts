/**
 * Sidebar drag-and-drop semantics (DOR-329).
 *
 * The heart of the sidebar's drag layer is a PURE reducer: given what is being
 * dragged and what it was dropped on, {@link classifySidebarDrop} names the
 * operation and {@link applySidebarDropOp} maps it to the existing
 * `entities/config` prefs helpers. Keeping the semantics pure means every row of
 * the drop table is unit-testable without synthetic pointer events (repo rule),
 * and the live dnd-kit wiring in `SidebarDnd` stays a thin adapter that only
 * converts drag events into these descriptors.
 *
 * The same descriptors drive per-operation ARIA announcements
 * ({@link buildSidebarAnnouncements}) so the spoken feedback can never drift
 * from what the reducer actually does.
 *
 * @module features/dashboard-sidebar/model/use-sidebar-dnd
 */
import type { SidebarPrefs } from '@dorkos/shared/config-schema';
import {
  pinPath,
  unpinPath,
  moveToGroup,
  reorderGroup,
  reorderWithinGroup,
  reorderPinned,
} from '@/layers/entities/config';

/** Where an agent row lives — its home section during a drag, or a drop target. */
export type AgentContainer =
  | { kind: 'pinned' }
  | { kind: 'group'; groupId: string }
  | { kind: 'ungrouped' };

/**
 * The `data` object a draggable/droppable node carries. dnd-kit reuses one data
 * object for a node's draggable AND droppable roles, so this single shape is
 * converted to a source ({@link SidebarDragDescriptor}) or a target
 * ({@link SidebarDropDescriptor}) depending on which role fired.
 */
export type SidebarDndData =
  | { type: 'agent'; path: string; container: AgentContainer }
  | { type: 'group'; groupId: string }
  | { type: 'container'; container: AgentContainer };

/** Normalized description of what is being dragged. */
export type SidebarDragDescriptor =
  | { type: 'agent'; path: string; from: AgentContainer }
  | { type: 'group'; groupId: string };

/** Normalized description of what a drag was dropped onto. */
export type SidebarDropDescriptor =
  | { type: 'agent-item'; path: string; container: AgentContainer }
  | { type: 'group-header'; groupId: string }
  | { type: 'container'; container: AgentContainer };

/** The named operation a drop resolves to (also the announcement subject). */
type SidebarDropOp =
  | { kind: 'none' }
  | { kind: 'reorder-group'; groupId: string; from: number; to: number }
  | { kind: 'move-to-group'; path: string; groupId: string; toIndex: number | null }
  | { kind: 'pin'; path: string }
  | { kind: 'unpin'; path: string }
  | { kind: 'remove-from-group'; path: string }
  | { kind: 'reorder-within-group'; groupId: string; path: string; from: number; to: number }
  | { kind: 'reorder-pinned'; path: string; from: number; to: number };

// ---------------------------------------------------------------------------
// Node-data ↔ descriptor conversion (used by the live dnd adapter + tests)
// ---------------------------------------------------------------------------

function isAgentContainer(value: unknown): value is AgentContainer {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'pinned' || kind === 'ungrouped') return true;
  return kind === 'group' && typeof (value as { groupId?: unknown }).groupId === 'string';
}

/**
 * Narrow an arbitrary dnd-kit `data.current` payload to {@link SidebarDndData}.
 * dnd-kit merges its own `sortable` bookkeeping into the object, so only the
 * fields we set are read; anything unrecognized returns `null`.
 *
 * @param data - The raw `active.data.current` / `over.data.current` value.
 */
export function readSidebarDndData(data: unknown): SidebarDndData | null {
  if (typeof data !== 'object' || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (type === 'agent') {
    const path = (data as { path?: unknown }).path;
    const container = (data as { container?: unknown }).container;
    if (typeof path === 'string' && isAgentContainer(container)) {
      return { type: 'agent', path, container };
    }
    return null;
  }
  if (type === 'group') {
    const groupId = (data as { groupId?: unknown }).groupId;
    return typeof groupId === 'string' ? { type: 'group', groupId } : null;
  }
  if (type === 'container') {
    const container = (data as { container?: unknown }).container;
    return isAgentContainer(container) ? { type: 'container', container } : null;
  }
  return null;
}

/** Interpret a node's data as a drag source (containers are never draggable). */
export function toDragDescriptor(data: SidebarDndData | null): SidebarDragDescriptor | null {
  if (data === null) return null;
  if (data.type === 'agent') return { type: 'agent', path: data.path, from: data.container };
  if (data.type === 'group') return { type: 'group', groupId: data.groupId };
  return null;
}

/** Interpret a node's data as a drop target. */
export function toDropDescriptor(data: SidebarDndData | null): SidebarDropDescriptor | null {
  if (data === null) return null;
  switch (data.type) {
    case 'agent':
      return { type: 'agent-item', path: data.path, container: data.container };
    case 'group':
      return { type: 'group-header', groupId: data.groupId };
    case 'container':
      return { type: 'container', container: data.container };
  }
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

/** A drop target resolved to its container plus the row hovered over (if any). */
function resolveTarget(drop: SidebarDropDescriptor): {
  container: AgentContainer;
  overPath?: string;
} {
  switch (drop.type) {
    case 'container':
      return { container: drop.container };
    case 'agent-item':
      return { container: drop.container, overPath: drop.path };
    case 'group-header':
      return { container: { kind: 'group', groupId: drop.groupId } };
  }
}

/** Build a move-to-group op, honoring the drop index only for `manual` groups. */
function moveToGroupOp(
  prev: SidebarPrefs,
  path: string,
  groupId: string,
  overPath: string | undefined
): SidebarDropOp {
  const group = prev.groups.find((g) => g.id === groupId);
  if (!group) return { kind: 'none' };
  let toIndex: number | null = null;
  if (group.sortMode === 'manual' && overPath !== undefined) {
    const idx = group.agentPaths.indexOf(overPath);
    if (idx >= 0) toIndex = idx;
  }
  return { kind: 'move-to-group', path, groupId, toIndex };
}

/**
 * Classify a drop into a named {@link SidebarDropOp}. Pure and index-complete —
 * every reorder op carries the concrete `from`/`to`/`toIndex` computed from
 * `prev`, so {@link applySidebarDropOp} needs no further lookups and tests can
 * assert the operation directly.
 *
 * Implements the full drop-semantics table:
 * - group header → group header: reorder groups
 * - agent → group body/header: move to group (append, or drop index if manual)
 * - agent → Pinned: pin (reference; home membership untouched)
 * - agent in a manual group → same group: reorder within group
 * - agent in a name/recent group → same group: no reorder (sort owns order)
 * - pinned row → within Pinned: reorder pinned
 * - pinned row → outside Pinned: unpin
 * - agent in a group → Agents (ungrouped): remove from group
 *
 * @param prev - Current sidebar prefs.
 * @param drag - What is being dragged.
 * @param drop - What it was dropped on, or `null` for no valid target.
 */
export function classifySidebarDrop(
  prev: SidebarPrefs,
  drag: SidebarDragDescriptor,
  drop: SidebarDropDescriptor | null
): SidebarDropOp {
  if (drop === null) return { kind: 'none' };

  // ── Group header reorder (groups only reorder among their own headers) ──
  if (drag.type === 'group') {
    if (drop.type !== 'group-header') return { kind: 'none' };
    const from = prev.groups.findIndex((g) => g.id === drag.groupId);
    const to = prev.groups.findIndex((g) => g.id === drop.groupId);
    if (from < 0 || to < 0 || from === to) return { kind: 'none' };
    return { kind: 'reorder-group', groupId: drag.groupId, from, to };
  }

  // ── Agent row ──
  const { path, from } = drag;
  const { container, overPath } = resolveTarget(drop);

  // Source: a pinned reference.
  if (from.kind === 'pinned') {
    if (container.kind !== 'pinned') return { kind: 'unpin', path }; // Finder drag-out.
    if (overPath === undefined) return { kind: 'none' };
    const fromIdx = prev.pinned.indexOf(path);
    const toIdx = prev.pinned.indexOf(overPath);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return { kind: 'none' };
    return { kind: 'reorder-pinned', path, from: fromIdx, to: toIdx };
  }

  // Source: inside a group.
  if (from.kind === 'group') {
    if (container.kind === 'pinned') return { kind: 'pin', path };
    if (container.kind === 'ungrouped') return { kind: 'remove-from-group', path };
    if (container.groupId !== from.groupId) {
      return moveToGroupOp(prev, path, container.groupId, overPath);
    }
    // Reorder within the same group — only when it is manually sorted.
    const group = prev.groups.find((g) => g.id === from.groupId);
    if (!group || group.sortMode !== 'manual' || overPath === undefined) return { kind: 'none' };
    const fromIdx = group.agentPaths.indexOf(path);
    const toIdx = group.agentPaths.indexOf(overPath);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return { kind: 'none' };
    return { kind: 'reorder-within-group', groupId: from.groupId, path, from: fromIdx, to: toIdx };
  }

  // Source: ungrouped.
  if (container.kind === 'pinned') return { kind: 'pin', path };
  if (container.kind === 'group') return moveToGroupOp(prev, path, container.groupId, overPath);
  return { kind: 'none' }; // ungrouped → ungrouped has no manual order.
}

/**
 * Apply a classified {@link SidebarDropOp} to `prev`, immutably. Each branch
 * maps to an existing pure prefs helper; `none` returns `prev` unchanged.
 *
 * @param prev - Current sidebar prefs.
 * @param op - The operation from {@link classifySidebarDrop}.
 */
function applySidebarDropOp(prev: SidebarPrefs, op: SidebarDropOp): SidebarPrefs {
  switch (op.kind) {
    case 'none':
      return prev;
    case 'reorder-group':
      return reorderGroup(prev, op.from, op.to);
    case 'pin':
      return pinPath(prev, op.path);
    case 'unpin':
      return unpinPath(prev, op.path);
    case 'remove-from-group':
      return moveToGroup(prev, op.path, null);
    case 'reorder-within-group':
      return reorderWithinGroup(prev, op.groupId, op.from, op.to);
    case 'reorder-pinned':
      return reorderPinned(prev, op.from, op.to);
    case 'move-to-group': {
      const moved = moveToGroup(prev, op.path, op.groupId);
      if (op.toIndex === null) return moved;
      const group = moved.groups.find((g) => g.id === op.groupId);
      if (!group) return moved;
      // `moveToGroup` appends the path last; slot it at the requested index.
      return reorderWithinGroup(moved, op.groupId, group.agentPaths.length - 1, op.toIndex);
    }
  }
}

/**
 * Resolve a drag gesture to the next prefs in one call: classify then apply.
 * Returns `prev` unchanged for no-op and unknown-target drops.
 *
 * @param prev - Current sidebar prefs.
 * @param drag - What is being dragged.
 * @param drop - What it was dropped on, or `null`.
 */
export function resolveSidebarDrop(
  prev: SidebarPrefs,
  drag: SidebarDragDescriptor,
  drop: SidebarDropDescriptor | null
): SidebarPrefs {
  return applySidebarDropOp(prev, classifySidebarDrop(prev, drag, drop));
}

// ---------------------------------------------------------------------------
// ARIA announcements — worded per operation, driven by the same descriptors
// ---------------------------------------------------------------------------

/** Name resolvers the announcements read so spoken feedback uses real labels. */
interface SidebarDndAnnounceContext {
  /** Current prefs (so a drag-over can be classified live). */
  prefs: SidebarPrefs;
  /** Resolve an agent projectPath to its display name. */
  agentName: (path: string) => string;
  /** Resolve a group id to its display name. */
  groupName: (groupId: string) => string;
}

/** Announce picking up a draggable. */
function describeSidebarPickup(
  drag: SidebarDragDescriptor,
  ctx: SidebarDndAnnounceContext
): string {
  return drag.type === 'group'
    ? `Picked up group ${ctx.groupName(drag.groupId)}.`
    : `Picked up ${ctx.agentName(drag.path)}.`;
}

/** Announce the result of a drop, worded per operation. */
function describeSidebarDropOp(op: SidebarDropOp, ctx: SidebarDndAnnounceContext): string {
  switch (op.kind) {
    case 'reorder-group':
      return `Moved group ${ctx.groupName(op.groupId)}.`;
    case 'move-to-group':
      return `Moved ${ctx.agentName(op.path)} to group ${ctx.groupName(op.groupId)}.`;
    case 'pin':
      return `Pinned ${ctx.agentName(op.path)}.`;
    case 'unpin':
      return `Unpinned ${ctx.agentName(op.path)}.`;
    case 'remove-from-group':
      return `Moved ${ctx.agentName(op.path)} to Agents.`;
    case 'reorder-within-group':
      return `Reordered ${ctx.agentName(op.path)} in group ${ctx.groupName(op.groupId)}.`;
    case 'reorder-pinned':
      return `Reordered ${ctx.agentName(op.path)} in Pinned.`;
    case 'none':
      return '';
  }
}

/** Announce hovering a drop target (calm, container-level). */
function describeSidebarDragOver(
  drop: SidebarDropDescriptor | null,
  ctx: SidebarDndAnnounceContext
): string {
  if (drop === null) return '';
  const { container } = resolveTarget(drop);
  switch (container.kind) {
    case 'pinned':
      return 'Over Pinned.';
    case 'ungrouped':
      return 'Over Agents.';
    case 'group':
      return `Over group ${ctx.groupName(container.groupId)}.`;
  }
}

/** A dnd event as the announcements read it (structural subset of dnd-kit's). */
interface AnnounceEvent {
  active: { data: { current?: unknown } };
  over?: { data: { current?: unknown } } | null;
}

/** The four announcement callbacks dnd-kit's `accessibility.announcements` needs. */
interface SidebarAnnouncements {
  onDragStart: (event: AnnounceEvent) => string | undefined;
  onDragOver: (event: AnnounceEvent) => string | undefined;
  onDragEnd: (event: AnnounceEvent) => string | undefined;
  onDragCancel: (event: AnnounceEvent) => string | undefined;
}

/**
 * Build the dnd-kit announcements object. Each callback reads the live context
 * (via `getContext`, so prefs/names stay current across a drag) and delegates to
 * the pure `describe*` helpers — the exact strings the reducer's operations map
 * to, so announcements can never describe an operation that did not happen.
 *
 * @param getContext - Returns the current announce context on each call.
 */
export function buildSidebarAnnouncements(
  getContext: () => SidebarDndAnnounceContext
): SidebarAnnouncements {
  const drag = (event: AnnounceEvent) =>
    toDragDescriptor(readSidebarDndData(event.active.data.current));
  const drop = (event: AnnounceEvent) =>
    toDropDescriptor(readSidebarDndData(event.over?.data.current));
  return {
    onDragStart: (event) => {
      const d = drag(event);
      return d ? describeSidebarPickup(d, getContext()) : undefined;
    },
    onDragOver: (event) => {
      const d = drag(event);
      if (!d) return undefined;
      return describeSidebarDragOver(drop(event), getContext()) || undefined;
    },
    onDragEnd: (event) => {
      const d = drag(event);
      if (!d) return undefined;
      const ctx = getContext();
      const op = classifySidebarDrop(ctx.prefs, d, drop(event));
      if (op.kind === 'none') return 'Movement cancelled. Item returned to its place.';
      return describeSidebarDropOp(op, ctx);
    },
    onDragCancel: (event) => {
      const d = drag(event);
      if (!d) return undefined;
      const subject =
        d.type === 'group' ? getContext().groupName(d.groupId) : getContext().agentName(d.path);
      return `Movement cancelled. ${subject} returned to its place.`;
    },
  };
}
