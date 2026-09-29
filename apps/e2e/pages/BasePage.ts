import { expect, type Page } from '@playwright/test';
import { SERVER_ROUND_TRIP_MS } from '../fixtures/rooms-api';

/** Shared navigation and readiness helpers every page object builds on. */
export class BasePage {
  constructor(readonly page: Page) {}

  async goto(path = '/') {
    await this.page.goto(path);
  }

  /**
   * Wait for the app shell to mount.
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

  /** Expand the desktop sidebar; phones use persistent tabs and have no sidebar. */
  async ensureSidebarOpen() {
    await this.waitForAppReady();
    const sidebar = this.page.locator('[data-slot="sidebar"]');
    if ((await sidebar.count()) === 0) return;

    if ((await sidebar.getAttribute('data-state')) === 'collapsed') {
      await this.page.locator('[data-slot="sidebar-trigger"]').click();
    }
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');
    await expect(sidebar.locator('[data-slot="sidebar-inner"]')).toBeInViewport({
      ratio: 1,
    });
  }
}
