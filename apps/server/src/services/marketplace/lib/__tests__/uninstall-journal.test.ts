/**
 * Tests for the uninstall journal's rollback (DOR-2245 §5). The flow tests
 * cover the happy paths; these pin the two properties a crash depends on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rollBackUninstall, type UninstallJournal } from '../uninstall-journal.js';

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
