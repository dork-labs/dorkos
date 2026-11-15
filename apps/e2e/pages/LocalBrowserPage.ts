import { expect, type Locator, type Page } from '@playwright/test';
import { RightPanelPage } from './RightPanelPage';

/** The local browser's human controls; native pages are never located through an iframe. */
export class LocalBrowserPage {
  readonly controls: Locator;
  constructor(readonly page: Page) {
    this.controls = page.getByRole('region', { name: 'Agent browser', exact: true });
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
