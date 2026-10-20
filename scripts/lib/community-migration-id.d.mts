/**
 * Types for `community-migration-id.mjs`. See that file for what the id is and who relies on it.
 *
 * @module scripts/lib/community-migration-id
 */

/**
 * The space server's migration compatibility id.
 *
 * @param migrationsDir - The space server's migrations folder.
 * @returns `sha256:` and 64 hex digits.
 */
export function communityMigrationCompatibilityId(migrationsDir: string): string;
