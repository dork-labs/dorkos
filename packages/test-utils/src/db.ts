import { createDb, createDbFromImage, runMigrations } from '@dorkos/db';
import type { Db } from '@dorkos/db';

/**
 * The migrated template, serialized. Built once per module instance (one per
 * test file under vitest's isolation) through the same `createDb` +
 * `runMigrations` path every database takes, then only ever copied.
 */
let templateImage: Buffer | undefined;

/** Migrate the template on first use and return its bytes. */
function migratedTemplateImage(): Buffer {
  if (!templateImage) {
    const template = createDb(':memory:');
    runMigrations(template);
    templateImage = template.$client.serialize();
    template.$client.close();
  }
  return templateImage;
}

/**
 * Creates a fresh in-memory database with all migrations applied.
 * Use in beforeEach() blocks for isolated test databases.
 *
 * Each call returns an independent copy of a template migrated once, not a new
 * migration replay (~0.2–0.4 s per call saved). The copy is opened through
 * `createDbFromImage`, so it carries the same per-connection pragmas
 * (`foreign_keys`, `recursive_triggers`, `secure_delete`, ...) as `createDb`;
 * `__tests__/db.test.ts` pins that against a database built the old way.
 */
export function createTestDb(): Db {
  return createDbFromImage(migratedTemplateImage());
}
