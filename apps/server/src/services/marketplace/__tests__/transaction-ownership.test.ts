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
