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
 * The rule this helper follows: **report a field only when its value is
 * something the person actually chose.** Everything else is left out, and the
 * server's field-wise merge keeps the source Shape's value for it.
 *
 * **Captured**, because a real surface shows them and
 * `buildShapeLayoutCommands` replays them:
 *
 * - `sidebarOpen` — the desktop sidebar the user toggles; `open_sidebar` /
 *   `close_sidebar` drive it. Phones use persistent tabs instead.
 * - `openPanels` — **only when at least one panel is open.** The panels slice is
 *   transient (`app-store-panels.ts`: never persisted, resets on refresh) and a
 *   Shape's panels are replayed only on an explicit apply. So after a reload,
 *   "no panels open" is indistinguishable from "this session just reset" — we
 *   cannot tell a deliberate all-closed arrangement from an unobserved one, and
 *   the merge contract says an unobserved field keeps the source's value.
 *   Reporting `[]` would silently erase a source Shape's arrival panels for
 *   someone who chose nothing.
 *
 *   Accepted cost: a fork can never *clear* the source Shape's panels — closing
 *   every panel and forking carries the original's set forward, and clearing it
 *   means editing the forked manifest. That is the right side of the trade:
 *   losing a setting someone picked is worse than keeping one they didn't.
 *   (Dirty-tracking a "user touched a panel" flag was considered and rejected —
 *   `applyShapeLayout` opens panels programmatically, so the flag would be set
 *   by the system as often as by the person, producing false positives.)
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

  return {
    sidebarOpen: chrome.sidebarOpen,
    ...(openPanels.length > 0 ? { openPanels } : {}),
  };
}
