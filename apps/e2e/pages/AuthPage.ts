import type { Page, Locator } from '@playwright/test';

/**
 * Page Object Model for the local-login (Better Auth) surface:
 * - the Settings → Security panel ("Require login" toggle, sign-out),
 * - the owner-setup dialog, and
 * - the full-bleed LoginScreen that the AuthGuard renders when a session is
 *   required.
 */
export class AuthPage {
  readonly page: Page;
  readonly settingsDialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.settingsDialog = page.getByRole('dialog', { name: /settings/i });
  }

  /** Open Settings (JS click due to overlay) and switch to the Security tab. */
  async openSecurityTab() {
    await this.page.evaluate(() => {
      (document.querySelector('button[aria-label="Settings"]') as HTMLElement)?.click();
    });
    await this.settingsDialog.waitFor({ state: 'visible' });
    await this.settingsDialog.getByRole('tab', { name: /security/i }).click();
  }

  /** The "Require login" toggle in Settings → Security. */
  get requireLoginSwitch() {
    return this.settingsDialog.getByRole('switch', { name: /require login/i });
  }

  /** The "Sign out" control shown in Settings → Security when signed in. */
  get signOutButton() {
    return this.settingsDialog.getByRole('button', { name: /sign out/i });
  }

  // ---------- Owner-setup dialog ----------

  get ownerDialog() {
    return this.page.getByRole('dialog', { name: /create an owner account/i });
  }

  /** Fill and submit the owner-setup dialog. */
  async createOwner(email: string, password: string) {
    await this.ownerDialog.getByLabel('Email').fill(email);
    await this.ownerDialog.getByLabel('Password', { exact: true }).fill(password);
    await this.ownerDialog.getByLabel('Confirm password').fill(password);
    await this.ownerDialog.getByRole('button', { name: /create account/i }).click();
  }

  // ---------- LoginScreen (AuthGuard) ----------

  /** Heading unique to the full-bleed sign-in screen. */
  get loginHeading() {
    return this.page.getByRole('heading', { name: /sign in to dorkos/i });
  }

  /** Fill and submit the full-bleed LoginScreen. */
  async signIn(email: string, password: string) {
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password', { exact: true }).fill(password);
    await this.page.getByRole('button', { name: /^sign in$/i }).click();
  }
}
