/**
 * Where the generated Drizzle migrations live on disk.
 *
 * Its own module because two things need it and neither should own it: the
 * migrator in `index.ts` reads the `.sql` files, and `backup.ts` reads the same
 * folder's `meta/_journal.json` to work out which migrations a database has yet
 * to apply. Importing it from either of those would make the two modules
 * circular at runtime.
 *
 * @module migrations-folder
 */
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Absolute path to `packages/db/drizzle`, resolved relative to this file so it
 * works in dev (TypeScript sources) and inside the bundled CLI alike.
 *
 * Resolved lazily so importing `@dorkos/db` does not inspect a migration path
 * until a caller actually runs migrations or checks their status.
 *
 * @returns Absolute path to the migrations folder.
 */
export function migrationsFolder(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
}
