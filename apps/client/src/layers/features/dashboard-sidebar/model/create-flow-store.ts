/**
 * The one create surface's state, held outside the panel body.
 *
 * The New menu is persistent chrome: it hangs off the header block, which
 * `AppShell` mounts OUTSIDE the `sidebar.body` swap region so a marketplace
 * takeover cannot take the way to make things with it (spec
 * `sidebar-now-today-library` R2, P2 AC-8). Everything that deep-links into it
 * — a Library section's hover `+`, an agent row's "Move to group ▸ New group" —
 * lives *inside* that body, under a different React tree. A context could not
 * span the two, so the state that both halves share lives here.
 *
 * Two things share it, and they are one flow seen from both ends:
 *
 * - **which item the menu opens on** (`preselect`), so a section's `+` is a
 *   deep link into the one menu rather than a second handler (BC-45);
 * - **the inline group-create editor** (`groupCreation`), which the menu starts
 *   and Library ▸ Agents draws, because a group's name belongs where the group
 *   will be.
 *
 * @module features/dashboard-sidebar/model/create-flow-store
 */
import { create } from 'zustand';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';

/**
 * The New menu's items, by name.
 *
 * This is the vocabulary AC-7 is asserted against: a create action anywhere in
 * the sidebar must be one of these, and the surfaces behind them are mounted in
 * exactly one module. `one-create-surface.test.ts` reads this list.
 */
export const NEW_MENU_ITEM_IDS = [
  'new-session',
  'new-channel',
  'new-message',
  'new-agent',
  'new-group',
] as const;

/** One of the New menu's items. */
export type NewMenuItemId = (typeof NEW_MENU_ITEM_IDS)[number];

/** The inline group-create flow, while it is running. */
export interface GroupCreationState {
  /**
   * What started the flow, and what lands in the new group on commit.
   *
   * A reference rather than an agent path, because "New group" is offered from
   * a room row's menu too (rooms-in-groups, DOR-581), and `null` when the New
   * menu started it with nothing to file.
   */
  pendingRef: SidebarItemRef | null;
}

/** Everything the one create surface needs to be reachable from both trees. */
interface CreateFlowState {
  /** Whether the New menu is open. */
  menuOpen: boolean;
  /** The item the menu should land on when it opens, or `null` for the top. */
  preselect: NewMenuItemId | null;
  /** The inline group-create flow, or `null` when it is not running. */
  groupCreation: GroupCreationState | null;
  /**
   * Open the New menu, optionally on one item.
   *
   * This is what a section's `+` calls. It is deliberately the only way in
   * besides the button itself, so "the `+` deep-links into this same menu" is a
   * fact about the code rather than a claim in a comment.
   *
   * @param preselect - The item to land on, or omitted for the top of the list.
   */
  openMenu: (preselect?: NewMenuItemId) => void;
  /**
   * Open or close the menu from the trigger itself, clearing any deep link.
   *
   * @param open - Whether the menu should be open.
   */
  setMenuOpen: (open: boolean) => void;
  /**
   * Begin the inline group-create flow, optionally seeded with a member.
   *
   * @param ref - The row that started it, which lands in the group on commit.
   */
  requestNewGroup: (ref?: SidebarItemRef) => void;
  /** End the flow — committed or abandoned, the editor closes either way. */
  endNewGroup: () => void;
}

/**
 * The store.
 *
 * A store rather than a context for the reason above: its two consumers sit in
 * two React trees that never meet.
 */
export const useCreateFlowStore = create<CreateFlowState>((set) => ({
  menuOpen: false,
  preselect: null,
  groupCreation: null,
  openMenu: (preselect) => set({ menuOpen: true, preselect: preselect ?? null }),
  setMenuOpen: (open) => set({ menuOpen: open, preselect: null }),
  requestNewGroup: (ref) => set({ groupCreation: { pendingRef: ref ?? null } }),
  endNewGroup: () => set({ groupCreation: null }),
}));
