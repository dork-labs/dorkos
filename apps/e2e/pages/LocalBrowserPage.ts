import { expect, type Locator, type Page } from '@playwright/test';
import { RightPanelPage } from './RightPanelPage';

/** The local browser's human controls; native pages are never located through an iframe. */
export class LocalBrowserPage {
  readonly controls: Locator;
  constructor(readonly page: Page) {
    this.controls = page.getByRole('region', { name: 'Local browser', exact: true });
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
  /** Navigate the one live page through the app's normal human control. */
  async navigate(url: string): Promise<void> {
    await this.controls.getByRole('textbox', { name: 'Web address', exact: true }).fill(url);
    await this.controls.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(this.controls.getByRole('button', { name: 'Go', exact: true })).toBeEnabled();
    await expect(
      this.controls.getByRole('textbox', { name: 'Web address', exact: true })
    ).toHaveValue(url);
  }
}
