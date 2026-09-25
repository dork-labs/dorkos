/**
 * The transaction's ownership half (DOR-2245, spec §4): the installed-files
 * record, the carry-over of a person's files from the live target, the staging
 * dir beside the target, and the late-write pass. Real temp directories, a
 * real `atomicMove` activation, like the install flows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PackageFileNotice } from '@dorkos/shared/marketplace-schemas';
import { runTransaction, type TransactionOwnership } from '../transaction.js';
import { atomicMove } from '../lib/atomic-move.js';
import { readInstalledFiles } from '../lib/installed-files.js';
import { rebuildInstalledFiles } from '../lib/legacy-record.js';
import { noopLogger } from '@dorkos/shared/logger';

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'tx-ownership-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function read(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
}

/** Install `files` as a package at `target` through the real transaction. */
async function install(
  target: string,
  files: Record<string, string>,
  opts: {
    userEditable?: string[];
    duringActivate?: (target: string) => Promise<void>;
    failActivate?: boolean;
    source?: TransactionOwnership['identity']['source'];
    rebuildLegacy?: TransactionOwnership['rebuildLegacy'];
  } = {}
): Promise<{ notices: PackageFileNotice[]; warnings: string[]; stagingPaths: string[] }> {
  const report = {
    notices: [] as PackageFileNotice[],
    warnings: [] as string[],
    stagingPaths: [] as string[],
  };
  await runTransaction({
    name: 'pkg',
    target,
    stage: async ({ path: staging }) => {
      report.stagingPaths.push(staging);
      await put(staging, '.dork/manifest.json', '{"name":"pkg"}');
      for (const [rel, content] of Object.entries(files)) await put(staging, rel, content);
    },
    activate: async ({ path: staging }) => {
      await atomicMove(staging, target);
      await opts.duringActivate?.(target);
      if (opts.failActivate) throw new Error('activate failed');
    },
    ownership: {
      identity: { name: 'pkg', type: 'plugin', ...(opts.source && { source: opts.source }) },
      userEditable: opts.userEditable ?? [],
      ...(opts.rebuildLegacy && { rebuildLegacy: opts.rebuildLegacy }),
      onNotices: (n, w) => {
        report.notices.push(...n);
        report.warnings.push(...w);
      },
    },
  });
  return report;
}

describe('runTransaction ownership (DOR-2245)', () => {
  // Purpose: the record lands inside the activated target, listing shipped files only.
  it('writes the installed-files record into the new install', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'skills/a/SKILL.md': 'a' });
    const record = await readInstalledFiles(target);
    expect(Object.keys(record!.files).sort()).toEqual(['.dork/manifest.json', 'skills/a/SKILL.md']);
  });

  // Purpose: stage on the target's filesystem, beside it, not in os.tmpdir().
  it('stages in a sibling of the target that it removes afterwards', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    const { stagingPaths } = await install(target, {});
    expect(path.dirname(stagingPaths[0])).toBe(path.dirname(target));
    expect(path.basename(stagingPaths[0])).toContain('.dorkos-stage-');
    expect(await readdir(path.dirname(target))).toEqual(['pkg']);
  });

  // Purpose: THE bug. A reinstall keeps a file the person added (flow's config).
  it("keeps the person's own files across a reinstall, and replaces the package's", async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'skills/a/SKILL.md': 'v1', 'config/config.example.json': '{}' });
    await put(target, 'config/config.json', '{"team":"DOR"}');
    await put(target, '.dork/data/state.json', '{"n":1}');

    await install(target, { 'skills/a/SKILL.md': 'v2', 'config/config.example.json': '{}' });

    expect(await read(target, 'config/config.json')).toBe('{"team":"DOR"}');
    expect(await read(target, '.dork/data/state.json')).toBe('{"n":1}');
    expect(await read(target, 'skills/a/SKILL.md')).toBe('v2');
    const record = await readInstalledFiles(target);
    expect(record!.files['config/config.json']).toBeUndefined();
  });

  // Purpose: an edited shipped file is replaced and the edit saved (row 5), with a notice.
  it('saves an edited shipped file as .dork-old and reports it', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'skills/a/SKILL.md': 'v1' });
    await put(target, 'skills/a/SKILL.md', 'mine');

    const { notices } = await install(target, { 'skills/a/SKILL.md': 'v2' });

    expect(await read(target, 'skills/a/SKILL.md')).toBe('v2');
    expect(await read(target, 'skills/a/SKILL.md.dork-old')).toBe('mine');
    expect(notices).toEqual([
      {
        path: 'skills/a/SKILL.md',
        outcome: 'replaced-edit',
        savedAs: 'skills/a/SKILL.md.dork-old',
      },
    ]);
  });

  // Purpose: a failed activation leaves the old install exactly as it was,
  // person files included, and no sibling behind.
  it('restores the live install byte-for-byte when activation fails after carrying', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'skills/a/SKILL.md': 'v1' });
    await put(target, 'config/config.json', 'mine');
    const before = await snapshotTree(target);

    await expect(
      install(target, { 'skills/a/SKILL.md': 'v2' }, { failActivate: true })
    ).rejects.toThrow('activate failed');

    expect(await snapshotTree(target)).toEqual(before);
    expect(await readdir(path.dirname(target))).toEqual(['pkg']);
  });

  // Purpose: the late-write pass brings over a file written during the update (N6/B).
  it('brings over a file written into the old install while the update ran', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'skills/a/SKILL.md': 'v1' });
    await put(target, 'notes/one.md', 'before');

    const { notices } = await install(
      target,
      { 'skills/a/SKILL.md': 'v2' },
      {
        duringActivate: async () => {
          const backup = (await readdir(path.dirname(target))).find((n) =>
            n.includes('.dorkos-bak-')
          )!;
          const backupRoot = path.join(path.dirname(target), backup);
          await put(backupRoot, 'notes/one.md', 'during');
          await put(backupRoot, 'notes/two.md', 'new');
          await rm(path.join(backupRoot, 'config.txt'), { force: true });
        },
      }
    );

    expect(await read(target, 'notes/one.md')).toBe('during');
    expect(await read(target, 'notes/two.md')).toBe('new');
    expect(
      notices
        .filter((n) => n.outcome === 'late-write')
        .map((n) => n.path)
        .sort()
    ).toEqual(['notes/one.md', 'notes/two.md']);
  });

  // Purpose (N6): an untouched update raises no late-write and writes no .dork-old.
  it('reports nothing for an update over an untouched install', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'skills/a/SKILL.md': 'v1', 'b.md': 'b' });
    await put(target, 'config.json', 'mine');
    const { notices } = await install(target, { 'skills/a/SKILL.md': 'v2', 'b.md': 'b2' });
    expect(notices).toEqual([]);
    const all = await snapshotTree(target);
    expect(Object.keys(all).some((p) => p.includes('.dork-old'))).toBe(false);
  });

  // Purpose: a file deleted from the old install during the update stays deleted.
  it('honours a deletion made during the update', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'a.md': 'v1' });
    await put(target, 'scratch.txt', 'x');
    await install(
      target,
      { 'a.md': 'v2' },
      {
        duringActivate: async () => {
          const backup = (await readdir(path.dirname(target))).find((n) =>
            n.includes('.dorkos-bak-')
          )!;
          await rm(path.join(path.dirname(target), backup, 'scratch.txt'));
        },
      }
    );
    expect(await read(target, 'scratch.txt')).toBeNull();
  });

  // Purpose (code review 7, M16): the late pass replaces or deletes a target
  // entry only while it is still the untouched clone. A write into the NEW
  // install after activation wins; the late write is saved beside it, and a
  // late deletion does not delete it.
  it('never overwrites or deletes a target entry changed after activation', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'a.md': 'v1' });
    await put(target, 'notes/one.md', 'before');
    await put(target, 'scratch.txt', 'x');
    await install(
      target,
      { 'a.md': 'v2' },
      {
        duringActivate: async () => {
          const backup = (await readdir(path.dirname(target))).find((n) =>
            n.includes('.dorkos-bak-')
          )!;
          const backupRoot = path.join(path.dirname(target), backup);
          await put(backupRoot, 'notes/one.md', 'during, in the old install');
          await rm(path.join(backupRoot, 'scratch.txt'));
          await put(target, 'notes/one.md', 'written into the new install');
          await put(target, 'scratch.txt', 'kept by the new install');
        },
      }
    );
    expect(await read(target, 'notes/one.md')).toBe('written into the new install');
    expect(await read(target, 'notes/one.md.dork-old')).toBe('during, in the old install');
    expect(await read(target, 'scratch.txt')).toBe('kept by the new install');
  });

  // Purpose (code review 7, M15): a late write can keep size and mtime (an
  // editor that writes a temp file, restores the time and renames it over);
  // the inode is what still tells it apart, so it must be compared.
  it('brings over a same-size rename-over whose mtime was restored', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'a.md': 'v1' });
    await put(target, 'notes/one.md', 'AAAA');
    const { rename, utimes } = await import('node:fs/promises');
    const when = new Date('2021-05-06T07:08:09Z');
    await utimes(path.join(target, 'notes', 'one.md'), when, when);
    await install(
      target,
      { 'a.md': 'v2' },
      {
        duringActivate: async () => {
          const backup = (await readdir(path.dirname(target))).find((n) =>
            n.includes('.dorkos-bak-')
          )!;
          const file = path.join(path.dirname(target), backup, 'notes', 'one.md');
          await writeFile(`${file}.tmp`, 'BBBB');
          await utimes(`${file}.tmp`, when, when);
          await rename(`${file}.tmp`, file);
        },
      }
    );
    expect(await read(target, 'notes/one.md')).toBe('BBBB');
  });

  // Purpose: a carried file keeps its timestamps (utimes after the clone).
  it('keeps the mtime of a carried file', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'a.md': 'v1' });
    await put(target, 'mine.txt', 'x');
    const old = new Date('2020-01-02T03:04:05Z');
    const { utimes } = await import('node:fs/promises');
    await utimes(path.join(target, 'mine.txt'), old, old);
    await install(target, { 'a.md': 'v2' });
    expect((await lstat(path.join(target, 'mine.txt'))).mtime.getTime()).toBe(old.getTime());
  });

  // Purpose: a same-named package from another source is warned about.
  it('warns when the kept files came from a different source', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, {}, { source: { cloneUrl: 'https://a/x', subpath: '', ref: 'main' } });
    await put(target, 'mine.txt', 'x');
    const same = await install(
      target,
      {},
      { source: { cloneUrl: 'https://a/x', subpath: '', ref: 'v2' } }
    );
    expect(same.warnings).toEqual([]);
    const other = await install(
      target,
      {},
      { source: { cloneUrl: 'https://b/y', subpath: '', ref: 'main' } }
    );
    expect(other.warnings[0]).toMatch(/Files kept from the earlier pkg/);
  });

  // Purpose: a linked install (a symlink to a working copy) is never walked.
  it('never carries anything out of a linked install', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'tx-work-'));
    try {
      await put(work, 'secret.txt', 'dev tree');
      const target = path.join(scratch, 'plugins', 'pkg');
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(work, target);
      await install(target, { 'a.md': 'v1' });
      expect(await read(target, 'secret.txt')).toBeNull();
      expect(await read(work, 'secret.txt')).toBe('dev tree');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  // Purpose: without ownership (the Shape fork) nothing changes: tmpdir staging, no record.
  it('leaves a transaction without ownership exactly as before', async () => {
    const target = path.join(scratch, 'fork');
    let staged = '';
    await runTransaction({
      name: 'fork',
      target,
      stage: async ({ path: p }) => {
        staged = p;
        await put(p, 'a', 'a');
      },
      activate: async ({ path: p }) => {
        await cp(p, target, { recursive: true });
      },
    });
    expect(staged.startsWith(tmpdir())).toBe(true);
    expect(await readInstalledFiles(target)).toBeNull();
  });
});

/** Every file under `root`, path → content. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out[child] = await readFile(path.join(root, child), 'utf8');
    }
  };
  await walk('');
  return out;
}

describe('an offline update of an install made before records existed (DOR-2322)', () => {
  const SHA = 'b'.repeat(40);

  /** A legacy install at `target`: the package's files, a sidecar naming its commit, no record. */
  async function legacyAt(target: string, files: Record<string, string>): Promise<void> {
    await put(target, '.dork/manifest.json', '{"name":"pkg"}');
    for (const [rel, content] of Object.entries(files)) await put(target, rel, content);
    await put(
      target,
      '.dork/install-metadata.json',
      JSON.stringify({
        name: 'pkg',
        version: '1.0.0',
        type: 'plugin',
        installedAt: '2026-09-01T00:00:00.000Z',
        commitSha: SHA,
        sourceKey: { cloneUrl: 'https://github.com/acme/pkg', subpath: '', ref: 'main' },
      })
    );
  }

  const offline: TransactionOwnership['rebuildLegacy'] = (liveRoot, stagedTree) =>
    rebuildInstalledFiles(
      liveRoot,
      {
        fetcher: { fetchAtCommit: vi.fn(async () => Promise.reject(new Error('offline'))) },
        logger: noopLogger,
      },
      stagedTree
    );

  // Purpose: THE decision. Offline, a file the package changed between
  // versions and a file the person added both match nothing. Neither may be
  // deleted or silently called theirs: each is kept, named on a notice (the
  // package's changed file saved beside the new copy), and one plain warning
  // says what to do. Fails if an unproven file gets the "you had changed"
  // wording, is dropped, or goes unnamed.
  it('keeps every file it cannot prove, names each one, and says what to do', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await legacyAt(target, { 'a.md': 'a v1', 'same.md': 'same' });
    await put(target, 'keep.txt', 'mine');

    const { notices, warnings } = await install(
      target,
      { 'a.md': 'a v2', 'same.md': 'same' },
      { rebuildLegacy: offline }
    );

    expect(await read(target, 'a.md')).toBe('a v2');
    expect(await read(target, 'a.md.dork-old')).toBe('a v1');
    expect(await read(target, 'keep.txt')).toBe('mine');
    expect(notices).toEqual([
      { path: 'a.md', outcome: 'kept-unproven', savedAs: 'a.md.dork-old' },
      { path: 'keep.txt', outcome: 'kept-unproven' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/couldn't download the version of pkg you had/);
    expect(warnings[0]).toMatch(/2 files/);
    expect(warnings[0]).toMatch(/a\.md\.dork-old, keep\.txt/);
    expect(warnings[0]).toMatch(/Check files/);
  });

  // Purpose: the new install remembers what it could not prove, where each
  // file now sits and which version to compare it with, so the Installed view
  // keeps reminding the person and Check files can sort it once online.
  it('records the kept files and the version to compare them with', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await legacyAt(target, { 'a.md': 'a v1' });
    await put(target, 'notes/keep.txt', 'mine');

    await install(target, { 'a.md': 'a v2' }, { rebuildLegacy: offline });

    const record = await readInstalledFiles(target);
    expect(record?.inferred).toBeUndefined();
    expect(record?.unproven).toEqual({
      why: 'fetch-failed',
      from: {
        name: 'pkg',
        commitSha: SHA,
        sourceKey: { cloneUrl: 'https://github.com/acme/pkg', subpath: '', ref: 'main' },
      },
      files: { 'a.md.dork-old': 'a.md', 'notes/keep.txt': 'notes/keep.txt' },
    });
  });

  // Purpose: a proven record changes nothing: no unproven notices, no warning,
  // no list on the new record. Fails if the new wording leaks into a normal update.
  it('says nothing new when the record was proven', async () => {
    const target = path.join(scratch, 'plugins', 'pkg');
    await install(target, { 'a.md': 'a v1' });
    await put(target, 'keep.txt', 'mine');

    const { notices, warnings } = await install(target, { 'a.md': 'a v2' });

    expect(notices).toEqual([]);
    expect(warnings).toEqual([]);
    expect((await readInstalledFiles(target))?.unproven).toBeUndefined();
  });
});
