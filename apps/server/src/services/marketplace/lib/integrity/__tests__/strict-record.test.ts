/**
 * The strict rebuild of a legacy install's installed-files record (DOR-2197,
 * DOR-2320): under the install lock, from the installed commit, written only
 * when that commit matches the live files exactly, and never a guess.
 * Real temp trees; the fetcher is a fake at its seam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import {
  computeInstalledFiles,
  readInstalledFiles,
  writeInstalledFiles,
} from '../../installed-files.js';
import { materializePackageSchedules } from '../../materialize-schedules.js';
import { withInstallTargetLock } from '../../../transaction.js';
import { describeStrictRebuild, rebuildRecordStrict } from '../strict-record.js';

const SHA = 'a'.repeat(40);
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'strict-record-'));
  dirs.push(d);
  return d;
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function tree(files: Record<string, string>): Promise<string> {
  const root = await tmp();
  for (const [p, c] of Object.entries(files)) await put(root, p, c);
  return root;
}

const MANIFEST = JSON.stringify({
  schemaVersion: 1,
  name: 'flow',
  version: '0.7.3',
  type: 'plugin',
  description: 'A plugin installed before records existed',
});

/** The shipped tree at the installed commit. */
function shipped(extra: Record<string, string> = {}): Record<string, string> {
  return {
    '.dork/manifest.json': MANIFEST,
    'skills/a/SKILL.md': '---\nname: a\ndescription: A.\n---\n\nA.\n',
    'commands/go.md': 'go',
    ...extra,
  };
}

/** A legacy install: the shipped files, a sidecar naming its commit, no record. */
async function legacyInstall(
  files: Record<string, string>,
  sidecar: Record<string, unknown> = {}
): Promise<string> {
  const root = path.join(await tmp(), 'flow');
  for (const [p, c] of Object.entries(files)) await put(root, p, c);
  await put(
    root,
    '.dork/install-metadata.json',
    JSON.stringify({
      name: 'flow',
      version: '0.7.3',
      type: 'plugin',
      installedAt: '2026-09-23T00:00:00.000Z',
      commitSha: SHA,
      sourceKey: {
        cloneUrl: 'https://github.com/dork-labs/marketplace',
        subpath: 'plugins/flow',
        ref: 'main',
      },
      ...sidecar,
    })
  );
  return root;
}

function fetcherFor(treePath: string) {
  return {
    fetchAtCommit: vi.fn(async () => ({ path: treePath, commitSha: SHA, fromCache: false })),
  };
}

/** Every file under `root`, path → bytes, so "nothing written" can be asserted exactly. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out[r] = await readFile(path.join(root, r), 'utf8');
      else out[r] = `<${e.isSymbolicLink() ? 'link' : 'special'}>`;
    }
  };
  await walk('');
  return out;
}

describe('rebuildRecordStrict', () => {
  // Purpose: a legacy install that matches its commit exactly gets the record
  // an install of that commit would have written.
  it('writes the record when the installed commit matches the live files', async () => {
    const root = await legacyInstall(shipped());
    await put(root, 'config/mine.json', 'mine');
    const fetcher = fetcherFor(await tree(shipped()));

    const result = await rebuildRecordStrict(root, { fetcher, logger: noopLogger });

    expect(result).toEqual({ outcome: 'rebuilt', files: 3 });
    const record = await readInstalledFiles(root);
    expect(Object.keys(record!.files).sort()).toEqual(Object.keys(shipped()).sort());
    expect(record!.inferred).toBeUndefined();
    expect(record!.package).toMatchObject({ name: 'flow', source: { subpath: 'plugins/flow' } });
    expect(fetcher.fetchAtCommit).toHaveBeenCalledWith({
      packageName: 'flow',
      sourceKey: expect.objectContaining({ subpath: 'plugins/flow' }),
      commitSha: SHA,
    });
  });

  // Purpose (DOR-2318): a skillRef schedule was written into the installed
  // SKILL.md; the fetched tree gets the same injection, so it still matches.
  it('matches a SKILL.md its install wrote a skillRef schedule into', async () => {
    const manifest = JSON.stringify({
      ...JSON.parse(MANIFEST),
      schedules: [{ skillRef: 'a', cron: '0 3 * * *' }],
    });
    const files = shipped({ '.dork/manifest.json': manifest });
    const installedCopy = await tree(files);
    await materializePackageSchedules({
      manifest: MarketplacePackageManifestSchema.parse(JSON.parse(manifest)),
      installPath: installedCopy,
      forms: 'skillRef',
      dorkHome: installedCopy,
      logger: noopLogger,
    });
    const injected = await readFile(path.join(installedCopy, 'skills/a/SKILL.md'), 'utf8');
    const root = await legacyInstall({ ...files, 'skills/a/SKILL.md': injected });

    const result = await rebuildRecordStrict(root, {
      fetcher: fetcherFor(await tree(files)),
      logger: noopLogger,
    });

    expect(result.outcome).toBe('rebuilt');
  });

  // Purpose: one edited or one missing shipped file means DorkOS cannot tell
  // the person's files from the package's, so it writes NOTHING (no guess).
  it.each([
    ['an edited file', async (root: string) => put(root, 'commands/go.md', 'edited')],
    ['a missing file', async (root: string) => rm(path.join(root, 'commands/go.md'))],
  ])('writes nothing on a mismatch (%s)', async (_label, change) => {
    const root = await legacyInstall(shipped());
    await change(root);
    const before = await snapshot(root);

    const result = await rebuildRecordStrict(root, {
      fetcher: fetcherFor(await tree(shipped())),
      logger: noopLogger,
    });

    expect(result).toEqual({ outcome: 'mismatch', differing: ['commands/go.md'] });
    expect(await snapshot(root)).toEqual(before);
  });

  // Purpose: offline (the fetch throws) writes nothing: no byte-matching
  // fallback that could hand a shipped file to the person.
  it('writes nothing when the fetch fails', async () => {
    const root = await legacyInstall(shipped());
    const before = await snapshot(root);
    const fetcher = {
      fetchAtCommit: vi.fn(async () => Promise.reject(new Error('could not resolve host'))),
    };

    const result = await rebuildRecordStrict(root, { fetcher, logger: noopLogger });

    expect(result).toEqual({ outcome: 'fetch-failed', message: 'could not resolve host' });
    expect(await snapshot(root)).toEqual(before);
  });

  // Purpose: an install with no commit to fetch (a local-path install) cannot
  // be rebuilt; nothing is fetched or written.
  it('reports no-source for an install with no recorded commit', async () => {
    const root = await legacyInstall(shipped(), { commitSha: undefined, sourceKey: undefined });
    const fetcher = fetcherFor(await tree(shipped()));
    const before = await snapshot(root);

    expect(await rebuildRecordStrict(root, { fetcher, logger: noopLogger })).toEqual({
      outcome: 'no-source',
    });
    expect(fetcher.fetchAtCommit).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(before);
  });

  // Purpose: only a legacy install is rebuilt: one with a record, a folder with
  // no package in it, and a linked install are left alone.
  it('leaves installs that need no rebuild alone', async () => {
    const fetcher = fetcherFor(await tree(shipped()));
    const deps = { fetcher, logger: noopLogger };

    const recorded = await legacyInstall(shipped());
    await put(recorded, '.dork/installed-files.json', '{}');
    expect(await rebuildRecordStrict(recorded, deps)).toEqual({
      outcome: 'not-needed',
      why: 'has-record',
    });

    const leftovers = path.join(await tmp(), 'leftovers');
    await put(leftovers, 'config/mine.json', 'mine');
    expect(await rebuildRecordStrict(leftovers, deps)).toEqual({
      outcome: 'not-needed',
      why: 'not-installed',
    });

    const target = await legacyInstall(shipped());
    const link = path.join(await tmp(), 'linked');
    await symlink(target, link);
    expect(await rebuildRecordStrict(link, deps)).toEqual({ outcome: 'not-needed', why: 'linked' });
    expect(fetcher.fetchAtCommit).not.toHaveBeenCalled();
  });

  // Purpose: the rebuild writes under the install lock, and re-checks inside
  // it: an update that wrote a record while it waited makes it a no-op, and
  // the update's record is left as it wrote it.
  it('waits for the install lock and re-checks the install inside it', async () => {
    const root = await legacyInstall(shipped());
    const fetcher = fetcherFor(await tree(shipped()));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = withInstallTargetLock(root, async () => {
      await held;
      // An update landing meanwhile writes the record.
      await put(root, '.dork/installed-files.json', '{"written":"by the update"}');
    });

    const pending = rebuildRecordStrict(root, { fetcher, logger: noopLogger });
    await new Promise((r) => setTimeout(r, 30));
    release();
    await holder;

    expect(await pending).toEqual({ outcome: 'not-needed', why: 'has-record' });
    expect(await readFile(path.join(root, '.dork/installed-files.json'), 'utf8')).toContain(
      'by the update'
    );
  });

  // Purpose: a file the package marks as the person's to edit may differ; it
  // is recorded with the package's hash and verifies as customized later.
  it('rebuilds when only an editable file differs', async () => {
    const manifest = JSON.stringify({
      ...JSON.parse(MANIFEST),
      userEditable: ['config/defaults.json'],
    });
    const files = shipped({ '.dork/manifest.json': manifest, 'config/defaults.json': '{}' });
    const root = await legacyInstall({ ...files, 'config/defaults.json': '{"mine":true}' });

    const result = await rebuildRecordStrict(root, {
      fetcher: fetcherFor(await tree(files)),
      logger: noopLogger,
    });

    expect(result.outcome).toBe('rebuilt');
    const expected = await computeInstalledFiles(await tree(files), {
      identity: { name: 'flow', type: 'plugin' },
      userEditable: ['config/defaults.json'],
      npmRan: false,
    });
    const record = await readInstalledFiles(root);
    expect(record!.files['config/defaults.json']).toBe(expected.files['config/defaults.json']);
    expect(record!.userEditable).toEqual(['config/defaults.json']);
  });

  // Purpose: when npm ran for the install, `node_modules` and the lockfile npm
  // rewrote are the install's own (owned paths), not shipped files: a lockfile
  // that differs from the commit's is not a mismatch. Without node_modules the
  // shipped lockfile is an ordinary file.
  it('treats the lockfile as owned only when npm ran', async () => {
    const files = shipped({
      'package.json': '{"dependencies":{}}',
      'package-lock.json': 'shipped',
    });
    const withNpm = await legacyInstall({ ...files, 'package-lock.json': 'rewritten by npm' });
    await put(withNpm, 'node_modules/dep/index.js', 'x');
    expect(
      await rebuildRecordStrict(withNpm, {
        fetcher: fetcherFor(await tree(files)),
        logger: noopLogger,
      })
    ).toMatchObject({ outcome: 'rebuilt' });
    const owned = await readInstalledFiles(withNpm);
    expect(owned!.ownedPaths).toEqual(['node_modules', 'package-lock.json']);
    expect(owned!.files['package-lock.json']).toBeUndefined();

    const withoutNpm = await legacyInstall(files);
    await rebuildRecordStrict(withoutNpm, {
      fetcher: fetcherFor(await tree(files)),
      logger: noopLogger,
    });
    const plain = await readInstalledFiles(withoutNpm);
    expect(plain!.ownedPaths).toEqual([]);
    expect(plain!.files['package-lock.json']).toBeDefined();
  });

  // Purpose (review 1): the rebuild must also prove the live folder holds
  // nothing extra where a package keeps what it runs. An extra skill (a newer
  // version's file copied in, or the person's own) would otherwise be recorded
  // as neither, and the install would verify clean while it runs.
  it('writes nothing when the live folder has extra files where a package keeps what it runs', async () => {
    const root = await legacyInstall({
      ...shipped(),
      'skills/b/SKILL.md': '---\nname: b\ndescription: B.\n---\n\nB.\n',
    });
    const before = await snapshot(root);

    const result = await rebuildRecordStrict(root, {
      fetcher: fetcherFor(await tree(shipped())),
      logger: noopLogger,
    });

    expect(result).toEqual({ outcome: 'mismatch', differing: ['skills/b/SKILL.md'] });
    expect(await snapshot(root)).toEqual(before);
  });

  // Purpose (review 1, S5): on a case-insensitive volume a fetched
  // `commands/Go.md` matches a live `commands/go.md`; the live spelling is then
  // an unrecorded file under an effect path, so it is a mismatch, not a match.
  it('treats a case-only difference as a mismatch', async () => {
    const files = { ...shipped(), 'commands/go.md': undefined as unknown as string };
    delete (files as Record<string, string | undefined>)['commands/go.md'];
    const root = await legacyInstall({ ...files, 'commands/go.md': 'go' });
    const fetched = await tree({ ...files, 'commands/Go.md': 'go' });

    const result = await rebuildRecordStrict(root, {
      fetcher: fetcherFor(fetched),
      logger: noopLogger,
    });

    expect(result.outcome).toBe('mismatch');
    expect(await readInstalledFiles(root)).toBeNull();
  });

  // Purpose (review 2, S2/S4): an older manifest's userEditable entry the
  // schema now refuses (`skills/**`, `**`) is not trusted, so an edited skill
  // is a mismatch rather than a "customized" file under a bogus rule.
  it.each([['skills/**'], ['**']])(
    'ignores a userEditable entry the schema refuses (%s)',
    async (entry) => {
      const manifest = JSON.stringify({ ...JSON.parse(MANIFEST), userEditable: [entry] });
      const files = shipped({ '.dork/manifest.json': manifest });
      const root = await legacyInstall({ ...files, 'skills/a/SKILL.md': 'EVIL' });

      const result = await rebuildRecordStrict(root, {
        fetcher: fetcherFor(await tree(files)),
        logger: noopLogger,
      });

      expect(result).toEqual({ outcome: 'mismatch', differing: ['skills/a/SKILL.md'] });
    }
  );

  // Purpose (review 8): the fetch and the staging run before the lock is
  // taken, so a slow network never holds up an install of the same package.
  it('fetches before taking the install lock', async () => {
    const root = await legacyInstall(shipped());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = withInstallTargetLock(root, () => held);
    const fetcher = fetcherFor(await tree(shipped()));

    const pending = rebuildRecordStrict(root, { fetcher, logger: noopLogger });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetcher.fetchAtCommit).toHaveBeenCalledTimes(1);
    release();
    await holder;
    expect((await pending).outcome).toBe('rebuilt');
  });

  // Purpose (review 2, item 5): an older DorkOS sharing this data directory
  // does not honour the install lock. If it reinstalled the package while the
  // fetch ran, the sidecar names another commit: the fetched tree is no longer
  // the installed one, so nothing is written.
  it('writes nothing when the sidecar names another commit by the time the lock is held', async () => {
    const root = await legacyInstall(shipped());
    const fetched = await tree(shipped());
    const fetcher = {
      fetchAtCommit: vi.fn(async () => {
        const sidecar = path.join(root, '.dork/install-metadata.json');
        const meta = JSON.parse(await readFile(sidecar, 'utf8'));
        await writeFile(sidecar, JSON.stringify({ ...meta, commitSha: 'b'.repeat(40) }));
        return { path: fetched, commitSha: SHA, fromCache: false };
      }),
    };

    const result = await rebuildRecordStrict(root, { fetcher, logger: noopLogger });

    expect(result).toEqual({ outcome: 'mismatch', differing: ['.dork/install-metadata.json'] });
    expect(await readInstalledFiles(root)).toBeNull();
  });

  // Purpose: a FIFO or a symlink at a recorded path is not the recorded file,
  // and is never opened (a FIFO would block the lock forever).
  it(
    'treats a FIFO or a symlink at a recorded path as a mismatch without reading it',
    { timeout: 10_000 },
    async () => {
      const root = await legacyInstall(shipped());
      await rm(path.join(root, 'commands/go.md'));
      execFileSync('mkfifo', [path.join(root, 'commands/go.md')]);
      await rm(path.join(root, 'skills/a/SKILL.md'));
      await symlink('/dev/zero', path.join(root, 'skills/a/SKILL.md'));

      const result = await rebuildRecordStrict(root, {
        fetcher: fetcherFor(await tree(shipped())),
        logger: noopLogger,
      });

      expect(result).toEqual({
        outcome: 'mismatch',
        differing: ['commands/go.md', 'skills/a/SKILL.md'],
      });
      expect(await readInstalledFiles(root)).toBeNull();
    }
  );
});

describe('Check files after a rebuild that could not prove everything (DOR-2322)', () => {
  /** A recorded install of `files` whose record lists `unproven` kept files. */
  async function recordedWithUnproven(
    files: Record<string, string>,
    kept: Record<string, string>,
    unproven: Record<string, string>,
    from = true
  ): Promise<string> {
    const root = path.join(await tmp(), 'flow');
    for (const [p, c] of Object.entries(files)) await put(root, p, c);
    const record = await computeInstalledFiles(root, {
      identity: { name: 'flow', type: 'plugin' },
      userEditable: [],
      npmRan: false,
    });
    for (const [p, c] of Object.entries(kept)) await put(root, p, c);
    await writeInstalledFiles(root, {
      ...record,
      unproven: {
        why: 'fetch-failed',
        ...(from && {
          from: {
            name: 'flow',
            commitSha: SHA,
            sourceKey: {
              cloneUrl: 'https://github.com/dork-labs/marketplace',
              subpath: 'plugins/flow',
              ref: 'main',
            },
          },
        }),
        files: unproven,
      },
    });
    return root;
  }

  // Purpose: an older install recorded only by guessing is not recorded yet:
  // Check files and the sweep run the strict rebuild on it and replace the
  // guess with an exact record. Fails if an inferred record reads "already checked".
  it('rebuilds an inferred record strictly', async () => {
    const root = await legacyInstall(shipped());
    const guess = await computeInstalledFiles(root, {
      identity: { name: 'flow', type: 'plugin' },
      userEditable: [],
      npmRan: false,
    });
    await writeInstalledFiles(root, { ...guess, files: {}, inferred: true });

    const result = await rebuildRecordStrict(root, {
      fetcher: fetcherFor(await tree(shipped())),
      logger: noopLogger,
    });

    expect(result).toEqual({ outcome: 'rebuilt', files: 3 });
    const record = await readInstalledFiles(root);
    expect(record?.inferred).toBeUndefined();
    expect(Object.keys(record!.files).sort()).toEqual(Object.keys(shipped()).sort());
  });

  // Purpose: THE re-verification (review 2: set aside, never delete). A kept
  // file whose bytes are exactly the old version's copy, and which the current
  // version does not ship, is a leftover an online update would have replaced:
  // it is moved to a free `<path>.dork-old` name, with its execute bits
  // cleared, so it stops running and nothing is lost. One already under a
  // set-aside name stays put. A file with other bytes is the person's and
  // stays; so does one the current version ships. The list is then dropped.
  // Fails if anything is deleted, a leftover stays where it runs, a person's
  // file moves, or the list stays.
  it('sets proven leftovers aside, keeps the rest as yours, and drops the list', async () => {
    const old = await tree({
      'old.md': 'old v1',
      'a.md': 'a v1',
      'skills/b/SKILL.md': 'b v1',
      'skills/gone/SKILL.md': 'gone skill',
      'bin/tool': 'tool v1',
      'settings.json': 'same default',
    });
    // settings.json: the current version ships it too, with the same bytes as
    // the earlier one (an editable file the update kept in place). It is the
    // package's own file now, so it is never moved.
    const root = await recordedWithUnproven(
      {
        '.dork/manifest.json': MANIFEST,
        'a.md': 'a v2',
        'skills/b/SKILL.md': 'b v2',
        'settings.json': 'same default',
      },
      {
        'old.md': 'old v1',
        'old.md.dork-old': 'an older copy the person kept',
        'a.md.dork-old': 'a v1',
        'mine.txt': 'mine',
        'skills/b/SKILL.md.dork-old': 'b edited',
        'skills/gone/SKILL.md': 'gone skill',
        'bin/tool': 'tool v1',
      },
      {
        'old.md': 'old.md',
        'a.md.dork-old': 'a.md',
        'mine.txt': 'mine.txt',
        'skills/b/SKILL.md.dork-old': 'skills/b/SKILL.md',
        'skills/gone/SKILL.md': 'skills/gone/SKILL.md',
        'bin/tool': 'bin/tool',
        'a.md': 'a.md',
        'settings.json': 'settings.json',
      }
    );
    await chmod(path.join(root, 'bin', 'tool'), 0o755);
    const before = await snapshot(root);

    const result = await rebuildRecordStrict(
      root,
      { fetcher: fetcherFor(old), logger: noopLogger },
      { sortUnproven: true }
    );

    expect(result).toEqual({
      outcome: 'sorted',
      setAside: [
        { path: 'a.md.dork-old', savedAs: 'a.md.dork-old' },
        { path: 'bin/tool', savedAs: 'bin/tool.dork-old' },
        { path: 'old.md', savedAs: 'old.md.dork-old.2' },
        { path: 'skills/gone/SKILL.md', savedAs: 'skills/gone/SKILL.md.dork-old' },
      ],
      kept: ['a.md', 'mine.txt', 'settings.json', 'skills/b/SKILL.md.dork-old'],
    });
    const after = await snapshot(root);
    // Nothing is lost: every file that was there is still there (the record,
    // which drops its list, aside).
    const RECORD = '.dork/installed-files.json';
    const contents = (tree: Record<string, string>) =>
      Object.entries(tree)
        .filter(([p]) => p !== RECORD)
        .map(([, c]) => c)
        .sort();
    expect(contents(after)).toEqual(contents(before));
    expect(after['old.md']).toBeUndefined();
    expect(after['old.md.dork-old.2']).toBe('old v1');
    expect(after['old.md.dork-old']).toBe('an older copy the person kept');
    expect(after['skills/gone/SKILL.md']).toBeUndefined();
    expect(after['bin/tool']).toBeUndefined();
    expect((await stat(path.join(root, 'bin', 'tool.dork-old'))).mode & 0o111).toBe(0);
    expect(after['mine.txt']).toBe('mine');
    expect(after['a.md']).toBe('a v2');
    expect(after['settings.json']).toBe('same default');
    expect((await readInstalledFiles(root))?.unproven).toBeUndefined();
  });

  // Purpose: the list is re-read under the install lock. If an update wrote a
  // new record while the earlier version was being fetched, nothing is
  // removed on the strength of the old list. Fails without the re-check.
  it('removes nothing when the record changed while the earlier version was fetched', async () => {
    const root = await recordedWithUnproven(
      { '.dork/manifest.json': MANIFEST },
      { 'old.md': 'old v1' },
      { 'old.md': 'old.md' }
    );
    const earlier = await tree({ 'old.md': 'old v1' });
    const fetcher = {
      fetchAtCommit: vi.fn(async () => {
        // An update lands meanwhile and records the file as the package's.
        const now = await readInstalledFiles(root);
        const { unproven: _gone, ...rest } = now!;
        await writeInstalledFiles(root, rest);
        return { path: earlier, commitSha: SHA, fromCache: false };
      }),
    };

    const result = await rebuildRecordStrict(
      root,
      { fetcher, logger: noopLogger },
      { sortUnproven: true }
    );

    expect(result).toEqual({ outcome: 'not-needed', why: 'has-record' });
    expect(await readFile(path.join(root, 'old.md'), 'utf8')).toBe('old v1');
  });

  // Purpose: sorting removes files, so only a person's Check files does it.
  // The sweep after boot (no `sortUnproven`) leaves them exactly as they are.
  it('never sorts kept files unless asked to', async () => {
    const root = await recordedWithUnproven(
      { '.dork/manifest.json': MANIFEST },
      { 'old.md': 'old v1' },
      { 'old.md': 'old.md' }
    );
    const before = await snapshot(root);
    const fetcher = fetcherFor(await tree({ 'old.md': 'old v1' }));

    const result = await rebuildRecordStrict(root, { fetcher, logger: noopLogger });

    expect(result).toEqual({ outcome: 'not-needed', why: 'has-record' });
    expect(fetcher.fetchAtCommit).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(before);
  });

  // Purpose: with nothing to compare against, nothing is removed and the list
  // stays, and the answer says why in words that fit kept files.
  it('removes nothing when the old version cannot be fetched, or there is none', async () => {
    const offline = await recordedWithUnproven(
      { '.dork/manifest.json': MANIFEST },
      { 'old.md': 'old v1' },
      { 'old.md': 'old.md' }
    );
    const before = await snapshot(offline);
    const failed = await rebuildRecordStrict(
      offline,
      {
        fetcher: { fetchAtCommit: vi.fn(async () => Promise.reject(new Error('offline'))) },
        logger: noopLogger,
      },
      { sortUnproven: true }
    );
    expect(failed).toEqual({ outcome: 'fetch-failed', message: 'offline', unproven: true });
    expect(await snapshot(offline)).toEqual(before);

    const local = await recordedWithUnproven(
      { '.dork/manifest.json': MANIFEST },
      { 'old.md': 'old v1' },
      { 'old.md': 'old.md' },
      false
    );
    const noSource = await rebuildRecordStrict(
      local,
      { fetcher: { fetchAtCommit: vi.fn() }, logger: noopLogger },
      { sortUnproven: true }
    );
    expect(noSource).toEqual({ outcome: 'no-source', unproven: true });
    expect((await readInstalledFiles(local))?.unproven?.files).toEqual({ 'old.md': 'old.md' });

    expect(describeStrictRebuild('flow', failed)).toBe(
      "Couldn't fetch the version of flow you had before (offline), so the files it kept stay as they are. Try again when you're online."
    );
    expect(describeStrictRebuild('flow', noSource)).toBe(
      "flow was installed from a folder on this computer, so there's no earlier version to sort the files it kept against. Delete any you don't need."
    );
  });

  // Purpose: the answer a person reads after sorting says what went and what stayed.
  it('says what sorting set aside, where, and what it kept', () => {
    expect(
      describeStrictRebuild('flow', {
        outcome: 'sorted',
        setAside: [
          { path: 'old.md', savedAs: 'old.md.dork-old' },
          { path: 'x.dork-old', savedAs: 'x.dork-old' },
        ],
        kept: ['c'],
      })
    ).toBe(
      'Checked the files flow kept: set aside 2 left over from the version you had before (old.md.dork-old, x.dork-old), and kept 1 as yours.'
    );
    expect(describeStrictRebuild('flow', { outcome: 'sorted', setAside: [], kept: ['c'] })).toBe(
      'Checked the files flow kept: the 1 file is yours, so it stays.'
    );
    expect(
      describeStrictRebuild('flow', {
        outcome: 'sorted',
        setAside: [{ path: 'a', savedAs: 'a.dork-old' }],
        kept: [],
      })
    ).toBe(
      'Checked the files flow kept: set aside 1 left over from the version you had before (a.dork-old).'
    );
  });
});
