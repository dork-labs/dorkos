/**
 * Every process that migrates the real database captures the live standing
 * permissions first (spec `agent-permissions` D13, phase 2).
 *
 * The migration that drops `approval_grants` runs wherever `runMigrations` from
 * `@dorkos/db` is called, and whichever process gets there first is the only
 * one that could ever read the table. `dorkos auth` once migrated without the
 * capture, so a person who ran it before starting the server after an upgrade
 * lost every history line the upgrade owed them. This scan holds every caller
 * to the rule: capture in the same file, or an entry below saying why that
 * database can never hold a standing permission.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { codeOnly } from '../../../../../../../scripts/lib/code-only.mjs';

/** The repository root, resolved from this file rather than from the cwd. */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../..');

/** Where production code that can open a database lives. */
const SCANNED = ['apps/server/src', 'apps/desktop/src', 'packages'];

/** Callers that need no capture, each with why. Paths relative to the root. */
const EXEMPT: Record<string, string> = {
  'packages/db/src/index.ts': 'the definition itself',
  'packages/test-utils/src/db.ts': 'an in-memory test database, created empty',
  'apps/server/src/harness-boot.ts':
    'the in-process test server, over a fresh sandbox data directory every run',
  'packages/evals/src/suite/operate.ts': 'an eval sandbox, created empty for each run',
  'packages/relay/src/relay-core.ts':
    "relay's own legacy index.db, a separate file no standing permission was ever written to",
};

/** Every `.ts` file under a directory, skipping tests, builds and dependencies. */
async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '__tests__', '.turbo'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(full)));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('migrating the database captures standing permissions first', () => {
  it('holds every runMigrations caller to a capture, or a stated exemption', async () => {
    const files = (await Promise.all(SCANNED.map((d) => sources(path.join(REPO, d))))).flat();
    const callers: string[] = [];
    const missing: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf-8');
      // Only the `@dorkos/db` migration: the extension store has its own
      // `runMigrations(dbPath, migrations)` over a different file.
      const importsDbMigrations =
        /import\s*\{[^}]*\brunMigrations\b[^}]*\}\s*from\s*'@dorkos\/db'/.test(text) ||
        file.endsWith(path.join('packages', 'db', 'src', 'index.ts'));
      if (!importsDbMigrations) continue;
      const code = codeOnly(text);
      if (!/\brunMigrations\(/.test(code)) continue;
      const rel = path.relative(REPO, file);
      callers.push(rel);
      if (EXEMPT[rel]) continue;
      const capture = code.indexOf('captureLiveStandingGrants(');
      const migrate = code.indexOf('runMigrations(');
      if (capture === -1 || capture > migrate) missing.push(rel);
    }

    // The scan found the two callers that matter, so it cannot pass by finding none.
    expect(callers).toEqual(
      expect.arrayContaining([
        'apps/server/src/index.ts',
        'packages/cli/src/commands/auth-runtime.ts',
      ])
    );
    expect(missing).toEqual([]);
    // An exemption for a file that no longer calls it is a stale reason.
    expect(Object.keys(EXEMPT).filter((rel) => !callers.includes(rel))).toEqual([]);
  });

  it('removes the retired settings at boot, and only after the capture has read them', async () => {
    const code = codeOnly(await readFile(path.join(REPO, 'apps/server/src/index.ts'), 'utf-8'));
    const read = code.indexOf('readStandingGrantLicence(');
    const capture = code.indexOf('captureLiveStandingGrants(');
    const retire = code.indexOf('.retireStandingGrantSettings(');
    expect(read).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(read);
    expect(retire).toBeGreaterThan(capture);
  });
});
