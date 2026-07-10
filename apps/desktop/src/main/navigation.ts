import type { BrowserWindow } from 'electron';

/**
 * Client route the "Settings…" menu item opens.
 *
 * Settings is a modal dialog toggled by the `settings` search param, not a
 * routed page — see `apps/client/src/layers/shared/model/use-dialog-deep-link.ts`
 * (`useSettingsDeepLink`). The dialog deep-links from any route, so this
 * lands on the dashboard with the param set, which reliably opens it
 * regardless of what the renderer was last showing.
 */
export const SETTINGS_ROUTE = '/?settings=open';

/**
 * Send the `navigate` IPC message to a window's renderer, asking the client's
 * TanStack Router to route to `path` (see ADR 260709-210223). This is the
 * single main → renderer navigation channel: menu items, the dock menu, and
 * (Chunk D) `dorkos://` deep links all funnel through this one function.
 *
 * A no-op when `win` is `null` or already destroyed — callers look up the
 * window at click-time (see `index.ts`'s `getMainWindow`), so this only
 * happens if the window closed between the click and the send.
 *
 * @param win - The window to navigate.
 * @param path - A client route path, optionally with a query string (e.g. `/agents`).
 */
export function sendNavigate(win: BrowserWindow | null, path: string): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('navigate', path);
}
