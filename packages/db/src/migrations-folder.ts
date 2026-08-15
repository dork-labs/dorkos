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
 */
export const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../drizzle'
);
