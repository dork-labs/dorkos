import { expect, type Locator, type Page } from '@playwright/test';
import { RightPanelPage } from './RightPanelPage';

/** The local browser's human controls; native pages are never located through an iframe. */
export class LocalBrowserPage {
  readonly controls: Locator;
  /** The chrome's status pill, which says who has the page (DOR-4428). */
  readonly pill: Locator;
  constructor(readonly page: Page) {
    this.controls = page.getByRole('region', { name: 'Agent browser', exact: true });
    this.pill = this.controls.locator('[data-slot="browser-status-pill"]');
  }
  /** Reveal the existing Browser view or add its controls through the shared menu. */
  async open(): Promise<void> {
    const panel = new RightPanelPage(this.page);
    await panel.ensureTabStripOpen();
    const liveBrowser = panel.header.locator('[role="tab"][data-view-category="local-browser"]');
    if (await liveBrowser.count()) await liveBrowser.first().click();
    else {
      await panel.header.getByRole('button', { name: 'Add view', exact: true }).click();
      await this.page.getByRole('menuitem', { name: 'Browser', exact: true }).click();
    }
    await expect(this.controls).toBeVisible();
  }
  /** Close the browser from the chrome's ⋯ menu, which draws outside the panel. */
  async close(): Promise<void> {
    await this.controls.getByRole('button', { name: 'Browser menu', exact: true }).click();
    await this.page.getByRole('menuitem', { name: 'Close browser', exact: true }).click();
  }
  /** Press one of the pill's agent controls; its popover draws outside the panel. */
  async pressInPill(name: string | RegExp): Promise<void> {
    await this.pill.click();
    await this.page
      .getByRole('button', typeof name === 'string' ? { name, exact: true } : { name })
      .click();
  }
  /**
   * Whether Forward can be used right now. Below 480px of chrome Forward leaves
   * the row for the ⋯ menu (spec §12), so this reads the menu then and closes it
   * again. Read it through `expect.poll`: a plain read does not retry.
   */
  async forwardEnabled(): Promise<boolean> {
    const inRow = this.forwardInRow();
    if (await inRow.isVisible()) return inRow.isEnabled();
    const item = await this.openForwardInMenu();
    const enabled = await item.isEnabled();
    await this.page.keyboard.press('Escape');
    await expect(item).toHaveCount(0);
    return enabled;
  }
  /** Go forward from the row, or from the ⋯ menu when the row has handed Forward to it. */
  async goForward(): Promise<void> {
    const inRow = this.forwardInRow();
    if (await inRow.isVisible()) return inRow.click();
    await (await this.openForwardInMenu()).click();
  }
  private forwardInRow(): Locator {
    return this.controls.getByRole('button', { name: 'Forward', exact: true });
  }
  private async openForwardInMenu(): Promise<Locator> {
    await this.controls.getByRole('button', { name: 'Browser menu', exact: true }).click();
    const item = this.page
      .getByRole('menuitem', { name: 'Forward', exact: true })
      .or(
        this.page
          .locator('[data-slot="drawer-content"]')
          .getByRole('button', { name: 'Forward', exact: true })
      );
    await expect(item).toBeVisible();
    return item;
  }
  /** Navigate the one live page through the app's normal human control: the address field. */
  async navigate(url: string): Promise<void> {
    const atRest = this.controls.getByRole('button', { name: /^Address:/ });
    await atRest.click();
    const field = this.controls.getByRole('textbox', { name: 'Address', exact: true });
    await field.fill(url);
    await field.press('Enter');
    // At rest the field names where the page is: host (no `www.`) and path.
    const target = new URL(url);
    const atRoot = target.pathname === '/' && target.search === '' && target.hash === '';
    const rest = atRoot ? '' : `${target.pathname}${target.search}${target.hash}`;
    await expect(atRest).toHaveAccessibleName(
      `Address: ${target.host.replace(/^www\./, '')}${rest}`
    );
    // And the panel is no longer busy with it: Reload is enabled again.
    await expect(this.controls.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  }
}
