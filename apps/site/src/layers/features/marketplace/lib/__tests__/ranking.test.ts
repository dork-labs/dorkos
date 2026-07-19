import { describe, it, expect } from 'vitest';
import type { MergedMarketplaceEntry } from '@dorkos/marketplace';

import { rankPackages, selectFeatured, type RankedPackage } from '../ranking';

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

/** Build a ranked fixture; the featured flag rides the DorkOS sidecar. */
function ranked(name: string, extra: Record<string, unknown> = {}): RankedPackage {
  return { name, source: `./${name}`, score: 0, ...extra } as RankedPackage;
}

describe('selectFeatured', () => {
  // The DorkOS featured flag lives ONLY on the sidecar. A read of a
  // top-level `featured` field compiles (passthrough schema) but is always
  // undefined at runtime — this test pins the sidecar as the source.
  it('selects a package whose featured flag exists only at dorkos.featured', () => {
    const packages = [
      ranked('featured-shape', { dorkos: { type: 'shape', featured: true } }),
      ranked('plain', { dorkos: { type: 'plugin' } }),
    ];
    expect(selectFeatured(packages).map((p) => p.name)).toEqual(['featured-shape']);
  });

  it('ignores a top-level featured field that is not on the sidecar', () => {
    // The bug shape: `featured` set at the top level (never populated by the
    // registry) must not surface the package.
    const packages = [ranked('imposter', { featured: true })];
    expect(selectFeatured(packages)).toHaveLength(0);
  });

  it('includes featured packages of every type', () => {
    const packages = [
      ranked('an-agent', { dorkos: { type: 'agent', featured: true } }),
      ranked('a-plugin', { dorkos: { type: 'plugin', featured: true } }),
      ranked('a-shape', { dorkos: { type: 'shape', featured: true } }),
    ];
    expect(selectFeatured(packages)).toHaveLength(3);
  });

  it('returns nothing while a type, category, or search filter is active', () => {
    const packages = [ranked('star', { dorkos: { featured: true } })];
    expect(selectFeatured(packages, { type: 'agent' })).toHaveLength(0);
    expect(selectFeatured(packages, { category: 'security' })).toHaveLength(0);
    expect(selectFeatured(packages, { q: 'star' })).toHaveLength(0);
    expect(selectFeatured(packages, {})).toHaveLength(1);
  });
});
