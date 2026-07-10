/**
 * Sidebar drag strip for the macOS desktop shell.
 *
 * @module app/TitlebarDragStrip
 */

/**
 * A thin strip pinned to the top of the sidebar that lets the user drag the
 * frameless `titleBarStyle: 'hiddenInset'` window (DOR-253). 44px tall to
 * clear the native traffic lights, which the main process positions at
 * `{ x: 16, y: 16 }` (see `apps/desktop/src/main/window-manager.ts`).
 *
 * Renders as `hidden` outside the desktop shell — the `desktop-darwin`
 * variant (stamped on `<html>` by the `index.html` bootstrap script) is the
 * only thing that reveals and sizes it. A no-op in the browser and Obsidian.
 */
export function TitlebarDragStrip() {
  return (
    <div
      className="desktop-darwin:block desktop-darwin:h-11 app-drag-region hidden shrink-0"
      aria-hidden="true"
    />
  );
}
