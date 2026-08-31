/**
 * Sidebar drag strip for the macOS desktop shell.
 *
 * @module app/TitlebarDragStrip
 */
import { cn } from '@/layers/shared/lib';
import { useElectronFullscreen } from './use-electron-fullscreen';

/**
 * A thin strip pinned to the top of the sidebar that lets the user drag the
 * frameless `titleBarStyle: 'hiddenInset'` window (DOR-253). 44px tall to
 * clear the native traffic lights, which the main process positions at
 * `{ x: 16, y: 16 }` (see `apps/desktop/src/main/window-manager.ts`) —
 * except in fullscreen (DOR-563), where the traffic lights retract into the
 * auto-hiding menu bar and this collapses to nothing rather than holding
 * open a dead gap in the one mode where screen space is the entire point.
 *
 * Renders as `hidden` outside the desktop shell — the `desktop-darwin`
 * variant (stamped on `<html>` by the `index.html` bootstrap script) is the
 * only thing that reveals it. A no-op in the browser and Obsidian.
 */
export function TitlebarDragStrip() {
  const isFullscreen = useElectronFullscreen();

  return (
    <div
      className={cn(
        'desktop-darwin:block app-drag-region hidden shrink-0',
        !isFullscreen && 'desktop-darwin:h-11'
      )}
      aria-hidden="true"
    />
  );
}
