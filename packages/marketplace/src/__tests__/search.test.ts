import { describe, it, expect } from 'vitest';
import { matchesMarketplaceSearch } from '../search.js';

describe('matchesMarketplaceSearch', () => {
  const pkg = {
    name: 'code-reviewer',
    description: 'Reviews pull requests for bugs',
    keywords: ['review', 'linting'],
    tags: ['quality', 'ci'],
  };

  it('matches by name', () => {
    expect(matchesMarketplaceSearch(pkg, 'reviewer')).toBe(true);
  });

  it('matches by description', () => {
    expect(matchesMarketplaceSearch(pkg, 'pull requests')).toBe(true);
  });

  it('matches by keywords', () => {
    expect(matchesMarketplaceSearch(pkg, 'linting')).toBe(true);
  });

  it('matches by tags', () => {
    expect(matchesMarketplaceSearch(pkg, 'quality')).toBe(true);
  });

  it('matches case-insensitively against package fields', () => {
    // Query is already lower-cased per contract; package fields are lowered internally
    expect(matchesMarketplaceSearch({ name: 'FOO-BAR' }, 'foo')).toBe(true);
    expect(matchesMarketplaceSearch({ name: 'test', tags: ['Quality'] }, 'quality')).toBe(true);
  });

  it('returns false when no field matches', () => {
    expect(matchesMarketplaceSearch(pkg, 'deployment')).toBe(false);
  });

  it('handles missing optional fields', () => {
    const minimal = { name: 'minimal-pkg' };
    expect(matchesMarketplaceSearch(minimal, 'minimal')).toBe(true);
    expect(matchesMarketplaceSearch(minimal, 'other')).toBe(false);
  });
});
