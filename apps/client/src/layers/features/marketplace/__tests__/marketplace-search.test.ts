import { describe, it, expect } from 'vitest';
import { marketplaceSearchSchema, normalizeCategoryParam } from '../model/marketplace-search';

// The schema is wired into the /marketplace route via `zodValidator`, which
// calls `.parse`. These tests exercise that same parse so a stale shared link
// degrades to the default instead of erroring the route.

describe('marketplaceSearchSchema — type facet', () => {
  it('accepts every package type, including shape', () => {
    for (const type of ['all', 'agent', 'plugin', 'skill-pack', 'adapter', 'shape'] as const) {
      expect(marketplaceSearchSchema.parse({ type }).type).toBe(type);
    }
  });

  it('drops an unknown type rather than throwing (stale-link fallback)', () => {
    expect(() => marketplaceSearchSchema.parse({ type: 'bogus' })).not.toThrow();
    expect(marketplaceSearchSchema.parse({ type: 'bogus' }).type).toBeUndefined();
  });
});

describe('marketplaceSearchSchema — sort facet', () => {
  it('keeps the supported sorts', () => {
    expect(marketplaceSearchSchema.parse({ sort: 'featured' }).sort).toBe('featured');
    expect(marketplaceSearchSchema.parse({ sort: 'name' }).sort).toBe('name');
    expect(marketplaceSearchSchema.parse({ sort: 'popular' }).sort).toBe('popular');
  });

  it('drops the retired Recent sort rather than throwing', () => {
    expect(() => marketplaceSearchSchema.parse({ sort: 'recent' })).not.toThrow();
    expect(marketplaceSearchSchema.parse({ sort: 'recent' }).sort).toBeUndefined();
  });
});

describe('marketplaceSearchSchema — category facet (single + multi migration)', () => {
  it('accepts the legacy single-value form (?category=security)', () => {
    // Old shared links written before the facet went multi-select stay valid.
    expect(marketplaceSearchSchema.parse({ category: 'security' }).category).toBe('security');
  });

  it('accepts the new array form (?category=["security","code-review"])', () => {
    expect(
      marketplaceSearchSchema.parse({ category: ['security', 'code-review'] }).category
    ).toEqual(['security', 'code-review']);
  });

  it('degrades garbage to undefined rather than throwing', () => {
    // A hand-edited or corrupt link — a number, an object — must not error the route.
    expect(() => marketplaceSearchSchema.parse({ category: 123 })).not.toThrow();
    expect(marketplaceSearchSchema.parse({ category: 123 }).category).toBeUndefined();
    expect(() => marketplaceSearchSchema.parse({ category: { junk: true } })).not.toThrow();
    expect(marketplaceSearchSchema.parse({ category: { junk: true } }).category).toBeUndefined();
  });
});

describe('normalizeCategoryParam', () => {
  it('wraps a single string in an array', () => {
    expect(normalizeCategoryParam('security')).toEqual(['security']);
  });

  it('drops an empty string', () => {
    expect(normalizeCategoryParam('')).toEqual([]);
  });

  it('passes an array through, dropping empties and de-duplicating', () => {
    expect(normalizeCategoryParam(['security', '', 'security', 'code-review'])).toEqual([
      'security',
      'code-review',
    ]);
  });

  it('filters non-string array entries', () => {
    expect(normalizeCategoryParam(['security', 42, null, 'docs'] as unknown[])).toEqual([
      'security',
      'docs',
    ]);
  });

  it('returns an empty array for undefined and non-string/array values', () => {
    expect(normalizeCategoryParam(undefined)).toEqual([]);
    expect(normalizeCategoryParam(123)).toEqual([]);
    expect(normalizeCategoryParam({ junk: true })).toEqual([]);
  });
});
