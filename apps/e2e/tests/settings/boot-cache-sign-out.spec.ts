import { test, expect } from '../../fixtures';
import { AuthPage } from '../../pages/AuthPage';

// Like auth-login.spec.ts, this owns global auth state and requires a fresh,
// isolated instance. Boot persistence must be ON (the default suite disables it).
// eslint-disable-next-line no-restricted-syntax -- e2e opt-in gate; no env.ts
const RUN_AUTH_E2E = !!process.env.DORKOS_E2E_AUTH;
const email = 'tern@example.invalid';
const password = 'made-up-tern-password';

async function bootEntries(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('dorkos:rq:'))
  );
}

test.describe('Sign-out erases boot memory in every tab @auth', () => {
  test.skip(!RUN_AUTH_E2E, 'Needs DORKOS_E2E_AUTH=1 and a fresh throwaway server.');

  test('two tabs, pagehide, sign-in recovery and public-computer idle reload', async ({
    page,
    context,
    basePage,
    authPage,
  }) => {
    await page.addInitScript(() => localStorage.removeItem('dorkos:boot-cache-disabled'));
    await basePage.goto();
    await basePage.waitForAppReady();
    await authPage.openLoginSecurityTab();
    await authPage.requireLoginSwitch.click();
    await authPage.createOwner(email, password);
    await expect(authPage.ownerDialog).toBeHidden();
    await expect(authPage.requireLoginSwitch).toBeChecked();
    await expect.poll(() => bootEntries(page)).not.toEqual([]);

    const other = await context.newPage();
    await other.goto('/');
    await expect(other.getByTestId('app-shell')).toBeVisible();
    await expect.poll(() => bootEntries(other)).not.toEqual([]);

    await authPage.signOutButton.click();
    await expect(authPage.loginHeading).toBeVisible();
    // This real second page receives a storage event, then leaves with its own
    // query cache. A pagehide flush must not resurrect the previous owner's data.
    await expect.poll(() => bootEntries(other)).toEqual([]);
    await other.reload();
    await expect(new AuthPage(other).loginHeading).toBeVisible();
    expect(await bootEntries(other)).toEqual([]);

    await authPage.signIn(email, password);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect.poll(() => bootEntries(page)).not.toEqual([]);

    // The server's ordinary session is kept for this test; only its client-side
    // publicComputer flag is supplied here to exercise the idle hook without
    // spending 30 minutes or creating a cloud account. Cookies/sign-out are real.
    await other.route('**/api/auth/get-session', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      if (data?.session) data.session.publicComputer = true;
      await route.fulfill({ response, json: data });
    });
    await other.clock.install();
    await other.reload();
    await expect(other.getByTestId('app-shell')).toBeVisible();
    await expect.poll(() => bootEntries(other)).not.toEqual([]);
    const reloaded = other.waitForEvent('load');
    await other.clock.fastForward(30 * 60 * 1_000 + 10_000);
    await reloaded;
    await expect(new AuthPage(other).loginHeading).toBeVisible();
    expect(await bootEntries(other)).toEqual([]);
    await other.close();
  });
});
