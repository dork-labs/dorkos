import { describe, it, expect } from 'vitest';
import {
  MARKETPLACE_CATEGORIES,
  MarketplaceCategorySchema,
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  primaryCategory,
  asMarketplaceCategory,
} from '../categories.js';

describe('MARKETPLACE_CATEGORIES vocabulary', () => {
  // Runtime backstop for the compile-time `Record<MarketplaceCategory, string>`:
  // a missing/misspelled label key is a TS error, but this catches drift that
  // slips past the type (e.g. an extra key added to the record).
  it('CATEGORY_LABELS key-set exactly equals the vocabulary', () => {
    expect(new Set(Object.keys(CATEGORY_LABELS))).toEqual(new Set(MARKETPLACE_CATEGORIES));
  });

  it('CATEGORY_DESCRIPTIONS key-set exactly equals the vocabulary', () => {
    expect(new Set(Object.keys(CATEGORY_DESCRIPTIONS))).toEqual(new Set(MARKETPLACE_CATEGORIES));
  });

  // The enum schema is the CI-checked binding on categories[]; it must accept
  // every vocabulary slug and reject an off-list one.
  it('MarketplaceCategorySchema accepts every vocabulary slug and rejects off-list', () => {
    for (const slug of MARKETPLACE_CATEGORIES) {
      expect(MarketplaceCategorySchema.safeParse(slug).success, `expected ${slug} to parse`).toBe(
        true
      );
    }
    expect(MarketplaceCategorySchema.safeParse('not-a-cat').success).toBe(false);
  });
});

describe('primaryCategory', () => {
  // categories[0] is the primary and wins over the legacy singular field.
  it('prefers categories[0] over the singular category', () => {
    expect(primaryCategory(['a'], 'b')).toBe('a');
  });

  // Legacy packages that predate categories[] fall back to the singular field.
  it('falls back to the singular category when categories is absent', () => {
    expect(primaryCategory(undefined, 'b')).toBe('b');
  });

  it('falls back to the singular category when categories is empty', () => {
    expect(primaryCategory([], 'b')).toBe('b');
  });

  // Fully uncategorized packages resolve to undefined.
  it('returns undefined when both are absent', () => {
    expect(primaryCategory(undefined, undefined)).toBeUndefined();
  });
});

describe('asMarketplaceCategory', () => {
  // Narrows a known slug to the typed value.
  it('narrows a valid slug', () => {
    expect(asMarketplaceCategory('security')).toBe('security');
  });

  // Rejects anything off the closed list.
  it('returns undefined for an off-list slug', () => {
    expect(asMarketplaceCategory('nope')).toBeUndefined();
  });
});
