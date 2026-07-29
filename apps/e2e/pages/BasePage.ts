import type { Page } from '@playwright/test';
import { SERVER_ROUND_TRIP_MS } from '../fixtures/rooms-api';

/** Shared navigation and readiness helpers every page object builds on. */
export class BasePage {
  constructor(readonly page: Page) {}

  async goto(path = '/') {
    await this.page.goto(path);
  }

  /**
   * Wait for the cockpit shell to mount.
   *
   * The ceiling is the suite's shared {@link SERVER_ROUND_TRIP_MS}, not the 10s
   * this used to hardcode. It is a **ceiling, not a delay** — the selector
   * resolves the moment the shell mounts, so on an idle machine this returns in
   * milliseconds and costs nothing. What the larger ceiling buys is the same
   * thing it buys everywhere else in this suite: survival on a machine running
   * several agents and dev servers at once, where four workers all boot the app
   * together and 10s is simply the wrong number. Nothing here is testing how
   * fast the shell mounts.
   */
  async waitForAppReady() {
    await this.page.waitForSelector('[data-testid="app-shell"]', {
      timeout: SERVER_ROUND_TRIP_MS,
    });
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
