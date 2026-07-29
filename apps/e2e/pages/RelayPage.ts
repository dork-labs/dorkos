import type { Page, Locator } from '@playwright/test';
import { openFromCommandPalette } from './command-palette';

/**
 * Page Object Model for the Relay dialog.
 *
 * Three names for one feature, all of them live: the palette entry says
 * "Integrations", the dialog is titled "Connections", and the server flag and
 * disabled-state copy still say "Relay". Nothing here guesses between them.
 */
export class RelayPage {
  readonly page: Page;
  readonly dialog: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByRole('dialog', { name: 'Connections' });
    this.closeButton = this.dialog.getByRole('button', { name: /close/i });
  }

  /** Open the Relay dialog from the command palette. */
  async open() {
    await openFromCommandPalette(this.page, 'Integrations');
    await this.dialog.waitFor({ state: 'visible' });
  }

  async close() {
    await this.closeButton.click();
    await this.dialog.waitFor({ state: 'hidden' });
  }

  get heading() {
    return this.dialog.getByRole('heading', { name: 'Connections' });
  }

  get notEnabledMessage() {
    return this.dialog.getByText(/relay provides inter-agent messaging/i);
  }

  get enableInstructions() {
    return this.dialog.getByText(/DORKOS_RELAY_ENABLED=true/);
  }

  /**
   * The tab strip.
   *
   * Present whenever any adapter instance is configured, which on a running
   * server is always: DorkOS registers a built-in `claude-code` adapter. The
   * no-tabs empty state ("Connect your agents to the world") therefore has no
   * coverage here — reaching it would mean a server with that adapter removed.
   */
  get tabList() {
    return this.dialog.getByRole('tablist');
  }

  tab(name: string) {
    return this.dialog.getByRole('tab', { name: new RegExp(name, 'i') });
  }

  get activePanel() {
    return this.dialog.getByRole('tabpanel');
  }
}
