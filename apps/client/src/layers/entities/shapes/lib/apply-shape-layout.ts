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

/**
 * Build sidebar visibility and panel commands from a Shape's layout.
 * Legacy `sidebarTab` metadata is accepted but has no active tab strip to target.
 */
export function buildShapeLayoutCommands(layout: ShapeLayout): UiCommand[] {
  const commands: UiCommand[] = [];
  commands.push({ action: layout.sidebarOpen ? 'open_sidebar' : 'close_sidebar' });

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
  for (const command of buildShapeLayoutCommands(layout)) dispatch(command);
}
