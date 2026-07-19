import { describe, it, expect } from 'vitest';
import { marketplaceSearchSchema } from '../model/marketplace-search';

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
  });

  it('drops the retired Popular/Recent sorts rather than throwing', () => {
    for (const sort of ['popular', 'recent'] as const) {
      expect(() => marketplaceSearchSchema.parse({ sort })).not.toThrow();
      expect(marketplaceSearchSchema.parse({ sort }).sort).toBeUndefined();
    }
  });
});
