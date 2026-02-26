import { createDb, runMigrations } from '@dorkos/db';
import type { Db } from '@dorkos/db';

/**
 * Creates a fresh in-memory database with all migrations applied.
 * Use in beforeEach() blocks for isolated test databases.
 */
export function createTestDb(): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}
