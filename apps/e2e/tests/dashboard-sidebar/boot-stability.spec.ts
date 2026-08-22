import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import type { RoomsApi } from '../../fixtures/rooms-api';

/**
 * How the sidebar comes up: once on a cold load, and already finished on a warm
 * one (spec `sidebar-simplification` D6, tasks 3.1 and 3.2).
 *
 * **Only a browser can answer this.** Every claim here is about frames and
 * pixels — was there a skeleton, did the panel move after it painted, was the
 * face on this row the same face a second later. jsdom measures every element as
 * 0×0, runs no animation, and has no `localStorage` that survives a reload, so
 * the unit suite can settle the boot gate's truth table and the persisted
 * allow-list (`shared/lib/__tests__/query-persister.test.ts`,
 * `model/boot/__tests__/warm-boot.test.tsx`) and can settle nothing at all about
 * what an operator sees.
 *
 * **The defect it exists to catch** is the one D6 was written for: the panel
 * used to paint an empty box and then assemble itself over about eight beats —
 * Heads up, then pins and groups a round trip late, then the rooms, then the
 * agents, then every agent's name and face flipping at once.
 *
 * **The measurement is per FRAME, not per poll**, and that is the load-bearing
 * choice. A poll at +100 ms and another at +2000 ms can straddle a 160 ms
 * entrance animation and see two identical pictures with the whole reveal
 * between them — measured: with the synchronous restore removed, a poll-based
 * version of this test stayed green. So a sampler installed ahead of the bundle
 * records every distinct picture the panel showed, and a warm boot is required
 * to have shown exactly one.
 *
 * No agent turn is spent here — channels are the cheapest rows this suite can
 * make, and the fleet it reads is whatever the machine already has.
 *
 * **One assertion D6 asks for is deliberately absent**: "no `data-arrived` rows
 * on boot". That attribute is task 3.3's arrive animation and does not exist in
 * the tree yet, so asserting it counts to zero today would be a green check
 * proving nothing. 3.3 owns it, and its own task text says so. What IS asserted
 * here is the property that attribute would violate — the panel showed one
 * picture and never a second — which is checkable now and stays checkable.
 */

/** How long to watch after the panel has rows, for anything arriving late. */
const SETTLE_MS = 2_000;

/**
 * How many channels to seed.
 *
 * Enough that the panel has real rows in more than one zone, so "nothing moved"
 * is a claim about a populated list rather than about an empty one.
 */
const CHANNEL_COUNT = 12;

/** The sidebar's landmark. */
function nav(page: Page) {
  return page.locator('nav[aria-label="Sidebar"]');
}

/** The bones a cold boot shows. */
function skeleton(page: Page) {
  return page.getByTestId('sidebar-skeleton');
}

/** Every row the panel drew, in document order. */
function rows(page: Page) {
  return page.locator('nav[aria-label="Sidebar"] [data-sidebar-row]');
}

/** What the frame sampler collected. */
interface BootFilm {
  /** Every distinct picture of the row list, in the order it was shown. */
  pictures: string[];
  /** How many times the bones came and went. */
  skeletonAppeared: number;
  skeletonDisappeared: number;
}

/**
 * Film the sidebar from before the app's first line of script runs.
 *
 * Each frame it writes down what the panel looked like — every row's title, its
 * face, and its box rounded to the pixel — and keeps the picture only when it
 * differs from the last one. A boot that assembles itself leaves a reel; a warm
 * boot leaves a single frame.
 *
 * Rounded to the pixel because a browser's fractional layout wobbles below that
 * for reasons that have nothing to do with data arriving late, and a test that
 * fails on 0.004 px is a test somebody deletes.
 *
 * @param page - The page under test, before `goto` or `reload`.
 */
async function filmBoot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const film: { pictures: string[]; skeletonAppeared: number; skeletonDisappeared: number } = {
      pictures: [],
      skeletonAppeared: 0,
      skeletonDisappeared: 0,
    };
    (window as unknown as { __bootFilm: typeof film }).__bootFilm = film;

    let bones = false;
    const frame = () => {
      const hasBones = document.querySelector('[data-testid="sidebar-skeleton"]') !== null;
      if (hasBones !== bones) {
        bones = hasBones;
        if (hasBones) film.skeletonAppeared++;
        else film.skeletonDisappeared++;
      }

      const found = document.querySelectorAll('nav[aria-label="Sidebar"] [data-sidebar-row]');
      if (found.length > 0) {
        // `getBoundingClientRect` carries an ANCESTOR transform, which is where
        // the reveal's 4px rise lives — the zones move, the rows do not — so a
        // row's own box is what notices an entrance animation.
        const picture = [...found]
          .map((row) => {
            const box = row.getBoundingClientRect();
            const title = row.querySelector('[data-slot="sidebar-row-title"]')?.textContent ?? '';
            const face =
              row.querySelector('[data-slot="identity-avatar"]')?.getAttribute('data-face') ?? '';
            return `${title}|${face}|${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`;
          })
          .join('\n');
        if (film.pictures[film.pictures.length - 1] !== picture) film.pictures.push(picture);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/** What the sampler saw. */
async function bootFilm(page: Page): Promise<BootFilm> {
  return page.evaluate(() => (window as unknown as { __bootFilm: BootFilm }).__bootFilm);
}

/**
 * Seed enough channels that the panel has a real list to be stable about.
 *
 * @param roomsApi - This run's seeder, which also puts the rooms away again.
 */
async function seedChannels(roomsApi: RoomsApi): Promise<void> {
  for (let i = 0; i < CHANNEL_COUNT; i++) {
    await roomsApi.createChannel(`e2e-boot-${roomsApi.runId}-${i}`);
  }
}

test.describe('the sidebar’s first paint @smoke', () => {
  test('shows bones once on a cold load, and one finished picture on a warm one', async ({
    page,
    roomsApi,
  }) => {
    await seedChannels(roomsApi);

    // ── Cold: nothing is remembered, so the panel shows bones ──
    await filmBoot(page);
    await page.goto('/');

    await expect(skeleton(page)).toBeVisible();
    await expect(nav(page)).toHaveAttribute('aria-busy', 'true');

    await expect(skeleton(page)).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);

    // One change of state, not two. `AnimatePresence mode="wait"` is what makes
    // it one; a panel that flickered back to bones on a refetch would count two.
    const cold = await bootFilm(page);
    expect(cold.skeletonAppeared).toBe(1);
    expect(cold.skeletonDisappeared).toBe(1);

    // The cold boot has to have left something behind, or the warm leg below
    // would be proving that a cold boot is fast rather than that a warm one is
    // warm.
    const remembered = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) => key.startsWith('dorkos:rq:'))
    );
    expect(remembered).toHaveLength(1);

    const settledPicture = cold.pictures[cold.pictures.length - 1];

    // ── Warm: the reload paints the finished panel and never changes it ──
    await filmBoot(page);
    await page.reload();

    await expect(rows(page).first()).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    const warm = await bootFilm(page);

    // (1) No bones, ever — and no `aria-busy` announcing them.
    expect(warm.skeletonAppeared).toBe(0);
    await expect(nav(page)).not.toHaveAttribute('aria-busy', 'true');

    // (2), (3) and (4) at once: ONE picture. Every row was in its final place,
    // with its final title and its final face, on the first frame it existed,
    // and nothing about it changed for the next two seconds. A row arriving
    // late, a zone rising 4px into place, a group restructuring after the config
    // landed, or an agent's face flipping from its directory hash to its
    // manifest (DOR-1143) would each be a second picture.
    expect(warm.pictures).toHaveLength(1);

    // …and the picture it painted is the one the last load ended on, not some
    // half-remembered subset of it.
    expect(warm.pictures[0]).toBe(settledPicture);
  });
});
