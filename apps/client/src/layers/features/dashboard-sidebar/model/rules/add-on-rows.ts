/**
 * The Add-ons section's rows — one per page a mini app added (spec
 * `mini-app-placement` Part 2).
 *
 * The pages arrive already chosen and ordered: `useSidebarState` reads the
 * registry's menu list, which leaves out `:param` paths and pages that asked not
 * to be listed, and sorts by title. So this decides only what a row says, and
 * that it is never dragged, pinned, muted or unread — the page belongs to its
 * extension, not to anything the operator filed.
 *
 * **Two pages with one title name their extensions.** Two extensions can each
 * add a "Settings" page, and two rows reading "Settings" cannot be told apart.
 * Each stays its own row; the shared title becomes `secondary` and the
 * extension becomes `primary`, so the row reads `flow › Settings` the way a
 * session row reads `agent › title`. The extension is named by its id: the
 * registry a page comes from does not carry the manifest's display name.
 *
 * @module features/dashboard-sidebar/model/rules/add-on-rows
 */
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarAddOnPage, SidebarState } from '../sidebar-state';
import { rowKey } from './targets';

/**
 * One page's row.
 *
 * @param page - The page, as the snapshot carries it.
 * @param titleShared - Whether another listed page has the same title.
 */
function addOnRow(page: SidebarAddOnPage, titleShared: boolean): SidebarRowModel {
  const target = { kind: 'add-on', extensionId: page.extensionId, path: page.path } as const;
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'page-icon', pageId: page.id },
    ...(titleShared
      ? { primary: page.extensionId, secondary: page.title }
      : { primary: page.title }),
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    reason: 'addons:page',
  };
}

/**
 * Every listed page's row, in the order the snapshot gives them.
 *
 * @param state - The snapshot.
 */
export function addOnRows(state: SidebarState): SidebarRowModel[] {
  const titleCounts = new Map<string, number>();
  for (const page of state.addOns) {
    titleCounts.set(page.title, (titleCounts.get(page.title) ?? 0) + 1);
  }
  return state.addOns.map((page) => addOnRow(page, (titleCounts.get(page.title) ?? 0) > 1));
}
