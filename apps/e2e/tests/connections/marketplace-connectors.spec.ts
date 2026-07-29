import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';

/**
 * Connector discovery in the cockpit marketplace (Slice C, asserted end to end
 * by Slice E): a connector-adapter package wears the distinct CONNECTOR badge,
 * and the sidebar's Connectors refinement narrows the grid to it while plain
 * adapters drop out.
 *
 * Deterministic with no network dependence: a `file://` marketplace source
 * (fixtures/connector-marketplace) is registered against the test-mode server
 * for the duration of the suite, carrying one connector adapter and one plain
 * adapter. The default remote sources may degrade freely — the assertions name
 * only the fixture's packages.
 *
 * Runs in the `chromium-connections` project. Safe beside connections.spec.ts:
 * it touches only the marketplace source list, never the connector provider
 * state that file serializes around.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '../../fixtures/connector-marketplace');
const SOURCE_NAME = 'e2e-connector-fixture';

test.describe('Marketplace — connector badge and filter', () => {
  test.beforeAll(async ({ request }) => {
    // Re-runs may find the source already registered (409) — that is fine.
    const res = await request.post(`${API_URL}/api/marketplace/sources`, {
      data: { name: SOURCE_NAME, source: `file://${FIXTURE_DIR}` },
    });
    expect(res.ok() || res.status() === 409).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`${API_URL}/api/marketplace/sources/${SOURCE_NAME}`);
  });

  test('shows the CONNECTOR badge and narrows the grid with the Connectors facet', async ({
    page,
  }) => {
    await page.goto('/marketplace', { waitUntil: 'domcontentloaded' });
    await new BasePage(page).waitForAppReady();

    // Both fixture adapters render; aggregation over the unreachable default
    // remote sources degrades to warnings without hiding the local source.
    const connectorCard = page.locator('[data-testid="package-card-e2e-gmail-connector"]');
    const plainCard = page.locator('[data-testid="package-card-e2e-plain-adapter"]');
    await expect(connectorCard).toBeVisible({ timeout: 20_000 });
    await expect(plainCard).toBeVisible();

    // The connector adapter wears the distinct badge; the plain one stays ADAPTER.
    await expect(connectorCard.getByText('CONNECTOR', { exact: true })).toBeVisible();
    await expect(plainCard.getByText('ADAPTER', { exact: true })).toBeVisible();
    await expect(plainCard.getByText('CONNECTOR', { exact: true })).toHaveCount(0);

    // The Connectors refinement narrows to connector adapters only.
    await page
      .getByRole('group', { name: 'Filter by type' })
      .getByRole('button', { name: /^Connectors/ })
      .click();
    await expect(connectorCard).toBeVisible();
    await expect(plainCard).toHaveCount(0);

    // The plain Adapters facet still includes both (Connectors is a refinement,
    // not a partition).
    await page
      .getByRole('group', { name: 'Filter by type' })
      .getByRole('button', { name: /^Adapters/ })
      .click();
    await expect(connectorCard).toBeVisible();
    await expect(plainCard).toBeVisible();
  });
});
