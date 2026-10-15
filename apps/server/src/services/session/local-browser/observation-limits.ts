import type { Page } from 'playwright-core';
import { LocalBrowserError } from './errors.js';

/** Maximum accessibility payload before granting an action observation. */
export const MAX_BROWSER_SNAPSHOT_BYTES = 128 * 1024;
/** Maximum encoded PNG bytes returned by the screenshot tool, before base64 expansion. */
export const MAX_BROWSER_SCREENSHOT_BYTES = 4 * 1024 * 1024;
/** Maximum screenshot edge; capture never resizes or scrolls the person's live page. */
export const MAX_BROWSER_SCREENSHOT_EDGE = 8192;
/** Maximum screenshot area, allowing a full 5K display while bounding decoded pixels. */
export const MAX_BROWSER_SCREENSHOT_PIXELS = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Read a bounded UTF-8 snapshot without truncating away controls or granting a partial revision. */
export async function boundedPageSnapshot(page: Page, timeout: number): Promise<string> {
  const snapshot = await page.locator('body').ariaSnapshot({ timeout });
  if (Buffer.byteLength(snapshot, 'utf8') > MAX_BROWSER_SNAPSHOT_BYTES)
    throw new LocalBrowserError('page_too_large', 'This page is too large. Open a simpler page.');
  return snapshot;
}

/** Capture the current viewport and refuse oversize PNG data without changing the live viewport. */
export async function boundedPageScreenshot(page: Page, timeout: number): Promise<Buffer> {
  const bytes = await page.screenshot({ type: 'png', fullPage: false, timeout });
  if (bytes.length > MAX_BROWSER_SCREENSHOT_BYTES)
    throw new LocalBrowserError(
      'image_too_large',
      'This image is too large. Make the browser window smaller.'
    );
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new LocalBrowserError('image_unavailable', 'Couldn’t read this image. Try again.');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > MAX_BROWSER_SCREENSHOT_EDGE ||
    height > MAX_BROWSER_SCREENSHOT_EDGE ||
    width * height > MAX_BROWSER_SCREENSHOT_PIXELS
  )
    throw new LocalBrowserError(
      'image_too_large',
      'This image is too large. Make the browser window smaller.'
    );
  return bytes;
}
