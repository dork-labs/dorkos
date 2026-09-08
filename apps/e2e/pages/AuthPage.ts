import type { Page, Locator } from '@playwright/test';
import { openFromCommandPalette } from './command-palette';

/**
 * Page Object Model for the local-login (Better Auth) surface:
 * - the Settings → Access panel ("Require login" toggle, sign-out),
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

  /**
   * Open Settings from the command palette and switch to the Access tab.
   *
   * "Access" since DOR-1758: the Security and DorkOS account tabs answered one
   * question and became two sections of one tab.
   */
  async openAccessTab() {
    // Idempotent: the open dialog writes `?settings=…` into the URL, so a
    // `page.reload()` mid-test comes back with Settings already up — and the
    // command-palette button is then behind a modal that swallows the click.
    if (!(await this.settingsDialog.isVisible().catch(() => false))) {
      await openFromCommandPalette(this.page, 'Settings');
      await this.settingsDialog.waitFor({ state: 'visible' });
    }
    await this.settingsDialog.getByRole('tab', { name: /^access$/i }).click();
  }

  /** The "Require login" toggle in Settings → Access. */
  get requireLoginSwitch() {
    return this.settingsDialog.getByRole('switch', { name: /require login/i });
  }

  /** The "Sign out" control shown in Settings → Access when signed in. */
  get signOutButton() {
    return this.settingsDialog.getByRole('button', { name: /sign out/i });
  }

  // ---------- API keys (Settings → Access) ----------

  /** The "API keys" block inside Settings → Access. */
  get apiKeysHeading() {
    return this.settingsDialog.getByText('API keys', { exact: true });
  }

  /** The name field of the create-a-key form. */
  get apiKeyNameInput() {
    return this.settingsDialog.getByRole('textbox', { name: /^name$/i });
  }

  /** The "Create key" button. */
  get createApiKeyButton() {
    return this.settingsDialog.getByRole('button', { name: /^create key$/i });
  }

  /** The one-time plaintext reveal shown immediately after creation. */
  get apiKeyReveal() {
    return this.settingsDialog.getByText(/copy your key now/i);
  }

  /**
   * The row for an existing key, addressed by its revoke button — the only
   * control on the row that carries the key's name in its accessible name.
   *
   * @param name - The key's name, as typed into the create form.
   */
  apiKeyRow(name: string) {
    return this.settingsDialog.getByRole('button', { name: `Revoke ${name}` });
  }

  /**
   * Create a key and dismiss its one-time reveal, leaving the list on screen.
   *
   * @param name - The name to give the key.
   */
  async createApiKey(name: string) {
    await this.apiKeyNameInput.fill(name);
    await this.createApiKeyButton.click();
    await this.apiKeyReveal.waitFor({ state: 'visible' });
    await this.settingsDialog.getByRole('button', { name: /^done$/i }).click();
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

  /**
   * Sign in if — and only if — the login screen is up.
   *
   * Every test in the suite starts with an EMPTY cookie jar (`storageState` in
   * `playwright.config.ts` pins `cookies: []`), so a session created by an
   * earlier test in a serial chain does not carry into the next one: once login
   * is required, each test opens on the login screen. Callers that need the app
   * shell say so by calling this first, rather than assuming a session they were
   * never given.
   *
   * @param email - The owner's email.
   * @param password - The owner's password.
   */
  async ensureSignedIn(email: string, password: string) {
    if (await this.loginHeading.isVisible().catch(() => false)) {
      await this.signIn(email, password);
      await this.loginHeading.waitFor({ state: 'hidden' });
    }
  }

  /** Fill and submit the full-bleed LoginScreen. */
  async signIn(email: string, password: string) {
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password', { exact: true }).fill(password);
    await this.page.getByRole('button', { name: /^sign in$/i }).click();
  }
}
