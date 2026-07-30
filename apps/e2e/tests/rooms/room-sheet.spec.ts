import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS, type RoomsApi, type SeededAgent } from '../../fixtures/rooms-api';
import { publishPresence, tapRoomStream } from './room-signals';
import { openCockpit } from './open-cockpit';

// Same shape as its siblings: one cockpit at a time, and a ceiling sized for a
// machine already running several worktrees of agents. Nothing here starts an
// agent turn — every seeded agent is silenced by the fixture.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * The room details sheet, measured.
 *
 * Everything in this file is **geometric or portal-bound**, which is the whole
 * reason it is here rather than in jsdom: jsdom reports every element as 0×0, so
 * it cannot see a clipped focus ring, a 44px touch target, a drawer that grows
 * off the top of a phone, or a label that ellipsises. The sheet's unit suite
 * covers what it says; this covers what it *is* on a laid-out page.
 *
 * **What this file cannot prove: the real safe-area insets.** `index.css` pads
 * `[data-vaul-drawer]` with `env(safe-area-inset-bottom)` so the home indicator
 * never sits under the footer, and the risk is that something else pads it too
 * and the gap doubles. Headless Chromium has no supported way to set those
 * insets — they are 0 in every browser Playwright drives — so a test asserting
 * the gap would be asserting `0 === 0` and could never fail. What IS checked
 * below is the structural half that survives a zero inset: exactly one element
 * in the drawer declares that padding, so there is nothing to double. The
 * pixel gap itself stays a device check.
 */

/** iPhone 14/15 in portrait — the width the sheet's phone rendering was cut for. */
const PHONE = { width: 390, height: 844 } as const;

/** The smallest thing a thumb can reliably hit, in CSS pixels. */
const TOUCH_TARGET_PX = 44;

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
async function touchHeight(locator: Locator): Promise<number> {
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
interface Rect {
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
async function rectOf(locator: Locator): Promise<Rect> {
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
async function settled(locator: Locator): Promise<void> {
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
async function tabTo(page: Page, target: Locator): Promise<void> {
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
async function ringBleed(locator: Locator): Promise<number | null> {
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
async function clipOverflow(
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
async function transitionMs(locator: Locator): Promise<number> {
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
async function seedRoom(
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
 * Open a room and then its details sheet, and hand back the sheet once it has
 * finished arriving.
 *
 * The settle is not politeness: on a phone this is a drawer that slides up, and
 * everything in this file measures.
 */
async function openSheet(page: Page, roomId: string): Promise<Locator> {
  await page.goto(`/channels?id=${roomId}`);
  await page.getByRole('button', { name: /^Members of / }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
  await settled(sheet);
  return sheet;
}

/** One member's row in the sheet, found by the name it prints. */
function memberRow(sheet: Locator, name: string): Locator {
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
async function expandScale(sheet: Locator, name: string): Promise<Locator> {
  await sheet.getByRole('button', { name: `How loud ${name} is here` }).click();
  const scale = sheet.getByRole('radiogroup', { name: `How loud is ${name} here?` });
  await expect(scale).toBeVisible();
  await settled(memberRow(sheet, name));
  return scale;
}

test.describe('Room sheet — what only a laid-out page can show @smoke', () => {
  test('the room meter and the pointed-at member move as one, and slide rather than jump', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'preview');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const roomLine = sheet.locator('[data-slot="room-loudness-line"]');
    await expect(roomLine).toBeVisible();
    // The fixture silences every agent it seeds, so this is the room's real
    // resting answer and the preview below has somewhere to move to.
    await expect(roomLine).toContainText('Nobody here will answer you');
    await expect(roomLine).not.toHaveAttribute('data-preview', 'true');

    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    await pill.click();
    const scale = sheet.getByRole('radiogroup', { name: `How loud is ${ana.name} here?` });
    await expect(scale).toBeVisible();

    const roomMeter = roomLine.locator('[data-slot="loudness-meter"]');
    const pillMeter = pill.locator('[data-slot="loudness-meter"]');

    // **As one system, or not at all.** Both meters are the same mark saying the
    // same thing at two scales, and the point of the preview is that a person
    // sees one cause the other. Two different durations would be two gestures
    // that happen to be near each other. Dropping `BAR_TRANSITION` from either
    // meter reddens this.
    const roomBar = roomMeter.locator('span').first();
    const pillBar = pillMeter.locator('span').first();
    const roomMs = await transitionMs(roomBar);
    const pillMs = await transitionMs(pillBar);
    expect(roomMs).toBeGreaterThan(0);
    expect(roomMs).toBe(pillMs);

    // Point at the loudest rung — with the mouse, which is the interaction the
    // phone cannot have — and the whole room restates itself as a hypothetical.
    await scale.getByRole('radio', { name: 'Everything' }).hover();
    await expect(roomLine).toHaveAttribute('data-preview', 'true');
    await expect(roomLine).toContainText('answers every message here');
    // And it says so in words too, for a reader who cannot see the tint.
    await expect(roomLine.getByText('If you make that change:')).toBeAttached();

    // Nothing was written: the sentence is a proposal until a rung is pressed.
    await expect(scale.getByRole('radio', { name: 'Silent' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    // Stop pointing and the room goes back to the truth. The pointer is moved
    // rather than hovered onto something else: the loudness line is repainting
    // as the preview clears, so Playwright's "visible and stable" check on a
    // hover target waits for an element that is mid-transition by construction.
    await page.mouse.move(4, 4);
    await expect(roomLine).not.toHaveAttribute('data-preview', 'true');
    await expect(roomLine).toContainText('Nobody here will answer you');
  });

  test('a rung committed moves the member meter and the room meter to the same answer', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'commit');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const roomLine = sheet.locator('[data-slot="room-loudness-line"]');
    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    await expect(pill).toHaveText('Silent');

    await pill.click();
    await sheet
      .getByRole('radiogroup', { name: `How loud is ${ana.name} here?` })
      .getByRole('radio', { name: 'Everything' })
      .click();

    // The pill is the member's answer; the line is the room's. One press moves
    // both, which is the claim — a member meter that moved alone would be a
    // setting with no stated consequence.
    await expect(pill).toHaveText('Everything');
    await expect(roomLine).toContainText('One agent answers every message here');

    // Counted in bars, not in words: the meter is the part a person reads at a
    // glance, and a lit-bar count that disagreed with the sentence would be the
    // two halves of one line contradicting each other. A lit bar is opaque
    // brand; an unlit one is the muted foreground at 30%, so the alpha channel
    // tells them apart without this test knowing either colour.
    const litBars = async (meter: Locator) =>
      meter.evaluate(
        (el) =>
          [...el.children].filter((bar) => {
            const rgba = getComputedStyle(bar).backgroundColor;
            const alpha = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(rgba);
            return alpha === null || parseFloat(alpha[1]!) > 0.5;
          }).length
      );
    expect(await litBars(roomLine.locator('[data-slot="loudness-meter"]'))).toBe(4);
    expect(await litBars(pill.locator('[data-slot="loudness-meter"]'))).toBe(4);
  });

  test('the roster you open the sheet on does not perform, and an agent you add does', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    // Seeded with one agent, so there is a second to add through the UI.
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const kai = await roomsApi.registerAgent(`E2E Kai ${roomsApi.runId}`, '🐙', '#7c3aed');
    const slug = `e2e-arrive-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug, [ana]);
    await openCockpit(basePage);
    const sheet = await openSheet(page, room.id);

    /**
     * How brand-washed a row is right now — the arrival glow, 0 once settled.
     *
     * The wash is the row's own preceding sibling inside the padded wrapper the
     * list gives each member, and it is the only `pointer-events-none` brand
     * fill in there — the radio dot inside an open scale is the other brand
     * span, and it is neither absolute nor inert.
     */
    const washOf = (name: string) =>
      memberRow(sheet, name)
        .locator('xpath=preceding-sibling::span[contains(@class, "pointer-events-none")]')
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).opacity));

    // **The roster that was already there did not just arrive.** This is what
    // `AnimatePresence initial={false}` buys, and it has to propagate through
    // React context to reach the wash INSIDE each row as well as the row
    // itself — confirmed by reading framer-motion's source and never once
    // executed until now. Remove `initial={false}` and every row on open
    // glows, which is the sheet claiming four agents just walked in.
    await expect(memberRow(sheet, ana.name)).toBeVisible();
    expect(await washOf(ana.name)).toBe(0);

    // Now add one for real, through the row at the foot of the list.
    await sheet.getByRole('button', { name: 'Add agents' }).click();
    const search = sheet.getByRole('combobox', { name: 'Search agents' });
    await search.fill(kai.name);
    await page.getByRole('option', { name: kai.name, exact: true }).click();
    await sheet.getByRole('button', { name: 'Add agent' }).click();

    const arrival = memberRow(sheet, kai.name);
    await expect(arrival).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // It glows on arrival — caught while the 0.9s fade is still running — and
    // the one that was already there still does not.
    await expect.poll(() => washOf(kai.name), { timeout: 2000 }).toBeGreaterThan(0);
    expect(await washOf(ana.name)).toBe(0);
    // And it settles rather than staying lit.
    await expect.poll(() => washOf(kai.name), { timeout: 4000 }).toBe(0);
  });

  test('a removed row collapses to nothing while the Undo is still on offer', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana, kai } = await seedRoom(roomsApi, 'remove');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);
    await expect(memberRow(sheet, kai.name)).toBeVisible();

    const rowsBefore = await sheet.locator('[data-slot="room-member-row"]').count();

    await sheet.getByRole('button', { name: `${kai.name} actions` }).click();
    await page.getByRole('menuitem', { name: /^Remove from/ }).click();
    await sheet.getByRole('button', { name: 'Remove', exact: true }).click();

    // The offer, and the thing it refers to. A row that simply vanished would
    // leave "Undo" pointing at something nobody watched happen — which is the
    // defect the collapse exists to fix, and the reason both halves are one
    // assertion rather than two tests.
    const toast = page.getByText(`${kai.name} removed from`);
    await expect(toast).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

    // Collapsed to zero, not merely hidden: the list closes the gap it left.
    await expect
      .poll(() => sheet.locator('[data-slot="room-member-row"]').count(), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toBe(rowsBefore - 1);
    await expect(memberRow(sheet, ana.name)).toBeVisible();
  });

  test('nothing shaves a focus ring against the row and list clips', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'ring');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    // Two `overflow-hidden` clips are new on this surface: the list item whose
    // height animates as a row arrives or leaves, and the disclosure whose
    // height animates as a scale opens. Both hold slack for exactly this, and
    // slack is the kind of thing that is correct in a comment and wrong in the
    // stylesheet.
    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    // Tabbed to, not `focus()`ed. A ring is `focus-visible`, and Chromium only
    // paints one once the focus arrived by keyboard — a programmatic focus
    // leaves `box-shadow: none`, and a test measuring the clip around a ring
    // nobody drew passes whatever the stylesheet says.
    //
    // `locator.press` is not the way to do it either: it focuses the element
    // first and then sends the key, so `Tab` walks straight back off it.
    await tabTo(page, pill);
    await expect(pill).toBeFocused();

    const pillBleed = await ringBleed(pill);
    expect(pillBleed, 'the pill is drawing no focus ring, so this proves nothing').not.toBeNull();
    expect(pillBleed!).toBeGreaterThan(0);
    expect(await clipOverflow(pill, pillBleed!)).toMatchObject({ clipped: false });

    await pill.press('Enter');
    const scale = sheet.getByRole('radiogroup', { name: `How loud is ${ana.name} here?` });
    await expect(scale).toBeVisible();
    // The disclosure opens its own height, so the clip this test measures
    // against is still growing for 150ms after the group is "visible" — and it
    // is the ROW that is still moving, not the group. See `expandScale`.
    await settled(memberRow(sheet, ana.name));

    // The last rung is the one nearest the clip's bottom edge, so it is the one
    // that would find a short slack. Its ring is declared `ring-inset`, which
    // `ringBleed` reports as 0 — that is the answer, not a missing measurement:
    // an inset ring is painted inside the border box and no clip can reach it.
    //
    // The key goes to the group through a rung, not to the group itself: the
    // radiogroup is a plain `div` with no tabindex, so `scale.press('End')`
    // leaves focus wherever it was — on the pill, outside the group — and the
    // handler never sees it.
    await tabTo(page, scale.getByRole('radio').first());
    await page.keyboard.press('End');
    const last = scale.getByRole('radio').last();
    await expect(last).toBeFocused();
    const lastBleed = await ringBleed(last);
    expect(lastBleed, 'the rung is drawing no focus ring at all').not.toBeNull();
    expect(await clipOverflow(last, lastBleed!)).toMatchObject({ clipped: false });

    // And the control as a whole sits inside the disclosure that clips it —
    // the assertion that catches a slack that is one line short.
    expect(await clipOverflow(scale, 0)).toMatchObject({ clipped: false });
  });

  test("a working agent's pulse is not shaved by the row's clip", async ({
    page,
    basePage,
    roomsApi,
    request,
  }) => {
    const { roomId, slug, ana } = await seedRoom(roomsApi, 'ping');
    await roomsApi.postEntries(roomId, ['can someone look at this']);

    const roster = await roomsApi.getRoom(roomId);
    const anaAuthorId = roster.members.find(
      (member) => member.author.kind === 'agent' && member.author.displayName === ana.name
    )!.author.id;
    const entries = await request.get(`/api/rooms/${roomId}/entries`);
    const { entries: stored } = (await entries.json()) as { entries: { id: string }[] };

    await openCockpit(basePage);
    // The signal rides the room's REAL stream — the sheet reads presence only
    // for the room that is on screen, so the tap has to be in place first.
    await tapRoomStream(page);
    const sheet = await openSheet(page, roomId);
    expect(slug).toContain('e2e-ping');

    await publishPresence(page, {
      authorId: anaAuthorId,
      state: 'working',
      entryId: stored[0]!.id,
      since: new Date().toISOString(),
    });

    const row = memberRow(sheet, ana.name);
    await expect(row.getByText('working now')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // `animate-ping` scales the dot to 2×, so an 8px dot paints 4px past itself
    // on every side. The list item that animates a row's height clips, and the
    // row carries top slack for precisely this — a comment saying so is not
    // evidence, and a shaved pulse reads as a rendering bug rather than as a
    // signal.
    const ping = row.locator('span.animate-ping');
    await expect(ping).toBeAttached();
    const shave = await clipOverflow(ping, 4);
    expect(shave, `ping shaved by ${shave.clipper}`).toMatchObject({ clipped: false });
  });

  test('the segmented control fits its indent without ellipsising a rung', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'segments');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    // The pill grew a caret when it stopped being a word and became a control
    // that opens something, and the caret is width the label used to have.
    const pillOverflow = await pill.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(pillOverflow).toBeLessThanOrEqual(1);

    await pill.click();
    const scale = sheet.getByRole('radiogroup', { name: `How loud is ${ana.name} here?` });
    await expect(scale).toBeVisible();

    // Four segments inside a 448px dialog, indented under the disc. The labels
    // are the ONLY thing telling the rungs apart, so an ellipsis here removes
    // the meaning rather than the polish — which is the measured reason the
    // phone gets a list instead.
    const rungs = await scale.getByRole('radio').all();
    expect(rungs).toHaveLength(4);
    for (const rung of rungs) {
      const label = await rung.textContent();
      const overflow = await rung.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, `"${label}" is truncated in its segment`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('Room sheet on a phone — 390×844 @smoke', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the sheet stays on the screen, and its middle is the part that scrolls', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    // Eight agents, because the failure this is about is a roster too long for
    // the screen — a sheet that fits has nothing to cap and nothing to scroll.
    const { roomId } = await seedRoom(roomsApi, 'phone-fit', 6);
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const box = await rectOf(sheet);
    // On screen at both ends. A drawer is `bottom-0` with `h-auto`, so a roster
    // of eight grows its TOP off the screen and takes the room's name with it —
    // the failure is at the top edge, which is why both are asserted.
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(PHONE.height + 1);
    // And capped, so the cap is what makes the body a scrolling region at all.
    expect(box.height).toBeLessThanOrEqual(PHONE.height * 0.85 + 1);

    const body = sheet.locator('[data-slot="responsive-dialog-body"]');
    const header = sheet.getByRole('heading').first();
    const footer = sheet.getByRole('button', { name: 'Archive room' });
    await expect(footer).toBeVisible();

    const headerBefore = await rectOf(header);
    const footerBefore = await rectOf(footer);

    const scrolled = await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(scrolled, 'the sheet body has nothing to scroll').toBeGreaterThan(0);

    // Pinned: the room's name and the way out of the room do not scroll away.
    // A pixel of tolerance is sub-pixel layout; a scrolled-away header moves by
    // its own height or more.
    expect((await rectOf(header)).top).toBeCloseTo(headerBefore.top, 0);
    expect((await rectOf(footer)).top).toBeCloseTo(footerBefore.top, 0);
  });

  test('exactly one element carries the home-indicator padding, so it cannot double', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'safe-area');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    // The inset itself is 0 in every browser Playwright drives, so the GAP is
    // not assertable here (see this file's header). What is assertable is the
    // shape of the rule: `index.css` pads `[data-vaul-drawer]` and nothing
    // inside it may pad again. A second declaration is how the gap doubles on
    // a real phone, and it is visible from here even at a zero inset.
    const declarations = await sheet.evaluate((root) => {
      const found: string[] = [];
      const walk = (rules: CSSRuleList) => {
        for (const rule of [...rules]) {
          // A rule is judged on its selector and recursed into for its
          // children, and it can be both. Two traps here, each of which cost a
          // run: `@supports` wraps the rule that matters and has no selector of
          // its own, so counting its `cssText` is how this first "found" one
          // declaration that was the wrong one — and since CSS nesting shipped,
          // an ordinary `CSSStyleRule` ALSO carries a (usually empty)
          // `cssRules`, so treating "has cssRules" as "is a wrapper" skipped
          // every real rule and found none at all.
          const selector = (rule as CSSStyleRule).selectorText;
          if (typeof selector === 'string' && selector !== '') {
            if (
              rule.cssText.includes('safe-area-inset-bottom') &&
              (root.matches(selector) || root.querySelector(selector) !== null)
            ) {
              found.push(selector);
            }
          }
          const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
          if (nested !== undefined && nested.length > 0) walk(nested);
        }
      };
      for (const styleSheet of [...document.styleSheets]) {
        try {
          walk(styleSheet.cssRules);
        } catch {
          continue; // cross-origin stylesheet; none of ours are
        }
      }
      return found;
    });

    expect(
      declarations,
      `more than one rule pads for the home indicator inside the drawer: ${declarations.join(', ')}`
    ).toHaveLength(1);
    expect(declarations[0]).toContain('data-vaul-drawer');
  });

  test('every control a thumb has to hit is at least 44px tall', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'targets');
    // One agent deliberately left OUT of the room, because the picker offers
    // only agents that are not in it already. Searched for by its own unique
    // name rather than by a shared prefix: the suite shares a server, so
    // "whatever the fleet happens to hold" is another test's business.
    const spare = await roomsApi.registerAgent(`E2E Spare ${roomsApi.runId}`, '🧰', '#15803d');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    /**
     * Measure one control and say which it was when it is too small.
     *
     * **Scrolled into view first, and that is not politeness.**
     * `document.elementFromPoint` works in VIEWPORT coordinates, so a control
     * sitting below the fold of the sheet's scrolling body answers for whatever
     * is painted at that point instead — which reads as a hit area truncated to
     * exactly the visible band. The third rung in an open scale measured 32px
     * that way, and it is 48.
     */
    const assertTouchable = async (label: string, locator: Locator) => {
      await expect(locator, `${label} is not on screen`).toBeVisible();
      await locator.scrollIntoViewIfNeeded();
      await settled(locator);
      const height = await touchHeight(locator);
      expect(height, `${label} is ${height}px tall`).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    };

    // **A member row is measured differently, because it is not a control.**
    // The row carries a face and two lines of text and nothing about it is
    // pressable — the pill and the "…" are, and they are measured as controls
    // below. Its 56px is a reading measure, so the honest assertion is on the
    // laid-out box. Probing it as a hit area answers ~43px, because the row's
    // own padding belongs to the wrapper rather than to the row, and reading
    // that as a failed touch target would be measuring the wrong thing with the
    // wrong ruler.
    const row = await rectOf(memberRow(sheet, ana.name));
    expect(row.height, `a member row is ${row.height}px tall`).toBeGreaterThanOrEqual(
      TOUCH_TARGET_PX
    );

    await assertTouchable(
      'the loudness pill',
      sheet.getByRole('button', { name: `How loud ${ana.name} is here` })
    );
    // The "…" menu is deliberately absent here — it is `!isMobile`, and a
    // dropdown is a poor verb list under a thumb. Removal on touch is a plain
    // button inside the expanded row, measured with the rungs below.
    await expect(sheet.getByRole('button', { name: `${ana.name} actions` })).toHaveCount(0);
    await assertTouchable('the add row', sheet.getByRole('button', { name: 'Add agents' }));

    // The rung list, which on a phone replaces the segmented control.
    const scale = await expandScale(sheet, ana.name);
    for (const rung of await scale.getByRole('radio').all()) {
      await assertTouchable(`the "${await rung.getAttribute('aria-label')}" rung`, rung);
    }
    // The touch path's own removal verb, which stands in for the "…" menu.
    await assertTouchable(
      'the in-row Remove button',
      sheet.getByRole('button', { name: 'Remove from this room' })
    );

    // The picker's own rows, and the chip that takes one back off again.
    await sheet.getByRole('button', { name: 'Add agents' }).click();
    const search = sheet.getByRole('combobox', { name: 'Search agents' });
    await search.fill(spare.name);
    const option = page.getByRole('option', { name: spare.name, exact: true });
    await assertTouchable('a picker row', option);
    await option.click();
    await assertTouchable(
      'a chip’s remove button',
      sheet.getByRole('button', { name: `Remove ${spare.name}` })
    );
  });

  test('dragging the roster scrolls it; dragging the sheet itself puts it away', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'drag', 6);
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    // A scale open and the list scrolled is the state where the two gestures
    // are most confusable: vaul listens for a downward drag to dismiss, and the
    // roster wants the same drag to scroll back up through it.
    await expandScale(sheet, ana.name);

    const body = sheet.locator('[data-slot="responsive-dialog-body"]');
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const scrolledTo = await body.evaluate((el) => el.scrollTop);
    expect(scrolledTo, 'nothing to scroll, so this test proves nothing').toBeGreaterThan(0);

    // Two separate claims, because one gesture cannot carry both here.
    //
    // **The roster is the scrolling region.** Driven with the wheel, which is a
    // real scroll gesture the browser handles natively. A mouse drag is not:
    // click-and-drag inside a `overflow-y: auto` box scrolls nothing in any
    // browser, so an assertion that it did would be asserting against the
    // platform rather than against this sheet.
    const box = await rectOf(body);
    const x = box.left + box.width / 2;
    const y = box.top + box.height * 0.6;
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -200);
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeLessThan(scrolledTo);

    // **And a downward drag over it does not throw the sheet away.** This is
    // vaul's own gesture, and it reaches it through pointer events, which
    // Playwright's mouse does generate — so this half is a real test of the
    // guard. A drawer that dismissed here would discard the reader's place in a
    // list they were part-way through, with an expanded row open in it.
    const heldAt = await body.evaluate((el) => el.scrollTop);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 160, { steps: 12 });
    await page.mouse.up();

    await expect(sheet).toBeVisible();
    // And it did not silently jump somewhere else either.
    expect(await body.evaluate((el) => el.scrollTop)).toBe(heldAt);

    // The drawer's own handle is where dismissal lives, and it still works —
    // otherwise the assertion above would pass on a drawer nobody can close.
    const grip = await rectOf(sheet);
    await page.mouse.move(grip.left + grip.width / 2, grip.top + 8);
    await page.mouse.down();
    await page.mouse.move(grip.left + grip.width / 2, PHONE.height - 10, { steps: 16 });
    await page.mouse.up();
    await expect(sheet).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
  });

  test("a long agent description truncates rather than pushing the picker's button away", async ({
    page,
    basePage,
    roomsApi,
    request,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const wordy = await roomsApi.registerAgent(`E2E Wordy ${roomsApi.runId}`, '📚', '#2563eb');
    // The second line is the agent's own words, and an operator can write as
    // many of them as they like. At 390px this is the line that wraps a picker
    // row to three and pushes the commit button under the keyboard.
    const long =
      'Reviews every pull request against the house style, writes the release notes, ' +
      'chases the flaky tests, and answers questions about the build system all day long.';
    const patched = await request.patch(`/api/mesh/agents/${wordy.id}`, {
      data: { description: long },
    });
    expect(patched.ok(), `could not give the agent a description: ${await patched.text()}`).toBe(
      true
    );

    const slug = `e2e-wordy-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug, [ana]);
    await openCockpit(basePage);
    const sheet = await openSheet(page, room.id);

    await sheet.getByRole('button', { name: 'Add agents' }).click();
    await sheet.getByRole('combobox', { name: 'Search agents' }).fill(wordy.name);
    const option = page.getByRole('option', { name: wordy.name, exact: true });
    await expect(option).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    const description = option.locator('[data-slot="candidate-description"]');
    await expect(description).toBeVisible();
    // One line, clipped — not three lines of somebody's prose reflowing the
    // list. `truncate` is the claim; `scrollWidth > clientWidth` is the proof
    // that it is actually doing something to this string.
    const line = await description.evaluate((el) => ({
      lines: Math.round(
        el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)
      ),
      overflowing: el.scrollWidth > el.clientWidth,
    }));
    expect(line.lines).toBe(1);
    expect(line.overflowing, 'the description is short enough that this proves nothing').toBe(true);

    // And the row it lives in is still inside the sheet.
    const rowBox = await rectOf(option);
    const sheetBox = await rectOf(sheet);
    expect(rowBox.right).toBeLessThanOrEqual(sheetBox.right + 1);

    // The commit button is reachable from the keyboard while the field has
    // focus — which is the state a phone is in, keyboard up, when somebody has
    // just typed a name.
    await option.click();
    const commit = sheet.getByRole('button', { name: 'Add agent' });
    await expect(commit).toBeVisible();
    const commitBox = await rectOf(commit);
    expect(commitBox.bottom).toBeLessThanOrEqual(sheetBox.bottom + 1);
    expect(commitBox.top).toBeGreaterThanOrEqual(sheetBox.top);
  });

  test('the header lines up with itself and stays inside the sheet', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'header');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    // Both are the inline fields, named by what pressing them does — `Room
    // name: #slug` and `Topic: Add a topic`. The heading role belongs to the
    // sheet's own label, which is not the control being measured.
    const name = sheet.getByRole('button', { name: /^Room name:/ });
    const topic = sheet.getByRole('button', { name: /^Topic:/ });
    await expect(name).toBeVisible();
    await expect(topic).toBeVisible();

    const sheetBox = await rectOf(sheet);
    const nameBox = await rectOf(name);
    const topicBox = await rectOf(topic);

    // The name and the topic are one block, read top to bottom. A half-pixel of
    // rounding is layout; anything more is one of them indented against the
    // other, which is what a stacked header looks like when it is wrong.
    expect(Math.abs(nameBox.left - topicBox.left)).toBeLessThanOrEqual(1);
    // Both inside the sheet at 390px, where there is no room to spare.
    expect(nameBox.left).toBeGreaterThanOrEqual(sheetBox.left);
    expect(nameBox.right).toBeLessThanOrEqual(sheetBox.right + 1);
    expect(topicBox.right).toBeLessThanOrEqual(sheetBox.right + 1);
    // And the topic is under the name, not beside it.
    expect(topicBox.top).toBeGreaterThanOrEqual(nameBox.bottom - 1);
  });
});

test.describe('Room sheet with motion turned down @smoke', () => {
  test('the preview snaps to its answer instead of sliding, and loses nothing', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    // Set on the page rather than through `test.use`, which this project's
    // extended `test` does not accept the option on. Same media query either
    // way — `index.css` keys its global cut on `prefers-reduced-motion`.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { roomId, ana } = await seedRoom(roomsApi, 'reduced');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const roomLine = sheet.locator('[data-slot="room-loudness-line"]');
    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    await pill.click();
    const scale = sheet.getByRole('radiogroup', { name: `How loud is ${ana.name} here?` });

    // The global rule in `index.css` cuts every transition to 0.01ms under this
    // preference. The meter snaps to the same place — a motion preference must
    // not remove information, and this is the assertion that says the meter
    // still gets there.
    const bar = roomLine.locator('[data-slot="loudness-meter"] span').first();
    expect(await transitionMs(bar)).toBeLessThan(1);

    await scale.getByRole('radio', { name: 'Everything' }).hover();
    await expect(roomLine).toHaveAttribute('data-preview', 'true');
    await expect(roomLine).toContainText('answers every message here');
  });
});
