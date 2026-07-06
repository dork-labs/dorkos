import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  features,
  PRODUCT_LABELS,
  CATEGORY_LABELS,
  LOOP_SURFACES,
  type FeatureProduct,
} from '../features';

/** A single capture entry from the seeded product manifest. */
interface ManifestAsset {
  file: string;
  surface: string;
  theme: string;
  kind: string;
  width: number;
  height: number;
}

/** Depth from this test's directory up to the monorepo root (where `docs/` lives). */
const ROOT_DEPTH = 8;
const DOCS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../'.repeat(ROOT_DEPTH),
  'docs'
);
const DOCS_URL_PREFIX = '/docs/';

/** Depth from this test's directory up to `apps/site` (where `public/` lives). */
const SITE_DEPTH = 6;
const PRODUCT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../'.repeat(SITE_DEPTH),
  'public/product'
);

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

  it('features the intended six: Mobile Cockpit is in, Tool Approval is out', () => {
    const featured = features.filter((f) => f.featured).map((f) => f.slug);
    expect(featured).toHaveLength(6);
    expect(featured).toContain('mobile');
    expect(featured).not.toContain('tool-approval');
  });

  it('covers every product tab', () => {
    const products = new Set(features.map((f) => f.product));
    const allProducts = Object.keys(PRODUCT_LABELS) as FeatureProduct[];
    for (const prod of allProducts) {
      expect(products.has(prod), `no feature for product "${prod}"`).toBe(true);
    }
  });

  it('all categories have valid labels', () => {
    for (const feature of features) {
      expect(CATEGORY_LABELS[feature.category]).toBeDefined();
    }
  });

  it('every media item has alt text', () => {
    for (const feature of features) {
      if (feature.media) {
        expect(feature.media.alt, `${feature.slug} media has no alt text`).toBeTruthy();
      }
    }
  });

  it('only loop-capable surfaces set loop: true', () => {
    for (const feature of features) {
      if (feature.media?.loop) {
        expect(
          (LOOP_SURFACES as readonly string[]).includes(feature.media.surface),
          `${feature.slug} sets loop on non-loop surface "${feature.media.surface}"`
        ).toBe(true);
      }
    }
  });

  it('every media path resolves to a real file in public/product', () => {
    for (const feature of features) {
      const media = feature.media;
      if (!media) continue;
      // The light still is always required (cards + non-loop heroes use it).
      expect(
        existsSync(path.join(PRODUCT_ROOT, `${media.surface}-light.png`)),
        `${feature.slug} → ${media.surface}-light.png is missing`
      ).toBe(true);
      // Loops additionally need the dark webm and its dark still poster.
      if (media.loop) {
        expect(
          existsSync(path.join(PRODUCT_ROOT, `${media.surface}-dark.webm`)),
          `${feature.slug} → ${media.surface}-dark.webm is missing`
        ).toBe(true);
        expect(
          existsSync(path.join(PRODUCT_ROOT, `${media.surface}-dark.png`)),
          `${feature.slug} → ${media.surface}-dark.png is missing`
        ).toBe(true);
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

  it('every loop surface ships a webm, a dark poster, and a light still', () => {
    for (const surface of LOOP_SURFACES) {
      expect(
        existsSync(path.join(PRODUCT_ROOT, `${surface}-dark.webm`)),
        `${surface}-dark.webm is missing`
      ).toBe(true);
      expect(
        existsSync(path.join(PRODUCT_ROOT, `${surface}-dark.png`)),
        `${surface}-dark.png is missing`
      ).toBe(true);
      expect(
        existsSync(path.join(PRODUCT_ROOT, `${surface}-light.png`)),
        `${surface}-light.png is missing`
      ).toBe(true);
    }
  });

  it('phone frames use portrait captures and desktop frames use landscape', () => {
    const manifest = JSON.parse(readFileSync(path.join(PRODUCT_ROOT, 'manifest.json'), 'utf8')) as {
      assets: ManifestAsset[];
    };
    const stillDims = (surface: string) =>
      manifest.assets.find((a) => a.file === `${surface}-light.png`);

    for (const feature of features) {
      const media = feature.media;
      if (!media) continue;
      const dims = stillDims(media.surface);
      expect(dims, `${media.surface}-light.png missing from manifest`).toBeTruthy();
      if (!dims) continue;
      const isPortrait = dims.height > dims.width;
      if (media.frame === 'phone') {
        expect(isPortrait, `${feature.slug} phone frame needs a portrait capture`).toBe(true);
      } else {
        expect(isPortrait, `${feature.slug} desktop frame needs a landscape capture`).toBe(false);
      }
    }
  });
});
