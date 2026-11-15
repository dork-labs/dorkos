import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, NativeImage, WebContentsView } from 'electron';
import { capturePageStill, PAGE_STILL_QUALITY } from '../page-still';

/**
 * DOR-4438: the still a covered page leaves behind. What the picture looks like is
 * a real-Electron fact for the CI smoke; this pins who gets one and when.
 */

const window = (name: string) => ({ name }) as unknown as BrowserWindow;
const jpeg = Buffer.from([0xff, 0xd8, 0xff]);

function page({
  visible = true,
  destroyed = false,
  capture = () => Promise.resolve({ isEmpty: () => false, toJPEG: () => jpeg }),
}: {
  visible?: boolean;
  destroyed?: boolean;
  capture?: () => Promise<Partial<NativeImage>>;
} = {}) {
  const capturePage = vi.fn(capture);
  return {
    capturePage,
    view: {
      getVisible: () => visible,
      webContents: { isDestroyed: () => destroyed, capturePage },
    } as unknown as WebContentsView,
  };
}

describe('capturePageStill', () => {
  it('gives the window showing the page a JPEG of it', async () => {
    const own = window('own');
    let quality: number | undefined;
    const { view } = page({
      capture: () =>
        Promise.resolve({
          isEmpty: () => false,
          toJPEG: (asked: number) => {
            quality = asked;
            return jpeg;
          },
        }),
    });

    const still = await capturePageStill(view, own, own);

    expect(still).toBeInstanceOf(Uint8Array);
    expect([...still!]).toEqual([0xff, 0xd8, 0xff]);
    expect(quality).toBe(PAGE_STILL_QUALITY);
  });

  it('never captures a page another window shows', async () => {
    const { view, capturePage } = page();
    expect(await capturePageStill(view, window('own'), window('other'))).toBeNull();
    expect(await capturePageStill(view, window('own'), null)).toBeNull();
    expect(await capturePageStill(view, undefined, window('other'))).toBeNull();
    expect(capturePage).not.toHaveBeenCalled();
  });

  it('never captures a hidden or closed page', async () => {
    const own = window('own');
    const hidden = page({ visible: false });
    const closed = page({ destroyed: true });
    expect(await capturePageStill(hidden.view, own, own)).toBeNull();
    expect(await capturePageStill(closed.view, own, own)).toBeNull();
    expect(hidden.capturePage).not.toHaveBeenCalled();
    expect(closed.capturePage).not.toHaveBeenCalled();
  });

  it('answers null, never a blank picture or a thrown error, when capture fails', async () => {
    const own = window('own');
    const empty = page({ capture: () => Promise.resolve({ isEmpty: () => true }) });
    const broken = page({ capture: () => Promise.reject(new Error('compositor gone')) });
    expect(await capturePageStill(empty.view, own, own)).toBeNull();
    expect(await capturePageStill(broken.view, own, own)).toBeNull();
  });
});
