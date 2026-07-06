import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { features, PRODUCT_LABELS, CATEGORY_LABELS, type FeatureProduct } from '../features';

/** Depth from this test's directory up to the monorepo root (where `docs/` lives). */
const ROOT_DEPTH = 8;
const DOCS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../'.repeat(ROOT_DEPTH),
  'docs'
);
const DOCS_URL_PREFIX = '/docs/';

/** Resolve a `/docs/...` URL to its backing MDX file, accepting leaf or index pages. */
function docsFileExists(docsUrl: string): boolean {
  const rel = docsUrl.slice(DOCS_URL_PREFIX.length);
  return (
    existsSync(path.join(DOCS_ROOT, `${rel}.mdx`)) ||
    existsSync(path.join(DOCS_ROOT, rel, 'index.mdx'))
  );
}

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

  it('covers all 5 products', () => {
    const products = new Set(features.map((f) => f.product));
    const allProducts = Object.keys(PRODUCT_LABELS) as FeatureProduct[];
    for (const prod of allProducts) {
      expect(products.has(prod)).toBe(true);
    }
  });

  it('all categories have valid labels', () => {
    for (const feature of features) {
      expect(CATEGORY_LABELS[feature.category]).toBeDefined();
    }
  });

  it('media items with screenshot have alt text', () => {
    for (const feature of features) {
      if (feature.media?.screenshot) {
        expect(feature.media.alt).toBeTruthy();
      }
    }
  });

  it('every docsUrl points at an existing docs page (no 404s)', () => {
    for (const feature of features) {
      if (!feature.docsUrl) continue;
      expect(feature.docsUrl.startsWith(DOCS_URL_PREFIX)).toBe(true);
      expect(
        docsFileExists(feature.docsUrl),
        `${feature.slug} → ${feature.docsUrl} has no backing MDX file`
      ).toBe(true);
    }
  });
});
