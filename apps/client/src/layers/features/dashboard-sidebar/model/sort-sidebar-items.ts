/**
 * Pure ordering for a sidebar section's rows (sidebar-groups, DOR-580).
 *
 * Sorts the item view model rather than agent paths, so a group holding a
 * channel next to an agent orders them together instead of in two passes.
 * Sibling of `filter-sidebar-items.ts`: that decides which rows a section shows,
 * this decides what order they come in. Every sort is total, immutable, and
 * never reads anything a {@link SidebarItem} does not carry.
 *
 * @module features/dashboard-sidebar/model/sort-sidebar-items
 */
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import type { SidebarItem } from './sidebar-item';

/** How a section orders its rows. */
export type SidebarSortMode = 'manual' | 'name' | 'recent';

/**
 * The last-resort tiebreak, so rows that tie never swap places between renders.
 *
 * A group can hold an agent and a room whose names and activity both tie, and
 * `Array.prototype.sort` is only stable with respect to the array it is given —
 * which is rebuilt every render from prefs and two queries. Without a total
 * order, a tie reshuffles under the pointer; the rooms work has already been
 * bitten by exactly that (`specs/rooms/02-specification.md` §12.2 fix round).
 *
 * Kind decides first so a tie resolves the same way regardless of which
 * happened to be listed first, then the reference's own stable identity.
 */
function compareRefs(a: SidebarItemRef, b: SidebarItemRef): number {
  if (a.kind === 'agent') return b.kind === 'agent' ? a.path.localeCompare(b.path) : -1;
  return b.kind === 'room' ? a.roomId.localeCompare(b.roomId) : 1;
}

/** Ascending by name, then by reference. */
function compareByName(a: SidebarItem, b: SidebarItem): number {
  return a.name.localeCompare(b.name) || compareRefs(a.ref, b.ref);
}

/** Most recently active first; never-active last; ties fall through to name. */
function compareByRecency(a: SidebarItem, b: SidebarItem): number {
  if (a.lastActiveAt !== null && b.lastActiveAt !== null) {
    if (a.lastActiveAt !== b.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
    return compareByName(a, b);
  }
  if (a.lastActiveAt !== null) return -1;
  if (b.lastActiveAt !== null) return 1;
  return compareByName(a, b);
}

/**
 * Order a section's items, immutably.
 *
 * - `manual` — a copy of the given order, which for a manual group IS the stored
 *   `items` order.
 * - `name` — ascending `localeCompare` on the item's name.
 * - `recent` — most recent first, items that were never active last.
 *
 * @param items - The items to order.
 * @param mode - The section's sort mode.
 */
export function sortSidebarItems(
  items: readonly SidebarItem[],
  mode: SidebarSortMode
): SidebarItem[] {
  if (mode === 'manual') return [...items];
  return [...items].sort(mode === 'name' ? compareByName : compareByRecency);
}
