import { test, expect } from '@playwright/test';

// apps/site runs on port 6244 in dev (see apps/site/package.json `dev` script).
// The default Playwright baseURL targets apps/client; this suite overrides it to
// hit the marketing site, where /features lives. SITE_BASE_URL lets a local run
// point at an already-running dev server on another port.
// eslint-disable-next-line no-restricted-syntax -- e2e harness has no env.ts; matches playwright.config.ts
const SITE_BASE_URL = process.env.SITE_BASE_URL ?? 'http://localhost:6244';

test.use({ baseURL: SITE_BASE_URL });

// Every catalog card is a single `<a>` inside the grid `<ul>`, linking to its
// detail page. Product tabs link to `/features?product=…`, so the trailing
// slash cleanly excludes them.
const CARD_SELECTOR = 'ul a[href^="/features/"]';

// The bento grid gutter is `gap-4` (16px). Any vertical space larger than this
// beneath a card is dead space from a row-height mismatch — the exact regression
// this suite guards against (short text tiles left hanging under a tall media
// tile in the same row). A small margin above 16px absorbs sub-pixel rounding.
const MAX_DEAD_SPACE_PX = 40;

/** Viewports to assert against: the single-column, two-column, and full bento layouts. */
const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 1000 },
  { label: 'tablet', width: 768, height: 1000 },
  { label: 'mobile', width: 390, height: 844 },
] as const;

/**
 * Measure the largest vertical gap beneath any card and the card that owns it.
 *
 * For each card we find the nearest card directly below it (>40% horizontal
 * overlap, so spanning tiles are matched to the column they sit in) and record
 * the gap between them. A packed grid leaves only the 16px gutter.
 */
async function worstGapBelowAnyCard(
  page: import('@playwright/test').Page
): Promise<{ gap: number; slug: string | null }> {
  return page.evaluate((selector) => {
    const cards = [...document.querySelectorAll(selector)].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        right: r.right,
        top: r.top + window.scrollY,
        bottom: r.bottom + window.scrollY,
        width: r.width,
        slug: el.getAttribute('href'),
      };
    });

    let worst = { gap: 0, slug: null as string | null };
    for (const card of cards) {
      const below = cards.filter((other) => {
        const overlap = Math.min(card.right, other.right) - Math.max(card.x, other.x);
        return (
          other !== card &&
          overlap > Math.min(card.width, other.width) * 0.4 &&
          other.top >= card.bottom - 2
        );
      });
      if (below.length === 0) continue;
      const nearest = below.reduce((closest, other) => (other.top < closest.top ? other : closest));
      const gap = nearest.top - card.bottom;
      if (gap > worst.gap) worst = { gap: Math.round(gap), slug: card.slug };
    }
    return worst;
  }, CARD_SELECTOR);
}

test.describe('features bento grid', () => {
  for (const viewport of VIEWPORTS) {
    test(`packs with no dead space beneath any card at ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/features', { waitUntil: 'networkidle' });

      // The grid must have rendered its cards before we measure.
      await expect(page.locator(CARD_SELECTOR).first()).toBeVisible();

      const worst = await worstGapBelowAnyCard(page);
      expect(
        worst.gap,
        `card ${worst.slug} leaves ${worst.gap}px of dead space below it (grid gutter is 16px)`
      ).toBeLessThanOrEqual(MAX_DEAD_SPACE_PX);
    });
  }
});
