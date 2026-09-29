/**
 * The project registry (spec `flow-multiproject` §6.1): stable URL-safe names,
 * second-class reported roots, lists that hide missing folders, and the
 * per-extension scope of `ctx.projects.list()`.
 *
 * Roots are resolved by a stand-in (the git rule has its own suite); folders
 * are real, so "does it exist" and "does it hold a copy" are real reads. The
 * store is the real SQLite table, so persistence is what a restart sees.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { MARKETPLACE_STAGE_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';

import { KnownProjectsStore } from '../known-projects-store.js';
import { parseOriginRepo } from '../origin-repo.js';
import {
  assignProjectName,
  MAX_REPORTED_ROOTS_PER_EXTENSION,
  ProjectRegistry,
  sanitizeNameSegment,
  type ProjectRegistryDeps,
} from '../project-registry.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

let base: string;
let boundary: string;

/** A folder under the test root, created. */
function folder(...segments: string[]): string {
  const dir = path.join(base, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A registry whose "git" says a folder's root is the nearest ancestor holding
 * a `.git` marker folder, and whose boundary is `boundary`.
 */
function registry(overrides: Partial<ProjectRegistryDeps> = {}, db?: Db): ProjectRegistry {
  const resolveRoot = vi.fn(async (cwd: string) => {
    let dir = cwd;
    while (dir !== path.dirname(dir)) {
      try {
        if (realpathSync(path.join(dir, '.git'))) return dir;
      } catch {
        // not here; climb
      }
      dir = path.dirname(dir);
    }
    return null;
  });
  const reg = new ProjectRegistry({
    resolveRoot,
    peekRoot: () => undefined,
    readOriginRepo: async () => null,
    checkBoundary: async (dir) => {
      if (!dir.startsWith(boundary)) throw new Error('outside');
      return dir;
    },
    ...overrides,
  });
  if (db) reg.attachStore(new KnownProjectsStore(db));
  return reg;
}

/** A repository root: a folder with a `.git` marker. */
function repo(...segments: string[]): string {
  const dir = folder(...segments);
  folder(...segments, '.git');
  return dir;
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'project-registry-')));
  boundary = folder('home');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('names', () => {
  it('replaces every character outside [A-Za-z0-9._-] with -', () => {
    expect(sanitizeNameSegment('My Project (v2)!')).toBe('My-Project--v2--');
    expect(sanitizeNameSegment('dorkos.site_v1-x')).toBe('dorkos.site_v1-x');
  });

  it('adds ~parent on a clash, then counts', () => {
    const taken = new Set<string>();
    const name = (root: string) => {
      const n = assignProjectName(root, (candidate) => taken.has(candidate));
      taken.add(n);
      return n;
    };
    expect(name('/Users/kai/dev/dorkos')).toBe('dorkos');
    expect(name('/Users/kai/work/dorkos')).toBe('dorkos~work');
    expect(name('/Volumes/x/work/dorkos')).toBe('dorkos~work-2');
    expect(name('/Volumes/y/work/dorkos')).toBe('dorkos~work-3');
    expect(name('/Users/kai/client work/dorkos')).toBe('dorkos~client-work');
  });

  it('keeps the first project its name when a later one clashes, across a restart', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const first = repo('home', 'dev', 'blintz');
    const second = repo('home', 'clients', 'blintz');

    const before = registry({}, db);
    expect(await before.resolve(first)).toEqual({ root: first, name: 'blintz' });
    expect(await before.resolve(second)).toEqual({ root: second, name: 'blintz~clients' });

    // A restart: a fresh registry over the same table sees the same names,
    // and asking about them again in the other order changes nothing.
    const after = registry({}, db);
    expect(await after.resolve(second)).toEqual({ root: second, name: 'blintz~clients' });
    expect(await after.resolve(first)).toEqual({ root: first, name: 'blintz' });
  });

  it('never records one root twice when asked concurrently', async () => {
    const root = repo('home', 'dev', 'concurrent');
    const reg = registry();
    const refs = await Promise.all([reg.resolve(root), reg.resolve(root), reg.resolve(root)]);
    expect(new Set(refs.map((r) => r?.name))).toEqual(new Set(['concurrent']));
    expect((await reg.list()).filter((p) => p.root === root)).toHaveLength(1);
  });
});

describe('resolve and list', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('maps a subfolder to its project and remembers it as seen', async () => {
    const root = repo('home', 'dev', 'alpha');
    const reg = registry({ readOriginRepo: async () => 'dork-labs/alpha' }, db);
    expect(await reg.resolve(path.join(root, 'src'))).toEqual({ root, name: 'alpha' });
    expect(await reg.list()).toEqual([
      expect.objectContaining({ root, name: 'alpha', originRepo: 'dork-labs/alpha' }),
    ]);
  });

  it('answers null for a folder in no repository and records nothing', async () => {
    const reg = registry({}, db);
    expect(await reg.resolve(folder('home', 'loose'))).toBeNull();
    expect(await reg.list()).toEqual([]);
  });

  it('hides a project whose folder is gone, and keeps it', async () => {
    const root = repo('home', 'dev', 'unplugged');
    const reg = registry({}, db);
    await reg.resolve(root);
    rmSync(root, { recursive: true, force: true });
    expect((await reg.list()).map((p) => p.root)).not.toContain(root);
    // Back again (a drive plugged in): the same name, no new row.
    repo('home', 'dev', 'unplugged');
    expect((await reg.list()).find((p) => p.root === root)?.name).toBe('unplugged');
  });

  it('lists by name', async () => {
    const reg = registry({}, db);
    await reg.resolve(repo('home', 'z', 'zeta'));
    await reg.resolve(repo('home', 'a', 'beta'));
    await reg.resolve(repo('home', 'm', 'alpha2'));
    expect((await reg.list()).map((p) => p.name)).toEqual(['alpha2', 'beta', 'zeta']);
  });

  it('seeds from its sources, and a source that throws costs only its seeds', async () => {
    const reg = registry({}, db);
    const agent = repo('home', 'agents', 'seeded');
    await reg.setSources(() => [agent, 'relative/ignored']);
    expect((await reg.list()).map((p) => p.root)).toContain(agent);

    const broken = registry({}, db);
    await broken.setSources(() => {
      throw new Error('boom');
    });
    expect(await broken.list()).toEqual(expect.any(Array));
  });

  it('peeks a project only once the registry has resolved its folder', async () => {
    const root = repo('home', 'dev', 'peeked');
    let cached: string | null | undefined;
    const reg = registry({ peekRoot: () => cached }, db);
    expect(reg.peek(root)).toBeUndefined();
    cached = null;
    expect(reg.peek(folder('home', 'loose2'))).toBeNull();
    cached = root;
    await reg.resolve(root);
    expect(reg.peek(root)).toEqual({ root, name: 'peeked' });
  });

  it('tells its listeners when a project is added, not when one is merely seen again', async () => {
    const reg = registry({}, db);
    const listener = vi.fn();
    reg.onChange(listener);
    const root = repo('home', 'dev', 'noisy');
    await reg.resolve(root);
    await reg.resolve(root);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('reported roots are second-class', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('refuses a path outside the boundary and records nothing', async () => {
    const outside = repo('elsewhere', 'secret');
    const reg = registry({}, db);
    expect(await reg.report(outside, 'flow')).toBeNull();
    expect(await reg.resolveWithin(outside, 'flow')).toBe('outside');
    expect(await reg.resolveWithin(outside)).toBe('outside');
    expect(new KnownProjectsStore(db).all()).toEqual([]);
  });

  it('refuses a folder inside the boundary whose root is outside it, and records nothing', async () => {
    // A worktree (or a `.git` file) inside the boundary whose repository
    // lives outside it. The real-git version is in routes/__tests__/projects.test.ts.
    const inside = folder('home', 'dev', 'wt-of-outside');
    const outsideRoot = repo('elsewhere', 'private');
    const reg = registry(
      {
        resolveRoot: async (cwd) => (cwd.startsWith(inside) ? outsideRoot : null),
      },
      db
    );
    expect(await reg.report(inside, 'flow')).toBeNull();
    expect(await reg.resolveWithin(inside, 'flow')).toBe('outside');
    expect(await reg.resolveWithin(inside)).toBe('outside');
    expect(new KnownProjectsStore(db).all()).toEqual([]);
  });

  it('refuses a folder in no repository', async () => {
    const reg = registry({}, db);
    expect(await reg.report(folder('home', 'not-a-repo'), 'flow')).toBeNull();
    expect(await reg.list()).toEqual([]);
  });

  it('stores a reported-only root as reported, and seeing it later upgrades it to seen', async () => {
    const root = repo('home', 'dev', 'hinted');
    const reg = registry({}, db);
    expect(await reg.report(root, 'flow')).toEqual({ root, name: 'hinted' });
    expect(reg.isReportedOnly(root)).toBe(true);

    await reg.resolve(root);
    expect(reg.isReportedOnly(root)).toBe(false);
    const stored = new KnownProjectsStore(db).all().find((p) => p.root === root);
    expect(stored).toMatchObject({ source: 'seen' });
  });

  it('a lookup, by an extension or a person, never makes a folder seen', async () => {
    const byExtension = repo('home', 'dev', 'resolved-by-ext');
    const byPerson = repo('home', 'dev', 'looked-up');
    const reg = registry({}, db);
    expect(await reg.resolveWithin(byExtension, 'flow')).toEqual({
      root: byExtension,
      name: 'resolved-by-ext',
    });
    expect(await reg.resolveWithin(byPerson)).toEqual({ root: byPerson, name: 'looked-up' });
    expect(reg.isReportedOnly(byExtension)).toBe(true);
    expect(reg.isReportedOnly(byPerson)).toBe(true);
  });

  it("keeps roots only extensions or lookups named out of the person's list until they are seen", async () => {
    const seen = repo('home', 'plist', 'seen-one');
    const reported = repo('home', 'plist', 'reported-one');
    const looked = repo('home', 'plist', 'looked-one');
    const reg = registry({}, db);
    await reg.resolve(seen);
    await reg.report(reported, 'flow');
    await reg.resolveWithin(looked);
    expect((await reg.list()).map((p) => p.name)).toEqual(['seen-one']);
    await reg.resolve(reported);
    expect((await reg.list()).map((p) => p.name)).toEqual(['reported-one', 'seen-one']);
  });

  it(`caps the new roots one extension can name at ${MAX_REPORTED_ROOTS_PER_EXTENSION}`, async () => {
    // A root per call, straight from the stub, so the cap is what is tested.
    let n = 0;
    const reg = registry(
      {
        resolveRoot: async (cwd) => cwd,
        checkBoundary: async (dir) => dir,
        exists: async () => true,
      },
      db
    );
    for (; n < MAX_REPORTED_ROOTS_PER_EXTENSION; n++) {
      const half = n % 2 === 0;
      const dir = path.join(boundary, 'cap', `r${n}`);
      const ok = half ? await reg.report(dir, 'greedy') : await reg.resolveWithin(dir, 'greedy');
      expect(ok).not.toBeNull();
    }
    const past = path.join(boundary, 'cap', 'one-too-many');
    expect(await reg.report(past, 'greedy')).toBeNull();
    expect(await reg.resolveWithin(past, 'greedy')).toBeNull();
    // Nothing was recorded for the refused one, and another extension is unaffected.
    expect(reg.get(past)).toBeUndefined();
    expect(await reg.report(past, 'modest')).not.toBeNull();
    // Re-reporting one it already named is not a new root.
    expect(await reg.report(path.join(boundary, 'cap', 'r0'), 'greedy')).not.toBeNull();
  });
});

describe('the cap under concurrency, and a clash from another process', () => {
  it(`records at most ${MAX_REPORTED_ROOTS_PER_EXTENSION} of 300 roots named at once`, async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const reg = registry(
      {
        resolveRoot: async (cwd) => cwd,
        checkBoundary: async (dir) => dir,
        exists: async () => true,
        // A real await between the cap check and the record.
        readOriginRepo: () => new Promise((resolve) => setTimeout(() => resolve(null), 1)),
      },
      db
    );
    const dirs = Array.from({ length: 300 }, (_, i) => path.join(boundary, 'burst', `r${i}`));
    const answers = await Promise.all(
      dirs.map((dir, i) => (i % 2 ? reg.report(dir, 'burst') : reg.resolveWithin(dir, 'burst')))
    );
    expect(answers.filter((a) => a !== null)).toHaveLength(MAX_REPORTED_ROOTS_PER_EXTENSION);
    expect(new KnownProjectsStore(db).all()).toHaveLength(MAX_REPORTED_ROOTS_PER_EXTENSION);
    const reporters = new KnownProjectsStore(db).reporters();
    expect(reporters.filter((r) => r.extensionId === 'burst')).toHaveLength(
      MAX_REPORTED_ROOTS_PER_EXTENSION
    );
  });

  it('gives a slot back when recording fails', async () => {
    let fail = true;
    const reg = registry({
      resolveRoot: async (cwd) => cwd,
      checkBoundary: async (dir) => dir,
      exists: async () => true,
    });
    reg.attachStore({
      all: () => [],
      reporters: () => [],
      insert: () => {
        if (fail) throw new Error('disk full');
      },
      update: vi.fn(),
      addReporter: vi.fn(),
    });
    const dirs = Array.from({ length: MAX_REPORTED_ROOTS_PER_EXTENSION }, (_, i) =>
      path.join(boundary, 'slots', `r${i}`)
    );
    await Promise.allSettled(dirs.map((dir) => reg.report(dir, 'slotty')));
    fail = false;
    // Nothing was recorded, so every slot is free again.
    expect(await reg.report(path.join(boundary, 'slots', 'after'), 'slotty')).not.toBeNull();
  });

  it('learns a name another process took on the same database instead of repeating the clash', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const root = repo('home', 'clash', 'dev', 'shared');
    const otherRoot = repo('home', 'clash', 'other', 'shared');
    const here = registry({}, db);
    // Another server process on the same database names a DIFFERENT folder
    // `shared` after this process loaded its rows.
    const elsewhere = registry({}, db);
    await elsewhere.resolve(otherRoot);

    // This process thinks `shared` is free: the insert clashes on the name.
    await expect(here.resolve(root)).rejects.toThrow(/UNIQUE/i);
    // It learned the other process's row, so the next try takes the next name.
    expect(here.get(otherRoot)?.name).toBe('shared');
    expect(await here.resolve(root)).toEqual({ root, name: 'shared~dev' });
  });

  it('adopts the row when another process recorded the same root first', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const root = repo('home', 'race', 'app');
    const here = registry({}, db);
    const elsewhere = registry({}, db);
    await elsewhere.resolve(root);
    expect(await here.resolve(root)).toEqual({ root, name: 'app' });
  });
});

describe('listForExtension', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
  });

  it('answers only projects holding a copy of the extension, or that it reported', async () => {
    const direct = repo('home', 'scope', 'direct');
    folder('home', 'scope', 'direct', '.dork', 'extensions', 'flow');
    const viaPlugin = repo('home', 'scope', 'via-plugin');
    folder(
      'home',
      'scope',
      'via-plugin',
      '.dork',
      'plugins',
      'flow',
      '.dork',
      'extensions',
      'flow'
    );
    const other = repo('home', 'scope', 'other');
    folder('home', 'scope', 'other', '.dork', 'extensions', 'hello');
    const unrelated = repo('home', 'scope', 'unrelated');
    // Only a half-finished install of flow here: the engine's own sibling is no copy.
    folder(
      'home',
      'scope',
      'unrelated',
      '.dork',
      'plugins',
      `flow${MARKETPLACE_STAGE_DIR_MARKER}1`,
      '.dork',
      'extensions',
      'flow'
    );
    const reported = repo('home', 'scope', 'reported');
    const alsoReported = repo('home', 'scope', 'also-reported');

    const reg = registry({}, db);
    for (const root of [direct, viaPlugin, other, unrelated]) await reg.resolve(root);
    await reg.report(reported, 'flow');
    // A second reporter is kept too, not only the first.
    await reg.report(reported, 'hello');
    await reg.report(alsoReported, 'hello');
    await reg.report(alsoReported, 'flow');
    // Resolving is not reporting: it does not widen the extension's list.
    await reg.resolveWithin(unrelated, 'flow');

    const flowList = ['also-reported', 'direct', 'reported', 'via-plugin'];
    const helloList = ['also-reported', 'other', 'reported'];
    expect((await reg.listForExtension('flow')).map((p) => p.name)).toEqual(flowList);
    expect((await reg.listForExtension('hello')).map((p) => p.name)).toEqual(helloList);

    // A restart keeps every reporter, so neither extension loses a root.
    const after = registry({}, db);
    expect((await after.listForExtension('flow')).map((p) => p.name)).toEqual(flowList);
    expect((await after.listForExtension('hello')).map((p) => p.name)).toEqual(helloList);
  });
});

describe('boot order and naming', () => {
  it('never hands out a saved name before the store is attached, once it is attached first', async () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const first = repo('home', 'boot', 'dev', 'dorkos');
    const second = repo('home', 'boot', 'work', 'dorkos');
    // A previous run saved both: /dev/dorkos is `dorkos`, /work/dorkos is `dorkos~work`.
    const before = registry({}, db);
    await before.resolve(first);
    await before.resolve(second);

    // This boot: the store is attached before anything (an extension) asks.
    const reg = registry({}, db);
    expect(await reg.resolveWithin(second, 'flow')).toEqual({
      root: second,
      name: 'dorkos~work',
    });
  });

  it('attaches the store before extensions start (index.ts boot order)', () => {
    const index = readFileSync(path.resolve(import.meta.dirname, '../../../index.ts'), 'utf8');
    const attach = index.indexOf('projectRegistry.attachStore(');
    const extensions = index.indexOf('extensionManager.initialize(');
    expect(attach).toBeGreaterThan(-1);
    expect(extensions).toBeGreaterThan(-1);
    expect(attach).toBeLessThan(extensions);
  });

  it('names a first-boot batch in sorted root order, whatever order git answers in', async () => {
    const roots = ['/b/zeta/app', '/a/alpha/app', '/c/mid/app'];
    const names = async (delays: number[]) => {
      const reg = new ProjectRegistry({
        resolveRoot: (cwd) =>
          new Promise((resolve) => setTimeout(() => resolve(cwd), delays[roots.indexOf(cwd)])),
        peekRoot: () => undefined,
        readOriginRepo: async () => null,
        exists: async () => true,
        checkBoundary: async (dir) => dir,
      });
      await reg.setSources(() => roots);
      return (await reg.list()).map((p) => `${p.root}=${p.name}`);
    };
    const expected = ['/a/alpha/app=app', '/b/zeta/app=app~zeta', '/c/mid/app=app~mid'].sort();
    expect((await names([30, 1, 15])).sort()).toEqual(expected);
    expect((await names([1, 30, 15])).sort()).toEqual(expected);
  });

  it('keeps nothing in memory that storage refused', async () => {
    let full = true;
    const insert = vi.fn((): void => {
      if (full) throw new Error('disk full');
    });
    const reg = registry();
    reg.attachStore({
      all: () => [],
      reporters: () => [],
      insert,
      update: vi.fn(),
      addReporter: vi.fn(),
    });
    const root = repo('home', 'refused', 'app');
    await expect(reg.resolve(root)).rejects.toThrow('disk full');
    expect(reg.get(root)).toBeUndefined();
    // Storage recovers: the root is recorded under the name it would have had.
    full = false;
    expect(await reg.resolve(root)).toEqual({ root, name: 'app' });
  });
});

describe('parseOriginRepo', () => {
  it.each([
    ['https://github.com/dork-labs/dorkos.git', 'dork-labs/dorkos'],
    ['https://github.com/dork-labs/dorkos', 'dork-labs/dorkos'],
    ['https://token@github.com/Dork-Labs/dorkos.git/', 'Dork-Labs/dorkos'],
    ['git@github.com:dork-labs/dorkos.git', 'dork-labs/dorkos'],
    ['ssh://git@github.com/dork-labs/dorkos.git', 'dork-labs/dorkos'],
    ['ssh://git@github.com:22/dork-labs/my.repo.git', 'dork-labs/my.repo'],
    ['  git@github.com:dork-labs/dorkos.git\n', 'dork-labs/dorkos'],
  ])('reads %s as %s', (url, expected) => {
    expect(parseOriginRepo(url)).toBe(expected);
  });

  it.each([
    ['a GitLab remote', 'https://gitlab.com/dork-labs/dorkos.git'],
    ['a self-hosted remote', 'git@git.example.com:dork-labs/dorkos.git'],
    ['a look-alike host', 'https://github.com.evil.io/dork-labs/dorkos'],
    ['a local path', '/Users/kai/repos/dorkos.git'],
    ['a nested path', 'https://github.com/dork-labs/dorkos/tree/main'],
    ['empty output', ''],
  ])('answers null for %s', (_what, url) => {
    expect(parseOriginRepo(url)).toBeNull();
  });
});
