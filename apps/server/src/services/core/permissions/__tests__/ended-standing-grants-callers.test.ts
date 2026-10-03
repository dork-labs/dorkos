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
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/** Read at most eight sources at once, retaining input order and draining failures. */
async function readSourcesInOrder<T>(
  files: readonly string[],
  read: (file: string) => Promise<T>
): Promise<T[]> {
  const results: ({ ok: true; value: T } | { ok: false; error: unknown })[] = new Array(
    files.length
  );
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      try {
        results[index] = { ok: true, value: await read(files[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, () => worker()));
  return results.map((result) => {
    if (!result.ok) throw result.error;
    return result.value;
  });
}

/** Preserve the original migration classification and parser's default filename. */
async function migrationCallers(
  files: readonly string[],
  root = REPO
): Promise<{
  callers: string[];
  missing: string[];
}> {
  const rows = await readSourcesInOrder(files, async (file) => {
    const text = await readFile(file, 'utf-8');
    // Only the `@dorkos/db` migration: the extension store has its own
    // `runMigrations(dbPath, migrations)` over a different file.
    const importsDbMigrations =
      /import\s*\{[^}]*\brunMigrations\b[^}]*\}\s*from\s*'@dorkos\/db'/.test(text) ||
      file.endsWith(path.join('packages', 'db', 'src', 'index.ts'));
    if (!importsDbMigrations) return undefined;
    const code = codeOnly(text);
    if (!/\brunMigrations\(/.test(code)) return undefined;
    const rel = path.relative(root, file);
    if (EXEMPT[rel]) return { caller: rel, missing: false };
    const capture = code.indexOf('captureLiveStandingGrants(');
    const migrate = code.indexOf('runMigrations(');
    return { caller: rel, missing: capture === -1 || capture > migrate };
  });
  const callers: string[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    if (!row) continue;
    callers.push(row.caller);
    if (row.missing) missing.push(row.caller);
  }
  return { callers, missing };
}

describe('migrating the database captures standing permissions first', () => {
  it('holds every runMigrations caller to a capture, or a stated exemption', async () => {
    const files = (await Promise.all(SCANNED.map((d) => sources(path.join(REPO, d))))).flat();
    const { callers, missing } = await migrationCallers(files);

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

describe('bounded source reads', () => {
  it('keeps every result in input order with eight reads and drains a delayed first input', async () => {
    const files = Array.from({ length: 33 }, (_, index) => `${index}`);
    let active = 0;
    let peak = 0;
    const finished: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const pending = readSourcesInOrder(files, async (file) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await (file === '0' ? first : Promise.resolve());
        finished.push(file);
        return file;
      } finally {
        active--;
      }
    });
    let settled = false;
    const observed = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      expect(active).toBe(8);
      // Let the other workers finish while the first input remains held.
      for (let turn = 0; turn < 32; turn++) await Promise.resolve();
      expect(finished).toHaveLength(32);
      expect(finished).not.toContain('0');
      expect(settled).toBe(false);
    } finally {
      releaseFirst();
      await observed;
    }
    expect(await pending).toEqual(files);
    expect(finished).toHaveLength(33);
    expect(active).toBe(0);
    expect(peak).toBe(8);
  });

  it.each([new Error('first input error'), undefined])(
    'throws the earliest input failure unchanged and drains every task (%s)',
    async (firstError) => {
      const files = Array.from({ length: 24 }, (_, index) => `${index}`);
      const laterError = new Error('later input error');
      let finished = 0;
      let caught = false;
      let actual: unknown;
      let releaseError!: () => void;
      const first = new Promise<void>((resolve) => {
        releaseError = resolve;
      });
      const pending = readSourcesInOrder(files, async (file) => {
        try {
          await (file === '2' ? first : Promise.resolve());
          if (file === '2') throw firstError;
          if (file === '7') throw laterError;
          return file;
        } finally {
          finished++;
        }
      });
      // Register the observer before releasing either error; undefined is still a failure.
      const observed = pending.then(
        () => {},
        (error: unknown) => {
          caught = true;
          actual = error;
        }
      );
      try {
        await Promise.resolve();
      } finally {
        releaseError();
        await observed;
      }
      expect(caught).toBe(true);
      expect(actual).toBe(firstError);
      expect(finished).toBe(24);
    }
  );
});

describe('independent migration source fixtures', () => {
  it('keeps the full path set and detects a late missing capture without changing exemptions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'standing-source-guard-'));
    const captured =
      "import { runMigrations } from '@dorkos/db'; captureLiveStandingGrants(db); runMigrations(db);";
    const missing = "import { runMigrations } from '@dorkos/db'; runMigrations(db);";
    const clean = 'export const value = 1;';
    const fixtures: Record<string, string> = {
      'apps/server/src/captured.ts': captured,
      'apps/server/src/after.ts': `${missing} captureLiveStandingGrants(db);`,
      'apps/server/src/.hidden/keep.ts': clean,
      'apps/server/src/__fixtures__/keep.ts': clean,
      'apps/server/src/comments.ts':
        "import { runMigrations } from '@dorkos/db'; // runMigrations(db)\nconst text = 'runMigrations(db)';",
      'apps/server/src/__tests__/skip.ts': missing,
      'apps/server/src/skip.test.ts': missing,
      'apps/server/src/skip.spec.tsx': missing,
      'apps/server/src/skip.d.ts': missing,
      'apps/server/src/dist/skip.ts': missing,
      'apps/server/src/node_modules/skip.ts': missing,
      'apps/server/src/.turbo/skip.ts': missing,
      'apps/desktop/src/jsx.tsx': `${captured} const view = <div />;`,
      'packages/db/src/index.ts': 'export function runMigrations(db) {}',
      'packages/test-utils/src/db.ts': missing,
      'packages/extension/src/other-db.ts':
        "import { runMigrations } from './extension-db'; runMigrations(db);",
      'packages/future/deep/z-last.ts': missing,
    };
    try {
      for (const [file, text] of Object.entries(fixtures)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
      }
      await symlink(
        path.join(root, 'apps/server/src/captured.ts'),
        path.join(root, 'apps/server/src/alias.ts')
      );
      await symlink(
        path.join(root, 'packages/future'),
        path.join(root, 'apps/server/src/dir-link'),
        'dir'
      );
      const files = (await Promise.all(SCANNED.map((dir) => sources(path.join(root, dir))))).flat();
      expect(files.map((file) => path.relative(root, file)).sort()).toEqual(
        [
          'apps/desktop/src/jsx.tsx',
          'apps/server/src/.hidden/keep.ts',
          'apps/server/src/__fixtures__/keep.ts',
          'apps/server/src/after.ts',
          'apps/server/src/alias.ts',
          'apps/server/src/captured.ts',
          'apps/server/src/comments.ts',
          'packages/db/src/index.ts',
          'packages/extension/src/other-db.ts',
          'packages/future/deep/z-last.ts',
          'packages/test-utils/src/db.ts',
        ].sort()
      );
      const result = await migrationCallers(files, root);
      expect([...result.callers].sort()).toEqual(
        [
          'apps/desktop/src/jsx.tsx',
          'apps/server/src/after.ts',
          'apps/server/src/alias.ts',
          'apps/server/src/captured.ts',
          'packages/db/src/index.ts',
          'packages/future/deep/z-last.ts',
          'packages/test-utils/src/db.ts',
        ].sort()
      );
      expect([...result.missing].sort()).toEqual([
        'apps/server/src/after.ts',
        'packages/future/deep/z-last.ts',
      ]);
      const ordered = ['apps/server/src/captured.ts', 'packages/future/deep/z-last.ts'].map(
        (file) => path.join(root, file)
      );
      expect(await migrationCallers(ordered, root)).toEqual({
        callers: ['apps/server/src/captured.ts', 'packages/future/deep/z-last.ts'],
        missing: ['packages/future/deep/z-last.ts'],
      });
      // Removing capture from a real FILE remains visible; no caller-set shortcut can hide it.
      await writeFile(path.join(root, 'apps/server/src/captured.ts'), missing);
      expect((await migrationCallers([ordered[0]], root)).missing).toEqual([
        'apps/server/src/captured.ts',
      ]);
      await expect(migrationCallers([path.join(root, 'absent.ts')], root)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(sources(path.join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
