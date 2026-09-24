/**
 * The strict rebuild of a legacy install's installed-files record (DOR-2197,
 * DOR-2320): under the install lock, from the installed commit, written only
 * when that commit matches the live files exactly, and never a guess.
 * Real temp trees; the fetcher is a fake at its seam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noopLogger } from '@dorkos/shared/logger';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import { computeInstalledFiles, readInstalledFiles } from '../../installed-files.js';
import { materializePackageSchedules } from '../../materialize-schedules.js';
import { withInstallTargetLock } from '../../../transaction.js';
import { rebuildRecordStrict } from '../strict-record.js';

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

  // Purpose: the rebuild holds the install lock, and re-checks inside it: an
  // update that wrote a record while it waited makes it a no-op.
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
    expect(fetcher.fetchAtCommit).not.toHaveBeenCalled();
    release();
    await holder;

    expect(await pending).toEqual({ outcome: 'not-needed', why: 'has-record' });
    expect(fetcher.fetchAtCommit).not.toHaveBeenCalled();
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
