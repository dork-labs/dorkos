import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { PHONE } from '../rooms/room-sheet-helpers';

/**
 * What the shared overlays must keep, on the real shell. Only a browser can see
 * any of this: jsdom has no animations and no viewport.
 *
 * The Inbox and Control Center pop-ups let a person approve and watch without
 * leaving a chat, so at desktop width they stay popovers over a page that still
 * works, and on a phone they are bottom sheets.
 *
 * The Inbox opens with its shortcut rather than the bell, because a quiet Inbox
 * draws no bell at all.
 */
const INBOX_SHORTCUT = 'ControlOrMeta+Shift+KeyY';
const POPOVER = '[data-slot="popover-content"]';
const DRAWER = '[data-vaul-drawer]';

/**
 * Open the Inbox with its shortcut. App-ready comes before the shell has bound its
 * keys, so a press can land on nothing; only a press that showed nothing is retried,
 * since a second one would close a panel that had opened.
 */
async function openInbox(page: Page, panel: string): Promise<void> {
  await expect(async () => {
    await page.keyboard.press(INBOX_SHORTCUT);
    await expect(page.locator(panel)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

test.describe('Overlay surfaces, 1440 @smoke', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('the Inbox stays a popover, and the composer behind it can still take focus', async ({
    page,
  }) => {
    await openInbox(page, POPOVER);
    await expect(page.locator(DRAWER)).toHaveCount(0);

    // Non-modal is the contract: approve and watch without leaving the chat.
    const composer = page.getByRole('combobox', { name: /^(message |send a message)/i });
    await composer.focus();
    await expect(composer).toBeFocused();
  });

  test('the Control Center stays a popover', async ({ controlCenter, page }) => {
    await controlCenter.open();
    await expect(page.locator(POPOVER)).toBeVisible();
    await expect(page.locator(DRAWER)).toHaveCount(0);
  });

  test('a menu reopens on the first press after it closed', async ({ page, dashboardSidebar }) => {
    const box = await dashboardSidebar.newMenu.trigger.boundingBox();
    expect(box, 'the New button was never laid out').not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    const menus = page.locator('[role="menu"]');

    // Raw coordinates: a locator's actionability wait would spend the window in
    // which a closing menu eats the press (DOR-1834).
    const press = async () => {
      await page.mouse.down();
      await page.mouse.up();
    };
    await page.mouse.move(x, y);
    await press();
    await expect(menus).toHaveCount(1);
    // Radix starts listening for a press outside just after the menu mounts, so a
    // press in that same instant is not one a person can make.
    await page.waitForTimeout(100);

    // Close, then press again straight away. Waiting for the menu to go first would
    // wait out any exit animation, which is the very window this has to land in.
    await press();
    await press();
    await page.waitForTimeout(400);
    await expect(menus).toHaveCount(1);
  });
});

test.describe('Overlay surfaces, dark @smoke', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a highlighted row on a lifted surface computes to the 5% tint', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('dorkos-theme', 'dark'));
    await page.goto('/dev/overlays');
    await page.getByRole('button', { name: 'Open dialog', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New room' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Every row', exact: true }).click();
    const item = page.getByRole('menuitem', { name: 'Rename' });
    await item.hover();
    await expect(item).toHaveAttribute('data-highlighted', '');
    // The foreground (87%) at 5%. The page's own 9% here would mean the bridge
    // resolved at the root and never climbed.
    await expect(item).toHaveCSS('background-color', /0\.05\)$/);
  });
});

test.describe('Overlay surfaces, 390 @smoke', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('the Control Center is a drawer with a grabber, and no border', async ({
    controlCenter,
    page,
  }) => {
    await controlCenter.open();
    const drawer = page.locator(DRAWER);
    await expect(drawer).toBeVisible();
    await expect(page.locator(POPOVER)).toHaveCount(0);
    await expect(drawer.locator('[data-slot="drawer-grabber"]')).toBeVisible();
    await expect(drawer).toHaveCSS('border-top-width', '0px');
  });

  test('a disabled button keeps its reason on touch, and tapping away closes it', async ({
    page,
  }) => {
    await page.goto('/dev/overlays');
    const archive = page.getByRole('button', { name: 'Archive room' });
    await archive.scrollIntoViewIfNeeded();
    // Forced: Playwright won't tap an aria-disabled button, and a thumb will.
    await archive.tap({ force: true });
    await expect(page.getByRole('tooltip')).toHaveText('Only the owner can archive this.');

    // Raw coordinates on the section's heading, so nothing scrolls and the button
    // stays in view: the reason has to close, not leave the screen.
    const box = await page.getByRole('heading', { name: 'Floating surfaces' }).boundingBox();
    expect(box, 'the heading was never laid out').not.toBeNull();
    await page.touchscreen.tap(box!.x + 8, box!.y + box!.height / 2);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(archive).toBeInViewport();

    // Every other tooltip stays closed on touch.
    await page.getByRole('button', { name: 'Room settings', exact: true }).tap();
    await page.waitForTimeout(600);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });

  test('under reduced motion a drawer still animates for 1ms, and so still unmounts', async ({
    page,
  }) => {
    // vaul unmounts on `animationend`, which `animation: none` never fires.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dev/overlays');
    await page.getByRole('button', { name: 'Open drawer', exact: true }).tap();
    const drawer = page.locator(DRAWER);
    await expect(drawer).toHaveCSS('animation-duration', '0.001s');
    await expect(drawer).not.toHaveCSS('animation-name', 'none');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  test('the Inbox is a drawer', async ({ page }) => {
    await openInbox(page, DRAWER);
    await expect(page.locator(POPOVER)).toHaveCount(0);
  });
});
