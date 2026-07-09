import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { features, LOOP_SURFACES } from '../features';
import { PRODUCT_SHOTS, PRODUCT_SHOT_IDS, getProductShot } from '../shots';

/**
 * Guards that keep the product-media shot registry, the marketing catalog, and
 * docs embeds in lockstep. The pipeline (`apps/e2e/capture`) is the source of
 * truth; it publishes the registry into `manifest.json`, which the site reads.
 * These tests fail loudly on drift — a loop shot missing from `LOOP_SURFACES`, a
 * feature or docs page referencing a shot that does not exist, or a v1 manifest.
 *
 * @module marketing/lib/__tests__/shots
 */

/** Depth from this test's dir up to `apps/site` (where `public/` lives). */
const SITE_DEPTH = 6;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_ROOT = path.resolve(HERE, '../'.repeat(SITE_DEPTH), 'public/product');

/** Depth from this test's dir up to the monorepo root (where `docs/` lives). */
const ROOT_DEPTH = 8;
const DOCS_ROOT = path.resolve(HERE, '../'.repeat(ROOT_DEPTH), 'docs');

/** Registered shots tagged for the marketing surface. */
const marketingShots = PRODUCT_SHOTS.filter((s) => s.consumers.includes('marketing'));

/** Every `<ProductShot id="…" />` usage found across the docs tree. */
function collectDocsShotIds(): { id: string; file: string }[] {
  const usages: { id: string; file: string }[] = [];
  const files = readdirSync(DOCS_ROOT, { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.mdx')
  );
  const pattern = /<ProductShot\b[^>]*\bid=["']([^"']+)["']/g;
  for (const rel of files) {
    const content = readFileSync(path.join(DOCS_ROOT, rel), 'utf8');
    for (const match of content.matchAll(pattern)) {
      usages.push({ id: match[1]!, file: rel });
    }
  }
  return usages;
}

describe('shot registry integrity', () => {
  it('publishes a non-empty registry (manifest v2)', () => {
    expect(PRODUCT_SHOTS.length).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(path.join(PRODUCT_ROOT, 'manifest.json'), 'utf8')) as {
      schemaVersion?: number;
    };
    expect(manifest.schemaVersion).toBe(2);
  });

  it('has unique shot ids', () => {
    expect(new Set(PRODUCT_SHOT_IDS).size).toBe(PRODUCT_SHOT_IDS.length);
  });

  it('tags every marketing manifest asset with a source', () => {
    const manifest = JSON.parse(readFileSync(path.join(PRODUCT_ROOT, 'manifest.json'), 'utf8')) as {
      assets: { file: string; source?: string }[];
    };
    for (const asset of manifest.assets) {
      expect(['auto', 'manual'], `${asset.file} has an invalid source`).toContain(asset.source);
    }
  });
});

describe('marketing catalog ↔ registry consistency', () => {
  it('LOOP_SURFACES exactly matches the registry loop shots', () => {
    const registryLoops = new Set(marketingShots.filter((s) => s.kind === 'loop').map((s) => s.id));
    expect(new Set(LOOP_SURFACES)).toEqual(registryLoops);
  });

  it('every feature media surface is a registered marketing shot', () => {
    const marketingIds = new Set(marketingShots.map((s) => s.id));
    for (const feature of features) {
      if (!feature.media) continue;
      expect(
        marketingIds.has(feature.media.surface),
        `${feature.slug} → "${feature.media.surface}" is not a registered marketing shot`
      ).toBe(true);
    }
  });

  it('every marketing shot ships its light still (and loops ship webm + poster)', () => {
    for (const shot of marketingShots) {
      expect(
        existsSync(path.join(PRODUCT_ROOT, `${shot.id}-light.png`)),
        `${shot.id}-light.png is missing`
      ).toBe(true);
      if (shot.kind === 'loop') {
        expect(
          existsSync(path.join(PRODUCT_ROOT, `${shot.id}-dark.webm`)),
          `${shot.id}-dark.webm is missing`
        ).toBe(true);
        expect(
          existsSync(path.join(PRODUCT_ROOT, `${shot.id}-dark.png`)),
          `${shot.id}-dark.png poster is missing`
        ).toBe(true);
      }
    }
  });
});

describe('docs ProductShot embeds', () => {
  const usages = collectDocsShotIds();

  it('embeds at least one real ProductShot (the proof)', () => {
    expect(usages.length).toBeGreaterThan(0);
  });

  it('every embedded id is a registered shot with its files present', () => {
    for (const { id, file } of usages) {
      const shot = getProductShot(id);
      expect(shot, `${file} embeds <ProductShot id="${id}"> which is not registered`).toBeTruthy();
      if (!shot) continue;
      expect(
        existsSync(path.join(PRODUCT_ROOT, `${id}-light.png`)),
        `${file} → ${id}-light.png is missing`
      ).toBe(true);
      if (shot.kind === 'loop') {
        expect(
          existsSync(path.join(PRODUCT_ROOT, `${id}-dark.webm`)),
          `${file} → ${id}-dark.webm is missing`
        ).toBe(true);
      }
    }
  });
});
