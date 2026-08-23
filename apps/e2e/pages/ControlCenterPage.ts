import { type Page, type Locator } from '@playwright/test';

/**
 * Page Object for the Control Center flyout (spec `full-power-defaults`, D7).
 *
 * The flyout opens from the ⚡ glyph in the top-bar cluster — the one always-
 * present anchor — and holds the global Trust Dial, the power switches and the
 * overrides ledger. Located by role and testid, never by layout: the flyout is a
 * portalled popover, so its geometry is not the test's to promise.
 */
export class ControlCenterPage {
  readonly page: Page;
  /** The ⚡ glyph — the only button named "Control Center" on a desktop viewport. */
  readonly trigger: Locator;
  /** The flyout contents, present only while it is open. */
  readonly body: Locator;
  /** The "Warm agents" power switch (`runtimes.claudeCode.persistentSession`). */
  readonly warmAgentsSwitch: Locator;

  constructor(page: Page) {
    this.page = page;
    this.trigger = page.getByRole('button', { name: 'Control Center' });
    this.body = page.getByTestId('control-center-body');
    this.warmAgentsSwitch = page.getByRole('switch', { name: 'Warm agents' });
  }

  /** Open the flyout from the glyph and wait for its body to render. */
  async open() {
    await this.trigger.click();
    await this.body.waitFor({ state: 'visible' });
  }

  /**
   * A row in the overrides ledger, by the surface it owns.
   *
   * @param kind - Which surface the row deep-links to.
   */
  overrideRow(kind: 'runtime' | 'session' | 'task' | 'binding'): Locator {
    return this.page.getByTestId(`override-row-${kind}`);
  }
}
