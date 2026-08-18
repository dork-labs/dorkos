import { describe, it, expect } from 'vitest';
import { CONNECTOR_ADAPTER_TYPE } from '@dorkos/marketplace';
import { marketplaceSearchSchema, normalizeFacetParam } from '../model/marketplace-search';

// The schema is wired into the /marketplace route via `zodValidator`, which
// calls `.parse`. These tests exercise that same parse so a stale shared link
// degrades to the default instead of erroring the route.

describe('marketplaceSearchSchema — type facet', () => {
  it('accepts every package type, including shape', () => {
    for (const type of ['all', 'agent', 'plugin', 'skill-pack', 'adapter', 'shape'] as const) {
      expect(marketplaceSearchSchema.parse({ type }).type).toBe(type);
    }
  });

  it('accepts the connector refinement (?type=connector)', () => {
    // Derived from the constant so the sidebar's setType(CONNECTOR_ADAPTER_TYPE)
    // and this URL schema can never drift apart.
    expect(marketplaceSearchSchema.parse({ type: CONNECTOR_ADAPTER_TYPE }).type).toBe(
      CONNECTOR_ADAPTER_TYPE
    );
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
    expect(marketplaceSearchSchema.parse({ sort: 'recent' }).sort).toBe('recent');
  });

  it('drops an unknown sort value rather than throwing', () => {
    // A stale bookmark whose value this release no longer accepts degrades to
    // the default instead of erroring the route.
    expect(() => marketplaceSearchSchema.parse({ sort: 'trending' })).not.toThrow();
    expect(marketplaceSearchSchema.parse({ sort: 'trending' }).sort).toBeUndefined();
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

describe('marketplaceSearchSchema — source facet', () => {
  it('accepts a single source name (?source=claude-plugins-official)', () => {
    expect(marketplaceSearchSchema.parse({ source: 'claude-plugins-official' }).source).toBe(
      'claude-plugins-official'
    );
  });

  it('accepts several source names', () => {
    expect(
      marketplaceSearchSchema.parse({ source: ['dorkos-community', 'my-registry'] }).source
    ).toEqual(['dorkos-community', 'my-registry']);
  });

  it('degrades garbage to undefined rather than throwing', () => {
    expect(() => marketplaceSearchSchema.parse({ source: 42 })).not.toThrow();
    expect(marketplaceSearchSchema.parse({ source: 42 }).source).toBeUndefined();
  });
});

describe('normalizeFacetParam', () => {
  it('wraps a single string in an array', () => {
    expect(normalizeFacetParam('security')).toEqual(['security']);
  });

  it('drops an empty string', () => {
    expect(normalizeFacetParam('')).toEqual([]);
  });

  it('passes an array through, dropping empties and de-duplicating', () => {
    expect(normalizeFacetParam(['security', '', 'security', 'code-review'])).toEqual([
      'security',
      'code-review',
    ]);
  });

  it('filters non-string array entries', () => {
    expect(normalizeFacetParam(['security', 42, null, 'docs'] as unknown[])).toEqual([
      'security',
      'docs',
    ]);
  });

  it('returns an empty array for undefined and non-string/array values', () => {
    expect(normalizeFacetParam(undefined)).toEqual([]);
    expect(normalizeFacetParam(123)).toEqual([]);
    expect(normalizeFacetParam({ junk: true })).toEqual([]);
  });
});
