/**
 * The words a section's sort submenu puts on the choice (sidebar-groups,
 * DOR-580).
 *
 * The vocabulary only. The sorting itself moved into
 * `rules/build-sections.ts` with everything else that decides what a
 * section shows, and the display filter went with it — a section's rows are the
 * model's business now. The file kept its exports and lost its verbs, so it is
 * named for what it holds rather than for what it used to do.
 *
 * @module features/dashboard-sidebar/model/section-sort-options
 */
/** How a section orders its rows. */
export type SidebarSortMode = 'manual' | 'name' | 'recent';

/**
 * What the sort submenu is called, wherever it appears — a group's header menu
 * and the Channels and Direct messages header menus. One constant so the same verb reads the
 * same in every menu that carries it (spec `rooms` §14.1).
 */
export const SORT_MENU_LABEL = 'Sort by';

/**
 * Every sort mode a section can offer, in menu order, with the words a person
 * sees. A section that cannot offer one filters it out — Channels, Direct
 * messages and smart groups all drop `manual`, because none has a
 * hand-orderable sequence — but no section renames one.
 */
export const SECTION_SORT_OPTIONS: { value: SidebarSortMode; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'recent', label: 'Recent activity' },
  { value: 'name', label: 'Name' },
];
