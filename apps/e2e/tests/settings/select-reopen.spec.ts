import { test, expect } from '../../fixtures';

/**
 * A list that is closing must not eat the press that reopens it (DOR-1835).
 *
 * The same defect DOR-1834 fixed for menus, on the other primitive that can
 * reach it. Radix keeps a Select's list mounted for as long as it has a closing
 * animation to play, and the part of it that listens for "somebody pressed
 * outside me" is kept with it — so for those ~150ms a press on the control's own
 * button was answered twice: the button reopened the list, and the copy still
 * finishing its fade read the same press as a press outside and closed what had
 * just opened.
 *
 * Select is the only sibling where that ordering bites, and the reason is its
 * button: it opens on POINTER DOWN, the very event the stale layer dismisses on.
 * A context menu opens on `contextmenu`, and Popover, Dialog and Sheet toggle on
 * `click` — all of which arrive after the dismissal, so those net out open.
 *
 * Only a browser can see this. jsdom runs no animations, so a list there leaves
 * on the commit that closes it and none of this happens.
 */
test.describe('Settings — a list that is closing @smoke', () => {
  test('opens the theme list on the FIRST press after it was dismissed', async ({
    page,
    basePage,
    settingsPage,
  }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await settingsPage.open();

    const trigger = settingsPage.themeSelectTrigger;
    await expect(trigger).toBeVisible();

    // Driven through raw pointer coordinates rather than `locator.click()`, and
    // that is the whole reason this spec catches anything. The window under test
    // is ~150ms wide, and a locator resolve plus an actionability wait spends
    // most of it — the reviewer who found this defect drove it by hand and could
    // not land inside the window at all. Coordinates are read ONCE, up front, so
    // the press that matters costs one round trip and nothing else.
    const box = await trigger.boundingBox();
    expect(box, 'the theme control was never laid out, so it has no coordinates').not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('[role="listbox"]')).toHaveCount(1);

    // Dismiss, then press again with nothing in between. Measured on this
    // machine, the press lands 1.4ms after the list goes to its closing state —
    // squarely inside the window, and unfixed the list is gone 160ms later
    // having never reopened.
    await page.keyboard.press('Escape');
    await page.mouse.down();
    await page.mouse.up();

    // Asked of Radix's own state rather than of the pixels: a list that is still
    // fading is still ON SCREEN, so a visibility check here passes on the very
    // state under test.
    await expect(
      trigger,
      'the first press after the theme list was dismissed did not reopen it'
    ).toHaveAttribute('data-state', 'open');
    // **And the keyboard came with it**, which is the half a screenshot cannot
    // tell apart. A list that reopens while the old copy is still on screen is
    // the SAME element re-shown rather than a new one, so nothing puts the
    // reader inside it and no arrow key reaches a row — it looks right and
    // answers nothing.
    await expect(
      page.locator('[role="listbox"]:focus-within'),
      'the reopened list never took focus, so no key can reach its options'
    ).toHaveCount(1);
  });
});
