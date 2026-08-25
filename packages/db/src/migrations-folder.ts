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
 * **A function rather than a constant, and the reason is a host that does not
 * migrate.** `import.meta.url` is not always a `file:` URL: a bundler that
 * targets a browser-like host rewrites it, and Obsidian's Electron renderer
 * hands back `app://obsidian.md/main.js`, which `fileURLToPath` refuses. As a
 * module-level constant that refusal happened at IMPORT time, so merely pulling
 * `@dorkos/db` into the Obsidian bundle threw before any code ran — a plugin
 * that does not load, over a path that host never uses. The embed reads the
 * database and never migrates it (whoever owns the install owns the schema), so
 * asking this question lazily means it is never asked there at all.
 *
 * @returns Absolute path to the migrations folder.
 */
export function migrationsFolder(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
}
