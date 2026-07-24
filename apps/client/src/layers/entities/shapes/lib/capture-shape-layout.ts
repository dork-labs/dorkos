/**
 * Snapshot the live workspace chrome into the partial layout a capture-current
 * fork sends to the server (`POST /api/shapes/:name/fork`, `liveLayout`).
 *
 * This is the inverse of {@link import('./apply-shape-layout').buildShapeLayoutCommands}:
 * it captures exactly the state that builder replays, so a fork of the Shape you
 * are living in reproduces the arrangement you were living in.
 *
 * @module entities/shapes/lib/capture-shape-layout
 */
import type { ShapeLiveLayoutCapture } from '@dorkos/shared/schemas';

/**
 * The live chrome a capture reads. A structural subset of the app store rather
 * than the store itself, so the mapping stays pure and unit-testable.
 */
export interface LiveChromeSnapshot {
  /** Sidebar visibility (`CoreSlice.sidebarOpen`). */
  sidebarOpen: boolean;
  /** Settings dialog open (`PanelsSlice.settingsOpen`). */
  settingsOpen: boolean;
  /** Tasks dialog open (`PanelsSlice.tasksOpen`). */
  tasksOpen: boolean;
  /** Relay panel open (`PanelsSlice.relayOpen`). */
  relayOpen: boolean;
  /** Picker panel open (`PanelsSlice.pickerOpen`). */
  pickerOpen: boolean;
}

/**
 * Build the partial layout capture from the live chrome.
 *
 * **Captured**, because a real surface shows them and the person set them by
 * hand — and `buildShapeLayoutCommands` replays both:
 *
 * - `sidebarOpen` — the cockpit sidebar the user toggles; `open_sidebar` /
 *   `close_sidebar` drive it on every host.
 * - `openPanels` — the four independent panel booleans the store keeps, mapped
 *   onto the `settings | tasks | relay | picker` ids `open_panel` drives.
 *
 * **Omitted**, so the server's merge keeps the source Shape's value rather than
 * writing something nobody chose:
 *
 * - `sidebarTab` — `switch_sidebar_tab` only reaches a sidebar tab strip, and
 *   the web cockpit retired its strip (DOR-401). `sidebarActiveTab` is
 *   write-and-report state no surface renders, so no one has picked a value to
 *   capture.
 * - `focusDashboardSections` — there is no client state behind it at all; it is
 *   an ordering hint that maps to no command. Reporting one would be inventing
 *   an observation.
 *
 * @param chrome - The live chrome to snapshot.
 * @returns The partial capture to send as `liveLayout`.
 */
export function captureShapeLayout(chrome: LiveChromeSnapshot): ShapeLiveLayoutCapture {
  const openPanels: NonNullable<ShapeLiveLayoutCapture['openPanels']> = [];
  if (chrome.settingsOpen) openPanels.push('settings');
  if (chrome.tasksOpen) openPanels.push('tasks');
  if (chrome.relayOpen) openPanels.push('relay');
  if (chrome.pickerOpen) openPanels.push('picker');

  return { sidebarOpen: chrome.sidebarOpen, openPanels };
}
