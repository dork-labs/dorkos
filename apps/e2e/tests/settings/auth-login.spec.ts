import { test, expect } from '../../fixtures';

/**
 * P1 local-login lifecycle (accounts-and-auth spec).
 *
 * Covers the full owner-login flow through the real UI:
 *   1. auth-OFF boots straight into the app with no login screen (zero-config
 *      regression check);
 *   2. enabling login via Settings → Security creates the owner and the session
 *      survives a full page reload;
 *   3. signing out returns to the login screen, and signing back in restores
 *      access; the run then disables login again to restore zero-config.
 *
 * ISOLATION: these tests mutate GLOBAL, PERSISTENT auth state (the `user` table
 * in SQLite + `auth.enabled` in config.json). They are `serial` and self-heal
 * (the last test turns login back off), but they must NOT race the rest of the
 * suite against a shared instance, and they assume a CLEAN instance at start (no
 * owner, auth off). They are therefore OPT-IN: skipped unless `DORKOS_E2E_AUTH`
 * is set, so a normal `pnpm e2e` run never touches auth state. Run them against a
 * throwaway DORK_HOME, e.g.:
 *
 *   DORKOS_E2E_AUTH=1 DORK_HOME=/tmp/dorkos-auth-e2e DORKOS_PORT=4242 VITE_PORT=4241 \
 *     pnpm --filter @dorkos/e2e exec playwright test tests/settings/auth-login.spec.ts --workers=1
 *
 * (or wire a dedicated isolated webServer + project in playwright.config.ts,
 * mirroring the existing test-mode project, before adding `@auth` to CI.)
 */

const OWNER_EMAIL = 'owner@e2e.dorkos.local';
const OWNER_PASSWORD = 'e2e-owner-pw-123';

// eslint-disable-next-line no-restricted-syntax -- e2e has no env.ts; opt-in gate for a state-mutating suite
const RUN_AUTH_E2E = !!process.env.DORKOS_E2E_AUTH;

test.describe('Auth — local login lifecycle @auth', () => {
  test.skip(
    !RUN_AUTH_E2E,
    'Opt-in: set DORKOS_E2E_AUTH=1 (mutates global auth state; run against an isolated DORK_HOME).'
  );
  test.describe.configure({ mode: 'serial' });

  test('auth-off mode boots straight into the app with no login screen', async ({
    basePage,
    authPage,
  }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    // Zero-config regression: the app shell renders and no login screen appears.
    await expect(basePage.page.locator('[data-testid="app-shell"]')).toBeVisible();
    await expect(authPage.loginHeading).toBeHidden();

    // Progressive disclosure: Security shows only the (off) "Require login" toggle.
    await authPage.openSecurityTab();
    await expect(authPage.requireLoginSwitch).not.toBeChecked();
  });

  test('enable login creates the owner and the session survives a reload', async ({
    basePage,
    authPage,
  }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    await authPage.openSecurityTab();
    // Toggling on launches owner-account creation; the flag flips once it exists.
    await authPage.requireLoginSwitch.click();
    await expect(authPage.ownerDialog).toBeVisible();
    await authPage.createOwner(OWNER_EMAIL, OWNER_PASSWORD);

    // Sign-up auto-signs-in and flips the flag; the dialog closes, still in-app.
    await expect(authPage.ownerDialog).toBeHidden();
    await expect(authPage.requireLoginSwitch).toBeChecked();
    await expect(authPage.loginHeading).toBeHidden();

    // A full reload keeps the session (Better Auth cookie) — no login screen.
    await basePage.page.reload();
    await basePage.waitForAppReady();
    await expect(authPage.loginHeading).toBeHidden();
  });

  test('sign out returns to the login screen; sign in restores access', async ({
    basePage,
    authPage,
  }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    await authPage.openSecurityTab();
    await authPage.signOutButton.click();

    // With no session and login still required, the next reload's gated requests
    // 401 and the AuthGuard renders the full-bleed login screen.
    await basePage.page.reload();
    await expect(authPage.loginHeading).toBeVisible();

    // Signing back in returns to the app.
    await authPage.signIn(OWNER_EMAIL, OWNER_PASSWORD);
    await expect(authPage.loginHeading).toBeHidden();
    await expect(basePage.page.locator('[data-testid="app-shell"]')).toBeVisible();

    // Restore zero-config for the shared instance: turn login back off.
    await authPage.openSecurityTab();
    await authPage.requireLoginSwitch.click();
    await expect(authPage.requireLoginSwitch).not.toBeChecked();
  });
});
