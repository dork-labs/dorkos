/**
 * check-categories.ts — CI guard for the controlled marketplace category
 * vocabulary (spec §D3).
 *
 * Two checks:
 *
 * 1. Exhaustiveness — `CATEGORY_LABELS` and `CATEGORY_DESCRIPTIONS` key-sets
 *    each exactly equal `MARKETPLACE_CATEGORIES`. This is a runtime backstop
 *    for the compile-time `Record<MarketplaceCategory, string>` typing: a
 *    missing/misspelled key is already a TS error, but an *extra* key or a
 *    drift introduced through a cast slips past the type — this catches it.
 * 2. Fixture coherence — every bundled `.dork/manifest.json` package-manifest
 *    fixture parses under `MarketplacePackageManifestSchema`, so an off-list
 *    `categories[]` entry or an incoherent `category`/`categories[0]` pair
 *    added to a fixture fails CI. Intentionally-invalid fixtures (the `broken/`
 *    tree and `invalid-*` packages) are skipped by design.
 *
 * The external registry gate — every `dork-labs/marketplace` package's
 * `categories[]` ∈ the closed list and `category === categories[0]` — runs in
 * THAT repo's CI via the same exported `MarketplaceCategorySchema` (spec §H /
 * task 6.1). This repo cannot validate an external registry at build time.
 *
 * Run directly (exits non-zero on any failure):
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     packages/marketplace/scripts/check-categories.ts
 *
 * The vitest test `src/__tests__/check-categories.test.ts` invokes these same
 * functions, so `pnpm verify` (which runs the marketplace test task) catches a
 * taxonomy drift or an off-list fixture category too.
 *
 * Imports from the built package (`@dorkos/marketplace`, resolved to `dist/`)
 * rather than `../src/*.ts`: Node's type stripping does not remap the `.js`
 * NodeNext specifiers the source modules use internally, so a source import
 * would fail to resolve. Build the package before running the script.
 *
 * @module @dorkos/marketplace/scripts/check-categories
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MARKETPLACE_CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  MarketplacePackageManifestSchema,
} from '@dorkos/marketplace';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

/**
 * Roots scanned for `.dork/manifest.json` package-manifest fixtures. The spec
 * names `packages/marketplace/fixtures/**`, but the on-disk package manifests
 * actually live under `src/__tests__/fixtures/**`; both are scanned so the
 * check is meaningful. `packages/marketplace/fixtures/**` currently holds only
 * registry (`marketplace.json`) fixtures, which are intentionally lenient and
 * out of scope here.
 */
const FIXTURE_ROOTS = [
  path.join(PACKAGE_ROOT, 'fixtures'),
  path.join(PACKAGE_ROOT, 'src', '__tests__', 'fixtures'),
  path.join(REPO_ROOT, 'apps', 'server', 'src', 'services', 'marketplace', 'fixtures'),
];

/**
 * Assert that a label/description record's key-set exactly equals the category
 * vocabulary. Pure and fully parameterized so tests can inject fake drift.
 *
 * @param categories - The canonical vocabulary (the `as const` slug list).
 * @param labels - The label record to check.
 * @param descriptions - The description record to check.
 * @returns Human-readable error strings; empty when both records are exhaustive.
 */
export function checkVocabulary(
  categories: readonly string[],
  labels: Record<string, string>,
  descriptions: Record<string, string>
): string[] {
  const errors: string[] = [];
  const vocab = new Set(categories);

  for (const [name, record] of [
    ['CATEGORY_LABELS', labels],
    ['CATEGORY_DESCRIPTIONS', descriptions],
  ] as const) {
    const keys = new Set(Object.keys(record));
    for (const slug of vocab) {
      if (!keys.has(slug)) errors.push(`${name} is missing an entry for "${slug}"`);
    }
    for (const key of keys) {
      if (!vocab.has(key)) errors.push(`${name} has an off-vocabulary entry "${key}"`);
    }
  }

  return errors;
}

/**
 * Validate a raw manifest object against the marketplace manifest schema.
 * Returns one formatted error string per Zod issue; empty when it parses.
 * Exposed so tests can assert an off-list `categories[]` is rejected without
 * committing a broken fixture.
 *
 * @param raw - The parsed JSON manifest object.
 * @param label - A human-readable source label for error messages.
 * @returns Error strings; empty when the manifest parses.
 */
export function validateManifest(raw: unknown, label = 'manifest'): string[] {
  const result = MarketplacePackageManifestSchema.safeParse(raw);
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => `${label}: ${issue.path.join('.') || '<root>'}: ${issue.message}`
  );
}

/**
 * Whether a fixture manifest is intentionally schema-invalid and must be
 * skipped: the repo's convention marks these with a `broken/` path segment or
 * an `invalid`-prefixed package directory name.
 */
function isIntentionallyInvalid(manifestPath: string): boolean {
  const segments = manifestPath.split(path.sep);
  if (segments.includes('broken')) return true;
  // package dir = the directory that contains `.dork/manifest.json`.
  const packageDir = path.basename(path.dirname(path.dirname(manifestPath)));
  return packageDir.startsWith('invalid');
}

/**
 * Recursively collect every `<pkg>/.dork/manifest.json` under a root. Missing
 * roots yield an empty list.
 */
async function findFixtureManifests(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root, { recursive: true });
  } catch {
    return [];
  }
  const suffix = path.join('.dork', 'manifest.json');
  return entries
    .filter((rel) => rel.endsWith(suffix))
    .map((rel) => path.join(root, rel))
    .filter((abs) => !isIntentionallyInvalid(abs));
}

/**
 * Parse and schema-validate every bundled package-manifest fixture. Returns one
 * error string per parse/schema failure; empty when all valid fixtures pass.
 *
 * @param roots - Fixture roots to scan (defaults to the bundled roots).
 * @returns Error strings; empty when every scanned fixture parses.
 */
export async function checkFixtures(roots: string[] = FIXTURE_ROOTS): Promise<string[]> {
  const errors: string[] = [];
  for (const root of roots) {
    for (const manifestPath of await findFixtureManifests(root)) {
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      } catch (err) {
        errors.push(
          `${path.relative(REPO_ROOT, manifestPath)}: invalid JSON — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        continue;
      }
      errors.push(...validateManifest(raw, path.relative(REPO_ROOT, manifestPath)));
    }
  }
  return errors;
}

/**
 * Run both checks against the shipped vocabulary and bundled fixtures.
 *
 * @returns All error strings; empty when everything is coherent.
 */
export async function runChecks(): Promise<string[]> {
  return [
    ...checkVocabulary(MARKETPLACE_CATEGORIES, CATEGORY_LABELS, CATEGORY_DESCRIPTIONS),
    ...(await checkFixtures()),
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
