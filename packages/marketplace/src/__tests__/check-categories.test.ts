import { describe, it, expect } from 'vitest';
import { MARKETPLACE_CATEGORIES, CATEGORY_LABELS, CATEGORY_DESCRIPTIONS } from '../categories.js';
import { MarketplacePackageManifestSchema } from '../manifest-schema.js';
import {
  checkVocabulary,
  checkFixtures,
  validateManifest,
} from '../../scripts/check-categories.js';

// `validateManifest`/`checkFixtures` require a schema argument — always the
// source-imported schema here, never the script's dynamic `@dorkos/marketplace`
// import (used only by its CLI-only `runChecks()`) — so
// `pnpm --filter @dorkos/marketplace test` stays correct with no prior build.
// See the module doc comment atop `scripts/check-categories.ts`.

describe('checkVocabulary', () => {
  // The shipped vocabulary + records must be exhaustive (the CI guarantee).
  it('returns clean for the shipped vocabulary', () => {
    expect(checkVocabulary(MARKETPLACE_CATEGORIES, CATEGORY_LABELS, CATEGORY_DESCRIPTIONS)).toEqual(
      []
    );
  });

  // Injected drift: a label record missing a vocabulary key is detected.
  it('detects a missing label key', () => {
    const { security: _dropped, ...missingLabels } = CATEGORY_LABELS;
    const errors = checkVocabulary(MARKETPLACE_CATEGORIES, missingLabels, CATEGORY_DESCRIPTIONS);
    expect(errors.some((e) => e.includes('CATEGORY_LABELS') && e.includes('security'))).toBe(true);
  });

  // Injected drift: an extra off-vocabulary key is detected (the case the
  // compile-time Record type cannot catch).
  it('detects an extra off-vocabulary description key', () => {
    const extraDescriptions = { ...CATEGORY_DESCRIPTIONS, 'not-a-cat': 'nope' };
    const errors = checkVocabulary(MARKETPLACE_CATEGORIES, CATEGORY_LABELS, extraDescriptions);
    expect(errors.some((e) => e.includes('CATEGORY_DESCRIPTIONS') && e.includes('not-a-cat'))).toBe(
      true
    );
  });
});

describe('validateManifest', () => {
  const base = {
    schemaVersion: 1,
    name: 'a-package',
    version: '1.0.0',
    type: 'agent',
    description: 'A package',
    tags: [],
    layers: [],
  };

  // An off-list categories[] entry is exactly what a drifted fixture would
  // carry — the fixture check must reject it.
  it('rejects an off-list categories[] entry', () => {
    expect(
      validateManifest({ ...base, categories: ['not-a-cat'] }, MarketplacePackageManifestSchema)
    ).not.toEqual([]);
  });

  // A legacy free-string singular-only category still parses (the harness
  // regression guard is upheld by the fixture check too).
  it('accepts a legacy free-string singular-only category', () => {
    expect(
      validateManifest({ ...base, category: 'workflow' }, MarketplacePackageManifestSchema)
    ).toEqual([]);
  });
});

describe('checkFixtures', () => {
  // Every bundled (valid) fixture manifest parses under the updated schema.
  it('returns clean for the shipped fixtures', async () => {
    expect(await checkFixtures(MarketplacePackageManifestSchema)).toEqual([]);
  });
});
