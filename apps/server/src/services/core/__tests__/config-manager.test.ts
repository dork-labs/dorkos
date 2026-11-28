import { describe, it, expect } from 'vitest';
import * as semver from 'semver';
import { CONFIG_MIGRATIONS } from '../config-manager.js';
import { checkMigrationSafety, extractMigrationBodies } from './migration-safety.js';
import { checkAppendOnly, migrationClosure } from './migration-append-only.js';
import {
  declarationPool,
  extractTopLevelDeclarations,
  reachedDeclarations,
} from './migration-closure.js';
import type { ClosureSources } from './migration-closure.js';
import { MERGED_MIGRATION_HASHES } from './merged-migration-hashes.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

/**
 * Join `config-manager.ts` and the files of `config-migrations/` into the one
 * source text the migration guards read.
 *
 * The table and the helpers its keys call live in `config-migrations/`, while
 * the guards parse text. Joining is exact rather than approximate: a pin sorts
 * the declarations it reaches by name, so which file a declaration sits in
 * never enters the hash, and the table slice is read whole wherever it lives.
 *
 * Refuses a name declared in two of the files. The declaration reader keeps the
 * last one it sees, so a duplicate would silently drop the other from every
 * closure that reaches it — a pin with a hole in it.
 *
 * @param files - Each file's path and source text.
 * @returns The files joined in the order given.
 */
function joinMigrationSources(files: { file: string; text: string }[]): string {
  const declaredIn = new Map<string, string>();
  for (const { file, text } of files) {
    for (const name of Object.keys(extractTopLevelDeclarations(text))) {
      const other = declaredIn.get(name);
      if (other !== undefined) {
        throw new Error(
          `${name} is declared in both ${other} and ${file}. The migration guards read these ` +
            'files as one, so one of the two would vanish from every closure. Rename one.'
        );
      }
      declaredIn.set(name, file);
    }
  }
  return files.map(({ text }) => text).join('\n');
}

/**
 * Why a folder inside `config-migrations/` is refused rather than read.
 *
 * The guards read the folder's own files only. A helper in a nested folder would
 * be reached by no closure, so every key calling it would be pinned with a hole
 * where that helper's body should be.
 *
 * @param nested - The nested folder names found.
 */
function nestedMigrationDirsMessage(nested: readonly string[]): string {
  return (
    `config-migrations/ holds a folder (${nested.join(', ')}). The migration guards read ` +
    'only the files directly in it, so a helper in a folder would escape every pin. Keep ' +
    'migration helpers flat in config-migrations/.'
  );
}

/** The working tree's `config-manager.ts` and `config-migrations/*.ts`, joined. */
function readMigrationSource(): string {
  const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(core, 'config-migrations');
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const nested = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (nested.length > 0) throw new Error(nestedMigrationDirsMessage(nested));
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();
  return joinMigrationSources([
    {
      file: 'config-manager.ts',
      text: fs.readFileSync(path.join(core, 'config-manager.ts'), 'utf-8'),
    },
    ...names.map((name) => ({
      file: `config-migrations/${name}`,
      text: fs.readFileSync(path.join(dir, name), 'utf-8'),
    })),
  ]);
}

describe('CONFIG_MIGRATIONS key invariant (DOR-339 regression guard)', () => {
  // Bit once (0.47.0 -> 0.48.0, see config-manager.ts around the '0.48.0' entry)
  // and again later (a '0.54.0' key drafted as "the next unreleased version"
  // went stale the moment v0.54.0 was tagged while its branch was still open).
  // conf only runs a key in `(storedVersion, projectVersion]`, so a key equal to
  // (or behind) an already-tagged release is silently excluded for every
  // upgrading user — no error, no warning, the backfill just never runs.
  //
  // The rule itself lives in `migration-safety.ts`, as a pure function over the
  // source text and the tag list, and its whole failure matrix is fixture-tested
  // next door in `migration-safety.test.ts`. This test is the other half: it
  // feeds that rule the REAL repository. Splitting it that way is what makes the
  // negative cases testable at all — staging "a migration body appended to an
  // already-tagged key" against real git would mean fabricating tags.
  //
  // Three things this guard checks that the first one did not. It compares the
  // CONTENT of every shipped migration against the release, not merely whether
  // the key is present — a body appended to an already-tagged composite key ships
  // dead while the key sits there looking fine, and that is DOR-988. It covers
  // every key, not only the newest. And it follows a shipped key into the code it
  // CALLS (DOR-1135): most of this table is a composite, so comparing the table
  // slice alone froze a helper's name and left its body editable — the tamper
  // that proved it was seeded into `backfillAutonomyAcknowledgement`, which the
  // shipped '0.57.0' key calls, and this test stayed green.
  //
  // Git tags, not package.json, are the ground truth: a feature branch can sit
  // open past a real release without ever touching its own stale copy of that
  // file, which is exactly how the 0.54.0 bug slipped through. Tags are shared
  // across every worktree of a checkout regardless of which commit a branch sits
  // on. A checkout with no tags is a LOUD failure rather than a fallback, because
  // "I cannot see the releases" and "there is nothing wrong" are different
  // answers; CI checks out with `fetch-depth: 0` for exactly this reason
  // (.github/workflows/test.yml).
  const CONFIG_MANAGER_PATH = 'apps/server/src/services/core/config-manager.ts';
  const MIGRATIONS_PATH = 'apps/server/src/services/core/config-migrations';

  /** Run a git command from the repo root, or return null when it fails. */
  const git = (args: string): string | null => {
    try {
      return execSync(`git ${args}`, {
        encoding: 'utf-8',
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };

  it('parses the real migration table into exactly the keys the module exports', () => {
    // Guard the guard: the rule below compares source slices, so a parser that
    // silently matched nothing would report every migration safe.
    const source = readMigrationSource();
    expect(Object.keys(extractMigrationBodies(source))).toEqual(Object.keys(CONFIG_MIGRATIONS));
  });

  it('every migration key is unreleased-and-newer, or matches its release in body and in what it calls', () => {
    const source = readMigrationSource();
    const tags = (git('tag -l "v*"') ?? '')
      .split('\n')
      .map((t) => t.trim().replace(/^v/, ''))
      .filter((t) => semver.valid(t) !== null);

    const result = checkMigrationSafety({
      workingSource: source,
      tags,
      // `refs/tags/` rather than a bare `v<version>`, so a branch that happens to
      // share a release's name cannot shadow the tag and be read as the release.
      //
      // A release cut after the table moved carries it in `config-migrations/`, so
      // that folder is read too wherever the tag has it; an older tag has no such
      // folder and reads exactly as before, `config-manager.ts` alone.
      readAtTag: (version) => {
        const ref = `refs/tags/v${version}`;
        const manager = git(`show ${ref}:${CONFIG_MANAGER_PATH}`);
        if (manager === null) return null;
        const listed = git(`ls-tree --full-tree ${ref} -- ${MIGRATIONS_PATH}/`);
        if (listed === null) return null;
        // `<mode> <type> <object>\t<path>` per line; a `tree` is a folder.
        const rows = listed
          .split('\n')
          .filter((line) => line.includes('\t'))
          .map((line) => {
            const [meta, file] = line.split('\t') as [string, string];
            return { type: meta.split(' ')[1], file };
          });
        const nested = rows.filter((row) => row.type === 'tree').map((row) => row.file);
        if (nested.length > 0) throw new Error(nestedMigrationDirsMessage(nested));
        const files = [{ file: CONFIG_MANAGER_PATH, text: manager }];
        for (const file of rows
          .filter((row) => row.type === 'blob' && row.file.endsWith('.ts'))
          .map((row) => row.file)
          .sort()) {
          const text = git(`show ${ref}:${file}`);
          if (text === null) return null;
          files.push({ file, text });
        }
        return joinMigrationSources(files);
      },
    });

    expect(result.ok, result.problems.join('\n')).toBe(true);
  });
});

describe('CONFIG_MIGRATIONS append-only pins (DOR-1222 regression guard)', () => {
  // The guard above measures against the newest `v*` TAG, which leaves the
  // merge-to-release window open: for a key above the newest tag it says "new
  // work" and permits any rewrite. That window is not empty. `conf` runs a key
  // in `(storedVersion, projectVersion]`, and `projectVersion` is whatever
  // `SERVER_VERSION` resolves to — the version baked into a built CLI bundle or
  // the desktop app, which is bumped in the repository BEFORE the tag exists.
  // The operator's own config was stamped `0.59.0` on 2026-08-12 while `0.59.0`
  // was "unreleased", so both later amendments to that key skipped him without a
  // word. The dogfood machine is always somebody.
  //
  // So this half pins CONTENT per merged key, against `merged-migration-hashes.ts`
  // rather than against git. That is what makes it answerable offline, in a
  // shallow clone, and — the point — inside the window where no tag exists yet to
  // compare with. The rule and its failure matrix are in
  // `migration-append-only.ts` / `migration-append-only.test.ts`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const readSources = (): ClosureSources => ({
    configManager: readMigrationSource(),
    configSchema: fs.readFileSync(
      path.resolve(here, '../../../../../../packages/shared/src/config-schema.ts'),
      'utf-8'
    ),
  });

  it('reaches into the helper a bare table entry names, not just its name', () => {
    // Guard the guard, and the thing this rule exists to cover that the tag rule
    // does not: `'0.103.0': raiseEngagedWindowDefaults` is one identifier in the
    // table, so a pin that hashed the table slice alone would freeze a NAME while
    // the body it points at stayed editable. That is the shape of DOR-1121.
    const closure = migrationClosure('0.103.0', readSources());
    expect(closure).toContain('rooms.engagedWindowPosts');
    // And it stops at what the key actually reaches: `offersEnabled` lives in
    // `backfillWelcomeBackDefaults`, which only `'0.59.0'` calls.
    expect(closure).not.toContain('offersEnabled');
  });

  it('reaches across the import boundary into config-schema.ts (DOR-1732)', () => {
    // The one-hop bypass this closure was widened to close. `'0.57.0'` calls
    // `toSidebarItemRef`, which lives one module away in `@dorkos/shared`, and
    // it decides what every upgrading install's sidebar members are rewritten
    // to. Rewriting its body used to leave every guard green.
    const sources = readSources();
    const sidebar = migrationClosure('0.57.0', sources);
    expect(sidebar).toContain('export function toSidebarItemRef');

    // The other behavior-bearing one: `'0.65.0'` mints account ids with
    // `claudeAccountId`, and reaches the private helper it calls in turn.
    const accounts = migrationClosure('0.65.0', sources);
    expect(accounts).toContain('export function claudeAccountId');
    expect(accounts).toContain('export function slugifyAccountId');

    // And it still stops somewhere. `UserConfigSchema` is the whole config
    // schema, so following it would move five shipped pins for every ordinary
    // field addition; `migration-closure.ts` states that boundary. The line that
    // derives the defaults FROM it is pinned, so the derivation cannot be
    // swapped for a literal unseen.
    const memory = migrationClosure('0.69.0', sources);
    expect(memory).toContain('USER_CONFIG_DEFAULTS: UserConfig = UserConfigSchema.parse');
    expect(memory).not.toContain('export const UserConfigSchema');
  });

  it('every merged migration still hashes to what it was pinned at', () => {
    const result = checkAppendOnly(readSources(), MERGED_MIGRATION_HASHES);
    expect(result.ok, result.problems.join('\n\n')).toBe(true);
  });

  it('no key reaches the one helper called only from inside interpolations (DOR-1733)', () => {
    // The walk now follows a call written as `` `${describeLoadError(cause)}` ``
    // rather than blanking it away with the rest of the template. That widening
    // moved nothing here, and this is the check that keeps saying so.
    //
    // `describeLoadError` is the shape the fix was for: a top-level declaration
    // in config-manager.ts that NOTHING calls except from inside a template
    // interpolation. It sits in the error path — `adviceFor`,
    // `unreadableMessage`, `loadConfigStore` — which no migration key reaches
    // today. The day one does, its pin moves and this goes red, which is the
    // warning the guard could not give while the mask was blind.
    const sources = readSources();
    const pool = declarationPool(sources);
    expect(Object.keys(pool)).toContain('describeLoadError');

    const bodies = extractMigrationBodies(sources.configManager);
    // The subject is asserted before the verdict is. "No key reaches it" is
    // vacuously true of no keys at all, so an extractor that returned `{}` would
    // pass this having scanned nothing. The count is the knowable bound; the
    // table is append-only, so raising it is the deliberate act of adding a
    // migration, which is exactly when this check should be re-read. DOR-4188
    // lowered it by retiring three keys the upgrade floor left as no-ops;
    // DOR-4891 raised it by one ('0.140.0', which never reaches the helper),
    // DOR-5033 by one ('0.142.0') and DOR-5164 by one ('0.143.0'); neither reaches it.
    expect(Object.keys(bodies)).toHaveLength(57);

    const reaching = Object.keys(bodies).filter((key) =>
      reachedDeclarations(bodies[key]!, pool).includes('describeLoadError')
    );
    expect(reaching).toEqual([]);
  });

  it('lists its keys in ascending semver order, after the legacy sentinel', () => {
    // Neither guard sees a REORDER: hashes are per key and the tag comparison is
    // per key too, so swapping two blocks leaves every check green while
    // changing what actually happens — `conf` runs migrations in the table's
    // INSERTION order, not in version order, and several bodies here depend on
    // running after another (the reserved account-id rename after the account
    // registry migration). Ascending order is what makes insertion order and
    // version order the same thing, so it is asserted rather than hashed — a
    // hash of the key list would go red without saying why.
    //
    // `'1.0.0'` is exempt and pinned to the front. It is the legacy sentinel
    // that seeds `version: 1`, and it is above every version this app has ever
    // carried, so `key <= projectVersion` excludes it and it runs for nobody
    // while DorkOS is 0.x. Its position cannot matter until the app reaches
    // 1.0.0, at which point running first is what a seed body wants anyway.
    const keys = Object.keys(CONFIG_MIGRATIONS);
    expect(keys[0]).toBe('1.0.0');
    const rest = keys.slice(1);
    expect(rest).toEqual([...rest].sort((a, b) => semver.compare(a, b)));
  });
});
