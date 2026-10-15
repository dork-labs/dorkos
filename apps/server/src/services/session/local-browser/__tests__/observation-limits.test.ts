import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import {
  boundedPageScreenshot,
  boundedPageSnapshot,
  MAX_BROWSER_SCREENSHOT_BYTES,
  MAX_BROWSER_SCREENSHOT_EDGE,
  MAX_BROWSER_SNAPSHOT_BYTES,
} from '../observation-limits.js';

function image(width: number, height: number, length = 24): Buffer {
  const bytes = Buffer.alloc(length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('local browser observation payload limits', () => {
  it('accepts the exact UTF-8 byte limit and refuses multibyte overflow without truncation', async () => {
    const read = vi.fn(async () => 'x'.repeat(MAX_BROWSER_SNAPSHOT_BYTES));
    const page = { locator: () => ({ ariaSnapshot: read }) } as unknown as Page;
    expect((await boundedPageSnapshot(page, 750)).length).toBe(MAX_BROWSER_SNAPSHOT_BYTES);
    read.mockResolvedValueOnce('界'.repeat(Math.ceil(MAX_BROWSER_SNAPSHOT_BYTES / 3)));
    await expect(boundedPageSnapshot(page, 750)).rejects.toMatchObject({ code: 'page_too_large' });
    expect(read).toHaveBeenCalledWith({ timeout: 750 });
  });

  it('accepts bounded viewport PNG bytes without applying a clip or changing the viewport', async () => {
    const bytes = image(4096, 4096, MAX_BROWSER_SCREENSHOT_BYTES);
    const screenshot = vi.fn(async () => bytes);
    const page = { screenshot } as unknown as Page;
    expect(await boundedPageScreenshot(page, 750)).toBe(bytes);
    expect(screenshot).toHaveBeenCalledExactlyOnceWith({
      type: 'png',
      fullPage: false,
      timeout: 750,
    });
  });

  it.each([
    [100, 100, MAX_BROWSER_SCREENSHOT_BYTES + 1],
    [MAX_BROWSER_SCREENSHOT_EDGE + 1, 1, 24],
    [4097, 4096, 24],
    [0, 100, 24],
  ])(
    'refuses oversize or empty image geometry %ix%i with %i bytes',
    async (width, height, length) => {
      const page = {
        screenshot: vi.fn(async () => image(width, height, length)),
      } as unknown as Page;
      await expect(boundedPageScreenshot(page, 750)).rejects.toMatchObject({
        code: 'image_too_large',
      });
    }
  );

  it('returns a recoverable error when the PNG header cannot be read', async () => {
    const page = {
      screenshot: vi.fn(async () => Buffer.from('private corrupted payload')),
    } as unknown as Page;
    await expect(boundedPageScreenshot(page, 750)).rejects.toMatchObject({
      code: 'image_unavailable',
      message: 'Couldn’t read this image. Try again.',
    });
  });
});
