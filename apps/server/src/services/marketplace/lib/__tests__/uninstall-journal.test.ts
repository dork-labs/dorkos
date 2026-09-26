/**
 * Tests for the uninstall journal's rollback (DOR-2245 §5). The flow tests
 * cover the happy paths; these pin the two properties a crash depends on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createUninstallSibling,
  finishUninstall,
  readJournal,
  rollBackUninstall,
  writeJournal,
  type UninstallJournal,
} from '../uninstall-journal.js';
import { recoverInterruptedInstall } from '../../install-recovery.js';
import { readInstalledFiles, writeInstalledFiles } from '../installed-files.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function setup(): Promise<{ root: string; sibling: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'uninstall-journal-'));
  dirs.push(base);
  const root = path.join(base, 'pkg');
  const sibling = path.join(base, 'pkg.dorkos-uninstall-x');
  await mkdir(root, { recursive: true });
  await mkdir(sibling, { recursive: true });
  return { root, sibling };
}

function journal(root: string, moves: string[]): UninstallJournal {
  return {
    version: 1,
    root,
    package: { name: 'pkg', type: 'plugin' },
    moves: moves.map((p) => ({ path: p })),
    phase: 'moving',
  };
}

describe('rollBackUninstall', () => {
  // Purpose: a move logged but never made (a crash between the journal write
  // and the rename) is skipped, not an error.
  it('tolerates a journaled move that never happened', async () => {
    const { root, sibling } = await setup();
    await put(sibling, 'a.md', 'a');
    await rollBackUninstall(sibling, journal(root, ['a.md', 'never-moved.md']));
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('a');
    expect(await lstat(sibling).catch(() => undefined)).toBeUndefined();
  });

  // Purpose: the identity files moved last come back first, so a rollback that
  // fails part-way still leaves the root recognisable as the package.
  it('restores the last move (the identity files) first', async () => {
    const { root, sibling } = await setup();
    await put(sibling, 'blocked/x.md', 'x');
    await put(sibling, '.dork/manifest.json', '{}');
    // The first move's destination parent is a file, so restoring it throws.
    await put(root, 'blocked', 'a file in the way');
    await expect(
      rollBackUninstall(sibling, journal(root, ['blocked/x.md', '.dork/manifest.json']))
    ).rejects.toThrow();
    expect(await readFile(path.join(root, '.dork', 'manifest.json'), 'utf8')).toBe('{}');
  });
});

describe('finishUninstall', () => {
  // Purpose (code review 4): the record is pruned BEFORE the sibling (and its
  // journal) is deleted. A crash between the two used to leave a full record
  // with no journal, so the next reinstall read moved-out editable defaults as
  // "deleted by the person" (row 3a) and dropped them. Here the sibling's
  // removal fails, standing in for that crash.
  it('prunes the record before deleting the sibling, and a retry finishes', async () => {
    const { root, sibling } = await setup();
    await put(root, 'edited.md', 'mine');
    await put(sibling, 'moved.md', 'pkg');
    await put(sibling, 'locked/x.md', 'x');
    await writeInstalledFiles(root, {
      version: 1,
      package: { name: 'pkg', type: 'plugin' },
      ownedPaths: [],
      files: { 'moved.md': `sha256:${'a'.repeat(64)}`, 'edited.md': `sha256:${'b'.repeat(64)}` },
      pendingDefaults: {},
      userEditable: [],
    });
    const committed = { ...journal(root, ['moved.md']), phase: 'committed' as const };
    await chmod(path.join(sibling, 'locked'), 0o555);
    try {
      await expect(finishUninstall(sibling, committed)).rejects.toThrow();
      const pruned = await readInstalledFiles(root);
      expect(Object.keys(pruned!.files)).toEqual(['edited.md']);
      expect(pruned!.uninstalledAt).toBeDefined();
    } finally {
      await chmod(path.join(sibling, 'locked'), 0o755);
    }

    await finishUninstall(sibling, committed);

    expect(await lstat(sibling).catch(() => undefined)).toBeUndefined();
    expect(Object.keys((await readInstalledFiles(root))!.files)).toEqual(['edited.md']);
  });
});

describe('readJournal (delta review 3)', () => {
  // Purpose: a journal is read back during recovery, which renames and deletes
  // what it names. A tampered path that leaves the root is refused, so the
  // journal is unreadable and recovery keeps the sibling rather than act on it.
  it.each([
    ['a move', { moves: [{ path: '../outside.txt' }] }],
    ['a unit file', { moves: [{ path: 'dir', unitFiles: ['../../outside.txt'] }] }],
    ['a saved copy', { savedCopies: ['../outside.txt'] }],
    ['an absolute saved copy', { savedCopies: ['/etc/hosts'] }],
  ])('refuses %s that leaves the root', async (_label, tamper) => {
    const { root, sibling } = await setup();
    await writeJournal(sibling, { ...journal(root, []), ...tamper } as UninstallJournal);
    expect(await readJournal(sibling)).toBeNull();
  });

  // Purpose: end to end, recovery never deletes a file outside the root that a
  // tampered journal names; it keeps the sibling and reports it.
  it('never deletes outside the root during recovery', async () => {
    const { root } = await setup();
    const outside = path.join(path.dirname(root), 'outside.txt');
    await writeFile(outside, 'not the package');
    const sibling = await createUninstallSibling(root);
    await writeJournal(sibling, {
      ...journal(root, []),
      savedCopies: ['../outside.txt'],
    } as UninstallJournal);

    const report = await recoverInterruptedInstall(root);

    expect(report.kept.map((r) => r.kind)).toEqual(['uninstall']);
    expect(await readFile(outside, 'utf8')).toBe('not the package');
  });
});
