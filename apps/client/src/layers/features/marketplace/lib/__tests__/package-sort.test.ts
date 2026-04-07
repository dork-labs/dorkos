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
});

// ---------------------------------------------------------------------------
// Popular sort (falls back to name)
// ---------------------------------------------------------------------------

describe('sortPackages — popular', () => {
  it('falls back to alphabetical order (installCount not present on AggregatedPackage)', () => {
    const result = sortPackages(PACKAGES, 'popular');
    expect(result.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  it('does not mutate the input array', () => {
    const input = [...PACKAGES];
    sortPackages(input, 'popular');
    expect(input[0].name).toBe('charlie');
  });
});

// ---------------------------------------------------------------------------
// Recent sort (falls back to name)
// ---------------------------------------------------------------------------

describe('sortPackages — recent', () => {
  it('falls back to alphabetical order (updatedAt not present on AggregatedPackage)', () => {
    const result = sortPackages(PACKAGES, 'recent');
    expect(result.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  it('does not mutate the input array', () => {
    const input = [...PACKAGES];
    sortPackages(input, 'recent');
    expect(input[0].name).toBe('charlie');
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
