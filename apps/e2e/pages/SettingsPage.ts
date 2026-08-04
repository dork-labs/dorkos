import { expect, type Page, type Locator } from '@playwright/test';
import { openFromCommandPalette } from './command-palette';

/** Page Object Model for the Settings dialog. */
export class SettingsPage {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    // The dialog is titled "Settings".
    this.dialog = page.getByRole('dialog', { name: /settings/i });
  }

  /** Open Settings from the command palette. */
  async open() {
    await openFromCommandPalette(this.page, 'Settings');
    await this.dialog.waitFor({ state: 'visible' });
  }

  async close() {
    await this.page.keyboard.press('Escape');
    await this.dialog.waitFor({ state: 'hidden' });
  }

  async closeViaButton() {
    await this.dialog.getByRole('button', { name: /close/i }).click();
    await this.dialog.waitFor({ state: 'hidden' });
  }

  /**
   * Switch tabs, and wait for the outgoing panel to finish leaving.
   *
   * For ~150ms after a switch there are genuinely **two** `role="tabpanel"`
   * elements in the dialog: the panel host crossfades with
   * `AnimatePresence mode="popLayout"`, and the exiting wrapper re-renders
   * against the new tab, so both wrappers hold a panel with the same `id`.
   * Settling here rather than in each caller is what keeps {@link
   * SettingsPage.activePanel} unambiguous — and it is why `switches.count()`
   * once answered 16 for a tab that has 8 switches: `count()` does not retry, so
   * it could sample mid-animation and see both copies.
   *
   * (The duplicate `id` is a real defect in `navigation-layout.tsx`, not
   * something this suite should paper over — but it is a defect about tab
   * animation, and these tests are about settings.)
   */
  async switchTab(tabName: string) {
    await this.dialog.getByRole('tab', { name: new RegExp(tabName, 'i') }).click();
    await expect(this.dialog.getByRole('tabpanel')).toHaveCount(1);
  }

  get heading() {
    return this.dialog.getByRole('heading', { name: /settings/i });
  }

  get tabList() {
    return this.dialog.getByRole('tablist');
  }

  /** Get a specific tab by name. */
  tab(name: string) {
    return this.dialog.getByRole('tab', { name: new RegExp(name, 'i') });
  }

  /** Get the active tab panel. */
  get activePanel() {
    return this.dialog.getByRole('tabpanel');
  }

  /** Appearance tab elements. */
  get themeCombobox() {
    return this.activePanel.getByRole('combobox').first();
  }

  /** Get all toggle switches in the current tab panel. */
  get switches() {
    return this.activePanel.getByRole('switch');
  }

  /**
   * Server tab: the address DorkOS is answering on.
   *
   * There is no "Port" row any more — DOR-539 replaced it with a copyable
   * address, and the port survives only as digits inside this URL.
   */
  get addressInfo() {
    return this.activePanel.locator('code').first();
  }

  /** Server tab: Node.js display. */
  get nodeInfo() {
    return this.activePanel.getByRole('button', { name: /^node\.js/i });
  }

  // ---------------------------------------------------------------------------
  // Runtimes tab
  //
  // Every control on a runtime card is namespaced by runtime type, because the
  // tab draws three cards at once and a page-global id could not name one of
  // them. The accessors below take that type and nothing else, so a spec never
  // hand-builds `runtime-…-<type>` strings.
  // ---------------------------------------------------------------------------

  /** Runtimes tab: one runtime's whole card. */
  runtimeCard(type: string) {
    return this.activePanel.getByTestId(`runtime-card-${type}`);
  }

  /**
   * Runtimes tab: every `Default` pill on the tab.
   *
   * Exactly one runtime is the default, so this is the locator that says how
   * many cards claim to be it — a count, where {@link SettingsPage.runtimeDefaultPill}
   * asks about one card.
   */
  get runtimeDefaultPills() {
    return this.activePanel.locator('[data-testid^="runtime-default-pill-"]');
  }

  /** Runtimes tab: the `Default` pill on one runtime's card. */
  runtimeDefaultPill(type: string) {
    return this.activePanel.getByTestId(`runtime-default-pill-${type}`);
  }

  /**
   * Runtimes tab: the card's own open/close control.
   *
   * The identity block IS the button, so this carries the `aria-expanded`
   * state. The chevron beside it is a second, equally declared toggle for the
   * same body (`runtime-card-chevron-<type>`), so either one opens the card.
   * A card with nothing to open renders neither.
   */
  runtimeCardToggle(type: string) {
    return this.activePanel.getByTestId(`runtime-card-toggle-${type}`);
  }

  /** Runtimes tab: one runtime's expanded body. */
  runtimeCardBody(type: string) {
    return this.activePanel.getByTestId(`runtime-card-body-${type}`);
  }

  /** Runtimes tab: the collapsed one-line summary of a connected runtime. */
  runtimeCardSummary(type: string) {
    return this.activePanel.getByTestId(`runtime-card-summary-${type}`);
  }

  /** Runtimes tab: the green Ready marker, present only on a connected runtime. */
  runtimeReady(type: string) {
    return this.activePanel.getByTestId(`runtime-ready-${type}`);
  }

  /** Runtimes tab: point new conversations at this runtime. */
  runtimeMakeDefault(type: string) {
    return this.activePanel.getByTestId(`runtime-make-default-${type}`);
  }

  /** Runtimes tab: the Model row's select, inside an expanded card. */
  runtimeModelSelect(type: string) {
    return this.activePanel.getByTestId(`runtime-model-select-${type}`);
  }

  /** Runtimes tab: re-run every runtime's connection checks. */
  get runtimesRecheck() {
    return this.activePanel.getByTestId('runtimes-recheck');
  }

  /** Runtimes tab: the fleet-wide trust row that sits beneath every card. */
  get globalTrustRow() {
    return this.activePanel.getByTestId('global-trust-row');
  }
}
