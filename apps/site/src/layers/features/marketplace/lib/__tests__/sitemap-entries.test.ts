import { describe, it, expect } from 'vitest';
import { MARKETPLACE_CATEGORIES, type MergedMarketplaceEntry } from '@dorkos/marketplace';

import { marketplaceSitemapEntries } from '../sitemap-entries';

const BASE = 'https://dorkos.ai';

/** Build a minimal merged entry carrying only the fields the sitemap reads. */
function entry(
  name: string,
  opts: { category?: string; categories?: string[] } = {}
): MergedMarketplaceEntry {
  return {
    name,
    source: `./${name}`,
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.categories ? { dorkos: { categories: opts.categories } } : {}),
  } as MergedMarketplaceEntry;
}

function categoryUrls(entries: { url: string }[]): string[] {
  return entries
    .map((e) => e.url)
    .filter((url) => url.startsWith(`${BASE}/marketplace/category/`))
    .map((url) => url.slice(`${BASE}/marketplace/category/`.length));
}

describe('marketplaceSitemapEntries', () => {
  // An empty category page is thin content for search engines, so only
  // categories that hold at least one package are listed.
  it('lists only categories that have at least one package', () => {
    const entries = marketplaceSitemapEntries(BASE, [
      entry('flow', { categories: ['agent-ops', 'project-management'] }),
      entry('writing-pack', { categories: ['documentation'] }),
    ]);
    expect(categoryUrls(entries).sort()).toEqual(
      ['agent-ops', 'documentation', 'project-management'].sort()
    );
  });

  // A package that predates the sidecar counts through its singular category,
  // the same membership rule the category page itself uses.
  it('counts a legacy singular-category package', () => {
    const entries = marketplaceSitemapEntries(BASE, [entry('legacy', { category: 'security' })]);
    expect(categoryUrls(entries)).toEqual(['security']);
  });

  // A category slug outside the closed vocabulary never becomes a URL.
  it('ignores categories outside the controlled vocabulary', () => {
    const entries = marketplaceSitemapEntries(BASE, [
      entry('odd', { categories: ['not-a-real-category'] }),
    ]);
    expect(categoryUrls(entries)).toEqual([]);
  });

  // When the registry cannot be read, we cannot tell which categories are
  // empty, so every category page stays listed (the previous behaviour).
  it('keeps every category when the registry is unavailable', () => {
    const entries = marketplaceSitemapEntries(BASE, null);
    expect(categoryUrls(entries)).toEqual([...MARKETPLACE_CATEGORIES]);
  });

  it('always lists the browse and privacy pages', () => {
    for (const plugins of [null, []]) {
      const urls = marketplaceSitemapEntries(BASE, plugins).map((e) => e.url);
      expect(urls).toContain(`${BASE}/marketplace`);
      expect(urls).toContain(`${BASE}/marketplace/privacy`);
    }
  });

  it('lists one detail page per package', () => {
    const urls = marketplaceSitemapEntries(BASE, [
      entry('flow', { categories: ['agent-ops'] }),
      entry('safety-hooks', { categories: ['security'] }),
    ]).map((e) => e.url);
    expect(urls).toContain(`${BASE}/marketplace/flow`);
    expect(urls).toContain(`${BASE}/marketplace/safety-hooks`);
  });
});
