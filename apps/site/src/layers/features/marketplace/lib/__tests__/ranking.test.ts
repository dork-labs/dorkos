import { describe, it, expect } from 'vitest';
import type { MergedMarketplaceEntry } from '@dorkos/marketplace';

import { rankPackages } from '../ranking';

/** Build a minimal merged entry carrying only the fields ranking reads. */
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

describe('rankPackages — category membership filter', () => {
  // A package matches when its sidecar categories[] includes the wanted slug,
  // even when it is not the primary (multi-membership).
  it('matches a package whose sidecar categories[] includes the slug', () => {
    const packages = [
      entry('multi', { categories: ['code-review', 'security'] }),
      entry('other', { categories: ['documentation'] }),
    ];
    const ranked = rankPackages(packages, {}, { category: 'security' });
    expect(ranked.map((p) => p.name)).toEqual(['multi']);
  });

  // Legacy packages without a sidecar fall back to the singular category.
  it('matches a legacy singular-category package via the fallback', () => {
    const packages = [
      entry('legacy', { category: 'security' }),
      entry('other', { categories: ['documentation'] }),
    ];
    const ranked = rankPackages(packages, {}, { category: 'security' });
    expect(ranked.map((p) => p.name)).toEqual(['legacy']);
  });

  // Non-members are excluded.
  it('excludes non-members', () => {
    const packages = [entry('a', { categories: ['documentation'] })];
    const ranked = rankPackages(packages, {}, { category: 'security' });
    expect(ranked).toHaveLength(0);
  });

  // No category filter returns everything.
  it('returns all packages when no category filter is set', () => {
    const packages = [
      entry('a', { categories: ['security'] }),
      entry('b', { category: 'documentation' }),
    ];
    const ranked = rankPackages(packages, {}, {});
    expect(ranked).toHaveLength(2);
  });
});
