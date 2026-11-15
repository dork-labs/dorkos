import type { BrowserWindow, WebContentsView } from 'electron';

/** JPEG quality for the still: high enough that the swap can't be seen. */
export const PAGE_STILL_QUALITY = 95;

/**
 * A still of the page a window shows right now, for the app to draw in its place
 * while an app layer covers it (DOR-4438), or `null`, and the app hides the page as
 * before. Only the window that shows the page gets it, and only while it is on screen:
 * never another window's page, never a hidden one. The bytes stay in memory.
 *
 * @param view - The page's native view.
 * @param shownIn - The window the page is in now.
 * @param asker - The window that asked.
 */
export async function capturePageStill(
  view: Pick<WebContentsView, 'getVisible' | 'webContents'>,
  shownIn: BrowserWindow | undefined,
  asker: BrowserWindow | null
): Promise<Uint8Array | null> {
  if (!asker || shownIn !== asker || view.webContents.isDestroyed() || !view.getVisible())
    return null;
  try {
    const image = await view.webContents.capturePage();
    return image.isEmpty() ? null : new Uint8Array(image.toJPEG(PAGE_STILL_QUALITY));
  } catch {
    return null;
  }
}
