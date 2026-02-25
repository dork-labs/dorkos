import type { Page } from '@playwright/test';

export class BasePage {
  constructor(readonly page: Page) {}

  async goto(path = '/') {
    await this.page.goto(path);
  }

  async waitForAppReady() {
    await this.page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
  }

  /** Ensure the sidebar is expanded (click "Open sidebar" if collapsed). */
  async ensureSidebarOpen() {
    const openButton = this.page.getByRole('button', { name: /open sidebar/i });
    if (await openButton.isVisible().catch(() => false)) {
      await openButton.click();
      // Wait for sidebar content to be interactable
      await this.page.getByRole('button', { name: /new chat/i }).waitFor({ state: 'visible' });
    }
  }
}
