import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The space server's migration compatibility id: a SHA-256 over every `.sql` file in its
 * migrations folder, in name order, each as its name, a NUL, its bytes and a NUL.
 *
 * Two producers must agree on it byte for byte: the CLI bakes it into the launcher
 * (`packages/cli/scripts/build.ts`), and every release manifest carries it
 * (`scripts/generate-community-release-manifest.ts`). A launcher refuses a release whose id
 * differs from its own, so both call this one function. Plain JavaScript so both, run under tsx
 * from different packages, import the same file.
 *
 * @param {string} migrationsDir - The space server's migrations folder.
 * @returns {string} `sha256:` and 64 hex digits.
 */
export function communityMigrationCompatibilityId(migrationsDir) {
  const hash = createHash('sha256');
  for (const filename of readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    hash.update(filename);
    hash.update('\0');
    hash.update(readFileSync(join(migrationsDir, filename)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}
