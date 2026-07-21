/**
 * run-check-categories.ts — CLI entry point for the controlled marketplace
 * category vocabulary CI guard (spec §D3).
 *
 * Thin wrapper around the pure checks in `./check-categories.ts`: imports the
 * built `@dorkos/marketplace` package (`MARKETPLACE_CATEGORIES`,
 * `CATEGORY_LABELS`, `CATEGORY_DESCRIPTIONS`, `MarketplacePackageManifestSchema`)
 * and feeds them to {@link checkVocabulary} and {@link checkFixtures}. Kept
 * separate from `check-categories.ts` deliberately: that module holds the
 * pure, unit-tested logic and must stay import-free of `@dorkos/marketplace`
 * so `check-categories.test.ts` never needs a built `dist/` (see its module
 * doc comment). This file is the one place allowed to depend on the build.
 *
 * Run directly (exits non-zero on any failure; build the package first):
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     packages/marketplace/scripts/run-check-categories.ts
 *
 * A source import (`../src/manifest-schema.ts`) is not an option here: Node's
 * type stripping does not remap the `.js` NodeNext specifiers the source
 * modules use internally to reach their sibling `.ts` files, so loading
 * `manifest-schema.ts` standalone fails to resolve `./categories.js` et al.
 * The sibling import below uses an explicit `.ts` extension for the same
 * reason — Node's type stripping resolves `.ts`-extension specifiers as-is,
 * but does not fall back to `.ts` for a `.js` specifier that has no matching
 * `.js` file on disk. `scripts/tsconfig.json` sets `allowImportingTsExtensions`
 * so this typechecks.
 *
 * @module @dorkos/marketplace/scripts/run-check-categories
 */

import { pathToFileURL } from 'node:url';
import {
  MARKETPLACE_CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  MarketplacePackageManifestSchema,
} from '@dorkos/marketplace';
import { checkVocabulary, checkFixtures } from './check-categories.ts';

/**
 * Run both checks against the shipped vocabulary and bundled fixtures.
 *
 * @returns All error strings; empty when everything is coherent.
 */
async function runChecks(): Promise<string[]> {
  return [
    ...checkVocabulary(MARKETPLACE_CATEGORIES, CATEGORY_LABELS, CATEGORY_DESCRIPTIONS),
    ...(await checkFixtures(MarketplacePackageManifestSchema)),
  ];
}

// Run as a CLI: report every failure and exit non-zero on any.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const errors = await runChecks();
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error(`\ncheck-categories: ${errors.length} problem(s) found.`);
    process.exit(1);
  }
  console.log('✓ check-categories: vocabulary exhaustive and all fixtures coherent.');
}
