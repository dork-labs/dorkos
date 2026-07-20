/**
 * Map a Shape's resolved chrome ({@link ShapeLayout}) to the UI commands that
 * restore it, then dispatch them through the shared UI dispatcher — the same
 * seam the agent's `control_ui` and the command palette drive (spec §5 step 6).
 *
 * Split into a pure builder ({@link buildShapeLayoutCommands}) and a dispatch
 * wrapper ({@link applyShapeLayout}) so the mapping is unit-testable without a
 * store.
 *
 * @module entities/shapes/lib/apply-shape-layout
 */
import type { UiCommand } from '@dorkos/shared/types';
import type { ShapeLayout } from '@dorkos/shared/marketplace-schemas';
import { getPlatform } from '@/layers/shared/lib';

/**
 * Build the ordered UI commands that restore a Shape's chrome.
 *
 * Sidebar: a pinned tab is honored only where a sidebar tab strip exists — the
 * embedded (Obsidian) shell. When `sidebarTabsAvailable` and the Shape pins a
 * tab AND wants the sidebar open, one `switch_sidebar_tab` both selects the tab
 * and opens the sidebar. Otherwise (web cockpit — no strip — or no pinned tab) an
 * explicit open/close command sets visibility without forcing a tab, so the web
 * shell still honors `sidebarOpen` even though the tab pin has no target there.
 * Panels each get an `open_panel`. `focusDashboardSections` is an ordering hint
 * with no client store today (spec Q1), so it maps to no command — the dashboard
 * section simply appears once its extension is enabled + remounted.
 *
 * @param layout - The resolved chrome from `applied.layout`.
 * @param sidebarTabsAvailable - Whether the host renders a sidebar tab strip a
 *   pinned `sidebarTab` could select (true only on the embedded shell).
 * @returns The commands to dispatch, in order.
 */
export function buildShapeLayoutCommands(
  layout: ShapeLayout,
  sidebarTabsAvailable: boolean
): UiCommand[] {
  const commands: UiCommand[] = [];

  if (sidebarTabsAvailable && layout.sidebarTab && layout.sidebarOpen) {
    commands.push({ action: 'switch_sidebar_tab', tab: layout.sidebarTab });
  } else {
    commands.push({ action: layout.sidebarOpen ? 'open_sidebar' : 'close_sidebar' });
  }

  for (const panel of layout.openPanels) {
    commands.push({ action: 'open_panel', panel });
  }

  return commands;
}

/**
 * Restore a Shape's chrome by dispatching its layout commands.
 *
 * @param layout - The resolved chrome from `applied.layout`.
 * @param dispatch - Runs a single UI command (the caller binds the real
 *   dispatcher + origin — `'agent'` for an agent-issued switch, `'user'` for the switcher UI).
 */
export function applyShapeLayout(
  layout: ShapeLayout,
  dispatch: (command: UiCommand) => void
): void {
  // Only the embedded shell has a sidebar tab strip a pinned tab can target.
  const sidebarTabsAvailable = getPlatform().isEmbedded;
  for (const command of buildShapeLayoutCommands(layout, sidebarTabsAvailable)) dispatch(command);
}
