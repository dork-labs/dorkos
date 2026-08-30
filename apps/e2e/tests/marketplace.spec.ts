import { test, expect } from '@playwright/test';

// The /marketplace pages render from the LIVE dork-labs/marketplace registry,
// fetched SERVER-side with hourly ISR (apps/site, features/marketplace/lib/
// fetch.ts). Server-side is the operative word: `page.route` interception never
// sees that fetch, so the previous version of this spec — a disk fixture
// "mocking" a registry URL the site had long stopped using — was dead code
// twice over, and went ENOENT the day the fixture moved. No CI ran the site
// specs, so nothing noticed (DOR-656 is the gate that changes that).
//
// This version is honest about the dependency instead: it asserts the
// STRUCTURE the pages guarantee for any non-empty registry — grid, static
// filter strip, card → detail navigation, install command — and never names a
// specific package, so it does not break when the registry's contents change.
// If the registry fetch fails or comes back empty, the browse page does NOT
// hard-error — it deliberately catches and renders a "Launching soon" empty
// state (marketplace/page.tsx: "the page must keep rendering"). These tests
// then fail as a "no card visible" timeout on CARD_SELECTOR, not as a page
// error. So when this spec reds and nothing in this repo changed, check the
// dork-labs/marketplace registry before hunting here.

// apps/site runs on port 6244 in dev (see apps/site/package.json `dev` script).
// The default Playwright baseURL targets apps/client; this suite overrides it
// to hit the marketing site, where /marketplace lives. SITE_BASE_URL lets a
// run whose site leg was moved off 6244 (DORKOS_SITE_PORT, e.g. alongside a
// live site dev server) still find it — same contract as features.spec.ts.
// eslint-disable-next-line no-restricted-syntax -- e2e harness has no env.ts; matches playwright.config.ts
const SITE_BASE_URL = process.env.SITE_BASE_URL ?? 'http://localhost:6244';

test.use({ baseURL: SITE_BASE_URL });

// A package card is a <div> with a stretched overlay <Link> (PackageCard.tsx,
// restructured by DOR-704/#606 so the category chip can be its own link
// without nesting anchors). The overlay anchor is EMPTY — the <h3> is its
// sibling, never its child — so `a:has(h3)` matches nothing, structurally and
// forever. What the overlay does carry is `aria-label={pkg.name}`: the
// accessible name IS the package name, which is also exactly the slug the
// detail route needs. Category chips and the privacy link have no aria-label,
// so that attribute is what tells a card from the rest.
const CARD_SELECTOR = 'a[href^="/marketplace/"][aria-label]:not([href*="/category/"])';

// First hits are expensive here in a way the cockpit specs never see: the dev
// server compiles each route on demand (Turbopack) AND blocks on the live
// registry fetch, and the app router streams the static shell first — so the
// h1 can be visible seconds before a single card exists. The first assertion
// after each cold navigation gets an explicit budget for that; everything
// after rides the compiled route and keeps the default 5s.
const FIRST_LOAD_TIMEOUT = 30_000;

test.describe('marketplace browse', () => {
  test('renders package grid and filters by type', async ({ page }) => {
    await page.goto('/marketplace');

    await expect(page.getByRole('heading', { name: 'Marketplace', level: 1 })).toBeVisible();

    // At least one package card renders. Content-free on purpose: which
    // packages exist is the registry's business, not this test's.
    await expect(page.locator(CARD_SELECTOR).first()).toBeVisible({
      timeout: FIRST_LOAD_TIMEOUT,
    });

    // The filter strip is static (PackageTypeSchema.options), so the tabs are
    // there whatever the registry holds. Clicking one narrows via the query
    // string — assert the navigation, not the narrowed contents.
    const filterNav = page.getByRole('navigation', { name: 'Filter by package type' });
    await expect(filterNav.getByRole('link', { name: 'All', exact: true })).toBeVisible();
    const firstTypeTab = filterNav.getByRole('link').nth(1);
    const typeLabel = (await firstTypeTab.textContent())?.trim() ?? '';
    expect(typeLabel).toBeTruthy();
    await firstTypeTab.click();
    await expect(page).toHaveURL(new RegExp(`[?&]type=${typeLabel}(&|$)`));
  });

  test('navigates to package detail page', async ({ page }) => {
    await page.goto('/marketplace');

    // Whichever package ranks first today: its overlay link's accessible name
    // is the package name, its detail page lives at /marketplace/<name>, and
    // that page renders the canonical install command for it.
    const firstCard = page.locator(CARD_SELECTOR).first();
    await expect(firstCard).toBeVisible({ timeout: FIRST_LOAD_TIMEOUT });
    const slug = (await firstCard.getAttribute('aria-label'))?.trim() ?? '';
    expect(slug).toBeTruthy();
    await firstCard.click();

    await expect(page).toHaveURL(new RegExp(`/marketplace/${slug}$`), {
      timeout: FIRST_LOAD_TIMEOUT,
    });
    await expect(page.getByRole('heading', { name: slug, level: 1 })).toBeVisible({
      timeout: FIRST_LOAD_TIMEOUT,
    });
    // .first(): most READMEs quote their own install command, and an unscoped
    // getByText strict-fails the day the first-ranked package's does. Note the
    // README renders BEFORE the canonical install block ([slug]/page.tsx), so
    // first may be the README's copy — fine for this structure test, which
    // asserts the command is visibly on the page, not which block renders it.
    await expect(page.getByText(`dorkos install ${slug}`).first()).toBeVisible();
  });

  test('renders telemetry privacy page', async ({ page }) => {
    await page.goto('/marketplace/privacy');

    await expect(
      page.getByRole('heading', { name: 'Marketplace privacy', level: 1 })
    ).toBeVisible();
    await expect(page.getByText(/Opt-in/i).first()).toBeVisible();
  });
});
