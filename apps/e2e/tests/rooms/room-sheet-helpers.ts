/**
 * The ruler the room-sheet browser specs measure with.
 *
 * Shared by `room-sheet.spec.ts` and `room-sheet-phone.spec.ts`, which are one
 * subject split by viewport rather than two subjects. Everything those files
 * assert is **geometric or portal-bound**, which is why they exist at all:
 * jsdom reports every element as 0×0, so it cannot see a clipped focus ring, a
 * 44px touch target, a drawer that grows off the top of a phone, or a label
 * that ellipsises. The sheet's unit suite covers what it says; those cover what
 * it *is* on a laid-out page.
 *
 * **Three measurement traps live here, each of which cost a red run.** They are
 * documented on the helper that defends against them rather than in a list,
 * because the next person meets them one at a time: geometry has to wait for a
 * drawer to stop moving ({@link rectOf}), `elementFromPoint` works in viewport
 * coordinates ({@link touchHeight}), and a Tailwind ring is one layer of a
 * five-layer `box-shadow` whose unused layers are all zeros ({@link ringBleed}).
 *
 * @module tests/rooms/room-sheet-helpers
 */
import type { Locator, Page } from '@playwright/test';
import { expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS, type RoomsApi, type SeededAgent } from '../../fixtures/rooms-api';

/** iPhone 14/15 in portrait — the width the sheet's phone rendering was cut for. */
export const PHONE = { width: 390, height: 844 } as const;

/** The smallest thing a thumb can reliably hit, in CSS pixels. */
export const TOUCH_TARGET_PX = 44;
/**
 * How tall a control really is to a finger, including any invisible reach it
 * gives itself.
 *
 * `boundingBox()` answers with the border box, which is the wrong number for
 * anything that widens its own hit area with a pseudo-element — the loudness
 * pill is 32px of visible pill plus 6px of `::after` each way, and a test
 * reading 32 would fail a control that is fine. So the page is *probed*: walk
 * a pixel at a time out from the border box and ask the browser what it would
 * hit, which is the same question a thumb asks.
 *
 * @param locator - The control to measure.
 * @returns Its hit height in CSS pixels.
 */
export async function touchHeight(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    // `contains` covers the element's own children; a pseudo-element hit-tests
    // as the element that owns it, so `::after` reach lands on `el` itself.
    const owns = (y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    };

    /**
     * The exact y where this control stops answering, found by halving.
     *
     * **Not a one-pixel-at-a-time walk, and the difference is the whole
     * measurement.** Stepping in integers loses the fraction at each end — a
     * band running 602.0 to 646.0 probed on whole pixels answers from 603 to
     * 644 and reports 41 for a control that is exactly 44. That looked like a
     * real miss of the 44px bar and was an artefact of the ruler.
     *
     * @param outward - -1 for up, 1 for down.
     */
    const edge = (outward: -1 | 1) => {
      let inside = box.top + box.height / 2;
      // 32px is past any reach this sheet gives anything, so a control that
      // still answers there is a hit area that has swallowed its neighbours.
      let outside = inside + outward * 32;
      if (owns(outside)) return outside;
      for (let i = 0; i < 14; i += 1) {
        const mid = (inside + outside) / 2;
        if (owns(mid)) inside = mid;
        else outside = mid;
      }
      return outside;
    };

    return edge(1) - edge(-1);
  });
}

/** A rect as the page reports it, in viewport coordinates. */
export interface Rect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

/**
 * One element's box, read only once it has stopped moving.
 *
 * **Every geometric assertion in this file has to wait for this, and finding
 * that out cost the first run seven reds.** A drawer opens by sliding up under
 * a transform, and `toBeVisible()` is satisfied the instant it mounts — so a
 * measurement taken then reports the sheet 517px below the fold, its controls
 * off-screen, and `elementFromPoint` answering `null` for all of them. Every
 * one of those looks exactly like a real layout bug and none of them were.
 *
 * Three identical frames rather than a fixed wait: it returns as soon as the
 * animation lands, and it cannot be tuned wrong on a slower machine.
 */
export async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate(
    (el) =>
      new Promise<Rect>((resolve) => {
        let previous = '';
        let stable = 0;
        const tick = () => {
          const b = el.getBoundingClientRect();
          const key = `${b.top},${b.left},${b.width},${b.height}`;
          if (key === previous) stable += 1;
          else {
            stable = 0;
            previous = key;
          }
          if (stable >= 3) {
            resolve({
              top: b.top,
              right: b.right,
              bottom: b.bottom,
              left: b.left,
              width: b.width,
              height: b.height,
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })
  );
}

/** Wait for something to finish moving, when the box itself is not wanted. */
export async function settled(locator: Locator): Promise<void> {
  await rectOf(locator);
}

/**
 * Walk the keyboard onto a control, so that focus arrives the way a person's
 * does.
 *
 * The point is the modality, not the destination: Chromium paints
 * `:focus-visible` only for focus that arrived by keyboard, so anything
 * asserting on a focus ring has to get there this way or it measures a ring
 * that was never drawn.
 *
 * @param page - The page to press keys on.
 * @param target - Where the keyboard should end up.
 */
export async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tabbed twenty times without reaching the control');
}

/**
 * How far outside its own box a focused control paints its ring, in pixels.
 *
 * Read from the ring rather than assumed, for two reasons that both make a
 * fixed `2` wrong. A ring declared `ring-inset` paints *inside*, so it can
 * never be clipped and asserting 2px of bleed on one would fail a control that
 * is fine. And a control that is not showing a ring at all bleeds nothing — a
 * test that measured 2px there would be asserting against a ring nobody drew,
 * which is the vacuous pass this returns `null` to prevent.
 */
export async function ringBleed(locator: Locator): Promise<number | null> {
  return locator.evaluate((el) => {
    const shadow = getComputedStyle(el).boxShadow;
    if (shadow === 'none' || shadow === '') return null;

    // **Split into layers first, and that is not a nicety.** Tailwind v4 builds
    // `box-shadow` as five stacked layers — inset shadow, inset ring, ring
    // offset, ring, shadow — and the unused ones compute to
    // `rgba(0, 0, 0, 0) 0px 0px 0px 0px`. Reading "the fourth length in the
    // string" therefore reads the FIRST layer's spread, which is always 0, and
    // reports every ring in the cockpit as bleeding nothing.
    //
    // The commas inside `rgb(...)` are why this is a scan rather than a split.
    const layers: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of shadow) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (char === ',' && depth === 0) {
        layers.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    layers.push(current);

    let widest = 0;
    for (const layer of layers) {
      // An inset ring paints inside the border box, so it bleeds nothing and no
      // clip can reach it. That is an answer, not a missing measurement.
      if (layer.includes('inset')) continue;
      const lengths = layer.match(/(-?[\d.]+)px/g);
      if (lengths === null || lengths.length < 4) continue;
      widest = Math.max(widest, Math.abs(parseFloat(lengths[3]!)));
    }
    return widest;
  });
}

/**
 * How far a laid-out element pokes out of the nearest ancestor that clips.
 *
 * Positive on any edge means the clip is eating it. Used for two different
 * defects with one measurement: a focus ring shaved by an `overflow-hidden`,
 * and the working dot's ping shaved by the same.
 *
 * @param locator - The element that must survive its clips.
 * @param bleed - Extra pixels the element paints outside its own box — a ring's
 *   width, or how far an `animate-ping` scales past its origin.
 */
export async function clipOverflow(
  locator: Locator,
  bleed: number
): Promise<{ clipped: boolean; worst: number; clipper: string }> {
  return locator.evaluate((el, extra) => {
    const box = el.getBoundingClientRect();
    const painted = {
      top: box.top - extra,
      right: box.right + extra,
      bottom: box.bottom + extra,
      left: box.left - extra,
    };
    let worst = -Infinity;
    let clipper = 'none';
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      const clips =
        style.overflow !== 'visible' ||
        style.overflowX !== 'visible' ||
        style.overflowY !== 'visible';
      if (!clips) continue;
      const bounds = node.getBoundingClientRect();
      // A scrolling box is not a clip in the sense that matters here — its
      // content is reachable by scrolling. Only a hidden overflow destroys.
      const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (scrolls) continue;
      const over = Math.max(
        bounds.top - painted.top,
        painted.bottom - bounds.bottom,
        bounds.left - painted.left,
        painted.right - bounds.right
      );
      if (over > worst) {
        worst = over;
        clipper = `${node.tagName.toLowerCase()}.${node.className}`.slice(0, 120);
      }
    }
    // Sub-pixel layout noise is not a shaved ring.
    return { clipped: worst > 0.5, worst: worst === -Infinity ? 0 : worst, clipper };
  }, bleed);
}

/** How long a CSS transition on this element runs, in milliseconds. */
export async function transitionMs(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const declared = getComputedStyle(el).transitionDuration.split(',')[0]!.trim();
    return declared.endsWith('ms') ? parseFloat(declared) : parseFloat(declared) * 1000;
  });
}

/**
 * A channel seeded through the API and silenced.
 *
 * @param roomsApi - The test's own seeder.
 * @param label - Goes in the slug, so a failure names the test that made it.
 * @param crowd - Extra agents beyond the two every test gets. A roster only
 *   overflows the phone's sheet once there are enough of them, and a scroll
 *   assertion against a list that fits proves nothing.
 */
export async function seedRoom(
  roomsApi: RoomsApi,
  label: string,
  crowd = 0
): Promise<{ slug: string; roomId: string; ana: SeededAgent; kai: SeededAgent }> {
  const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
  const kai = await roomsApi.registerAgent(`E2E Kai ${roomsApi.runId}`, '🐙', '#7c3aed');
  const extras: SeededAgent[] = [];
  for (let i = 0; i < crowd; i += 1) {
    extras.push(await roomsApi.registerAgent(`E2E Crowd${i} ${roomsApi.runId}`, '🤖', '#0891b2'));
  }
  const slug = `e2e-${label}-${roomsApi.runId}`;
  const room = await roomsApi.createChannel(slug, slug, [ana, kai, ...extras]);
  return { slug, roomId: room.id, ana, kai };
}

/**
 * Open a room and then its details panel, and hand back the panel once it has
 * finished arriving.
 *
 * **Two shapes, one locator** (phase R2, spec `one-bar-header` §3.6). On a
 * desktop the panel is an inset column beside the room; on a phone it is a
 * slide-over. Both are the right panel's body, which carries `role="tabpanel"`
 * whenever more than one tab is visible — and on a room route two always are, so
 * the one role finds it at either width. The old modal's `role="dialog"` is only
 * the phone's outer sheet now, and matching on it would have found nothing at
 * all on a desktop.
 *
 * The settle is not politeness: on a phone this still slides in, and everything
 * in this file measures.
 */
export async function openSheet(page: Page, roomId: string): Promise<Locator> {
  await page.goto(`/channels?id=${roomId}`);
  await page.getByTestId('bar-members-chip').click();
  const sheet = page.getByRole('tabpanel');
  await expect(sheet).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
  await settled(sheet);
  return sheet;
}

/** One member's row in the panel, found by the name it prints. */
export function memberRow(sheet: Locator, name: string): Locator {
  return sheet
    .locator('[data-slot="room-member-row"]')
    .filter({ has: sheet.page().getByText(name, { exact: false }) });
}

/**
 * Open one member's loudness scale and wait for it to finish opening.
 *
 * **The row is what has to settle, not the scale.** The disclosure animates its
 * own height under `overflow-hidden`, and the radiogroup inside reaches full
 * size on the first frame — so waiting on the group returns immediately while
 * the clip is still growing, and everything below the fold of that clip
 * hit-tests as the clip rather than as itself. That reads as a rung measuring
 * 32px instead of 48, and as a roster that scrolls somewhere nobody asked for.
 * The row's own height is the thing that is actually still moving.
 *
 * @param sheet - The open sheet.
 * @param name - Whose scale to open.
 */
export async function expandScale(sheet: Locator, name: string): Promise<Locator> {
  await sheet.getByRole('button', { name: `How loud ${name} is here` }).click();
  const scale = sheet.getByRole('radiogroup', { name: `How loud is ${name} here?` });
  await expect(scale).toBeVisible();
  await settled(memberRow(sheet, name));
  return scale;
}
