import { test, expect } from '../../fixtures';
import { openFromCommandPalette } from '../../pages/command-palette';

/**
 * Keyboard place-keeping in the Shape switcher's nested form (DOR-513).
 *
 * Escape inside "Make your own version" folds the form away and leaves the
 * switcher open. The input it was focused on is removed by that same commit, and
 * Radix `FocusScope` answers a removed focus owner with a generic fallback — it
 * focuses the `DialogContent` container itself. From there the next Tab restarts
 * at the top of the Shape list, so anyone forking with the keyboard loses their
 * place on the one control they use repeatedly.
 *
 * This has to be a browser spec. jsdom does not reproduce either side of it:
 * `FocusScope`'s fallback rides a `MutationObserver` plus real focusin/focusout
 * events, and jsdom's focus model diverges enough that the container never takes
 * focus there. The unit suite can only assert the wiring
 * (`ShapeSwitcherDialog.test.tsx`, "hands focus back to the trigger"); this is
 * the proof.
 *
 * No model credentials involved — the Shape list is stubbed and nothing here
 * starts a turn, so it stays a fast `@smoke` spec.
 */

/** A stubbed installed-Shapes list: one active Shape, so the footer renders. */
const SHAPES = {
  shapes: [
    { name: 'flow-board', displayName: 'Flow Board', active: true },
    { name: 'writing-desk', displayName: 'Writing Desk', active: false },
  ],
};

test.describe('Shapes — switcher keyboard focus @smoke', () => {
  test.beforeEach(async ({ page, basePage }) => {
    // Only the list is stubbed, by exact pathname: `/api/shapes/:name/apply`
    // and `/fork` stay live so a stray click still hits the real server rather
    // than a silently faked success.
    await page.route(
      (url) => url.pathname === '/api/shapes',
      (route) => route.fulfill({ json: SHAPES })
    );
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('Escape out of the fork form puts focus back on its trigger', async ({ page }) => {
    // The switcher has no URL param of its own, so it opens the way a person
    // opens it: type "Switch shape" into the palette and pick the quick action.
    await openFromCommandPalette(page, 'Switch shape');

    const dialog = page.getByRole('dialog');
    // The first row in the list, and the active Shape the footer acts on.
    const firstShapeRow = dialog.getByRole('button', { name: 'Flow Board Active' });
    await expect(firstShapeRow).toBeVisible();

    const trigger = page.getByRole('button', { name: /make your own version/i });
    await trigger.click();
    const nameField = page.getByRole('textbox', { name: /name your version/i });
    await expect(nameField).toBeFocused();

    await page.keyboard.press('Escape');

    // Escape backs out one layer only — the form folds away, the switcher stays.
    await expect(nameField).toBeHidden();
    await expect(dialog).toBeVisible();

    // The regression lock. Before the fix this was the DialogContent container
    // (`div[role=dialog][tabindex="-1"]`), which is why the assertion below is
    // about the trigger and not merely "focus is somewhere in the dialog".
    await expect(trigger).toBeFocused();

    // And the consequence that made it worth fixing: Tab continues from the
    // trigger's own position (the dialog's close button is the next tab stop,
    // rendered after the footer) instead of restarting at the top of the list.
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(firstShapeRow).not.toBeFocused();
  });
});
