import { describe, it, expect } from 'vitest';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { sortPackages } from '../package-sort';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pkg(overrides: Partial<AggregatedPackage> & { name: string }): AggregatedPackage {
  return {
    source: 'https://github.com/example/pkg',
    marketplace: 'official',
    ...overrides,
  };
}

const CHARLIE = pkg({ name: 'charlie', featured: false });
const ALPHA = pkg({ name: 'alpha', featured: true });
const BRAVO = pkg({ name: 'bravo', featured: true });
const DELTA = pkg({ name: 'delta', featured: false });

const PACKAGES = [CHARLIE, ALPHA, DELTA, BRAVO];

// ---------------------------------------------------------------------------
// Featured sort
// ---------------------------------------------------------------------------

describe('sortPackages — featured', () => {
  it('places featured packages before non-featured packages', () => {
    const result = sortPackages(PACKAGES, 'featured');
    const featuredNames = result.filter((p) => p.featured).map((p) => p.name);
    const nonFeaturedNames = result.filter((p) => !p.featured).map((p) => p.name);
    // All featured entries appear at the head of the array; every entry before
    // the first non-featured entry must itself be featured.
    const firstNonFeaturedIdx = result.findIndex((p) => !p.featured);
    const allBeforeAreFeatured = result.slice(0, firstNonFeaturedIdx).every((p) => !!p.featured);
    expect(allBeforeAreFeatured).toBe(true);
    expect(featuredNames).toEqual(['alpha', 'bravo']);
    expect(nonFeaturedNames).toEqual(['charlie', 'delta']);
  });

  it('sorts featured packages alphabetically within the featured group', () => {
    const result = sortPackages(PACKAGES, 'featured');
    const featuredNames = result.filter((p) => p.featured).map((p) => p.name);
    expect(featuredNames).toEqual(['alpha', 'bravo']);
  });

  it('sorts non-featured packages alphabetically within the non-featured group', () => {
    const result = sortPackages(PACKAGES, 'featured');
    const nonFeaturedNames = result.filter((p) => !p.featured).map((p) => p.name);
    expect(nonFeaturedNames).toEqual(['charlie', 'delta']);
  });

  it('treats packages with no featured field as non-featured', () => {
    const unfeatured = pkg({ name: 'unfeatured' }); // featured is undefined
    const featured = pkg({ name: 'featured-pkg', featured: true });
    const result = sortPackages([unfeatured, featured], 'featured');
    expect(result[0].name).toBe('featured-pkg');
    expect(result[1].name).toBe('unfeatured');
  });

  it('does not mutate the input array', () => {
    const input = [...PACKAGES];
    sortPackages(input, 'featured');
    expect(input[0].name).toBe('charlie');
  });
});

// ---------------------------------------------------------------------------
// Name sort
// ---------------------------------------------------------------------------

describe('sortPackages — name', () => {
  it('sorts alphabetically by name', () => {
    const result = sortPackages(PACKAGES, 'name');
    expect(result.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  it('returns empty array for empty input', () => {
    expect(sortPackages([], 'name')).toHaveLength(0);
  });

  it('handles a single package', () => {
    const result = sortPackages([ALPHA], 'name');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('alpha');
  });

  it('orders by the displayed label, not the raw slug, when a displayName diverges', () => {
    // Slug order would be apple-tool < zzz-tool; label order is Apple < Zebra,
    // which flips them. The sort must match what the card shows.
    const appleLabel = pkg({ name: 'zzz-tool', displayName: 'Apple' });
    const zebraLabel = pkg({ name: 'apple-tool', displayName: 'Zebra' });

    const result = sortPackages([zebraLabel, appleLabel], 'name');

    expect(result.map((p) => p.name)).toEqual(['zzz-tool', 'apple-tool']);
    expect(result.map((p) => p.displayName)).toEqual(['Apple', 'Zebra']);
  });

  it('sorts a scoped package by its humanized label, not the leading "@"', () => {
    // Raw-slug order puts '@dorkos/zebra' first (the '@' sorts before 'a'); the
    // humanized labels are Zebra vs Apple, so "Apple" must lead.
    const scopedZebra = pkg({ name: '@dorkos/zebra' }); // humanizes to "Zebra"
    const bareApple = pkg({ name: 'apple' }); // humanizes to "Apple"

    const result = sortPackages([scopedZebra, bareApple], 'name');

    expect(result.map((p) => p.name)).toEqual(['apple', '@dorkos/zebra']);
  });
});

// ---------------------------------------------------------------------------
// Popular sort
// ---------------------------------------------------------------------------

describe('sortPackages — popular', () => {
  it('orders by install count, most-installed first', () => {
    const low = pkg({ name: 'low', installCount: 3 });
    const high = pkg({ name: 'high', installCount: 99 });
    const mid = pkg({ name: 'mid', installCount: 40 });

    const result = sortPackages([low, high, mid], 'popular');

    expect(result.map((p) => p.name)).toEqual(['high', 'mid', 'low']);
  });

  it('breaks install-count ties by displayed label', () => {
    const zebra = pkg({ name: 'zebra', installCount: 10 });
    const apple = pkg({ name: 'apple', installCount: 10 });

    const result = sortPackages([zebra, apple], 'popular');

    expect(result.map((p) => p.name)).toEqual(['apple', 'zebra']);
  });

  it('treats a missing install count as zero (sorts last, then by name)', () => {
    const counted = pkg({ name: 'counted', installCount: 5 });
    const uncountedB = pkg({ name: 'bravo' });
    const uncountedA = pkg({ name: 'alpha' });

    const result = sortPackages([uncountedB, counted, uncountedA], 'popular');

    expect(result.map((p) => p.name)).toEqual(['counted', 'alpha', 'bravo']);
  });

  it('falls back to name order when no package has a count (offline degrade)', () => {
    // Every installCount undefined → equivalent to A–Z, so a stale ?sort=popular
    // link stays well-behaved even though the menu hides the option offline.
    const result = sortPackages(PACKAGES, 'popular');
    expect(result.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  it('does not mutate the input array', () => {
    const input = [pkg({ name: 'x', installCount: 1 }), pkg({ name: 'y', installCount: 9 })];
    const first = input[0].name;
    sortPackages(input, 'popular');
    expect(input[0].name).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

describe('sortPackages — general', () => {
  it('returns a new array (does not return the same reference)', () => {
    const input = [ALPHA];
    const result = sortPackages(input, 'name');
    expect(result).not.toBe(input);
  });
});
