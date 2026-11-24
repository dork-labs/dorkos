/**
 * A throwaway copy of the fixture release point for each test.
 *
 * `fixtures/repo/` holds a tiny DorkOS-shaped tree: VERSION, the API document,
 * a ten-version CHANGELOG.md with its archive, both docs changelog pages and
 * three fragments (a patch release as it stands). The five package.json files
 * are written here rather than committed under `scripts/`, so no tool that
 * walks the repo for manifests ever mistakes the fixture for a package.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diskReader } from '../release-commit.ts';
import { buildReleasePlan, type PlanInput, type ReleasePlan } from '../plan.ts';
import { PACKAGE_FILES } from '../version-files.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/repo', import.meta.url));

/** The last release the fixture tree is at. */
export const FIXTURE_PREVIOUS = '0.20.0';

/** The release date every fixture plan uses. */
export const FIXTURE_DATE = '2026-11-24';

/** A fixture checkout in a temp directory, with helpers to change it. */
export interface FixtureRepo {
  /** The checkout's root. */
  dir: string;
  /** Read a file in the checkout. */
  read(relative: string): string;
  /** Write (or overwrite) a file in the checkout. */
  write(relative: string, text: string): void;
  /** Delete a file in the checkout. */
  remove(relative: string): void;
  /** Build a plan over the checkout with the fixture's previous version and date. */
  plan(extra?: Partial<Omit<PlanInput, 'reader'>>): ReleasePlan;
  /** Delete the temp directory. */
  cleanup(): void;
}

/** Copy the fixture tree into a fresh temp directory. */
export function fixtureRepo(): FixtureRepo {
  const root = mkdtempSync(path.join(tmpdir(), 'release-commit-'));
  const dir = path.join(root, 'repo');
  cpSync(FIXTURE, dir, { recursive: true });
  PACKAGE_FILES.forEach((file, index) => {
    const manifest = {
      name: index ? `@fixture/${file.split('/')[1]}` : 'fixture-root',
      // A nested "version" after the top-level one must never move.
      version: FIXTURE_PREVIOUS,
      private: true,
      engines: { node: '>=24' },
      ...(index === 1 ? { pkg: { version: FIXTURE_PREVIOUS } } : {}),
    };
    write(file, JSON.stringify(manifest, null, 2) + '\n');
  });

  function write(relative: string, text: string): void {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  return {
    dir,
    read: (relative) => readFileSync(path.join(dir, relative), 'utf8'),
    write,
    remove: (relative) => rmSync(path.join(dir, relative)),
    plan: (extra = {}) =>
      buildReleasePlan({
        reader: diskReader(dir),
        previous: FIXTURE_PREVIOUS,
        date: FIXTURE_DATE,
        ...extra,
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
