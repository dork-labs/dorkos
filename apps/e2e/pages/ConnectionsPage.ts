import type { Page, Locator } from '@playwright/test';
import { openFromCommandPalette } from './command-palette';

/**
 * Page Object Model for the /connections page.
 *
 * One list of apps (DOR-2418): "Yours" (every connected account and chat app,
 * one row each) above "All apps" (everything that could be connected, with a
 * small "For developers" group under it). A connected row opens a side panel
 * whose address is `?app=<id>`. Decisions waiting on the owner sit in a "Needs
 * you" strip on top, only when there is one.
 */
export class ConnectionsPage {
  readonly page: Page;
  readonly heading: Locator;
  /** The one list: search, Yours, All apps, For developers. */
  readonly list: Locator;
  /** "Yours" — absent on a first visit, when nothing is connected. */
  readonly yours: Locator;
  /** "All apps" (headed "Apps" while searching). */
  readonly allApps: Locator;
  /** The side panel a connected row opens. */
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    // The page's `h1` is `sr-only` (design decision E1): the one bar overhead
    // already says "Connections", so the heading exists for the outline, not
    // for the eye. Assert it is attached, never that it is visible — a 1px
    // clipped box satisfies Playwright's visibility check either way, which
    // would make a "visible" assertion here pass without meaning anything.
    this.heading = page.getByRole('heading', { name: 'Connections', level: 1 });
    this.list = page.getByTestId('connections-list');
    this.yours = page.getByRole('region', { name: 'Yours', exact: true });
    this.allApps = page.getByRole('region', { name: /^(All apps|Apps)$/ });
    this.panel = page.getByTestId('app-panel');
  }

  /** Go straight to the page. */
  async goto() {
    await this.page.goto('/connections');
    await this.heading.waitFor({ state: 'attached' });
    await this.allApps.waitFor({ state: 'visible' });
  }

  /** Reach the page the way a person would, through the command palette. */
  async openFromPalette() {
    await openFromCommandPalette(this.page, 'Connections');
    await this.heading.waitFor({ state: 'attached' });
    await this.allApps.waitFor({ state: 'visible' });
  }

  /** The one quiet line the list shows when chat apps are turned off on this server. */
  get chatAppsOff() {
    return this.page.getByTestId('chat-apps-off');
  }

  /**
   * One row in "Yours", by the app's name and, optionally, which account it
   * is. Several rows can share an app's name (a second Gmail is a second row),
   * so pass the account (its label or address, the start of the line under
   * the name) to pick one.
   */
  yourApp(name: string, account?: string) {
    const rows = this.page.locator('[data-testid^="app-row-"]', { hasText: name });
    if (!account) return rows;
    const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return rows.filter({ has: this.page.getByText(new RegExp(`^${escaped}( ·|$)`)) });
  }

  /** One app in "All apps", by its service id. */
  catalogApp(serviceSlug: string) {
    return this.page.getByTestId(`catalog-app-${serviceSlug}`);
  }

  /** The row button that starts connecting an app ("Connect Gmail", "Set up Webhook"). */
  connect(displayName: string) {
    return this.page.getByRole('button', {
      name: new RegExp(`^(Connect|Set up) ${displayName}$`),
    });
  }

  /** Open one connected app's side panel by clicking its row. */
  async openPanel(name: string, account?: string) {
    await this.yourApp(name, account).first().getByRole('button').first().click();
    await this.panel.waitFor({ state: 'visible' });
    return this.panel;
  }

  /** Unfold the side panel's "More". */
  async openMore() {
    await this.panel.getByRole('button', { name: 'More' }).click();
    return this.panel.getByTestId('app-panel-more');
  }

  /** Chats that arrived with no agent set to answer them, inside a chat app's panel. */
  get waitingOnYou() {
    return this.page.getByRole('region', { name: 'Waiting on you' });
  }

  /** Your own Composio or Nango key is set in Settings › Connections; the page points there. */
  get carrierSection() {
    return this.page.getByRole('button', { name: 'Set it up in Settings › Connections' });
  }

  /** Decisions waiting on the owner (agent requests, program reviews), when any. */
  get needsYou() {
    return this.page.getByTestId('needs-you');
  }

  /** Exact operation access editor for a connected account, from its side panel. */
  async openAccess(name: string, account?: string) {
    await this.openPanel(name, account);
    const more = await this.openMore();
    await more.getByRole('button', { name: 'Exact actions per agent' }).click();
    return this.page.getByTestId('connector-access-dialog');
  }
}
