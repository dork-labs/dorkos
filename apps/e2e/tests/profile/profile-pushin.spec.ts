import { test, expect } from '../../fixtures';

/**
 * A profile page pushes in over the profile, and comes back (spec
 * `profile-unification` §1.3, §6).
 *
 * The unit tests own the mechanics — `ProfileView.test.tsx` pins the focus on
 * push and on pop, `ProfileStack` owns the frame. What only a browser can
 * answer is whether the docked profile on a real `/session` actually behaves
 * like a stack: that the panel opens on the Profile without being asked, that a
 * row replaces the whole panel rather than growing it, and that the way back
 * lands on the row you left from with the root's rows underneath it again.
 *
 * The CLICK path deliberately — `dialog-deep-link.spec.ts` already covers the
 * `?profilePage=` address, and `RightPanelPage.openProfilePage` opens a page by
 * that link. This drives the row, which is how anybody actually gets there.
 *
 * On the cockpit leg, not the test-mode one, and that is safe: nothing here
 * sends a message, so no turn is ever started. (It could not run on the mock leg
 * anyway — `chromium-mock` matches exactly one spec file, on purpose.)
 */
test.describe('Profile — a page pushes in @smoke', () => {
  test('the panel opens on the Profile, and a row takes the whole of it', async ({
    page,
    basePage,
    rightPanel,
    roomsApi,
  }) => {
    const agent = await roomsApi.registerAgent(`E2E PushIn ${roomsApi.runId}`, '🪟', '#14b8a6');
    const dir = encodeURIComponent(agent.projectPath);
    await page.goto(`/session?dir=${dir}&agentPath=${dir}`, { waitUntil: 'domcontentloaded' });
    await basePage.waitForAppReady();

    // No `?panel=` in the URL: the Profile is the contextual tab `/session`
    // auto-selects, so opening the panel is the whole of what a person does.
    await rightPanel.ensureTabStripOpen();
    await expect(rightPanel.profileTab).toHaveAttribute('aria-selected', 'true');
    const docked = page.locator('[data-slot="profile"][data-home="docked"]');
    await expect(docked).toBeVisible();

    const sessionsRow = docked.locator('[data-profile-row="sessions"]');
    await expect(sessionsRow).toBeVisible();
    await sessionsRow.click();

    // The page took the panel: the portrait is gone, and the strip carries the
    // identity in one line instead.
    await expect(page.locator('[data-slot="profile-page-title"]')).toHaveText('Sessions');
    await expect(docked.locator('[data-slot="profile-header"]')).toHaveCount(0);
    await expect(page.locator('[data-slot="profile-strip"]')).toContainText(agent.name);

    // The way out is first in the DOM — a page that owns the panel needs its
    // exit reachable without traversing the content — and focus is on the
    // title, which is what the page IS.
    const firstButton = page.locator('[data-slot="profile-page"] button').first();
    await expect(firstButton).toHaveAttribute('aria-label', 'Back to profile');
    await expect(page.locator('[data-slot="profile-page-title"]')).toBeFocused();
  });

  test('coming back lands on the row it left from, with the root underneath', async ({
    page,
    basePage,
    rightPanel,
    roomsApi,
  }) => {
    const agent = await roomsApi.registerAgent(`E2E PopBack ${roomsApi.runId}`, '🚪', '#f97316');
    const dir = encodeURIComponent(agent.projectPath);
    await page.goto(`/session?dir=${dir}&agentPath=${dir}`, { waitUntil: 'domcontentloaded' });
    await basePage.waitForAppReady();
    await rightPanel.ensureTabStripOpen();

    const docked = page.locator('[data-slot="profile"][data-home="docked"]');
    await docked.locator('[data-profile-row="rooms"]').click();
    await expect(page.locator('[data-slot="profile-page-title"]')).toHaveText('Rooms');

    await page.getByRole('button', { name: 'Back to profile' }).click();

    // The root is back — the portrait and its rows, not an empty frame — and
    // focus is where the eye already was, so the next Tab carries on from the
    // row rather than starting the panel over.
    await expect(docked.locator('[data-slot="profile-header"]')).toBeVisible();
    await expect(docked.locator('[data-profile-row="rooms"]')).toBeFocused();
  });
});
