import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, expect } from '@playwright/test';

// Resolve the seed fixture relative to this file so the test does not depend on cwd.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  HERE,
  '../../../packages/marketplace/fixtures/dorkos-community-marketplace.json'
);

const REGISTRY_URL =
  'https://raw.githubusercontent.com/dorkos-community/marketplace/main/marketplace.json';

// apps/site runs on port 6244 in dev (see apps/site/package.json `dev` script).
// The default Playwright baseURL targets apps/client; this suite overrides it to
// hit the marketing site, where /marketplace lives.
const SITE_BASE_URL = 'http://localhost:6244';

test.use({ baseURL: SITE_BASE_URL });

test.describe('marketplace browse', () => {
  let fixtureBody: string;

  test.beforeAll(async () => {
    fixtureBody = await readFile(FIXTURE_PATH, 'utf8');
  });

  test.beforeEach(async ({ page }) => {
    // Intercept the upstream registry fetch so the test is deterministic and
    // does not depend on the dorkos-community/marketplace repo existing yet.
    await page.route(REGISTRY_URL, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: fixtureBody,
      });
    });
  });

  test('renders package grid and filters by type', async ({ page }) => {
    await page.goto('/marketplace');

    await expect(page.getByRole('heading', { name: 'Marketplace', level: 1 })).toBeVisible();

    // Both seed packages should appear in the unfiltered grid. Use `.first()`
    // because featured agents render in both the rail and the grid.
    await expect(page.getByText('code-reviewer').first()).toBeVisible();
    await expect(page.getByText('discord-adapter').first()).toBeVisible();

    // Click the "agent" filter tab. The MarketplaceGrid renders a navigation
    // strip of `<Link>` elements with the type label as text content.
    await page
      .getByRole('navigation', { name: 'Filter by package type' })
      .getByRole('link', { name: 'agent', exact: true })
      .click();

    await expect(page).toHaveURL(/[?&]type=agent\b/);

    // Agents remain visible after filtering; non-agent packages are filtered out.
    await expect(page.getByText('code-reviewer').first()).toBeVisible();
    await expect(page.getByText('discord-adapter')).toHaveCount(0);
  });

  test('navigates to package detail page', async ({ page }) => {
    await page.goto('/marketplace');

    // The featured rail shows code-reviewer first; clicking it routes to the
    // detail page. Use `.first()` because PackageCard links to the same href
    // from both the featured rail and the main grid.
    await page
      .getByRole('link', { name: /code-reviewer/ })
      .first()
      .click();

    await expect(page).toHaveURL(/\/marketplace\/code-reviewer$/);
    await expect(page.getByRole('heading', { name: 'code-reviewer', level: 1 })).toBeVisible();
    await expect(page.getByText('dorkos install code-reviewer')).toBeVisible();
  });

  test('renders telemetry privacy page', async ({ page }) => {
    await page.goto('/marketplace/privacy');

    await expect(
      page.getByRole('heading', { name: 'Marketplace privacy', level: 1 })
    ).toBeVisible();
    await expect(page.getByText(/Opt-in/i).first()).toBeVisible();
  });
});
