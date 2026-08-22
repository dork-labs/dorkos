/**
 * Sidebar drag-and-drop semantics (DOR-329).
 *
 * The heart of the sidebar's drag layer is a PURE reducer: given what is being
 * dragged and what it was dropped on, {@link classifySidebarDrop} names the
 * operation and `applySidebarDropOp` maps it to the existing `entities/config`
 * prefs helpers. Keeping the semantics pure means every row of the drop table is
 * unit-testable without synthetic pointer events (repo rule), and the live
 * dnd-kit wiring in `SidebarDnd` stays a thin adapter that only converts drag
 * events into these descriptors.
 *
 * Every descriptor carries a `SidebarItemRef` rather than an agent path
 * (sidebar-groups, DOR-579), so the same reducer covers rooms once they become
 * draggable — the rules below never look at what kind of item they are moving.
 *
 * The same descriptors drive per-operation ARIA announcements
 * ({@link buildSidebarAnnouncements}) so the spoken feedback can never drift
 * from what the reducer actually does.
 *
 * @module features/dashboard-sidebar/model/use-sidebar-dnd
 */
import type { SidebarPrefs, SidebarItemRef } from '@dorkos/shared/config-schema';
import { sameSidebarItem } from '@dorkos/shared/config-schema';
import {
  pinItem,
  unpinItem,
  moveToGroup,
  reorderGroup,
  reorderWithinGroup,
  reorderPinned,
} from '@/layers/entities/config';

/**
 * What a drop into Heads up or Today is answered with (R3).
 *
 * One spelling, read by the toast the operator sees and by the announcement a
 * screen reader hears, so the two can never drift. It names the way out rather
 * than only the refusal: the row CAN be kept in place, by pinning it.
 */
export const COMPUTED_ZONE_REJECTION =
  'Heads up and Today are computed — pin it to Library to keep it in place.';

/**
 * The three Library sections a row can sit in without belonging to a group.
 *
 * **Ids, not labels.** This travelled as the printed name ("Direct messages")
 * while the section's own id was `dms`, so a container carried a string that
 * could only be compared against copy — one rename away from a drop target
 * nothing recognised. The label is looked up when a sentence needs one, in
 * {@link UNGROUPED_SECTION_LABEL}.
 */
export type UngroupedSectionId = 'channels' | 'dms' | 'agents';

/** What each ungrouped section is called out loud, for the announcements. */
const UNGROUPED_SECTION_LABEL: Record<UngroupedSectionId, string> = {
  channels: 'Channels',
  dms: 'Direct messages',
  agents: 'Agents',
};

/** Where a sidebar row lives — its home section during a drag, or a drop target. */
export type SidebarContainer =
  | { kind: 'pinned' }
  | { kind: 'group'; groupId: string }
  /**
   * "In no group at all", which since rooms became draggable (DOR-581) is three
   * sections rather than one: Agents, Channels and Direct messages. They behave
   * identically as a drop target — landing in any of them takes the row out of
   * its group and lets it fall back to wherever it belongs — so they share the
   * kind. `section` is the id of the one actually under the cursor, read ONLY
   * by the ARIA announcements; nothing in the reducer branches on it.
   */
  | { kind: 'ungrouped'; section?: UngroupedSectionId }
  /**
   * A computed zone — Heads up, Today or Getting started (R3).
   *
   * These are the only containers that are never a home: nothing is dragged
   * OUT of them, because the model gives every row in them `draggable: false`.
   * They exist as a container so a row dragged INTO one is rejected with a
   * sentence instead of springing back in silence.
   */
  | { kind: 'computed'; zone: 'now' | 'today' | 'getting-started' };

/**
 * The `data` object a draggable/droppable node carries. dnd-kit reuses one data
 * object for a node's draggable AND droppable roles, so this single shape is
 * converted to a source ({@link SidebarDragDescriptor}) or a target
 * ({@link SidebarDropDescriptor}) depending on which role fired.
 */
export type SidebarDndData =
  | { type: 'item'; ref: SidebarItemRef; container: SidebarContainer }
  | { type: 'group'; groupId: string }
  | { type: 'container'; container: SidebarContainer };

/** Normalized description of what is being dragged. */
export type SidebarDragDescriptor =
  | { type: 'item'; ref: SidebarItemRef; from: SidebarContainer }
  | { type: 'group'; groupId: string };

/** Normalized description of what a drag was dropped onto. */
export type SidebarDropDescriptor =
  | { type: 'item'; ref: SidebarItemRef; container: SidebarContainer }
  | { type: 'group-header'; groupId: string }
  | { type: 'container'; container: SidebarContainer };

/** The named operation a drop resolves to (also the announcement subject). */
type SidebarDropOp =
  | { kind: 'none' }
  | { kind: 'reorder-group'; groupId: string; from: number; to: number }
  | { kind: 'move-to-group'; ref: SidebarItemRef; groupId: string; toIndex: number | null }
  | { kind: 'pin'; ref: SidebarItemRef }
  | { kind: 'unpin'; ref: SidebarItemRef }
  | { kind: 'remove-from-group'; ref: SidebarItemRef }
  | {
      kind: 'reorder-within-group';
      groupId: string;
      ref: SidebarItemRef;
      from: number;
      to: number;
    }
  | { kind: 'reorder-pinned'; ref: SidebarItemRef; from: number; to: number }
  /**
   * A drop targeted a smart group's body/header (smart-agent-groups,
   * DOR-338). Applying this op is a no-op — smart-group membership is
   * rule-derived, never a valid drop target — but the distinct kind lets
   * `SidebarDnd` surface a hint instead of silently doing nothing. A room
   * dropped on a smart group resolves here unchanged.
   */
  | { kind: 'reject-smart-group'; groupId: string; ref: SidebarItemRef }
  /**
   * A drop landed in a computed zone (R3). Applying it is a no-op — Heads up and
   * Today are derived, so there is no stored order for a row to take a place
   * in — and the distinct kind is what lets `SidebarDnd` say so rather than
   * appear to lose the gesture.
   */
  | { kind: 'reject-computed-zone'; ref: SidebarItemRef };

// ---------------------------------------------------------------------------
// Node-data ↔ descriptor conversion (used by the live dnd adapter + tests)
// ---------------------------------------------------------------------------

function isSidebarContainer(value: unknown): value is SidebarContainer {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'pinned') return true;
  if (kind === 'ungrouped') {
    const section = (value as { section?: unknown }).section;
    return (
      section === undefined || (typeof section === 'string' && section in UNGROUPED_SECTION_LABEL)
    );
  }
  if (kind === 'computed') {
    const zone = (value as { zone?: unknown }).zone;
    return zone === 'now' || zone === 'today' || zone === 'getting-started';
  }
  return kind === 'group' && typeof (value as { groupId?: unknown }).groupId === 'string';
}

/** Narrow an arbitrary value to a {@link SidebarItemRef} (both union branches). */
function isSidebarItemRef(value: unknown): value is SidebarItemRef {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'agent') return typeof (value as { path?: unknown }).path === 'string';
  return kind === 'room' && typeof (value as { roomId?: unknown }).roomId === 'string';
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
  if (type === 'item') {
    const ref = (data as { ref?: unknown }).ref;
    const container = (data as { container?: unknown }).container;
    if (isSidebarItemRef(ref) && isSidebarContainer(container)) {
      return { type: 'item', ref, container };
    }
    return null;
  }
  if (type === 'group') {
    const groupId = (data as { groupId?: unknown }).groupId;
    return typeof groupId === 'string' ? { type: 'group', groupId } : null;
  }
  if (type === 'container') {
    const container = (data as { container?: unknown }).container;
    return isSidebarContainer(container) ? { type: 'container', container } : null;
  }
  return null;
}

/** Interpret a node's data as a drag source (containers are never draggable). */
export function toDragDescriptor(data: SidebarDndData | null): SidebarDragDescriptor | null {
  if (data === null) return null;
  if (data.type === 'item') return { type: 'item', ref: data.ref, from: data.container };
  if (data.type === 'group') return { type: 'group', groupId: data.groupId };
  return null;
}

/** Interpret a node's data as a drop target. */
export function toDropDescriptor(data: SidebarDndData | null): SidebarDropDescriptor | null {
  if (data === null) return null;
  switch (data.type) {
    case 'item':
      return { type: 'item', ref: data.ref, container: data.container };
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
  container: SidebarContainer;
  overRef?: SidebarItemRef;
} {
  switch (drop.type) {
    case 'container':
      return { container: drop.container };
    case 'item':
      return { container: drop.container, overRef: drop.ref };
    case 'group-header':
      return { container: { kind: 'group', groupId: drop.groupId } };
  }
}

/** Index of `ref` in a member/pinned list, or `-1`. Union equality, never `===`. */
function indexOfRef(list: readonly SidebarItemRef[], ref: SidebarItemRef): number {
  return list.findIndex((entry) => sameSidebarItem(entry, ref));
}

/**
 * Build a move-to-group op, honoring the drop index only for `manual`
 * groups. Smart groups (DOR-338) are never a valid drop target — membership
 * is rule-derived — so any drop resolving here rejects instead.
 */
function moveToGroupOp(
  prev: SidebarPrefs,
  ref: SidebarItemRef,
  groupId: string,
  overRef: SidebarItemRef | undefined
): SidebarDropOp {
  const group = prev.groups.find((g) => g.id === groupId);
  if (!group) return { kind: 'none' };
  if (group.kind === 'smart') return { kind: 'reject-smart-group', groupId, ref };
  let toIndex: number | null = null;
  if (group.sortMode === 'manual' && overRef !== undefined) {
    const idx = indexOfRef(group.items, overRef);
    if (idx >= 0) toIndex = idx;
  }
  return { kind: 'move-to-group', ref, groupId, toIndex };
}

/**
 * Classify a drop into a named {@link SidebarDropOp}. Pure and index-complete —
 * every reorder op carries the concrete `from`/`to`/`toIndex` computed from
 * `prev`, so `applySidebarDropOp` needs no further lookups and tests can assert
 * the operation directly.
 *
 * Implements the full drop-semantics table:
 * - group header → group header: reorder groups
 * - item → group body/header: move to group (append, or drop index if manual)
 * - item → Pinned: pin (reference; home membership untouched)
 * - item in a manual group → same group: reorder within group
 * - item in a name/recent group → same group: no reorder (sort owns order)
 * - pinned row → within Pinned: reorder pinned
 * - pinned row → a non-pinned container (Agents or a group): unpin
 * - item in a group → Agents (ungrouped): remove from group
 *
 * A `null`/void drop (released with no valid target) is always a no-op — unpin
 * fires only when a pinned row actually lands on a non-pinned container, never
 * from dropping into empty space.
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

  // ── Item row ──
  const { ref, from } = drag;
  const { container, overRef } = resolveTarget(drop);

  // Heads up and Today are computed, and dragging into them would be a lie about
  // what the operator controls (R3, design-meta rule 6). Checked FIRST, before
  // any source branch: where the row came from does not change the answer, and
  // putting it here is what leaves the existing table below untouched.
  if (container.kind === 'computed') return { kind: 'reject-computed-zone', ref };

  // Source: a pinned reference.
  if (from.kind === 'pinned') {
    if (container.kind !== 'pinned') return { kind: 'unpin', ref }; // Finder drag-out.
    if (overRef === undefined) return { kind: 'none' };
    const fromIdx = indexOfRef(prev.pinned, ref);
    const toIdx = indexOfRef(prev.pinned, overRef);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return { kind: 'none' };
    return { kind: 'reorder-pinned', ref, from: fromIdx, to: toIdx };
  }

  // Source: inside a group.
  if (from.kind === 'group') {
    if (container.kind === 'pinned') return { kind: 'pin', ref };
    if (container.kind === 'ungrouped') return { kind: 'remove-from-group', ref };
    if (container.groupId !== from.groupId) {
      return moveToGroupOp(prev, ref, container.groupId, overRef);
    }
    // Reorder within the same group — only when it is manually sorted.
    const group = prev.groups.find((g) => g.id === from.groupId);
    if (!group || group.sortMode !== 'manual' || overRef === undefined) return { kind: 'none' };
    const fromIdx = indexOfRef(group.items, ref);
    const toIdx = indexOfRef(group.items, overRef);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return { kind: 'none' };
    return { kind: 'reorder-within-group', groupId: from.groupId, ref, from: fromIdx, to: toIdx };
  }

  // Source: ungrouped.
  if (container.kind === 'pinned') return { kind: 'pin', ref };
  if (container.kind === 'group') return moveToGroupOp(prev, ref, container.groupId, overRef);
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
    case 'reject-smart-group':
    case 'reject-computed-zone':
      return prev;
    case 'reorder-group':
      return reorderGroup(prev, op.from, op.to);
    case 'pin':
      return pinItem(prev, op.ref);
    case 'unpin':
      return unpinItem(prev, op.ref);
    case 'remove-from-group':
      return moveToGroup(prev, op.ref, null);
    case 'reorder-within-group':
      return reorderWithinGroup(prev, op.groupId, op.from, op.to);
    case 'reorder-pinned':
      return reorderPinned(prev, op.from, op.to);
    case 'move-to-group': {
      const moved = moveToGroup(prev, op.ref, op.groupId);
      if (op.toIndex === null) return moved;
      const group = moved.groups.find((g) => g.id === op.groupId);
      if (!group) return moved;
      // `moveToGroup` appends the ref last; slot it at the requested index.
      return reorderWithinGroup(moved, op.groupId, group.items.length - 1, op.toIndex);
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
  /** Resolve a sidebar item reference to its display name. */
  itemName: (ref: SidebarItemRef) => string;
  /** Resolve a section id to its display name. */
  groupName: (groupId: string) => string;
}

/** Announce picking up a draggable. */
function describeSidebarPickup(
  drag: SidebarDragDescriptor,
  ctx: SidebarDndAnnounceContext
): string {
  return drag.type === 'group'
    ? `Picked up section ${ctx.groupName(drag.groupId)}.`
    : `Picked up ${ctx.itemName(drag.ref)}.`;
}

/** Announce the result of a drop, worded per operation. */
function describeSidebarDropOp(op: SidebarDropOp, ctx: SidebarDndAnnounceContext): string {
  switch (op.kind) {
    case 'reorder-group':
      return `Moved section ${ctx.groupName(op.groupId)}.`;
    case 'move-to-group':
      return `Moved ${ctx.itemName(op.ref)} to ${ctx.groupName(op.groupId)}.`;
    case 'pin':
      return `Pinned ${ctx.itemName(op.ref)}.`;
    case 'unpin':
      return `Unpinned ${ctx.itemName(op.ref)}.`;
    case 'remove-from-group':
      // Names no destination section on purpose. The row lands back wherever it
      // belongs — an agent in Agents, a channel in Channels, a conversation in
      // Direct messages — and which of the three received the drop does not
      // decide that, so naming one would be right only a third of the time.
      return `Moved ${ctx.itemName(op.ref)} out of its section.`;
    case 'reorder-within-group':
      return `Reordered ${ctx.itemName(op.ref)} in ${ctx.groupName(op.groupId)}.`;
    case 'reorder-pinned':
      return `Reordered ${ctx.itemName(op.ref)} in Pinned.`;
    case 'reject-smart-group':
      return `Can't move ${ctx.itemName(op.ref)} into ${ctx.groupName(op.groupId)} — membership is rule-based. Edit rules instead.`;
    case 'reject-computed-zone':
      return `Can't move ${ctx.itemName(op.ref)} there — ${COMPUTED_ZONE_REJECTION}`;
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
      return `Over ${container.section === undefined ? 'Agents' : UNGROUPED_SECTION_LABEL[container.section]}.`;
    case 'computed':
      return container.zone === 'today' ? 'Over Today.' : 'Over Heads up.';
    case 'group':
      return `Over ${ctx.groupName(container.groupId)}.`;
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
      const ctx = getContext();
      const subject = d.type === 'group' ? ctx.groupName(d.groupId) : ctx.itemName(d.ref);
      return `Movement cancelled. ${subject} returned to its place.`;
    },
  };
}
