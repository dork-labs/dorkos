import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS, type RoomsApi, type SeededRoom } from '../../fixtures/rooms-api';

/**
 * Seed a channel somebody has actually been in.
 *
 * The entry is not decoration. "Jump back in" drops a room whose
 * `lastActivityAt` still equals its `createdAt` — a channel nobody has said
 * anything in has no "back" to jump to, so five channels made on Tuesday cannot
 * push out the work you were doing (`entities/recents/lib/jump-back-in.ts`,
 * `isJumpBackInRoom`). A bare `createChannel` therefore seeds a room this list
 * is right to ignore, and the spec times out describing a missing panel.
 *
 * No agent is in the room, so posting triggers no turn and costs nothing.
 *
 * @param roomsApi - This test's seeder, which also puts the room away again.
 * @param slug - The channel's slug, unique to this run.
 */
async function seedUsedChannel(roomsApi: RoomsApi, slug: string): Promise<SeededRoom> {
  const room = await roomsApi.createChannel(slug);
  await roomsApi.postEntries(room.id, ['Where we left off.']);
  return room;
}

/**
 * "Jump back in" over the home composer (spec `team-room-home` §D2.3).
 *
 * Put the caret in the empty box and the last few threads you were in float up;
 * start typing and they get out of the way. The panel never takes DOM focus —
 * the composer keeps the caret and publishes the highlight as its
 * `aria-activedescendant` — which is precisely why this needs a real browser:
 * the whole behaviour is a focus/blur/pointer race, and jsdom runs none of it.
 * The unit suite can prove the hook's rules; only this can prove that clicking
 * the box a person is already focused in opens anything at all.
 *
 * Each test seeds its own channel and walks the highlight to it before pressing
 * Enter. The suite shares one server and this list is unfiltered, so pressing
 * Enter on whatever is first would open a neighbouring spec's thread and mark it
 * read (GOTCHAS — "Assertions this suite cannot make").
 */
test.describe('Home surface — Jump back in @smoke', () => {
  test.describe.configure({ timeout: 90_000 });

  test('the empty composer floats up the threads you were in, and typing puts them away', async ({
    basePage,
    homeSurface,
    roomsApi,
  }) => {
    const slug = `e2e-jbi-open-${roomsApi.runId}`;
    await seedUsedChannel(roomsApi, slug);

    await basePage.goto();
    await basePage.waitForAppReady();

    // Nothing on arrival: the composer autofocuses itself on mount, and being
    // handed a page is not the same as asking for a panel over it.
    await expect(homeSurface.jumpBackIn).toBeHidden();

    await homeSurface.composerField.click();
    await expect(homeSurface.jumpBackIn).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(homeSurface.rowFor(slug)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // The field says the panel is up, and names the row Enter would open.
    await expect(homeSurface.composerField).toHaveAttribute('aria-expanded', 'true');
    await expect(homeSurface.composerField).toHaveAttribute(
      'aria-activedescendant',
      /jump-back-in-item-\d+/
    );

    // One keystroke ends the offer — and it stays ended for this visit to the
    // box, even after the word is deleted again.
    await homeSurface.composerField.pressSequentially('h');
    await expect(homeSurface.jumpBackIn).toBeHidden();
    await expect(homeSurface.composerField).toHaveAttribute('aria-expanded', 'false');

    await homeSurface.composerField.press('Backspace');
    await expect(homeSurface.jumpBackIn).toBeHidden();
  });

  test('arrow and Enter open the highlighted thread, with the mouse never touched', async ({
    page,
    basePage,
    homeSurface,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-jbi-keys-${roomsApi.runId}`;
    const room = await seedUsedChannel(roomsApi, slug);

    // The whole gesture is retried as one, because the list underneath it is
    // shared. The highlight is stamped with the list it was made against and
    // resets to the top whenever that list changes shape — so a neighbouring
    // spec seeding a room in the window between walking to a row and pressing
    // Enter sends Enter to somebody else's thread. That is not a product bug and
    // not a selector to harden: it is the shared server, and it was measured
    // here (Enter landed on a room this test had never heard of). Re-attempting
    // from a fresh page keeps the assertion exactly as strong — the keyboard
    // still has to reach THIS channel — while letting the race lose.
    await expect(async () => {
      await basePage.goto();
      await basePage.waitForAppReady();

      // Keyboard only, from here on. The composer already holds the caret after
      // mount, so tabbing off it and back is how a keyboard reaches it — and the
      // return is a focus the person performed, which is what opens the panel.
      await homeSurface.composerField.press('Tab');
      await expect(homeSurface.composerField).not.toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(homeSurface.composerField).toBeFocused();
      await expect(homeSurface.jumpBackIn).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

      // Walk to this run's own channel rather than trusting the first row.
      await expect(homeSurface.rowFor(slug)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
      await homeSurface.highlightRowContaining(slug);
      await expect(homeSurface.highlightedRow).toContainText(slug);

      await homeSurface.composerField.press('Enter');

      await expect(page).toHaveURL(new RegExp(`/channels\\?.*id=${room.id}`), { timeout: 5_000 });
    }).toPass({ timeout: SERVER_ROUND_TRIP_MS * 2, intervals: [0] });

    // The room is what is on screen, not just what the address bar claims.
    await expect(roomsPage.roomHeading).toHaveAccessibleName(`#${slug}`, {
      timeout: SERVER_ROUND_TRIP_MS,
    });
  });

  test('Tab moves on rather than picking whatever was lit', async ({
    page,
    basePage,
    homeSurface,
    roomsApi,
  }) => {
    const slug = `e2e-jbi-tab-${roomsApi.runId}`;
    await seedUsedChannel(roomsApi, slug);

    await basePage.goto();
    await basePage.waitForAppReady();
    await homeSurface.openJumpBackIn();
    await homeSurface.composerField.press('ArrowDown');

    // This panel arrives because the caret landed in an empty box, not because
    // anybody typed `@` or `/` — so Tab is still Tab. `tabPicks={false}`.
    await homeSurface.composerField.press('Tab');

    await expect(homeSurface.jumpBackIn).toBeHidden();
    await expect(homeSurface.composerField).not.toBeFocused();
    await expect(page).toHaveURL(/\/($|\?)/);
  });

  test('Escape puts it down and leaves the words alone', async ({
    page,
    basePage,
    homeSurface,
    roomsApi,
  }) => {
    const slug = `e2e-jbi-esc-${roomsApi.runId}`;
    await seedUsedChannel(roomsApi, slug);

    await basePage.goto();
    await basePage.waitForAppReady();
    await homeSurface.openJumpBackIn();

    await homeSurface.composerField.press('Escape');
    await expect(homeSurface.jumpBackIn).toBeHidden();
    await expect(page).toHaveURL(/\/($|\?)/);

    // Dismissed means dismissed for this visit: clicking the same box again does
    // not put it back up.
    await homeSurface.composerField.click();
    await expect(homeSurface.jumpBackIn).toBeHidden();
  });
});

/**
 * The panel on a phone, where "floats over the composer" has somewhere to go
 * wrong: a popover anchored to a box near the right edge can hang off screen,
 * and nothing in jsdom would ever say so.
 */
test.describe('Home surface — Jump back in at 375px @smoke', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test.describe.configure({ timeout: 90_000 });

  test('opens fully inside the viewport', async ({ page, basePage, homeSurface, roomsApi }) => {
    const slug = `e2e-jbi-phone-${roomsApi.runId}`;
    await seedUsedChannel(roomsApi, slug);

    await basePage.goto();
    await basePage.waitForAppReady();
    await homeSurface.openJumpBackIn();
    await expect(homeSurface.rowFor(slug)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    const box = await homeSurface.jumpBackIn.boundingBox();
    expect(box, 'the panel has no box').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(812);

    // And it did not push the page sideways getting there.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});
