import { describe, it, expect } from 'vitest';
import { features, CATEGORY_LABELS, type FeatureCategory } from '../features';

describe('features catalog data integrity', () => {
  it('all slugs are unique', () => {
    const slugs = features.map((f) => f.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('all relatedFeatures references resolve to valid slugs', () => {
    const allSlugs = new Set(features.map((f) => f.slug));
    for (const feature of features) {
      for (const ref of feature.relatedFeatures ?? []) {
        expect(allSlugs.has(ref)).toBe(true);
      }
    }
  });

  it('all taglines are ≤80 chars', () => {
    for (const feature of features) {
      expect(feature.tagline.length).toBeLessThanOrEqual(80);
    }
  });

  it('all descriptions are 120-160 chars', () => {
    for (const feature of features) {
      expect(feature.description.length).toBeGreaterThanOrEqual(120);
      expect(feature.description.length).toBeLessThanOrEqual(160);
    }
  });

  it('each feature has 3-5 benefits', () => {
    for (const feature of features) {
      expect(feature.benefits.length).toBeGreaterThanOrEqual(3);
      expect(feature.benefits.length).toBeLessThanOrEqual(5);
    }
  });

  it('featured features count is ≤6', () => {
    const featuredCount = features.filter((f) => f.featured).length;
    expect(featuredCount).toBeLessThanOrEqual(6);
  });

  it('covers all 5 categories', () => {
    const categories = new Set(features.map((f) => f.category));
    const allCategories = Object.keys(CATEGORY_LABELS) as FeatureCategory[];
    for (const cat of allCategories) {
      expect(categories.has(cat)).toBe(true);
    }
  });

  it('media items with screenshot have alt text', () => {
    for (const feature of features) {
      if (feature.media?.screenshot) {
        expect(feature.media.alt).toBeTruthy();
      }
    }
  });
});
