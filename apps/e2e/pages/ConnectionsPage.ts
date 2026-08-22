import type { Page, Locator } from '@playwright/test';
import { openFromCommandPalette } from './command-palette';

/**
 * Page Object Model for the /connections page.
 *
 * One name now, where there used to be three: the palette entry, the surface
 * and the page all say "Connections". The server flag and its disabled-state
 * copy are the exception the product cannot change — an operator sets
 * `DORKOS_RELAY_ENABLED`, so that string stays as it is.
 *
 * Two regions on one scroll, not tabs. Every getter here is scoped to a region
 * so an assertion cannot accidentally match the other half of the page.
 */
export class ConnectionsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly messaging: Locator;
  readonly accounts: Locator;

  constructor(page: Page) {
    this.page = page;
    // The page's `h1` is `sr-only` (design decision E1): the one bar overhead
    // already says "Connections", so the heading exists for the outline, not
    // for the eye. Assert it is attached, never that it is visible — a 1px
    // clipped box satisfies Playwright's visibility check either way, which
    // would make a "visible" assertion here pass without meaning anything.
    this.heading = page.getByRole('heading', { name: 'Connections', level: 1 });
    this.messaging = page.getByRole('region', { name: 'Messaging' });
    this.accounts = page.getByRole('region', { name: 'Accounts' });
  }

  /** Go straight to the page. */
  async goto() {
    await this.page.goto('/connections');
    await this.heading.waitFor({ state: 'attached' });
    await this.messaging.waitFor({ state: 'visible' });
  }

  /** Reach the page the way a person would, through the command palette. */
  async openFromPalette() {
    await openFromCommandPalette(this.page, 'Connections');
    await this.heading.waitFor({ state: 'attached' });
    await this.messaging.waitFor({ state: 'visible' });
  }

  /** The messaging region's honest empty state when the server flag is off. */
  get messagingOffMessage() {
    return this.messaging.getByText(/messaging is off/i);
  }

  /** The command that turns messaging on — an operator instruction, verbatim. */
  get enableInstructions() {
    return this.messaging.getByText(/DORKOS_RELAY_ENABLED=true/);
  }

  /**
   * One live messaging connection's card, found by the name it displays.
   *
   * Anchored structurally to the card holding that name rather than to the
   * first card on the page: the suite shares one server, so a spec running
   * alongside this one can add a connection and change what "first" means.
   */
  liveConnection(name: string) {
    return this.messaging
      .getByText(name, { exact: true })
      .locator('xpath=ancestor::div[.//*[@role="switch"]][1]');
  }

  /** The button that starts adding a new way to reach your agents. */
  addConnection(displayName: string) {
    return this.messaging.getByRole('button', { name: `Add ${displayName}` });
  }

  /** Chats that arrived with no agent set to answer them. */
  get waitingOnYou() {
    return this.page.getByRole('region', { name: 'Waiting on you' });
  }

  /** The collapsed section naming the two account carriers, verbatim. */
  get carrierSection() {
    return this.accounts.getByRole('button', { name: 'Composio & Nango' });
  }
}
