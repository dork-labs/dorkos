import { expect, type Locator, type Page } from '@playwright/test';
import {
  BrowserProductionOpenReceiptSchema,
  BrowserCloseReceiptSchema,
  type BrowserBinding,
} from '@dorkos/shared/browser-schemas';

/** Drive the installed app's existing authenticated browser UI; no internal viewer harness. */
export class ManagedBrowserPage {
  readonly canvas: Locator;
  readonly pointer: Locator;
  constructor(readonly page: Page) {
    this.canvas = page.locator('canvas[role="img"][aria-label="Shared browser"]');
    this.pointer = page.getByTestId('managed-browser-pointer');
  }
  async goto() {
    await this.page.goto('/browser');
    await expect(this.page.getByLabel('Workspace', { exact: true })).toBeVisible();
  }
  async createSaved(label: string, workspace: string) {
    await this.page.getByLabel('Workspace', { exact: true }).selectOption(workspace);
    await this.page.getByLabel('New saved profile', { exact: true }).fill(label);
    await this.page.getByRole('button', { name: 'Create saved profile', exact: true }).click();
    await expect(this.page.getByLabel('Browser', { exact: true })).toHaveValue('persistent');
    await expect(this.page.getByLabel('Saved profile', { exact: true })).not.toHaveValue('');
  }
  async openSaved() {
    await this.page.getByLabel('Browser', { exact: true }).selectOption('persistent');
    await this.page.getByRole('button', { name: 'Open saved browser', exact: true }).click();
    await expect(
      this.page.getByRole('button', { name: 'Take control', exact: true })
    ).toBeEnabled();
    await this.page.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(
      this.page.getByRole('button', { name: 'You have control', exact: true })
    ).toBeVisible();
  }
  async openClean() {
    await this.page.getByLabel('Browser', { exact: true }).selectOption('ephemeral');
    const opening = this.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/browser/runtime/open' &&
        response.request().method() === 'POST'
    );
    void opening.catch(() => {});
    try {
      await this.page.getByRole('button', { name: 'Open clean browser', exact: true }).click();
      const response = await opening;
      expect(response.status()).toBe(200);
      const receipt = BrowserProductionOpenReceiptSchema.parse(await response.json());
      expect(receipt.instance.mode).toBe('ephemeral');
      await expect(
        this.page.getByRole('button', { name: 'Take control', exact: true })
      ).toBeEnabled();
      await this.page.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(
        this.page.getByRole('button', { name: 'You have control', exact: true })
      ).toBeVisible();
      return receipt;
    } finally {
      await Promise.allSettled([opening]);
    }
  }
  async closeClean(binding: BrowserBinding) {
    const row = this.page
      .getByRole('region', { name: 'Your browsers', exact: true })
      .getByRole('listitem')
      .filter({ has: this.page.getByText(/^Clean browser \d+$/, { exact: true }) })
      .filter({
        has: this.page
          .getByRole('button', { name: 'Close', exact: true })
          .and(this.page.locator('button:not([disabled])')),
      });
    await expect(row).toHaveCount(1);
    const closing = this.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/browser/instances/close' &&
        response.request().method() === 'POST'
    );
    void closing.catch(() => {});
    try {
      await row.getByRole('button', { name: 'Close', exact: true }).click();
      const response = await closing;
      expect(response.status()).toBe(200);
      const receipt = BrowserCloseReceiptSchema.parse(await response.json());
      expect(receipt.browserId).toBe(binding.browserId);
      expect(receipt.browserGeneration).toBe(binding.browserGeneration);
      expect(receipt.cleanup).toBe('observed');
      await expect(this.canvas).toHaveCount(0);
      await expect(this.pointer).toHaveCount(0);
      await expect(this.page.getByText('Browser closed.', { exact: true })).toBeVisible();
      await expect(
        this.page.getByRole('button', { name: 'Open clean browser', exact: true })
      ).toBeEnabled();
    } finally {
      await Promise.allSettled([closing]);
    }
  }
  async navigateLocal(url: string) {
    await this.page.getByLabel('Page URL', { exact: true }).fill(url);
    const summary = this.page.getByText('Open a website on this computer', { exact: true });
    const disclosure = this.page.locator('details').filter({ has: summary });
    await expect(disclosure).toHaveCount(1);
    if ((await disclosure.getAttribute('open')) === null) await summary.click({ timeout: 10_000 });
    await expect(disclosure).toHaveAttribute('open', '');
    const original: { response?: import('@playwright/test').Response; first?: { value: unknown } } =
      {};
    const allowed = this.page
      .waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/browser/runtime/local-destination' &&
          response.request().method() === 'POST',
        { timeout: 10_000 }
      )
      .then(
        (response) => {
          original.response = response;
        },
        (value) => {
          original.first ??= { value };
        }
      );
    const clicking = disclosure
      .getByRole('button', { name: 'Allow local website for five minutes', exact: true })
      .click({ timeout: 10_000 })
      .catch((value) => {
        original.first ??= { value };
      });
    // An action failure still consumes the original response wait before this helper returns.
    await Promise.allSettled([allowed, clicking]);
    if (original.first) throw original.first.value;
    if (!original.response) throw new Error('Original local website grant response required');
    expect(original.response.status()).toBe(200);
    await this.page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(
      this.page.getByRole('button', { name: 'You have control', exact: true })
    ).toBeVisible();
  }
  async closeSaved(label: string) {
    const row = this.page
      .getByRole('region', { name: 'Your browsers', exact: true })
      .getByRole('listitem')
      .filter({ hasText: label })
      .filter({
        has: this.page
          .getByRole('button', { name: 'Close', exact: true })
          .and(this.page.locator('button:not([disabled])')),
      });
    await expect(row).toHaveCount(1);
    const response = this.page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname === '/api/browser/instances/close' &&
        value.request().method() === 'POST'
    );
    void response.catch(() => {});
    try {
      await row.getByRole('button', { name: 'Close', exact: true }).click();
      const original = await response;
      expect(original.status()).toBe(200);
      expect((await original.json()).cleanup).toBe('observed');
      await expect(this.canvas).toHaveCount(0);
      await expect(this.pointer).toHaveCount(0);
      // This UI message is checked only after the actual server cleanup receipt.
      await expect(this.page.getByText('Browser closed.', { exact: true })).toBeVisible();
      await expect(
        this.page.getByRole('button', { name: 'Open saved browser', exact: true })
      ).toBeEnabled();
    } finally {
      await Promise.allSettled([response]);
    }
  }
  async point(x: number, y: number, width: number, height: number, click = false) {
    // Raw mouse coordinates do not scroll a canvas below the saved-browser list into view.
    await this.canvas.scrollIntoViewIfNeeded({ timeout: 10_000 });
    const rect = await this.canvas.boundingBox();
    if (!rect) throw new Error('Actual browser canvas is unavailable');
    const position = {
      x: rect.x + (x * rect.width) / width,
      y: rect.y + (y * rect.height) / height,
    };
    await this.page.mouse.move(position.x, position.y);
    if (click) await this.page.mouse.click(position.x, position.y);
    return position;
  }
}
