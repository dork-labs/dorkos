/**
 * The marketplace catalog's two filter vocabularies, as analytics may record
 * them (DOR-4992). A filter arrives in the page URL, where a person can type
 * anything, so analytics keeps a value only when it names a real package type
 * or catalog category. Read through narrow subpaths so the send hook, which
 * loads on every page, does not pull in the whole marketplace package.
 *
 * @module lib/telemetry/marketplace-filters
 */
import { MARKETPLACE_CATEGORIES } from '@dorkos/marketplace/categories';
import { PackageTypeSchema } from '@dorkos/marketplace/package-types';

const KNOWN_TYPES: ReadonlySet<string> = new Set(PackageTypeSchema.options);
const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(MARKETPLACE_CATEGORIES);

/**
 * Whether a value names a real marketplace package type, like `plugin`.
 *
 * @param value - The value from the page URL.
 */
export function isKnownPackageType(value: string): boolean {
  return KNOWN_TYPES.has(value);
}

/**
 * Whether a value names a real marketplace catalog category, like `security`.
 *
 * @param value - The value from the page URL.
 */
export function isKnownCategory(value: string): boolean {
  return KNOWN_CATEGORIES.has(value);
}
