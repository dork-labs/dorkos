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
 * What the sort submenu is called, wherever it appears — a group's header menu
 * and the Agents header menu today. One constant so the same verb reads the
 * same in every menu that carries it (spec `rooms` §14.1).
 */
export const SORT_MENU_LABEL = 'Sort by';

/**
 * Every sort mode a section can offer, in menu order, with the words a person
 * sees. A section that cannot offer one filters it out — the ungrouped Agents
 * list and smart groups both drop `manual`, because neither has a
 * hand-orderable sequence — but no section renames one.
 */
export const SECTION_SORT_OPTIONS: { value: SidebarSortMode; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'recent', label: 'Recent activity' },
  { value: 'name', label: 'Name' },
];

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
