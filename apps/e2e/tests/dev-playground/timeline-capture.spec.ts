import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * A screenshot of a scrolled conversation shows its messages (DOR-2230).
 *
 * The feedback dialog's pictures are re-drawn from the app's own DOM by
 * snapdom (`shared/lib/app-capture.ts`). Inside a scrolled container snapdom
 * adds the scroll offset to the inline `top` of every element whose INLINE
 * style says `position: absolute`. The timeline's drawn window used to be
 * exactly that, and it already sits inside the scrolled content, so the
 * correction pushed it a whole scroll height down and out of the picture.
 * Every report pointed at a conversation someone had scrolled arrived as an
 * empty list with the jump arrow on it, while the live list was fine.
 *
 * Only a browser can say this: jsdom has no rasterizer, so the unit test next
 * to the timeline (`Timeline.test.tsx`) can pin that the window carries no
 * inline position, and only this spec can pin that the picture has the rows.
 *
 * The long virtualized run in the Dev Playground is the host: it is the REAL
 * `Conversation.Timeline` drawing real `SessionMessage` rows, with no server
 * state behind it, and 400 rows is far more than one screen. The page around
 * it is not: every other showcase is cut away before anything is photographed
 * — see {@link openLongRun} for why that is necessary and why it is safe.
 */

/** Where the Timeline showcase lives. */
const PLAYGROUND_PATH = '/dev/conversation';

/**
 * The whole test's budget. A capture of the pruned page takes about a second
 * at 4x CPU throttling (measured), and the app itself gives up at 20s, so
 * this is room for the page load on a slow runner rather than for the capture.
 */
const TEST_BUDGET_MS = 90_000;

/**
 * Open the long run, wait for it to land at its newest message, and cut the
 * page down to it.
 *
 * **Why cut at all.** The capture re-draws the whole app root, and this
 * playground page holds every Conversation showcase at once: about 11,000
 * elements, where a real session page holds about 500. snapdom's cost grows
 * with that count, and on a CI runner it did not finish inside the app's 20s
 * bound (measured locally at 4x CPU throttling: over 20s for the full page,
 * about 1s once pruned to the long run's ~200 elements). Hiding the rest with
 * `display: none` does not help: snapdom still walks every hidden node, and
 * measured at 4x it timed out just the same.
 *
 * **Why cutting is safe.** Only SIBLINGS of the path from the app root down to
 * the long run's frame are removed. The timeline, its scroller, its rows and
 * every ancestor stay exactly as React drew them, so what is photographed is
 * the shipped component in the shipped capture. Nothing re-renders the removed
 * showcases before the test ends and the page is thrown away.
 *
 * @returns The feed and its scroller, landed and pruned.
 */
async function openLongRun(page: Page) {
  await page.goto(PLAYGROUND_PATH);
  const feed = page.getByRole('feed', { name: 'Long run demo' });
  await feed.scrollIntoViewIfNeeded({ timeout: 30_000 });
  await expect(feed.getByRole('article').first()).toBeVisible();

  // The run lands on its newest message, which is thousands of pixels down.
  const scroller = feed.locator('xpath=..');
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop), {
      message: 'the long run must land scrolled well past its first screen',
    })
    .toBeGreaterThan(2_000);

  const kept = await page.evaluate(() => {
    const frame = document
      .querySelector('[role="feed"][aria-label="Long run demo"]')
      ?.closest('[data-slot="conversation-timeline"]');
    const root = document.getElementById('root');
    if (!frame || !root) throw new Error('the long run is not on the page');
    for (let el: Element = frame; el !== root && el.parentElement; el = el.parentElement) {
      for (const sibling of Array.from(el.parentElement.children)) {
        if (sibling !== el) sibling.remove();
      }
    }
    return root.querySelectorAll('*').length;
  });
  expect(kept, 'the page must be cut down to the long run before it is photographed').toBeLessThan(
    1_000
  );
  await feed.scrollIntoViewIfNeeded();
  return { feed, scroller };
}

/**
 * Take the app's own picture of the page and count how much of the long run's
 * scroller is inked, as a share of its area — the whole of it, or only its
 * top half.
 *
 * It runs the shipped capture module rather than a copy of it: Vite serves the
 * source, so the import below is the same `captureAppShot` the feedback dialog
 * calls.
 */
async function inkShareOfScroller(
  page: Page,
  part: 'whole' | 'top-half' = 'whole'
): Promise<number> {
  return page.evaluate(async (part) => {
    const feed = document.querySelector('[role="feed"][aria-label="Long run demo"]');
    const scroller = feed?.parentElement;
    if (!scroller) throw new Error('the long run has no scroller');
    const modulePath = '/src/layers/shared/lib/app-capture.ts';
    const { captureAppShot } = (await import(/* @vite-ignore */ modulePath)) as {
      captureAppShot: () => Promise<{
        dataUrl: string;
        region: { left: number; top: number; width: number; height: number };
      }>;
    };
    const shot = await captureAppShot();
    const image = new Image();
    image.src = shot.dataUrl;
    await image.decode();

    const box = scroller.getBoundingClientRect();
    const scale = image.naturalWidth / shot.region.width;
    const sx = Math.round((box.left - shot.region.left) * scale);
    const sy = Math.round((box.top - shot.region.top) * scale);
    const sw = Math.round(box.width * scale);
    const sh = Math.round((part === 'top-half' ? box.height / 2 : box.height) * scale);
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const pixels = context.getImageData(0, 0, sw, sh).data;

    // An empty frame is one colour, whatever the theme made it, so ink is any
    // pixel far from the frame's most common colour: the text and avatars of a
    // row are, and the frame's own hairline border and scroll thumb are not.
    // Measured in Chromium: an empty list is at most 0.03% ink, four rows of
    // the run about 3%.
    const counts = new Map<number, number>();
    for (let i = 0; i < pixels.length; i += 4) {
      const colour = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
    let background = 0;
    let most = 0;
    for (const [colour, count] of counts) {
      if (count > most) [background, most] = [colour, count];
    }
    const [br, bg, bb] = [(background >> 16) & 255, (background >> 8) & 255, background & 255];
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const distance =
        Math.abs(pixels[i]! - br) + Math.abs(pixels[i + 1]! - bg) + Math.abs(pixels[i + 2]! - bb);
      if (distance > 150) ink++;
    }
    return ink / (sw * sh);
  }, part);
}

test.describe('Dev Playground — a screenshot of a scrolled conversation', () => {
  test.setTimeout(TEST_BUDGET_MS);

  test('shows the messages that are on screen, not an empty list', async ({ page }) => {
    // At its newest message, and then part-way up with the jump arrow on
    // screen — the two shapes the reports showed. Both are a scroll offset far
    // larger than the scroller is tall, which is what the old window lost.
    const { scroller } = await openLongRun(page);

    const atEnd = await inkShareOfScroller(page);
    expect(
      atEnd,
      'a picture of the list at its newest message must show the rows, not an empty frame'
    ).toBeGreaterThan(0.01);

    await scroller.evaluate((el) => {
      el.scrollTop = Math.round(el.scrollHeight / 2);
    });
    // The rows at the new offset are drawn a frame or two later. Wait until the
    // middle of the scroller is really over a message, as a reader would see it.
    await expect
      .poll(
        () =>
          scroller.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2
            );
            return hit?.closest('[role="article"]') != null;
          }),
        { message: 'the live list must show a message part-way up before it is photographed' }
      )
      .toBe(true);
    const midway = await inkShareOfScroller(page);
    expect(
      midway,
      'a picture of the list part-way up must show the rows, not an empty frame'
    ).toBeGreaterThan(0.01);
  });

  test('shows the top of the frame when the drawn rows start inside it', async ({ page }) => {
    // The other shape the reports had: one message at the bottom under a large
    // gap. The old picture moved the drawn rows down by the scroll offset, so
    // it came out blank wherever the first DRAWN row started below the top of
    // the frame. That is not the same as the scroll offset: the list draws a
    // few rows above the viewport too, so a small offset still starts drawing
    // at row 0 and the old picture looked merely unscrolled. So the offset is
    // chosen by where the drawn rows start — between half and all of one frame
    // down — and the top half of the picture must still hold a message.
    const { scroller } = await openLongRun(page);

    const drawnFrom = await scroller.evaluate(async (el) => {
      const settle = () =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // The sizer's only child is the box holding the drawn rows; its `top` is
      // where they start.
      const drawnTop = () =>
        (el.querySelector('[role="feed"] > div > div') as HTMLElement | null)?.offsetTop ?? -1;
      for (let offset = 0; offset < el.clientHeight * 6; offset += 16) {
        el.scrollTop = offset;
        await settle();
        const top = drawnTop();
        if (top >= el.clientHeight / 2 && top < el.clientHeight) return top / el.clientHeight;
      }
      return -1;
    });
    expect(
      drawnFrom,
      'the list must be scrolled so its drawn rows start inside the frame, below its middle'
    ).toBeGreaterThanOrEqual(0.5);
    await expect
      .poll(
        () =>
          scroller.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 24);
            return hit?.closest('[role="article"]') != null;
          }),
        { message: 'the live list must show a message at the top of the frame' }
      )
      .toBe(true);

    const topHalf = await inkShareOfScroller(page, 'top-half');
    expect(
      topHalf,
      'a picture must show rows at the top of the frame, not a gap above the first drawn row'
    ).toBeGreaterThan(0.01);
  });
});
