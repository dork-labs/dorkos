/**
 * Build the site's CURRENT schema in a test database.
 *
 * The frozen `drizzle/` history stops at the schema split; everything since
 * lives in the public and control-plane histories. A test that needs the schema
 * production runs today applies those two, in the order `pnpm db:migrate` does,
 * on a fresh database — never the frozen folder alone, which would quietly
 * leave the test on the pre-split schema (DOR-2036: `account.issuer` still
 * NOT NULL there, so every Better Auth sign-up failed).
 *
 * @module db/__tests__/migrate-current-schema
 */
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import { MIGRATION_HISTORIES } from '../../../scripts/migration-histories';

/**
 * Apply every current migration history to a fresh PGlite database.
 *
 * @param db - A drizzle handle over an empty PGlite database.
 */
export async function migrateCurrentSchema<TSchema extends Record<string, unknown>>(
  db: PgliteDatabase<TSchema>
): Promise<void> {
  for (const history of MIGRATION_HISTORIES) {
    await migrate(db, {
      migrationsFolder: history.folder,
      migrationsTable: history.migrationsTable,
      migrationsSchema: history.migrationsSchema,
    });
  }
}
