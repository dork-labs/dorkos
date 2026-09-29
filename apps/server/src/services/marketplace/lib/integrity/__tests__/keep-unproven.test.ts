/**
 * "Keep these as mine" (DOR-2341): a person claims the files an update kept
 * but nothing could sort. Bound to exactly the files, bytes and version they
 * were shown; moves and deletes nothing. Real temp trees.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
import {
  computeInstalledFiles,
  readInstalledFiles,
  writeInstalledFiles,
} from '../../records/installed-files.js';
import { writeInstallMetadata } from '../../../installed-metadata.js';
import { keepUnprovenFiles, keptFilesKey } from '../keep-unproven.js';
import { verifyInstall } from '../verify-install.js';
import { withInstallTargetLock } from '../../../transaction.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

/** Every file under `root`, with its contents. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else out[r] = await readFile(path.join(root, r), 'utf8');
    }
  };
  await walk('');
  return out;
}

/** An install from a local folder whose update kept two files it could not sort. */
async function installWithKeptFiles(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'keep-unproven-'));
  dirs.push(d);
  const root = path.join(d, 'flow');
  await put(root, '.dork/manifest.json', '{"name":"flow"}');
  await put(root, 'skills/a/SKILL.md', '---\nname: a\ndescription: A.\n---\n\nA.\n');
  const record = await computeInstalledFiles(root, {
    identity: { name: 'flow', type: 'plugin' },
    userEditable: [],
    npmRan: false,
  });
  await put(root, 'skills/old/SKILL.md', '---\nname: old\ndescription: Old.\n---\n\nOld.\n');
  await put(root, 'notes/old.md', 'old notes');
  await chmod(path.join(root, 'notes', 'old.md'), 0o755);
  await writeInstallMetadata(root, {
    name: 'flow',
    version: '1.2.0',
    type: 'plugin',
    installedAt: '2026-09-01T00:00:00.000Z',
  });
  await writeInstalledFiles(root, {
    ...record,
    unproven: {
      why: 'no-source',
      files: { 'skills/old/SKILL.md': 'skills/old/SKILL.md', 'notes/old.md': 'notes/old.md' },
    },
  });
  return root;
}

describe('keepUnprovenFiles', () => {
  // Purpose: the person's yes makes the files theirs in the record, and that
  // is all it does: every byte and mode on disk stays exactly as it was.
  it('clears the kept-files list and moves or deletes nothing', async () => {
    const root = await installWithKeptFiles();
    const before = await snapshot(root);
    const modeBefore = (await stat(path.join(root, 'notes', 'old.md'))).mode;
    const key = await keptFilesKey(root);

    const result = await keepUnprovenFiles(root, key!);

    expect(result).toEqual({
      outcome: 'kept',
      files: ['notes/old.md', 'skills/old/SKILL.md'],
      running: ['skills/old/SKILL.md'],
    });
    expect((await readInstalledFiles(root))?.unproven).toBeUndefined();
    const after = await snapshot(root);
    delete before['.dork/installed-files.json'];
    delete after['.dork/installed-files.json'];
    expect(after).toEqual(before);
    expect((await stat(path.join(root, 'notes', 'old.md'))).mode).toBe(modeBefore);
  });

  // Purpose: once theirs, a kept file that runs is simply a file they added,
  // which is what every later update and the Installed row already know.
  it('leaves the files reading as the person’s additions', async () => {
    const root = await installWithKeptFiles();
    await keepUnprovenFiles(root, (await keptFilesKey(root))!);

    const integrity = await verifyInstall(root);
    expect(integrity).toMatchObject({ status: 'modified', added: ['skills/old/SKILL.md'] });
    expect('unproven' in integrity).toBe(false);
  });

  // Purpose: acceptance is bound to the exact bytes shown. An edit that lands
  // after the person looked is not what they said yes to.
  it('refuses, writing nothing, when a kept file changed since the key was taken', async () => {
    const root = await installWithKeptFiles();
    const key = (await keptFilesKey(root))!;
    await put(root, 'skills/old/SKILL.md', '---\nname: old\ndescription: Edited.\n---\n\nX.\n');
    const recordBefore = await readFile(path.join(root, '.dork', 'installed-files.json'), 'utf8');

    expect(await keepUnprovenFiles(root, key)).toEqual({ outcome: 'changed' });
    expect(await readFile(path.join(root, '.dork', 'installed-files.json'), 'utf8')).toBe(
      recordBefore
    );
  });

  it('refuses when a kept file was removed, or the installed version moved', async () => {
    const removed = await installWithKeptFiles();
    const removedKey = (await keptFilesKey(removed))!;
    await rm(path.join(removed, 'notes', 'old.md'));
    expect(await keepUnprovenFiles(removed, removedKey)).toEqual({ outcome: 'changed' });

    const moved = await installWithKeptFiles();
    const movedKey = (await keptFilesKey(moved))!;
    await writeInstallMetadata(moved, {
      name: 'flow',
      version: '1.3.0',
      type: 'plugin',
      installedAt: '2026-09-02T00:00:00.000Z',
    });
    expect(await keepUnprovenFiles(moved, movedKey)).toEqual({ outcome: 'changed' });
  });

  it('answers not-needed when nothing is kept any more', async () => {
    const root = await installWithKeptFiles();
    const key = (await keptFilesKey(root))!;
    await keepUnprovenFiles(root, key);

    expect(await keepUnprovenFiles(root, key)).toEqual({ outcome: 'not-needed' });
    expect(await keptFilesKey(root)).toBeUndefined();
  });

  // Purpose: the key reaches the person through the integrity answer, so the
  // row and `installed --verify` can send it back.
  it('hands the key out with the kept files on the integrity answer', async () => {
    const root = await installWithKeptFiles();
    const integrity = await verifyInstall(root);

    expect(integrity).toMatchObject({ unproven: { keepKey: await keptFilesKey(root) } });
  });

  // Purpose (review): a kept symbolic link is bound by where it points, so
  // re-pointing it after the person looked is not what they said yes to.
  it('binds a kept link to its target', async () => {
    const root = await installWithKeptFiles();
    await symlink('notes/old.md', path.join(root, 'skills', 'link.md'));
    const record = (await readInstalledFiles(root))!;
    await writeInstalledFiles(root, {
      ...record,
      unproven: {
        ...record.unproven!,
        files: { ...record.unproven!.files, 'skills/link.md': 'skills/link.md' },
      },
    });
    const key = (await keptFilesKey(root))!;
    await rm(path.join(root, 'skills', 'link.md'));
    await symlink('../elsewhere.md', path.join(root, 'skills', 'link.md'));

    expect(await keepUnprovenFiles(root, key)).toEqual({ outcome: 'changed' });
  });

  // Purpose (review): what runs after the keep (the approval of a held-back
  // package) holds the same install lock, so nothing can change the install
  // between the keep and it.
  it('runs what follows the keep under the same install lock', async () => {
    const root = await installWithKeptFiles();
    const key = (await keptFilesKey(root))!;
    const events: string[] = [];

    const kept = keepUnprovenFiles(root, key, async () => {
      events.push('approve-start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push('approve-end');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const other = withInstallTargetLock(root, async () => {
      events.push('other');
    });
    await Promise.all([kept, other]);

    expect(events).toEqual(['approve-start', 'approve-end', 'other']);
  });
});
