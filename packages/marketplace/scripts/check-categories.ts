/**
 * check-categories.ts — pure checks backing the controlled marketplace
 * category vocabulary CI guard (spec §D3).
 *
 * Two checks, both exported as pure/parameterized functions so they can be
 * unit-tested without a filesystem-scanning CLI run:
 *
 * 1. Exhaustiveness ({@link checkVocabulary}) — a label/description record's
 *    key-set exactly equals a vocabulary. This is a runtime backstop for the
 *    compile-time `Record<MarketplaceCategory, string>` typing: a
 *    missing/misspelled key is already a TS error, but an *extra* key or a
 *    drift introduced through a cast slips past the type — this catches it.
 * 2. Fixture coherence ({@link checkFixtures}, {@link validateManifest}) —
 *    every bundled `.dork/manifest.json` package-manifest fixture parses
 *    under a given schema, so an off-list `categories[]` entry or an
 *    incoherent `category`/`categories[0]` pair added to a fixture fails CI.
 *    Intentionally-invalid fixtures (the `broken/` tree and `invalid-*`
 *    packages) are skipped by design.
 *
 * The external registry gate — every `dork-labs/marketplace` package's
 * `categories[]` ∈ the closed list and `category === categories[0]` — runs in
 * THAT repo's CI via the same exported `MarketplaceCategorySchema` (spec §H /
 * task 6.1). This repo cannot validate an external registry at build time.
 *
 * The vitest test `src/__tests__/check-categories.test.ts` invokes these same
 * functions, so `pnpm verify` (which runs the marketplace test task) catches a
 * taxonomy drift or an off-list fixture category too.
 *
 * `validateManifest` and `checkFixtures` take the schema to validate against
 * as a **required** parameter — this module deliberately holds no import,
 * static or dynamic, of `@dorkos/marketplace` itself. A top-level
 * `import { MarketplacePackageManifestSchema } from '@dorkos/marketplace'`
 * (or even an `await import(...)` never actually called) resolves through the
 * package's `exports` map to `dist/index.js` (the `types` condition only
 * steers the type-checker, not the runtime, and Vite's import-analysis
 * statically resolves dynamic-import specifiers too) — either form makes
 * *importing this module at all* fail without a prior
 * `pnpm --filter @dorkos/marketplace build`. `check-categories.test.ts`
 * imports the schema straight from `../manifest-schema.ts` and passes it in
 * explicitly, so `pnpm --filter @dorkos/marketplace test` stays correct — and
 * immune to a stale `dist/` — with no prior build. The CLI entry point that
 * *does* need the built package lives in the sibling `run-check-categories.ts`.
 *
 * @module @dorkos/marketplace/scripts/check-categories
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MarketplacePackageManifestSchema } from '@dorkos/marketplace';

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
export const FIXTURE_ROOTS = [
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
 * @param schema - Schema to validate against — always passed explicitly (see
 *   the module doc comment for why there is no built-in default).
 * @param label - A human-readable source label for error messages.
 * @returns Error strings; empty when the manifest parses.
 */
export function validateManifest(
  raw: unknown,
  schema: typeof MarketplacePackageManifestSchema,
  label = 'manifest'
): string[] {
  const result = schema.safeParse(raw);
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
 * @param schema - Schema to validate against — always passed explicitly (see
 *   the module doc comment for why there is no built-in default).
 * @param roots - Fixture roots to scan (defaults to the bundled roots).
 * @returns Error strings; empty when every scanned fixture parses.
 */
export async function checkFixtures(
  schema: typeof MarketplacePackageManifestSchema,
  roots: string[] = FIXTURE_ROOTS
): Promise<string[]> {
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
      errors.push(...validateManifest(raw, schema, path.relative(REPO_ROOT, manifestPath)));
    }
  }
  return errors;
}
